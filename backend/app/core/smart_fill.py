# -*- coding: utf-8 -*-
"""Smart Fill (v2.21): del escaneo de la factura a la work order.

Mapea el `extract` de docscan.scan a una PROPUESTA de campos + líneas para
una WO (nueva o ya existente) y aplica esa propuesta en UNA transacción.
SquareRigger solo tiene esto para trabajo outside; acá sirve para inside y
outside, y también sobre una WO que ya existe (el escáner de CreateWoModal
y el botón "Smart Fill" del drawer comparten este mapeo).

- `propose(extract, wo, vendor_match)`: fields {service_date?, shop_invoice?,
  mileage?, wo_type, vendor_id?} + lines [{kind, description, qty,
  unit_cost, part_number}].
  * WO NUEVA (`wo` None, /workorders/scan): wo_type pasa a 'outside' si el
    documento trae nombre de taller (una factura de terceros = trabajo
    outside); si no, 'inside'. vendor_id = el match, si lo hay.
  * WO EXISTENTE (v2.23): el tipo es FIJO desde la creación, así que
    wo_type = el de la WO y vendor_id solo se propone si es outside (en una
    inside se importan fecha, invoice # y líneas SIN ligar el taller).
- `apply(wo_id, fields, vendor_create, lines, lines_mode)`: campos + alta
  opcional del vendor (kind 'shop') + líneas (append|replace), todo o nada.
  Bloqueado si la WO ya está facturada. v2.23: nunca cambia wo_type (otro
  tipo => workorders.TYPE_LOCKED_MSG) y en una WO inside rechaza
  vendor_id/vendor_create (workorders.INSIDE_VENDOR_MSG) ANTES de crear el
  vendor: no queda ningún vendor fantasma.
"""

from __future__ import annotations

from datetime import datetime

from ..db import SessionLocal, Vendor, WorkOrder
from . import workorders

INVOICED_MSG = "un-invoice the work order before importing"
# Campos que la propuesta/aplicación puede tocar (nunca status ni mecánico).
APPLY_FIELDS = ("service_date", "shop_invoice", "mileage", "wo_type",
                "vendor_id", "title", "complaint")
LINES_MODES = ("append", "replace")


def _norm_unit(u: str) -> str:
    return "".join(ch for ch in (u or "").upper() if ch.isalnum())


def _mileage_for(extract: dict, unit: str) -> int | None:
    """Millaje del complaint de ESTA unidad; si no hay, el primero con
    millaje (factura de una sola unidad)."""
    comps = [c for c in (extract.get("complaints") or []) if isinstance(c, dict)]
    want = _norm_unit(unit)
    for c in comps:
        if want and _norm_unit(c.get("unit") or "") == want \
                and c.get("mileage") not in (None, ""):
            return int(c["mileage"])
    for c in comps:
        if c.get("mileage") not in (None, ""):
            try:
                return int(c["mileage"])
            except (TypeError, ValueError):
                continue
    return None


def propose_lines(extract: dict) -> list[dict]:
    """Líneas del extract normalizadas a la forma de WorkOrderLine."""
    out: list[dict] = []
    for ln in extract.get("lines") or []:
        if not isinstance(ln, dict):
            continue
        desc = str(ln.get("description") or "").strip()
        if not desc:
            continue
        kind = "labor" if str(ln.get("kind") or "").lower().startswith(
            "lab") else "part"
        try:
            qty = float(ln.get("qty") if ln.get("qty") not in (None, "")
                        else 1)
        except (TypeError, ValueError):
            qty = 1.0
        try:
            cost = float(ln.get("unit_cost") or 0)
        except (TypeError, ValueError):
            cost = 0.0
        out.append({
            "kind": kind,
            "description": desc[:160],
            "qty": qty if qty > 0 else 1.0,
            "unit_cost": max(0.0, cost),
            "part_number": str(ln.get("part_number") or "").strip()[:60],
        })
    return out


def propose(extract: dict, wo: dict | None,
            vendor_match: dict | None = None) -> dict:
    """Propuesta {fields, lines} para la WO `wo` (dict de _wo_dict, o None
    para una WO que todavía no existe). v2.23: sobre una WO existente el
    tipo NO se propone distinto del suyo (ver docstring del módulo)."""
    extract = extract or {}
    existing = wo is not None
    wo = wo or {}
    fields: dict = {}
    if extract.get("service_date"):
        fields["service_date"] = str(extract["service_date"])[:10]
    if extract.get("invoice_number"):
        fields["shop_invoice"] = str(extract["invoice_number"]).strip()[:60]
    mi = _mileage_for(extract, wo.get("unit") or "")
    if mi is not None:
        fields["mileage"] = mi
    vendor_name = (extract.get("vendor") or "").strip()
    if existing:
        # WO existente: el tipo es fijo; el taller solo aplica a outside.
        fields["wo_type"] = wo.get("wo_type") or "inside"
    else:
        fields["wo_type"] = "outside" if vendor_name else "inside"
    matched = (vendor_match or {}).get("vendor")
    if matched and matched.get("id") and fields["wo_type"] == "outside":
        fields["vendor_id"] = matched["id"]
    return {"fields": fields, "lines": propose_lines(extract)}


def apply(wo_id: int, fields: dict | None, vendor_create: dict | None,
          lines: list[dict] | None, lines_mode: str = "append") -> dict | None:
    """Aplica la propuesta en UNA transacción: campos + vendor nuevo (kind
    'shop') + líneas. None si la WO no existe; ValueError si está facturada
    o algo no valida (nada queda a medias). v2.23: el tipo de la WO no
    cambia y una WO inside no liga taller; ambas reglas se validan ANTES de
    dar de alta el vendor."""
    fields = {k: v for k, v in (fields or {}).items() if k in APPLY_FIELDS}
    lines = list(lines or [])
    if lines_mode not in LINES_MODES:
        raise ValueError("lines_mode must be append or replace")
    with SessionLocal() as session:
        wo = session.get(WorkOrder, wo_id)
        if wo is None:
            return None
        if wo.invoiced_at is not None or wo.status == "invoiced":
            raise ValueError(INVOICED_MSG)
        # v2.23: tipo fijo + inside sin taller. Antes del flush del vendor
        # nuevo, para que un rechazo no deje un vendor fantasma (un
        # vendor_id en una inside lo rechaza apply_fields_in, con rollback).
        if "wo_type" in fields:
            workorders.check_type_locked(wo, fields["wo_type"])
        if vendor_create and (wo.wo_type or "inside") == "inside":
            raise ValueError(workorders.INSIDE_VENDOR_MSG)
        if vendor_create:
            name = str(vendor_create.get("name") or "").strip()
            if not name:
                raise ValueError("Vendor name is required")
            v = Vendor(
                name=name[:120], kind="shop",
                city=str(vendor_create.get("city") or "").strip()[:80],
                state=str(vendor_create.get("state") or "").strip()[:20]
                .upper(),
                created_at=datetime.now())
            session.add(v)
            session.flush()                 # asigna el id
            fields["vendor_id"] = v.id
        try:
            workorders.apply_fields_in(session, wo, fields)
            new_lines = [workorders.build_line(ln) for ln in lines]
        except ValueError:
            session.rollback()
            raise
        if lines_mode == "replace":
            wo.lines = []
        for ln in new_lines:
            wo.lines.append(ln)
        wo.updated_at = datetime.now()
        session.commit()
        return workorders._detail_dict(wo, session)
