# -*- coding: utf-8 -*-
"""Device settings por unidad (fase G3, estilo Panda ELD).

Perfil editable por unidad: apodo (nickname), grupo libre, silenciar
alertas y notas. Se guarda en `backend/units.local.json` (gitignored:
puede contener notas operativas). Clave = nombre de la unidad (el mismo
que muestran Fleet y el Live Map).
"""

from __future__ import annotations

from .. import config, db

# H6: persiste por-tenant en org_setting (clave 'unit_settings'); el JSON
# legacy (units.local.json) se importa una sola vez a la org 'default'.
SETTING_KEY = "unit_settings"
SETTINGS_PATH = config.BACKEND_DIR / "units.local.json"   # legacy (migracion)

_FIELDS = ("nickname", "group", "muted", "notes", "ops_status",
           "campaigns", "campaigns_off")
# Campos que, si quedan vacíos todos (y no está silenciada), hacen que la
# entrada de la unidad se borre (no acumular basura).
_KEEP_FIELDS = ("nickname", "group", "notes", "ops_status", "campaigns",
                "campaigns_off")


def _load() -> dict:
    data = db.get_setting(SETTING_KEY, legacy_file=SETTINGS_PATH)
    return data if isinstance(data, dict) else {}


def _save(data: dict) -> None:
    db.save_setting(SETTING_KEY, data)


def all_settings() -> dict[str, dict]:
    return _load()


def get_unit(unit: str) -> dict:
    base = {"nickname": "", "group": "", "muted": False, "notes": "",
            "ops_status": "", "campaigns": [], "campaigns_off": []}
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
        "campaigns_off": data.get(unit, {}).get("campaigns_off", []),
    }
    if not entry["campaigns_off"]:
        entry.pop("campaigns_off")
    # Perfil 100% vacío -> se elimina la entrada (no acumular basura).
    if not any(entry.get(f) for f in _KEEP_FIELDS) \
            and not entry["muted"]:
        data.pop(unit, None)
    else:
        data[unit] = entry
    _save(data)
    return get_unit(unit)


def campaigns(unit: str) -> list[str]:
    """Campañas EXTRA habilitadas para la unidad (fase H3)."""
    return list(_load().get(unit, {}).get("campaigns", []))


def campaigns_off(unit: str) -> list[str]:
    """Campañas AUTOMÁTICAS que se apagaron a mano para la unidad (v2.22:
    p.ej. 'reefer' en un trailer que ya no tiene equipo de frío)."""
    return list(_load().get(unit, {}).get("campaigns_off", []))


def campaign_units(key: str) -> tuple[set[str], set[str]]:
    """(unidades con `key` prendida a mano, unidades con `key` apagada a
    mano). Una sola lectura del setting: la usa el board del reefer."""
    on: set[str] = set()
    off: set[str] = set()
    for u, s in _load().items():
        if not isinstance(s, dict):
            continue
        if key in (s.get("campaigns") or []):
            on.add(u)
        if key in (s.get("campaigns_off") or []):
            off.add(u)
    return on, off


def set_campaign(unit: str, key: str, enabled: bool,
                 opt_out: bool = False) -> list[str]:
    """Prende/apaga una campaña extra de la unidad. `opt_out` (v2.22, para
    campañas que se prenden SOLAS, como el PM del reefer): al apagar, se
    recuerda el apagado explícito para que la detección automática no la
    vuelva a prender; prenderla borra ese apagado."""
    unit = unit.strip()
    if not unit:
        raise ValueError("unit is required")
    data = _load()
    entry = data.setdefault(unit, {
        "nickname": "", "group": "", "muted": False, "notes": ""})
    cur = set(entry.get("campaigns", []))
    off = set(entry.get("campaigns_off", []))
    if enabled:
        cur.add(key)
        off.discard(key)
    else:
        cur.discard(key)
        if opt_out:
            off.add(key)
    for field, vals in (("campaigns", cur), ("campaigns_off", off)):
        if vals:
            entry[field] = sorted(vals)
        else:
            entry.pop(field, None)
    if not any(entry.get(f) for f in _KEEP_FIELDS) \
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
        # v2.22: también cuenta campaigns/campaigns_off (antes, limpiar el
        # ops_status borraba la entrada entera y con ella las campañas).
        if not any(entry.get(f) for f in _KEEP_FIELDS) \
                and not entry.get("muted"):
            data.pop(unit, None)
    _save(data)


def ops_statuses() -> dict[str, str]:
    return {u: s["ops_status"] for u, s in _load().items()
            if s.get("ops_status")}


def muted_units() -> set[str]:
    return {u for u, s in _load().items() if s.get("muted")}
