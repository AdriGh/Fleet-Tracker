"""Unidades agregadas a mano (Fleet -> Add New Unit).

Complementan el fleet vivo de Samsara para terminales/clientes que no estan
en Samsara, y alimentan los trackers PM/DOT. Persisten en la tabla `unit`
(org-scoped). Toda operacion corre bajo el tenant del request (H6 fase 3).
"""

from __future__ import annotations

from datetime import datetime

from .. import db

_TYPES = ("truck", "trailer", "chassis")


def _clean(s, cap: int) -> str:
    return str(s or "").strip()[:cap]


def add(data: dict) -> dict:
    """Crea (o actualiza, por numero de unidad) una unidad manual."""
    unit = _clean(data.get("unit"), 64)
    if not unit:
        raise ValueError("unit number is required")
    unit_type = str(data.get("unit_type") or "truck").lower()
    if unit_type not in _TYPES:
        unit_type = "truck"
    fields = dict(
        unit=unit,
        unit_type=unit_type,
        subtype=_clean(data.get("subtype"), 40),
        terminal=_clean(data.get("terminal"), 40),
        customer=_clean(data.get("customer"), 120),
        company=_clean(data.get("company"), 64),
        vin=_clean(data.get("vin"), 20).upper(),
        year=_clean(data.get("year"), 8),
        make=_clean(data.get("make"), 60),
        model=_clean(data.get("model"), 60),
        fleet_no=_clean(data.get("fleet_no"), 40),
        plate=_clean(data.get("plate"), 20).upper(),
        plate_state=_clean(data.get("plate_state"), 8).upper(),
    )
    with db.SessionLocal() as session:
        # Upsert por numero de unidad (el auto-filtro por tenant acota a la org
        # actual, asi que esto solo ve/pisa unidades de esta organizacion).
        existing = session.scalars(
            db.select(db.Unit).where(db.Unit.unit == unit)).first()
        if existing is None:
            row = db.Unit(created_at=datetime.now(), **fields)
            session.add(row)
        else:
            for k, v in fields.items():
                setattr(existing, k, v)
            row = existing
        session.commit()
        return _to_dict(row)


def list_units() -> list[dict]:
    with db.SessionLocal() as session:
        rows = session.scalars(
            db.select(db.Unit).order_by(db.Unit.unit)).all()
        return [_to_dict(r) for r in rows]


def delete(unit_id: int) -> bool:
    with db.SessionLocal() as session:
        row = session.get(db.Unit, unit_id)
        if row is None:
            return False
        session.delete(row)
        session.commit()
        return True


def names() -> set[str]:
    """Numeros de unidad manuales (para alimentar las listas de PM/DOT)."""
    with db.SessionLocal() as session:
        return {r for (r,) in session.execute(db.select(db.Unit.unit)).all()}


def _to_dict(r: "db.Unit") -> dict:
    return {
        "id": r.id, "unit": r.unit, "unit_type": r.unit_type,
        "subtype": r.subtype, "terminal": r.terminal, "customer": r.customer,
        "company": r.company, "vin": r.vin, "year": r.year, "make": r.make,
        "model": r.model, "fleet_no": r.fleet_no, "plate": r.plate,
        "plate_state": r.plate_state,
    }


def _as_fleet_row(r: dict) -> dict:
    """Una unidad manual con la forma de una unidad del fleet de Samsara."""
    kind = "trailer" if r["unit_type"] == "trailer" else "truck"
    return {
        "id": f"manual-{r['id']}",
        "unit": r["unit"],
        "kind": kind,
        "unit_type": r["unit_type"],
        "asset_type": "trailer" if kind == "trailer" else "vehicle",
        "company": r["company"],
        "make": r["make"], "model": r["model"], "year": r["year"],
        "vin": r["vin"], "plate": r["plate"],
        "open_defects": 0,
        "last_dvir": None,
        "dvir_known": False,
        "auto_eligible": False,
        "source": "manual",
        "terminal": r["terminal"],
    }


def merge_into_fleet(samsara_units: list[dict]) -> list[dict]:
    """Agrega al fleet de Samsara las unidades manuales que no esten ya
    presentes (por numero de unidad; Samsara gana)."""
    seen = {str(u.get("unit") or "").strip() for u in samsara_units}
    extra = [_as_fleet_row(r) for r in list_units()
             if r["unit"] and r["unit"] not in seen]
    return list(samsara_units) + extra
