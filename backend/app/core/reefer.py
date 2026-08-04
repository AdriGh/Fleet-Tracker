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

from .. import config
from . import demo_eld, lynx, thermoking, traccar


def demo_evaluation_enabled() -> bool:
    """¿Las reglas (alerta de temperatura y el puente reefer -> work order)
    pueden correr sobre el SIMULADOR?

    Solo si el modo demo se pidió EXPLÍCITAMENTE con `FLEET_DEMO=1`, o sea que
    hay intención de desarrollo. El fallback automático a demo —cuando
    simplemente no hay credenciales configuradas— NO habilita nada: eso puede
    pasar por accidente en producción (un secret que no cargó), y ahí generar
    alertas o work orders falsas sería peor que no mostrar nada.

    Sin esto, el diferenciador del producto (falla del reefer -> WO automática)
    era justo lo único que no se podía ver ni probar en local."""
    return bool(config.DEMO_ELD)

# Fuentes reales en orden de prioridad (módulo, etiqueta de `source`).
_SOURCES = ((lynx, "lynx"), (thermoking, "thermoking"), (traccar, "traccar"))

# Control remoto: prefijo del id -> módulo OEM que lo ejecuta (two-way).
_CONTROL_MODS = (("lynx-", lynx), ("tk-", thermoking))


# ----- Demo: SIMULADOR determinista -------------------------------------
#
# DISENO: hay UNA sola funcion (`_state_at`) que devuelve el estado fisico del
# reefer en un instante dado. La foto la llama con t = ahora; el historial la
# llama con t = ahora - i horas. Por construccion, la tabla y el chart NO se
# pueden contradecir.
#
# Antes eran DOS generadores independientes: `demo_units` calculaba
# `setpoint + drift` (constante) y `demo_history` calculaba
# `setpoint + wave + defrost`. Resultado: la tabla marcaba una unidad a 78.9 °F
# en rojo mientras su sparkline estaba plana en 55 — los graficos mentian.
#
# Ademas todo es funcion del RELOJ, asi que el refresco de 60 s del front de
# verdad muestra algo nuevo: ciclos de frio, defrost cada 8 h, aperturas de
# puerta, una excursion de temperatura que se desarrolla y se recupera, y
# combustible que baja. Sin RNG: es matematica pura del timestamp, o sea
# determinista y reproducible en los tests.

_COMPANY = "SUMMIT FREIGHT"
_DAY_S = 86400.0
_DEFROST_PERIOD_S = 8 * 3600.0      # un defrost cada 8 h
_DEFROST_LEN_S = 1800.0             # que dura ~30 min

# Config por unidad: (setpoint_f, modo, perfil, lat, lng, lugar).
# El `perfil` decide que le pasa a esa unidad a lo largo del tiempo:
#   stable    -> ciclo de frio normal
#   door      -> aperturas de puerta periodicas (sube la temperatura)
#   excursion -> se sale de rango y se recupera, con un fault code OEM: es el
#                caso que ejercita alarma -> work order (el diferenciador)
_DEMO_CFG: dict[str, tuple] = {
    "53108": (-10.0, "Continuous", "stable", 32.7767, -96.7970, "Dallas, TX"),
    "53112": (35.0, "Start-Stop", "stable", 33.7490, -84.3880, "Atlanta, GA"),
    "7841": (34.0, "Continuous", "door", 41.8781, -87.6298, "Chicago, IL"),
    "7846": (38.0, "Continuous", "excursion", 29.7604, -95.3698, "Houston, TX"),
}

# Setpoints cambiados desde la UI (control two-way en demo). En memoria: el
# simulador no persiste, pero alcanza para ver que el comando surte efecto.
_setpoint_override: dict[str, float] = {}


def _phase(unit: str) -> float:
    """Desfase estable por unidad (0..1) para que no vayan todas sincronizadas."""
    return (sum(ord(c) for c in unit) % 97) / 97.0


def _demo_cfg(unit: str) -> tuple:
    return _DEMO_CFG.get(unit, (35.0, "Continuous", "stable",
                                32.7767, -96.7970, "Dallas, TX"))


def _state_at(unit: str, ts: float) -> dict:
    """Estado fisico del reefer `unit` en el instante `ts` (epoch segundos).

    UNICA fuente de verdad del demo: la usan tanto la foto como el historial."""
    sp_base, mode, profile, lat, lng, place = _demo_cfg(unit)
    sp = _setpoint_override.get(unit, sp_base)
    ph = _phase(unit)

    # Ambiente: ciclo diario (pico a la tarde).
    tod = (ts % _DAY_S) / _DAY_S
    ambient = 72.0 + 14.0 * math.sin((tod - 0.30) * 2 * math.pi) + 6.0 * ph

    # Ciclo de refrigeracion alrededor del setpoint (~15 min). Start-Stop
    # oscila mas que Continuous, como en la realidad.
    swing = 2.6 if mode == "Start-Stop" else 1.2
    cycle = math.sin(ts / 900.0 + ph * 6.2832)
    ret = sp + swing * cycle

    # Defrost cada 8 h: sube la temperatura ~30 min y vuelve.
    dfr = (ts + ph * _DEFROST_PERIOD_S) % _DEFROST_PERIOD_S
    defrosting = dfr < _DEFROST_LEN_S
    if defrosting:
        ret += 7.5 * math.sin(math.pi * dfr / _DEFROST_LEN_S)

    # Puerta: aperturas de 12 min cada 3 h (solo el perfil 'door').
    door = "Closed"
    if profile == "door":
        dp = (ts + ph * 10800.0) % 10800.0
        if dp < 720.0:
            door = "Open"
            ret += 9.0 * (dp / 720.0)

    # Excursion: ciclo de 6 h con 2 h fuera de rango. Se puede VER como se
    # desarrolla y como se recupera (y la alarma aparece y desaparece).
    excursion = False
    if profile == "excursion":
        ep = (ts + ph * 21600.0) % 21600.0
        if ep < 7200.0:
            excursion = True
            ret += 13.0 * math.sin(math.pi * ep / 7200.0)

    supply = ret - (1.5 + 0.9 * abs(cycle))

    # Combustible: baja a lo largo de ~5 dias y se reposta.
    fuel = int(round(96 - 80 * (((ts + ph * 5 * _DAY_S) % (5 * _DAY_S))
                                / (5 * _DAY_S))))
    state = "On"

    # ---- Alarmas DERIVADAS del estado ----
    # Antes eran literales fijos, asi que podian contradecir los numeros (una
    # unidad "no esta corriendo" con temperatura perfecta). Ahora salen de lo
    # que de verdad esta pasando.
    alarms: list[dict] = []
    if excursion:
        # Fault code OEM: la unidad fallo, POR ESO sube la temperatura. Con
        # severidad 3 cruza el umbral del puente reefer -> work order.
        alarms.append({
            "code": 25502, "description": "Failed To Start - Auto Mode",
            "severity": 3, "operator_action": "Take immediate action"})
    dev = ret - sp
    if abs(dev) > 8.0:
        alarms.append({
            "code": 25501,
            "description": f"Temperature deviation {dev:+.1f} F from setpoint",
            "severity": 3 if abs(dev) > 12.0 else 2,
            "operator_action": "Check load and unit"})
    if door == "Open":
        alarms.append({
            "code": 40, "description": "Door open while cooling",
            "severity": 2, "operator_action": "Close door"})
    if fuel < 20:
        alarms.append({
            "code": 16, "description": "Fuel level low",
            "severity": 1, "operator_action": "OK to run"})

    return {
        "id": f"demo-{unit}",
        "unit": unit,
        "company": _COMPANY,
        "setpoint_f": round(sp, 1),
        "return_f": round(ret, 1),
        "supply_f": round(supply, 1),
        "ambient_f": round(ambient, 1),
        "run_mode": ("Defrost" if defrosting else mode),
        "state": state,
        "fuel_pct": max(2, min(100, fuel)),
        "door": door,
        "alarms": alarms,
        "lat": lat,
        "lng": lng,
        "location": place,
        "source": "demo",
        "can_control": True,     # en demo el control mueve el simulador
        "updated": datetime.fromtimestamp(ts, timezone.utc).isoformat(),
        "demo": True,
    }


def demo_units() -> list[dict]:
    """Foto de todos los reefers demo AHORA. Las unidades salen de la flota
    demo (`demo_eld.reefer_units`), no de una lista propia."""
    now = datetime.now(timezone.utc).timestamp()
    return [_state_at(u, now) for u in demo_eld.reefer_units()]


def demo_history(unit_id: str, hours: int = 24) -> list[dict]:
    """Serie horaria del MISMO simulador que la foto (por eso coinciden).

    El último punto es AHORA (no el tope de la hora), así el final del gráfico
    coincide exactamente con el número que muestra la tabla."""
    unit = unit_id[5:] if unit_id.startswith("demo-") else unit_id
    now = datetime.now(timezone.utc).timestamp()
    out = []
    for i in range(hours, -1, -1):
        ts = now - i * 3600.0
        s = _state_at(unit, ts)
        out.append({
            "time": datetime.fromtimestamp(ts, timezone.utc).isoformat(),
            "setpoint_f": s["setpoint_f"],
            "return_f": s["return_f"],
            "supply_f": s["supply_f"],
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

    # Sin fuente real: simulador etiquetado. `demo_explicit` distingue el modo
    # demo PEDIDO (FLEET_DEMO=1, banco de pruebas local) del fallback por falta
    # de credenciales — que puede pasar por accidente en producción. El front
    # lo usa para decidir si muestra el panel del Dashboard.
    return {"available": True, "demo": True, "source": "demo",
            "demo_explicit": demo_evaluation_enabled(),
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
    """Cambia el setpoint REAL del reefer vía su API OEM (two-way).

    En demo mueve el simulador: sin esto el botón siempre devolvía 400 y la UI
    de control era irrevisable sin credenciales OEM."""
    if unit_id.startswith("demo-"):
        unit = unit_id[5:]
        _setpoint_override[unit] = float(setpoint_f)
        return {"ok": True, "demo": True, "unit": unit,
                "setpoint_f": float(setpoint_f),
                "detail": "Setpoint applied to the demo simulator"}
    mod = _control_mod(unit_id)
    if mod is None:
        return dict(_NO_OEM)
    return await mod.set_setpoint(unit_id, setpoint_f)


async def command(unit_id: str, cmd: str, mode: str | None = None,
                 on: bool | None = None) -> dict:
    """Comandos OEM extra (two-way): mode / defrost / power."""
    cmd = (cmd or "").lower()
    if unit_id.startswith("demo-"):
        # El simulador acepta el comando y lo refleja; 'defrost' y 'power' no
        # se modelan (el ciclo de defrost es automático cada 8 h).
        if cmd in ("mode", "defrost", "power"):
            return {"ok": True, "demo": True,
                    "detail": f"Command '{cmd}' accepted by the demo simulator"}
        return {"ok": False, "detail": "Unknown reefer command"}
    mod = _control_mod(unit_id)
    if mod is None:
        return dict(_NO_OEM)
    if cmd == "mode" and mode is not None:
        return await mod.set_mode(unit_id, mode)
    if cmd == "defrost":
        return await mod.initiate_defrost(unit_id)
    if cmd == "power" and on is not None:
        return await mod.set_power(unit_id, on)
    return {"ok": False, "detail": "Unknown reefer command"}
