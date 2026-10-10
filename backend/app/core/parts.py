# -*- coding: utf-8 -*-
"""Catálogo de Partes + Vendors (fase H3, estilo Fullbay).

Dos catálogos maestros que alimentan las líneas de las work orders:
- Vendors: proveedores a los que el taller compra.
- Parts: partes con costo INTERNO (lo que paga el taller, sin markup —
  decisión del usuario) y vendor opcional; `on_hand` es un conteo de
  inventario manual (sin auto-decremento todavía).

Persistencia en SQLite (mismas tablas del resto de la app). Los precios
son costo, no precio de venta: esta es la flota propia del taller.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from ..db import Part, SessionLocal, Vendor, WorkOrder, WorkOrderLine


# ----- Vendors -------------------------------------------------------------

# Outside work (v2.21): qué es el vendor para el taller.
VENDOR_KINDS = ("", "parts", "shop", "both")


def _vendor_dict(v: Vendor, parts_count: int = 0, wo_count: int = 0) -> dict:
    return {
        "id": v.id,
        "name": v.name,
        "contact": v.contact,
        "phone": v.phone,
        "email": v.email,
        "address": v.address,
        "account": v.account,
        "notes": v.notes,
        "kind": v.kind or "",
        "city": v.city or "",
        "state": v.state or "",
        "parts_count": parts_count,
        "wo_count": wo_count,          # WOs outside/inside ligadas (v2.21)
    }


def _wo_count(session, vendor_id: int) -> int:
    return session.scalar(
        select(func.count()).select_from(WorkOrder)
        .where(WorkOrder.vendor_id == vendor_id)) or 0


def list_vendors() -> list[dict]:
    with SessionLocal() as session:
        counts = dict(session.execute(
            select(Part.vendor_id, func.count())
            .group_by(Part.vendor_id)).all())
        wo_counts = dict(session.execute(
            select(WorkOrder.vendor_id, func.count())
            .where(WorkOrder.vendor_id.is_not(None))
            .group_by(WorkOrder.vendor_id)).all())
        rows = session.scalars(
            select(Vendor).order_by(func.lower(Vendor.name))).all()
        return [_vendor_dict(v, counts.get(v.id, 0), wo_counts.get(v.id, 0))
                for v in rows]


_VENDOR_FIELDS = ("name", "contact", "phone", "email", "address",
                  "account", "notes", "kind", "city", "state")
_VENDOR_CAPS = {"name": 120, "contact": 120, "phone": 40, "email": 120,
                "address": 200, "account": 60, "notes": 300,
                "kind": 12, "city": 80, "state": 20}


def _clean_vendor_field(f: str, raw) -> str:
    val = str(raw if raw is not None else "").strip()[:_VENDOR_CAPS[f]]
    if f == "kind":
        val = val.lower()
        if val not in VENDOR_KINDS:
            raise ValueError("kind must be parts, shop, both or empty")
    if f == "state":
        val = val.upper()
    return val


def create_vendor(data: dict) -> dict:
    name = str(data.get("name", "")).strip()
    if not name:
        raise ValueError("Vendor name is required")
    with SessionLocal() as session:
        v = Vendor(created_at=datetime.now())
        for f in _VENDOR_FIELDS:
            if f in data:
                setattr(v, f, _clean_vendor_field(f, data[f]))
        v.name = name[:120]
        session.add(v)
        session.commit()
        return _vendor_dict(v)


def update_vendor(vendor_id: int, data: dict) -> dict | None:
    with SessionLocal() as session:
        v = session.get(Vendor, vendor_id)
        if v is None:
            return None
        for f in _VENDOR_FIELDS:
            if f in data:
                val = _clean_vendor_field(f, data[f])
                if f == "name" and not val:
                    raise ValueError("Vendor name is required")
                setattr(v, f, val)
        session.commit()
        n = session.scalar(select(func.count()).select_from(Part)
                           .where(Part.vendor_id == v.id)) or 0
        return _vendor_dict(v, n, _wo_count(session, v.id))


def delete_vendor(vendor_id: int) -> bool:
    """Borra el vendor. Las partes que lo referenciaban quedan sin vendor
    (vendor_id -> NULL), no se borran. Outside work (v2.21): si tiene work
    orders ligadas NO se borra (ValueError): la WO outside perdería su
    taller; hay que reasignarlas primero."""
    with SessionLocal() as session:
        v = session.get(Vendor, vendor_id)
        if v is None:
            return False
        if _wo_count(session, v.id):
            raise ValueError("vendor has work orders; reassign them first")
        for p in session.scalars(
                select(Part).where(Part.vendor_id == v.id)).all():
            p.vendor_id = None
        # v2.22: las POs ligadas por FK conservan el NOMBRE (texto `vendor`)
        # y pierden solo el vínculo (si no, el FK rompe el borrado en PG).
        from ..db import PurchaseOrder
        for po in session.scalars(select(PurchaseOrder).where(
                PurchaseOrder.vendor_id == v.id)).all():
            po.vendor_id = None
        session.flush()
        session.delete(v)
        session.commit()
        return True


# ----- Parts ---------------------------------------------------------------

def _part_dict(p: Part, vendor_name: str = "") -> dict:
    return {
        "id": p.id,
        "part_number": p.part_number,
        "description": p.description,
        "category": p.category,
        "manufacturer": p.manufacturer,
        "cost": round(p.cost, 2),
        # Costo promedio: si no se registró, cae al costo estándar. v2.22: es
        # el promedio ponderado móvil que mantiene cada recepción de PO; es
        # el costo por defecto de una línea de parte en una WO.
        "avg_cost": round(p.avg_cost or p.cost, 2),
        # v2.22: costo (landed) de la última recepción; None = nunca recibida.
        "last_cost": (None if p.last_cost is None
                      else round(p.last_cost, 2)),
        "vendor_id": p.vendor_id,
        "vendor_name": vendor_name,
        "on_hand": p.on_hand,
        "reorder_point": p.reorder_point,   # = mínimo
        "max_qty": p.max_qty,               # objetivo de stock
        "bin": p.bin,
        "upc": p.upc,
        "fits": p.fits,
        "source": p.source,
        "core_charge": round(p.core_charge or 0.0, 2),
        "warranty_months": int(p.warranty_months or 0),
        "notes": p.notes,
    }


def list_parts() -> list[dict]:
    with SessionLocal() as session:
        vendors = dict(session.execute(select(Vendor.id, Vendor.name)).all())
        rows = session.scalars(
            select(Part).order_by(func.lower(Part.part_number))).all()
        return [_part_dict(p, vendors.get(p.vendor_id, "")) for p in rows]


def categories() -> list[str]:
    with SessionLocal() as session:
        rows = session.scalars(select(Part.category).distinct()).all()
        return sorted({c for c in rows if c})


def create_part(data: dict) -> dict:
    pn = str(data.get("part_number", "")).strip()
    if not pn:
        raise ValueError("Part number is required")
    with SessionLocal() as session:
        dup = session.scalar(select(Part).where(
            func.lower(Part.part_number) == pn.lower()))
        if dup is not None:
            raise ValueError(f"Part {pn} already exists")
        now = datetime.now()
        p = Part(part_number=pn[:60], created_at=now, updated_at=now)
        _apply_part(p, data)
        session.add(p)
        try:
            session.commit()
        except IntegrityError:
            # DATA-4: backstop ante carrera (otra request creó la misma parte
            # entre el chequeo de arriba y este commit).
            session.rollback()
            raise ValueError(f"Part {pn} already exists")
        name = ""
        if p.vendor_id:
            v = session.get(Vendor, p.vendor_id)
            name = v.name if v else ""
        return _part_dict(p, name)


def update_part(part_id: int, data: dict) -> dict | None:
    """Edita la ficha de una parte. `on_hand` se IGNORA en la edición: la
    existencia solo cambia con un movimiento del libro (POST /parts/adjust,
    recepciones, consumos). Escribirla directo desde un formulario abierto
    pisaba recepciones concurrentes y desalineaba el promedio ponderado."""
    data = {k: v for k, v in (data or {}).items() if k != "on_hand"}
    with SessionLocal() as session:
        p = session.get(Part, part_id)
        if p is None:
            return None
        if "part_number" in data:
            pn = str(data["part_number"]).strip()
            if not pn:
                raise ValueError("Part number is required")
            dup = session.scalar(select(Part).where(
                func.lower(Part.part_number) == pn.lower(),
                Part.id != p.id))
            if dup is not None:
                raise ValueError(f"Part {pn} already exists")
            p.part_number = pn[:60]
        _apply_part(p, data)
        p.updated_at = datetime.now()
        session.commit()
        name = ""
        if p.vendor_id:
            v = session.get(Vendor, p.vendor_id)
            name = v.name if v else ""
        return _part_dict(p, name)


def _apply_part(p: Part, data: dict) -> None:
    if "description" in data:
        p.description = str(data["description"]).strip()[:160]
    if "category" in data:
        p.category = str(data["category"]).strip()[:40]
    if "notes" in data:
        p.notes = str(data["notes"]).strip()[:300]
    if "cost" in data:
        try:
            p.cost = max(0.0, float(data["cost"] or 0))
        except (TypeError, ValueError):
            pass
    if "on_hand" in data:
        try:
            p.on_hand = float(data["on_hand"] or 0)
        except (TypeError, ValueError):
            pass
    if "reorder_point" in data:
        try:
            p.reorder_point = max(0.0, float(data["reorder_point"] or 0))
        except (TypeError, ValueError):
            pass
    if "vendor_id" in data:
        vid = data["vendor_id"]
        p.vendor_id = int(vid) if vid not in (None, "", 0, "0") else None
    # Campos ricos del catálogo (v1.48).
    if "manufacturer" in data:
        p.manufacturer = str(data["manufacturer"]).strip()[:80]
    if "bin" in data:
        p.bin = str(data["bin"]).strip()[:40]
    if "upc" in data:
        p.upc = str(data["upc"]).strip()[:40]
    if "fits" in data:
        p.fits = str(data["fits"]).strip()[:200]
    if "source" in data:
        p.source = str(data["source"]).strip()[:30]
    if "max_qty" in data:
        try:
            p.max_qty = max(0.0, float(data["max_qty"] or 0))
        except (TypeError, ValueError):
            pass
    if "avg_cost" in data:
        try:
            p.avg_cost = max(0.0, float(data["avg_cost"] or 0))
        except (TypeError, ValueError):
            pass
    if "core_charge" in data:
        try:
            p.core_charge = max(0.0, float(data["core_charge"] or 0))
        except (TypeError, ValueError):
            pass
    if "warranty_months" in data:
        try:
            p.warranty_months = max(0, int(data["warranty_months"] or 0))
        except (TypeError, ValueError):
            pass


def delete_part(part_id: int) -> bool:
    with SessionLocal() as session:
        p = session.get(Part, part_id)
        if p is None:
            return False
        session.delete(p)
        session.commit()
        return True


def part_usage() -> dict[str, int]:
    """Cuántas líneas de WO referencian cada part_number (para reportes)."""
    with SessionLocal() as session:
        rows = session.execute(
            select(WorkOrderLine.part_number, func.count())
            .where(WorkOrderLine.part_number != "")
            .group_by(WorkOrderLine.part_number)).all()
        return {pn: n for pn, n in rows}


# ----- v2.22: perfil del vendor (Resources → Vendors) ------------------------

_PROFILE_LIMIT = 200


def vendor_profile(vendor_id: int) -> dict | None:
    """Perfil del vendor: sus WOs (outside work y cualquier WO ligada por
    vendor_id), sus POs (por vendor_id o, si la PO no está ligada, por
    NOMBRE case-insensitive), sus partes (Part.vendor_id) y totales:
    - spend_ytd = POs ordered/received del año (fecha = recepción o alta;
      total financiero de la PO) + WOs outside completed/invoiced del año
      (fecha efectiva), en la TZ de la org;
    - open_po_value = POs no recibidas y financieramente abiertas (misma
      regla que purchasing.stats().open_value);
    - outside_wo_total = Σ total de las WOs outside del vendor (histórico).
    None = el vendor no existe en la org."""
    from sqlalchemy import and_, or_
    from sqlalchemy.orm import selectinload
    from ..db import PurchaseOrder
    from . import org_config, purchasing, workorders  # import diferido
    with SessionLocal() as session:
        v = session.get(Vendor, vendor_id)
        if v is None:
            return None
        year = org_config.org_today().year
        parts_rows = session.scalars(
            select(Part).where(Part.vendor_id == v.id)
            .order_by(func.lower(Part.part_number))).all()
        wos = session.scalars(
            select(WorkOrder).options(selectinload(WorkOrder.lines))
            .where(WorkOrder.vendor_id == v.id)
            .order_by(WorkOrder.id.desc())).all()
        name_key = " ".join((v.name or "").split()).lower()
        pos = session.scalars(
            select(PurchaseOrder)
            .options(selectinload(PurchaseOrder.lines),
                     selectinload(PurchaseOrder.adjustments))
            .where(or_(PurchaseOrder.vendor_id == v.id,
                       and_(PurchaseOrder.vendor_id.is_(None),
                            func.lower(func.trim(PurchaseOrder.vendor))
                            == name_key)))
            .order_by(PurchaseOrder.id.desc())).all()

        po_spend_ytd = open_po_value = po_balance = 0.0
        po_rows: list[dict] = []
        for po in pos:
            d = purchasing._po_dict(po)
            fin = d["financial"]
            if po.status in ("ordered", "received"):
                when = org_config.to_org_date(po.received_at or po.created_at)
                if when is not None and when.year == year:
                    po_spend_ytd += fin["total"]
            if po.status != "received" and (po.fin_status or "open") == "open":
                open_po_value += fin["total"]
            if po.status != "draft":
                po_balance += fin["balance"]
            if len(po_rows) < _PROFILE_LIMIT:
                po_rows.append(d)

        outside_total = outside_ytd = 0.0
        wo_rows: list[dict] = []
        for wo in wos:
            total = round(sum(float(ln.qty or 0) * float(ln.unit_cost or 0)
                              for ln in wo.lines), 2)
            if (wo.wo_type or "inside") == "outside":
                outside_total += total
                eff = workorders.effective_date(wo)
                if (wo.status in ("completed", "invoiced") and eff is not None
                        and eff.year == year):
                    outside_ytd += total
            if len(wo_rows) < _PROFILE_LIMIT:
                wo_rows.append({
                    "id": wo.id,
                    "display_no": workorders._display_no(wo),
                    "unit": wo.unit,
                    "title": wo.title,
                    "status": wo.status,
                    "wo_type": wo.wo_type or "inside",
                    "shop_invoice": wo.shop_invoice or "",
                    "created_at": (wo.created_at.isoformat()
                                   if wo.created_at else None),
                    "closed_at": (wo.closed_at.isoformat()
                                  if wo.closed_at else None),
                    "invoiced_at": (wo.invoiced_at.isoformat()
                                    if wo.invoiced_at else None),
                    "total": total,
                })
        return {
            "vendor": _vendor_dict(v, len(parts_rows), len(wos)),
            "work_orders": wo_rows,
            "purchase_orders": po_rows,
            "parts": [_part_dict(p, v.name) for p in parts_rows],
            "totals": {
                "spend_ytd": round(po_spend_ytd + outside_ytd, 2),
                "po_spend_ytd": round(po_spend_ytd, 2),
                "outside_spend_ytd": round(outside_ytd, 2),
                "open_po_value": round(open_po_value, 2),
                "po_balance": round(po_balance, 2),
                "outside_wo_total": round(outside_total, 2),
                "wo_count": len(wos),
                "po_count": len(pos),
                "parts_count": len(parts_rows),
            },
        }
