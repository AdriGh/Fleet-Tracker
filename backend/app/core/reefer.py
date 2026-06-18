# -*- coding: utf-8 -*-
"""Cold chain / monitoreo de reefers (G4 -> H5/H6 — reemplazo de TrackFleet).

Principio de SOBERANÍA DEL DATO (ver docs/STRATEGY-data.md): el reefer es
NUESTRO y directo. Fuentes, por prioridad:
  1. **Lynx (OEM directo)** — Carrier Lynx API: lee Y controla. `core/lynx.py`.
  2. **Thermo King (OEM directo)** — TracKing/ConnectedSuite API: lee Y
     controla. `core/thermoking.py`.
  3. **Traccar (aftermarket)** — Teltonika/Queclink + sonda -> Traccar
     self-host. Solo lectura + umbral de alerta. `core/traccar.py`.
  4. **Demo** — set determinista etiquetado (`demo: true`) cuando no hay
     ninguna fuente configurada, para poder ver/demostrar el dashboard.

Samsara NO es fuente de reefer (a propósito): evita depender de un tercero
y del API-gating de Samsara; el ELD del cliente se usa para el power unit,
no para el cold chain.

Todas las fuentes emiten la MISMA forma ReeferUnit (unit, setpoint_f,
return_f, supply_f, ambient_f, run_mode, state, fuel_pct, door, alarms[],
updated, source, …) para que el frontend sea agnóstico. Las alertas JAMÁS
se evalúan sobre datos demo. El control remoto (two-way) se despacha al
módulo OEM según el prefijo del id (lynx- / tk-).
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

from . import lynx, thermoking, traccar

# Fuentes reales en orden de prioridad (módulo, etiqueta de `source`).
_SOURCES = ((lynx, "lynx"), (thermoking, "thermoking"), (traccar, "traccar"))

# Control remoto: prefijo del id -> módulo OEM que lo ejecuta (two-way).
_CONTROL_MODS = (("lynx-", lynx), ("tk-", thermoking))


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
    """Snapshot del cold chain. Prioridad Lynx (OEM) -> Traccar -> demo.

    La primera fuente configurada y disponible gana. Si ninguna está
    configurada/disponible, se sirve el demo etiquetado para poder ver el
    dashboard (con el último error de una fuente que falló, si lo hubo)."""
    last_error = ""
    for mod, src in _SOURCES:
        if not mod.is_configured():
            continue
        r = await mod.load()
        if r.get("available"):
            units = r["units"]
            return {"available": True, "demo": False, "source": src,
                    "missing_scopes": [], "units": units,
                    "live_empty": not units}
        last_error = r.get("error", "") or last_error

    # Sin fuente real: demo etiquetado (las alertas nunca corren sobre demo).
    return {"available": True, "demo": True, "source": "demo",
            "missing_scopes": [], "units": demo_units(),
            "live_empty": True, "error": last_error}


async def history(unit_id: str, hours: int = 24) -> dict:
    if unit_id.startswith("demo-"):
        return {"unit_id": unit_id, "demo": True,
                "points": demo_history(unit_id, hours)}
    if unit_id.startswith("lynx-"):                 # OEM directo (Carrier)
        return await lynx.history(unit_id, hours)
    if unit_id.startswith("tk-"):                   # OEM directo (Thermo King)
        return await thermoking.history(unit_id, hours)
    if unit_id.startswith("trc-"):                  # aftermarket (Traccar)
        return await traccar.history(unit_id, hours)
    return {"unit_id": unit_id, "demo": False, "points": []}


# ----- Control remoto (despacho por prefijo a la fuente OEM) -------------

def _control_mod(unit_id: str):
    for pfx, mod in _CONTROL_MODS:
        if unit_id.startswith(pfx):
            return mod
    return None


_NO_OEM = {"ok": False,
           "detail": "Remote control is only available on OEM "
                     "(Carrier Lynx / Thermo King) units"}


async def set_setpoint(unit_id: str, setpoint_f: float) -> dict:
    """Cambia el setpoint REAL del reefer vía su API OEM (two-way)."""
    mod = _control_mod(unit_id)
    if mod is None:
        return dict(_NO_OEM)
    return await mod.set_setpoint(unit_id, setpoint_f)


async def command(unit_id: str, cmd: str, mode: str | None = None,
                 on: bool | None = None) -> dict:
    """Comandos OEM extra (two-way): mode / defrost / power."""
    mod = _control_mod(unit_id)
    if mod is None:
        return dict(_NO_OEM)
    cmd = (cmd or "").lower()
    if cmd == "mode" and mode is not None:
        return await mod.set_mode(unit_id, mode)
    if cmd == "defrost":
        return await mod.initiate_defrost(unit_id)
    if cmd == "power" and on is not None:
        return await mod.set_power(unit_id, on)
    return {"ok": False, "detail": "Unknown reefer command"}
