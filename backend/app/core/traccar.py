# -*- coding: utf-8 -*-
"""Ingesta de reefers desde Traccar (fase H5 — reemplazo real de TrackFleet).

El hardware (Teltonika FMC130 + sonda DS18B20, o Queclink GV600MA + sonda)
reporta por celular a un **Traccar self-host** (Apache-2.0). Fleet Tracker
ingiere de ahí vía el REST de Traccar y alimenta el Cold Chain con datos
REALES, reemplazando el modo demo.

Config en `backend/traccar.local.json` (gitignored por `*.local.json`):
    {
      "url": "https://traccar.tu-vps.com",   // sin barra final
      "token": "xxxxx",                       // token de usuario de Traccar
      "temp_attr": "temp1",       // atributo de temperatura (DS18B20 -> temp1)
      "temp_unit": "C",           // C o F (Teltonika reporta °C)
      "door_attr": "",            // p.ej. "in1"; vacío = sin sensor de puerta
      "battery_attr": "battery",  // % de batería interna del device
      "company": "",              // empresa por defecto de estos reefers
      "setpoints": { "53206": -10 },  // target °F por unidad (alerta por desvío)
      "deviation_f": 8,           // °F de desvío que dispara alarma de temp
      "stale_minutes": 20         // sin reportar => alarma "no data"
    }

ALCANCE (mínimo estándar de H5): temp de caja + puerta + batería + GPS, cada
≤5 min, con alertas por umbral, historial y export. El setpoint/modo/alarmas
del OEM (Thermo King TracKing / Carrier Lynx) necesitan su API y quedan para
una fase posterior — acá el `setpoint` es el target que cargás vos para
medir el desvío.

NOTA Teltonika: PROBAR SIEMPRE bajo cero (-10 °F real) — hay un bug histórico
de decodificación de temperaturas negativas; verificar que la sonda reporte
el signo correcto antes de confiar en las alarmas.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx

from .. import config

SETTINGS_PATH = config.BACKEND_DIR / "traccar.local.json"
_TIMEOUT = 15

_DEFAULTS = {
    "url": "",
    "token": "",
    "temp_attr": "temp1",
    "temp_unit": "C",
    "door_attr": "",
    "battery_attr": "battery",
    "company": "",
    "setpoints": {},
    "deviation_f": 8.0,
    "stale_minutes": 20,
}


def load_settings() -> dict:
    data: dict = {}
    if SETTINGS_PATH.exists():
        try:
            data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
    out = dict(_DEFAULTS)
    for k in _DEFAULTS:
        if k in data:
            out[k] = data[k]
    out["url"] = str(out["url"]).rstrip("/")
    out["setpoints"] = {str(k).upper(): v
                        for k, v in (out.get("setpoints") or {}).items()}
    try:
        out["deviation_f"] = float(out["deviation_f"])
    except (TypeError, ValueError):
        out["deviation_f"] = 8.0
    try:
        out["stale_minutes"] = int(out["stale_minutes"])
    except (TypeError, ValueError):
        out["stale_minutes"] = 20
    return out


def is_configured(s: dict | None = None) -> bool:
    s = s or load_settings()
    return bool(s["url"] and s["token"])


def _c_to_f(c) -> float | None:
    try:
        return round(float(c) * 9 / 5 + 32, 1)
    except (TypeError, ValueError):
        return None


def _temp_f(value, unit: str) -> float | None:
    """Temperatura del atributo -> °F (la sonda Teltonika reporta °C)."""
    if value is None:
        return None
    if str(unit).upper().startswith("F"):
        try:
            return round(float(value), 1)
        except (TypeError, ValueError):
            return None
    return _c_to_f(value)


def _num(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _params(s: dict, extra: str = "") -> str:
    base = f"token={s['token']}"
    return f"?{base}&{extra}" if extra else f"?{base}"


async def _get(client: httpx.AsyncClient, s: dict, path: str,
               extra: str = "") -> list:
    r = await client.get(f"{s['url']}/api{path}{_params(s, extra)}")
    r.raise_for_status()
    data = r.json()
    return data if isinstance(data, list) else [data]


def _stale(updated_iso: str, minutes: int) -> bool:
    if not updated_iso:
        return True
    try:
        t = datetime.fromisoformat(updated_iso.replace("Z", "+00:00"))
    except ValueError:
        return True
    return (datetime.now(timezone.utc) - t) > timedelta(minutes=minutes)


def _build_unit(dev: dict, pos: dict, s: dict) -> dict:
    """Device + última posición de Traccar -> forma ReeferUnit del Cold Chain.

    Sin OEM no hay setpoint/supply/ambient reales: el `setpoint_f` es el
    target configurado por el usuario (para medir el desvío). `return_f` es
    la temperatura de caja medida por la sonda."""
    attrs = (pos.get("attributes") or {}) if pos else {}
    name = dev.get("name") or dev.get("uniqueId") or str(dev.get("id"))
    box_f = _temp_f(attrs.get(s["temp_attr"]), s["temp_unit"])
    setpoint = s["setpoints"].get(str(name).upper())
    setpoint_f = _num(setpoint)
    updated = (pos.get("fixTime") or pos.get("deviceTime")
               or dev.get("lastUpdate") or "") if pos else \
        (dev.get("lastUpdate") or "")

    door = ""
    if s["door_attr"]:
        dv = attrs.get(s["door_attr"])
        if dv is not None:
            door = "Open" if dv in (True, 1, "1", "true", "open") else "Closed"
    battery = _num(attrs.get(s["battery_attr"]))

    # Alarmas por umbral (lo que da el "mínimo estándar"): desvío de temp,
    # sin datos recientes, batería baja.
    alarms: list[dict] = []
    stale = _stale(updated, s["stale_minutes"])
    if stale:
        alarms.append({"code": "no_data", "severity": 2,
                       "description": f"No data in {s['stale_minutes']}+ min",
                       "operator_action": "Check device power/signal"})
    elif (box_f is not None and setpoint_f is not None
          and abs(box_f - setpoint_f) >= s["deviation_f"]):
        alarms.append({
            "code": "temp_deviation", "severity": 3,
            "description": (f"Box {box_f}°F vs setpoint {setpoint_f}°F "
                            f"(>{s['deviation_f']:g}°F off)"),
            "operator_action": "Check reefer unit immediately"})
    if battery is not None and battery <= 20:
        alarms.append({"code": "low_battery", "severity": 1,
                       "description": f"Tracker battery {battery:g}%",
                       "operator_action": "OK to run; service device soon"})

    return {
        "id": f"trc-{dev.get('id')}",
        "unit": name,
        "company": s["company"] or "",
        "setpoint_f": setpoint_f,
        "return_f": box_f,
        "supply_f": None,            # sin OEM no hay supply real
        "ambient_f": None,
        "run_mode": "",
        "state": "" if stale else "Reporting",
        "fuel_pct": battery,         # se reusa la columna para batería del tracker
        "door": door,
        "alarms": alarms,
        "updated": updated,
        "demo": False,
        "source": "traccar",
        "lat": pos.get("latitude") if pos else None,
        "lng": pos.get("longitude") if pos else None,
    }


async def load() -> dict:
    """Reefers reales desde Traccar. {available, units, source, error}."""
    s = load_settings()
    if not is_configured(s):
        return {"available": False, "units": [], "source": "traccar",
                "error": "Not configured"}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            devices, positions = await asyncio.gather(
                _get(client, s, "/devices"),
                _get(client, s, "/positions"))
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        msg = ("Invalid Traccar token" if code in (401, 403)
               else f"Traccar HTTP {code}")
        return {"available": False, "units": [], "source": "traccar",
                "error": msg}
    except httpx.HTTPError as exc:
        return {"available": False, "units": [], "source": "traccar",
                "error": f"Could not reach Traccar: {type(exc).__name__}"}

    pos_by_dev = {p.get("deviceId"): p for p in positions}
    units = [_build_unit(d, pos_by_dev.get(d.get("id")), s) for d in devices]
    # Con alarmas primero (igual que el resto del Cold Chain).
    units.sort(key=lambda u: (len(u["alarms"]) == 0, u["unit"]))
    return {"available": True, "units": units, "source": "traccar",
            "error": ""}


async def history(unit_id: str, hours: int = 24) -> dict:
    """Serie de temperatura de un device (id 'trc-<deviceId>')."""
    s = load_settings()
    dev_id = unit_id.replace("trc-", "", 1)
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=hours)
    extra = (f"deviceId={dev_id}"
             f"&from={start.isoformat().replace('+00:00', 'Z')}"
             f"&to={end.isoformat().replace('+00:00', 'Z')}")
    points: list[dict] = []
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            rows = await _get(client, s, "/positions", extra)
    except httpx.HTTPError:
        return {"unit_id": unit_id, "demo": False, "points": []}
    setpoint = None
    for p in rows:
        attrs = p.get("attributes") or {}
        name = None  # el setpoint se resuelve por unidad afuera; acá best-effort
        box_f = _temp_f(attrs.get(s["temp_attr"]), s["temp_unit"])
        points.append({
            "time": p.get("fixTime") or p.get("deviceTime") or "",
            "setpoint_f": setpoint,
            "return_f": box_f,
            "supply_f": None,
        })
    return {"unit_id": unit_id, "demo": False, "points": points}


async def ping() -> dict:
    """Chequeo vivo para Connectivity: lee /server + cuenta devices."""
    s = load_settings()
    if not is_configured(s):
        return {"ok": False, "detail": "Not configured (url + token)"}
    import time
    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            await _get(client, s, "/server")
            devices = await _get(client, s, "/devices")
        ms = int((time.monotonic() - t0) * 1000)
        return {"ok": True,
                "detail": f"{len(devices)} device(s) ({ms} ms)"}
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        return {"ok": False,
                "detail": ("Invalid token" if code in (401, 403)
                           else f"HTTP {code}")}
    except httpx.HTTPError as exc:
        return {"ok": False, "detail": type(exc).__name__}
