# -*- coding: utf-8 -*-
"""Inventario de la flota (fuente única de GET /api/fleet, v2.20).

Extraído de la ruta para que Service Requests use EXACTAMENTE el mismo
universo de unidades que el dropdown del front (que lee GET /api/fleet):
unidades de Samsara (o del ELD demo) + unidades manuales (Fleet -> Add New
Unit; Samsara gana por número de unidad).
"""

from __future__ import annotations

from . import app_config, manual_units, samsara


def _manual_only() -> list[dict]:
    units = manual_units.merge_into_fleet([])
    for u in units:
        u["archived"], u["archive_reason"] = False, None
    return units


async def load(refresh: bool = False) -> dict:
    """Inventario de la flota con datos del asset, defectos abiertos y estado
    de archivo (manual o auto por inactividad de DVIR). Solo Samsara (sin
    fallback CSV). Devuelve {available, source, units, settings[,
    archived_count][, error]}: `error` = Samsara falló y `units` trae SOLO
    las manuales (universo parcial)."""
    if refresh:
        samsara.clear_cache()
    st = app_config.get_settings()
    # Unidades agregadas a mano (Fleet -> Add New Unit): se muestran SIEMPRE,
    # esten o no disponibles los datos de Samsara.
    if not samsara.is_available():
        units = _manual_only()
        return {"available": bool(units),
                "source": "manual" if units else "none",
                "units": units, "settings": st, "archived_count": 0}
    arch = app_config.archived_ids()
    keep = app_config.kept_active_ids()
    auto_days = st["auto_archive_days"] if st["auto_archive_enabled"] else None
    try:
        units = await samsara.list_fleet(auto_days)
    except Exception as exc:  # noqa: BLE001
        units = _manual_only()
        return {"available": bool(units),
                "source": "error" if not units else "manual",
                "error": str(exc), "units": units, "settings": st}

    for u in units:
        uid = str(u.get("id"))
        if uid in arch:
            u["archived"], u["archive_reason"] = True, "manual"
        elif (auto_days and u.get("dvir_known") and u.get("auto_eligible")
              and not u.get("last_dvir") and uid not in keep):
            u["archived"], u["archive_reason"] = True, "auto"
        else:
            u["archived"], u["archive_reason"] = False, None

    # Mergear las unidades manuales (Samsara gana por numero de unidad).
    units = manual_units.merge_into_fleet(units)
    for u in units:
        u.setdefault("archived", False)
        u.setdefault("archive_reason", None)

    return {
        "available": True,
        "source": "samsara",
        "settings": st,
        "archived_count": sum(1 for u in units if u["archived"]),
        "units": units,
    }
