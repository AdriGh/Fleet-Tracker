# -*- coding: utf-8 -*-
"""Purchase Orders / QuickBuy (Increment B).

Órdenes de compra de partes a un vendor, primera versión. Espeja el módulo
de work orders (core/workorders.py): serializers a dict, org-scoping
automático vía los eventos de SessionLocal (db.py), y pipeline simple.

Pipeline:
    draft -> ordered -> received

`draft` es editable (se arman las líneas); `ordered` significa que se mandó
al proveedor; `received` que llegó la mercancía. Avanzar/retroceder es libre
por ahora (sin gates duros, salvo que el estado sea válido). El `total` se
recalcula SIEMPRE desde las líneas al guardar y al serializar, así el valor
cacheado en la fila nunca queda desincronizado.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta

from sqlalchemy import func, select

from ..db import (
    Part, PartsRequest, POLine, PurchaseOrder, SessionLocal, Vendor,
)

STATUSES = ("draft", "ordered", "received")


def _line_dict(ln: POLine) -> dict:
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
    }


def _receiving_state(po: PurchaseOrder) -> str:
    """Estado DERIVADO de recepción (no se guarda; no toca el pipeline de
    status): 'full' si la PO está recibida, 'partial' si llegó algo pero no
    todo, 'none' si no llegó nada."""
    if po.status == "received":
        return "full"
    recv = sum(min(ln.qty_received or 0.0, ln.qty) for ln in po.lines
               if (ln.part_number or "").strip())
    return "partial" if recv > 1e-9 else "none"


def _po_dict(po: PurchaseOrder, with_lines: bool = False) -> dict:
    total = round(sum(ln.qty * ln.unit_cost for ln in po.lines), 2)
    out = {
        "id": po.id,
        "created_at": po.created_at.isoformat(),
        "updated_at": po.updated_at.isoformat(),
        "vendor": po.vendor or "",
        "status": po.status,
        "notes": po.notes or "",
        "total": total,
        "n_lines": len(po.lines),
        "received_at": po.received_at.isoformat() if po.received_at else None,
        "backorder_of_po_id": po.backorder_of_po_id,
        "receiving_state": _receiving_state(po),
    }
    if with_lines:
        out["lines"] = [_line_dict(ln) for ln in po.lines]
    return out


def list_pos(status: str = "", limit: int = 200) -> list[dict]:
    with SessionLocal() as session:
        q = select(PurchaseOrder).order_by(PurchaseOrder.id.desc()).limit(limit)
        if status:
            q = q.where(PurchaseOrder.status == status)
        return [_po_dict(p) for p in session.scalars(q).all()]


def get_po(po_id: int) -> dict | None:
    with SessionLocal() as session:
        po = session.get(PurchaseOrder, po_id)
        return _po_dict(po, with_lines=True) if po else None


def _recalc_total(po: PurchaseOrder) -> None:
    po.total = round(sum(ln.qty * ln.unit_cost for ln in po.lines), 2)


def create_po(vendor: str = "", notes: str = "",
              lines: list[dict] | None = None) -> dict:
    """Crea una PO en estado draft. `lines` (opcional) es una lista de
    {part_number, description, qty, unit_cost}: el QuickBuy crea la PO con
    una línea de un saque."""
    now = datetime.now()
    po = PurchaseOrder(
        created_at=now, updated_at=now,
        vendor=vendor.strip()[:120],
        status="draft",
        notes=notes.strip(),
    )
    for ld in (lines or []):
        desc = str(ld.get("description", "")).strip()
        pn = str(ld.get("part_number", "")).strip()
        if not desc and not pn:
            continue
        po.lines.append(POLine(
            part_number=pn[:60],
            description=desc[:160] or pn[:160],
            qty=max(0.0, float(ld.get("qty") or 0) or 1.0),
            unit_cost=max(0.0, float(ld.get("unit_cost") or 0)),
        ))
    _recalc_total(po)
    with SessionLocal() as session:
        session.add(po)
        session.commit()
        return _po_dict(po, with_lines=True)


def update_po(po_id: int, fields: dict) -> dict | None:
    """Actualiza campos editables de una PO (vendor, notes, status). El
    cambio de status valida que el destino sea un estado conocido."""
    with SessionLocal() as session:
        po = session.get(PurchaseOrder, po_id)
        if po is None:
            return None
        if "vendor" in fields:
            po.vendor = str(fields["vendor"]).strip()[:120]
        if "notes" in fields:
            po.notes = str(fields["notes"]).strip()
        received_now = False
        if "status" in fields:
            target = str(fields["status"])
            if target not in STATUSES:
                raise ValueError(f"invalid status: {target}")
            received_now = target == "received"
            po.status = target
        now = datetime.now()
        po.updated_at = now
        _recalc_total(po)
        # Al pasar a 'received' se repone SOLO lo que falta de cada línea
        # (qty - qty_received), no la qty entera. El movimiento se crea EN LA
        # MISMA sesión (atómico con qty_received): si algo falla, se deshace
        # todo. ref_id ':full' -> idempotente re-marcar received.
        if received_now:
            from . import inventory
            for ln in po.lines:
                if not (ln.part_number or "").strip():
                    continue
                remaining = round(ln.qty - (ln.qty_received or 0.0), 4)
                if remaining <= 1e-9:
                    continue
                applied = inventory.apply_in_session(
                    session, ln.part_number, remaining, "po_receive",
                    ref_type="po_line", ref_id=f"{ln.id}:full",
                    note=f"PO #{po_id} received")
                if applied:
                    ln.qty_received = ln.qty
                    ln.received_at = now
            po.received_at = po.received_at or now
        session.commit()
        return _po_dict(po, with_lines=True)


def receive_po(po_id: int, receipts: list[dict], token: str = "",
               create_backorder: bool = True) -> dict | None:
    """Recepción por línea (parcial o total) de una PO.

    `receipts` = [{line_id, qty_now}] con la cantidad que llegó AHORA por
    línea. Aplica solo el delta (clamp a lo pendiente), repone stock de forma
    idempotente (ref_id versionado por `token` del evento) y — si se pidió
    (`create_backorder`) y quedan faltantes — auto-genera UNA PO de backorder
    (draft) con las líneas cortas y cierra la PO original como 'received'.
    Idempotente: reenviar el mismo (payload + token) es no-op (ni suma stock
    ni incrementa qty_received).
    """
    tok = (str(token or "").strip().replace(" ", "") or "e")[:24]
    now = datetime.now()
    short_lines: list[dict] = []
    parent_vendor = ""
    received_any = False
    with SessionLocal() as session:
        from . import inventory
        po = session.get(PurchaseOrder, po_id)
        if po is None:
            return None
        parent_vendor = po.vendor or ""
        by_id = {ln.id: ln for ln in po.lines}
        for r in (receipts or []):
            if r.get("line_id") is None:
                continue
            ln = by_id.get(int(r["line_id"]))
            if ln is None or not (ln.part_number or "").strip():
                continue
            remaining = round(ln.qty - (ln.qty_received or 0.0), 4)
            take = min(max(0.0, float(r.get("qty_now") or 0)), max(0.0, remaining))
            if take <= 1e-9:
                continue
            # Movimiento EN-SESIÓN: atómico con qty_received e idempotente por
            # (line_id, token). Si el evento ya se aplicó, devuelve False y NO
            # tocamos qty_received (no diverge del stock ante reintentos).
            applied = inventory.apply_in_session(
                session, ln.part_number, take, "po_receive",
                ref_type="po_line", ref_id=f"{ln.id}:{tok}",
                note=f"PO #{po_id} received (qty {take:g})")
            if not applied:
                continue
            ln.qty_received = round((ln.qty_received or 0.0) + take, 4)
            ln.received_at = now
            received_any = True
        # Solo si algo se recibió realmente: decidir cierre / backorder.
        # (Con receipts vacío o todo ya recibido -> no-op, sin cerrar ni
        # backordear.)
        if received_any:
            for ln in po.lines:
                if not (ln.part_number or "").strip():
                    continue
                short = round(ln.qty - (ln.qty_received or 0.0), 4)
                if short > 1e-9:
                    short_lines.append({
                        "part_number": ln.part_number,
                        "description": ln.description,
                        "qty": short, "unit_cost": ln.unit_cost,
                    })
            will_backorder = create_backorder and bool(short_lines)
            # Se cierra si llegó todo (sin faltantes) o si se backordea el resto.
            if not short_lines or will_backorder:
                po.status = "received"
                po.received_at = now
        po.updated_at = now
        _recalc_total(po)
        session.commit()
        result = _po_dict(po, with_lines=True)

    # Backorder: si quedaron faltantes y se pidió, crear PO draft linkeada.
    backorder = None
    if create_backorder and received_any and short_lines:
        child = create_po(vendor=parent_vendor,
                          notes=f"Backorder of PO #{po_id}", lines=short_lines)
        with SessionLocal() as session:
            cpo = session.get(PurchaseOrder, child["id"])
            if cpo is not None:
                cpo.backorder_of_po_id = po_id
                session.commit()
                backorder = _po_dict(cpo, with_lines=True)
        backorder = backorder or child
    return {"po": result, "backorder": backorder}


def add_line(po_id: int, part_number: str, description: str,
             qty: float, unit_cost: float) -> dict | None:
    description = (description or "").strip()
    part_number = (part_number or "").strip()
    if not description and not part_number:
        raise ValueError("description or part number is required")
    with SessionLocal() as session:
        po = session.get(PurchaseOrder, po_id)
        if po is None:
            return None
        po.lines.append(POLine(
            part_number=part_number[:60],
            description=description[:160] or part_number[:160],
            qty=max(0.0, float(qty or 0) or 1.0),
            unit_cost=max(0.0, float(unit_cost or 0)),
        ))
        po.updated_at = datetime.now()
        _recalc_total(po)
        session.commit()
        return _po_dict(po, with_lines=True)


def delete_line(po_id: int, line_id: int) -> dict | None:
    with SessionLocal() as session:
        po = session.get(PurchaseOrder, po_id)
        if po is None:
            return None
        po.lines = [ln for ln in po.lines if ln.id != line_id]
        po.updated_at = datetime.now()
        _recalc_total(po)
        session.commit()
        return _po_dict(po, with_lines=True)


def delete_po(po_id: int) -> bool:
    with SessionLocal() as session:
        po = session.get(PurchaseOrder, po_id)
        if po is None:
            return False
        session.delete(po)
        session.commit()
        return True


def stats() -> dict:
    with SessionLocal() as session:
        by_status = dict(session.execute(
            select(PurchaseOrder.status, func.count())
            .group_by(PurchaseOrder.status)).all())
        open_total = session.scalar(
            select(func.coalesce(func.sum(PurchaseOrder.total), 0.0))
            .where(PurchaseOrder.status != "received")) or 0.0
        return {
            "draft": by_status.get("draft", 0),
            "ordered": by_status.get("ordered", 0),
            "received": by_status.get("received", 0),
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
    POs en vuelo (draft+ordered), y valor recibido en los últimos 30 días."""
    cutoff = datetime.now() - timedelta(days=30)
    with SessionLocal() as session:
        pend = session.scalars(
            select(PartsRequest).where(PartsRequest.status == "pending")).all()
        pending_n = len(pend)
        pending_value = round(sum(r.qty * r.unit_cost for r in pend), 2)
        vendors_n = len({(r.vendor or "").strip().lower()
                         for r in pend if (r.vendor or "").strip()})
        pos_in_flight = session.scalar(
            select(func.count()).select_from(PurchaseOrder)
            .where(PurchaseOrder.status.in_(("draft", "ordered")))) or 0
        in_flight_value = session.scalar(
            select(func.coalesce(func.sum(PurchaseOrder.total), 0.0))
            .where(PurchaseOrder.status.in_(("draft", "ordered")))) or 0.0
        recv_30 = session.execute(
            select(func.coalesce(func.sum(PurchaseOrder.total), 0.0),
                   func.count())
            .where(PurchaseOrder.status == "received",
                   PurchaseOrder.updated_at >= cutoff)).one()
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
        vmap = {v.id: v.name for v in session.scalars(
            select(__import__("app.db", fromlist=["Vendor"]).Vendor)).all()}
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


def bundle_requests(request_ids: list[int]) -> dict:
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
                   lines=lines)

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
