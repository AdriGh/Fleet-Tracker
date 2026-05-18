"""Procesamiento por lote: clasificacion de archivos, parseo de nombres
y emparejado automatico DVIR <-> actividad por dia y empresa.

Convenciones de nombre de Samsara observadas:
- DVIR:      'Driver Vehicle Inspection Reports - May 15 - May 15.csv'
             (rango de fechas; SIN empresa)
- Actividad: '(Samsara)_Vehicle_Activity_Report_-_Chaser_LLC_-_May_14_2026
              _-_May_15_2026.csv'  (empresa + rango de fechas)

Emparejado: un bloque del dia D usa el CSV de DVIR fechado en D y el CSV
de actividad de esa empresa cuyo fin de rango sea D.
"""

import io
import re
from datetime import date

import pandas as pd

_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
    "january": 1, "february": 2, "march": 3, "april": 4, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10,
    "november": 11, "december": 12,
}

# Empresas reconocidas: codigo -> patrones en el nombre del archivo.
_COMPANY_PATTERNS = {
    "CHASER": ("chaser",),
    "MCC": ("memphis", "mcc"),
}


def date_label(d: date) -> str:
    """date -> 'mes.dia' (ej. 5.15)."""
    return f"{d.month}.{d.day}"


def _month_num(token: str):
    return _MONTHS.get(token.strip().lower().rstrip("."))


def _find_dates(name: str) -> list[date]:
    """Extrae todas las fechas 'Mon DD[ YYYY]' del nombre, en orden."""
    dates: list[date] = []
    pattern = re.compile(r"([A-Za-z]{3,9})[ _]+(\d{1,2})(?:[ _,]+(\d{4}))?")
    for mon, day, year in pattern.findall(name):
        m = _month_num(mon)
        if not m:
            continue
        try:
            d = int(day)
            y = int(year) if year else date.today().year
            dates.append(date(y, m, d))
        except ValueError:
            continue
    return dates


def company_from_filename(name: str):
    low = name.lower()
    for code, needles in _COMPANY_PATTERNS.items():
        if any(n in low for n in needles):
            return code
    return None


def company_from_units(df: pd.DataFrame):
    """Deduce la empresa por los prefijos de unidad del CSV de DVIR.
    Unidades con prefijo de ubicacion (MEM-, MDW-, SAV-...) => MCC;
    si todas son del tipo CF1234/CI1234 => CHASER."""
    prefixed = 0
    plain = 0
    for col in ("Vehicle Name", "Trailer"):
        if col not in df.columns:
            continue
        for value in df[col].astype(str):
            v = value.strip()
            if not v:
                continue
            if re.match(r"^[A-Za-z]{2,4}[-\s]", v):
                prefixed += 1
            elif re.match(r"^[A-Za-z]{2}\d+$", v):
                plain += 1
    if prefixed == 0 and plain == 0:
        return None
    return "MCC" if prefixed > 0 else "CHASER"


def classify_csv(df: pd.DataFrame) -> str:
    """Devuelve 'dvir', 'activity', 'roster' o 'unknown'."""
    cols = {c.strip().lower() for c in df.columns}
    if {"vehicle name", "author", "status"} <= cols:
        return "dvir"
    if "vehicle name" in cols and any(c.startswith("distance") for c in cols):
        return "activity"
    if {"truck", "driver"} & cols and len(cols) <= 4:
        return "roster"
    return "unknown"


class AnalyzedFile:
    """Un CSV subido, ya clasificado."""

    def __init__(self, file_id: str, name: str, raw: bytes):
        self.file_id = file_id
        self.name = name
        self.raw = raw
        self.kind = "unknown"
        self.company = None
        self.dates: list[date] = []
        self.error = None

        try:
            df = pd.read_csv(io.BytesIO(raw), dtype=str,
                             nrows=200, keep_default_na=False)
            df.columns = [c.strip() for c in df.columns]
        except Exception as exc:  # noqa: BLE001
            self.error = f"No se pudo leer el CSV: {exc}"
            return

        self.kind = classify_csv(df)
        self.dates = _find_dates(name)
        if self.kind == "activity":
            self.company = company_from_filename(name)
        elif self.kind == "dvir":
            self.company = (company_from_filename(name)
                            or company_from_units(df))

    @property
    def dvir_date(self):
        """Para un DVIR: la fecha del dia (ultima del rango del nombre)."""
        return self.dates[-1] if self.dates else None

    @property
    def activity_end(self):
        """Para actividad: el fin del rango (= dia del bloque)."""
        return self.dates[-1] if self.dates else None


def pair_blocks(files: list[AnalyzedFile]) -> dict:
    """Empareja los archivos en bloques (empresa + dia).

    Devuelve un dict con:
      blocks   -> lista de bloques propuestos
      files    -> resumen de cada archivo detectado
      warnings -> avisos legibles
    """
    dvirs = [f for f in files if f.kind == "dvir" and not f.error]
    activities = [f for f in files if f.kind == "activity" and not f.error]
    warnings: list[str] = []

    # Indice de actividad por (empresa, fecha-fin).
    activity_index: dict[tuple, AnalyzedFile] = {}
    for act in activities:
        if act.company and act.activity_end:
            activity_index[(act.company, act.activity_end)] = act

    blocks = []
    for dv in sorted(dvirs, key=lambda f: (f.company or "", f.dvir_date
                                           or date.min)):
        d = dv.dvir_date
        act = activity_index.get((dv.company, d)) if d else None
        if not dv.company:
            warnings.append(f"No se detecto la empresa de '{dv.name}'.")
        if d and not act:
            warnings.append(
                f"Sin CSV de actividad para {dv.company or '?'} "
                f"del {date_label(d)}.")
        blocks.append({
            "company": dv.company or "",
            "date_label": date_label(d) if d else "",
            "month": d.month if d else None,
            "dvir_file_id": dv.file_id,
            "dvir_name": dv.name,
            "activity_file_id": act.file_id if act else "",
            "activity_name": act.name if act else "",
            "status": "ok" if (dv.company and act) else "incompleto",
        })

    for f in files:
        if f.kind == "unknown" and not f.error:
            warnings.append(f"'{f.name}' no parece un CSV de DVIR ni de "
                            f"actividad; se ignora.")

    file_summaries = [{
        "file_id": f.file_id,
        "name": f.name,
        "kind": f.kind,
        "company": f.company or "",
        "error": f.error,
    } for f in files]

    return {"blocks": blocks, "files": file_summaries, "warnings": warnings}


def sheet_name(company: str, month) -> str:
    base = f"{company} {month}" if month else company
    return base[:31]
