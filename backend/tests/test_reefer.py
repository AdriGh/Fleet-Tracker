# -*- coding: utf-8 -*-
"""Tests del simulador de Cold Chain (v2.12).

`python backend/tests/test_reefer.py`. Funciones puras: sin DB ni red.

Lo que se protege acá es justo lo que estaba roto:
  - la foto y el historial salían de DOS generadores distintos, así que los
    gráficos MENTÍAN (la tabla marcaba una unidad a 78.9 F en rojo mientras su
    sparkline estaba plana en 55);
  - las alarmas eran literales fijos que podían contradecir los números;
  - los reefers demo tenían números de unidad que no existían en la flota;
  - y el pipeline alarma -> work order (el diferenciador) estaba bloqueado en
    demo, con el riesgo de que destrabarlo genere WOs falsas en producción.
"""
import asyncio
import os
import sys
import time
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

os.environ["FLEET_SKIP_DB_INIT"] = "1"
os.environ["FLEET_DEMO"] = "1"

from app import config                              # noqa: E402
from app.core import demo_eld, reefer               # noqa: E402

TS = 1_780_000_000.0        # instante fijo para los tests deterministas


def test_units_come_from_the_fleet():
    """Los reefers del Cold Chain son trailers REALES de la flota demo. Antes
    eran números inventados (53218, R1904…) que no existían en ningún lado, así
    que la tarjeta de reefer del perfil de unidad no aparecía nunca."""
    fleet_reefers = set(demo_eld.reefer_units())
    assert fleet_reefers, "la flota demo no tiene trailers reefer"
    units = {u["unit"] for u in reefer.demo_units()}
    assert units == fleet_reefers, (units, fleet_reefers)
    # Y esos trailers están en la flota con subtipo 'reefer'.
    sub = {u["unit"]: u.get("subtype") for u in demo_eld.fleet()}
    for u in units:
        assert sub.get(u) == "reefer", (u, sub.get(u))
    print(f"OK {len(units)} reefers, todos trailers de la flota: {sorted(units)}")


def test_snapshot_and_history_agree():
    """EL bug: foto y gráfico salen del MISMO generador, así que el último
    punto del historial es exactamente lo que muestra la tabla."""
    for u in reefer.demo_units():
        pts = reefer.demo_history(u["id"], 24)
        assert len(pts) == 25, len(pts)
        last = pts[-1]
        assert abs(last["return_f"] - u["return_f"]) <= 0.5, (
            f"{u['unit']}: tabla={u['return_f']} vs gráfico={last['return_f']}")
        assert last["setpoint_f"] == u["setpoint_f"]
    print("OK la foto y el historial coinciden (antes se contradecían)")


def test_deterministic_and_time_driven():
    s1 = reefer._state_at("53108", TS)
    s2 = reefer._state_at("53108", TS)
    assert s1 == s2, "no es determinístico"
    # Pero SÍ cambia con el tiempo (antes era una foto congelada).
    vals = {reefer._state_at("53108", TS + h * 900)["return_f"]
            for h in range(16)}
    assert len(vals) > 6, f"apenas varía con el tiempo: {vals}"
    print(f"OK determinístico y vivo ({len(vals)} valores distintos en 4 h)")


def test_events_show_up_over_24h():
    """En 24 h se ven los eventos del simulador: defrost, puerta y excursión."""
    hist = {u["unit"]: reefer.demo_history(u["id"], 24)
            for u in reefer.demo_units()}
    for unit, pts in hist.items():
        rng = max(p["return_f"] for p in pts) - min(p["return_f"] for p in pts)
        assert rng > 1.5, f"{unit}: la serie es casi plana ({rng:.1f} F)"
    # La unidad con perfil de excursión es la que más se despega del setpoint.
    worst = max(hist.items(),
                key=lambda kv: max(abs(p["return_f"] - p["setpoint_f"])
                                   for p in kv[1]))
    assert worst[0] == "7846", worst[0]
    print("OK se ven defrost / puerta / excursión en la serie de 24 h")


def test_alarms_derive_from_state():
    """Las alarmas salen del estado real, no de literales fijos: si hay
    desvío grande hay alarma, y si está en rango no la hay."""
    now = time.time()
    peak = max((reefer._state_at("7846", now + s) for s in range(0, 21600, 300)),
               key=lambda s: abs(s["return_f"] - s["setpoint_f"]))
    dev = abs(peak["return_f"] - peak["setpoint_f"])
    assert dev > 8.0, dev
    codes = {a["code"] for a in peak["alarms"]}
    assert 25501 in codes, f"sin alarma de desvío con {dev:.1f} F: {codes}"
    assert any(a["severity"] >= 3 for a in peak["alarms"]), peak["alarms"]

    # Una unidad estable, en su momento más cercano al setpoint, no debe
    # inventar una alarma de desvío.
    calm = min((reefer._state_at("53108", now + s) for s in range(0, 21600, 300)),
               key=lambda s: abs(s["return_f"] - s["setpoint_f"]))
    assert 25501 not in {a["code"] for a in calm["alarms"]}, calm["alarms"]
    print(f"OK alarmas derivadas del estado (pico {dev:.1f} F -> alarma; en rango -> ninguna)")


def test_demo_control_moves_the_simulator():
    """El control two-way en demo mueve el simulador; antes el POST siempre
    devolvía 400 y esa UI era irrevisable sin credenciales OEM."""
    unit = demo_eld.reefer_units()[0]
    uid = f"demo-{unit}"
    before = reefer._state_at(unit, TS)["setpoint_f"]
    try:
        r = asyncio.run(reefer.set_setpoint(uid, before + 7.0))
        assert r["ok"] and r.get("demo"), r
        after = reefer._state_at(unit, TS)["setpoint_f"]
        assert after == before + 7.0, (before, after)
        # Y el historial refleja el setpoint nuevo (sale del mismo generador).
        assert reefer.demo_history(uid, 3)[-1]["setpoint_f"] == before + 7.0
        # Las unidades demo se declaran controlables para que la UI se renderice.
        assert all(u["can_control"] for u in reefer.demo_units())
    finally:
        reefer._setpoint_override.pop(unit, None)
    print("OK el setpoint desde la UI mueve el simulador")


def test_rules_gate_on_explicit_demo_only():
    """El gate de seguridad: las reglas corren sobre el simulador SOLO con
    FLEET_DEMO=1 explícito. El fallback a demo por falta de credenciales
    (que puede pasar por accidente en producción) no dispara nada."""
    original = config.DEMO_ELD
    try:
        config.DEMO_ELD = True
        assert reefer.demo_evaluation_enabled() is True
        config.DEMO_ELD = False
        assert reefer.demo_evaluation_enabled() is False
    finally:
        config.DEMO_ELD = original
    print("OK las reglas solo corren sobre demo con FLEET_DEMO=1 explícito")


def test_units_have_map_and_source_fields():
    """Traen lat/lng y `source`, que les faltaban: sin eso los reefers no
    podían aparecer nunca en el mapa."""
    for u in reefer.demo_units():
        assert u["lat"] and u["lng"], u["unit"]
        assert u["source"] == "demo" and u["demo"] is True
        assert u["company"] == "SUMMIT FREIGHT", u["company"]
    print("OK los reefers demo traen posición, source y la empresa de la flota")


if __name__ == "__main__":
    test_units_come_from_the_fleet()
    test_snapshot_and_history_agree()
    test_deterministic_and_time_driven()
    test_events_show_up_over_24h()
    test_alarms_derive_from_state()
    test_demo_control_moves_the_simulator()
    test_rules_gate_on_explicit_demo_only()
    test_units_have_map_and_source_fields()
    print("\nALL REEFER SIMULATOR TESTS PASSED")
