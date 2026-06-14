# -*- coding: utf-8 -*-
"""Cold chain / monitoreo de reefers (fase G4 — el reemplazo de TrackFleet).

Fuente LIVE: Samsara `GET /fleet/trailers/stats` (scope "Read Trailer
Statistics", ya presente en los tokens). Stat types reefer* — la API
limita a 3 por request, así que se hacen 3 llamadas por org:
  A: reeferSetPointTemperatureMilliCZone1, reeferReturnAirTemperatureMilliCZone1,
     reeferSupplyAirTemperatureMilliCZone1
  B: reeferAmbientAirTemperatureMilliC, reeferAlarms, reeferRunMode
  C: reeferStateZone1, reeferFuelPercent, reeferDoorStateZone1
Temperaturas en mili-°C -> se convierten a °F (flota US).

MODO DEMO: hoy los orgs de Samsara devuelven 0 trailers con reefer (los
reefers del partner viven en hardware de terceros). Si live responde OK
pero vacío, se sirve un set DEMO determinista claramente etiquetado
(`demo: true`) para poder ver/demostrar el dashboard. Las alertas JAMÁS
se evalúan sobre datos demo.

Multizona (Zone2/3) queda para una iteración futura; las flotas de
referencia son single-zone.
"""

from __future__ import annotations

import asyncio
import math
from datetime import datetime, timedelta, timezone

import httpx

from . import traccar
from .samsara import _TIMEOUT, _orgs, _paged

_TYPES_A = ("reeferSetPointTemperatureMilliCZone1,"
            "reeferReturnAirTemperatureMilliCZone1,"
            "reeferSupplyAirTemperatureMilliCZone1")
_TYPES_B = "reeferAmbientAirTemperatureMilliC,reeferAlarms,reeferRunMode"
_TYPES_C = "reeferStateZone1,reeferFuelPercent,reeferDoorStateZone1"

SCOPE_TRAILER_STATS = "Read Trailer Statistics"


def _f(milli_c) -> float | None:
    """Mili-°C -> °F redondeado a 1 decimal."""
    if milli_c is None:
        return None
    return round(milli_c / 1000.0 * 9 / 5 + 32, 1)


def _val(node):
    """Valor de un stat (snapshot {value} o lista de eventos)."""
    if isinstance(node, dict):
        return node.get("value", node)
    if isinstance(node, list) and node and isinstance(node[-1], dict):
        return node[-1].get("value", node[-1])
    return None


def _time_of(node) -> str:
    if isinstance(node, dict):
        return node.get("time") or ""
    if isinstance(node, list) and node and isinstance(node[-1], dict):
        return node[-1].get("time") or ""
    return ""


def _alarms_of(node) -> list[dict]:
    raw = _val(node)
    items = []
    if isinstance(raw, dict):
        items = raw.get("alarms") or []
    elif isinstance(raw, list):
        items = raw
    out = []
    for a in items:
        if not isinstance(a, dict):
            continue
        out.append({
            "code": a.get("alarmCode") or a.get("code") or "",
            "description": a.get("description") or "",
            "severity": a.get("severity") or 0,
            "operator_action": a.get("operatorAction") or "",
        })
    return out


def _auth_error(exc: BaseException) -> bool:
    return (isinstance(exc, httpx.HTTPStatusError)
            and exc.response.status_code in (401, 403))


async def _org_reefer(client: httpx.AsyncClient, cfg: dict) -> dict:
    base = "/fleet/trailers/stats?limit=512&types="
    a, b, c = await asyncio.gather(
        _paged(client, cfg, base + _TYPES_A),
        _paged(client, cfg, base + _TYPES_B),
        _paged(client, cfg, base + _TYPES_C),
        return_exceptions=True,
    )
    out: dict = {"company": cfg.get("company") or "", "units": [],
                 "missing": set(), "ok": False}
    parts = [a, b, c]
    if any(isinstance(p, BaseException) for p in parts):
        first = next(p for p in parts if isinstance(p, BaseException))
        if _auth_error(first):
            out["missing"].add(SCOPE_TRAILER_STATS)
        return out
    out["ok"] = True

    merged: dict[str, dict] = {}
    for batch in parts:
        for t in batch:
            tid = str(t.get("id"))
            merged.setdefault(tid, {"id": tid,
                                    "name": t.get("name") or tid})
            merged[tid].update({k: v for k, v in t.items()
                                if k not in ("id", "name")})

    for t in merged.values():
        has_reefer = any(k.startswith("reefer") for k in t)
        if not has_reefer:
            continue
        set_node = t.get("reeferSetPointTemperatureMilliCZone1")
        out["units"].append({
            "id": t["id"],
            "unit": t["name"],
            "company": out["company"],
            "setpoint_f": _f(_val(set_node)),
            "return_f": _f(_val(
                t.get("reeferReturnAirTemperatureMilliCZone1"))),
            "supply_f": _f(_val(
                t.get("reeferSupplyAirTemperatureMilliCZone1"))),
            "ambient_f": _f(_val(
                t.get("reeferAmbientAirTemperatureMilliC"))),
            "run_mode": _val(t.get("reeferRunMode")) or "",
            "state": _val(t.get("reeferStateZone1")) or "",
            "fuel_pct": _val(t.get("reeferFuelPercent")),
            "door": _val(t.get("reeferDoorStateZone1")) or "",
            "alarms": _alarms_of(t.get("reeferAlarms")),
            "updated": _time_of(set_node),
            "demo": False,
        })
    return out


# ----- Demo determinista (etiquetado; nunca alimenta alertas) -----------

_DEMO_BASE = [
    # (unit, setpoint, drift, ambient, mode, state, fuel, door, alarms)
    ("53218", 65, -4.7, 87.3, "Continuous", "On", 73, "Closed",
     [{"code": 31, "description": "Failed To Start - Auto Mode",
       "severity": 2, "operator_action": "Check as specified"}]),
    ("53210", -10, 0.8, 88.1, "Continuous", "On", 64, "Closed", []),
    ("53213", 35, 0.9, 79.4, "Start-Stop", "On", 41, "Closed", []),
    ("R1904", -10, 3.9, 84.6, "Continuous", "On", 22, "Closed",
     [{"code": 16, "description": "Battery Voltage Too Low",
       "severity": 1, "operator_action": "OK to run"}]),
    ("R2102", 26, 0.4, 81.2, "Start-Stop", "On", 58, "Open", []),
    ("q35029", 55, 23.9, 80.5, "Start-Stop", "Off", 12, "Closed",
     [{"code": 25502, "description": "Unit not running",
       "severity": 3, "operator_action": "Take immediate action"}]),
]


def demo_units() -> list[dict]:
    now = datetime.now(timezone.utc)
    out = []
    for i, (unit, sp, drift, amb, mode, state, fuel, door,
            alarms) in enumerate(_DEMO_BASE):
        out.append({
            "id": f"demo-{unit}",
            "unit": unit,
            "company": "DEMO",
            "setpoint_f": float(sp),
            "return_f": round(sp + drift, 1),
            "supply_f": round(sp - 1.8 + drift * 0.3, 1),
            "ambient_f": amb,
            "run_mode": mode,
            "state": state,
            "fuel_pct": fuel,
            "door": door,
            "alarms": alarms,
            "updated": (now - timedelta(minutes=2 + i)).isoformat(),
            "demo": True,
        })
    return out


def demo_history(unit_id: str, hours: int = 24) -> list[dict]:
    """Serie horaria determinista: return oscila alrededor del setpoint
    con un pico de defrost cada 8 h; supply corre ~2 °F por debajo."""
    base = next((d for d in _DEMO_BASE
                 if f"demo-{d[0]}" == unit_id), _DEMO_BASE[0])
    sp = float(base[1])
    seed = sum(ord(ch) for ch in unit_id) % 7
    now = datetime.now(timezone.utc).replace(minute=0, second=0,
                                             microsecond=0)
    out = []
    for i in range(hours, -1, -1):
        t = now - timedelta(hours=i)
        wave = math.sin((i + seed) * 0.9) * 1.4
        defrost = 6.0 if (i + seed) % 8 == 0 else 0.0
        out.append({
            "time": t.isoformat(),
            "setpoint_f": sp,
            "return_f": round(sp + wave + defrost, 1),
            "supply_f": round(sp - 2.0 + wave * 0.5, 1),
        })
    return out


# ----- API públicas ------------------------------------------------------

async def load_live() -> dict:
    # H5: reefers REALES desde Traccar (hardware propio) primero. Si no está
    # configurado, Samsara; si Samsara reporta 0 reefers, demo etiquetado.
    traccar_error = ""
    if traccar.is_configured():
        t = await traccar.load()
        if t.get("available"):
            return {"available": True, "demo": False, "source": "traccar",
                    "missing_scopes": [], "units": t["units"],
                    "live_empty": not t["units"]}
        traccar_error = t.get("error", "")

    orgs = _orgs()
    if not orgs:
        return {"available": bool(traccar_error), "demo": False,
                "source": "traccar" if traccar_error else "none",
                "missing_scopes": [], "units": [], "live_empty": False,
                "error": traccar_error}

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        results = await asyncio.gather(
            *(_org_reefer(client, o) for o in orgs))

    units: list[dict] = []
    missing: set[str] = set()
    ok_any = False
    for r in results:
        missing |= r["missing"]
        ok_any = ok_any or r["ok"]
        units.extend(r["units"])

    if not ok_any:
        return {"available": False, "demo": False, "source": "none",
                "missing_scopes": sorted(missing), "units": [],
                "live_empty": False, "error": traccar_error}

    if not units:
        # Scope OK pero ningún trailer reporta reefer: servir demo
        # etiquetado para poder ver/demostrar el dashboard.
        return {"available": True, "demo": True, "source": "demo",
                "missing_scopes": [], "units": demo_units(),
                "live_empty": True}

    units.sort(key=lambda u: (len(u["alarms"]) == 0, u["unit"]))
    return {"available": True, "demo": False, "source": "samsara",
            "missing_scopes": [], "units": units, "live_empty": False}


async def history(unit_id: str, hours: int = 24) -> dict:
    if unit_id.startswith("demo-"):
        return {"unit_id": unit_id, "demo": True,
                "points": demo_history(unit_id, hours)}
    if unit_id.startswith("trc-"):                  # H5: historial de Traccar
        return await traccar.history(unit_id, hours)

    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=hours)
    qs = (f"/fleet/trailers/stats/history?trailerIds={unit_id}"
          f"&startTime={start.isoformat()}&endTime={end.isoformat()}"
          f"&types={_TYPES_A}")
    points: list[dict] = []
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for cfg in _orgs():
            try:
                rows = await _paged(client, cfg, qs)
            except httpx.HTTPError:
                continue
            for t in rows:
                if str(t.get("id")) != unit_id:
                    continue
                sets = {e["time"]: e.get("value") for e in
                        t.get("reeferSetPointTemperatureMilliCZone1") or []}
                rets = {e["time"]: e.get("value") for e in
                        t.get("reeferReturnAirTemperatureMilliCZone1") or []}
                sups = {e["time"]: e.get("value") for e in
                        t.get("reeferSupplyAirTemperatureMilliCZone1") or []}
                for ts in sorted(set(sets) | set(rets) | set(sups)):
                    points.append({
                        "time": ts,
                        "setpoint_f": _f(sets.get(ts)),
                        "return_f": _f(rets.get(ts)),
                        "supply_f": _f(sups.get(ts)),
                    })
            if points:
                break
    return {"unit_id": unit_id, "demo": False, "points": points}
