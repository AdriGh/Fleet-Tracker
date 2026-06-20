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

from datetime import datetime

from sqlalchemy import func, select

from ..db import POLine, PurchaseOrder, SessionLocal

STATUSES = ("draft", "ordered", "received")


def _line_dict(ln: POLine) -> dict:
    return {
        "id": ln.id,
        "part_number": ln.part_number or "",
        "description": ln.description,
        "qty": ln.qty,
        "unit_cost": ln.unit_cost,
        "total": round(ln.qty * ln.unit_cost, 2),
    }


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
        if "status" in fields:
            target = str(fields["status"])
            if target not in STATUSES:
                raise ValueError(f"invalid status: {target}")
            po.status = target
        po.updated_at = datetime.now()
        _recalc_total(po)
        session.commit()
        return _po_dict(po, with_lines=True)


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
