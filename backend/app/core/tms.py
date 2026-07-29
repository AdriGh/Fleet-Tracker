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

import datetime

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


# Perfiles DEMO: (nombre, truck, trailer, rol, tipo_pago, pct, y los cuatro
# vencimientos como DÍAS respecto a hoy — None = sin fecha cargada).
# Relativos a propósito, igual que el PM del simulador: así el spread de estados
# (vencido / por vencer / vigente / sin fecha) se mantiene y no se podre.
# Dos conductores quedan SIN perfil, que es el caso realista.
_DEMO_PROFILES: list[tuple] = [
    ("James Carter",   "412", "53108", "owner_operator", "percentage", 72.0,
     -14, 200, 320, 150),          # CDL VENCIDO
    ("Miguel Santos",  "418", "53112", "company_driver", "mileage", 0.0,
     18, 240, 90, 400),            # CDL por vencer (18 d)
    ("Daniel Reyes",   "421", "7841", "owner_operator", "percentage", 70.0,
     600, 21, 260, 310),           # médico por vencer
    ("Robert Lee",     "305", "7846", "company_driver", "hourly", 0.0,
     420, 380, 500, 610),          # todo vigente
    ("David Nguyen",   "308", "4402", "lease_operator", "flat", 0.0,
     -3, 45, None, 280),           # CDL vencido + MVR sin fecha
    ("Kevin Walsh",    "311", "4410", "company_driver", "mileage", 0.0,
     520, 470, 350, 560),          # todo vigente
    ("Carlos Mendez",  "207", "", "owner_operator", "percentage", 68.0,
     300, 26, 410, None),          # médico por vencer + clearinghouse sin fecha
    ("Anthony Brooks", "214", "", "company_driver", "hourly", 0.0,
     480, 430, 390, 505),          # todo vigente
    # Marcus Hill y Victor Ramos quedan sin perfil (caso real: alta pendiente).
]


def seed_demo_profiles() -> int:
    """DEMO: crea perfiles de conductor con un spread realista de compliance.

    En modo demo el roster viene del simulador pero los perfiles viven en la DB,
    así que sin esto TODO el compliance sale vacío ("40 fechas faltantes") y el
    feature no se puede revisar ni desarrollar local. Además asigna camiones, lo
    que llena la columna Driver del board de PM/DOT (que se arma con
    `truck` → conductor).

    No-op fuera de modo demo, y NUNCA sobreescribe un perfil existente (si lo
    editaste a mano, se respeta). Devuelve cuántos creó."""
    if not samsara._demo():
        return 0
    today = datetime.date.today()

    def _iso(offset: int | None) -> str:
        if offset is None:
            return ""
        return (today + datetime.timedelta(days=offset)).isoformat()

    added = 0
    with SessionLocal() as session:
        have = {n for (n,) in session.execute(select(TmsDriver.name)).all()}
        for (name, truck, trailer, role, pay_type, pct,
             cdl, med, mvr, chouse) in _DEMO_PROFILES:
            if name in have:
                continue
            session.add(TmsDriver(
                name=name, company="SUMMIT FREIGHT",
                driver_company=(f"{truck} - {name.split()[-1].upper()} "
                                f"TRANSPORT LLC" if role == "owner_operator"
                                else ""),
                role=role, pay_type=pay_type, pay_pct=pct,
                truck=truck, trailer=trailer,
                hired_date=_iso(-(400 + 40 * added)),
                emergency_name="", emergency_phone="",
                cdl_exp=_iso(cdl), med_exp=_iso(med),
                mvr_exp=_iso(mvr), chouse_exp=_iso(chouse),
                notes=""))
            added += 1
        if added:
            session.commit()
    return added


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

