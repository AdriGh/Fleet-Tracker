# -*- coding: utf-8 -*-
"""Ingesta + control de reefers vía Thermo King TracKing / ConnectedSuite.

BOCETO H6 — adapter OEM gemelo de `core/lynx.py` para la flota Thermo King.
Igual que Lynx (Carrier), el API de TracKing es **BIDIRECCIONAL**: lee la
telemetría real del reefer (setpoint, supply/return/ambient, modo, alarmas)
Y permite **CONTROLARLO** (cambiar setpoint/modo, pre-trip, defrost, power).
Confirmado (doc de integración): *"remotely changing the set point and unit
modes, and turning the reefer on or off… can integrate data into any 3rd
party website or back-end system through web service"*.

TracKing/ConnectedSuite viene de fábrica en los reefers Thermo King; las
credenciales del API se piden a **tracking@thermoking.com** (vía el
formulario que entrega el proveedor). Auth = OAuth2 client-credentials
(CONFIRMAR — algunos despliegues usan API key sola).

SOBERANÍA DEL DATO (ver docs/STRATEGY-data.md): fuente NUESTRA y directa —
no pasa por Samsara ni por ningún tercero.

TIER: el control remoto requiere un service level de ConnectedSuite que
incluya two-way (los planes superiores). Con tier `monitor` (solo lectura)
las funciones de control devuelven un error claro sin pegarle al API.

Config en `backend/thermoking.local.json` (gitignored por `*.local.json`):
    {
      "base_url": "https://api.tracking.thermoking.com",  // CONFIRMAR
      "token_url": "",            // vacío => base_url + /oauth/token
      "client_id": "",            // de tracking@thermoking.com
      "client_secret": "",        // de tracking@thermoking.com
      "api_key": "",              // header x-api-key (si aplica)
      "company": "",
      "tier": "monitor",          // monitor | control | enhanced
      "temp_unit": "F",           // unidad que reporta el API (CONFIRMAR)
      "deviation_f": 8.0,
      "stale_minutes": 20
    }

PENDIENTE (no es público; pedir a tracking@thermoking.com): los PATHS
exactos de los endpoints y los nombres de campos del JSON. Acá van como
defaults overrideables por config (`path_assets`/`path_command`/
`path_history`) y los campos se leen por `_pick()` con los nombres más
probables, todo centralizado para ajustarlo en un solo lugar cuando lleguen
las credenciales. Ver docs/reefer-dealer-questions.md.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone

import httpx

from .. import config

SETTINGS_PATH = config.BACKEND_DIR / "thermoking.local.json"
_TIMEOUT = 20

# Paths del API (CONFIRMAR con Thermo King; overrideables por config).
_PATH_ASSETS = "/api/v1/assets"                  # lista de reefers + estado
_PATH_COMMAND = "/api/v1/assets/{id}/commands"   # two-way command API
_PATH_HISTORY = "/api/v1/assets/{id}/history"    # serie de temperatura

_CONTROL_TIERS = {"control", "enhanced"}

_DEFAULTS = {
    "base_url": "",
    "token_url": "",
    "client_id": "",
    "client_secret": "",
    "api_key": "",
    "company": "",
    "tier": "monitor",
    "temp_unit": "F",
    "deviation_f": 8.0,
    "stale_minutes": 20,
    "path_assets": _PATH_ASSETS,
    "path_command": _PATH_COMMAND,
    "path_history": _PATH_HISTORY,
}

# Token OAuth cacheado en memoria (se renueva al expirar).
_token_cache: dict = {"access_token": "", "expires_at": 0.0}


def _norm_tier(value) -> str:
    """Service level -> monitor|control|enhanced (control = incluye two-way)."""
    t = str(value or "monitor").strip().lower()
    if "enhanced" in t:
        return "enhanced"
    if "control" in t:
        return "control"
    return "monitor"


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
    out["base_url"] = str(out["base_url"]).rstrip("/")
    out["token_url"] = str(out["token_url"]).rstrip("/")
    out["tier"] = _norm_tier(out.get("tier"))
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
    return bool(s["base_url"] and s["client_id"] and s["client_secret"])


def can_control(s: dict | None = None) -> bool:
    """¿El service level habilita control remoto real (two-way)?"""
    s = s or load_settings()
    return s["tier"] in _CONTROL_TIERS


# ----- Helpers de parsing -------------------------------------------------

def _pick(d: dict, *keys):
    """Primer valor no-None de `d` entre varios nombres de campo probables."""
    for k in keys:
        v = d.get(k)
        if v is not None:
            return v
    return None


def _num(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _temp_f(value, unit: str) -> float | None:
    """Temperatura del API -> °F. `unit` = 'F' (passthrough) o 'C' (convierte)."""
    if value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if str(unit).upper().startswith("C"):
        return round(v * 9 / 5 + 32, 1)
    return round(v, 1)


def _door(value) -> str:
    if value is None:
        return ""
    return "Open" if value in (True, 1, "1", "true", "open", "Open") else "Closed"


def _alarms(asset: dict) -> list[dict]:
    """Alarmas/fault codes reales del OEM -> forma normalizada del Cold Chain."""
    raw = _pick(asset, "alarms", "activeAlarms", "faults", "faultCodes") or []
    out: list[dict] = []
    for a in raw if isinstance(raw, list) else []:
        if not isinstance(a, dict):
            continue
        out.append({
            "code": _pick(a, "alarmCode", "faultCode", "code", "id") or "",
            "description": _pick(a, "description", "name", "message") or "",
            "severity": _pick(a, "severity", "level") or 0,
            "operator_action": _pick(a, "operatorAction", "action") or "",
        })
    return out


def _stale(updated_iso: str, minutes: int) -> bool:
    if not updated_iso:
        return True
    try:
        t = datetime.fromisoformat(str(updated_iso).replace("Z", "+00:00"))
    except ValueError:
        return False          # timestamp no-ISO: no asumir stale
    return (datetime.now(timezone.utc) - t) > timedelta(minutes=minutes)


def _as_list(data) -> list:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for k in ("assets", "data", "items", "results", "units"):
            if isinstance(data.get(k), list):
                return data[k]
        return [data]
    return []


def _build_unit(asset: dict, s: dict) -> dict:
    """Asset del TracKing API -> forma ReeferUnit del Cold Chain.

    NOMBRES DE CAMPO: el JSON exacto del API no es público; los accesos van
    por `_pick()` con los nombres más probables y deben confirmarse contra
    el schema (un solo lugar). Como en Lynx, setpoint/supply/ambient/modo/
    alarmas son REALES (OEM)."""
    aid = _pick(asset, "id", "assetId", "unitId", "serialNumber", "deviceId")
    name = (_pick(asset, "name", "unitName", "assetName", "displayName")
            or str(aid))
    tu = s["temp_unit"]
    setpoint_f = _temp_f(
        _pick(asset, "setpoint", "setPoint", "setpointTemperature"), tu)
    return_f = _temp_f(
        _pick(asset, "returnAirTemperature", "returnAir", "boxTemperature"),
        tu)
    supply_f = _temp_f(
        _pick(asset, "supplyAirTemperature", "supplyAir", "dischargeAir"), tu)
    ambient_f = _temp_f(
        _pick(asset, "ambientAirTemperature", "ambient"), tu)
    run_mode = str(_pick(asset, "runMode", "operatingMode", "mode") or "")
    state = str(_pick(asset, "powerState", "state", "switchState") or "")
    fuel = _num(_pick(asset, "fuelLevelPercent", "fuelPercent", "fuelLevel"))
    door = _door(_pick(asset, "doorState", "door", "doorOpen"))

    loc = asset.get("location") or asset.get("position") or {}
    lat = _num(_pick(asset, "latitude", "lat")
               or loc.get("latitude") or loc.get("lat"))
    lng = _num(_pick(asset, "longitude", "lng", "lon")
               or loc.get("longitude") or loc.get("lng"))
    updated = str(_pick(asset, "lastReported", "lastUpdate", "timestamp",
                        "updatedAt") or "")

    alarms = _alarms(asset)
    stale = _stale(updated, s["stale_minutes"])
    if stale:
        alarms = alarms + [{
            "code": "no_data", "severity": 2,
            "description": f"No data in {s['stale_minutes']}+ min",
            "operator_action": "Check unit connectivity"}]
    elif (return_f is not None and setpoint_f is not None
          and abs(return_f - setpoint_f) >= s["deviation_f"]):
        alarms = alarms + [{
            "code": "temp_deviation", "severity": 3,
            "description": (f"Return {return_f}°F vs setpoint {setpoint_f}°F "
                            f"(>{s['deviation_f']:g}°F off)"),
            "operator_action": "Check reefer unit immediately"}]

    return {
        "id": f"tk-{aid}",
        "unit": name,
        "company": s["company"] or str(_pick(asset, "fleetName",
                                             "company") or ""),
        "setpoint_f": setpoint_f,
        "return_f": return_f,
        "supply_f": supply_f,
        "ambient_f": ambient_f,
        "run_mode": run_mode,
        "state": state or ("" if stale else "Reporting"),
        "fuel_pct": fuel,
        "door": door,
        "alarms": alarms,
        "updated": updated,
        "demo": False,
        "source": "thermoking",
        "lat": lat,
        "lng": lng,
        "can_control": s["tier"] in _CONTROL_TIERS,  # la UI gatea el botón
    }


# ----- HTTP / OAuth -------------------------------------------------------

async def _access_token(client: httpx.AsyncClient, s: dict) -> str:
    """Token OAuth2 client-credentials, cacheado hasta ~30 s antes de expirar."""
    now = time.time()
    if _token_cache["access_token"] and _token_cache["expires_at"] - 30 > now:
        return _token_cache["access_token"]
    url = s["token_url"] or f"{s['base_url']}/oauth/token"
    r = await client.post(url, data={
        "grant_type": "client_credentials",
        "client_id": s["client_id"],
        "client_secret": s["client_secret"],
    })
    r.raise_for_status()
    tok = r.json() if r.content else {}
    _token_cache["access_token"] = tok.get("access_token", "")
    _token_cache["expires_at"] = now + float(tok.get("expires_in", 3600) or 3600)
    return _token_cache["access_token"]


def _headers(token: str, s: dict) -> dict:
    h = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if s["api_key"]:
        h["x-api-key"] = s["api_key"]
    return h


async def _get(client: httpx.AsyncClient, s: dict, path: str,
               params: dict | None = None):
    token = await _access_token(client, s)
    r = await client.get(f"{s['base_url']}{path}",
                         headers=_headers(token, s), params=params)
    r.raise_for_status()
    return r.json() if r.content else []


# ----- API públicas (misma firma que lynx.py / traccar.py) ---------------

async def load() -> dict:
    """Reefers reales desde Thermo King. {available, units, source, error}."""
    s = load_settings()
    if not is_configured(s):
        return {"available": False, "units": [], "source": "thermoking",
                "error": "Not configured"}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            data = await _get(client, s, s["path_assets"])
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        msg = ("Invalid Thermo King credentials" if code in (401, 403)
               else f"TracKing HTTP {code}")
        return {"available": False, "units": [], "source": "thermoking",
                "error": msg}
    except httpx.HTTPError as exc:
        return {"available": False, "units": [], "source": "thermoking",
                "error": f"Could not reach TracKing: {type(exc).__name__}"}

    units = [_build_unit(a, s) for a in _as_list(data) if isinstance(a, dict)]
    units.sort(key=lambda u: (len(u["alarms"]) == 0, u["unit"]))
    return {"available": True, "units": units, "source": "thermoking",
            "error": ""}


async def history(unit_id: str, hours: int = 24) -> dict:
    """Serie de temperatura de una unidad (id 'tk-<assetId>')."""
    s = load_settings()
    if not is_configured(s):
        return {"unit_id": unit_id, "demo": False, "points": []}
    aid = unit_id.replace("tk-", "", 1)
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=hours)
    path = s["path_history"].format(id=aid)
    params = {"from": start.isoformat().replace("+00:00", "Z"),
              "to": end.isoformat().replace("+00:00", "Z")}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            data = await _get(client, s, path, params)
    except httpx.HTTPError:
        return {"unit_id": unit_id, "demo": False, "points": []}
    tu = s["temp_unit"]
    points = [{
        "time": str(_pick(row, "time", "timestamp", "reportedAt") or ""),
        "setpoint_f": _temp_f(_pick(row, "setpoint", "setPoint"), tu),
        "return_f": _temp_f(_pick(row, "returnAirTemperature", "returnAir",
                                  "boxTemperature"), tu),
        "supply_f": _temp_f(_pick(row, "supplyAirTemperature", "supplyAir",
                                  "dischargeAir"), tu),
    } for row in _as_list(data) if isinstance(row, dict)]
    return {"unit_id": unit_id, "demo": False, "points": points}


# ----- Control remoto (two-way; gateado por tier) -------------------------

async def _command(unit_id: str, command: str,
                   payload: dict | None = None) -> dict:
    """Envía un comando two-way al reefer vía el TracKing command API.

    Gateado por tier: sin un service level con two-way devuelve error SIN
    pegarle al API. Solo unidades 'tk-'."""
    s = load_settings()
    if not is_configured(s):
        return {"ok": False, "detail": "Thermo King not configured"}
    if not can_control(s):
        return {"ok": False, "detail": (
            "Remote control requires a ConnectedSuite service level with "
            "two-way commands")}
    if not unit_id.startswith("tk-"):
        return {"ok": False,
                "detail": "Remote control is only available on Thermo King units"}
    aid = unit_id.replace("tk-", "", 1)
    body = {"command": command}
    if payload:
        body.update(payload)
    path = s["path_command"].format(id=aid)
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            token = await _access_token(client, s)
            r = await client.post(f"{s['base_url']}{path}",
                                  headers=_headers(token, s), json=body)
            r.raise_for_status()
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        return {"ok": False, "detail": (
            "Invalid Thermo King credentials" if code in (401, 403)
            else f"TracKing HTTP {code}")}
    except httpx.HTTPError as exc:
        return {"ok": False,
                "detail": f"Could not reach TracKing: {type(exc).__name__}"}
    return {"ok": True, "detail": f"Command '{command}' sent to {unit_id}"}


async def set_setpoint(unit_id: str, setpoint_f: float) -> dict:
    """Cambia el setpoint REAL del reefer (no un umbral): requiere two-way."""
    return await _command(unit_id, "setSetpoint",
                         {"setpointF": round(float(setpoint_f), 1)})


async def set_mode(unit_id: str, mode: str) -> dict:
    return await _command(unit_id, "setMode", {"mode": str(mode)})


async def initiate_defrost(unit_id: str) -> dict:
    return await _command(unit_id, "defrost")


async def set_power(unit_id: str, on: bool) -> dict:
    return await _command(unit_id, "power", {"on": bool(on)})


# ----- Test de conexión (Connectivity) -----------------------------------

async def ping() -> dict:
    """Chequeo vivo y SEGURO: OAuth + lista de assets. No muta nada."""
    s = load_settings()
    if not is_configured(s):
        return {"ok": False,
                "detail": "Not configured (base URL + client id/secret)"}
    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            await _access_token(client, s)        # OAuth válido
            data = await _get(client, s, s["path_assets"])
        ms = int((time.monotonic() - t0) * 1000)
        n = len([a for a in _as_list(data) if isinstance(a, dict)])
        ctl = "control" if s["tier"] in _CONTROL_TIERS else "read-only"
        return {"ok": True,
                "detail": f"{n} asset(s) · tier {s['tier']} ({ctl}) ({ms} ms)"}
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        return {"ok": False, "detail": ("Invalid credentials"
                                        if code in (401, 403)
                                        else f"HTTP {code}")}
    except httpx.HTTPError as exc:
        return {"ok": False, "detail": type(exc).__name__}
