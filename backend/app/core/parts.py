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

from ..db import Part, SessionLocal, Vendor, WorkOrderLine


# ----- Vendors -------------------------------------------------------------

def _vendor_dict(v: Vendor, parts_count: int = 0) -> dict:
    return {
        "id": v.id,
        "name": v.name,
        "contact": v.contact,
        "phone": v.phone,
        "email": v.email,
        "address": v.address,
        "account": v.account,
        "notes": v.notes,
        "parts_count": parts_count,
    }


def list_vendors() -> list[dict]:
    with SessionLocal() as session:
        counts = dict(session.execute(
            select(Part.vendor_id, func.count())
            .group_by(Part.vendor_id)).all())
        rows = session.scalars(
            select(Vendor).order_by(func.lower(Vendor.name))).all()
        return [_vendor_dict(v, counts.get(v.id, 0)) for v in rows]


_VENDOR_FIELDS = ("name", "contact", "phone", "email", "address",
                  "account", "notes")
_VENDOR_CAPS = {"name": 120, "contact": 120, "phone": 40, "email": 120,
                "address": 200, "account": 60, "notes": 300}


def create_vendor(data: dict) -> dict:
    name = str(data.get("name", "")).strip()
    if not name:
        raise ValueError("Vendor name is required")
    with SessionLocal() as session:
        v = Vendor(created_at=datetime.now())
        for f in _VENDOR_FIELDS:
            if f in data:
                setattr(v, f, str(data[f]).strip()[:_VENDOR_CAPS[f]])
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
                val = str(data[f]).strip()[:_VENDOR_CAPS[f]]
                if f == "name" and not val:
                    raise ValueError("Vendor name is required")
                setattr(v, f, val)
        session.commit()
        n = session.scalar(select(func.count()).select_from(Part)
                           .where(Part.vendor_id == v.id)) or 0
        return _vendor_dict(v, n)


def delete_vendor(vendor_id: int) -> bool:
    """Borra el vendor. Las partes que lo referenciaban quedan sin vendor
    (vendor_id -> NULL), no se borran."""
    with SessionLocal() as session:
        v = session.get(Vendor, vendor_id)
        if v is None:
            return False
        for p in session.scalars(
                select(Part).where(Part.vendor_id == v.id)).all():
            p.vendor_id = None
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
        "cost": round(p.cost, 2),
        "vendor_id": p.vendor_id,
        "vendor_name": vendor_name,
        "on_hand": p.on_hand,
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
        session.commit()
        name = ""
        if p.vendor_id:
            v = session.get(Vendor, p.vendor_id)
            name = v.name if v else ""
        return _part_dict(p, name)


def update_part(part_id: int, data: dict) -> dict | None:
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
    if "vendor_id" in data:
        vid = data["vendor_id"]
        p.vendor_id = int(vid) if vid not in (None, "", 0, "0") else None


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
