"""Unidades agregadas a mano (Fleet -> Add New Unit).

Complementan el fleet vivo de Samsara para terminales/clientes que no estan
en Samsara, y alimentan los trackers PM/DOT. Persisten en la tabla `unit`
(org-scoped). Toda operacion corre bajo el tenant del request (H6 fase 3).
"""

from __future__ import annotations

import csv as _csv
import io
from datetime import datetime

from .. import db

_TYPES = ("truck", "trailer", "chassis")

# Columnas del CSV de import masivo (encabezados de la plantilla).
CSV_COLUMNS = [
    "unit", "unit_type", "company", "terminal", "vin", "year", "make",
    "model", "plate", "plate_state", "fleet_no", "subtype", "customer",
]

# Encabezados aceptados (en minusculas) -> campo interno. 'unit' es el unico
# obligatorio. Se aceptan alias comunes para que entre un export de otra herram.
_CSV_ALIASES = {
    "unit": "unit", "unit #": "unit", "unit number": "unit", "unit no": "unit",
    "truck": "unit", "truck #": "unit", "trk#": "unit", "trk #": "unit",
    "number": "unit", "asset": "unit", "asset #": "unit",
    "type": "unit_type", "unit_type": "unit_type", "unit type": "unit_type",
    "asset type": "unit_type",
    "subtype": "subtype",
    "terminal": "terminal", "yard": "terminal", "region": "terminal",
    "customer": "customer", "client": "customer",
    "company": "company", "carrier": "company", "owner": "company",
    "vin": "vin",
    "year": "year",
    "make": "make",
    "model": "model",
    "fleet": "fleet_no", "fleet #": "fleet_no", "fleet no": "fleet_no",
    "fleet_no": "fleet_no", "fleet number": "fleet_no",
    "plate": "plate", "license": "plate", "license plate": "plate",
    "plate state": "plate_state", "plate_state": "plate_state",
    "state": "plate_state",
}


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


def csv_template() -> str:
    """CSV de ejemplo (encabezados + 2 filas) para descargar y completar."""
    out = io.StringIO()
    w = _csv.writer(out)
    w.writerow(CSV_COLUMNS)
    w.writerow(["TRK-001", "truck", "DEMO CO", "MAIN", "", "2022",
                "Freightliner", "Cascadia", "", "", "", "", ""])
    w.writerow(["TRL-100", "trailer", "DEMO CO", "MAIN", "", "2019",
                "Wabash", "DuraPlate", "", "", "", "", ""])
    return out.getvalue()


def import_csv(text: str) -> dict:
    """Importa unidades en masa desde un CSV. Devuelve un resumen.

    Acepta encabezados flexibles (ver _CSV_ALIASES); 'unit' es obligatorio.
    Hace upsert por numero de unidad (igual que add())."""
    text = (text or "").lstrip("﻿")
    if not text.strip():
        return {"added": 0, "updated": 0, "total": 0,
                "errors": ["empty file"]}
    reader = _csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        return {"added": 0, "updated": 0, "total": 0,
                "errors": ["no header row"]}
    colmap: dict[str, str] = {}
    for col in reader.fieldnames:
        field = _CSV_ALIASES.get(str(col or "").strip().lower())
        if field:
            colmap[col] = field
    if "unit" not in colmap.values():
        return {"added": 0, "updated": 0, "total": 0,
                "errors": ["missing required 'unit' (or 'truck') column"]}

    existing = names()
    added = updated = 0
    errors: list[str] = []
    for i, raw in enumerate(reader, start=2):       # fila 1 = encabezados
        data = {field: raw.get(col, "") for col, field in colmap.items()}
        unit = str(data.get("unit") or "").strip()
        if not unit:
            continue                                # fila sin unidad: ignorar
        try:
            was_new = unit not in existing
            add(data)
            if was_new:
                added += 1
                existing.add(unit)
            else:
                updated += 1
        except ValueError as exc:
            errors.append(f"row {i}: {exc}")
    return {"added": added, "updated": updated,
            "total": added + updated, "errors": errors[:20]}


def merge_into_fleet(samsara_units: list[dict]) -> list[dict]:
    """Agrega al fleet de Samsara las unidades manuales que no esten ya
    presentes (por numero de unidad; Samsara gana)."""
    seen = {str(u.get("unit") or "").strip() for u in samsara_units}
    extra = [_as_fleet_row(r) for r in list_units()
             if r["unit"] and r["unit"] not in seen]
    return list(samsara_units) + extra
