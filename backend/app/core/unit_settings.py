# -*- coding: utf-8 -*-
"""Device settings por unidad (fase G3, estilo Panda ELD).

Perfil editable por unidad: apodo (nickname), grupo libre, silenciar
alertas y notas. Se guarda en `backend/units.local.json` (gitignored:
puede contener notas operativas). Clave = nombre de la unidad (el mismo
que muestran Fleet y el Live Map).
"""

from __future__ import annotations

import json

from .. import config

SETTINGS_PATH = config.BACKEND_DIR / "units.local.json"

_FIELDS = ("nickname", "group", "muted", "notes", "ops_status",
           "campaigns")


def _load() -> dict:
    if SETTINGS_PATH.exists():
        try:
            return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
    return {}


def _save(data: dict) -> None:
    SETTINGS_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=1),
        encoding="utf-8")


def all_settings() -> dict[str, dict]:
    return _load()


def get_unit(unit: str) -> dict:
    base = {"nickname": "", "group": "", "muted": False, "notes": "",
            "ops_status": "", "campaigns": []}
    base.update(_load().get(unit, {}))
    return base


def set_unit(unit: str, nickname: str = "", group: str = "",
             muted: bool = False, notes: str = "") -> dict:
    unit = unit.strip()
    if not unit:
        raise ValueError("unit is required")
    data = _load()
    entry = {
        "nickname": nickname.strip()[:60],
        "group": group.strip()[:40],
        "muted": bool(muted),
        "notes": notes.strip()[:500],
        # ops_status y campaigns se editan por su propia vía (tableros
        # PM/DOT y perfil H3): editar el perfil normal NO los pisa.
        "ops_status": data.get(unit, {}).get("ops_status", ""),
        "campaigns": data.get(unit, {}).get("campaigns", []),
    }
    # Perfil 100% vacío -> se elimina la entrada (no acumular basura).
    if not any(entry[f] for f in ("nickname", "group", "notes",
                                  "ops_status", "campaigns")) \
            and not entry["muted"]:
        data.pop(unit, None)
    else:
        data[unit] = entry
    _save(data)
    return get_unit(unit)


def campaigns(unit: str) -> list[str]:
    """Campañas EXTRA habilitadas para la unidad (fase H3)."""
    return list(_load().get(unit, {}).get("campaigns", []))


def set_campaign(unit: str, key: str, enabled: bool) -> list[str]:
    unit = unit.strip()
    if not unit:
        raise ValueError("unit is required")
    data = _load()
    entry = data.setdefault(unit, {
        "nickname": "", "group": "", "muted": False, "notes": ""})
    cur = set(entry.get("campaigns", []))
    if enabled:
        cur.add(key)
    else:
        cur.discard(key)
    if cur:
        entry["campaigns"] = sorted(cur)
    else:
        entry.pop("campaigns", None)
        if not any(entry.get(f) for f in ("nickname", "group", "notes",
                                          "ops_status")) \
                and not entry.get("muted"):
            data.pop(unit, None)
    _save(data)
    return sorted(cur)


def set_ops_status(unit: str, status: str) -> None:
    """Estado operativo manual (out_of_service | in_shop | '' = auto)."""
    unit = unit.strip()
    if not unit:
        raise ValueError("unit is required")
    data = _load()
    entry = data.setdefault(unit, {
        "nickname": "", "group": "", "muted": False, "notes": ""})
    if status:
        entry["ops_status"] = status
    else:
        entry.pop("ops_status", None)
        if not any(entry.get(f) for f in ("nickname", "group", "notes")) \
                and not entry.get("muted"):
            data.pop(unit, None)
    _save(data)


def ops_statuses() -> dict[str, str]:
    return {u: s["ops_status"] for u, s in _load().items()
            if s.get("ops_status")}


def muted_units() -> set[str]:
    return {u for u, s in _load().items() if s.get("muted")}
