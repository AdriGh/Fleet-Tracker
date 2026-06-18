# -*- coding: utf-8 -*-
"""Tracker de PM (mantenimiento preventivo) de los camiones.

Lee el export de Fullbay `backend/pm.local.csv` (gitignored): cada camión tiene
dos posibles tipos de PM (ISX para International, DD15/DD13 para Freightliner),
cada uno con "fecha; millaje" del último PM. Se toma el PM realizado (el que no
diga "Never Performed"). El millaje ACTUAL se toma de Samsara (más confiable);
acá solo se extrae el último PM + el meter del reporte como respaldo.

El PM se hace cada 20.000 millas → próximo PM = millaje del último PM + 20.000.
"""

import csv
import re
from pathlib import Path

from .. import db

CSV_PATH = Path(__file__).resolve().parents[2] / "pm.local.csv"
# Overrides manuales por unidad (telemetría/Fullbay errados): exclude, millaje
# actual y/o millaje del último PM. H6: en org_setting por-tenant (clave
# 'pm_overrides'); el JSON legacy se importa una vez a la org 'default'.
OVERRIDES_KEY = "pm_overrides"
OVERRIDES_PATH = Path(__file__).resolve().parents[2] / "pm_overrides.local.json"  # legacy
INTERVAL_MILES = 20000


def is_available() -> bool:
    return CSV_PATH.exists()


def load_overrides() -> dict:
    data = db.get_setting(OVERRIDES_KEY, legacy_file=OVERRIDES_PATH)
    return data if isinstance(data, dict) else {}


def _save_overrides(d: dict) -> None:
    db.save_setting(OVERRIDES_KEY, d)


def set_override(unit: str, field: str, value) -> None:
    """field: current_miles | last_pm_miles. value=None borra el override."""
    if field not in ("current_miles", "last_pm_miles"):
        raise ValueError(f"invalid field: {field}")
    d = load_overrides()
    u = d.setdefault(unit, {})
    if value is None or value == "":
        u.pop(field, None)
    else:
        u[field] = int(value)
    if not u:
        d.pop(unit, None)
    _save_overrides(d)


def set_excluded(unit: str, excluded: bool) -> None:
    d = load_overrides()
    u = d.setdefault(unit, {})
    if excluded:
        u["exclude"] = True
    else:
        u.pop("exclude", None)
    if not u:
        d.pop(unit, None)
    _save_overrides(d)


def _miles(s: str) -> int | None:
    m = re.search(r"([\d,]+)", s or "")
    return int(m.group(1).replace(",", "")) if m else None


def _parse_pm_cell(s: str) -> tuple[str | None, int | None]:
    """'3/31/2026; 442,916 Miles' -> ('3/31/2026', 442916). 'Never Performed' -> (None, None)."""
    s = (s or "").strip()
    if not s or s.lower().startswith("never"):
        return (None, None)
    m = re.search(r"([\d/]+)\s*;\s*([\d,]+)\s*Miles", s, re.IGNORECASE)
    if m:
        return (m.group(1), int(m.group(2).replace(",", "")))
    return (None, None)


def _date_key(d: str | None) -> tuple:
    """Clave ordenable de fecha M/D/YYYY (para elegir el PM más reciente)."""
    if not d:
        return (0, 0, 0)
    try:
        mo, da, yr = (int(x) for x in d.split("/"))
        return (yr, mo, da)
    except ValueError:
        return (0, 0, 0)


def load() -> list[dict]:
    # En modo demo (sin Samsara), el PM board se alimenta de la flota demo.
    from . import demo_eld, samsara
    if samsara._demo():
        return demo_eld.pm_rows()
    if not CSV_PATH.exists():
        return []
    with CSV_PATH.open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.reader(fh)
        rows = list(reader)
    if not rows:
        return []
    headers = [h or "" for h in rows[0]]

    def find_one(*needles) -> int | None:
        for i, h in enumerate(headers):
            hl = h.lower()
            if all(n in hl for n in needles):
                return i
        return None

    i_unit = find_one("unit", "#")
    i_model = find_one("model")
    i_meter = find_one("meter")
    # Columnas de PM (fecha;millaje): tienen "full wet service" y NO "next due".
    pm_cols = [i for i, h in enumerate(headers)
               if "full wet service" in h.lower() and "next due" not in h.lower()]

    out: list[dict] = []
    for row in rows[1:]:
        def cell(idx):
            return (row[idx].strip() if idx is not None and idx < len(row)
                    and row[idx] is not None else "")

        unit = cell(i_unit)
        if not unit:
            continue
        # PM realizado = el de fecha más reciente entre las columnas.
        best_date, best_miles, best_type = None, None, None
        for ci in pm_cols:
            d, mi = _parse_pm_cell(cell(ci))
            if d and (_date_key(d) > _date_key(best_date)):
                best_date, best_miles = d, mi
                best_type = "ISX" if "isx" in headers[ci].lower() else "DD"
        out.append({
            "unit": unit,
            "model": cell(i_model),
            "pm_type": best_type,
            "last_pm_date": best_date,
            "last_pm_miles": best_miles,
            "report_miles": _miles(cell(i_meter)),
        })
    out.sort(key=lambda r: r["unit"])
    return out
