# -*- coding: utf-8 -*-
"""Parseo del custom report de Samsara 'Pre-trip & Post-trip | Remark not empty'.

El report exporta los logs de HoS con remark no vacía (filtrados a On Duty)
con columnas:
    Driver Name, Asset Name, HoS Status, Start Time, End Time, Remark

El cumplimiento DOT no se mide por la duración del DVIR sino por que el
conductor registre su **Pre-Trip** y **Post-Trip** en sus logs (On Duty). Este
módulo agrega, por conductor, la duración total (End − Start) de los segmentos
cuya remark dice "Pre-Trip Inspection" / "Post-Trip Inspection".

Devuelve `{clave_de_nombre: {"pre": segundos|None, "post": segundos|None}}`
donde `None` = no hizo esa inspección (→ se mostrará "⚠ NO PRE-TRIP" en la
columna Pre-trip o "⚠ NO POST-TRIP" en la columna Post-trip).
"""

import io
import re
from datetime import datetime

import pandas as pd

from .contacts import name_key
from .engine import ReportError

# Formatos de fecha/hora del export (sin/con espacio antes de AM/PM, con/sin
# segundos). La zona horaria del final ("EDT") se recorta antes de parsear: solo
# calculamos End − Start, así que el offset no afecta la diferencia.
_DT_FORMATS = (
    "%b %d %Y %I:%M:%S%p",
    "%b %d %Y %I:%M:%S %p",
    "%b %d %Y %I:%M%p",
    "%b %d %Y %I:%M %p",
)
_TZ_SUFFIX = re.compile(r"\s+[A-Z]{2,5}$")


def parse_datetime(text):
    """'Jun 5 2026 4:39:53PM EDT' -> datetime (None si no se reconoce)."""
    if text is None:
        return None
    s = _TZ_SUFFIX.sub("", str(text).strip())
    if not s:
        return None
    for fmt in _DT_FORMATS:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _segment_seconds(start, end) -> int:
    """Duración de un segmento (End − Start) en segundos; 0 si no parsea o es
    negativa."""
    a, b = parse_datetime(start), parse_datetime(end)
    if a is None or b is None:
        return 0
    return max(0, int((b - a).total_seconds()))


def _find_col(cols: dict, *needles) -> str | None:
    """Primera columna cuyo nombre (lower) empiece por alguno de los needles."""
    for needle in needles:
        for low, original in cols.items():
            if low.startswith(needle):
                return original
    return None


def load_pretrip(source) -> dict[str, dict]:
    """Lee el CSV del report y agrega pre/post-trip por conductor.

    `source`: ruta o file-like. Devuelve {name_key: {"pre", "post"}} con los
    segundos sumados de todos los segmentos On Duty con esa remark (None si el
    conductor no registró esa inspección).
    """
    try:
        df = pd.read_csv(source, dtype=str, keep_default_na=False)
    except Exception as exc:  # noqa: BLE001
        raise ReportError(
            f"Could not read the Pre/Post-trip CSV: {exc}") from exc
    cols = {c.strip().lower(): c.strip() for c in df.columns}
    df.columns = [c.strip() for c in df.columns]

    driver_col = _find_col(cols, "driver")
    remark_col = _find_col(cols, "remark")
    start_col = _find_col(cols, "start")
    end_col = _find_col(cols, "end")
    status_col = _find_col(cols, "hos", "status", "duty")
    if not (driver_col and remark_col and start_col and end_col):
        raise ReportError(
            "The Pre/Post-trip CSV is missing expected columns "
            "(Driver Name, Remark, Start Time, End Time).")

    out: dict[str, dict] = {}
    for _, r in df.iterrows():
        driver = str(r[driver_col]).strip()
        if not driver:
            continue
        # El report ya viene filtrado a On Duty; si trae la columna, la
        # respetamos por las dudas (el Pre-trip se hace On Duty).
        if status_col and "ON DUTY" not in str(r[status_col]).strip().upper():
            continue
        remark = str(r[remark_col]).strip().lower().replace(" ", "-")
        if "pre-trip" in remark:
            field = "pre"
        elif "post-trip" in remark:
            field = "post"
        else:
            continue
        secs = _segment_seconds(r[start_col], r[end_col])
        rec = out.setdefault(name_key(driver), {"pre": None, "post": None})
        rec[field] = (rec[field] or 0) + secs
    return out


def load_pretrip_bytes(raw: bytes) -> dict[str, dict]:
    """Variante para los bytes ya en memoria del lote."""
    return load_pretrip(io.BytesIO(raw))
