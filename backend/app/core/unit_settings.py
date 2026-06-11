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

_FIELDS = ("nickname", "group", "muted", "notes")


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
    base = {"nickname": "", "group": "", "muted": False, "notes": ""}
    base.update(_load().get(unit, {}))
    return base


def set_unit(unit: str, nickname: str = "", group: str = "",
             muted: bool = False, notes: str = "") -> dict:
    unit = unit.strip()
    if not unit:
        raise ValueError("unit vacío")
    data = _load()
    entry = {
        "nickname": nickname.strip()[:60],
        "group": group.strip()[:40],
        "muted": bool(muted),
        "notes": notes.strip()[:500],
    }
    # Perfil 100% vacío -> se elimina la entrada (no acumular basura).
    if not any(entry[f] for f in ("nickname", "group", "notes")) \
            and not entry["muted"]:
        data.pop(unit, None)
    else:
        data[unit] = entry
    _save(data)
    return get_unit(unit)


def muted_units() -> set[str]:
    return {u for u, s in _load().items() if s.get("muted")}
