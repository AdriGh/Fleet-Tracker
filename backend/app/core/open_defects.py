# -*- coding: utf-8 -*-
"""Defectos ABIERTOS desde el export de Samsara (CSV).

Carga temporal mientras se conecta la API de Samsara. Lee
`backend/open_defects.local.csv` (export "Driver Vehicle Inspection Reports -
defects": columnas Asset Name, Asset ID, Defect Created At, Defect Type,
Comment, DVIR ID) y devuelve, por defecto distinto, una fila con la misma
forma que `db.list_defects` para que el frontend lo consuma igual.

Cada fila del CSV es un defecto abierto (el export no trae estado), así que
todas salen con `status = "Open"`. Se deduplican los re-reportes diarios del
mismo defecto (misma unidad + tipo + comentario), quedándose con la fecha más
reciente.
"""

import csv
import datetime
import re
from pathlib import Path

CSV_PATH = Path(__file__).resolve().parents[2] / "open_defects.local.csv"

# Prefijo de terminal → empresa MCC (Memphis City Cartage). Sin prefijo → CHASER.
_TERMINAL = re.compile(r"^(MEM|MDW|ATL|SAV|MIA)[-\s]", re.IGNORECASE)
_DATE = re.compile(r"([A-Za-z]{3})\s+(\d+),\s+(\d{4})")

# Re-inspecciones sin novedad: no son defectos reales, se descartan del conteo.
_NOISE = re.compile(
    r"^(previous inspection|nothing\s*(has\s*)?chang|same(\s|$|,|\.)|"
    r"no\s*chang|still the same|everything still|all (still )?the same|"
    r"same as before|same issues|same status)", re.IGNORECASE)


def _is_noise(comment: str) -> bool:
    return bool(_NOISE.match((comment or "").strip()))


def company_of(unit: str) -> str:
    return "MCC" if _TERMINAL.match(unit or "") else "CHASER"


def _parse_date(raw: str) -> datetime.date | None:
    m = _DATE.search(raw or "")
    if not m:
        return None
    try:
        return datetime.datetime.strptime(
            f"{m.group(1)} {m.group(2)} {m.group(3)}", "%b %d %Y").date()
    except ValueError:
        return None


def is_available() -> bool:
    return CSV_PATH.exists()


def load() -> list[dict]:
    """Lista de defectos abiertos (deduplicados) con forma de `Defect`."""
    if not CSV_PATH.exists():
        return []

    # clave (unidad, tipo, comentario normalizado) -> registro acumulado
    seen: dict[tuple, dict] = {}
    with CSV_PATH.open(encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            unit = (row.get("Asset Name") or "").strip()
            if not unit:
                continue
            dtype = (row.get("Defect Type") or "").strip()
            comment = (row.get("Comment") or "").strip()
            if _is_noise(comment):
                continue
            key = (unit, dtype, comment.lower())
            day = _parse_date(row.get("Defect Created At", ""))

            cur = seen.get(key)
            if cur is None or (day and day > cur["_day"]):
                detail = f"{dtype} - {comment}" if comment else dtype
                seen[key] = {
                    "unit": unit,
                    "dtype": dtype,
                    "detail": detail,
                    "_day": day or datetime.date(1970, 1, 1),
                }

    out: list[dict] = []
    for rec in seen.values():
        day = rec["_day"]
        out.append({
            "date_label": f"{day.month}.{day.day}",
            "block_date": day.isoformat(),
            "company": company_of(rec["unit"]),
            "driver": "",
            "unit": rec["unit"],
            "unit_kind": "truck",   # el export no trae tipo; por defecto camión
            "dvir_type": "",
            "status": "Open",
            "detail": rec["detail"],
            "mechanic": "",
            "mechanic_notes": "",
        })
    # orden estable por unidad
    out.sort(key=lambda d: d["unit"])
    return out
