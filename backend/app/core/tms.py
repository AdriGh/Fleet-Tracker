# -*- coding: utf-8 -*-
"""Driver roster & compliance (ex-TMS, fase G-TMS): referencia QuickManage.

Vista MERGEADA del roster vivo de Samsara (nombre, teléfono, email,
licencia) con el perfil local del conductor (contrato, equipo asignado,
vencimientos de compliance — CDL/med/MVR/clearinghouse —, emergencia). El
perfil se crea/edita aquí; el roster sigue siendo la fuente de identidad.

NOTA: el módulo Loads/dispatch se removió (jun-14) — el producto se enfoca
en el stack Taller + Cold Chain; el dispatch es otro mercado. Esta capa
queda como roster/compliance de conductores, que el tablero de
mantenimiento usa para mapear truck→conductor.
"""

from __future__ import annotations

from sqlalchemy import select

from ..db import SessionLocal, TmsDriver
from . import samsara

ROLES = ("owner_operator", "company_driver", "lease_operator")
PAY_TYPES = ("percentage", "flat", "mileage", "hourly")

_DRIVER_FIELDS = (
    "driver_company", "role", "pay_type", "truck", "trailer",
    "hired_date", "emergency_name", "emergency_phone",
    "cdl_exp", "med_exp", "mvr_exp", "chouse_exp", "notes",
)


# ----- Drivers -----------------------------------------------------------

def _profile_dict(p: TmsDriver | None) -> dict:
    base = {f: "" for f in _DRIVER_FIELDS}
    base.update({"role": "owner_operator", "pay_type": "percentage",
                 "pay_pct": 0.0})
    if p is not None:
        for f in _DRIVER_FIELDS:
            base[f] = getattr(p, f) or ""
        base["pay_pct"] = p.pay_pct or 0.0
        if p.role:
            base["role"] = p.role
        if p.pay_type:
            base["pay_type"] = p.pay_type
    return base


async def list_drivers() -> list[dict]:
    """Roster vivo + perfil TMS, una fila por conductor activo."""
    roster = await samsara.list_drivers()
    with SessionLocal() as session:
        profiles = {p.name: p for p in session.scalars(
            select(TmsDriver)).all()}
    out = []
    for d in roster:
        p = profiles.get(d["name"])
        row = {
            "name": d["name"],
            "company": d.get("company") or "",
            "phone": d.get("phone") or "",
            "email": d.get("email") or "",
            "license_number": d.get("license_number") or "",
            "license_state": d.get("license_state") or "",
            "has_profile": p is not None,
            **_profile_dict(p),
        }
        out.append(row)
    out.sort(key=lambda r: r["name"])
    return out


def save_driver(name: str, fields: dict) -> dict:
    name = name.strip()
    if not name:
        raise ValueError("name is required")
    with SessionLocal() as session:
        p = session.get(TmsDriver, name)
        if p is None:
            p = TmsDriver(name=name)
            session.add(p)
        if "company" in fields:
            p.company = str(fields["company"]).strip()[:64]
        for f in _DRIVER_FIELDS:
            if f in fields:
                setattr(p, f, str(fields[f]).strip())
        if fields.get("role") in ROLES:
            p.role = fields["role"]
        if fields.get("pay_type") in PAY_TYPES:
            p.pay_type = fields["pay_type"]
        if "pay_pct" in fields:
            try:
                p.pay_pct = max(0.0, min(100.0, float(fields["pay_pct"])))
            except (TypeError, ValueError):
                pass
        session.commit()
        return {"name": p.name, **_profile_dict(p)}

