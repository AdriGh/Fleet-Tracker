# -*- coding: utf-8 -*-
"""Tests de Resources (Employees, Locations, Vendors), búsqueda global y
Home (v2.22, benchmark SquareRigger).

`python backend/tests/test_resources.py`. DB SQLite temporal fresca; la
flota viva, el roster de conductores y los boards de PM se reemplazan por
fakes (sin red).

Lo que NO hay que perder:
  - Employees: la ficha (role/phone/email/hourly_rate/hire_date/notes) se
    crea y edita por /technicians, validada; phone/email ENMASCARADOS sin
    pii.view (listado, perfil, escrituras) y un PATCH con el valor
    enmascarado no pisa el real; GET /technicians/{id} = WOs asignadas por
    nombre (case-insensitive) + horas de labor 30d (+ costo = horas ×
    tarifa);
  - Locations: las terminales aceptan type/code/address/city/state/zip/
    phone; editar sin esos campos los conserva; type inválido => 400;
  - Vendors: /vendors/{id}/profile = WOs outside, POs (por vendor_id y por
    nombre), partes y totales (spend YTD, open PO value, outside total);
  - /api/search: q < 2 => nada; WOs por número (#12 y 4.1), unidad,
    customer y vendor (TODAS, no el tope del listado); equipo de la flota +
    unidades de customers; customers, partes, vendors, service requests
    abiertos, empleados y conductores (teléfono enmascarado sin pii.view);
    NUNCA matchea por PII; una fuente caída no tumba el resto;
  - /api/home/summary: KPIs (in progress, completed today, labor hours this
    week, parts blocking, SRs abiertos), WOs por status, semana actual vs
    anterior (cerradas, valor, inside/outside, PM nuevas, SRs, días
    promedio, facturado con markup, gasto de partes/labor), top 5 unidades
    y pm_due de maint.due — en la TZ de la org.
"""
import asyncio
import os
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

_TMP = Path(tempfile.mkdtemp())
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP / 'resources_test.db'}"

from fastapi import HTTPException                       # noqa: E402
from sqlalchemy import select                           # noqa: E402

from app import db                                      # noqa: E402
from app.api import routes                              # noqa: E402
from app.core import (                                  # noqa: E402
    customers, fleet_inventory, home, maint, org_config, parts, purchasing,
    search, service_requests as sr, technicians, tenant, terminals, tms,
    workorders,
)

ORG = db.default_org_id()
tenant.set_current_org(ORG)

FLEET_UNITS = [
    {"unit": "MEM 77", "unit_type": "truck", "year": "2021",
     "make": "Freightliner", "model": "Cascadia", "vin": "1FUJ77",
     "company": "CHASER"},
    {"unit": "TRL 53108", "unit_type": "trailer", "year": "2019",
     "make": "Utility", "model": "3000R", "vin": "1UYV53"},
]
DRIVERS = [
    {"name": "Carlos Mendez", "phone": "9015557788", "email": "c@x.com",
     "role": "owner_operator", "truck": "MEM 77", "trailer": "",
     "company": "CHASER", "driver_company": ""},
    {"name": "Beth Ross", "phone": "9015550001", "email": "",
     "role": "company_driver", "truck": "MEM 12", "trailer": "",
     "company": "CHASER", "driver_company": ""},
]
STATE = {"fleet_fail": False}


async def _fake_fleet(refresh: bool = False) -> dict:
    if STATE["fleet_fail"]:
        raise RuntimeError("samsara down")
    return {"available": True, "source": "fake", "units": FLEET_UNITS}


async def _fake_drivers() -> list[dict]:
    return [dict(d) for d in DRIVERS]


async def _fake_due(limit=None) -> dict:
    return {"items": [], "counts": {"overdue": 3, "upcoming": 2},
            "total": 5, "errors": []}

fleet_inventory.load = _fake_fleet
tms.list_drivers = _fake_drivers
maint.due = _fake_due


def _raises(fn, needle: str, *args, **kw):
    try:
        fn(*args, **kw)
    except ValueError as exc:
        assert needle in str(exc), f"{needle!r} not in {exc!s}"
        return
    raise AssertionError(f"debió lanzar ValueError con {needle!r}")


def _http(fn, status: int, *args, **kw):
    try:
        res = fn(*args, **kw)
        if asyncio.iscoroutine(res):
            asyncio.run(res)
    except HTTPException as exc:
        assert exc.status_code == status, (exc.status_code, exc.detail)
        return exc
    raise AssertionError(f"debió dar {status}")


def _req(role: str, name: str = "", org: int = ORG):
    return SimpleNamespace(state=SimpleNamespace(user={
        "id": 1, "org_id": org, "role": role,
        "name": name or f"Test {role}", "username": role}))


def _set_times(wo_id: int, **ts) -> None:
    with db.SessionLocal() as s:
        wo = s.get(db.WorkOrder, wo_id)
        for k, v in ts.items():
            setattr(wo, k, v)
        s.commit()


def _at(d, hour: int = 12) -> datetime:
    """Mediodía de la fecha `d` de la ORG, como datetime naive del server."""
    return org_config.org_day_start(d) + timedelta(hours=hour)


# ----- Employees ------------------------------------------------------------------

def test_employees_profile_and_masking():
    t = technicians.add("Luis Gomez", profile={
        "role": "Lead mechanic", "phone": "(901) 555-4321",
        "email": "luis@shop.com", "hourly_rate": 32.5,
        "hire_date": "2024-02-01", "notes": "reefer certified"})
    assert t["role"] == "Lead mechanic" and t["hourly_rate"] == 32.5
    _raises(technicians.add, "hourly_rate must be", "Bad Rate",
            profile={"hourly_rate": -1})
    _raises(technicians.update, "hire_date must be a date", t["id"],
            {"hire_date": "02/01/2024"})
    _raises(technicians.update, "invalid email", t["id"], {"email": "x"})
    # Rutas: masking sin pii.view (mechanic) / claro con dispatcher.
    mech = _req("mechanic")
    rows = routes.technicians_list(0, mech)
    assert rows["pii_masked"] is True
    me = next(r for r in rows["technicians"] if r["id"] == t["id"])
    assert me["phone"] == "•••-4321" and me["email"] == "l•••@shop.com"
    clear = routes.technicians_list(0, _req("dispatcher"))["technicians"]
    assert next(r for r in clear if r["id"] == t["id"])["email"] == \
        "luis@shop.com"
    # PATCH con valores enmascarados (formulario devuelto tal cual) + rol.
    out = routes.technicians_update(t["id"], routes.TechnicianPatch(
        phone="•••-4321", email="l•••@shop.com", role="Shop foreman"), mech)
    assert out["role"] == "Shop foreman" and out["phone"] == "•••-4321"
    raw = technicians.get(t["id"])
    assert raw["phone"] == "(901) 555-4321" and raw["email"] == "luis@shop.com"
    # hourly_rate '' borra la tarifa; la ruta de alta acepta la ficha.
    assert technicians.update(t["id"], {"hourly_rate": ""})["hourly_rate"] \
        is None
    technicians.update(t["id"], {"hourly_rate": 30})
    created = routes.technicians_create(routes.TechnicianIn(
        name="Ana Ruiz", role="Apprentice", phone="9015550909"), mech)
    assert created["role"] == "Apprentice" and created["phone"] == "•••-0909"

    # Perfil: WOs por nombre (cualquier grafía) + labor 30d.
    today = org_config.org_today()
    w1 = workorders.create_wo("MEM 77", "Brakes", mechanic="luis gomez")
    workorders.add_line(w1["id"], "labor", "Labor", 3, 100)
    workorders.add_line(w1["id"], "part", "Pads", 2, 40)
    w2 = workorders.create_wo("MEM 77", "Old job", mechanic="LUIS GOMEZ",
                              service_date=(today - timedelta(days=45))
                              .isoformat())
    workorders.add_line(w2["id"], "labor", "Labor", 5, 100)
    workorders.create_wo("MEM 77", "Not his", mechanic="Ana Ruiz")
    p = routes.technicians_profile(t["id"], mech)
    assert p["technician"]["email"] == "l•••@shop.com"
    assert {w["id"] for w in p["work_orders"]} == {w1["id"], w2["id"]}
    assert p["labor_hours_30d"] == 3.0, p
    assert p["labor_cost_30d"] == 90.0 and p["labor_billed_30d"] == 300.0
    assert p["wo_count"] == 2 and p["open_wos"] == 2
    _http(routes.technicians_profile, 404, 9999)
    print("OK Employees: ficha, masking, perfil con labor 30d")


# ----- Locations ------------------------------------------------------------------

def test_locations_fields():
    req = _req("admin")
    cfg = routes.terminals_save(routes.TerminalIn(
        label="Memphis Shop", prefixes=["MEM"], type="shop", code="mem1",
        address="100 Shop Rd", city="Memphis", state="tn", zip="38118",
        phone="9015550100"), req)
    t = next(x for x in cfg["terminals"] if x["label"] == "Memphis Shop")
    assert t["type"] == "shop" and t["code"] == "MEM1" and t["state"] == "TN"
    assert t["address"] == "100 Shop Rd"
    # Editar SIN los campos de location los conserva.
    cfg = routes.terminals_save(routes.TerminalIn(
        key=t["key"], label="Memphis Main Shop", prefixes=["MEM"]), req)
    t2 = next(x for x in cfg["terminals"] if x["key"] == t["key"])
    assert t2["label"] == "Memphis Main Shop" and t2["type"] == "shop"
    assert t2["zip"] == "38118"
    # Editar uno solo.
    cfg = routes.terminals_save(routes.TerminalIn(
        key=t["key"], label="Memphis Main Shop", prefixes=["MEM"],
        type="yard"), req)
    assert next(x for x in cfg["terminals"]
                if x["key"] == t["key"])["type"] == "yard"
    _http(routes.terminals_save, 400, routes.TerminalIn(
        label="Bad", prefixes=[], type="warehouse"), req)
    # Entradas viejas/defaults traen los campos vacíos.
    assert all("address" in x for x in terminals.get_all()["terminals"])
    # assign/delete conservan la ficha.
    terminals.assign(t["key"], ["MEM 77"])
    assert next(x for x in terminals.get_all()["terminals"]
                if x["key"] == t["key"])["city"] == "Memphis"
    assert terminals.resolve("MEM 77") == t["key"]
    print("OK Locations: ficha en terminales")


# ----- Vendors ---------------------------------------------------------------------

def test_vendor_profile():
    v = parts.create_vendor({"name": "Speedco Memphis", "kind": "both",
                             "city": "Memphis", "state": "TN"})
    other = parts.create_vendor({"name": "Other Parts"})
    parts.create_part({"part_number": "SP-1", "description": "Belt",
                       "cost": 20, "vendor_id": v["id"]})
    parts.create_part({"part_number": "OT-1", "description": "Other",
                       "cost": 5, "vendor_id": other["id"]})
    po1 = purchasing.create_po(vendor="Speedco Memphis", lines=[
        {"part_number": "SP-1", "description": "Belt", "qty": 10,
         "unit_cost": 20}])
    assert po1["vendor_id"] == v["id"]
    po2 = purchasing.create_po(vendor="Speedco Memphis", lines=[
        {"part_number": "SP-1", "description": "Belt", "qty": 2,
         "unit_cost": 20}])
    purchasing.update_po(po2["id"], {"status": "ordered"})
    # PO vieja sin vendor_id, ligada solo por NOMBRE.
    with db.SessionLocal() as s:
        now = datetime.now()
        po = db.PurchaseOrder(vendor=" speedco memphis ", status="received",
                              created_at=now, updated_at=now,
                              received_at=now, total=0.0)
        po.lines.append(db.POLine(part_number="SP-1", description="Belt",
                                  qty=1, unit_cost=30, qty_received=1))
        s.add(po)
        s.commit()
        legacy_id = po.id
    purchasing.create_po(vendor="Other Parts", lines=[
        {"part_number": "OT-1", "qty": 1, "unit_cost": 5}])
    w = workorders.create_wo("MEM 77", "Outside PM", wo_type="outside",
                             vendor_id=v["id"])
    workorders.add_line(w["id"], "labor", "PM service", 1, 250)
    workorders.update_wo(w["id"], {"status": "completed"})
    p = routes.vendors_profile(v["id"])
    assert p["vendor"]["name"] == "Speedco Memphis"
    assert [x["part_number"] for x in p["parts"]] == ["SP-1"]
    assert {x["id"] for x in p["purchase_orders"]} == {
        po1["id"], po2["id"], legacy_id}
    assert [x["id"] for x in p["work_orders"]] == [w["id"]]
    t = p["totals"]
    # open = draft (200) + ordered (40); YTD = ordered (40) + legacy
    # recibida (30) + outside completada (250).
    assert t["open_po_value"] == 240.0, t
    assert t["spend_ytd"] == 320.0 and t["outside_wo_total"] == 250.0, t
    assert t["po_spend_ytd"] == 70.0 and t["outside_spend_ytd"] == 250.0
    _http(routes.vendors_profile, 404, 9999)
    print("OK Vendors: perfil con WOs outside, POs (id y nombre), partes")


# ----- Búsqueda global -----------------------------------------------------------

def _groups(res) -> dict:
    return {g["key"]: g for g in res["groups"]}


def test_global_search():
    c = customers.create_customer({"name": "Zeta Hauling",
                                   "email": "secret@zeta.com",
                                   "city": "Tupelo", "state": "MS"})
    customers.set_unit(c["id"], "ZETA 1")
    wo = workorders.create_wo("ZETA 1", "Alternator swap")
    assert wo["customer_id"] == c["id"]
    parent = workorders.create_wo("MEM 77", "Multi unit parent")
    child = workorders.create_wo("TRL 53108", "Multi unit child",
                                 parent_id=parent["id"])
    sr.create_manual("MEM 77", "Zeta mirror broken")
    run = lambda q, role="dispatcher", limit=8: asyncio.run(  # noqa: E731
        routes.global_search(q, limit, _req(role)))

    assert run("z")["groups"] == []
    g = _groups(run("zeta"))
    assert g["customers"]["items"][0]["intent"] == {"customer": c["id"]}
    assert g["customers"]["items"][0]["section"] == "customers"
    assert "Tupelo, MS" in g["customers"]["items"][0]["subtitle"]
    assert any(i["intent"] == {"wo": wo["id"]}
               for i in g["work_orders"]["items"])      # por customer/unidad
    assert any(i["intent"] == {"unit": "ZETA 1"} for i in g["units"]["items"])
    assert g["service_requests"]["items"][0]["section"] == "service-requests"
    assert g["work_orders"]["label"] == "Work orders"
    # Número de WO: '#12' y el de hija '4.1' primero.
    g = _groups(run(f"#{wo['id']}"))
    assert g["work_orders"]["items"][0]["intent"] == {"wo": wo["id"]}
    disp = f"{parent['id']}.{child['child_seq']}"
    g = _groups(run(disp))
    assert g["work_orders"]["items"][0]["intent"] == {"wo": child["id"]}
    assert g["work_orders"]["items"][0]["title"].startswith(f"WO #{disp}")
    # Equipo (flota fake), partes, vendors.
    g = _groups(run("cascadia"))
    assert g["units"]["items"][0]["intent"] == {"unit": "MEM 77"}
    g = _groups(run("sp-1"))
    assert g["parts"]["items"][0]["title"] == "SP-1"
    assert g["parts"]["items"][0]["intent"]["part"]
    g = _groups(run("speedco"))
    assert g["vendors"]["items"][0]["section"] == "vendors"
    # Empleados + conductores; teléfono enmascarado sin pii.view.
    g = _groups(run("luis", role="mechanic"))
    assert g["technicians"]["items"][0]["section"] == "employees"
    assert "•••-4321" in g["technicians"]["items"][0]["subtitle"]
    g = _groups(run("carlos", role="mechanic"))
    d = g["drivers"]["items"][0]
    assert d["intent"] == {"driver": "Carlos Mendez"}
    assert "•••-7788" in d["subtitle"] and "9015557788" not in d["subtitle"]
    g = _groups(run("carlos", role="dispatcher"))
    assert "9015557788" in g["drivers"]["items"][0]["subtitle"]
    # Nunca por PII: el email del customer no matchea.
    assert "customers" not in _groups(run("secret@zeta"))
    # Fuente caída (Samsara): el resto responde.
    STATE["fleet_fail"] = True
    try:
        g = _groups(run("zeta"))
        assert "customers" in g and "work_orders" in g
        assert any(i["intent"] == {"unit": "ZETA 1"}
                   for i in g["units"]["items"])   # unidad del customer
    finally:
        STATE["fleet_fail"] = False
    # Busca en TODAS las WOs (no solo las 200 facturadas del listado).
    with db.SessionLocal() as s:
        now = datetime.now()
        old = db.WorkOrder(created_at=now, updated_at=now, unit="ANCIENT 1",
                           title="Very old invoiced job", status="invoiced",
                           invoiced_at=now)
        s.add(old)
        s.commit()
        old_id = old.id
    g = _groups(run("ancient"))
    assert g["work_orders"]["items"][0]["intent"] == {"wo": old_id}
    # limit
    assert len(_groups(run("multi unit", limit=1))["work_orders"]["items"]) \
        == 1
    # Aislamiento por tenant: nada de otra org (ni por el join de customer).
    with db.SessionLocal() as ss:
        o = db.Organization(slug="search-b", name="B", active=True,
                            created_at=datetime.now())
        ss.add(o)
        ss.commit()
        org_b = o.id
    tok = tenant.set_current_org(org_b)
    try:
        cb = customers.create_customer({"name": "Quokka Freight"})
        workorders.create_wo("QK 1", "Quokka job", customer_id=cb["id"])
        parts.create_vendor({"name": "Quokka Vendor"})
    finally:
        tenant.reset_current_org(tok)
    assert run("quokka")["groups"] == [], run("quokka")
    tok = tenant.set_current_org(org_b)
    try:
        g = _groups(asyncio.run(search.search("quokka", 8)))
        assert set(g) >= {"customers", "work_orders", "vendors"}, set(g)
        assert "Zeta" not in str(asyncio.run(search.search("zeta", 8)))
    finally:
        tenant.reset_current_org(tok)
    print("OK búsqueda global: grupos, números de WO, PII, fuentes caídas, "
          "tenant")


# ----- Home ----------------------------------------------------------------------------

def test_home_summary():
    # Base limpia de WOs/SRs para que los números sean exactos.
    with db.SessionLocal() as s:
        for row in s.scalars(select(db.WorkOrder)).all():
            s.delete(row)
        for row in s.scalars(select(db.ServiceRequest)).all():
            s.delete(row)
        s.commit()
    today = org_config.org_today()
    mon, _ = org_config.week_bounds(today)
    last_mon = mon - timedelta(days=7)
    cust = customers.create_customer({"name": "Home Billing",
                                      "parts_markup_pct": 10})

    # Esta semana: cerrada HOY (inside, PM), 2 días en cerrar.
    a = workorders.create_wo("MEM 77", "PM A", mechanic="Luis",
                             campaign="pm")
    workorders.add_line(a["id"], "part", "Oil", 1, 100)
    workorders.add_line(a["id"], "labor", "Labor", 2, 50)
    workorders.update_wo(a["id"], {"status": "completed"})
    _set_times(a["id"], created_at=_at(today) - timedelta(days=2),
               closed_at=_at(today))
    # Esta semana: outside facturada al customer, cerrada hoy, en curso 0d.
    v = parts.create_vendor({"name": "Home Shop", "kind": "shop"})
    b = workorders.create_wo("TRL 53108", "Outside B", wo_type="outside",
                             vendor_id=v["id"], customer_id=cust["id"])
    workorders.add_line(b["id"], "part", "Tire", 2, 100)
    workorders.update_wo(b["id"], {"status": "invoiced"})
    _set_times(b["id"], created_at=_at(today, 8), closed_at=_at(today, 9),
               invoiced_at=_at(today, 10))
    # Semana pasada: cerrada (inside), 1 día.
    c = workorders.create_wo("MEM 12", "Last week", mechanic="Ana")
    workorders.add_line(c["id"], "labor", "Labor", 4, 25)
    workorders.update_wo(c["id"], {"status": "completed"})
    _set_times(c["id"], created_at=_at(last_mon, 8),
               closed_at=_at(last_mon + timedelta(days=1), 8))
    # Abiertas: in_progress + waiting parts, assigned, open.
    d = workorders.create_wo("MEM 77", "In progress D", mechanic="Luis")
    workorders.update_wo(d["id"], {"status": "in_progress",
                                   "waiting_parts": True})
    workorders.create_wo("MEM 13", "Assigned E", mechanic="Luis")
    workorders.create_wo("MEM 14", "Open F")
    # SRs: 2 abiertos (uno de la semana pasada).
    s1 = sr.create_manual("MEM 77", "Lights")
    s2 = sr.create_manual("MEM 13", "Mirror")
    with db.SessionLocal() as s:
        s.get(db.ServiceRequest, s2["id"]).created_at = _at(last_mon, 9)
        s.commit()

    out = asyncio.run(routes.home_summary(_req("dispatcher",
                                               name="Adrian Ramirez")))
    assert out["user_first_name"] == "Adrian"
    k = out["kpis"]
    assert k["in_progress"] == 1 and k["completed_today"] == 2, k
    assert k["parts_blocking"] == 1 and k["open_service_requests"] == 2, k
    assert k["labor_hours_week"] == 2.0, k
    assert out["wo_by_status"] == {"open": 1, "assigned": 1,
                                   "in_progress": 1, "completed": 2,
                                   "waiting_parts": 1}, out["wo_by_status"]
    this, last = out["weeks"]["this"], out["weeks"]["last"]
    assert this["closed_wos"] == 2 and this["inside"] == 1 \
        and this["outside"] == 1, this
    assert this["closed_value"] == 400.0, this      # 200 (A) + 200 (B)
    assert this["avg_days_to_close"] == 1.0, this   # (2 + 0.04) / 2 -> 1.0
    assert this["invoiced_value"] == 220.0, this    # B con markup 10%
    # A (PM) se creó hace 2 días: lunes/martes cae en la semana pasada.
    a_this = (today - timedelta(days=2)) >= mon
    assert this["new_pm"] == (1 if a_this else 0), this
    assert last["new_pm"] == (0 if a_this else 1), last
    assert this["service_requests"] == 1, this
    assert this["parts_spend"] == 300.0 and this["labor_spend"] == 100.0
    assert last["closed_wos"] == 1 and last["closed_value"] == 100.0, last
    assert last["avg_days_to_close"] == 1.0 and last["inside"] == 1
    assert last["service_requests"] == 1 and last["labor_spend"] == 100.0
    top = out["top_units_week"]
    assert top[0] == {"unit": "MEM 77", "total": 200.0} or \
        top[0] == {"unit": "TRL 53108", "total": 200.0}, top
    assert {u["unit"] for u in top} == {"MEM 77", "TRL 53108"}, top
    assert out["pm_due"] == {"overdue": 3, "upcoming": 2}
    assert out["pm_due_error"] is False
    assert out["week_ranges"]["this"]["from"] == mon.isoformat()
    # maint.due caído: el Home responde igual (ceros + flag).

    async def _boom(limit=None):
        raise RuntimeError("boards down")
    maint.due = _boom
    try:
        out = asyncio.run(home.summary({"name": ""}))
        assert out["pm_due"] == {"overdue": 0, "upcoming": 0}
        assert out["pm_due_error"] is True and out["user_first_name"] == ""
    finally:
        maint.due = _fake_due
    print("OK Home: KPIs, semana actual vs anterior, top unidades, pm_due")


if __name__ == "__main__":
    test_employees_profile_and_masking()
    test_locations_fields()
    test_vendor_profile()
    test_global_search()
    test_home_summary()
    print("\nALL RESOURCES/SEARCH/HOME TESTS PASSED")
