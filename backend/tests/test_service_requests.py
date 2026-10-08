# -*- coding: utf-8 -*-
"""Tests de Service Requests (v2.20, benchmark SquareRigger) + fix del drawer
de WOs (las mutaciones devuelven `links`).

`python backend/tests/test_service_requests.py`. DB SQLite temporal fresca.
El feed de defectos y los tableros PM/DOT se reemplazan por fakes (sin red).

Lo que NO hay que perder:
  - el sync materializa defectos + PM/DOT y es idempotente (source_key);
  - un defecto que desaparece se auto-resuelve SOLO con un feed exitoso
    (nunca vaciar el backlog por una caída de Samsara);
  - el ciclo del PM va en la clave: registrar el PM => request NUEVO;
  - deny / snooze / reopen respetan sus estados de origen; el snooze vencido
    vuelve a open;
  - create_wo es atómico y valida misma unidad + open; add_to_wo valida;
  - hooks de WO: completar => done, retroceder => on_wo, borrar => open;
  - defect_to_wo crea + liga con la misma clave que el sync;
  - el resumen por unidad ordena por prioridad y después por millas vencidas;
  - update_wo / add_line / delete_line devuelven links + service_requests.
  - review v2.20: una caída de Samsara (board con `errors`, unidad sin
    odómetro) NO auto-cierra PM ni borra snoozes; defect_to_wo sobre un
    defecto cerrado por WO archiva la fila (la WO conserva el vínculo);
    insert concurrente => sync devuelve None (no 500); el sync no pisa una
    acción del usuario hecha en medio; fechas YYYY-MM-DD estrictas; lo
    accionable sale sin tope; cambios de PM/DOT olvidan el TTL; list_wos
    no pierde WOs activas viejas por el tope de 200.
  - addendum v2.20: borrado suave + restore (on_wo se saltea, inexistente
    'not found', ya borrado se ignora); lo borrado no sale en listas /
    conteos / units / all; el sync NUNCA revive un borrado con la fuente
    activa (defecto ni PM) y un defecto borrado que se resolvió y vuelve a
    aparecer entra como request nuevo (la fila vieja se archiva);
    duplicados (texto igual, contenido, Jaccard, pm↔pm, union-find con el
    más viejo como keeper, units[].duplicates, delete_duplicates por unidad
    y de la flota); unidad canónica (el sync renombra 'CAN1' del feed a
    'CAN 1' de la flota sin crear otra fila, create_manual canoniza y
    rechaza una unidad desconocida si hay flota, units[] funde variantes).
"""
import asyncio
import json
import os
import sys
import tempfile
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

_TMP = Path(tempfile.mkdtemp())
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP / 'service_requests_test.db'}"
os.environ["FLEET_DEMO"] = "1"          # feed real de defectos = ELD demo

from sqlalchemy import event, select                    # noqa: E402

from app import db                                      # noqa: E402
from app.core import (                                  # noqa: E402
    fleet_inventory, maint, open_defects, service_requests as sr, tenant,
    wo_invoices, workorders,
)

# maint.board REAL (el __main__ lo reemplaza por el fake): lo usa
# test_pm_record_goes_to_board_row.
_REAL_BOARD = maint.board

ORG = db.default_org_id()
tenant.set_current_org(ORG)

# Los adjuntos de factura de las WOs del test van a un dir temporal: borrar
# una WO del test NO debe tocar los archivos reales del repo.
wo_invoices.UPLOADS_DIR = _TMP / "wo_invoices"

TODAY = date.today()


# ----- Fakes (sin red) -------------------------------------------------------

def _defect(unit, detail, company="CHASER", reports=1):
    return {"unit": unit, "company": company, "detail": detail,
            "dvir_type": "Pre-trip", "reports": reports,
            "date_label": f"{TODAY.month}.{TODAY.day}",
            "block_date": TODAY.isoformat(), "unit_kind": "truck",
            "status": "Open"}


def _pm(unit, to_due, last_miles=100_000, model="2021 Freightliner Cascadia",
        current=None, interval=15_000):
    nxt = last_miles + interval
    return {"unit": unit, "model": model,
            "current_miles": current if current is not None else nxt - to_due,
            "last_miles": last_miles, "last_date": "2026-03-01",
            "next_due_miles": nxt, "to_due": to_due, "status": "x"}


def _dot(unit, to_due, last_date="2025-10-01"):
    return {"unit": unit, "model": "", "current_miles": None,
            "last_miles": None, "last_date": last_date,
            "next_due_date": (TODAY + timedelta(days=to_due)).isoformat(),
            "to_due": to_due, "status": "x"}


STATE: dict = {
    "feed": {"available": True, "source": "samsara", "defects": []},
    "pm": {"upcoming_miles": 2000, "units": []},
    "dot": {"upcoming_days": 30, "units": []},
    # Universo de GET /fleet: nombres de unidad. Vacío = flota no disponible
    # (todo se acepta como vino); una Exception => fleet con `error`.
    "fleet": [],
}


async def _fake_feed(refresh: bool = False) -> dict:
    if isinstance(STATE["feed"], Exception):
        raise STATE["feed"]
    return STATE["feed"]


async def _fake_board(kind: str, refresh: bool = False) -> dict:
    return STATE[kind]


async def _fake_fleet(refresh: bool = False) -> dict:
    """Misma forma que fleet_inventory.load (GET /api/fleet)."""
    if isinstance(STATE["fleet"], Exception):
        return {"available": True, "source": "manual",
                "error": str(STATE["fleet"]),
                "units": [{"unit": "ONLY-MANUAL"}]}
    units = [{"id": f"f-{i}", **u} if isinstance(u, dict)
             else {"id": f"f-{i}", "unit": u}
             for i, u in enumerate(STATE["fleet"])]
    return {"available": bool(units),
            "source": "samsara" if units else "none", "units": units}


def _sync(force: bool = True) -> dict:
    return asyncio.run(sr.sync(force=force))


def _rows(**where) -> list:
    with db.SessionLocal() as s:
        q = select(db.ServiceRequest)
        for k, v in where.items():
            q = q.where(getattr(db.ServiceRequest, k) == v)
        return list(s.scalars(q.order_by(db.ServiceRequest.id)).all())


def _row(key: str):
    rows = _rows(source_key=key)
    assert len(rows) == 1, f"esperaba 1 fila para {key}, hay {len(rows)}"
    return rows[0]


def _wo_count() -> int:
    with db.SessionLocal() as s:
        return len(s.scalars(select(db.WorkOrder)).all())


def _raises(fn, *args, contains: str = "", **kw):
    try:
        fn(*args, **kw)
    except ValueError as exc:
        assert contains in str(exc), f"mensaje inesperado: {exc}"
        return str(exc)
    raise AssertionError(f"{fn.__name__} debió lanzar ValueError")


# ----- Tests -----------------------------------------------------------------

def test_real_feed_helper():
    """El helper extraído de GET /dvir/open-defects responde igual que la
    ruta (antes de reemplazarlo por el fake)."""
    from app.api import routes
    feed = asyncio.run(open_defects.current_feed())
    assert feed["available"] is True and feed["source"] == "samsara"
    assert feed["defects"], "el ELD demo trae defectos abiertos"
    assert "error" not in feed
    via_route = asyncio.run(routes.dvir_open_defects())
    assert via_route == feed, "la ruta delega en el helper"
    print(f"OK helper current_feed (demo): {len(feed['defects'])} defectos")


def test_sync_creates_rows():
    STATE["feed"] = {"available": True, "source": "samsara", "defects": [
        _defect("412", "Brakes - chamber leaking", reports=3),
        _defect("MEM 77", "Lights - left marker out", company="MCC"),
        # mismo defecto con otro espaciado/caso: se funde en la misma clave
        _defect("412", "brakes  -  Chamber leaking", reports=2),
    ]}
    STATE["pm"] = {"upcoming_miles": 2000, "units": [
        _pm("412", -500),                   # vencido
        _pm("500", 1000, last_miles=50_000),  # por vencer
        _pm("600", 9000),                   # on track -> nada
        {**_pm("700", 0), "to_due": None},  # sin odómetro -> nada
    ]}
    STATE["dot"] = {"upcoming_days": 30, "units": [
        _dot("412", -3), _dot("800", 10), _dot("900", 200),
        {**_dot("901", 0), "to_due": None},
    ]}
    res = _sync()
    assert res["created"] == 6, res
    assert res["resolved"] == 0 and res["reopened"] == 0
    assert res["synced_at"]

    d = _row(sr.defect_key("412", "Brakes - chamber leaking"))
    assert d.source == "defect" and d.status == "open"
    assert d.priority == "normal" and d.title == "Brakes - chamber leaking"
    assert d.source_key.startswith("defect:") and len(d.source_key) == 31
    meta = sr._meta(d)
    assert meta["reports"] == 5 and meta["dvir_type"] == "Pre-trip"

    pm412 = _row("pm:412:100000")
    assert pm412.priority == "urgent" and pm412.status == "open"
    assert pm412.title == "Preventive maintenance (PM) due"
    assert pm412.company == "CHASER", "empresa tomada del feed de defectos"
    m = sr._meta(pm412)
    assert m["kind"] == "miles" and m["overdue"] is True and m["to_due"] == -500
    assert m["next_due_miles"] == 115_000 and m["current_miles"] == 115_500
    assert "DD13/DD15" in pm412.detail
    assert _row("pm:500:50000").priority == "normal"
    dot412 = _row("dot:412:2025-10-01")
    assert dot412.priority == "emergency"
    assert dot412.title == "Annual DOT inspection due"
    assert sr._meta(dot412)["kind"] == "days"
    assert _row("dot:800:2025-10-01").priority == "normal"
    assert not _rows(unit="600") and not _rows(unit="700")
    assert not _rows(unit="900") and not _rows(unit="901")
    print("OK sync crea defectos + PM/DOT con prioridad y meta")


def test_sync_idempotent():
    before = len(_rows())
    res = _sync()
    assert res == {**res, "created": 0, "resolved": 0, "reopened": 0}, res
    assert len(_rows()) == before
    # Sin force respeta el TTL (no vuelve a leer el feed).
    STATE["feed"] = RuntimeError("no debería llamarse")
    res2 = _sync(force=False)
    assert res2["created"] == 0
    STATE["feed"] = {"available": True, "source": "samsara", "defects": [
        _defect("412", "Brakes - chamber leaking", reports=3),
        _defect("MEM 77", "Lights - left marker out", company="MCC"),
    ]}
    print("OK sync idempotente + TTL")


def test_clearing_only_on_successful_feed():
    key_lights = sr.defect_key("MEM 77", "Lights - left marker out")
    only_brakes = [_defect("412", "Brakes - chamber leaking")]

    # 1) Fallback por error: el defecto falta pero NO se resuelve.
    STATE["feed"] = {"available": True, "source": "csv",
                     "error": "Samsara did not respond", "defects": only_brakes}
    res = _sync()
    assert res["resolved"] == 0
    r = _row(key_lights)
    assert r.status == "open" and r.source_active is True

    # 2) El feed explota: tampoco.
    STATE["feed"] = RuntimeError("boom")
    assert _sync()["resolved"] == 0
    assert _row(key_lights).status == "open"

    # 3) Feed exitoso sin el defecto -> done / cleared.
    STATE["feed"] = {"available": True, "source": "samsara",
                     "defects": only_brakes}
    res = _sync()
    assert res["resolved"] == 1, res
    r = _row(key_lights)
    assert (r.status, r.resolution, r.source_active) == ("done", "cleared",
                                                         False)
    assert r.resolved_at is not None

    # 4) Vuelve a aparecer: el auto-cierre lo decidió el sistema -> re-abre.
    STATE["feed"] = {"available": True, "source": "samsara", "defects": [
        *only_brakes, _defect("MEM 77", "Lights - left marker out")]}
    res = _sync()
    assert res["reopened"] == 1 and res["created"] == 0, res
    r = _row(key_lights)
    assert (r.status, r.resolution, r.source_active) == ("open", "", True)

    # 5) PM que deja de estar por vencer -> cleared.
    STATE["pm"] = {"upcoming_miles": 2000, "units": [_pm("412", -500)]}
    res = _sync()
    assert res["resolved"] == 1
    assert _row("pm:500:50000").status == "done"
    print("OK clearing solo con feed exitoso (+ re-open si reaparece)")


def test_pm_cycle_new_row():
    # Se registró el PM de 412 (last_miles nuevo) -> el viejo se cierra.
    STATE["pm"] = {"upcoming_miles": 2000, "units": [
        _pm("412", 14_000, last_miles=115_500)]}
    res = _sync()
    assert res["resolved"] == 1
    old = _row("pm:412:100000")
    assert old.status == "done" and old.resolution == "cleared"
    assert not _rows(source_key="pm:412:115500"), "on track: sin request"
    # Más adelante vuelve a vencer: request NUEVO (otra clave/ciclo).
    STATE["pm"] = {"upcoming_miles": 2000, "units": [
        _pm("412", -100, last_miles=115_500)]}
    res = _sync()
    assert res["created"] == 1 and res["reopened"] == 0
    new = _row("pm:412:115500")
    assert new.status == "open" and new.priority == "urgent"
    assert _row("pm:412:100000").status == "done", "el ciclo viejo no revive"
    print("OK ciclo de PM en la clave: PM registrado => request nuevo")


def test_priority_bump_when_overdue():
    STATE["dot"] = {"upcoming_days": 30, "units": [
        _dot("412", -3), _dot("800", 10)]}
    _sync()
    assert _row("dot:800:2025-10-01").priority == "normal"
    STATE["dot"] = {"upcoming_days": 30, "units": [
        _dot("412", -3), _dot("800", -1)]}
    _sync()
    r = _row("dot:800:2025-10-01")
    assert r.priority == "emergency" and sr._meta(r)["overdue"] is True
    print("OK prioridad sube al vencer")


def test_deny_snooze_reopen():
    m = sr.create_manual("412", "Check A/C", detail="Driver says weak",
                         priority="low", follow_up_date="2026-12-01",
                         company="CHASER", created_by="Ana")
    assert m["source"] == "manual" and m["status"] == "open"
    assert m["source_key"].startswith("manual:")
    assert m["created_by"] == "Ana" and m["follow_up_date"] == "2026-12-01"
    assert isinstance(m["meta"], dict)
    _raises(sr.create_manual, "", "x", contains="unit and title are required")
    _raises(sr.create_manual, "412", "x", priority="asap",
            contains="priority")
    rid = m["id"]

    upd = sr.update_request(rid, {"title": "Check A/C compressor",
                                  "priority": "urgent",
                                  "follow_up_date": ""})
    assert upd["title"] == "Check A/C compressor"
    assert upd["priority"] == "urgent" and upd["follow_up_date"] is None
    _raises(sr.update_request, rid, {"title": " "}, contains="title")
    assert sr.update_request(999_999, {"title": "x"}) is None

    past = (TODAY - timedelta(days=1)).isoformat()
    future = (TODAY + timedelta(days=7)).isoformat()
    _raises(sr.snooze, rid, past, contains="future")
    _raises(sr.snooze, rid, TODAY.isoformat(), contains="future")
    _raises(sr.snooze, rid, "12/01/2026", contains="YYYY-MM-DD")
    s = sr.snooze(rid, future)
    assert s["status"] == "snoozed" and s["snooze_until"] == future
    _raises(sr.snooze, rid, future, contains="only open")

    d = sr.deny(rid, "Not needed")
    assert (d["status"], d["resolution"], d["deny_reason"]) == (
        "denied", "denied", "Not needed")
    assert d["resolved_at"] and d["snooze_until"] is None
    _raises(sr.deny, rid, contains="only open or snoozed")

    o = sr.reopen(rid)
    assert (o["status"], o["resolution"], o["resolved_at"]) == ("open", "",
                                                                None)
    _raises(sr.reopen, rid, contains="already open")
    assert sr.deny(999_999) is None and sr.reopen(999_999) is None
    print("OK deny / snooze / reopen con sus reglas")


def test_snooze_expiry_reopens():
    m = sr.create_manual("500", "Replace wiper blades")
    sr.snooze(m["id"], (TODAY + timedelta(days=3)).isoformat())
    # Simula que pasó el tiempo: el snooze ya venció.
    with db.SessionLocal() as s:
        row = s.get(db.ServiceRequest, m["id"])
        row.snooze_until = (TODAY - timedelta(days=1)).isoformat()
        s.commit()
    res = _sync()
    assert res["reopened"] >= 1
    r = sr.get_request(m["id"])
    assert r["status"] == "open" and r["snooze_until"] is None
    print("OK snooze vencido vuelve a open en el sync")


def test_create_wo_links_atomically():
    a = sr.create_manual("777", "Fix mirror", detail="Left mirror loose",
                         priority="normal", company="CHASER")
    b = sr.create_manual("777", "Grease fifth wheel", priority="emergency")
    other = sr.create_manual("778", "Other unit thing")
    n0 = _wo_count()

    _raises(sr.create_wo, [a["id"], other["id"]],
            contains="requests must belong to the same unit")
    _raises(sr.create_wo, [a["id"], 999_999], contains="request 999999")
    _raises(sr.create_wo, [], contains="at least one")
    assert _wo_count() == n0, "validación falla => ninguna WO"

    # Atomicidad: si el commit falla después de insertar la WO, no queda
    # ni la WO ni el vínculo.
    real_commit = sr._commit_wo

    def _boom(session):
        raise ValueError("simulated commit failure")
    sr._commit_wo = _boom
    try:
        _raises(sr.create_wo, [a["id"], b["id"]], contains="simulated")
    finally:
        sr._commit_wo = real_commit
    assert _wo_count() == n0, "rollback: la WO no quedó"
    assert sr.get_request(a["id"])["status"] == "open"
    assert sr.get_request(a["id"])["wo_id"] is None

    out = sr.create_wo([a["id"], b["id"]], mechanic="Luis",
                       created_by="Ana")
    wo = out["workorder"]
    assert _wo_count() == n0 + 1
    assert wo["unit"] == "777" and wo["company"] == "CHASER"
    assert wo["title"] == "Fix mirror (+1 more)"
    assert wo["priority"] == "high", "emergency => high"
    assert wo["status"] == "assigned" and wo["mechanic"] == "Luis"
    assert wo["source"] == "request"
    assert wo["complaint"] == ("• [Request] Left mirror loose\n"
                               "• [Request] Grease fifth wheel")
    assert "links" in wo and wo["links"]["display_no"] == str(wo["id"])
    assert sorted(x["id"] for x in wo["service_requests"]) == sorted(
        [a["id"], b["id"]])
    for r in out["requests"]:
        assert r["status"] == "on_wo" and r["wo_id"] == wo["id"]
        assert r["wo_display_no"] == str(wo["id"])
        assert r["wo_status"] == "assigned"

    # Un request ya en WO no entra en otra.
    _raises(sr.create_wo, [a["id"]], contains=f"request {a['id']} is not open")

    # PM: campaña pm + millaje del meta + título simple + prioridad mapeada.
    pm = _row("pm:412:115500")
    out2 = sr.create_wo([pm.id])
    wo2 = out2["workorder"]
    assert wo2["campaign"] == "pm" and wo2["is_pm"] is True
    assert wo2["mileage"] == sr._meta(pm)["current_miles"]
    assert wo2["title"] == "Preventive maintenance (PM) due"
    assert wo2["priority"] == "high" and wo2["status"] == "open"
    assert wo2["complaint"].startswith("• [PM due] ")
    print("OK create_wo: atómico, valida unidad/open, arma la WO")


def test_add_to_wo_validation():
    base = workorders.create_wo("412", "Brake job", complaint="Brakes")
    other_unit = workorders.create_wo("999", "Other")
    done_wo = workorders.create_wo("412", "Old job", mechanic="Luis")
    workorders.update_wo(done_wo["id"], {"status": "completed"})

    dot = _row("dot:412:2025-10-01")
    _raises(sr.add_to_wo, dot.id, other_unit["id"], contains="another unit")
    _raises(sr.add_to_wo, dot.id, done_wo["id"], contains="already completed")
    _raises(sr.add_to_wo, dot.id, 999_999, contains="work order not found")
    assert sr.add_to_wo(999_999, base["id"]) is None

    out = sr.add_to_wo(dot.id, base["id"])
    wo = out["workorder"]
    assert wo["complaint"].startswith("Brakes\n• [DOT due] ")
    assert wo["campaign"] == "dot"
    assert out["request"]["status"] == "on_wo"
    assert out["request"]["wo_id"] == base["id"]
    assert any(x["id"] == dot.id for x in wo["service_requests"])
    # Ya ligado: no se puede sumar otra vez; unlink lo devuelve a open.
    _raises(sr.add_to_wo, dot.id, base["id"], contains="is not open")
    un = sr.unlink(dot.id)
    assert un["status"] == "open" and un["wo_id"] is None
    _raises(sr.unlink, dot.id, contains="not on a work order")
    # La normalización de unidad acepta 'mem 77' vs 'MEM77'.
    mem = workorders.create_wo("MEM77", "Lights")
    lights = _row(sr.defect_key("MEM 77", "Lights - left marker out"))
    assert sr.add_to_wo(lights.id, mem["id"])["request"]["status"] == "on_wo"
    print("OK add_to_wo: unidad, WO cerrada, inexistente, unlink")


def test_wo_hooks_complete_back_delete():
    req = sr.create_manual("321", "Check tires")
    out = sr.create_wo([req["id"]], mechanic="Luis")
    wo_id = out["workorder"]["id"]

    upd = workorders.update_wo(wo_id, {"status": "completed"})
    r = sr.get_request(req["id"])
    assert (r["status"], r["resolution"]) == ("done", "wo")
    assert r["resolved_at"] and r["wo_status"] == "completed"
    # Fix del drawer (C): la mutación trae links + service_requests.
    assert upd["links"]["display_no"] == str(wo_id)
    assert upd["service_requests"][0]["status"] == "done"
    _raises(sr.reopen, req["id"], contains="completed by a work order")

    workorders.update_wo(wo_id, {"status": "in_progress"})
    r = sr.get_request(req["id"])
    assert (r["status"], r["resolution"], r["resolved_at"]) == (
        "on_wo", "", None)

    # Facturar también cierra (requiere total > 0).
    workorders.add_line(wo_id, "labor", "Tire check", 1, 50)
    workorders.update_wo(wo_id, {"status": "invoiced"})
    assert sr.get_request(req["id"])["status"] == "done"

    assert workorders.delete_wo(wo_id) is True
    r = sr.get_request(req["id"])
    assert (r["status"], r["wo_id"], r["resolution"]) == ("open", None, "")

    # Borrar el PADRE de un invoice multi-unidad re-abre los requests de
    # las hijas.
    parent = workorders.create_wo("321", "Parent")
    child = workorders.create_wo("322", "Child", parent_id=parent["id"])
    kid_req = sr.create_manual("322", "Child work")
    sr.add_to_wo(kid_req["id"], child["id"])
    assert sr.get_request(kid_req["id"])["wo_display_no"] == \
        f"{parent['id']}.1"
    workorders.delete_wo(parent["id"])
    assert sr.get_request(kid_req["id"])["status"] == "open"
    print("OK hooks WO: completed/invoiced => done, atrás => on_wo, "
          "delete => open")


def test_wo_mutations_keep_links():
    parent = workorders.create_wo("100", "Invoice parent")
    child = workorders.create_wo("101", "Invoice child",
                                 parent_id=parent["id"])
    disp = f"{parent['id']}.1"
    w = workorders.add_line(child["id"], "part", "Filter", 2, 10)
    assert w["links"]["display_no"] == disp
    assert w["links"]["parent"]["id"] == parent["id"]
    assert "service_requests" in w
    line_id = w["lines"][0]["id"]
    w = workorders.update_wo(child["id"], {"title": "Renamed"})
    assert w["links"]["display_no"] == disp and w["title"] == "Renamed"
    w = workorders.delete_line(child["id"], line_id)
    assert w["links"]["display_no"] == disp and w["lines"] == []
    p = workorders.update_wo(parent["id"], {"notes": "x"})
    assert [c["display_no"] for c in p["links"]["children"]] == [disp]
    print("OK update_wo / add_line / delete_line devuelven links")


def test_defect_to_wo():
    detail = "Tires - flat on axle 2"
    out = sr.defect_to_wo("555", detail, dvir_type="Post-trip",
                          company="CHASER", mechanic="Luis")
    req, wo = out["request"], out["workorder"]
    assert req["source"] == "defect"
    assert req["source_key"] == sr.defect_key("555", detail)
    assert req["status"] == "on_wo" and req["wo_id"] == wo["id"]
    assert wo["status"] == "assigned" and wo["title"] == detail
    assert wo["complaint"] == f"• [DVIR defect] {detail}"
    assert wo["service_requests"][0]["id"] == req["id"]
    _raises(sr.defect_to_wo, "555", detail, contains="already on work order")
    _raises(sr.defect_to_wo, "555", "", contains="unit and detail")

    # El sync con ese defecto en el feed NO duplica (misma clave).
    STATE["feed"]["defects"].append(_defect("555", detail))
    _sync()
    assert len(_rows(source_key=sr.defect_key("555", detail))) == 1
    assert sr.get_request(req["id"])["status"] == "on_wo"

    # Un defecto denegado se puede mandar a WO igual (vuelve al backlog).
    STATE["feed"]["defects"].append(_defect("556", "Horn - inoperative"))
    _sync()
    den = _row(sr.defect_key("556", "Horn - inoperative"))
    sr.deny(den.id, "dup")
    out = sr.defect_to_wo("556", "Horn - inoperative")
    assert out["request"]["id"] == den.id
    assert out["request"]["status"] == "on_wo"
    print("OK defect_to_wo crea/reusa el request y lo liga")


def test_defect_recurrence_after_close():
    """Defecto cerrado por una persona (WO completada / denegado) que sale de
    un feed exitoso (resuelto en el ELD) y se vuelve a reportar => request
    NUEVO; la fila vieja queda archivada con su estado y su WO."""
    base = list(STATE["feed"]["defects"])
    fixed, junk = "Lights - headlight out", "Mirror - loose"
    with_rc = {"available": True, "source": "samsara", "defects": [
        *base, _defect("RC1", fixed), _defect("RC1", junk)]}
    STATE["feed"] = with_rc
    _sync()
    k_fixed = sr.defect_key("RC1", fixed)
    k_junk = sr.defect_key("RC1", junk)
    old_fixed, old_junk = _row(k_fixed), _row(k_junk)
    wo_id = sr.create_wo([old_fixed.id], mechanic="Luis")["workorder"]["id"]
    workorders.update_wo(wo_id, {"status": "completed"})
    sr.deny(old_junk.id, "driver error")

    # Siguen en el feed (nadie los resolvió en el ELD): no se duplican.
    assert _sync()["created"] == 0
    assert _row(k_fixed).id == old_fixed.id and _row(k_junk).id == old_junk.id

    # Se resuelven en el ELD (salen de un feed exitoso)...
    STATE["feed"] = {"available": True, "source": "samsara", "defects": base}
    _sync()
    assert _row(k_fixed).source_active is False
    assert _row(k_fixed).status == "done", "el cierre por WO no se toca"
    # ...y se vuelven a reportar: requests nuevos, los viejos archivados.
    STATE["feed"] = with_rc
    res = _sync()
    assert res["created"] == 2, res
    new_fixed = _row(k_fixed)
    assert new_fixed.id != old_fixed.id and new_fixed.status == "open"
    arch = _row(f"{k_fixed}#{old_fixed.id}")
    assert (arch.status, arch.resolution, arch.wo_id) == ("done", "wo", wo_id)
    assert _row(k_junk).status == "open"
    assert _row(f"{k_junk}#{old_junk.id}").status == "denied"
    # La WO conserva su vínculo histórico; el sync sigue idempotente.
    assert [x["id"] for x in workorders.get_wo(wo_id)["service_requests"]] \
        == [old_fixed.id]
    assert _sync()["created"] == 0
    print("OK defecto re-reportado tras cerrarse => request nuevo (archiva)")


def test_list_units_summary():
    # Unidades limpias para ordenar: emergency > urgent > normal > low y,
    # a igual prioridad, más millas de PM vencidas primero.
    STATE["feed"] = {"available": True, "source": "samsara", "defects": [
        _defect("U-NORMAL", "Mirror - cracked")]}
    STATE["pm"] = {"upcoming_miles": 2000, "units": [
        _pm("U-PM-BIG", -3000, model="2020 International LT"),
        _pm("U-PM-SMALL", -200)]}
    STATE["dot"] = {"upcoming_days": 30, "units": [_dot("U-DOT", -5)]}
    _sync()
    sr.create_manual("U-LOW", "Wash", priority="low")

    out = sr.list_requests("open")
    order = [u["unit"] for u in out["units"]]
    want = ["U-DOT", "U-PM-BIG", "U-PM-SMALL", "U-NORMAL", "U-LOW"]
    assert [u for u in order if u in want] == want, order
    first = out["units"][0]
    assert first["unit"] == "U-DOT" and first["top_priority"] == "emergency"
    assert first["by_source"] == {"defect": 0, "pm": 0, "dot": 1,
                                  "manual": 0}
    big = next(u for u in out["units"] if u["unit"] == "U-PM-BIG")
    assert big["worst_overdue_miles"] == 3000
    assert big["model"] == "2020 International LT"
    assert next(u for u in out["units"]
                if u["unit"] == "U-NORMAL")["worst_overdue_miles"] is None
    assert all(r["status"] == "open" for r in out["requests"])
    assert out["synced_at"]
    # Los requests salen por prioridad.
    prios = [sr._PRIO_RANK[r["priority"]] for r in out["requests"]]
    assert prios == sorted(prios, reverse=True)
    assert set(out["counts"]) == {"open", "snoozed", "on_wo", "done",
                                  "denied"}
    assert out["counts"]["open"] == len(out["requests"])

    # Filtros: unit (requests + counts) y source; units ignora `unit`.
    one = sr.list_requests("open", unit="U-DOT")
    assert [r["unit"] for r in one["requests"]] == ["U-DOT"]
    assert one["counts"]["open"] == 1
    assert len(one["units"]) == len(out["units"])
    pm_only = sr.list_requests("open", source="pm")
    assert {r["source"] for r in pm_only["requests"]} == {"pm"}
    assert all(u["by_source"]["pm"] == u["open"] for u in pm_only["units"])
    allr = sr.list_requests("all")
    assert len(allr["requests"]) == sum(allr["counts"].values())
    _raises(sr.list_requests, "bogus", contains="status must be")
    _raises(sr.list_requests, "open", source="bogus", contains="source")
    print(f"OK resumen por unidad ordenado: {order[:5]}")


def test_tenant_isolation():
    with db.SessionLocal() as s:
        other = db.Organization(slug="other-shop", name="Other", active=True,
                                created_at=datetime.now())
        s.add(other)
        s.commit()
        other_id = other.id
    mine = sr.list_requests("all")
    tok = tenant.set_current_org(other_id)
    try:
        sr.create_manual("X-1", "Other tenant request")
        theirs = sr.list_requests("all")
        assert [r["unit"] for r in theirs["requests"]] == ["X-1"]
        assert theirs["counts"]["open"] == 1
    finally:
        tenant.reset_current_org(tok)
    again = sr.list_requests("all")
    assert again["counts"] == mine["counts"], "conteos no cruzan tenants"
    assert "X-1" not in {r["unit"] for r in again["requests"]}
    print("OK aislamiento por tenant (lista + conteos)")


def test_routes_and_rbac():
    from fastapi import HTTPException

    from app.api import routes
    from app.main import _scope_for

    paths = {r.path for r in routes.router.routes}
    for p in ("/api/service-requests", "/api/service-requests/sync",
              "/api/service-requests/create-wo",
              "/api/service-requests/defect-to-wo",
              "/api/service-requests/delete",
              "/api/service-requests/restore",
              "/api/service-requests/delete-duplicates",
              "/api/service-requests/{req_id}",
              "/api/service-requests/{req_id}/deny",
              "/api/service-requests/{req_id}/snooze",
              "/api/service-requests/{req_id}/reopen",
              "/api/service-requests/{req_id}/add-to-wo",
              "/api/service-requests/{req_id}/unlink"):
        assert p in paths, p
    assert not [p for p in paths if "walk" in p or "workflow" in p], \
        "walkaround / workflows retirados"
    assert _scope_for("POST", "/api/service-requests/create-wo") == \
        "maint.edit"
    assert _scope_for("PATCH", "/api/service-requests/3") == "maint.edit"
    for p in ("delete", "restore", "delete-duplicates"):
        assert _scope_for("POST", f"/api/service-requests/{p}") == \
            "maint.edit", p
    assert _scope_for("GET", "/api/service-requests") is None
    # Las literales van ANTES de las dinámicas /{req_id}.
    order = [r.path for r in routes.router.routes]
    first_dyn = min(i for i, p in enumerate(order)
                    if p.startswith("/api/service-requests/{req_id}"))
    for p in ("delete", "restore", "delete-duplicates"):
        assert order.index(f"/api/service-requests/{p}") < first_dyn, p

    # GET: un sync que falla no rompe la lista.
    real = sr.sync

    async def _broken(force=False):
        raise RuntimeError("down")
    sr.sync = _broken
    try:
        out = asyncio.run(routes.sr_list("open", "", ""))
        assert "requests" in out and "units" in out
    finally:
        sr.sync = real
    # PATCH: solo campos presentes; follow_up_date null explícito la limpia.
    m = sr.create_manual("R-1", "Patch me", follow_up_date="2026-12-24")
    p = routes.sr_patch(m["id"], routes.ServiceRequestPatch(title="Patched"))
    assert p["title"] == "Patched" and p["follow_up_date"] == "2026-12-24"
    p = routes.sr_patch(m["id"],
                        routes.ServiceRequestPatch(follow_up_date=None))
    assert p["title"] == "Patched" and p["follow_up_date"] is None
    try:
        routes.sr_patch(m["id"], routes.ServiceRequestPatch(priority="asap"))
        raise AssertionError("debió dar 400")
    except HTTPException as exc:
        assert exc.status_code == 400
    try:
        routes.sr_reopen(999_999)
        raise AssertionError("debió dar 404")
    except HTTPException as exc:
        assert exc.status_code == 404
    try:
        routes.sr_deny(999_999, None)
        raise AssertionError("debió dar 404")
    except HTTPException as exc:
        assert exc.status_code == 404
    print("OK rutas registradas, RBAC y GET tolerante a fallas del sync")


def test_board_reports_samsara_errors():
    """maint.board NO levanta si Samsara falla: arma el board igual y lo
    avisa en `errors` (el sync no da nada por resuelto con ese board)."""
    from app.core import samsara
    saved = (samsara.is_available, samsara.vehicle_odometers,
             samsara.list_fleet)

    async def _down(*a, **k):
        raise RuntimeError("samsara down")

    samsara.is_available = lambda: True
    samsara.vehicle_odometers = _down
    samsara.list_fleet = _down
    try:
        b = asyncio.run(maint.board("pm"))
    finally:
        (samsara.is_available, samsara.vehicle_odometers,
         samsara.list_fleet) = saved
    assert b["errors"] == ["odometer", "fleet"], b["errors"]
    print("OK maint.board avisa las fallas de Samsara en `errors`")


def _feed(*defects) -> dict:
    return {"available": True, "source": "samsara", "defects": list(defects)}


def test_pm_outage_never_clears():
    """Caída del odómetro: ni el board con `errors` ni una unidad sin dato
    (to_due None, mismo ciclo) auto-cierran el PM; el snooze sobrevive."""
    STATE["pm"] = {"upcoming_miles": 2000, "units": [
        _pm("OUT1", 500, last_miles=10_000),
        _pm("OUT2", 800, last_miles=20_000)]}
    _sync()
    k1, k2 = "pm:OUT1:10000", "pm:OUT2:20000"
    until = (TODAY + timedelta(days=20)).isoformat()
    sr.snooze(_row(k1).id, until)

    # 1) Odómetro caído: OUT1 sin dato y OUT2 "al día" con millas viejas
    #    del CSV. El board avisa el error -> no se resuelve nada.
    STATE["pm"] = {"upcoming_miles": 2000, "errors": ["odometer"], "units": [
        {**_pm("OUT1", 0, last_miles=10_000), "to_due": None,
         "current_miles": None},
        _pm("OUT2", 9_000, last_miles=20_000)]}
    res = _sync()
    assert res["resolved"] == 0, res
    r1, r2 = _row(k1), _row(k2)
    assert (r1.status, r1.snooze_until) == ("snoozed", until)
    assert r2.status == "open"

    # 2) Board sano pero OUT1 sin odómetro (mismo ciclo): sin dato no es
    #    "al día" -> sigue pospuesto.
    STATE["pm"] = {"upcoming_miles": 2000, "units": [
        {**_pm("OUT1", 0, last_miles=10_000), "to_due": None},
        _pm("OUT2", 800, last_miles=20_000)]}
    assert _sync()["resolved"] == 0
    assert _row(k1).status == "snoozed"

    # 3) Al día CON dato -> cleared, pero conserva el snooze; si vuelve a
    #    vencer dentro del snooze, vuelve POSPUESTO (no 'open').
    STATE["pm"] = {"upcoming_miles": 2000, "units": [
        _pm("OUT1", 9_000, last_miles=10_000),
        _pm("OUT2", 800, last_miles=20_000)]}
    assert _sync()["resolved"] == 1
    r1 = _row(k1)
    assert (r1.status, r1.resolution, r1.snooze_until) == (
        "done", "cleared", until)
    STATE["pm"] = {"upcoming_miles": 2000, "units": [
        _pm("OUT1", 500, last_miles=10_000),
        _pm("OUT2", 800, last_miles=20_000)]}
    res = _sync()
    assert res["reopened"] == 0, res
    r1 = _row(k1)
    assert (r1.status, r1.resolution, r1.snooze_until, r1.resolved_at) == (
        "snoozed", "", until, None)
    print("OK caída de Samsara: PM no se auto-cierra y el snooze sobrevive")


def test_defect_to_wo_after_completed_wo():
    """Defecto cerrado por una WO completada que sigue en el ELD: '→ WO' de
    nuevo crea un request NUEVO; la WO vieja conserva su vínculo."""
    detail = "Wipers - streaking"
    key = sr.defect_key("D2W", detail)
    STATE["feed"] = _feed(_defect("D2W", detail))
    _sync()
    first = sr.defect_to_wo("D2W", detail, mechanic="Luis")
    wo1, rid1 = first["workorder"]["id"], first["request"]["id"]
    workorders.update_wo(wo1, {"status": "completed"})
    _sync()                              # sigue en el feed: nadie lo cerró
    assert sr.get_request(rid1)["status"] == "done"

    # v2.21: con un mecánico NUEVO. Esta rama archiva el request viejo
    # (flush) antes de crear la WO: el alta en el roster de técnicos debe
    # ir DESPUÉS del commit o SQLite se traba ("database is locked").
    second = sr.defect_to_wo("D2W", detail, mechanic="Brand New Tech")
    rid2, wo2 = second["request"]["id"], second["workorder"]["id"]
    assert second["workorder"]["mechanic"] == "Brand New Tech"
    assert "Brand New Tech" in workorders.mechanics()
    assert rid2 != rid1 and wo2 != wo1
    assert second["request"]["source_key"] == key
    assert second["request"]["status"] == "on_wo"
    old = sr.get_request(rid1)
    assert (old["status"], old["resolution"], old["wo_id"]) == (
        "done", "wo", wo1)
    assert old["source_key"] == f"{key}#{rid1}"
    assert [x["id"] for x in workorders.get_wo(wo1)["service_requests"]] \
        == [rid1]
    # Retroceder la WO vieja la re-liga a SU request, no al nuevo.
    workorders.update_wo(wo1, {"status": "in_progress"})
    assert sr.get_request(rid1)["status"] == "on_wo"
    assert sr.get_request(rid2)["wo_id"] == wo2
    _sync()
    assert sr.get_request(rid2)["status"] == "on_wo"
    print("OK defect_to_wo tras WO completada: request nuevo, WO vieja intacta")


def test_strict_dates():
    """Solo YYYY-MM-DD: '20261001' / '2026-W40-1' (que fromisoformat acepta
    desde 3.11) romperían la comparación de texto del snooze."""
    m = sr.create_manual("DT1", "Check horn")
    for bad in ("20261001", "2026-W40-1", "2026-10-1", "12/01/2026"):
        _raises(sr.snooze, m["id"], bad, contains="YYYY-MM-DD")
        _raises(sr.update_request, m["id"], {"follow_up_date": bad},
                contains="YYYY-MM-DD")
    _raises(sr.create_manual, "DT1", "x", follow_up_date="20261201",
            contains="YYYY-MM-DD")
    _raises(sr.snooze, m["id"], "2026-02-30", contains="YYYY-MM-DD")
    ok = sr.update_request(m["id"], {"follow_up_date": " 2026-12-01 "})
    assert ok["follow_up_date"] == "2026-12-01"
    print("OK fechas estrictas YYYY-MM-DD")


def test_sync_concurrent_insert_returns_none():
    """Otro thread (defect_to_wo) inserta la misma clave entre el SELECT del
    sync y su flush: el sync devuelve vacío, no explota (antes: 500)."""
    detail = "Horn - weak"
    key = sr.defect_key("CC1", detail)
    STATE["feed"] = _feed(_defect("CC1", detail))
    now = datetime.now()

    def _other_thread_inserts(session, ctx, instances):
        with db.SessionLocal() as s2:
            s2.add(db.ServiceRequest(
                unit="CC1", company="", source="defect", source_key=key,
                title=detail, detail=detail, priority="normal",
                status="open", resolution="", meta="{}", source_active=True,
                deny_reason="", created_by="", created_at=now,
                updated_at=now, source_seen_at=now))
            s2.commit()

    event.listen(db.SessionLocal, "before_flush", _other_thread_inserts,
                 once=True)
    res = _sync()
    assert res["created"] == 0, res
    assert len(_rows(source_key=key)) == 1
    assert _sync()["created"] == 0, "el siguiente sync queda estable"
    print("OK insert concurrente: el sync no explota")


def test_sync_does_not_overwrite_user_action():
    """El usuario crea la WO mientras el sync (que vio desaparecer el
    defecto) corre: gana el usuario — nada de 'cleared' ligado a una WO."""
    detail = "Seat - torn"
    STATE["feed"] = _feed(_defect("RACE", detail))
    _sync()
    rid = _row(sr.defect_key("RACE", detail)).id
    STATE["feed"] = _feed()              # desaparece de un feed exitoso
    made: dict = {}

    def _user_creates_wo(session, ctx, instances):
        made.update(sr.create_wo([rid]))

    event.listen(db.SessionLocal, "before_flush", _user_creates_wo,
                 once=True)
    _sync()
    assert made, "create_wo corrió en medio del sync"
    got = sr.get_request(rid)
    assert (got["status"], got["wo_id"], got["resolution"]) == (
        "on_wo", made["workorder"]["id"], ""), got
    print("OK el sync no pisa la acción del usuario (UPDATE condicional)")


def test_list_history_cap():
    """Lo accionable sale completo; solo el historial tiene tope (+flag)."""
    for i in range(3):
        a = sr.create_manual("CAP", f"Open item {i}")
        b = sr.create_manual("CAP", f"Denied item {i}")
        sr.deny(b["id"])
        assert a["status"] == "open"
    saved = sr.HISTORY_LIMIT
    sr.HISTORY_LIMIT = 2
    try:
        lst = sr.list_requests("open")
        assert lst["counts"]["open"] > 2
        assert len(lst["requests"]) == lst["counts"]["open"]
        assert lst["truncated"] is False
        den = sr.list_requests("denied")
        assert den["counts"]["denied"] > 2
        assert len(den["requests"]) == 2 and den["truncated"] is True
    finally:
        sr.HISTORY_LIMIT = saved
    print("OK lista: accionable sin tope, historial con tope + truncated")


def test_maint_change_marks_stale():
    """Registrar PM/DOT, override o exclusión olvida el TTL del sync."""
    from app.core import pm
    _sync()
    assert ORG in sr._last_sync
    maint.add_record("STALE1", "pm", TODAY.isoformat(), 1000)
    assert ORG not in sr._last_sync
    _sync()
    pm.set_excluded("STALE1", True)
    assert ORG not in sr._last_sync
    _sync()
    pm.set_override("STALE1", "current_miles", 5000)
    assert ORG not in sr._last_sync
    pm.set_override("STALE1", "current_miles", None)
    pm.set_excluded("STALE1", False)
    print("OK cambios de PM/DOT olvidan el TTL del sync")


def test_list_wos_keeps_active_beyond_cap():
    """Una WO activa vieja no se cae de la lista por el tope de historial."""
    old = workorders.create_wo("CAPWO", "Old open job", mechanic="Luis")
    for i in range(3):
        w = workorders.create_wo("CAPWO", f"Done job {i}", mechanic="Luis")
        workorders.add_line(w["id"], "labor", "Work", 1, 10)
        workorders.update_wo(w["id"], {"status": "invoiced"})
    got = workorders.list_wos(unit="CAPWO", limit=2)
    ids = [w["id"] for w in got]
    assert old["id"] in ids, ids
    assert sum(1 for w in got if w["status"] == "invoiced") == 2
    assert ids == sorted(ids, reverse=True)
    assert len(workorders.list_wos("invoiced", "CAPWO", limit=2)) == 2
    print("OK list_wos: activas completas + últimas N facturadas")


# ----- Addendum v2.20: borrado suave, duplicados, unidad canónica -----------

def _mk(unit, title, detail="", source="manual", created_at=None,
        status="open", seen=None) -> int:
    """Inserta un request a mano (controla created_at para el keeper)."""
    now = datetime.now()
    with db.SessionLocal() as s:
        r = db.ServiceRequest(
            unit=unit, company="", source=source,
            source_key=f"{source}:t:{uuid.uuid4().hex}", title=title,
            detail=detail, priority="normal", status=status, resolution="",
            meta="{}", source_active=True, deny_reason="", created_by="",
            created_at=created_at or now, updated_at=now,
            source_seen_at=seen)
        s.add(r)
        s.commit()
        return r.id


def _ids(lst: dict) -> set[int]:
    return {r["id"] for r in lst["requests"]}


def test_delete_and_restore():
    a = sr.create_manual("DEL1", "Fix door latch")
    b = sr.create_manual("DEL1", "Fix seat belt")
    snz = sr.create_manual("DEL1", "Check wipers")
    snz_until = (TODAY + timedelta(days=5)).isoformat()
    sr.snooze(snz["id"], snz_until)
    den = sr.create_manual("DEL1", "Paint bumper")
    sr.deny(den["id"], "cosmetic")
    on = sr.create_manual("DEL1", "Replace mirror")
    wo = sr.create_wo([on["id"]])["workorder"]
    done = sr.create_manual("DEL1", "Grease")
    wo_done = sr.create_wo([done["id"]], mechanic="Luis")["workorder"]
    workorders.update_wo(wo_done["id"], {"status": "completed"})
    assert sr.get_request(done["id"])["status"] == "done"
    before = sr.list_requests("all")

    out = sr.delete_requests([a["id"], snz["id"], den["id"], on["id"],
                              999_999, a["id"], done["id"]])
    assert out["deleted"] == [a["id"], snz["id"], den["id"], done["id"]], out
    assert out["skipped"] == [
        {"id": on["id"],
         "reason": f"on work order #{wo['id']} — unlink it first"},
        {"id": 999_999, "reason": "not found"}], out
    # Ya borrado: se ignora en silencio.
    assert sr.delete_requests([a["id"]]) == {"deleted": [], "skipped": []}
    assert sr.delete_requests([]) == {"deleted": [], "skipped": []}
    g = sr.get_request(a["id"])
    assert (g["status"], g["resolution"]) == ("deleted", "deleted")
    assert g["resolved_at"]
    assert sr.get_request(snz["id"])["snooze_until"] is None
    assert sr.get_request(on["id"])["status"] == "on_wo", "on_wo intacto"

    # Fuera de TODO: listas (incluida 'all'), conteos y units.
    gone = {a["id"], snz["id"], den["id"], done["id"]}
    allr = sr.list_requests("all")
    assert not gone & _ids(allr)
    assert "deleted" not in allr["counts"]
    assert len(allr["requests"]) == sum(allr["counts"].values())
    assert sum(allr["counts"].values()) == \
        sum(before["counts"].values()) - len(gone)
    assert allr["counts"]["snoozed"] == before["counts"]["snoozed"] - 1
    assert allr["counts"]["denied"] == before["counts"]["denied"] - 1
    for st in ("open", "snoozed", "done", "denied"):
        assert not gone & _ids(sr.list_requests(st)), st
    one = sr.list_requests("all", unit="DEL1")
    assert _ids(one) == {b["id"], on["id"]}, _ids(one)
    u = next(x for x in sr.list_requests("open")["units"]
             if x["unit"] == "DEL1")
    assert u["open"] == 1
    _raises(sr.list_requests, "deleted", contains="status must be")
    # La WO cerrada ya no lista el request borrado.
    assert workorders.get_wo(wo_done["id"])["service_requests"] == []
    _raises(sr.reopen, a["id"], contains="restore it instead")
    # Una unidad con TODO borrado no sale en units.
    solo = sr.create_manual("DEL2", "Only one")
    sr.delete_requests([solo["id"]])
    assert "DEL2" not in {x["unit"] for x in
                          sr.list_requests("open")["units"]}

    # Restore (Undo): vuelve al estado que tenía ANTES del borrado; lo que
    # no está borrado se ignora.
    res = sr.restore_requests([a["id"], b["id"], 999_999, done["id"],
                               snz["id"]])
    assert res == {"restored": [a["id"], done["id"], snz["id"]]}, res
    g = sr.get_request(a["id"])
    assert (g["status"], g["resolution"], g["resolved_at"],
            g["snooze_until"], g["wo_id"]) == ("open", "", None, None,
                                               None), g
    # Cerrado por su WO: vuelve cerrado y LIGADO (nunca como backlog
    # pendiente: invitaría a una segunda WO por trabajo ya hecho).
    g = sr.get_request(done["id"])
    assert (g["status"], g["resolution"], g["wo_id"]) == (
        "done", "wo", wo_done["id"]), g
    assert g["resolved_at"]
    assert [x["id"] for x in workorders.get_wo(wo_done["id"])[
        "service_requests"]] == [done["id"]]
    _raises(sr.reopen, done["id"], contains="completed by a work order")
    # Pospuesto: vuelve pospuesto con su fecha. El meta interno no sale.
    g = sr.get_request(snz["id"])
    assert (g["status"], g["snooze_until"]) == ("snoozed", snz_until), g
    assert "_pre_delete" not in g["meta"]
    assert sr.restore_requests([]) == {"restored": []}
    assert sr.get_request(den["id"])["status"] == "deleted"
    # Denegado: vuelve denegado con su motivo.
    assert sr.restore_requests([den["id"]]) == {"restored": [den["id"]]}
    g = sr.get_request(den["id"])
    assert (g["status"], g["resolution"], g["deny_reason"]) == (
        "denied", "denied", "cosmetic"), g
    assert g["resolved_at"]

    # Lo que ya no aplica cae al backlog: snooze vencido mientras estaba
    # borrado -> open; la WO volvió atrás -> on_wo; la WO ya no existe ->
    # open sin WO.
    late = sr.create_manual("DEL1", "Check horn")
    sr.snooze(late["id"], (TODAY + timedelta(days=2)).isoformat())
    sr.delete_requests([late["id"]])
    with db.SessionLocal() as s:
        row = s.get(db.ServiceRequest, late["id"])
        meta = sr._meta(row)
        meta["_pre_delete"]["snooze_until"] = (
            TODAY - timedelta(days=1)).isoformat()
        row.meta = json.dumps(meta)
        s.commit()
    sr.restore_requests([late["id"]])
    g = sr.get_request(late["id"])
    assert (g["status"], g["snooze_until"]) == ("open", None), g
    back = sr.create_manual("DEL1", "Fix step")
    wo_back = sr.create_wo([back["id"]], mechanic="Luis")["workorder"]
    workorders.update_wo(wo_back["id"], {"status": "completed"})
    sr.delete_requests([back["id"]])
    workorders.update_wo(wo_back["id"], {"status": "in_progress"})
    sr.restore_requests([back["id"]])
    g = sr.get_request(back["id"])
    assert (g["status"], g["wo_id"]) == ("on_wo", wo_back["id"]), g
    gone_wo = sr.create_manual("DEL1", "Fix bunk light")
    wo_gone = sr.create_wo([gone_wo["id"]], mechanic="Luis")["workorder"]
    workorders.update_wo(wo_gone["id"], {"status": "completed"})
    sr.delete_requests([gone_wo["id"]])
    workorders.delete_wo(wo_gone["id"])
    sr.restore_requests([gone_wo["id"]])
    g = sr.get_request(gone_wo["id"])
    assert (g["status"], g["resolution"], g["wo_id"]) == ("open", "", None), g

    # Rutas (cuerpo {ids} / {unit?}).
    from app.api import routes
    r = routes.sr_delete(routes.SrIdsIn(ids=[b["id"]]))
    assert r == {"deleted": [b["id"]], "skipped": []}
    assert routes.sr_restore(routes.SrIdsIn(ids=[b["id"]])) == {
        "restored": [b["id"]]}
    print("OK delete / restore: on_wo se saltea, not found, fuera de listas")


def test_sync_never_resurrects_deleted():
    """Borrado con la fuente ACTIVA: el sync no lo revive ni lo recrea."""
    detail = "Horn - stuck on"
    key = sr.defect_key("RES1", detail)
    STATE["feed"] = _feed(_defect("RES1", detail))
    STATE["pm"] = {"upcoming_miles": 2000, "units": [
        _pm("RES1", -300, last_miles=40_000)]}
    STATE["dot"] = {"upcoming_days": 30, "units": []}
    _sync()
    d, p = _row(key), _row("pm:RES1:40000")
    p_until = (TODAY + timedelta(days=9)).isoformat()
    sr.snooze(p.id, p_until)
    out = sr.delete_requests([d.id, p.id])
    assert out["deleted"] == [d.id, p.id]
    for _ in range(2):
        res = _sync()
        assert res["created"] == 0 and res["reopened"] == 0, res
    assert _row(key).status == "deleted" and _row(key).id == d.id
    assert _row("pm:RES1:40000").status == "deleted"
    # PM: sale del board (exitoso) y vuelve a vencer EN EL MISMO CICLO ->
    # sigue borrado (solo un ciclo nuevo trae un request nuevo).
    STATE["pm"] = {"upcoming_miles": 2000, "units": [
        _pm("RES1", 9_000, last_miles=40_000)]}
    _sync()
    STATE["pm"] = {"upcoming_miles": 2000, "units": [
        _pm("RES1", -10, last_miles=40_000)]}
    assert _sync()["created"] == 0
    assert _row("pm:RES1:40000").status == "deleted"
    assert len(_rows(unit="RES1", source="pm")) == 1
    lst = sr.list_requests("all", unit="RES1")
    assert lst["requests"] == [] and sum(lst["counts"].values()) == 0
    # El sync refresca el meta de la fila borrada pero CONSERVA su estado
    # previo: el Undo devuelve el PM pospuesto con su fecha.
    assert "_pre_delete" in sr._meta(_row("pm:RES1:40000"))
    assert sr.restore_requests([p.id]) == {"restored": [p.id]}
    g = sr.get_request(p.id)
    assert (g["status"], g["snooze_until"]) == ("snoozed", p_until), g
    assert g["meta"]["board_unit"] == "RES1"
    print("OK el sync no revive un defecto / PM borrado con la fuente activa")


def test_deleted_defect_reappears_after_clear():
    """Defecto borrado que se resuelve en el ELD y se vuelve a reportar =>
    request NUEVO; el viejo queda archivado ('<key>#<id>', borrado)."""
    detail = "Mudflap - missing"
    key = sr.defect_key("RES2", detail)
    STATE["feed"] = _feed(_defect("RES2", detail))
    _sync()
    old = _row(key)
    sr.delete_requests([old.id])
    STATE["feed"] = _feed()                          # resuelto en el ELD
    _sync()
    r = _row(key)
    assert (r.status, r.source_active) == ("deleted", False)
    STATE["feed"] = _feed(_defect("RES2", detail))   # vuelve a aparecer
    res = _sync()
    assert res["created"] == 1, res
    new = _row(key)
    assert new.id != old.id and new.status == "open"
    arch = _row(f"{key}#{old.id}")
    assert arch.id == old.id and arch.status == "deleted"
    assert _sync()["created"] == 0, "idempotente"
    print("OK defecto borrado que reaparece tras resolverse => request nuevo")


def test_duplicates_rules():
    base = datetime.now() - timedelta(days=10)
    t = lambda h: base + timedelta(hours=h)      # noqa: E731
    U = "DUP1"
    # Texto igual tras normalizar (manual vs defecto): se queda el DEFECTO
    # (fila de sistema con la fuente activa) aunque el manual sea más viejo.
    m1 = _mk(U, "Brakes - chamber leaking", created_at=t(0))
    k1 = _mk(U, "x", detail="brakes   chamber LEAKING!", source="defect",
             created_at=t(1))
    # Contenido (≥ 12 caracteres, por palabras).
    k2 = _mk(U, "Left marker light out", created_at=t(2))
    d2 = _mk(U, "Left marker light out on trailer side", created_at=t(3))
    # Jaccard ≥ 0.8 (4 de 5 palabras, otro orden).
    k3 = _mk(U, "check horn wiring relay", created_at=t(4))
    d3 = _mk(U, "relay wiring horn check fuse", created_at=t(5))
    # pm↔pm (textos distintos) y dot↔dot.
    k4 = _mk(U, "PM due", detail="Cycle A", source="pm", created_at=t(6))
    d4 = _mk(U, "PM due", detail="Cycle B", source="pm", created_at=t(7))
    # NO duplicados: corto (< 12), Jaccard bajo, palabra parcial.
    n1 = _mk(U, "Fix seat", created_at=t(8))
    n2 = _mk(U, "Fix seat cover", created_at=t(9))
    n3 = _mk(U, "brake light out", created_at=t(10))
    n4 = _mk(U, "rear brake light outlet", created_at=t(11))
    # Fuera del cálculo: on_wo / done / borrado con el mismo texto.
    _mk(U, "Brakes chamber leaking", status="done", created_at=t(-5))
    _mk(U, "Brakes chamber leaking", status="deleted", created_at=t(-4))
    # Snoozed SÍ cuenta.
    s1 = _mk(U, "Brakes: chamber leaking", status="snoozed", created_at=t(12))
    # Otra unidad con el mismo texto: no es duplicado (otra unidad).
    o1 = _mk("DUP9", "Brakes - chamber leaking", created_at=t(-1))

    lst = sr.list_requests("open", unit=U)
    dup = {r["id"]: r["duplicate_of"] for r in lst["requests"]}
    assert dup[k1] is None and dup[m1] == k1, dup
    assert dup[k2] is None and dup[d2] == k2
    assert dup[k3] is None and dup[d3] == k3
    assert dup[k4] is None and dup[d4] == k4
    for n in (n1, n2, n3, n4):
        assert dup[n] is None, n
    assert sr.list_requests("snoozed", unit=U)["requests"][0][
        "duplicate_of"] == k1
    assert {r["id"]: r["duplicate_of"] for r in sr.list_requests(
        "open", unit="DUP9")["requests"]} == {o1: None}
    # El historial no trae duplicate_of.
    assert all(r["duplicate_of"] is None
               for r in sr.list_requests("done", unit=U)["requests"])
    # Un request suelto también lo trae (get_request / mutaciones).
    assert sr.get_request(m1)["duplicate_of"] == k1
    assert sr.update_request(d2, {"priority": "urgent"})[
        "duplicate_of"] == k2
    u = next(x for x in lst["units"] if x["unit"] == U)
    assert u["duplicates"] == 5, u               # m1 d2 d3 d4 s1
    # Con filtro de source el keeper no cambia (se calcula sin filtros).
    only_man = sr.list_requests("open", unit=U, source="manual")
    assert {r["id"]: r["duplicate_of"] for r in only_man["requests"]
            if r["id"] == m1} == {m1: k1}

    # Contra el KEEPER, no en cadena: A~B (contenido), B~C (Jaccard),
    # A !~ C. C (el más viejo) es keeper, B es su duplicado y A —que solo se
    # parecía a B— queda como request propio.
    V = "DUP2"
    c = _mk(V, "wiring loose and out headlight left", created_at=t(0))
    a = _mk(V, "left headlight out", created_at=t(1))
    b = _mk(V, "left headlight out and wiring loose", created_at=t(2))
    # Empate de created_at -> id menor.
    e1 = _mk(V, "Coolant leak at radiator hose", created_at=t(5))
    e2 = _mk(V, "coolant leak at radiator hose", created_at=t(5))
    dup = {r["id"]: r["duplicate_of"]
           for r in sr.list_requests("open", unit=V)["requests"]}
    assert dup == {c: None, a: None, b: c, e1: None, e2: e1}, dup
    # Un request combinado NO arrastra a otro distinto al grupo del primero
    # (antes: 'Fix door handle' salía duplicado de 'Replace left mirror').
    W = "DUP3"
    mir = _mk(W, "Replace left mirror", created_at=t(0))
    both = _mk(W, "Replace left mirror and fix door handle", created_at=t(1))
    door = _mk(W, "Fix door handle", created_at=t(2))
    dup = {r["id"]: r["duplicate_of"]
           for r in sr.list_requests("open", unit=W)["requests"]}
    assert dup == {mir: None, both: mir, door: None}, dup
    assert sr._duplicates([]) == {}
    print("OK duplicados: igual / contenido / Jaccard / pm<->pm, contra el "
          "keeper (sin cadenas)")


def test_duplicates_side_specific():
    """Defectos casi iguales que difieren en el LADO / la posición / el eje
    son fallas distintas: no son duplicados (borrar uno escondería una falla
    real que el sync no revive mientras siga reportada)."""
    base = datetime.now() - timedelta(days=3)
    U = "SIDE1"
    pairs = [
        ("Brakes - Air leak at the rear axle driver side brake chamber",
         "Brakes - Air leak at the rear axle passenger side brake chamber"),
        ("Tires - Left front steer tire tread depth below 4/32 needs "
         "replacement",
         "Tires - Right front steer tire tread depth below 4/32 needs "
         "replacement"),
        ("Lights - Marker light out on left side of trailer near the rear",
         "Lights - Marker light out on right side of trailer near the rear"),
        ("Suspension - cracked spring hanger on axle 2 needs welding repair",
         "Suspension - cracked spring hanger on axle 3 needs welding repair"),
    ]
    ids = []
    for i, (x, y) in enumerate(pairs):
        ids.append(_mk(U, "x", detail=x, source="defect",
                       created_at=base + timedelta(hours=2 * i)))
        ids.append(_mk(U, "x", detail=y, source="defect",
                       created_at=base + timedelta(hours=2 * i + 1)))
    # Control: la misma falla con una palabra de menos SÍ es duplicado.
    same = _mk(U, "x", detail="Brakes - Air leak at rear axle driver side "
               "brake chamber", source="defect",
               created_at=base + timedelta(hours=20))
    dup = {r["id"]: r["duplicate_of"]
           for r in sr.list_requests("open", unit=U)["requests"]}
    assert all(dup[i] is None for i in ids), dup
    assert dup[same] == ids[0], dup
    assert sr.delete_duplicates(U)["deleted"] == [same]
    print("OK duplicados: lado / posición / eje distintos no son duplicados")


def test_duplicate_keeper_preference():
    """El keeper NO es simplemente el más viejo: fila de sistema activa >
    open > vista más recientemente por su fuente > más vieja."""
    old = datetime.now() - timedelta(days=30)
    # 1) Un manual 'DOT inspection' anterior al vencimiento real: se queda
    #    la fila de sistema (DOT), se borra el manual; la DOT sigue abierta.
    STATE["dot"] = {"upcoming_days": 30, "units": [_dot("KP1", -2)]}
    man = _mk("KP1", "DOT inspection", created_at=old)
    _sync()
    dot = _row("dot:KP1:2025-10-01")
    dup = {r["id"]: r["duplicate_of"]
           for r in sr.list_requests("open", unit="KP1")["requests"]}
    assert dup == {man: dot.id, dot.id: None}, dup
    assert sr.delete_duplicates("kp1") == {"deleted": [man], "skipped": []}
    assert sr.get_request(dot.id)["status"] == "open"
    STATE["dot"] = {"upcoming_days": 30, "units": []}

    # 2) Un pospuesto viejo + un re-reporte abierto: se queda el ABIERTO
    #    (borrar el abierto escondería el defecto hasta que venza el snooze).
    snz = _mk("KP2", "x", detail="Brake light out left side",
              source="defect", status="snoozed", created_at=old)
    opn = _mk("KP2", "x", detail="Brake light out left side rear",
              source="defect")
    dup = {r["id"]: r["duplicate_of"] for r in sr.list_requests(
        "all", unit="KP2")["requests"]}
    assert dup == {snz: opn, opn: None}, dup

    # 3) pm↔pm: el ciclo vigente (visto por el board en el último sync) se
    #    queda; el viejo que una caída dejó sin cerrar es el duplicado.
    stale = _mk("KP3", "PM due", detail="cycle 100000", source="pm",
                created_at=old, seen=old)
    cur = _mk("KP3", "PM due", detail="cycle 115000", source="pm",
              seen=datetime.now())
    dup = {r["id"]: r["duplicate_of"] for r in sr.list_requests(
        "open", unit="KP3")["requests"]}
    assert dup == {stale: cur, cur: None}, dup
    print("OK keeper: sistema activo > open > ciclo vigente > más viejo")


def test_delete_duplicates():
    """delete_duplicates(unit) borra solo los de esa unidad (normalizada);
    sin unidad, los de toda la flota. Los keepers quedan abiertos."""
    U, V = "DUP1", "DUP2"
    before_u = {r["id"]: r["duplicate_of"] for r in sr.list_requests(
        "all", unit=U)["requests"] if r["duplicate_of"]}
    snoozed_dups = {r["id"] for r in sr.list_requests(
        "snoozed", unit=U)["requests"] if r["duplicate_of"]}
    out = sr.delete_duplicates(" dup 1 ")
    assert set(out["deleted"]) == set(before_u) | snoozed_dups, out
    assert out["skipped"] == []
    for keeper in set(before_u.values()):
        assert sr.get_request(keeper)["status"] == "open"
    left = sr.list_requests("open", unit=U)
    assert all(r["duplicate_of"] is None for r in left["requests"])
    assert next(x for x in left["units"] if x["unit"] == U)[
        "duplicates"] == 0
    # La otra unidad sigue con sus duplicados.
    assert any(r["duplicate_of"] for r in sr.list_requests(
        "open", unit=V)["requests"])
    # De toda la flota (vía ruta).
    from app.api import routes
    fleet_dups = {r["id"] for r in sr.list_requests("all")["requests"]
                  if r["duplicate_of"]}
    v_dups = {r["id"] for r in sr.list_requests("open", unit=V)["requests"]
              if r["duplicate_of"]}
    assert len(v_dups) == 2 and v_dups <= fleet_dups   # b, e2 de DUP2
    out2 = routes.sr_delete_duplicates(routes.SrDeleteDupsIn())
    assert set(out2["deleted"]) == fleet_dups, out2
    assert not any(r["duplicate_of"] for r in sr.list_requests(
        "open")["requests"])
    assert sr.delete_duplicates() == {"deleted": [], "skipped": []}
    # Undo del borrado de duplicados.
    assert sr.restore_requests(out2["deleted"])["restored"] == out2[
        "deleted"]
    assert {r["id"] for r in sr.list_requests("open", unit=V)["requests"]
            if r["duplicate_of"]} == v_dups
    print("OK delete_duplicates por unidad (normalizada) y de toda la flota")


def test_unit_canonicalization():
    sr.reset_sync_cache()
    STATE["fleet"] = []
    STATE["pm"] = {"upcoming_miles": 2000, "units": [
        _pm("CAN1", -50, last_miles=70_000)]}
    STATE["dot"] = {"upcoming_days": 30, "units": []}
    detail = "Tail light - cracked lens"
    STATE["feed"] = _feed(_defect("CAN1", detail))
    _sync()
    dkey = sr.defect_key("CAN1", detail)
    d0, p0 = _row(dkey), _row("pm:CAN1:70000")
    assert d0.unit == "CAN1" and p0.unit == "CAN1", "sin flota: como vino"
    legacy = sr.create_manual("can1", "Wash trailer")     # sin índice
    assert legacy["unit"] == "can1"
    on_wo = sr.create_manual("can 1", "Fix step")
    sr.create_wo([on_wo["id"]])

    # Aparece la flota con 'CAN 1': el sync renombra SIN crear filas.
    STATE["fleet"] = ["CAN 1", "CAN2", "Mrg 5"]
    res = _sync()
    assert res["created"] == 0, res
    d1, p1 = _row(dkey), _row("pm:CAN1:70000")
    assert (d1.id, d1.unit) == (d0.id, "CAN 1")
    assert (p1.id, p1.unit) == (p0.id, "CAN 1")
    assert sr.get_request(legacy["id"])["unit"] == "CAN 1"
    assert sr.get_request(on_wo["id"])["unit"] == "CAN 1"
    # El feed lo sigue reportando como 'CAN1': ni fila nueva ni rename atrás.
    assert _sync()["created"] == 0
    assert _row(dkey).unit == "CAN 1"
    assert len(_rows(source="defect", detail=detail)) == 1

    # create_manual canoniza y valida contra el índice.
    idx = asyncio.run(sr.unit_index("can1"))
    assert idx.get("CAN1") == "CAN 1" and idx.get("MRG5") == "Mrg 5"
    m = sr.create_manual("can1", "Check tires", units=idx)
    assert m["unit"] == "CAN 1"
    _raises(sr.create_manual, "ZZZ-404", "x", units=idx,
            contains="unknown unit — pick one from the fleet list")
    assert sr.create_manual("ZZZ-404", "x", units={})["unit"] == "ZZZ-404"
    assert sr.create_manual("ZZZ-405", "x", units=None)["unit"] == "ZZZ-405"

    # units[] funde variantes de escritura (nombre canónico de la flota).
    _mk("MRG5", "Mrg request one")
    _mk("mrg 5", "Mrg request two")
    lst = sr.list_requests("open")
    mrg = [u for u in lst["units"] if sr._norm_unit(u["unit"]) == "MRG5"]
    assert len(mrg) == 1 and mrg[0]["unit"] == "Mrg 5" and \
        mrg[0]["open"] == 2, mrg
    can = [u for u in lst["units"] if sr._norm_unit(u["unit"]) == "CAN1"]
    assert len(can) == 1 and can[0]["unit"] == "CAN 1"
    # ?unit= compara normalizado.
    assert len(sr.list_requests("open", unit="mrg5")["requests"]) == 2
    assert sr.list_requests("open", unit="MRG 5")["counts"]["open"] == 2
    # Fuera de la flota: la escritura más usada.
    _mk("XQ 1", "Var one")
    _mk("XQ 1", "Var two")
    _mk("xq1", "Var three")
    xq = [u for u in sr.list_requests("open")["units"]
          if sr._norm_unit(u["unit"]) == "XQ1"]
    assert len(xq) == 1 and xq[0]["unit"] == "XQ 1" and xq[0]["open"] == 3

    # Rutas: create canoniza / 400 con unidad desconocida.
    from fastapi import HTTPException

    from app.api import routes
    req = SimpleNamespace(state=SimpleNamespace(user={"name": "Ana"}))
    sr.reset_sync_cache()
    made = asyncio.run(routes.sr_create(
        routes.ServiceRequestIn(unit="can2", title="Via route"), req))
    assert made["unit"] == "CAN2" and made["created_by"] == "Ana"
    try:
        asyncio.run(routes.sr_create(
            routes.ServiceRequestIn(unit="NOPE-1", title="x"), req))
        raise AssertionError("debió dar 400")
    except HTTPException as exc:
        assert exc.status_code == 400 and exc.detail == sr.UNKNOWN_UNIT
    # Unidad recién agregada a la flota: el índice cacheado no la tiene ->
    # se reconstruye (no hay que esperar al próximo sync).
    STATE["fleet"] = [*STATE["fleet"], "NEW 9"]
    made = asyncio.run(routes.sr_create(
        routes.ServiceRequestIn(unit="new9", title="Fresh unit"), req))
    assert made["unit"] == "NEW 9"
    # defect-to-wo: la unidad del feed (fuera de la flota, p.ej. MCC del
    # CSV) es válida; una que no está en ningún lado, no.
    STATE["feed"] = _feed(_defect("MCC 12", "Door - won't latch",
                                  company="MCC"))
    got = asyncio.run(routes.sr_defect_to_wo(routes.SrDefectToWoIn(
        unit="MCC 12", detail="Door - won't latch")))
    assert got["request"]["unit"] == "MCC 12"
    got = asyncio.run(routes.sr_defect_to_wo(routes.SrDefectToWoIn(
        unit="can2", detail="Hood latch broken")))
    assert got["request"]["unit"] == "CAN2"
    try:
        asyncio.run(routes.sr_defect_to_wo(routes.SrDefectToWoIn(
            unit="GHOST 1", detail="x")))
        raise AssertionError("debió dar 400")
    except HTTPException as exc:
        assert exc.status_code == 400 and "unknown unit" in exc.detail
    # Flota parcial (Samsara falló: solo manuales) => no se valida.
    STATE["fleet"] = RuntimeError("samsara down")
    sr.reset_sync_cache()
    assert asyncio.run(sr.unit_index("GHOST 2")) == {}
    made = asyncio.run(routes.sr_create(
        routes.ServiceRequestIn(unit="GHOST 2", title="x"), req))
    assert made["unit"] == "GHOST 2"
    STATE["fleet"] = []
    sr.reset_sync_cache()
    print("OK unidad canónica: sync renombra sin duplicar, create valida, "
          "units[] funde variantes")


def test_known_units_and_archived():
    """create_manual acepta las unidades que la app YA muestra fuera de GET
    /fleet (defecto del CSV de MCC, camión solo del board de PM); una
    desconocida sigue dando 400. Ante dos grafías, la canónica es la ACTIVA
    (no la de un asset archivado)."""
    from fastapi import HTTPException

    from app.api import routes
    req = SimpleNamespace(state=SimpleNamespace(user={"name": "Ana"}))
    STATE["fleet"] = ["KN 1", {"unit": "ARC 77", "archived": True}, "ARC77"]
    STATE["feed"] = _feed(_defect("MCC 14", "Mirror - cracked",
                                  company="MCC"))
    STATE["pm"] = {"upcoming_miles": 2000, "units": [
        _pm("PMONLY 5", 9_000, last_miles=1_000)]}      # al día: sin request
    STATE["dot"] = {"upcoming_days": 30, "units": []}
    sr.reset_sync_cache()
    _sync()
    assert not _rows(unit="PMONLY 5"), "al día: no hay request"
    made = asyncio.run(routes.sr_create(
        routes.ServiceRequestIn(unit="mcc14", title="Check bracket"), req))
    assert made["unit"] == "MCC 14", made          # del backlog (feed CSV)
    made = asyncio.run(routes.sr_create(
        routes.ServiceRequestIn(unit="pmonly 5", title="Check A/C"), req))
    assert made["unit"] == "PMONLY 5", made        # del board de PM
    try:
        asyncio.run(routes.sr_create(
            routes.ServiceRequestIn(unit="GHOST 3", title="x"), req))
        raise AssertionError("debió dar 400")
    except HTTPException as exc:
        assert exc.status_code == 400 and exc.detail == sr.UNKNOWN_UNIT
    # Archivado 'ARC 77' (sale antes en el orden de Samsara) + activo
    # 'ARC77': gana el activo, igual que el front.
    assert asyncio.run(sr.unit_index("arc 77"))["ARC77"] == "ARC77"
    STATE["fleet"] = []
    sr.reset_sync_cache()
    print("OK unidades conocidas (backlog / fuentes) + gana la activa")


def test_unit_filter_unicode_whitespace():
    """?unit= y delete_duplicates(unit) comparan con _norm_unit (Python):
    una unidad con NBSP, tab o letras no ASCII no queda afuera (SQLite solo
    sube ASCII y un replace de ' ' no saca tabs ni NBSP)."""
    base = datetime.now() - timedelta(days=2)
    for name in ("NB 77", "TB\t88", "grúa 9"):
        k = _mk(name, "Same broken thing here", created_at=base)
        d = _mk(name, "same broken thing here", created_at=base
                + timedelta(hours=1))
        lst = sr.list_requests("open", unit=name)
        assert {r["id"] for r in lst["requests"]} == {k, d}, name
        assert lst["counts"]["open"] == 2, name
        u = next(x for x in lst["units"]
                 if sr._norm_unit(x["unit"]) == sr._norm_unit(name))
        assert u["duplicates"] == 1, u
        assert sr.get_request(d)["duplicate_of"] == k
        assert sr.delete_duplicates(name) == {"deleted": [d],
                                              "skipped": []}, name
    print("OK ?unit= / delete_duplicates(unit) con NBSP, tab y no ASCII")


def test_pm_record_goes_to_board_row():
    """WO de un PM cuya fila del BOARD se escribe distinto que la flota
    ('BRD1' en el CSV, 'BRD 1' en Samsara): la WO lleva el nombre de la
    flota, pero el registro del PM al facturar va a la fila del board, que
    pasa al ciclo nuevo — sin fila duplicada ni PM vencido para siempre.
    Usa el maint.board REAL (CSV de Fullbay simulado, sin Samsara)."""
    from app.core import pm, samsara
    saved = (maint.board, pm.load, samsara.is_available)
    pm.load = lambda: [{"unit": "BRD1", "model": "2021 Freightliner Cascadia",
                        "last_pm_date": "3/1/2026", "last_pm_miles": 70_000,
                        "report_miles": 92_000}]
    samsara.is_available = lambda: False
    maint.board = _REAL_BOARD
    STATE["fleet"] = ["BRD 1"]
    STATE["feed"] = _feed()
    sr.reset_sync_cache()
    try:
        before = asyncio.run(_REAL_BOARD("pm"))
        row = next(x for x in before["units"] if x["unit"] == "BRD1")
        assert row["status"] == "overdue", row
        _sync()
        r = _row("pm:BRD1:70000")
        assert r.unit == "BRD 1" and sr._meta(r)["board_unit"] == "BRD1"
        wo = sr.create_wo([r.id], mechanic="Luis")["workorder"]
        assert wo["unit"] == "BRD 1" and wo["campaign"] == "pm"
        workorders.add_line(wo["id"], "labor", "PM service", 1, 100)
        workorders.update_wo(wo["id"], {"status": "invoiced"})
        latest = maint.latest_by_unit("pm")
        assert latest["BRD1"]["notes"].startswith(f"WO #{wo['id']}:")
        assert "BRD 1" not in latest
        after = asyncio.run(_REAL_BOARD("pm"))
        same = [x for x in after["units"]
                if sr._norm_unit(x["unit"]) == "BRD1"]
        assert [x["unit"] for x in same] == ["BRD1"], same
        assert same[0]["last_miles"] == 92_000, same[0]
        assert same[0]["status"] != "overdue", same[0]
        # Re-facturar no registra dos veces.
        workorders.update_wo(wo["id"], {"status": "completed"})
        workorders.update_wo(wo["id"], {"status": "invoiced"})
        with db.SessionLocal() as s:
            n = len(s.scalars(select(db.MaintRecord).where(
                db.MaintRecord.notes.like(f"WO #{wo['id']}:%"))).all())
        assert n == 1, n
        assert _sync()["created"] == 0
        assert sr.get_request(r.id)["status"] == "done"
        # WO creada A MANO con el nombre de la flota (picker de New work
        # order, sin request ligado): el registro también va a la grafía
        # que el tracker ya conoce ('BRD1' del CSV).
        man = workorders.create_wo("BRD 1", "Manual PM", mechanic="Luis",
                                   campaign="pm", mileage=95_000)
        workorders.add_line(man["id"], "labor", "PM service", 1, 100)
        workorders.update_wo(man["id"], {"status": "invoiced"})
        latest = maint.latest_by_unit("pm")
        assert latest["BRD1"]["notes"].startswith(f"WO #{man['id']}:")
        assert "BRD 1" not in latest
    finally:
        maint.board, pm.load, samsara.is_available = saved
        STATE["fleet"] = []
        sr.reset_sync_cache()
    print("OK registro del PM va a la fila del board (no a otra grafía)")


if __name__ == "__main__":
    test_real_feed_helper()
    test_board_reports_samsara_errors()
    open_defects.current_feed = _fake_feed
    maint.board = _fake_board
    fleet_inventory.load = _fake_fleet
    test_sync_creates_rows()
    test_sync_idempotent()
    test_clearing_only_on_successful_feed()
    test_pm_cycle_new_row()
    test_priority_bump_when_overdue()
    test_deny_snooze_reopen()
    test_snooze_expiry_reopens()
    test_create_wo_links_atomically()
    test_add_to_wo_validation()
    test_wo_hooks_complete_back_delete()
    test_wo_mutations_keep_links()
    test_defect_to_wo()
    test_defect_recurrence_after_close()
    test_list_units_summary()
    test_tenant_isolation()
    test_routes_and_rbac()
    test_pm_outage_never_clears()
    test_defect_to_wo_after_completed_wo()
    test_strict_dates()
    test_sync_concurrent_insert_returns_none()
    test_sync_does_not_overwrite_user_action()
    test_list_history_cap()
    test_maint_change_marks_stale()
    test_list_wos_keeps_active_beyond_cap()
    test_delete_and_restore()
    test_sync_never_resurrects_deleted()
    test_deleted_defect_reappears_after_clear()
    test_duplicates_rules()
    test_duplicates_side_specific()
    test_duplicate_keeper_preference()
    test_delete_duplicates()
    test_unit_canonicalization()
    test_known_units_and_archived()
    test_unit_filter_unicode_whitespace()
    test_pm_record_goes_to_board_row()
    print("\nALL SERVICE REQUEST TESTS PASSED")
