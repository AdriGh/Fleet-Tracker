"""Parseo y formateo de duraciones de DVIR ('1h 12m 54s')."""

import re

_UNIT_SECONDS = {"h": 3600, "m": 60, "s": 1}


def parse_duration(text) -> int:
    """'1h 12m 54s' / '8m' / '53s' / '' -> segundos (int)."""
    if text is None:
        return 0
    s = str(text).strip()
    if not s or s in ("-", "nan"):
        return 0
    total = 0
    for value, unit in re.findall(r"(\d+)\s*([hms])", s):
        total += int(value) * _UNIT_SECONDS[unit]
    return total


def format_duration(seconds: int) -> str:
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
