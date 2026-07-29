# -*- coding: utf-8 -*-
"""Tests del simulador de ELD demo (v2.10).

`python backend/tests/test_demo_eld.py`. No toca la base: son funciones puras.

Cubre lo que hace que el demo sea un SIMULADOR y no una foto:
  - el odómetro ACUMULA y es determinístico;
  - `day_distance` y el odómetro salen de la MISMA fuente (no se contradicen);
  - los estados de PM se mantienen (on_track/upcoming/overdue/never) aunque el
    odómetro crezca — es decir, no se podren con el paso del tiempo real;
  - los pre-trips traen post-trip y casos cortos, y correlacionan con los DVIR;
  - el mapa se mueve y las duraciones crecen.
"""
import datetime as dt
import os
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

os.environ["FLEET_SKIP_DB_INIT"] = "1"      # el simulador no necesita DB

from app.core import demo_eld as d              # noqa: E402
from app.core.contacts import name_key          # noqa: E402

PM_INTERVAL = 20000        # org_config "pm_interval_miles" por defecto
UPCOMING = 5500            # umbral de "upcoming" del dashboard


def test_odometer_accumulates_and_is_deterministic():
    today = dt.date.today()
    for unit in d.units():
        a = d.odometer_at(unit, today - dt.timedelta(days=30))
        b = d.odometer_at(unit, today)
        assert b > a, f"{unit}: el odómetro no creció en 30 días"
        # Determinístico: misma entrada, mismo valor.
        assert d.odometer_at(unit, today) == b, f"{unit}: no determinístico"
    # Antes del epoch se devuelve la base (no hay millaje que acumular).
    assert d.odometer_at("412", d._EPOCH - dt.timedelta(days=1)) == d._ODO_BASE["412"]
    print("OK odómetro acumula + determinístico + base antes del epoch")


def test_distance_matches_odometer_delta():
    """La coherencia que antes no existía: las millas del día reportadas por
    `day_distance` son EXACTAMENTE el salto del odómetro de ese día."""
    today = dt.date.today()
    for day in (today, today - dt.timedelta(days=3),
                today - dt.timedelta(days=17)):
        dist = d.day_distance(None, day)
        for unit, miles in dist.items():
            delta = d.odometer_at(unit, day) - d.odometer_at(
                unit, day - dt.timedelta(days=1))
            # El odómetro se guarda como entero, así que hay ±1 de redondeo.
            assert abs(delta - miles) <= 1, (
                f"{unit} {day}: day_distance={miles} vs delta odómetro={delta}")
    print("OK day_distance == salto del odómetro (misma fuente)")


def test_weekend_is_slower():
    """El domingo se rueda mucho menos que un día laboral (realismo)."""
    # Busca el domingo y el miércoles de una misma semana reciente.
    day = dt.date.today()
    while day.weekday() != 6:
        day -= dt.timedelta(days=1)
    sunday, wednesday = day, day - dt.timedelta(days=4)
    assert wednesday.weekday() == 2
    tot_sun = sum(d.day_distance(None, sunday).values())
    tot_wed = sum(d.day_distance(None, wednesday).values())
    assert tot_sun < tot_wed * 0.6, (
        f"domingo ({tot_sun:.0f} mi) debería ser mucho menor que "
        f"miércoles ({tot_wed:.0f} mi)")
    print("OK el fin de semana rueda menos")


def test_pm_status_distribution_holds():
    """El PM es relativo a hoy, así que la distribución de estados se mantiene
    aunque el odómetro haya crecido meses. Antes eran fechas/millas absolutas
    y los estados se podrían con el tiempo."""
    buckets = {"on_track": 0, "upcoming": 0, "overdue": 0, "never": 0}
    for r in d.pm_rows():
        if r["last_pm_miles"] is None:
            buckets["never"] += 1
            continue
        remaining = (r["last_pm_miles"] + PM_INTERVAL) - r["report_miles"]
        if remaining < 0:
            buckets["overdue"] += 1
        elif remaining <= UPCOMING:
            buckets["upcoming"] += 1
        else:
            buckets["on_track"] += 1
        # El odómetro reportado es el de hoy, y el PM quedó atrás.
        assert r["report_miles"] > r["last_pm_miles"]
    assert buckets == {"on_track": 3, "upcoming": 3, "overdue": 2, "never": 2}, buckets
    print("OK PM mantiene 3 on_track / 3 upcoming / 2 overdue / 2 never:", buckets)


def test_pretrip_depth_and_correlation():
    today = dt.date.today()
    pt = d.pretrip(None, today)
    assert pt, "no hay pre-trips"
    # Hay post-trips reales (antes SIEMPRE era None => 'NO POST-TRIP' imposible).
    assert any(v["post"] for v in pt.values()), "ningún post-trip"
    # Y también faltantes, para poder ver el estado 'NO POST-TRIP'.
    assert any(v["post"] is None for v in pt.values()), "todos tienen post"
    assert all(v["pre"] > 0 for v in pt.values())
    # Correlación con los DVIR: el que firmó el DVIR es de la misma asignación
    # del día, así que casi todos los autores tienen su pre-trip.
    authors = {name_key(r["Author"]) for r in d.dvir_rows(None, today)
               if r["Author"]}
    assert authors, "sin autores de DVIR"
    overlap = len(authors & set(pt)) / len(authors)
    assert overlap >= 0.7, f"correlación DVIR/pre-trip baja: {overlap:.0%}"
    # `company` se respeta (antes se ignoraba): otra empresa => sin pre-trips.
    assert d.pretrip("EMPRESA QUE NO EXISTE", today) == {}
    print(f"OK pre-trip con post + faltantes + correlación {overlap:.0%}")


def test_map_moves_and_durations_grow():
    p1 = d.map_payload()
    v1 = {v["unit"]: v for v in p1["vehicles"]}
    assert p1["vehicles"], "mapa vacío"
    # Hay unidades en movimiento, con rumbo y velocidad reales.
    movers = [v for v in v1.values() if (v["speed_mph"] or 0) > 1]
    assert movers, "ninguna unidade en movimiento"
    for v in movers:
        assert v["moving_for_s"] and v["moving_for_s"] > 0
        assert 0 <= v["heading"] <= 359
        assert v["odometer_mi"] and v["odometer_mi"] > 0
    # Al menos una unidad idle con duración creciente (para umbrales de alerta).
    idlers = [v for v in v1.values() if v["idle_for_s"]]
    assert idlers, "ninguna unidad idle con duración"
    # Y una unidad STALE (GPS viejo) sin duraciones, como en el camino real.
    stale = [v for v in v1.values() if v["stale"]]
    assert len(stale) == 1, f"se esperaba 1 unidad stale, hay {len(stale)}"
    assert stale[0]["moving_for_s"] is None and stale[0]["idle_for_s"] is None
    # El summary sigue cuadrando con la flota.
    assert p1["summary"]["vehicles"] == len(p1["vehicles"])
    print("OK mapa: movimiento + rumbo + idle creciente + 1 stale")


def test_fleet_and_defect_ids_match():
    """El asset_id de un defecto de trailer tiene que ser el MISMO que el de
    fleet() — si no, el filtro de unidades archivadas no lo reconoce."""
    ids = {u["unit"]: u["id"] for u in d.fleet()}
    for row in d.open_defects():
        assert row["asset_id"] == ids[row["unit"]], (
            f"{row['unit']}: defecto {row['asset_id']} vs fleet {ids[row['unit']]}")
    # Los trailers traen subtipo (incluye reefers, para cadena de frío).
    subs = {u["unit"]: u.get("subtype") for u in d.fleet()
            if u["kind"] == "trailer"}
    assert any(s == "reefer" for s in subs.values()), subs
    print("OK asset_id de defectos == fleet, y hay trailers reefer")


if __name__ == "__main__":
    test_odometer_accumulates_and_is_deterministic()
    test_distance_matches_odometer_delta()
    test_weekend_is_slower()
    test_pm_status_distribution_holds()
    test_pretrip_depth_and_correlation()
    test_map_moves_and_durations_grow()
    test_fleet_and_defect_ids_match()
    print("\nALL DEMO ELD TESTS PASSED")
