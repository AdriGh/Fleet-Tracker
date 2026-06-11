# -*- coding: utf-8 -*-
"""Tracking en vivo para el Live Map (fase G1 del rework).

Lee de Samsara, por org y en paralelo:
- GET /fleet/vehicles/stats?types=gps,engineStates,obdOdometerMeters
- GET /fleet/vehicles/stats?types=fuelPercents,defLevelMilliPercent
  (la API limita a 3 stat types por request, por eso son dos llamadas)
- GET /fleet/hos/clocks  (duty status ACTUAL de cada conductor)

Scopes del token requeridos:
- "Read Vehicle Statistics" (categoría Vehicles)  -> vehicles/stats
- "Read ELD Compliance Settings (US)" (Compliance) -> hos/clocks

Si el token aún no tiene un scope, ese pedazo falla con 401/403: el
resultado lo reporta en `missing_scopes` y el frontend muestra el empty
state guiado en lugar de romper. La flota sin GPS simplemente no aparece.

La duración de movimiento ("Moving for 52m") se trackea en memoria del
proceso: cuando una unidad pasa de detenida a >1 mph se anota el epoch;
si se detiene, se borra. Sobrevive mientras el server viva, que es el
mismo ciclo de vida del caché de referencia de samsara.py.
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone

import httpx

from .samsara import _TIMEOUT, _get, _orgs, _paged  # noqa: F401 (reuso interno)

_STATS_A = ("/fleet/vehicles/stats"
            "?types=gps,engineStates,obdOdometerMeters&limit=512")
_STATS_B = ("/fleet/vehicles/stats"
            "?types=fuelPercents,defLevelMilliPercent&limit=512")
_CLOCKS = "/fleet/hos/clocks?limit=512"

SCOPE_VEHICLE_STATS = "Read Vehicle Statistics"
SCOPE_HOS = "Read ELD Compliance Settings (US)"

_METERS_PER_MILE = 1609.344

# vehicle_id -> epoch en que la unidad empezó a moverse (ver docstring).
_moving_since: dict[str, float] = {}
# vehicle_id -> epoch en que el motor entró en Idle (para alertas G3).
_idle_since: dict[str, float] = {}

# Estados de duty del HoS de Samsara (el valor es exactamente `sleeperBed`).
DUTY_KEYS = ("driving", "onDuty", "sleeperBed", "offDuty",
             "yardMove", "personalConveyance")


def _auth_error(exc: BaseException) -> bool:
    return (isinstance(exc, httpx.HTTPStatusError)
            and exc.response.status_code in (401, 403))


def _val(node: dict | None, *keys: str):
    """Valor de un stat de Samsara, tolerante a singular/plural.

    El snapshot devuelve objetos singulares (`engineState: {value}`); el
    feed/history devuelven listas de eventos. Acepta ambos.
    """
    if not node:
        return None
    for k in keys:
        v = node.get(k)
        if isinstance(v, dict):
            return v.get("value")
        if isinstance(v, list) and v and isinstance(v[-1], dict):
            return v[-1].get("value")
    return None


async def _org_track(client: httpx.AsyncClient, cfg: dict) -> dict:
    sa, sb, clocks, drivers = await asyncio.gather(
        _paged(client, cfg, _STATS_A),
        _paged(client, cfg, _STATS_B),
        _paged(client, cfg, _CLOCKS),
        _paged(client, cfg, "/fleet/drivers?limit=512"),
        return_exceptions=True,
    )
    out: dict = {
        "company": cfg.get("company") or "",
        "vehicles": [], "clocks": [],
        "missing": set(), "errors": [],
        "stats_ok": False, "hos_ok": False,
    }

    if isinstance(sa, BaseException):
        if _auth_error(sa):
            out["missing"].add(SCOPE_VEHICLE_STATS)
        else:
            out["errors"].append(f"stats: {sa}")
    else:
        out["stats_ok"] = True
        out["vehicles"] = sa

    if isinstance(sb, BaseException):
        # Fuel/DEF es secundario: si falla por scope ya quedó registrado
        # arriba (mismo scope); cualquier otro error no tumba el mapa.
        if not _auth_error(sb):
            out["errors"].append(f"fuel: {sb}")
        sb = []
    out["fuel"] = {str(v.get("id")): v for v in sb or []}

    if isinstance(clocks, BaseException):
        if _auth_error(clocks):
            out["missing"].add(SCOPE_HOS)
        else:
            out["errors"].append(f"hos: {clocks}")
    else:
        out["hos_ok"] = True
        out["clocks"] = clocks

    # /hos/clocks incluye perfiles INACTIVOS: el resumen de duty solo debe
    # contar conductores activos (mismo criterio que el Roster).
    if isinstance(drivers, BaseException):
        out["active_ids"] = None      # sin lista: no se filtra
    else:
        out["active_ids"] = {
            str(d.get("id")) for d in drivers
            if (d.get("driverActivationStatus") or "active") == "active"
        }

    return out


async def load_live() -> dict:
    """Snapshot del mapa: unidades con GPS + resumen de duty status."""
    orgs = _orgs()
    if not orgs:
        return {
            "available": False, "missing_scopes": [],
            "error": "No Samsara orgs configured",
            "vehicles": [], "summary": _empty_summary(),
        }

    now = time.time()
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        results = await asyncio.gather(
            *(_org_track(client, o) for o in orgs))

    vehicles: list[dict] = []
    counts = dict.fromkeys(DUTY_KEYS, 0)
    unknown = 0
    drivers_total = 0
    duty_by_vehicle: dict[str, dict] = {}
    missing: set[str] = set()
    errors: list[str] = []
    stats_ok = False
    hos_ok = False

    for r in results:
        missing |= r["missing"]
        errors += r["errors"]
        stats_ok = stats_ok or r["stats_ok"]
        hos_ok = hos_ok or r["hos_ok"]

        active_ids = r.get("active_ids")
        for c in r["clocks"]:
            status = ((c.get("currentDutyStatus") or {})
                      .get("hosStatusType") or "")
            veh = c.get("currentVehicle") or {}
            drv = c.get("driver") or {}
            # Solo conductores ACTIVOS cuentan en el resumen (clocks trae
            # también perfiles desactivados); sin lista, exige estado/unidad.
            if active_ids is not None:
                if str(drv.get("id")) not in active_ids:
                    continue
            elif not status and not veh.get("id"):
                continue
            drivers_total += 1
            if status in counts:
                counts[status] += 1
            else:
                unknown += 1
            if veh.get("id"):
                duty_by_vehicle[str(veh["id"])] = {
                    "driver": drv.get("name") or "",
                    "duty": status,
                }

        for v in r["vehicles"]:
            vid = str(v.get("id"))
            gps = v.get("gps") or {}
            lat = gps.get("latitude")
            lng = gps.get("longitude")
            if lat is None or lng is None:
                continue
            speed = float(gps.get("speedMilesPerHour") or 0.0)
            if speed > 1.0:
                _moving_since.setdefault(vid, now)
            else:
                _moving_since.pop(vid, None)
            engine = _val(v, "engineState", "engineStates") or ""
            if engine == "Idle":
                _idle_since.setdefault(vid, now)
            else:
                _idle_since.pop(vid, None)
            fuel_row = r["fuel"].get(vid) or {}
            odo_m = _val(v, "obdOdometerMeters", "obdOdometerMeter")
            duty = duty_by_vehicle.get(vid) or {}
            vehicles.append({
                "id": vid,
                "unit": v.get("name") or vid,
                "company": r["company"],
                "lat": lat,
                "lng": lng,
                "heading": gps.get("headingDegrees"),
                "speed_mph": round(speed, 1),
                "location": ((gps.get("reverseGeo") or {})
                             .get("formattedLocation") or ""),
                "gps_time": gps.get("time") or "",
                "engine": engine,
                "fuel_pct": _val(fuel_row, "fuelPercent", "fuelPercents"),
                "def_pct": _def_pct(fuel_row),
                "odometer_mi": (round(odo_m / _METERS_PER_MILE)
                                if odo_m else None),
                "driver": duty.get("driver") or "",
                "duty": duty.get("duty") or "",
                "moving_for_s": (int(now - _moving_since[vid])
                                 if vid in _moving_since else None),
                "idle_for_s": (int(now - _idle_since[vid])
                               if vid in _idle_since else None),
            })

    vehicles.sort(key=lambda x: (-(x["speed_mph"] or 0), x["unit"]))
    moving = sum(1 for x in vehicles if (x["speed_mph"] or 0) > 1.0)

    return {
        "available": stats_ok,
        "missing_scopes": sorted(missing),
        "error": "; ".join(errors) if errors and not stats_ok else "",
        "hos_available": hos_ok,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "vehicles": vehicles,
        "summary": {
            "drivers": drivers_total,
            "vehicles": len(vehicles),
            "moving": moving,
            "unknown": unknown,
            **counts,
        },
    }


def _def_pct(fuel_row: dict):
    milli = _val(fuel_row, "defLevelMilliPercent", "defLevelMilliPercents")
    if milli is None:
        return None
    return round(milli / 1000.0, 1)


def _empty_summary() -> dict:
    return {"drivers": 0, "vehicles": 0, "moving": 0, "unknown": 0,
            **dict.fromkeys(DUTY_KEYS, 0)}
