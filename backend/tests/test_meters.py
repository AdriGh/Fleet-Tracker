# -*- coding: utf-8 -*-
"""Tests del horómetro (engine hours) + PM del reefer por horas (v2.22).

`python backend/tests/test_meters.py`. DB SQLite temporal fresca. Samsara,
el feed del reefer, el feed de defectos y GET /fleet se reemplazan por
fakes (sin red, sin depender de la config local).

Lo que NO hay que perder (benchmark SquareRigger, que vence las horas
contra el ODÓMETRO):
  - las horas viven en meter_reading y JAMÁS entran al odómetro / CPM;
  - log_reading: mismo día + fuente = corrección; fecha futura, valor no
    positivo, más de 5 % por debajo de la anterior o más de 24 h/día se
    rechazan salvo force; unidades normalizadas ('TRL 9' == 'trl9');
  - eval_due 'hours': vence lo que llegue PRIMERO (horas o días), status =
    el peor, due_by = el que vence primero, sin horómetro => solo días
    (meter_missing), horómetro reseteado => solo días;
  - universo del board del reefer: subtipo reefer (flota / manual) ∪ feed
    del reefer ∪ unidades con horas ∪ registros ∪ opt-in, menos opt-out; el
    feed DEMO no cuenta fuera de demo; errores de flota en `errors`;
  - unit_campaigns: reefer automática (auto) + current_hours*, opt-in/out;
  - add_record(hours) registra la lectura 'maint'; sin horas toma la del
    horómetro de ese día;
  - GET /api/maint/due: pm + dot + reefer, vencidos primero, unidades;
  - Service Requests: fuente 'reefer' (clave por horas del último PM, meta
    kind 'hours', días de respaldo sin horómetro), create_wo/add_to_wo copian
    las horas a la WO y al facturar se registra el PM con esas horas; una WO
    con DOT + reefer registra AMBAS campañas;
  - WorkOrder.engine_hours (create/patch, 0 borra, inválido => error) y su
    lectura 'wo';
  - parsers de feed (Traccar ms -> h, Lynx por _pick), simulador demo y
    estados demo estables; aislamiento por tenant.
"""
import asyncio
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

_TMP = Path(tempfile.mkdtemp())
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP / 'meters_test.db'}"
os.environ.pop("FLEET_DEMO", None)

from sqlalchemy import select                            # noqa: E402

from app import db                                       # noqa: E402
from app.core import (                                   # noqa: E402
    demo_eld, fleet_inventory, lynx, maint, manual_units, meters, odometer,
    open_defects, org_config, pm, reefer, samsara, service_requests as sr,
    tenant, traccar, wo_invoices, workorders,
)

ORG = db.default_org_id()
tenant.set_current_org(ORG)
wo_invoices.UPLOADS_DIR = _TMP / "wo_invoices"

TODAY = org_config.org_today()


def _d(offset: int) -> str:
    return (TODAY + timedelta(days=offset)).isoformat()


# ----- Fakes (sin red) -------------------------------------------------------

FAKE: dict = {
    "fleet": [
        {"unit": "TRL 100", "subtype": "reefer", "unit_type": "trailer",
         "year": "2020", "make": "Utility", "model": "3000R"},
        {"unit": "T1", "subtype": "", "unit_type": "truck",
         "year": "2021", "make": "Freightliner", "model": "Cascadia"},
    ],
    "feed": {"available": True, "demo": False, "source": "lynx",
             "units": [{"unit": "TRL 200", "engine_hours": 5000.0,
                        "source": "lynx"}]},
    "fleet_error": False,
    "demo": False,
}


async def _fake_list_fleet(*a, **k):
    if FAKE["fleet_error"]:
        raise RuntimeError("samsara down")
    return [dict(u) for u in FAKE["fleet"]]


async def _fake_odometers():
    return {}


async def _fake_load_live():
    return FAKE["feed"]


async def _fake_defects(refresh: bool = False):
    return {"available": True, "source": "samsara", "defects": []}


async def _fake_fleet_inventory(refresh: bool = False):
    units = [{"id": f"f-{i}", "unit": u["unit"]}
             for i, u in enumerate(FAKE["fleet"])]
    units += [{"id": f"m-{u['id']}", "unit": u["unit"]}
              for u in manual_units.list_units()]
    return {"available": True, "source": "samsara", "units": units}


samsara._demo = lambda: FAKE["demo"]
samsara.is_available = lambda: True
samsara.list_fleet = _fake_list_fleet
samsara.vehicle_odometers = _fake_odometers
reefer.load_live = _fake_load_live
open_defects.current_feed = _fake_defects
fleet_inventory.load = _fake_fleet_inventory
pm.load = lambda: []                 # sin CSV de Fullbay local


def _raises(fn, *args, contains: str = "", **kw) -> str:
    try:
        fn(*args, **kw)
    except ValueError as exc:
        assert contains in str(exc), f"mensaje inesperado: {exc}"
        return str(exc)
    raise AssertionError(f"{fn.__name__} debió lanzar ValueError")


def _board() -> dict:
    meters.clear_cache()
    return asyncio.run(maint.board("reefer"))


def _row(board: dict, unit: str) -> dict | None:
    return next((r for r in board["units"] if r["unit"] == unit), None)


# ----- Tests -----------------------------------------------------------------

def test_log_reading_rules():
    r1 = meters.log_reading("TRL 9", 1000, _d(-10))
    assert r1["value"] == 1000.0 and r1["source"] == "manual"
    # Mismo día + fuente = corrección (misma fila).
    r2 = meters.log_reading("TRL 9", 1005, _d(-10))
    assert r2["id"] == r1["id"] and r2["value"] == 1005.0
    # Normalizada: 'trl9' es la misma unidad.
    meters.log_reading("trl9", 1100, _d(-5))
    assert meters.latest("TRL 9") == {"value": 1100.0, "date": _d(-5),
                                      "source": "manual"}
    # Más de 5 % por debajo de la anterior.
    _raises(meters.log_reading, "TRL 9", 1000, _d(0),
            contains="lower than the previous reading")
    # Más de 24 h por día transcurrido (5 días => 120 h máx).
    _raises(meters.log_reading, "TRL 9", 1100 + 121, _d(0),
            contains="more than 120 hrs in 5 day(s)")
    meters.log_reading("TRL 9", 1200, _d(0))
    # Con fecha vieja y más alta que una posterior.
    meters.log_reading("NXT 1", 100, _d(-1))
    _raises(meters.log_reading, "NXT 1", 200, _d(-5),
            contains="higher than a later reading")
    # Validaciones de entrada.
    _raises(meters.log_reading, "TRL 9", 1300, _d(1),
            contains="future")
    _raises(meters.log_reading, "TRL 9", 1300, "10/09/2026",
            contains="YYYY-MM-DD")
    for bad in (0, -3, "abc", None, 250_000):
        _raises(meters.log_reading, "TRL 9", bad, contains="engine hours")
    _raises(meters.log_reading, "", 10, contains="unit is required")
    _raises(meters.log_reading, "TRL 9", 10, meter="fuel",
            contains="unknown meter")
    # force: horómetro reseteado (controlador cambiado).
    meters.log_reading("RST 1", 5000, _d(-3))
    _raises(meters.log_reading, "RST 1", 40, _d(-1), contains="lower")
    meters.log_reading("RST 1", 40, _d(-1), force=True)
    assert meters.latest("RST 1")["value"] == 40.0
    # Fecha vacía = hoy (zona de la org).
    meters.log_reading("RST 1", 52)
    assert meters.latest("RST 1") == {"value": 52.0, "date": _d(0),
                                      "source": "manual"}

    got = meters.unit_readings("TRL 9")
    assert got["count"] == 3 and got["latest"]["value"] == 1200.0
    assert [x["date"] for x in got["readings"]] == [_d(0), _d(-5), _d(-10)]
    allv = meters.latest_all()
    assert allv["TRL9"]["value"] == 1200.0 and allv["RST1"]["value"] == 52.0
    assert meters.value_at("TRL 9", _d(-6)) == 1005.0
    assert meters.value_at("TRL 9", _d(-60)) is None
    # JAMÁS en el odómetro / CPM (el error de SquareRigger).
    with db.SessionLocal() as s:
        assert not s.scalars(select(db.OdometerReading)).all()
    assert "TRL 9" not in odometer.miles_by_unit(None, None)
    assert meters.norm_unit(" trl\t9 ") == sr._norm_unit(" trl\t9 ")
    print("OK log_reading: corrección, normalización, plausibilidad, force")


def test_eval_due_hours():
    cfg = maint.due_config("reefer")
    assert cfg == {"interval_hours": 1500, "upcoming_hours": 150,
                   "interval_days": 365, "upcoming_days": 30}, cfg
    t = TODAY

    def ev(last_off, last_h, cur):
        last = (t + timedelta(days=last_off)).isoformat() \
            if last_off is not None else None
        return maint.eval_due("hours", last, last_h, cur, t, cfg)

    e = ev(None, None, 1000)
    assert e["status"] == "never" and e["due_by"] is None
    # Horas primero: faltan 100 h (upcoming) y 265 días.
    e = ev(-100, 1000, 2400)
    assert (e["status"], e["due_by"], e["to_due"], e["to_due_days"]) == (
        "upcoming", "hours", 100.0, 265), e
    assert e["next_due_hours"] == 2500.0 and not e["meter_missing"]
    # Fecha primero: horas al día pero 370 días desde el último PM.
    e = ev(-370, 1000, 1200)
    assert (e["status"], e["due_by"], e["to_due"], e["to_due_days"]) == (
        "overdue", "days", 1300.0, -5), e
    # Sin horómetro: solo días (no se inventa nada con el odómetro).
    e = ev(-350, 1000, None)
    assert (e["status"], e["due_by"], e["to_due"], e["meter_missing"]) == (
        "upcoming", "days", None, True), e
    # Los dos vencidos: el más urgente en ventanas (-300h/150 vs -10d/30).
    e = ev(-375, 1000, 2800)
    assert (e["status"], e["due_by"]) == ("overdue", "hours"), e
    # Horómetro reseteado (debajo del último PM): solo días.
    e = ev(-10, 1000, 500)
    assert e["meter_reset"] and e["due_by"] == "days" and e["to_due"] is None
    # Último PM sin horas: solo días.
    e = ev(-10, None, 900)
    assert e["next_due_hours"] is None and e["due_by"] == "days"
    # Umbrales editables desde Settings (org_config.thresholds).
    org_config.save({"thresholds": {"reefer_pm_interval_hours": 1000}})
    try:
        assert maint.due_config("reefer")["interval_hours"] == 1000
    finally:
        org_config.save({"thresholds": {"reefer_pm_interval_hours": 1500}})
    print("OK eval_due horas: lo que llegue primero, sin horómetro => días")


def test_reefer_board_universe():
    manual_units.add({"unit": "TRL 300", "unit_type": "trailer",
                      "subtype": "Reefer 53'", "year": "2019",
                      "make": "Wabash", "model": "Arcticlite"})
    manual_units.add({"unit": "TRL 600", "unit_type": "trailer",
                      "subtype": "reefer"})
    from app.core import unit_settings
    unit_settings.set_campaign("TRL 500", "reefer", True)
    unit_settings.set_campaign("TRL 600", "reefer", False, opt_out=True)
    meters.log_reading("TRL 400", 800, _d(-1))
    meters.log_reading("TRL 100", 2400, _d(0))
    maint.add_record("TRL100", "reefer", _d(-100), hours=1000)
    assert asyncio.run(meters.snapshot_now()) == 1      # TRL 200 (lynx)
    assert meters.latest("TRL 200") == {"value": 5000.0, "date": _d(0),
                                        "source": "lynx"}

    b = _board()
    units = {r["unit"] for r in b["units"]}
    for u in ("TRL 100", "TRL 200", "TRL 300", "TRL 400", "TRL 500"):
        assert u in units, (u, units)
    assert "T1" not in units, "un camión sin reefer no entra"
    assert "TRL 600" not in units, "opt-out explícito"
    assert "TRL100" not in units, "registro con otra grafía = misma fila"
    assert (b["interval_hours"], b["upcoming_hours"], b["interval_days"],
            b["upcoming_days"], b["errors"]) == (1500, 150, 365, 30, [])
    r100 = _row(b, "TRL 100")
    assert (r100["status"], r100["due_by"], r100["to_due"],
            r100["current_hours"], r100["last_hours"]) == (
        "upcoming", "hours", 100.0, 2400.0, 1000.0), r100
    assert r100["model"] == "2020 Utility 3000R"
    assert r100["current_miles"] is None, "el reefer no usa millas"
    r200 = _row(b, "TRL 200")
    assert r200["status"] == "never"
    assert r200["current_hours_source"] == "lynx"
    r300 = _row(b, "TRL 300")
    assert r300["meter_missing"] and r300["model"] == "2019 Wabash Arcticlite"
    # Orden: el más urgente primero.
    assert b["units"][0]["unit"] == "TRL 100", [r["unit"]
                                                for r in b["units"]]

    # Exclusión del tracker (pm overrides) y estado de operaciones.
    pm.set_excluded("TRL 300", True)
    maint.set_ops_status("TRL 100", "in_shop")
    try:
        b = _board()
        assert "TRL 300" in {e["unit"] for e in b["excluded"]}
        r100 = _row(b, "TRL 100")
        assert (r100["status"], r100["due_status"]) == ("in_shop",
                                                        "upcoming")
    finally:
        pm.set_excluded("TRL 300", False)
        maint.set_ops_status("TRL 100", "")
    # Flota caída: el board avisa (Service Requests no cierra nada).
    FAKE["fleet_error"] = True
    try:
        assert _board()["errors"] == ["fleet"]
    finally:
        FAKE["fleet_error"] = False
    # Feed DEMO fuera de demo: sus unidades no son de la flota.
    saved = FAKE["feed"]
    FAKE["feed"] = {"available": True, "demo": True, "source": "demo",
                    "units": [{"unit": "DEMO 1", "engine_hours": 10.0,
                               "demo": True}]}
    try:
        assert "DEMO 1" not in {r["unit"] for r in _board()["units"]}
        assert asyncio.run(meters.snapshot_now()) == 0
    finally:
        FAKE["feed"] = saved
    print(f"OK universo del board del reefer: {sorted(units)}")


def test_unit_campaigns_reefer():
    from app.api import routes
    uc = asyncio.run(maint.unit_campaigns("TRL 100"))
    rc = next(c for c in uc["campaigns"] if c["key"] == "reefer")
    assert rc["auto"] and rc["due"] == "hours" and rc["due_by"] == "hours"
    assert rc["to_due"] == 100.0 and rc["last_hours"] == 1000.0
    assert rc["records"][0]["hours"] == 1000.0, "registro con otra grafía"
    assert (uc["current_hours"], uc["current_hours_source"],
            uc["current_hours_date"]) == (2400.0, "manual", _d(0))
    assert "reefer" not in {a["key"] for a in uc["available"]}
    # Un camión: el PM del reefer se ofrece (opt-in), no viene prendido.
    t1 = asyncio.run(maint.unit_campaigns("T1"))
    assert "reefer" in {a["key"] for a in t1["available"]}
    assert t1["current_hours"] is None
    routes.unit_campaign_toggle("T1", routes.CampaignIn(key="reefer",
                                                        enabled=True))
    t1 = asyncio.run(maint.unit_campaigns("T1"))
    rc = next(c for c in t1["campaigns"] if c["key"] == "reefer")
    assert rc["auto"] is False and rc["status"] == "never"
    assert "T1" in {r["unit"] for r in _board()["units"]}
    routes.unit_campaign_toggle("T1", routes.CampaignIn(key="reefer",
                                                        enabled=False))
    assert "T1" not in {r["unit"] for r in _board()["units"]}
    # Opt-out de una reefer automática: queda apagada aunque se detecte.
    routes.unit_campaign_toggle("TRL 100", routes.CampaignIn(
        key="reefer", enabled=False))
    meters.clear_cache()
    uc = asyncio.run(maint.unit_campaigns("TRL 100"))
    assert "reefer" in {a["key"] for a in uc["available"]}
    assert "TRL 100" not in {r["unit"] for r in _board()["units"]}
    routes.unit_campaign_toggle("TRL 100", routes.CampaignIn(
        key="reefer", enabled=True))
    assert "TRL 100" in {r["unit"] for r in _board()["units"]}
    print("OK campañas del perfil: reefer automática, opt-in y opt-out")


def test_add_record_hours():
    from app.api import routes
    rec = maint.add_record("TRL 300", "reefer", _d(0), hours=777)
    assert rec["hours"] == 777.0 and rec["kind"] == "reefer"
    assert meters.latest("TRL 300") == {"value": 777.0, "date": _d(0),
                                        "source": "maint"}
    _raises(maint.add_record, "TRL 300", "reefer", _d(0), hours=-1,
            contains="hours")
    # Sin horas en una campaña por horas: la lectura del horómetro del día.
    rec = maint.add_record("TRL 400", "reefer", _d(0), notes="no reading")
    assert rec["hours"] == 800.0, rec
    with db.SessionLocal() as s:
        srcs = {m.source for m in s.scalars(select(db.MeterReading).where(
            db.MeterReading.unit == "TRL 400")).all()}
    assert srcs == {"manual"}, "la derivada no se re-registra como lectura"
    out = routes.maint_add_record(routes.MaintRecordIn(
        kind="reefer", unit="TRL 500", date=_d(-30), hours=321.5))
    assert out["record"]["hours"] == 321.5
    b = _board()
    r300 = _row(b, "TRL 300")
    assert (r300["status"], r300["to_due"], r300["meter_missing"]) == (
        "on_track", 1500.0, False), r300
    print("OK add_record con horas (+ lectura 'maint') y derivada del día")


def test_maint_due_and_routes():
    from fastapi import HTTPException

    from app.api import routes
    from app.main import _scope_for
    meters.clear_cache()
    d = asyncio.run(maint.due())
    reefer_items = [i for i in d["items"] if i["campaign"] == "reefer"]
    assert any(i["unit"] == "TRL 100" for i in reefer_items)
    it = next(i for i in reefer_items if i["unit"] == "TRL 100")
    assert (it["status"], it["due_by"], it["unit_label"], it["to_due"],
            it["label"]) == ("upcoming", "hours", "hrs", 100.0,
                             "Reefer PM (engine hours)"), it
    assert it["next_due"] == "2,500 hrs" and it["to_due_days"] == 265
    assert d["counts"]["upcoming"] >= 1 and d["errors"] == []
    st = [i["status"] for i in d["items"]]
    assert st == sorted(st, key=lambda s: 0 if s == "overdue" else 1)
    assert routes.maint_due.__name__
    lim = asyncio.run(routes.maint_due(limit=1))
    assert len(lim["items"]) == 1 and lim["total"] == len(d["items"])
    # Rutas: /maint/due literal ANTES de /maint/{kind}; RBAC.
    order = [r.path for r in routes.router.routes]
    assert order.index("/api/maint/due") < order.index("/api/maint/{kind}")
    assert "/api/units/{unit}/meters/{meter}" in order
    assert _scope_for("POST", "/api/units/TRL 1/meters/engine_hours") == \
        "maint.edit"
    assert _scope_for("GET", "/api/units/TRL 1/meters/engine_hours") is None
    assert _scope_for("GET", "/api/maint/due") is None
    _raises(lambda: asyncio.run(maint.board("bogus")), contains="kind")
    # POST manual: devuelve la vigente; 400 si no es creíble; force.
    got = routes.unit_meter_log("TRL 9", "engine_hours",
                                routes.MeterReadingIn(value=1210))
    assert (got["value"], got["date"], got["source"]) == (
        1210.0, _d(0), "manual"), got
    try:
        routes.unit_meter_log("TRL 9", "engine_hours",
                              routes.MeterReadingIn(value=10))
        raise AssertionError("debió dar 400")
    except HTTPException as exc:
        assert exc.status_code == 400 and "lower" in exc.detail
    got = routes.unit_meter_log("TRL 9", "engine_hours",
                                routes.MeterReadingIn(value=10, force=True))
    assert got["value"] == 10.0
    try:
        routes.unit_meter_readings("TRL 9", "odometer")
        raise AssertionError("debió dar 404")
    except HTTPException as exc:
        assert exc.status_code == 404
    rd = routes.unit_meter_readings("TRL 9", "engine_hours")
    assert rd["latest"]["value"] == 10.0 and rd["count"] == 3
    print(f"OK GET /maint/due ({d['counts']}) + rutas del horómetro")


def _sr_sync() -> dict:
    sr.reset_sync_cache()
    meters.clear_cache()
    return asyncio.run(sr.sync(force=True))


def _req(key: str):
    with db.SessionLocal() as s:
        rows = s.scalars(select(db.ServiceRequest).where(
            db.ServiceRequest.source_key == key)).all()
    assert len(rows) == 1, (key, len(rows))
    return rows[0]


def test_service_requests_reefer():
    # TRL 700: vencido por HORAS. TRL 800: sin horómetro, vencido por FECHA
    # (y con la DOT vencida).
    manual_units.add({"unit": "TRL 700", "unit_type": "trailer",
                      "subtype": "reefer"})
    manual_units.add({"unit": "TRL 800", "unit_type": "trailer",
                      "subtype": "reefer"})
    maint.add_record("TRL 700", "reefer", _d(-200), hours=3000)
    meters.log_reading("TRL 700", 4600, _d(0), force=True)
    # Registro viejo SIN horas y sin lecturas: el ciclo es la fecha.
    maint.add_record("TRL 800", "reefer", _d(-400))
    maint.add_record("TRL 800", "dot", _d(-400))
    _sr_sync()

    r700 = _req("reefer:TRL700:3000")
    m = sr._meta(r700)
    assert (r700.source, r700.title, r700.priority) == (
        "reefer", "Reefer PM due (engine hours)", "urgent")
    assert (m["kind"], m["to_due"], m["due_by"], m["current_hours"],
            m["next_due_hours"]) == ("hours", -100.0, "hours", 4600.0,
                                     4500.0), m
    assert "next due at 4,500 hrs" in r700.detail
    r800 = _req(f"reefer:TRL800:{_d(-400)}")
    m8 = sr._meta(r800)
    assert m8["meter_missing"] and m8["due_by"] == "days" \
        and m8["to_due"] is None and m8["to_due_days"] < 0, m8
    r100 = _req("reefer:TRL100:1000")
    assert r100.priority == "normal", "upcoming => normal"
    dot800 = _req(f"dot:TRL800:{_d(-400)}")
    assert sr._sr_dict(r700)["source"] == "reefer"
    lst = sr.list_requests("open", source="reefer")
    assert {r["unit"] for r in lst["requests"]} >= {"TRL 700", "TRL 800",
                                                    "TRL 100"}
    assert all("reefer" in u["by_source"] for u in lst["units"])
    # Idempotente.
    assert _sr_sync()["created"] == 0

    # create_wo: campaña reefer + horas del request en la WO.
    wo = sr.create_wo([r700.id], mechanic="Luis")["workorder"]
    assert (wo["campaign"], wo["engine_hours"]) == ("reefer", 4600.0), wo
    workorders.add_line(wo["id"], "labor", "Reefer PM", 2, 90)
    workorders.update_wo(wo["id"], {"status": "invoiced"})
    rec = maint.latest_by_unit("reefer")["TRL 700"]
    assert rec["hours"] == 4600.0 and rec["notes"].startswith(
        f"WO #{wo['id']}:"), rec
    row = _row(_board(), "TRL 700")
    assert row["status"] == "on_track" and row["last_hours"] == 4600.0
    res = _sr_sync()
    assert res["created"] == 0, res
    assert sr.get_request(r700.id)["status"] == "done"

    # WO con DOT + reefer del mismo trailer: al facturar se registran AMBAS.
    wo2 = sr.create_wo([dot800.id, r800.id], mechanic="Luis")["workorder"]
    assert wo2["campaign"] == "dot" and wo2["engine_hours"] is None
    workorders.add_line(wo2["id"], "labor", "DOT + reefer PM", 3, 90)
    workorders.update_wo(wo2["id"], {"status": "invoiced"})
    with db.SessionLocal() as s:
        kinds = sorted(r.kind for r in s.scalars(select(db.MaintRecord).where(
            db.MaintRecord.notes.like(f"WO #{wo2['id']}:%"))).all())
    assert kinds == ["dot", "reefer"], kinds
    row = _row(_board(), "TRL 800")
    assert row["status"] == "on_track" and row["last_date"] == _d(0)
    # Re-facturar no duplica.
    workorders.update_wo(wo2["id"], {"status": "completed"})
    workorders.update_wo(wo2["id"], {"status": "invoiced"})
    with db.SessionLocal() as s:
        n = len(s.scalars(select(db.MaintRecord).where(
            db.MaintRecord.notes.like(f"WO #{wo2['id']}:%"))).all())
    assert n == 2, n

    # add_to_wo: el request del reefer se suma a una WO abierta de la unidad
    # y le pasa campaña + horas.
    man = workorders.create_wo("TRL 100", "Shop visit", mechanic="Luis")
    out = sr.add_to_wo(r100.id, man["id"])
    assert (out["workorder"]["campaign"],
            out["workorder"]["engine_hours"]) == ("reefer", 2400.0), out
    print("OK Service Requests 'reefer': horas, días de respaldo, WO, "
          "registro con horas y DOT + reefer")


def test_wo_engine_hours_field():
    from app.api import routes
    wo = workorders.create_wo("TRL 900", "Reefer repair",
                              engine_hours=1234.5)
    assert wo["engine_hours"] == 1234.5
    assert meters.latest("TRL 900") == {"value": 1234.5, "date": _d(0),
                                        "source": "wo"}
    wo = workorders.update_wo(wo["id"], {"engine_hours": 1250})
    assert wo["engine_hours"] == 1250.0
    assert meters.latest("TRL 900")["value"] == 1250.0, "corrige el día"
    assert meters.unit_readings("TRL 900")["count"] == 1
    wo = workorders.update_wo(wo["id"], {"engine_hours": 0})
    assert wo["engine_hours"] is None, "0 = borrar"
    _raises(workorders.update_wo, wo["id"], {"engine_hours": -5},
            contains="engine hours")
    _raises(workorders.create_wo, "TRL 900", "x", engine_hours="abc",
            contains="engine hours")
    assert "engine_hours" in routes.WorkOrderIn.model_fields
    assert "engine_hours" in routes.WorkOrderPatch.model_fields
    w = routes.wo_create(routes.WorkOrderIn(unit="TRL 901", title="t",
                                            engine_hours=50), None)
    assert w["engine_hours"] == 50.0
    assert any(x["id"] == w["id"] and x["engine_hours"] == 50.0
               for x in workorders.list_wos(unit="TRL 901"))
    print("OK WorkOrder.engine_hours (create/patch/borrar/validación)")


def test_feed_parsers_and_demo():
    hours_ms = 1234.5 * 3_600_000
    u = traccar._build_unit({"id": 7, "name": "TRL 77"},
                            {"attributes": {"hours": hours_ms},
                             "fixTime": datetime.now(
                                 timezone.utc).isoformat()},
                            dict(traccar._DEFAULTS))
    assert u["engine_hours"] == 1234.5, u["engine_hours"]
    u = traccar._build_unit({"id": 8, "name": "TRL 78"},
                            {"attributes": {}}, dict(traccar._DEFAULTS))
    assert u["engine_hours"] is None
    lu = lynx._build_unit({"id": "a1", "name": "TRL 79",
                           "totalEngineHours": "4321.04"},
                          dict(lynx._DEFAULTS))
    assert lu["engine_hours"] == 4321.0, lu["engine_hours"]
    lu = lynx._build_unit({"id": "a2", "name": "TRL 80",
                           "engineHours": 9e9}, dict(lynx._DEFAULTS))
    assert lu["engine_hours"] is None, "fuera de rango = sin dato"

    # Simulador demo: determinista y creciente; mismo valor que el seed.
    ts = datetime(2026, 9, 1, 12, 0).timestamp()
    s1 = reefer._state_at("53108", ts)["engine_hours"]
    assert s1 == reefer._state_at("53108", ts)["engine_hours"]
    assert reefer._state_at("53108", ts + 6 * 3600)["engine_hours"] > s1
    assert reefer._state_at("4402", ts)["engine_hours"] is None
    day = TODAY - timedelta(days=3)
    h1 = demo_eld.engine_hours_at("53108", day)
    h0 = demo_eld.engine_hours_at("53108", day - timedelta(days=1))
    assert 0 < h1 - h0 <= 24

    # Demo completo (en una org aparte): seed + estados estables.
    with db.SessionLocal() as s:
        o = db.Organization(slug="demo-org", name="Demo", active=True,
                            created_at=datetime.now())
        s.add(o)
        s.commit()
        demo_org = o.id
    tok = tenant.set_current_org(demo_org)
    saved = (FAKE["fleet"], FAKE["feed"], FAKE["demo"])
    FAKE["demo"] = True
    FAKE["fleet"] = demo_eld.fleet()
    FAKE["feed"] = {"available": True, "demo": True, "source": "demo",
                    "units": reefer.demo_units()}
    try:
        assert meters.seed_demo_history(30) == 4 * 30
        assert meters.seed_demo_history(30) == 0, "idempotente"
        assert asyncio.run(meters.snapshot_now()) == 4
        b = _board()
        st = {r["unit"]: (r["due_status"], r["due_by"]) for r in b["units"]}
        assert st == {"53108": ("on_track", "hours"),
                      "53112": ("upcoming", "hours"),
                      "7841": ("overdue", "hours"),
                      "7846": ("overdue", "days")}, st
        assert all(r["current_hours_source"] == "demo" for r in b["units"])
        d = asyncio.run(maint.due())
        assert {i["unit"] for i in d["items"]
                if i["campaign"] == "reefer"} == {"53112", "7841", "7846"}
        # La org sale del demo (configura Samsara): las lecturas demo que
        # quedaron en la base no son vigentes ni crean reefers fantasma.
        FAKE["demo"] = False
        FAKE["fleet"] = []
        assert meters.latest_all() == {}
        assert meters.latest("53108") is None
        assert _board()["units"] == []
    finally:
        FAKE["fleet"], FAKE["feed"], FAKE["demo"] = saved
        tenant.reset_current_org(tok)
    print("OK parsers de feed (Traccar ms->h, Lynx) + demo estable")


def test_tenant_isolation():
    with db.SessionLocal() as s:
        o = db.Organization(slug="other-meters", name="Other", active=True,
                            created_at=datetime.now())
        s.add(o)
        s.commit()
        other = o.id
    mine = meters.latest_all()
    tok = tenant.set_current_org(other)
    try:
        assert meters.latest_all() == {}
        # Misma unidad, fecha más nueva en la otra org: no cruza.
        meters.log_reading("TRL 9", 99_000, _d(0))
        assert meters.latest("TRL 9")["value"] == 99_000.0
    finally:
        tenant.reset_current_org(tok)
    assert meters.latest_all() == mine
    assert meters.latest("TRL 9")["value"] == 10.0
    print("OK aislamiento por tenant del horómetro")


def test_finisher_meter_reset_and_cycles():
    """v2.22 finisher: reseteo del horómetro (tramo nuevo), recuperación del
    feed, ciclo fijo del baseline demo, horas al facturar y fecha de la org."""
    # (C) Org manual: lectura 'wo' 15000 el día D (WO del cambio de
    # controlador) y luego un 50 FORZADO el mismo día => tramo nuevo.
    meters.log_reading("RST 9", 14990, _d(-3), source="manual")
    meters.log_reading("RST 9", 15000, _d(-2), source="wo")
    _raises(meters.log_reading, "RST 9", 50, _d(-2), contains="lower than")
    r = meters.log_reading("RST 9", 50, _d(-2), source="manual", force=True)
    assert r["is_reset"] is True, r
    assert meters.latest("RST 9")["value"] == 50.0, meters.latest("RST 9")
    assert meters.latest_all()["RST9"]["value"] == 50.0
    # Lecturas posteriores (feed, wo, maint) contra el tramo nuevo: pasan.
    meters.log_reading("RST 9", 62, _d(-1), source="lynx")
    assert meters.latest("RST 9")["value"] == 62.0
    # El 15000 viejo ya no se acepta sin force (no es creíble vs 62).
    _raises(meters.log_reading, "RST 9", 15010, _d(0), source="wo",
            contains="more than")
    maint.add_record("RST 9", "reefer", _d(0), hours=80)
    lat = meters.latest("RST 9")
    assert (lat["value"], lat["source"]) == (80.0, "maint"), lat
    ur = meters.unit_readings("RST 9")
    assert ur["latest"]["value"] == 80.0
    assert any(x["superseded"] for x in ur["readings"]), ur["readings"]
    # value_at antes del reseteo sigue viendo el tramo viejo.
    assert meters.value_at("RST 9", _d(-3)) == 14990.0
    # eval_due tras el PM: al día, nunca "13,000 hrs over".
    manual_units.add({"unit": "RST 9", "unit_type": "trailer",
                      "subtype": "reefer"})
    row = _row(_board(), "RST 9")
    assert row["status"] == "on_track" and row["to_due"] > 0, row
    # Un force que NO baja (salto grande) no es reseteo.
    r2 = meters.log_reading("RST 9", 200, _d(0), source="manual", force=True)
    assert r2["is_reset"] is False, r2

    # Feed que reporta un valor bajo DOS días seguidos => reseteo solo.
    saved_feed, saved_today = FAKE["feed"], meters._today
    try:
        meters.log_reading("FDR 1", 9000, _d(-3), source="lynx")
        for k, hrs in ((-2, 40.0), (-1, 52.0)):
            FAKE["feed"] = {"available": True, "demo": False,
                            "source": "lynx",
                            "units": [{"unit": "FDR 1", "engine_hours": hrs,
                                       "source": "lynx"}]}
            meters._today = (lambda kk=k: TODAY + timedelta(days=kk))
            asyncio.run(meters.snapshot_now())
        lat = meters.latest("FDR 1")
        assert lat["value"] == 52.0, lat
    finally:
        FAKE["feed"], meters._today = saved_feed, saved_today

    # Baseline demo: el ciclo del request es fijo aunque last_* cambie.
    k1 = sr._due_key("reefer", "7841", {"last_hours": 100.5,
                                        "last_source": "baseline"})
    k2 = sr._due_key("reefer", "7841", {"last_hours": 117.2,
                                        "last_source": "baseline"})
    assert k1 == k2 == "reefer:7841:baseline", (k1, k2)
    assert sr._due_key("reefer", "7841", {"last_hours": 117.2,
                                          "last_source": "record"})         == "reefer:7841:117.2"
    assert sr._due_key("pm", "T1", {"last_miles": 5,
                                    "last_source": "baseline"})         == "pm:T1:baseline"
    rows = demo_eld.reefer_pm_rows()
    assert rows and all("last_hours" in x for x in rows)
    assert all(x["baseline"] for x in demo_eld.pm_rows()
               if x["last_pm_miles"] is not None)

    # Facturar una WO de reefer con horas VIEJAS: gana la lectura más nueva
    # del horómetro; fecha del registro = hoy de la ORG.
    manual_units.add({"unit": "STL 1", "unit_type": "trailer",
                      "subtype": "reefer"})
    meters.log_reading("STL 1", 1000, _d(-5))
    meters.log_reading("STL 1", 1090, _d(-1))
    wo = workorders.create_wo("STL 1", "Reefer PM", mechanic="Luis",
                              campaign="reefer")
    with db.SessionLocal() as s:        # copia vieja del request (día -5)
        s.get(db.WorkOrder, wo["id"]).engine_hours = 1000.0
        s.commit()
    workorders.add_line(wo["id"], "labor", "Reefer PM", 2, 90)
    workorders.update_wo(wo["id"], {"status": "invoiced"})
    rec = maint.latest_by_unit("reefer")["STL 1"]
    assert rec["hours"] == 1090.0, rec
    assert rec["date"] == org_config.org_today().isoformat(), rec
    print("OK finisher: meter reset segment, feed self-recovery, fixed "
          "demo baseline cycle, newest hours at invoice, org date")


if __name__ == "__main__":
    test_log_reading_rules()
    test_eval_due_hours()
    test_reefer_board_universe()
    test_unit_campaigns_reefer()
    test_add_record_hours()
    test_maint_due_and_routes()
    test_service_requests_reefer()
    test_wo_engine_hours_field()
    test_feed_parsers_and_demo()
    test_tenant_isolation()
    test_finisher_meter_reset_and_cycles()
    print("\nALL METER / REEFER PM TESTS PASSED")
