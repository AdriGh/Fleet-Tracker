# -*- coding: utf-8 -*-
"""TMS-lite (fase G-TMS): Drivers & Loads, referencia QuickManage.

Drivers: vista MERGEADA del roster vivo de Samsara (nombre, teléfono,
email, licencia) con el perfil TMS local (contrato, equipo asignado,
vencimientos de compliance, emergencia). El perfil se crea/edita aquí;
el roster sigue siendo la fuente de identidad.

Loads: cargas con stops (pickup/delivery + cita), broker/ref#, rates y
payout del driver calculado por su % de contrato (accesorios van 100%
al driver, como en QuickManage). Pipeline de 6 estados.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import func, select

from ..db import Load, LoadStop, SessionLocal, TmsDriver
from . import samsara

LOAD_STATUSES = ("upcoming", "dispatched", "in_transit", "delivered",
                 "invoiced", "closed")
ROLES = ("owner_operator", "company_driver", "lease_operator")
PAY_TYPES = ("percentage", "flat", "mileage", "hourly")
LOAD_TAGS = ("set", "paid", "short_pay", "lumper_pending", "issue")
DOC_KEYS = ("rc", "bol", "pod")

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


# ----- Loads -------------------------------------------------------------

def _stop_dict(s: LoadStop) -> dict:
    return {"id": s.id, "seq": s.seq, "kind": s.kind, "name": s.name,
            "city": s.city, "state": s.state, "appt": s.appt}


def _load_dict(ld: Load, with_stops: bool = False) -> dict:
    total = round(ld.hauling_rate + ld.accessorials, 2)
    payout = round(ld.hauling_rate * (ld.pay_pct or 0) / 100.0
                   + ld.accessorials, 2)
    stops = sorted(ld.stops, key=lambda s: s.seq)
    first = stops[0] if stops else None
    last = stops[-1] if len(stops) > 1 else None
    out = {
        "id": ld.id,
        "created_at": ld.created_at.isoformat(),
        "updated_at": ld.updated_at.isoformat(),
        "status": ld.status,
        "broker": ld.broker,
        "ref": ld.ref,
        "driver": ld.driver,
        "unit": ld.unit,
        "hauling_rate": ld.hauling_rate,
        "accessorials": ld.accessorials,
        "pay_pct": ld.pay_pct,
        "miles": ld.miles,
        "rate_per_mile": (round(ld.hauling_rate / ld.miles, 2)
                          if ld.miles else None),
        "tags": [t for t in (ld.tags or "").split(",") if t],
        "docs": {k: k in (ld.docs or "").split(",") for k in DOC_KEYS},
        "notes": ld.notes,
        "total": total,
        "payout": payout,
        "n_stops": len(stops),
        "origin": _stop_dict(first) if first else None,
        "destination": _stop_dict(last) if last else None,
    }
    if with_stops:
        out["stops"] = [_stop_dict(s) for s in stops]
    return out


def list_loads(status: str = "", driver: str = "",
               limit: int = 200) -> list[dict]:
    with SessionLocal() as session:
        q = select(Load).order_by(Load.id.desc()).limit(limit)
        if status:
            q = q.where(Load.status == status)
        if driver:
            q = q.where(Load.driver == driver)
        return [_load_dict(ld) for ld in session.scalars(q).all()]


def get_load(load_id: int) -> dict | None:
    with SessionLocal() as session:
        ld = session.get(Load, load_id)
        return _load_dict(ld, with_stops=True) if ld else None


def create_load(broker: str, ref: str = "", driver: str = "",
                unit: str = "", hauling_rate: float = 0.0,
                accessorials: float = 0.0, pay_pct: float = 0.0,
                miles: float | None = None,
                stops: list[dict] | None = None) -> dict:
    broker = broker.strip()
    if not broker:
        raise ValueError("broker (Bill To) is required")
    now = datetime.now()
    ld = Load(
        created_at=now, updated_at=now, status="upcoming",
        broker=broker[:120], ref=ref.strip()[:60],
        driver=driver.strip()[:128], unit=unit.strip()[:32],
        hauling_rate=max(0.0, float(hauling_rate or 0)),
        accessorials=max(0.0, float(accessorials or 0)),
        pay_pct=max(0.0, min(100.0, float(pay_pct or 0))),
        miles=(float(miles) if miles else None),
        tags="", docs="", notes="",
    )
    for i, s in enumerate(stops or [], start=1):
        ld.stops.append(LoadStop(
            seq=i,
            kind=("delivery" if s.get("kind") == "delivery" else "pickup"),
            name=str(s.get("name") or "").strip()[:120],
            city=str(s.get("city") or "").strip()[:80],
            state=str(s.get("state") or "").strip().upper()[:4],
            appt=str(s.get("appt") or "").strip()[:24],
        ))
    with SessionLocal() as session:
        session.add(ld)
        session.commit()
        return _load_dict(ld, with_stops=True)


def update_load(load_id: int, fields: dict) -> dict | None:
    with SessionLocal() as session:
        ld = session.get(Load, load_id)
        if ld is None:
            return None
        if fields.get("status") in LOAD_STATUSES:
            ld.status = fields["status"]
        for key, cap in (("broker", 120), ("ref", 60), ("driver", 128),
                         ("unit", 32)):
            if key in fields:
                setattr(ld, key, str(fields[key]).strip()[:cap])
        for key in ("hauling_rate", "accessorials"):
            if key in fields:
                try:
                    setattr(ld, key, max(0.0, float(fields[key] or 0)))
                except (TypeError, ValueError):
                    pass
        if "pay_pct" in fields:
            try:
                ld.pay_pct = max(0.0, min(100.0,
                                          float(fields["pay_pct"] or 0)))
            except (TypeError, ValueError):
                pass
        if "miles" in fields:
            try:
                ld.miles = (float(fields["miles"])
                            if fields["miles"] not in ("", None) else None)
            except (TypeError, ValueError):
                pass
        if "tags" in fields and isinstance(fields["tags"], list):
            ld.tags = ",".join(
                t for t in fields["tags"] if t in LOAD_TAGS)[:160]
        if "docs" in fields and isinstance(fields["docs"], dict):
            ld.docs = ",".join(
                k for k in DOC_KEYS if fields["docs"].get(k))[:60]
        if "notes" in fields:
            ld.notes = str(fields["notes"]).strip()
        ld.updated_at = datetime.now()
        session.commit()
        return _load_dict(ld, with_stops=True)


def add_stop(load_id: int, kind: str, name: str, city: str,
             state: str, appt: str) -> dict | None:
    with SessionLocal() as session:
        ld = session.get(Load, load_id)
        if ld is None:
            return None
        ld.stops.append(LoadStop(
            seq=(max((s.seq for s in ld.stops), default=0) + 1),
            kind=("delivery" if kind == "delivery" else "pickup"),
            name=name.strip()[:120], city=city.strip()[:80],
            state=state.strip().upper()[:4], appt=appt.strip()[:24],
        ))
        ld.updated_at = datetime.now()
        session.commit()
        return _load_dict(ld, with_stops=True)


def delete_stop(load_id: int, stop_id: int) -> dict | None:
    with SessionLocal() as session:
        ld = session.get(Load, load_id)
        if ld is None:
            return None
        ld.stops = [s for s in ld.stops if s.id != stop_id]
        for i, s in enumerate(sorted(ld.stops, key=lambda x: x.seq),
                              start=1):
            s.seq = i
        ld.updated_at = datetime.now()
        session.commit()
        return _load_dict(ld, with_stops=True)


def load_stats() -> dict:
    month_ago = datetime.now() - timedelta(days=30)
    with SessionLocal() as session:
        by_status = dict(session.execute(
            select(Load.status, func.count()).group_by(Load.status)).all())
        active = sum(by_status.get(s, 0)
                     for s in ("upcoming", "dispatched", "in_transit"))
        delivered_30 = session.scalars(
            select(Load).where(
                Load.status.in_(("delivered", "invoiced", "closed")),
                Load.updated_at >= month_ago)).all()
        revenue_30 = round(sum(
            ld.hauling_rate + ld.accessorials for ld in delivered_30), 2)
        return {
            "active": active,
            "in_transit": by_status.get("in_transit", 0),
            "delivered_30d": len(delivered_30),
            "revenue_30d": revenue_30,
        }
