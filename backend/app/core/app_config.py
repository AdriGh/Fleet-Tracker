# -*- coding: utf-8 -*-
"""Configuración persistente de la app (JSON local, no versionado).

Primera función configurable: **archivo de unidades**.
- `archived_ids`: unidades archivadas a mano (ocultas de Fleet).
- `kept_active_ids`: unidades que el usuario marcó "mantener activa" (excepción
  a la regla de auto-archivo).
- `auto_archive_enabled` / `auto_archive_days`: auto-archivar un camión si no
  tiene DVIR hace más de N días (se evalúa en vivo contra Samsara).
"""

from pathlib import Path

from .. import db

# H6 fase 3d: persiste por-tenant en org_setting (clave 'app_config'); el
# JSON legacy se importa una sola vez a la org 'default'.
SETTING_KEY = "app_config"
CONF_PATH = Path(__file__).resolve().parents[2] / "app_config.local.json"

_DEFAULTS: dict = {
    "auto_archive_enabled": False,
    "auto_archive_days": 30,
    "archived_ids": [],
    "kept_active_ids": [],
}


def _load() -> dict:
    return {**_DEFAULTS, **(db.get_setting(SETTING_KEY, legacy_file=CONF_PATH)
                            or {})}


def _save(d: dict) -> None:
    db.save_setting(SETTING_KEY, d)


def get_settings() -> dict:
    d = _load()
    return {
        "auto_archive_enabled": bool(d["auto_archive_enabled"]),
        "auto_archive_days": int(d["auto_archive_days"]),
    }


def set_settings(enabled: bool, days: int) -> dict:
    d = _load()
    d["auto_archive_enabled"] = bool(enabled)
    d["auto_archive_days"] = max(1, min(int(days), 365))
    _save(d)
    return get_settings()


def archived_ids() -> set[str]:
    return {str(x) for x in _load().get("archived_ids", [])}


def kept_active_ids() -> set[str]:
    return {str(x) for x in _load().get("kept_active_ids", [])}


def apply_action(asset_id: str, action: str) -> None:
    """archive | unarchive | keep_active | auto (resetea a la regla)."""
    asset_id = str(asset_id)
    d = _load()
    arch = {str(x) for x in d.get("archived_ids", [])}
    keep = {str(x) for x in d.get("kept_active_ids", [])}
    if action == "archive":
        arch.add(asset_id); keep.discard(asset_id)
    elif action == "unarchive":
        arch.discard(asset_id)
    elif action == "keep_active":
        keep.add(asset_id); arch.discard(asset_id)
    elif action == "auto":
        keep.discard(asset_id); arch.discard(asset_id)
    else:
        raise ValueError(f"unknown action: {action}")
    d["archived_ids"] = sorted(arch)
    d["kept_active_ids"] = sorted(keep)
    _save(d)
