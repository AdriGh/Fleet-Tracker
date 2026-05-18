"""Motor de cruce: DVIR + actividad + roster -> bloque del informe diario.

Reglas de negocio (validadas contra el informe original):
- Duracion por unidad = suma de todos los DVIR de ese conductor en el dia.
- Estado mostrado = el del DVIR mas reciente (por hora de firma).
- NO DVIR = camion en el CSV de actividad por encima del umbral de millas
  y sin DVIR de camion ese dia. El conductor se toma del roster.
- Las columnas DOT Issues / Fullbay se rellenan siempre con 'YES'.
"""

import csv
import io
import re
from datetime import datetime

import pandas as pd

from .duration import format_duration, parse_duration

# Columnas del informe, en orden.
COLUMNS = [
    "Company", "Driver", "Trk#", "DVIR trk", "Trl#", "DVIR trl",
    "Duration trk", "Duration trl", "DOT Issues trk", "DOT Issues trl",
    "Fullbay trk", "Fullbay trl",
]

# Columnas del lado del camion (se fusionan cuando hay un unico camion).
TRUCK_SIDE = ("Trk#", "DVIR trk", "Duration trk", "DOT Issues trk",
              "Fullbay trk")
TRAILER_SIDE = ("Trl#", "DVIR trl", "Duration trl", "DOT Issues trl",
                 "Fullbay trl")

NO_DVIR_TEXT = "⚠ NO DVIR"

# Umbral de millas para considerar que un camion circulo (NO DVIR).
MIN_MILES = 30.0

DVIR_REQUIRED = {"Vehicle Name", "Trailer", "Author", "Signed At",
                 "Duration", "Status"}


class ReportError(ValueError):
    """Error de validacion de entradas legible para el usuario."""


# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------
def norm(text) -> str:
    """Normaliza un identificador de unidad para comparar."""
    return re.sub(r"\s+", "", str(text or "").strip()).upper()


def parse_signed_at(text):
    """'May 15, 2026 3:27 AM' -> datetime (None si no se reconoce)."""
    if text is None:
        return None
    s = str(text).strip()
    for fmt in ("%b %d, %Y %I:%M %p", "%B %d, %Y %I:%M %p",
                "%m/%d/%Y %I:%M %p", "%m/%d/%Y %H:%M"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def data_year(dvir_df) -> int:
    """Anio dominante de las fechas de firma del CSV de DVIR."""
    for value in dvir_df["Signed At"]:
        parsed = parse_signed_at(value)
        if parsed:
            return parsed.year
    return datetime.now().year


# ---------------------------------------------------------------------------
# Carga de archivos (acepta ruta o file-like)
# ---------------------------------------------------------------------------
def load_dvir(source) -> pd.DataFrame:
    try:
        df = pd.read_csv(source, dtype=str, keep_default_na=False)
    except Exception as exc:  # noqa: BLE001
        raise ReportError(f"No se pudo leer el CSV de DVIR: {exc}") from exc
    df.columns = [c.strip() for c in df.columns]
    missing = DVIR_REQUIRED - set(df.columns)
    if missing:
        raise ReportError(
            "El CSV de DVIR no tiene las columnas esperadas. Faltan: "
            + ", ".join(sorted(missing))
        )
    return df


def load_activity(source) -> dict:
    """Devuelve {nombre_unidad: distancia_millas}."""
    try:
        df = pd.read_csv(source, dtype=str, keep_default_na=False)
    except Exception as exc:  # noqa: BLE001
        raise ReportError(
            f"No se pudo leer el CSV de actividad: {exc}") from exc
    df.columns = [c.strip() for c in df.columns]
    name_col = next(
        (c for c in df.columns if c.lower().startswith("vehicle")), None)
    dist_col = next(
        (c for c in df.columns if c.lower().startswith("distance")), None)
    if not name_col or not dist_col:
        raise ReportError(
            "El CSV de actividad no tiene columnas 'Vehicle Name' / "
            "'Distance'.")
    activity = {}
    for _, r in df.iterrows():
        unit = str(r[name_col]).strip()
        if not unit:
            continue
        try:
            dist = float(str(r[dist_col]).replace(",", "") or 0)
        except ValueError:
            dist = 0.0
        activity[unit] = dist
    return activity


def load_roster(source) -> dict:
    """Devuelve {unidad_normalizada: conductor}. source: ruta o texto CSV."""
    roster = {}
    if source is None:
        return roster
    if hasattr(source, "read"):
        text = source.read()
        if isinstance(text, bytes):
            text = text.decode("utf-8-sig")
        handle = io.StringIO(text)
    else:
        handle = open(source, "r", encoding="utf-8-sig", newline="")
    try:
        for row in csv.DictReader(handle):
            keys = {k.lower().strip(): k for k in row}
            tk = keys.get("truck") or keys.get("unit") or keys.get("camion")
            dk = keys.get("driver") or keys.get("conductor")
            if not tk:
                continue
            unit = str(row[tk]).strip()
            driver = str(row[dk]).strip() if dk else ""
            if unit:
                roster[norm(unit)] = driver
    finally:
        handle.close()
    return roster


# ---------------------------------------------------------------------------
# Construccion del informe
# ---------------------------------------------------------------------------
def _consolidate(entries):
    """entries: lista de (signed_at, status, segundos).
    Devuelve (estado_mas_reciente, suma_segundos)."""
    total = sum(secs for _, _, secs in entries)
    latest = max(entries, key=lambda e: e[0] or datetime.min)
    return latest[1] or "Safe", total


def _blank_row(company):
    row = {c: "" for c in COLUMNS}
    row["Company"] = company
    row["is_nodvir"] = False
    return row


def build_report(dvir_df, activity, roster, min_miles, company):
    """Devuelve una lista de grupos. Cada grupo:
        {"truck_merge": bool, "rows": [row_dict, ...]}
    """
    drivers = {}
    truck_has_dvir = set()

    for _, r in dvir_df.iterrows():
        author = str(r["Author"]).strip()
        if not author:
            continue
        signed = parse_signed_at(r["Signed At"])
        status = str(r["Status"]).strip() or "Safe"
        secs = parse_duration(r["Duration"])
        d = drivers.setdefault(author, {"trucks": {}, "trailers": {}})
        veh = str(r["Vehicle Name"]).strip()
        trl = str(r["Trailer"]).strip()
        if veh:
            d["trucks"].setdefault(veh, []).append((signed, status, secs))
            truck_has_dvir.add(norm(veh))
        if trl:
            d["trailers"].setdefault(trl, []).append((signed, status, secs))

    groups = []
    for driver in sorted(drivers, key=str.lower):
        data = drivers[driver]
        trucks = [(u, *_consolidate(e))
                  for u, e in sorted(data["trucks"].items())]
        trailers = [(u, *_consolidate(e))
                    for u, e in sorted(data["trailers"].items())]
        n = max(len(trucks), len(trailers), 1)
        rows = []
        for i in range(n):
            row = _blank_row(company)
            row["Driver"] = driver if i == 0 else ""
            if i < len(trucks):
                unit, status, secs = trucks[i]
                row["Trk#"] = unit
                row["DVIR trk"] = status
                row["Duration trk"] = format_duration(secs)
                row["DOT Issues trk"] = "YES"
                row["Fullbay trk"] = "YES"
            elif i == 0 and not trucks:
                for c in TRUCK_SIDE:
                    row[c] = "-"
            if i < len(trailers):
                unit, status, secs = trailers[i]
                row["Trl#"] = unit
                row["DVIR trl"] = status
                row["Duration trl"] = format_duration(secs)
                row["DOT Issues trl"] = "YES"
                row["Fullbay trl"] = "YES"
            elif i == 0 and not trailers:
                for c in TRAILER_SIDE:
                    row[c] = "-"
            rows.append(row)
        truck_merge = len(rows) > 1 and all(r["Trk#"] == "" for r in rows[1:])
        groups.append({"truck_merge": truck_merge, "rows": rows})

    # NO DVIR: camiones activos sin DVIR de camion.
    nodvir = []
    for unit, dist in sorted(activity.items()):
        if dist < min_miles or norm(unit) in truck_has_dvir:
            continue
        driver = roster.get(norm(unit), "")
        row = _blank_row(company)
        row["Driver"] = driver
        row["Trk#"] = unit
        row["DVIR trk"] = NO_DVIR_TEXT
        row["is_nodvir"] = True
        nodvir.append((driver.lower(), {"truck_merge": False, "rows": [row]}))
    nodvir.sort(key=lambda x: x[0])
    groups.extend(g for _, g in nodvir)
    return groups


def report_stats(groups):
    rows = sum(len(g["rows"]) for g in groups)
    nodvir = sum(1 for g in groups for r in g["rows"] if r["is_nodvir"])
    return {
        "drivers": len(groups),
        "rows": rows,
        "no_dvir": nodvir,
    }


def block_metrics(dvir_df, groups) -> dict:
    """Metricas del bloque para el panel:
      n_reports      - conductores distintos que hicieron DVIR
      n_no_dvir      - filas NO DVIR
      n_unsafe       - inspecciones en estado Unsafe
      fleet_safe_pct - % de inspecciones del dia en estado Safe
    """
    authors = {str(a).strip() for a in dvir_df["Author"]}
    authors.discard("")
    status = dvir_df["Status"].astype(str).str.strip()
    total = len(dvir_df)
    n_safe = int((status == "Safe").sum())
    n_unsafe = int((status == "Unsafe").sum())
    n_no_dvir = sum(1 for g in groups for r in g["rows"]
                    if r["is_nodvir"])
    return {
        "n_reports": len(authors),
        "n_no_dvir": n_no_dvir,
        "n_unsafe": n_unsafe,
        "fleet_safe_pct": round(n_safe / total * 100, 1) if total else 0.0,
    }


def dvir_looks_incomplete(groups) -> bool:
    """Heuristica: el bloque tiene >=3 filas NO DVIR y mas NO DVIR que
    conductores con DVIR. Suele indicar un CSV de DVIR incompleto."""
    nodvir = sum(1 for g in groups for r in g["rows"] if r["is_nodvir"])
    with_dvir = len(groups) - nodvir
    return nodvir >= 3 and nodvir > with_dvir
