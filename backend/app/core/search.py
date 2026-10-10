# -*- coding: utf-8 -*-
"""Búsqueda global (v2.22, command palette Ctrl/⌘+K).

GET /api/search?q= -> {groups:[{key, label, items:[{id, title, subtitle,
section, intent}]}]}. Un grupo por tipo de registro, en el orden del
palette: work orders, equipo, customers, partes, vendors, service
requests, empleados, conductores. Solo se devuelven los grupos con
resultados. `section` es el id de sección del frontend y `intent` lo que
la página abre al llegar ({wo: 12}, {unit: 'MEM 77'}, {customer: 3}…).

Reglas:
- q mínimo 2 caracteres (más corto => sin grupos).
- Work orders: TODAS (no el tope de 200 facturadas del listado), por número
  de display (#12, 4.1), unidad, título, invoice/PO/shop ref, mecánico,
  vendor y customer.
- Nunca se busca DENTRO de campos PII (email/teléfono/dirección): el match
  revelaría datos que el usuario sin `pii.view` ve enmascarados. Los
  subtítulos con contacto salen enmascarados sin pii.view.
- Cada fuente es independiente: si una falla (p.ej. Samsara caído para
  equipo/conductores) las demás responden igual.
"""

from __future__ import annotations

import asyncio
import logging
import re

from sqlalchemy import and_, case, or_, select

from ..db import (Customer, Part, ServiceRequest, SessionLocal, Vendor,
                  WorkOrder)
from . import pii

log = logging.getLogger(__name__)

MIN_Q = 2
MAX_LIMIT = 25
_NET_TIMEOUT_S = 6.0

GROUP_LABELS = {
    "work_orders": "Work orders",
    "units": "Equipment",
    "customers": "Customers",
    "parts": "Parts",
    "vendors": "Vendors",
    "service_requests": "Service requests",
    "technicians": "Employees",
    "drivers": "Drivers",
}
_WO_STATUS = {"open": "Open", "assigned": "Assigned",
              "in_progress": "In progress", "completed": "Completed",
              "invoiced": "Invoiced"}
_SR_SOURCE = {"defect": "DVIR defect", "pm": "PM due", "dot": "DOT due",
              "reefer": "Reefer PM due", "manual": "Request"}
_VENDOR_KIND = {"parts": "Parts vendor", "shop": "Outside shop",
                "both": "Parts & shop"}
_DRIVER_ROLE = {"owner_operator": "Owner-operator",
                "company_driver": "Company driver",
                "lease_operator": "Lease operator"}
_WO_NO = re.compile(r"(?:wo\s*)?#?\s*(\d{1,9})(?:\.(\d{1,4}))?")


def _norm(s: str) -> str:
    return "".join((s or "").split()).upper()


def _join(*parts) -> str:
    return " · ".join(str(p) for p in parts if p not in (None, ""))


def _item(id_, title: str, subtitle: str, section: str,
          intent: dict) -> dict:
    return {"id": str(id_), "title": title, "subtitle": subtitle,
            "section": section, "intent": intent}


def _rank(q: str, *fields: str) -> int:
    """0 = igual, 1 = empieza con, 2 = contiene (unidades/partes)."""
    nq = _norm(q)
    best = 3
    for f in fields:
        nf = _norm(f)
        if not nf:
            continue
        if nf == nq:
            return 0
        if nf.startswith(nq):
            best = min(best, 1)
        elif nq in nf:
            best = min(best, 2)
    return best


# ----- Fuentes ----------------------------------------------------------------------

def _work_orders(q: str, limit: int) -> list[dict]:
    from .workorders import _display_no  # import diferido (ciclo)
    conds = [WorkOrder.unit.icontains(q, autoescape=True),
             WorkOrder.title.icontains(q, autoescape=True),
             WorkOrder.invoice_number.icontains(q, autoescape=True),
             WorkOrder.shop_invoice.icontains(q, autoescape=True),
             WorkOrder.po_number.icontains(q, autoescape=True),
             WorkOrder.mechanic.icontains(q, autoescape=True),
             Vendor.name.icontains(q, autoescape=True),
             Customer.name.icontains(q, autoescape=True)]
    exact = None
    m = _WO_NO.fullmatch(q.strip().lower())
    if m:
        n = int(m.group(1))
        if m.group(2):
            exact = and_(WorkOrder.parent_id == n,
                         WorkOrder.child_seq == int(m.group(2)))
        else:
            exact = WorkOrder.id == n
        conds.append(exact)
    order = [WorkOrder.id.desc()]
    if exact is not None:
        order.insert(0, case((exact, 0), else_=1))
    with SessionLocal() as session:
        rows = session.execute(
            select(WorkOrder, Vendor.name, Customer.name)
            .outerjoin(Vendor, WorkOrder.vendor_id == Vendor.id)
            .outerjoin(Customer, WorkOrder.customer_id == Customer.id)
            .where(or_(*conds)).order_by(*order).limit(limit)).all()
        out = []
        for wo, vname, cname in rows:
            out.append(_item(
                wo.id, f"WO #{_display_no(wo)} · {wo.title}",
                _join(wo.unit, _WO_STATUS.get(wo.status, wo.status),
                      "Outside" if wo.wo_type == "outside" else "",
                      cname or vname or ""),
                "workorders", {"wo": wo.id}))
        return out


async def _units(q: str, limit: int) -> list[dict]:
    from . import fleet_inventory, manual_units  # import diferido
    try:
        fleet = await asyncio.wait_for(fleet_inventory.load(),
                                       _NET_TIMEOUT_S)
        units = list(fleet.get("units") or [])
    except Exception:  # noqa: BLE001 — Samsara caído: solo manuales
        log.info("search: fleet unavailable, manual units only")
        try:
            units = manual_units.merge_into_fleet([])
        except Exception:  # noqa: BLE001
            units = []
    # Unidades de customers que no están en la flota (owner-operators).
    try:
        from ..db import CustomerUnit
        with SessionLocal() as session:
            seen = {_norm(u.get("unit") or "") for u in units}
            for r in session.scalars(select(CustomerUnit)).all():
                if _norm(r.unit) not in seen:
                    seen.add(_norm(r.unit))
                    units.append({"unit": r.unit, "source": "customer"})
    except Exception:  # noqa: BLE001
        pass
    hits = []
    for u in units:
        name = str(u.get("unit") or "").strip()
        if not name:
            continue
        r = _rank(q, name, str(u.get("vin") or ""), str(u.get("plate") or ""))
        ymm = " ".join(str(u.get(k) or "").strip()
                       for k in ("year", "make", "model")
                       if str(u.get(k) or "").strip())
        if r > 2 and q.lower() in ymm.lower():
            r = 2
        if r > 2:
            continue
        kind = u.get("unit_type") or u.get("kind") or ""
        hits.append((r, name.upper(), _item(
            name, name,
            _join(str(kind).replace("_", " ").title() if kind else "", ymm,
                  u.get("company") or "",
                  "Archived" if u.get("archived") else ""),
            "flota", {"unit": name})))
    hits.sort(key=lambda h: (h[0], h[1]))
    return [h[2] for h in hits[:limit]]


def _customers(q: str, limit: int) -> list[dict]:
    from . import customers               # import diferido
    out = []
    for c in customers.list_customers(q)[:limit]:
        n = c["units_count"]
        out.append(_item(
            c["id"], c["name"],
            _join(c["kind_label"],
                  ", ".join(x for x in (c["city"], c["state"]) if x),
                  f"{n} unit{'s' if n != 1 else ''}" if n else "",
                  "" if c["active"] else "Inactive"),
            "customers", {"customer": c["id"]}))
    return out


def _parts(q: str, limit: int) -> list[dict]:
    with SessionLocal() as session:
        rows = session.scalars(select(Part).where(or_(
            Part.part_number.icontains(q, autoescape=True),
            Part.description.icontains(q, autoescape=True),
            Part.manufacturer.icontains(q, autoescape=True),
            Part.upc.icontains(q, autoescape=True)))
            .order_by(Part.part_number).limit(limit * 4)).all()
        ranked = sorted(rows, key=lambda p: (
            _rank(q, p.part_number, p.upc), p.part_number.upper()))
        out = []
        for p in ranked[:limit]:
            out.append(_item(
                p.id, p.part_number,
                _join(p.description, f"{p.on_hand:g} on hand",
                      p.manufacturer),
                "parts", {"part": p.id}))
        return out


def _vendors(q: str, limit: int) -> list[dict]:
    with SessionLocal() as session:
        rows = session.scalars(select(Vendor).where(or_(
            Vendor.name.icontains(q, autoescape=True),
            Vendor.city.icontains(q, autoescape=True),
            Vendor.account.icontains(q, autoescape=True)))
            .order_by(Vendor.name).limit(limit)).all()
        return [_item(
            v.id, v.name,
            _join(_VENDOR_KIND.get(v.kind or "", ""),
                  ", ".join(x for x in (v.city, v.state) if x)),
            "vendors", {"vendor": v.id}) for v in rows]


def _service_requests(q: str, limit: int) -> list[dict]:
    with SessionLocal() as session:
        rows = session.scalars(select(ServiceRequest).where(
            ServiceRequest.status.in_(("open", "snoozed")),
            or_(ServiceRequest.title.icontains(q, autoescape=True),
                ServiceRequest.unit.icontains(q, autoescape=True),
                ServiceRequest.detail.icontains(q, autoescape=True)))
            .order_by(ServiceRequest.id.desc()).limit(limit)).all()
        return [_item(
            r.id, r.title,
            _join(r.unit, _SR_SOURCE.get(r.source, r.source),
                  "Snoozed" if r.status == "snoozed" else ""),
            "service-requests", {"sr": r.id, "unit": r.unit})
            for r in rows]


def _technicians(q: str, limit: int, mask: bool) -> list[dict]:
    from . import technicians             # import diferido
    ql = q.lower()
    out = []
    for t in technicians.list_technicians(active_only=False):
        if ql not in f"{t['name']} {t.get('role') or ''}".lower():
            continue
        phone = t.get("phone") or ""
        out.append(_item(
            t["id"], t["name"],
            _join(t.get("role") or "Technician",
                  pii.mask_phone(phone) if mask else phone,
                  "" if t["active"] else "Inactive"),
            "employees", {"technician": t["id"]}))
        if len(out) >= limit:
            break
    return out


async def _drivers(q: str, limit: int, mask: bool) -> list[dict]:
    from . import tms                     # import diferido
    try:
        drivers = await asyncio.wait_for(tms.list_drivers(), _NET_TIMEOUT_S)
    except Exception:  # noqa: BLE001 — roster no disponible
        return []
    ql = q.lower()
    out = []
    for d in drivers:
        hay = " ".join(str(d.get(k) or "") for k in (
            "name", "truck", "trailer", "company", "driver_company")).lower()
        if ql not in hay:
            continue
        phone = d.get("phone") or ""
        out.append(_item(
            d["name"], d["name"],
            _join(_DRIVER_ROLE.get(d.get("role") or "", ""),
                  f"Truck {d['truck']}" if d.get("truck") else "",
                  pii.mask_phone(phone) if mask else phone),
            "drivers", {"driver": d["name"]}))
        if len(out) >= limit:
            break
    return out


# ----- Entrada ----------------------------------------------------------------------

async def search(q: str, limit: int = 8, mask_pii: bool = False) -> dict:
    q = " ".join((q or "").split())[:80]
    if len(q) < MIN_Q:
        return {"q": q, "groups": []}
    try:
        limit = max(1, min(int(limit or 8), MAX_LIMIT))
    except (TypeError, ValueError):
        limit = 8

    async def _safe(key: str, fn, *args):
        try:
            res = fn(*args)
            if asyncio.iscoroutine(res):
                res = await res
            return key, res
        except Exception:  # noqa: BLE001 — una fuente caída no tumba el resto
            log.exception("search: source %s failed", key)
            return key, []

    results = [
        await _safe("work_orders", _work_orders, q, limit),
        await _safe("units", _units, q, limit),
        await _safe("customers", _customers, q, limit),
        await _safe("parts", _parts, q, limit),
        await _safe("vendors", _vendors, q, limit),
        await _safe("service_requests", _service_requests, q, limit),
        await _safe("technicians", _technicians, q, limit, mask_pii),
        await _safe("drivers", _drivers, q, limit, mask_pii),
    ]
    return {"q": q, "groups": [
        {"key": key, "label": GROUP_LABELS[key], "items": items}
        for key, items in results if items]}
