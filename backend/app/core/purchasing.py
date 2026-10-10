# -*- coding: utf-8 -*-
"""Purchase Orders / QuickBuy (Increment B) + costeo post-recepción (v2.22).

Órdenes de compra de partes a un vendor. Espeja el módulo de work orders
(core/workorders.py): serializers a dict, org-scoping automático vía los
eventos de SessionLocal (db.py).

Dos ciclos INDEPENDIENTES:
  - `status` (RECEPCIÓN): draft -> ordered -> received. Recibir repone stock
    (movimientos po_receive costeados). Retroceder desde 'received' SOLO se
    hace des-recibiendo líneas (unreceive_line: movimiento po_unreceive
    negativo + reversión del promedio); el PATCH de status lo rechaza.
  - `fin_status` (FINANCIERO): open -> closed (close_po / reopen_po). Cerrar
    NO toca stock ni congela costos.

v2.22 (benchmark SquareRigger — SR obliga a reabrir para corregir): las
líneas (costo unitario, qty, taxable, descripción) y los ajustes financieros
(descuento/crédito/flete/tax/fee/pago) se editan en CUALQUIER status y
fin_status. Si la línea ya tiene unidades recibidas y su costo efectivo
(landed) cambia, se escribe UN movimiento po_cost_adj (delta 0, value_delta =
Δc × qty_received) y se revalúa Part.avg_cost solo por la porción todavía en
stock (core/inventory.revalue_in_session). Todo en una sesión + AuditEvent.

El `total` (y su cache en la fila) = total financiero: líneas − descuentos −
créditos + flete + tax + fees (los pagos solo bajan el saldo).
"""

from __future__ import annotations

import math
import re
from datetime import datetime, timedelta

from sqlalchemy import func, or_, select

from ..db import (
    CoreItem, Part, PartsRequest, PartStockMovement, PoAdjustment, POLine,
    PurchaseOrder, SessionLocal, Vendor,
)
from . import audit, org_config

STATUSES = ("draft", "ordered", "received")
FIN_STATUSES = ("open", "closed")
ADJ_KINDS = ("discount", "credit", "shipping", "tax", "fee", "payment")
# Ajustes que se pueden repartir en el landed cost (el pago nunca).
ALLOCATABLE = ("discount", "credit", "shipping", "tax", "fee")
NEGATIVE_KINDS = ("discount", "credit")
PAYMENT_METHODS = ("", "invoice", "paid", "card", "cash")

_EPS = 1e-9
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_LOG_REASONS = ("po_receive", "po_unreceive", "po_cost_adj")


# ----- Helpers de costo / serialización ------------------------------------

def _eff_cost(ln: POLine) -> float:
    """Costo unitario EFECTIVO de la línea: landed si hay prorrateo, si no
    el unit_cost. Es el costo con el que entra (y sale) del inventario."""
    if ln.landed_unit_cost is not None:
        return float(ln.landed_unit_cost)
    return float(ln.unit_cost or 0.0)


def _line_ref(po_id, line_id) -> str:
    """entity_id de auditoría de una línea: '<po_id>:<line_id>'."""
    return f"{po_id}:{line_id}"


def _money(v: float) -> float:
    return round(float(v or 0.0), 2)


def _num(v, what: str) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise ValueError(f"{what} must be a number")
    if not math.isfinite(f):
        raise ValueError(f"{what} must be a number")
    return f


def _active_adjustments(po: PurchaseOrder) -> list[PoAdjustment]:
    return [a for a in po.adjustments if a.voided_at is None]


def _financial(po: PurchaseOrder) -> dict:
    subtotal = sum((ln.qty or 0.0) * (ln.unit_cost or 0.0) for ln in po.lines)
    taxable = sum((ln.qty or 0.0) * (ln.unit_cost or 0.0) for ln in po.lines
                  if ln.taxable)
    sums = {k: 0.0 for k in ADJ_KINDS}
    for a in _active_adjustments(po):
        if a.kind in sums:
            sums[a.kind] += float(a.amount or 0.0)
    total = (subtotal - sums["discount"] - sums["credit"] + sums["shipping"]
             + sums["tax"] + sums["fee"])
    return {
        "subtotal": _money(subtotal),
        "taxable_subtotal": _money(taxable),
        "discount": _money(sums["discount"]),
        "credit": _money(sums["credit"]),
        "shipping": _money(sums["shipping"]),
        "tax": _money(sums["tax"]),
        "fees": _money(sums["fee"]),
        "total": _money(total),
        "paid": _money(sums["payment"]),
        "balance": _money(total - sums["payment"]),
    }


def _adj_dict(a: PoAdjustment) -> dict:
    amt = float(a.amount or 0.0)
    signed = -amt if a.kind in NEGATIVE_KINDS + ("payment",) else amt
    return {
        "id": a.id,
        "kind": a.kind,
        "amount": _money(amt),
        # Efecto sobre el saldo de la PO (discount/credit/payment restan).
        "signed_amount": _money(signed),
        "note": a.note or "",
        "allocate": bool(a.allocate),
        "actor": a.actor or "",
        "created_at": org_config.org_iso(a.created_at),
        "voided": a.voided_at is not None,
        "voided_at": org_config.org_iso(a.voided_at),
        "void_reason": a.void_reason or "",
    }


def _line_dict(ln: POLine, log: list | None = None) -> dict:
    recv = round(ln.qty_received or 0.0, 4)
    return {
        "id": ln.id,
        "part_number": ln.part_number or "",
        "description": ln.description,
        "qty": ln.qty,
        "unit_cost": ln.unit_cost,
        "total": round(ln.qty * ln.unit_cost, 2),
        # Recepción parcial: cuánto llegó y cuánto falta de esta línea.
        "qty_received": recv,
        "qty_outstanding": round(max(0.0, ln.qty - recv), 4),
        "received_at": ln.received_at.isoformat() if ln.received_at else None,
        # v2.22 costeo.
        "taxable": bool(ln.taxable),
        "landed_unit_cost": (None if ln.landed_unit_cost is None
                             else round(ln.landed_unit_cost, 4)),
        "effective_unit_cost": round(_eff_cost(ln), 4),
        "received_log": log or [],
    }


def _receiving_state(po: PurchaseOrder) -> str:
    """Estado DERIVADO de recepción (no se guarda; no toca el pipeline de
    status): 'full' si la PO está recibida, 'partial' si llegó algo pero no
    todo, 'none' si no llegó nada."""
    if po.status == "received":
        return "full"
    recv = sum(min(ln.qty_received or 0.0, ln.qty) for ln in po.lines
               if (ln.part_number or "").strip())
    return "partial" if recv > _EPS else "none"


def _received_logs(session, po: PurchaseOrder) -> dict[int, list]:
    """Bitácora de recepción por línea, desde el libro de movimientos
    (po_receive / po_unreceive / po_cost_adj con ref_type 'po_line' y
    ref_id '<line_id>:…')."""
    ids = [ln.id for ln in po.lines if ln.id is not None]
    pns = {ln.part_number for ln in po.lines if (ln.part_number or "").strip()}
    if not ids or not pns:
        return {}
    rows = session.scalars(
        select(PartStockMovement).where(
            PartStockMovement.ref_type == "po_line",
            PartStockMovement.reason.in_(_LOG_REASONS),
            PartStockMovement.part_number.in_(pns),
            or_(*[PartStockMovement.ref_id.startswith(f"{i}:")
                  for i in ids]))
        .order_by(PartStockMovement.id)).all()
    wanted = {str(i) for i in ids}
    out: dict[int, list] = {}
    for m in rows:
        lid = (m.ref_id or "").split(":", 1)[0]
        if lid not in wanted:
            continue
        out.setdefault(int(lid), []).append({
            "date": org_config.org_iso(m.created_at),
            "qty": m.delta,
            "unit_cost": m.unit_cost,
            "value_delta": m.value_delta,
            "reason": m.reason,
            "ref": m.ref_id or "",
            "actor": m.actor or "",
            "note": m.note or "",
        })
    return out


def _po_audit(session, po_id: int, limit: int = 100) -> list[dict]:
    return audit.query_events(
        session, [("po", str(po_id), False), ("po_line", f"{po_id}:", True)],
        limit)


def _po_dict(po: PurchaseOrder, with_lines: bool = False,
             session=None) -> dict:
    fin = _financial(po)
    out = {
        "id": po.id,
        "created_at": po.created_at.isoformat(),
        "updated_at": po.updated_at.isoformat(),
        "vendor": po.vendor or "",
        "vendor_id": po.vendor_id,
        "status": po.status,
        "notes": po.notes or "",
        "total": fin["total"],
        "n_lines": len(po.lines),
        "received_at": po.received_at.isoformat() if po.received_at else None,
        "backorder_of_po_id": po.backorder_of_po_id,
        "receiving_state": _receiving_state(po),
        # v2.22: ciclo financiero + datos de factura del proveedor.
        "fin_status": po.fin_status or "open",
        "closed_at": org_config.org_iso(po.closed_at),
        "invoice_no": po.invoice_no or "",
        "invoice_date": po.invoice_date or "",
        "tracking_no": po.tracking_no or "",
        "payment_method": po.payment_method or "",
        "financial": fin,
        "adjustments": [_adj_dict(a) for a in po.adjustments],
    }
    if with_lines:
        # POs de backorder generadas desde esta (lo corto se movió ahí).
        out["backorder_po_ids"] = (list(session.scalars(
            select(PurchaseOrder.id).where(
                PurchaseOrder.backorder_of_po_id == po.id)
            .order_by(PurchaseOrder.id)).all()) if session is not None
            else [])
        logs = _received_logs(session, po) if session is not None else {}
        out["lines"] = [_line_dict(ln, logs.get(ln.id)) for ln in po.lines]
        out["audit"] = (_po_audit(session, po.id) if session is not None
                        else [])
    return out


def list_pos(status: str = "", limit: int = 200,
             fin_status: str = "") -> list[dict]:
    from sqlalchemy.orm import selectinload
    with SessionLocal() as session:
        q = (select(PurchaseOrder)
             .options(selectinload(PurchaseOrder.lines),
                      selectinload(PurchaseOrder.adjustments))
             .order_by(PurchaseOrder.id.desc()).limit(limit))
        if status:
            q = q.where(PurchaseOrder.status == status)
        if fin_status:
            q = q.where(PurchaseOrder.fin_status == fin_status)
        return [_po_dict(p) for p in session.scalars(q).all()]


def get_po(po_id: int) -> dict | None:
    with SessionLocal() as session:
        po = session.get(PurchaseOrder, po_id)
        return _po_dict(po, with_lines=True, session=session) if po else None


def get_po_audit(po_id: int, limit: int = 500) -> dict | None:
    """Historia completa de la PO (cabecera + líneas), recientes primero."""
    with SessionLocal() as session:
        po = session.get(PurchaseOrder, po_id)
        if po is None:
            return None
        return {"po_id": po.id, "events": _po_audit(session, po.id, limit)}


def _recalc_total(po: PurchaseOrder) -> None:
    po.total = _financial(po)["total"]


def _find_line(po: PurchaseOrder, line_id: int) -> POLine | None:
    return next((ln for ln in po.lines if ln.id == int(line_id)), None)


def _resolve_vendor_id(session, name: str) -> int | None:
    """Vendor del catálogo con ese nombre (sin distinguir mayúsculas)."""
    n = (name or "").strip().lower()
    if not n:
        return None
    return session.scalar(
        select(Vendor.id).where(func.lower(Vendor.name) == n)
        .order_by(Vendor.id).limit(1))


def _record_core(session, ln: POLine, vendor: str, qty: float,
                 po_id: int, ref: str) -> None:
    """Core tracking: si la parte de la línea lleva core (`core_charge > 0`),
    registra el core pendiente de devolver DENTRO de la sesión (atómico con el
    movimiento de stock; idempotente por `ref` = el ref_id del movimiento)."""
    from . import cores
    p = session.scalar(select(Part).where(
        Part.part_number == ln.part_number))
    if p is not None and (p.core_charge or 0.0) > 0:
        cores.add_core_in_session(
            session, ln.part_number, ln.description or p.description,
            vendor, p.core_charge, qty, po_id, ref)


def _unreceive_gen(session, line_id: int) -> int:
    """Cuántas veces se des-recibió la línea. Versiona los ref_id de las
    recepciones posteriores para que el guard de idempotencia no confunda una
    re-recepción legítima con un reintento de la vieja."""
    return int(session.scalar(
        select(func.count()).select_from(PartStockMovement).where(
            PartStockMovement.ref_type == "po_line",
            PartStockMovement.reason == "po_unreceive",
            PartStockMovement.ref_id.startswith(f"{line_id}:u"))) or 0)


def _next_cost_seq(session, line_id: int) -> int:
    return int(session.scalar(
        select(func.count()).select_from(PartStockMovement).where(
            PartStockMovement.ref_type == "po_line",
            PartStockMovement.reason == "po_cost_adj",
            PartStockMovement.ref_id.startswith(f"{line_id}:c"))) or 0) + 1


def _ref_line(ref_id: str | None) -> int | None:
    try:
        return int((ref_id or "").split(":", 1)[0])
    except ValueError:
        return None


def _line_receipt_ids(session, line_id: int) -> list[int]:
    """ids de los movimientos po_receive VIGENTES de la línea: los
    posteriores a su último po_unreceive (lo anterior ya se revirtió)."""
    last_un = session.scalar(
        select(func.max(PartStockMovement.id)).where(
            PartStockMovement.ref_type == "po_line",
            PartStockMovement.reason == "po_unreceive",
            PartStockMovement.ref_id.startswith(f"{line_id}:")))
    q = select(PartStockMovement.id).where(
        PartStockMovement.ref_type == "po_line",
        PartStockMovement.reason == "po_receive",
        PartStockMovement.ref_id.startswith(f"{line_id}:"))
    if last_un is not None:
        q = q.where(PartStockMovement.id > last_un)
    return list(session.scalars(q).all())


def _latest_active_receipt(session, part_number: str,
                           exclude_line_id: int | None = None
                           ) -> tuple[int | None, float | None]:
    """(line_id, costo) de la recepción NO revertida más reciente de la
    parte (ignorando `exclude_line_id`). El costo es el efectivo actual de
    esa línea (incluye correcciones posteriores) o, si la línea ya no
    existe, el del movimiento."""
    rows = session.execute(
        select(PartStockMovement.reason, PartStockMovement.ref_id,
               PartStockMovement.unit_cost).where(
            PartStockMovement.part_number == part_number,
            PartStockMovement.ref_type == "po_line",
            PartStockMovement.reason.in_(("po_receive", "po_unreceive")))
        .order_by(PartStockMovement.id.desc()).limit(1000)).all()
    reversed_lines: set[int] = set()
    for reason, ref, cost in rows:
        lid = _ref_line(ref)
        if lid is None:
            continue
        if reason == "po_unreceive":
            reversed_lines.add(lid)
            continue
        if lid in reversed_lines or lid == exclude_line_id:
            continue
        ln = session.get(POLine, lid)
        if ln is not None:
            return lid, _eff_cost(ln)
        return lid, None if cost is None else float(cost)
    return None, None


def _is_latest_receipt(session, part_number: str, line_id: int) -> bool:
    """¿La recepción vigente más reciente de esta parte vino de esta línea?
    (si sí, corregir su costo también corrige Part.last_cost). Las
    recepciones ya des-recibidas no cuentan."""
    return _latest_active_receipt(session, part_number)[0] == line_id


# ----- Prorrateo (landed cost) + revaluación ---------------------------------

def _allocate(po: PurchaseOrder) -> None:
    """Recalcula `landed_unit_cost` de cada línea repartiendo los ajustes
    activos con allocate=True pro-rata por valor de línea (qty × unit_cost).
    descuento/crédito restan; flete/tax/fee suman. El tax se reparte solo
    entre las líneas gravadas si hay alguna. Sin ajustes asignables, landed
    queda NULL (el costo efectivo es unit_cost)."""
    lines = list(po.lines)
    adjs = [a for a in _active_adjustments(po)
            if a.allocate and a.kind in ALLOCATABLE]
    if not adjs:
        for ln in lines:
            ln.landed_unit_cost = None
        return
    val = [max(0.0, (ln.qty or 0.0) * (ln.unit_cost or 0.0)) for ln in lines]
    share = [0.0] * len(lines)
    for a in adjs:
        signed = -float(a.amount or 0.0) if a.kind in NEGATIVE_KINDS \
            else float(a.amount or 0.0)
        pool = [i for i in range(len(lines)) if val[i] > 0]
        if a.kind == "tax":
            taxed = [i for i in pool if lines[i].taxable]
            if taxed:
                pool = taxed
        base = sum(val[i] for i in pool)
        if base <= 0:
            continue
        for i in pool:
            share[i] += signed * val[i] / base
    for i, ln in enumerate(lines):
        q = float(ln.qty or 0.0)
        if q > _EPS and abs(share[i]) > _EPS:
            ln.landed_unit_cost = round(
                max(0.0, float(ln.unit_cost or 0.0) + share[i] / q), 6)
        else:
            ln.landed_unit_cost = None


def _snapshot(po: PurchaseOrder) -> dict[int, tuple[float, float | None]]:
    """(costo efectivo, landed) por línea ANTES de un cambio (clave = id()
    del objeto: estable durante la sesión, sirve también para líneas sin
    flush)."""
    return {id(ln): (_eff_cost(ln), ln.landed_unit_cost) for ln in po.lines}


def _reprice(session, po: PurchaseOrder, before: dict, actor: str,
             why: str) -> list[dict]:
    """Después de mutar líneas/ajustes: recalcula el landed cost y, para cada
    línea con unidades recibidas cuyo costo efectivo cambió, escribe el
    movimiento po_cost_adj + revalúa el promedio (inventory). Devuelve el
    detalle de cada revaluación."""
    from . import inventory
    _allocate(po)
    out: list[dict] = []
    for ln in po.lines:
        prev = before.get(id(ln))
        if prev is None or ln.id is None:
            continue
        old_cost, old_landed = prev
        if (old_landed is None) != (ln.landed_unit_cost is None) or (
                old_landed is not None
                and abs(old_landed - ln.landed_unit_cost) > 1e-6):
            audit.record(session, "po_line", _line_ref(po.id, ln.id),
                         "reprice", "landed_unit_cost", old_landed,
                         ln.landed_unit_cost, actor)
        new_cost = _eff_cost(ln)
        if abs(new_cost - old_cost) <= 1e-6:
            continue
        qr = float(ln.qty_received or 0.0)
        pn = (ln.part_number or "").strip()
        if qr <= _EPS or not pn:
            continue
        seq = _next_cost_seq(session, ln.id)
        # Solo las unidades de ESTA recepción que siguen en stock (consumo
        # proporcional del promedio móvil) revalúan el avg.
        units = inventory.line_units_on_hand(
            session, pn, _line_receipt_ids(session, ln.id))
        info = inventory.revalue_in_session(
            session, pn, qr, old_cost, new_cost, "po_line",
            f"{ln.id}:c{seq}",
            note=(f"PO #{po.id} cost {old_cost:.2f} -> {new_cost:.2f} "
                  f"({why})"),
            actor=actor,
            set_last_cost=_is_latest_receipt(session, pn, ln.id),
            units_on_hand=units)
        info["line_id"] = ln.id
        out.append(info)
        if info["in_catalog"] and info["revalued_qty"] > _EPS:
            audit.record(session, "po_line", _line_ref(po.id, ln.id),
                         "revalue", "avg_cost", info["avg_old"],
                         info["avg_new"], actor)
            audit.record(session, "part", pn, "revalue", "avg_cost",
                         info["avg_old"], info["avg_new"], actor)
    return out


def _finish(session, po: PurchaseOrder, revals: list[dict],
            dry_run: bool = False) -> dict:
    """Commitea (o, en dry_run, arma el preview y hace rollback) y devuelve
    la PO serializada + las revaluaciones."""
    if dry_run:
        out = _po_dict(po, with_lines=True, session=session)
        out["revaluations"] = revals
        out["dry_run"] = True
        session.rollback()
        return out
    session.commit()
    out = _po_dict(po, with_lines=True, session=session)
    out["revaluations"] = revals
    return out


# ----- CRUD de la PO ---------------------------------------------------------

def _new_line(ld: dict) -> POLine | None:
    desc = str(ld.get("description", "") or "").strip()
    pn = str(ld.get("part_number", "") or "").strip()
    if not desc and not pn:
        return None
    return POLine(
        part_number=pn[:60],
        description=desc[:160] or pn[:160],
        qty=max(0.0, float(ld.get("qty") or 0) or 1.0),
        unit_cost=max(0.0, float(ld.get("unit_cost") or 0)),
        taxable=bool(ld.get("taxable") or False),
    )


def create_po(vendor: str = "", notes: str = "",
              lines: list[dict] | None = None, actor: str = "",
              vendor_id: int | None = None) -> dict:
    """Crea una PO en estado draft. `lines` (opcional) es una lista de
    {part_number, description, qty, unit_cost, taxable?}: el QuickBuy crea la
    PO con una línea de un saque. `vendor_id` se resuelve por nombre si no
    viene explícito."""
    now = datetime.now()
    vendor = (vendor or "").strip()
    with SessionLocal() as session:
        vid = None
        if vendor_id:
            v = session.get(Vendor, int(vendor_id))
            if v is None:
                raise ValueError("vendor not found")
            vid = v.id
            vendor = vendor or v.name
        else:
            vid = _resolve_vendor_id(session, vendor)
        po = PurchaseOrder(
            created_at=now, updated_at=now,
            vendor=vendor[:120], vendor_id=vid,
            status="draft", fin_status="open",
            notes=(notes or "").strip(),
        )
        for ld in (lines or []):
            ln = _new_line(ld)
            if ln is not None:
                po.lines.append(ln)
        _recalc_total(po)
        session.add(po)
        session.flush()
        audit.record(session, "po", po.id, "create", "lines", None,
                     len(po.lines), actor)
        session.commit()
        return _po_dict(po, with_lines=True, session=session)


def update_po(po_id: int, fields: dict, actor: str = "") -> dict | None:
    """Actualiza la cabecera de una PO: vendor/vendor_id, notes, datos de la
    factura del proveedor (invoice_no, invoice_date, tracking_no,
    payment_method) y status. Editable en cualquier status / fin_status.

    Status: avanzar a 'received' recibe el remanente de cada línea (camino
    legacy de recepción completa). Retroceder desde 'received' con unidades
    recibidas se rechaza ("unreceive lines instead"): el stock se revierte
    línea por línea con unreceive_line."""
    with SessionLocal() as session:
        po = session.get(PurchaseOrder, po_id)
        if po is None:
            return None

        def _set(attr: str, new) -> None:
            """Asigna + audita solo si el valor cambia."""
            old = getattr(po, attr)
            changed = ((old or "") != (new or "")) if isinstance(new, str) \
                else old != new
            if changed:
                audit.record(session, "po", po.id, "update", attr, old, new,
                             actor)
                setattr(po, attr, new)

        if "vendor" in fields:
            name = str(fields["vendor"] or "").strip()[:120]
            if name != (po.vendor or ""):
                _set("vendor", name)
                if "vendor_id" not in fields:
                    po.vendor_id = _resolve_vendor_id(session, name)
        if fields.get("vendor_id") not in (None, "", 0):
            v = session.get(Vendor, int(fields["vendor_id"]))
            if v is None:
                raise ValueError("vendor not found")
            _set("vendor_id", v.id)
            if not (po.vendor or "").strip():
                po.vendor = v.name[:120]
        if "notes" in fields:
            _set("notes", str(fields["notes"] or "").strip())
        if "invoice_no" in fields:
            _set("invoice_no", str(fields["invoice_no"] or "").strip()[:40])
        if "tracking_no" in fields:
            _set("tracking_no",
                 str(fields["tracking_no"] or "").strip()[:60])
        if "invoice_date" in fields:
            d = str(fields["invoice_date"] or "").strip()
            if d and not _valid_date(d):
                raise ValueError("invoice date must be YYYY-MM-DD")
            _set("invoice_date", d)
        if "payment_method" in fields:
            pm = str(fields["payment_method"] or "").strip().lower()
            if pm not in PAYMENT_METHODS:
                raise ValueError(f"invalid payment method: {pm}")
            _set("payment_method", pm)

        received_now = False
        if "status" in fields:
            target = str(fields["status"])
            if target not in STATUSES:
                raise ValueError(f"invalid status: {target}")
            if po.status == "received" and target != "received":
                if any((ln.qty_received or 0.0) > _EPS for ln in po.lines):
                    raise ValueError("unreceive lines instead")
                po.received_at = None
            received_now = target == "received"
            _set("status", target)
        now = datetime.now()
        po.updated_at = now
        # Al pasar a 'received' se repone SOLO lo que falta de cada línea
        # (qty - qty_received), no la qty entera. El movimiento se crea EN LA
        # MISMA sesión (atómico con qty_received): si algo falla, se deshace
        # todo. ref_id ':full' (versionado tras un unreceive) -> idempotente.
        if received_now:
            from . import inventory
            for ln in po.lines:
                if not (ln.part_number or "").strip():
                    continue
                remaining = round(ln.qty - (ln.qty_received or 0.0), 4)
                if remaining <= _EPS:
                    continue
                gen = _unreceive_gen(session, ln.id)
                ref = f"{ln.id}:full" + (f"-r{gen}" if gen else "")
                applied = inventory.apply_in_session(
                    session, ln.part_number, remaining, "po_receive",
                    ref_type="po_line", ref_id=ref,
                    note=f"PO #{po_id} received",
                    unit_cost=_eff_cost(ln), actor=actor)
                if applied:
                    audit.record(session, "po_line", _line_ref(po.id, ln.id),
                                 "receive", "qty_received", ln.qty_received,
                                 ln.qty, actor)
                    ln.qty_received = ln.qty
                    ln.received_at = now
                    _record_core(session, ln, po.vendor or "", remaining,
                                 po_id, ref)
            po.received_at = po.received_at or now
        _recalc_total(po)
        session.commit()
        return _po_dict(po, with_lines=True, session=session)


def _valid_date(s: str) -> bool:
    if not _DATE_RE.match(s):
        return False
    try:
        datetime.strptime(s, "%Y-%m-%d")
    except ValueError:
        return False
    return True


def receive_po(po_id: int, receipts: list[dict], token: str = "",
               create_backorder: bool = True, actor: str = "") -> dict | None:
    """Recepción por línea (parcial o total) de una PO.

    `receipts` = [{line_id, qty_now}] con la cantidad que llegó AHORA por
    línea. Aplica solo el delta (clamp a lo pendiente), repone stock de forma
    idempotente (ref_id versionado por `token` del evento) al costo efectivo
    (landed) de la línea — eso alimenta el promedio ponderado — y, si se
    pidió (`create_backorder`) y quedan faltantes, auto-genera UNA PO de
    backorder (draft) con las líneas cortas y cierra la PO original como
    'received'. Idempotente: reenviar el mismo (payload + token) es no-op.

    Backorder = MOVER lo corto, no duplicarlo: en la misma transacción la
    línea de la PO original baja su qty a lo recibido (o sale de la PO si no
    llegó nada) y la PO hija toma el faltante. Así la original no queda con
    pendiente re-recibible, su total es lo que de verdad facturó el
    proveedor y on-order no cuenta dos veces. El reparto de los ajustes
    asignados se recalcula ANTES de entrar el stock (la recepción entra al
    landed correcto; lo recibido antes se revalúa por _reprice).
    """
    tok = (str(token or "").strip().replace(" ", "") or "e")[:24]
    now = datetime.now()
    with SessionLocal() as session:
        from . import inventory
        po = session.get(PurchaseOrder, po_id)
        if po is None:
            return None
        parent_vendor = po.vendor or ""
        by_id = {ln.id: ln for ln in po.lines}
        # 1) Plan: cuánto entra AHORA por línea (clamp a lo pendiente). Los
        #    eventos ya aplicados (mismo token) se descartan acá, antes de
        #    tocar nada: un reintento es no-op completo.
        plan: list[tuple[POLine, float, str]] = []
        seen: set[int] = set()
        for r in (receipts or []):
            if r.get("line_id") is None:
                continue
            ln = by_id.get(int(r["line_id"]))
            if ln is None or ln.id in seen \
                    or not (ln.part_number or "").strip():
                continue
            remaining = round(ln.qty - (ln.qty_received or 0.0), 4)
            take = min(max(0.0, float(r.get("qty_now") or 0)),
                       max(0.0, remaining))
            if take <= _EPS:
                continue
            gen = _unreceive_gen(session, ln.id)
            ref = f"{ln.id}:{tok}" + (f"~{gen}" if gen else "")
            if inventory.already_applied(session, "po_receive", "po_line",
                                         ref):
                continue
            seen.add(ln.id)
            plan.append((ln, take, ref))
        if not plan:
            # Nada nuevo (receipts vacío, todo recibido o reintento): no-op,
            # sin cerrar ni backordear.
            return {"po": _po_dict(po, with_lines=True, session=session),
                    "backorder": None}
        children = list(session.scalars(select(PurchaseOrder.id).where(
            PurchaseOrder.backorder_of_po_id == po.id)).all())
        if po.status == "received" and children:
            # Datos previos a v2.22: el faltante de la original quedó también
            # en su backorder; recibirlo acá contaría el stock dos veces.
            raise ValueError(
                "this PO's shortage is on backorder PO "
                + ", ".join(f"#{c}" for c in children)
                + " — receive it there")
        taking = {ln.id: take for ln, take, _ in plan}
        short_lines: list[dict] = []
        moved: list[tuple[POLine, float]] = []
        for ln in po.lines:
            if not (ln.part_number or "").strip():
                continue
            got = round((ln.qty_received or 0.0) + taking.get(ln.id, 0.0), 4)
            short = round(ln.qty - got, 4)
            if short > _EPS:
                short_lines.append({
                    "part_number": ln.part_number,
                    "description": ln.description,
                    "qty": short, "unit_cost": ln.unit_cost,
                    "taxable": bool(ln.taxable),
                })
                moved.append((ln, got))
        will_backorder = create_backorder and bool(short_lines)
        revals: list[dict] = []
        child = None
        if will_backorder:
            before = _snapshot(po)
            child = PurchaseOrder(
                created_at=now, updated_at=now, vendor=parent_vendor[:120],
                vendor_id=po.vendor_id, status="draft", fin_status="open",
                notes=f"Backorder of PO #{po_id}",
                backorder_of_po_id=po.id)
            for ld in short_lines:
                cl = _new_line(ld)
                if cl is not None:
                    child.lines.append(cl)
            _recalc_total(child)
            session.add(child)
            session.flush()
            audit.record(session, "po", child.id, "create", "lines", None,
                         len(child.lines), actor)
            for ln, got in moved:
                lref = _line_ref(po.id, ln.id)
                if got > _EPS:
                    audit.record(session, "po_line", lref, "backorder", "qty",
                                 ln.qty, got, actor)
                    ln.qty = got
                else:
                    audit.record(session, "po_line", lref, "backorder",
                                 "line",
                                 f"{ln.qty:g} x {ln.part_number} "
                                 f"@ {ln.unit_cost:g}",
                                 f"moved to PO #{child.id}", actor)
                    po.lines.remove(ln)
            # Menos valor en la original -> otro reparto de ajustes asignados.
            revals = _reprice(session, po, before, actor, "backorder split")
        # 2) Entrar el stock al costo efectivo (ya re-prorrateado).
        for ln, take, ref in plan:
            # Movimiento EN-SESIÓN: atómico con qty_received (y con el
            # backorder); idempotente por (line_id, token).
            applied = inventory.apply_in_session(
                session, ln.part_number, take, "po_receive",
                ref_type="po_line", ref_id=ref,
                note=f"PO #{po_id} received (qty {take:g})",
                unit_cost=_eff_cost(ln), actor=actor)
            if not applied:
                continue
            _record_core(session, ln, parent_vendor, take, po_id, ref)
            new_qr = round((ln.qty_received or 0.0) + take, 4)
            audit.record(session, "po_line", _line_ref(po.id, ln.id),
                         "receive", "qty_received", ln.qty_received, new_qr,
                         actor)
            ln.qty_received = new_qr
            ln.received_at = now
        # Se cierra si llegó todo (sin faltantes) o si se backordea el resto.
        if not short_lines or will_backorder:
            if po.status != "received":
                audit.record(session, "po", po.id, "update", "status",
                             po.status, "received", actor)
            po.status = "received"
            po.received_at = now
        po.updated_at = now
        _recalc_total(po)
        session.commit()
        result = _po_dict(po, with_lines=True, session=session)
        result["revaluations"] = revals
        backorder = (_po_dict(child, with_lines=True, session=session)
                     if child is not None else None)
    return {"po": result, "backorder": backorder}


def unreceive_line(po_id: int, line_id: int,
                   actor: str = "") -> dict | None:
    """Des-recibe TODO lo recibido de una línea (único camino de regresión
    desde 'received'). En una sola sesión: movimiento 'po_unreceive' negativo
    por qty_received (revierte el promedio: ver
    inventory.unreceive_in_session), anula los cores PENDIENTES de esa línea
    (los ya
    devueltos al proveedor se conservan), qty_received = 0 y, si la PO estaba
    'received', vuelve a 'ordered' para poder re-recibir."""
    from . import inventory
    with SessionLocal() as session:
        po = session.get(PurchaseOrder, po_id)
        if po is None:
            return None
        ln = _find_line(po, line_id)
        if ln is None:
            return None
        qr = round(float(ln.qty_received or 0.0), 4)
        if qr <= _EPS:
            raise ValueError("nothing received on this line")
        now = datetime.now()
        pn = (ln.part_number or "").strip()
        lref = _line_ref(po.id, ln.id)
        if pn:
            gen = _unreceive_gen(session, ln.id) + 1
            # Lo de esta recepción que sigue en stock sale a su costo; lo ya
            # consumido se repone del resto del stock a su promedio (no se
            # vacía el avg). Sin stock: vuelve el costo previo y last_cost a
            # la última recepción vigente de otra línea.
            units = inventory.line_units_on_hand(
                session, pn, _line_receipt_ids(session, ln.id))
            was_latest = _is_latest_receipt(session, pn, ln.id)
            _, prev_cost = _latest_active_receipt(session, pn,
                                                  exclude_line_id=ln.id)
            inventory.unreceive_in_session(
                session, pn, qr, _eff_cost(ln), units, "po_line",
                f"{ln.id}:u{gen}",
                note=f"PO #{po.id} unreceived (qty {qr:g})", actor=actor,
                restore_cost=prev_cost, restore_last_cost=prev_cost,
                set_last_cost=was_latest)
        cores = session.scalars(select(CoreItem).where(
            CoreItem.po_id == po.id, CoreItem.status == "pending",
            CoreItem.ref.startswith(f"{ln.id}:", autoescape=True))).all()
        if cores:
            audit.record(session, "po_line", lref, "core_void", "core_qty",
                         sum(float(c.qty or 0.0) for c in cores), 0, actor)
            for c in cores:
                session.delete(c)
        audit.record(session, "po_line", lref, "unreceive", "qty_received",
                     qr, 0, actor)
        ln.qty_received = 0.0
        ln.received_at = None
        if po.status == "received":
            audit.record(session, "po", po.id, "update", "status",
                         "received", "ordered", actor)
            po.status = "ordered"
            po.received_at = None
        po.updated_at = now
        _recalc_total(po)
        session.commit()
        return _po_dict(po, with_lines=True, session=session)


# ----- Líneas ----------------------------------------------------------------

def add_line(po_id: int, part_number: str, description: str,
             qty: float, unit_cost: float, actor: str = "",
             taxable: bool = False, dry_run: bool = False) -> dict | None:
    """Agrega una línea. Con ajustes asignados, re-prorratea y puede revaluar
    lo ya recibido de otras líneas: `dry_run` devuelve ese preview."""
    description = (description or "").strip()
    part_number = (part_number or "").strip()
    if not description and not part_number:
        raise ValueError("description or part number is required")
    with SessionLocal() as session:
        po = session.get(PurchaseOrder, po_id)
        if po is None:
            return None
        before = _snapshot(po)
        ln = POLine(
            part_number=part_number[:60],
            description=description[:160] or part_number[:160],
            qty=max(0.0, float(qty or 0) or 1.0),
            unit_cost=max(0.0, float(unit_cost or 0)),
            taxable=bool(taxable),
        )
        po.lines.append(ln)
        session.flush()
        audit.record(session, "po_line", _line_ref(po.id, ln.id), "line_add",
                     "line", None,
                     f"{ln.qty:g} x {ln.part_number or ln.description} "
                     f"@ {ln.unit_cost:g}", actor)
        # Agregar una línea cambia el reparto de los ajustes asignados.
        revals = _reprice(session, po, before, actor, "line added")
        po.updated_at = datetime.now()
        _recalc_total(po)
        return _finish(session, po, revals, dry_run)


def update_line(po_id: int, line_id: int, fields: dict, actor: str = "",
                dry_run: bool = False) -> dict | None:
    """Edita una línea en CUALQUIER status / fin_status: unit_cost, qty,
    taxable, description. qty no puede bajar de qty_received (eso es un
    unreceive). Si la línea tiene unidades recibidas y su costo efectivo
    cambia, se revalúa el inventario (ver _reprice). `dry_run` devuelve el
    preview (incl. revaluations) sin guardar."""
    with SessionLocal() as session:
        po = session.get(PurchaseOrder, po_id)
        if po is None:
            return None
        ln = _find_line(po, line_id)
        if ln is None:
            return None
        before = _snapshot(po)
        lref = _line_ref(po.id, ln.id)
        if fields.get("qty") is not None:
            q = round(_num(fields["qty"], "quantity"), 4)
            if q <= 0:
                raise ValueError("quantity must be greater than 0")
            if q < float(ln.qty_received or 0.0) - _EPS:
                raise ValueError("quantity can't go below what was received "
                                 "— use unreceive")
            if abs(q - float(ln.qty or 0.0)) > _EPS:
                audit.record(session, "po_line", lref, "update", "qty",
                             ln.qty, q, actor)
                ln.qty = q
        if fields.get("unit_cost") is not None:
            c = round(_num(fields["unit_cost"], "unit cost"), 4)
            if c < 0:
                raise ValueError("unit cost can't be negative")
            if abs(c - float(ln.unit_cost or 0.0)) > _EPS:
                audit.record(session, "po_line", lref, "update", "unit_cost",
                             ln.unit_cost, c, actor)
                ln.unit_cost = c
        if fields.get("taxable") is not None:
            t = bool(fields["taxable"])
            if t != bool(ln.taxable):
                audit.record(session, "po_line", lref, "update", "taxable",
                             bool(ln.taxable), t, actor)
                ln.taxable = t
        if fields.get("description") is not None:
            d = str(fields["description"]).strip()[:160]
            pn = (ln.part_number or "").strip()
            if not d and not pn:
                raise ValueError("description or part number is required")
            d = d or pn[:160]
            if d != (ln.description or ""):
                audit.record(session, "po_line", lref, "update",
                             "description", ln.description, d, actor)
                ln.description = d
        revals = _reprice(session, po, before, actor, "line edited")
        po.updated_at = datetime.now()
        _recalc_total(po)
        return _finish(session, po, revals, dry_run)


def delete_line(po_id: int, line_id: int, actor: str = "",
                dry_run: bool = False) -> dict | None:
    """Quita una línea SIN unidades recibidas (con recibidas → 400: primero
    unreceive, así el stock nunca queda huérfano). Con ajustes asignados
    re-prorratea (puede revaluar otras líneas): `dry_run` = preview."""
    with SessionLocal() as session:
        po = session.get(PurchaseOrder, po_id)
        if po is None:
            return None
        ln = _find_line(po, line_id)
        if ln is None:
            return _po_dict(po, with_lines=True, session=session)
        if float(ln.qty_received or 0.0) > _EPS:
            raise ValueError("line has received parts — unreceive first")
        before = _snapshot(po)
        audit.record(session, "po_line", _line_ref(po.id, ln.id),
                     "line_delete", "line",
                     f"{ln.qty:g} x {ln.part_number or ln.description} "
                     f"@ {ln.unit_cost:g}", None, actor)
        po.lines.remove(ln)
        revals = _reprice(session, po, before, actor, "line deleted")
        po.updated_at = datetime.now()
        _recalc_total(po)
        return _finish(session, po, revals, dry_run)


def delete_po(po_id: int, actor: str = "") -> bool:
    """Borra una PO sin nada recibido (con recibido → 400). Antes desliga los
    parts requests que la originaron (vuelven a 'pending'), así el FK
    parts_request.po_id nunca queda colgando."""
    with SessionLocal() as session:
        po = session.get(PurchaseOrder, po_id)
        if po is None:
            return False
        if any(float(ln.qty_received or 0.0) > _EPS for ln in po.lines):
            raise ValueError("PO has received parts — unreceive first")
        for r in session.scalars(select(PartsRequest).where(
                PartsRequest.po_id == po.id)).all():
            r.po_id = None
            if r.status == "ordered":
                r.status = "pending"
        session.flush()
        audit.record(session, "po", po.id, "delete", "po",
                     f"{po.vendor or '-'} / {len(po.lines)} lines / "
                     f"{_financial(po)['total']:.2f}", None, actor)
        session.delete(po)
        session.commit()
        return True


# ----- Ajustes financieros + ciclo fin_status --------------------------------

def add_adjustment(po_id: int, kind: str, amount: float, note: str = "",
                   allocate: bool = False, actor: str = "",
                   dry_run: bool = False) -> dict | None:
    """Agrega un ajuste (descuento/crédito/flete/tax/fee/pago) en cualquier
    status / fin_status. `amount` > 0 (el signo lo da kind). allocate=True
    (no aplica a payment) lo reparte en el landed cost y revalúa lo ya
    recibido."""
    kind = str(kind or "").strip().lower()
    if kind not in ADJ_KINDS:
        raise ValueError(f"invalid adjustment kind: {kind}")
    amt = round(_num(amount, "amount"), 2)
    if amt <= 0:
        raise ValueError("amount must be greater than 0")
    alloc = bool(allocate) and kind in ALLOCATABLE
    with SessionLocal() as session:
        po = session.get(PurchaseOrder, po_id)
        if po is None:
            return None
        before = _snapshot(po)
        a = PoAdjustment(kind=kind, amount=amt,
                         note=str(note or "").strip()[:200], allocate=alloc,
                         actor=(actor or "")[:80], created_at=datetime.now(),
                         void_reason="")
        po.adjustments.append(a)
        session.flush()
        audit.record(session, "po", po.id, "adjustment_add", kind, None,
                     amt, actor)
        revals = _reprice(session, po, before, actor, f"{kind} added") \
            if alloc else []
        po.updated_at = datetime.now()
        _recalc_total(po)
        return _finish(session, po, revals, dry_run)


def void_adjustment(po_id: int, adj_id: int, reason: str = "",
                    actor: str = "") -> dict | None:
    """Anula un ajuste (nunca se borra). Si estaba asignado al landed cost,
    se re-prorratea y se revalúa lo recibido."""
    with SessionLocal() as session:
        po = session.get(PurchaseOrder, po_id)
        if po is None:
            return None
        a = next((x for x in po.adjustments if x.id == int(adj_id)), None)
        if a is None:
            return None
        if a.voided_at is not None:
            raise ValueError("adjustment already voided")
        before = _snapshot(po)
        a.voided_at = datetime.now()
        a.void_reason = str(reason or "").strip()[:200]
        audit.record(session, "po", po.id, "adjustment_void", a.kind,
                     a.amount, None, actor)
        revals = _reprice(session, po, before, actor, f"{a.kind} voided") \
            if a.allocate else []
        po.updated_at = datetime.now()
        _recalc_total(po)
        return _finish(session, po, revals)


def _set_fin_status(po_id: int, target: str, actor: str) -> dict | None:
    with SessionLocal() as session:
        po = session.get(PurchaseOrder, po_id)
        if po is None:
            return None
        cur = po.fin_status or "open"
        if cur != target:
            audit.record(session, "po", po.id,
                         "close" if target == "closed" else "reopen",
                         "fin_status", cur, target, actor)
            po.fin_status = target
            po.closed_at = datetime.now() if target == "closed" else None
            po.updated_at = datetime.now()
            session.commit()
        return _po_dict(po, with_lines=True, session=session)


def close_po(po_id: int, actor: str = "") -> dict | None:
    """Cierre FINANCIERO (fin_status closed). No toca stock ni congela
    costos: líneas y ajustes siguen editables."""
    return _set_fin_status(po_id, "closed", actor)


def reopen_po(po_id: int, actor: str = "") -> dict | None:
    """Reabre el ciclo financiero (solo fin_status; el stock no se toca)."""
    return _set_fin_status(po_id, "open", actor)


def stats() -> dict:
    with SessionLocal() as session:
        by_status = dict(session.execute(
            select(PurchaseOrder.status, func.count())
            .group_by(PurchaseOrder.status)).all())
        open_total = session.scalar(
            select(func.coalesce(func.sum(PurchaseOrder.total), 0.0))
            .where(PurchaseOrder.status != "received",
                   PurchaseOrder.fin_status == "open")) or 0.0
        closed = session.scalar(
            select(func.count()).select_from(PurchaseOrder)
            .where(PurchaseOrder.fin_status == "closed")) or 0
        return {
            "draft": by_status.get("draft", 0),
            "ordered": by_status.get("ordered", 0),
            "received": by_status.get("received", 0),
            "closed": int(closed),
            "open_value": round(float(open_total), 2),
        }


# ===== Parts Requests (cola de faltantes -> bundle por vendor -> PO) =========
# Increment 4 del handoff. Un faltante entra a la cola (bajo stock auto, WO o
# manual), el parts manager agrupa varios del mismo vendor y los funde en una
# sola PO. La PO en sí sigue el mismo pipeline draft->ordered->received de
# arriba (recibir repone stock).

def _req_dict(r: PartsRequest) -> dict:
    return {
        "id": r.id,
        "part_number": r.part_number or "",
        "description": r.description or "",
        "qty": r.qty,
        "unit_cost": r.unit_cost,
        "total": round(r.qty * r.unit_cost, 2),
        "vendor": r.vendor or "",
        "source": r.source or "manual",
        "source_ref": r.source_ref or "",
        "requested_by": r.requested_by or "",
        "status": r.status,
        "po_id": r.po_id,
        "created_at": r.created_at.isoformat(),
    }


def list_requests(status: str = "pending", limit: int = 300) -> list[dict]:
    with SessionLocal() as session:
        q = (select(PartsRequest)
             .order_by(PartsRequest.vendor, PartsRequest.id.desc())
             .limit(limit))
        if status:
            q = q.where(PartsRequest.status == status)
        return [_req_dict(r) for r in session.scalars(q).all()]


def request_stats() -> dict:
    """KPIs de la cabecera de Purchasing: faltantes pendientes + su valor,
    POs en vuelo (draft+ordered, fin_status open), y valor recibido en los últimos 30 días
    (por `received_at`: editar una PO recibida ya no la "re-fecha")."""
    cutoff = datetime.now() - timedelta(days=30)
    with SessionLocal() as session:
        pend = session.scalars(
            select(PartsRequest).where(PartsRequest.status == "pending")).all()
        pending_n = len(pend)
        pending_value = round(sum(r.qty * r.unit_cost for r in pend), 2)
        vendors_n = len({(r.vendor or "").strip().lower()
                         for r in pend if (r.vendor or "").strip()})
        # En vuelo = draft/ordered Y financieramente abierta (misma regla que
        # stats().open_value: una PO cerrada no suma "en vuelo").
        in_flight = (PurchaseOrder.status.in_(("draft", "ordered")),
                     PurchaseOrder.fin_status == "open")
        pos_in_flight = session.scalar(
            select(func.count()).select_from(PurchaseOrder)
            .where(*in_flight)) or 0
        in_flight_value = session.scalar(
            select(func.coalesce(func.sum(PurchaseOrder.total), 0.0))
            .where(*in_flight)) or 0.0
        recv_30 = session.execute(
            select(func.coalesce(func.sum(PurchaseOrder.total), 0.0),
                   func.count())
            .where(PurchaseOrder.status == "received",
                   PurchaseOrder.received_at.is_not(None),
                   PurchaseOrder.received_at >= cutoff)).one()
        return {
            "pending": pending_n,
            "pending_value": pending_value,
            "vendors": vendors_n,
            "pos_in_flight": int(pos_in_flight),
            "in_flight_value": round(float(in_flight_value), 2),
            "received_30d_value": round(float(recv_30[0] or 0.0), 2),
            "received_30d_count": int(recv_30[1] or 0),
        }


def create_request(part_number: str = "", description: str = "",
                   qty: float = 1.0, unit_cost: float = 0.0,
                   vendor: str = "", source: str = "manual",
                   source_ref: str = "", requested_by: str = "") -> dict:
    part_number = (part_number or "").strip()
    description = (description or "").strip()
    if not part_number and not description:
        raise ValueError("part number or description is required")
    r = PartsRequest(
        part_number=part_number[:60],
        description=(description or part_number)[:160],
        qty=max(0.0, float(qty or 0) or 1.0),
        unit_cost=max(0.0, float(unit_cost or 0)),
        vendor=(vendor or "").strip()[:120],
        source=(source or "manual")[:20],
        source_ref=(source_ref or "")[:60],
        requested_by=(requested_by or "")[:60],
        status="pending",
        created_at=datetime.now(),
    )
    with SessionLocal() as session:
        session.add(r)
        session.commit()
        return _req_dict(r)


def generate_low_stock_requests() -> dict:
    """Crea un request pendiente por cada parte en/bajo su reorder_point que
    todavía no tenga uno pendiente. Cantidad sugerida: reponer hasta 2× el
    punto de reorden. Idempotente por part_number (no duplica)."""
    with SessionLocal() as session:
        existing = {pn for (pn,) in session.execute(
            select(PartsRequest.part_number)
            .where(PartsRequest.status == "pending")).all()}
        low = session.scalars(
            select(Part).where(Part.reorder_point > 0,
                               Part.on_hand <= Part.reorder_point)).all()
        vmap = {v.id: v.name for v in session.scalars(select(Vendor)).all()}
        created = 0
        for p in low:
            if p.part_number in existing:
                continue
            target = p.reorder_point * 2
            qty = max(1.0, math.ceil(target - p.on_hand))
            session.add(PartsRequest(
                part_number=p.part_number[:60],
                description=(p.description or p.part_number)[:160],
                qty=qty, unit_cost=p.cost or 0.0,
                vendor=(vmap.get(p.vendor_id, "") or "")[:120],
                source="low_stock", source_ref="auto",
                requested_by="system", status="pending",
                created_at=datetime.now(),
            ))
            created += 1
        session.commit()
        return {"created": created}


def bundle_requests(request_ids: list[int], actor: str = "") -> dict:
    """Funde varios requests PENDIENTES del MISMO vendor en una sola PO draft.
    Marca los requests como 'ordered' y los liga a la PO. Rechaza selección
    de vendors mezclados o vacía."""
    ids = [int(i) for i in (request_ids or [])]
    if not ids:
        raise ValueError("select at least one request")
    with SessionLocal() as session:
        reqs = session.scalars(
            select(PartsRequest).where(
                PartsRequest.id.in_(ids),
                PartsRequest.status == "pending")).all()
        if not reqs:
            raise ValueError("no pending requests found for that selection")
        vendors = {(r.vendor or "").strip() for r in reqs}
        if len(vendors) > 1:
            raise ValueError("all requests must share the same vendor")
        vendor = next(iter(vendors))
        lines = [{"part_number": r.part_number, "description": r.description,
                  "qty": r.qty, "unit_cost": r.unit_cost} for r in reqs]

    # create_po abre su propia sesión (org-scoped por el contexto del request).
    po = create_po(vendor=vendor, notes="Bundled from parts requests",
                   lines=lines, actor=actor)

    with SessionLocal() as session:
        for r in session.scalars(
                select(PartsRequest).where(PartsRequest.id.in_(ids))).all():
            if r.status == "pending":
                r.status = "ordered"
                r.po_id = po["id"]
        session.commit()
    return {"po": po, "n": len(reqs)}


def cancel_request(request_id: int) -> bool:
    with SessionLocal() as session:
        r = session.get(PartsRequest, request_id)
        if r is None:
            return False
        session.delete(r)
        session.commit()
        return True
