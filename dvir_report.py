"""
Generador de informes DVIR diarios.

Cruza un CSV de inspecciones DVIR con un CSV de actividad de vehiculos
(Samsara) y un roster camion->conductor, y produce un Excel con el
bloque diario consolidado (un conductor por fila, camion + trailers,
y deteccion automatica de "NO DVIR").

Uso: ejecutar este archivo para abrir la interfaz de escritorio.
"""

import csv
import os
import re
import sys
from datetime import datetime

import pandas as pd
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

# ---------------------------------------------------------------------------
# Estilo del informe (tomado del Excel original)
# ---------------------------------------------------------------------------
HEADER_FILL = "1F4E79"
HEADER_FONT_COLOR = "FFFFFF"
STATUS_STYLES = {
    "Safe":       ("C6EFCE", "276221"),
    "Resolved":   ("C6EFCE", "006100"),
    "Unsafe":     ("FFC7CE", "9C0006"),
    "NO DVIR":    ("FFE0B2", "BF360C"),
}
NO_DVIR_TEXT = "⚠ NO DVIR"  # warning sign + texto

COLUMNS = [
    "Company", "Driver", "Trk#", "DVIR trk", "Trl#", "DVIR trl",
    "Duration trk", "Duration trl", "DOT Issues trk", "DOT Issues trl",
    "Fullbay trk", "Fullbay trl",
]


# ---------------------------------------------------------------------------
# Utilidades de duracion y fecha
# ---------------------------------------------------------------------------
def parse_duration(text):
    """'1h 12m 54s' / '8m' / '53s' / '' -> segundos (int)."""
    if text is None:
        return 0
    s = str(text).strip()
    if not s or s in ("-", "nan"):
        return 0
    total = 0
    for value, unit in re.findall(r"(\d+)\s*([hms])", s):
        n = int(value)
        total += n * {"h": 3600, "m": 60, "s": 1}[unit]
    return total


def format_duration(seconds):
    """segundos -> '1h 12m 54s' (omite partes en cero salvo que todo sea 0)."""
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    parts = []
    if h:
        parts.append(f"{h}h")
    if m or h:
        parts.append(f"{m}m")
    if s or (not h and not m):
        parts.append(f"{s}s")
    return " ".join(parts)


def parse_signed_at(text):
    """'May 15, 2026 3:27 AM' -> datetime (None si no se puede)."""
    if text is None:
        return None
    s = str(text).strip()
    for fmt in ("%b %d, %Y %I:%M %p", "%B %d, %Y %I:%M %p", "%m/%d/%Y %I:%M %p"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def norm(text):
    """Normaliza un identificador de unidad para comparar."""
    return re.sub(r"\s+", "", str(text or "").strip()).upper()


# ---------------------------------------------------------------------------
# Carga de archivos
# ---------------------------------------------------------------------------
def load_dvir(path):
    df = pd.read_csv(path, dtype=str, keep_default_na=False)
    df.columns = [c.strip() for c in df.columns]
    required = {"Vehicle Name", "Trailer", "Author", "Signed At",
                "Duration", "Status"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(
            "El CSV de DVIR no tiene las columnas esperadas. "
            f"Faltan: {', '.join(sorted(missing))}"
        )
    return df


def load_activity(path):
    """Devuelve dict {nombre_unidad: distancia_millas}."""
    df = pd.read_csv(path, dtype=str, keep_default_na=False)
    df.columns = [c.strip() for c in df.columns]
    name_col = next((c for c in df.columns if c.lower().startswith("vehicle")), None)
    dist_col = next((c for c in df.columns if c.lower().startswith("distance")), None)
    if not name_col or not dist_col:
        raise ValueError(
            "El CSV de actividad no tiene columnas 'Vehicle Name' / 'Distance'."
        )
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


def load_roster(path):
    """Devuelve dict {unidad_normalizada: conductor}."""
    roster = {}
    if not path or not os.path.exists(path):
        return roster
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            keys = {k.lower().strip(): k for k in row}
            tk = keys.get("truck") or keys.get("unit") or keys.get("camion")
            dk = keys.get("driver") or keys.get("conductor")
            if not tk:
                continue
            unit = str(row[tk]).strip()
            driver = str(row[dk]).strip() if dk else ""
            if unit:
                roster[norm(unit)] = driver
    return roster


# ---------------------------------------------------------------------------
# Motor de cruce
# ---------------------------------------------------------------------------
def consolidate(entries):
    """entries: lista de (signed_at, status, segundos).
    Devuelve (estado_mas_reciente, suma_segundos)."""
    total = sum(secs for _, _, secs in entries)
    latest = max(entries, key=lambda e: e[0] or datetime.min)
    return latest[1] or "Safe", total


def build_report(dvir_df, activity, roster, min_miles, company):
    """Devuelve una lista de 'grupos'; cada grupo es una lista de filas (dict)."""
    # driver -> {"trucks": {unit: [entries]}, "trailers": {unit: [entries]}}
    drivers = {}
    truck_has_dvir = set()  # unidades de camion con DVIR (normalizadas)

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
        trucks = [
            (unit, *consolidate(ent))
            for unit, ent in sorted(data["trucks"].items())
        ]
        trailers = [
            (unit, *consolidate(ent))
            for unit, ent in sorted(data["trailers"].items())
        ]
        n = max(len(trucks), len(trailers), 1)
        group = []
        for i in range(n):
            row = {c: "" for c in COLUMNS}
            row["Company"] = company
            row["Driver"] = driver if i == 0 else ""
            row["_nodvir"] = False

            if i < len(trucks):
                unit, status, secs = trucks[i]
                row["Trk#"] = unit
                row["DVIR trk"] = status
                row["Duration trk"] = format_duration(secs)
                row["DOT Issues trk"] = "YES"
                row["Fullbay trk"] = "YES"
            elif i == 0 and not trucks:
                for c in ("Trk#", "DVIR trk", "Duration trk",
                          "DOT Issues trk", "Fullbay trk"):
                    row[c] = "-"

            if i < len(trailers):
                unit, status, secs = trailers[i]
                row["Trl#"] = unit
                row["DVIR trl"] = status
                row["Duration trl"] = format_duration(secs)
                row["DOT Issues trl"] = "YES"
                row["Fullbay trl"] = "YES"
            elif i == 0 and not trailers:
                for c in ("Trl#", "DVIR trl", "Duration trl",
                          "DOT Issues trl", "Fullbay trl"):
                    row[c] = "-"
            group.append(row)
        groups.append(group)

    # --- Deteccion NO DVIR -------------------------------------------------
    nodvir = []
    for unit, dist in sorted(activity.items()):
        if dist < min_miles:
            continue
        if norm(unit) in truck_has_dvir:
            continue
        driver = roster.get(norm(unit), "")
        row = {c: "" for c in COLUMNS}
        row["Company"] = company
        row["Driver"] = driver
        row["Trk#"] = unit
        row["DVIR trk"] = NO_DVIR_TEXT
        row["_nodvir"] = True
        nodvir.append((driver.lower(), [row]))
    nodvir.sort(key=lambda x: x[0])
    groups.extend(g for _, g in nodvir)
    return groups


# ---------------------------------------------------------------------------
# Escritura del Excel
# ---------------------------------------------------------------------------
def write_excel(groups, company, date_label, out_path):
    wb = Workbook()
    ws = wb.active
    ws.title = f"{company} {date_label}"[:31]

    thin = Side(style="thin", color="D9D9D9")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    center = Alignment(horizontal="center", vertical="center", wrap_text=True)

    # Encabezado
    header_fill = PatternFill("solid", fgColor=HEADER_FILL)
    header_font = Font(name="Calibri", size=12, bold=True, color=HEADER_FONT_COLOR)
    for col, name in enumerate(COLUMNS, start=1):
        cell = ws.cell(row=1, column=col, value=name)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = center
        cell.border = border
    ws.row_dimensions[1].height = 30

    # Fila marcador del dia
    ws.cell(row=2, column=1, value=date_label)
    ws.merge_cells(start_row=2, start_column=1,
                   end_row=2, end_column=len(COLUMNS))
    m = ws.cell(row=2, column=1)
    m.fill = PatternFill("solid", fgColor=HEADER_FILL)
    m.font = Font(name="Calibri", size=12, bold=True, color=HEADER_FONT_COLOR)
    m.alignment = Alignment(horizontal="center", vertical="center")

    row = 3
    for group in groups:
        start = row
        for entry in group:
            for col, name in enumerate(COLUMNS, start=1):
                value = entry.get(name, "")
                cell = ws.cell(row=row, column=col, value=value)
                cell.alignment = center
                cell.border = border
                cell.font = Font(name="Calibri", size=11)
                style = None
                if name in ("DVIR trk", "DVIR trl"):
                    if value == NO_DVIR_TEXT:
                        style = STATUS_STYLES["NO DVIR"]
                    elif value in STATUS_STYLES:
                        style = STATUS_STYLES[value]
                if style:
                    cell.fill = PatternFill("solid", fgColor=style[0])
                    cell.font = Font(name="Calibri", size=11, bold=True,
                                     color=style[1])
            row += 1
        # Fusionar verticalmente cuando el grupo tiene filas de continuacion
        if row - start > 1:
            # Columna Driver: siempre fusionada
            cols_to_merge = [2]
            # Lado del camion: fusionar solo si hay un unico camion en el
            # grupo (las filas de continuacion tienen Trk# vacio).
            truck_single = all(g["Trk#"] == "" for g in group[1:])
            if truck_single:
                # Trk#, DVIR trk, Duration trk, DOT Issues trk, Fullbay trk
                cols_to_merge += [3, 4, 7, 9, 11]
            for col in cols_to_merge:
                ws.merge_cells(start_row=start, start_column=col,
                               end_row=row - 1, end_column=col)
                ws.cell(row=start, column=col).alignment = center

    # Anchos de columna
    widths = [16, 20, 12, 13, 12, 13, 14, 14, 15, 15, 12, 12]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w

    ws.freeze_panes = "A3"
    wb.save(out_path)


# ---------------------------------------------------------------------------
# Funcion de alto nivel
# ---------------------------------------------------------------------------
def generate(dvir_path, activity_path, roster_path, company, date_label,
             min_miles, out_path):
    dvir_df = load_dvir(dvir_path)
    activity = load_activity(activity_path)
    roster = load_roster(roster_path)
    groups = build_report(dvir_df, activity, roster, min_miles, company)
    write_excel(groups, company, date_label, out_path)
    n_rows = sum(len(g) for g in groups)
    n_nodvir = sum(1 for g in groups for r in g if r.get("_nodvir"))
    return {
        "groups": len(groups),
        "rows": n_rows,
        "nodvir": n_nodvir,
        "out": out_path,
    }


if __name__ == "__main__":
    import gui
    gui.main()
