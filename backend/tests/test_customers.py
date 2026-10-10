# -*- coding: utf-8 -*-
"""Tests de Customers + Bill-To de la WO (v2.22, benchmark SquareRigger).

`python backend/tests/test_customers.py`. DB SQLite temporal fresca; la
flota viva (Samsara) se reemplaza por un fake (sin red).

Lo que NO hay que perder:
  - CRUD + validación: nombre único case-insensitive ("customer already
    exists"), kind/terms/markups/since validados, tags normalizados; el
    quick-add del picker devuelve el existente en vez de fallar;
  - contactos: un solo contacto de facturación; PII (email/phone/address
    del customer y de los contactos) ENMASCARADA sin pii.view en todo GET y
    respuesta; un PATCH con el valor enmascarado no pisa el dato real;
  - unidades: UN dueño por unidad (normalizado 'mem77' == 'MEM 77');
    set_unit MUEVE la propiedad;
  - WO: sin customer_id hereda el dueño ACTIVO de la unidad (también por el
    flujo de Service Requests); 0 = Self; id inexistente => 400;
  - facturar congela unit_price = costo × (1 + markup partes/labor); cambiar
    el markup después NO re-precia; des-facturar + línea nueva + re-facturar
    congela solo la nueva; no se cambia el customer de una WO facturada;
    cambiar de customer borra los precios congelados;
  - payment_status unpaid|paid (+ paid_at), exige wo.invoice en la ruta;
  - perfil: work orders, parts billed, totales (billed YTD, open balance) y
    el listado con balance/open_wos/units;
  - invoice por email: Bill-To del customer (Attn del contacto de
    facturación, términos) y tarifas = precio de venta; Self = billing de la
    empresa y costo;
  - borrado suave con WOs / duro sin WOs; backfill desde Unit.customer (una
    vez) + hook de Add New Unit; RBAC (/api/customers = maint.edit);
    aislamiento por tenant.
"""
import asyncio
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

_TMP = Path(tempfile.mkdtemp())
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP / 'customers_test.db'}"

from fastapi import HTTPException                       # noqa: E402
from sqlalchemy import select                           # noqa: E402

from app import db                                      # noqa: E402
from app.api import routes                              # noqa: E402
from app.core import (                                  # noqa: E402
    customers, fleet_inventory, manual_units, org_config,
    service_requests as sr, tenant, wo_invoice, workorders,
)
from app.main import _scope_for                         # noqa: E402

ORG = db.default_org_id()
tenant.set_current_org(ORG)

FLEET = {"units": [
    {"unit": "MEM 77", "model": "Cascadia", "make": "Freightliner",
     "year": "2021"},
    {"unit": "TRL 500", "model": "DuraPlate", "make": "Wabash",
     "year": "2019"},
]}


async def _fake_fleet(refresh: bool = False) -> dict:
    return {"available": True, "source": "fake", "units": FLEET["units"]}

fleet_inventory.load = _fake_fleet


# ----- Helpers ---------------------------------------------------------------

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


def _req(role: str, org: int = ORG):
    """Request mínimo con el usuario que deja el middleware."""
    return SimpleNamespace(state=SimpleNamespace(user={
        "id": 1, "org_id": org, "role": role, "name": f"Test {role}",
        "username": role}))


def _line(wo_id, kind, desc, qty, cost, pn=""):
    return workorders.add_line(wo_id, kind, desc, qty, cost, pn)


def _invoice(wo_id: int) -> dict:
    wo = workorders.get_wo(wo_id)
    if not wo["mechanic"] and wo["wo_type"] != "outside":
        workorders.update_wo(wo_id, {"mechanic": "Luis"})
    return workorders.update_wo(wo_id, {"status": "invoiced"})


# ----- Tests -------------------------------------------------------------------

def test_crud_and_validation():
    c = customers.create_customer({
        "name": "  Juan   Perez  ", "kind": "owner_operator",
        "since": "2025-03-01", "email": "juan@example.com",
        "phone": "(901) 555-1234", "address": "12 Main St",
        "city": "Memphis", "state": "tn", "zip": "38101",
        "terms": "NET30", "labor_markup_pct": 10, "parts_markup_pct": 20,
        "tax_exempt": True, "tax_rate_pct": 7.5, "accounting_id": "MCL-9",
        "driver_name": "Juan Perez", "notes": "pays weekly",
        "tags": ["vip", "VIP", " reefer "]})
    assert c["name"] == "Juan Perez", c["name"]
    assert c["state"] == "TN" and c["terms"] == "net30"
    assert c["terms_label"] == "Net 30"
    assert c["tags"] == "vip, reefer", c["tags"]
    assert c["active"] is True and c["kind_label"] == "Owner-operator"
    _raises(customers.create_customer, "customer already exists",
            {"name": "JUAN PEREZ"})
    _raises(customers.create_customer, "customer name is required",
            {"name": "   "})
    _raises(customers.create_customer, "kind must be",
            {"name": "X1", "kind": "friend"})
    _raises(customers.create_customer, "terms must be",
            {"name": "X2", "terms": "net60"})
    _raises(customers.create_customer, "parts_markup_pct must be between",
            {"name": "X3", "parts_markup_pct": -5})
    _raises(customers.create_customer, "since must be a date",
            {"name": "X4", "since": "03/01/2025"})
    _raises(customers.create_customer, "invalid email",
            {"name": "X5", "email": "nope"})
    other = customers.create_customer({"name": "Acme Carrier",
                                       "kind": "carrier"})
    _raises(customers.update_customer, "customer already exists",
            other["id"], {"name": "juan perez"})
    upd = customers.update_customer(other["id"], {"city": "Dallas",
                                                  "since": ""})
    assert upd["city"] == "Dallas" and upd["since"] is None
    assert customers.update_customer(9999, {"city": "x"}) is None
    # Quick add: el existente vuelve (sin 400).
    q = customers.quick_create({"name": "juan perez"})
    assert q["existing"] is True and q["id"] == c["id"]
    q2 = customers.quick_create({"name": "Maria Lopez",
                                 "phone": "9015550000"})
    assert q2["existing"] is False and q2["kind"] == "owner_operator"
    # Rutas: 400 / 404.
    _http(routes.customers_create, 400, routes.CustomerIn(name="Acme carrier"))
    _http(routes.customers_patch, 404, 9999, routes.CustomerPatch(city="x"))
    _http(routes.customers_get, 404, 9999)
    print("OK CRUD + validación + quick add")


def test_contacts_and_pii_masking():
    c = customers.create_customer({"name": "Pedro Ruiz",
                                   "email": "pedro@ruiz.com",
                                   "phone": "9015551111",
                                   "address": "77 Elm"})
    a = customers.add_contact(c["id"], {"name": "Ana", "role": "Wife",
                                        "email": "ana@ruiz.com",
                                        "phone": "9015552222",
                                        "is_billing": True})
    b = customers.add_contact(c["id"], {"name": "Office",
                                        "email": "office@ruiz.com",
                                        "is_billing": True})
    prof = customers.profile(c["id"])
    billing = [ct for ct in prof["contacts"] if ct["is_billing"]]
    assert [ct["id"] for ct in billing] == [b["id"]], billing
    assert prof["bill_to"]["email"] == "office@ruiz.com"
    assert prof["bill_to"]["contact"] == "Office"
    _raises(customers.add_contact, "contact needs",
            c["id"], {"role": "nobody"})
    assert customers.add_contact(9999, {"name": "x"}) is None
    upd = customers.update_contact(c["id"], a["id"], {"is_billing": True})
    assert upd["is_billing"] is True
    prof = customers.profile(c["id"])
    assert [ct["id"] for ct in prof["contacts"] if ct["is_billing"]] == [
        a["id"]]

    # Sin pii.view (mechanic): todo enmascarado.
    mech = _req("mechanic")
    p = asyncio.run(routes.customers_get(c["id"], mech))
    assert p["pii_masked"] is True
    assert p["customer"]["email"] == "p•••@ruiz.com", p["customer"]["email"]
    assert p["customer"]["phone"] == "•••-1111"
    assert p["customer"]["address"] == "•••"
    assert all("•••" in ct["email"] for ct in p["contacts"] if ct["email"])
    assert "•••" in p["bill_to"]["email"]
    # Con pii.view (dispatcher): en claro.
    p = asyncio.run(routes.customers_get(c["id"], _req("dispatcher")))
    assert p["customer"]["email"] == "pedro@ruiz.com"
    assert p["pii_masked"] is False
    # Respuestas de escritura también enmascaradas; y un PATCH con el valor
    # enmascarado (formulario completo devuelto tal cual) NO pisa el real.
    out = routes.customers_patch(c["id"], routes.CustomerPatch(
        email="p•••@ruiz.com", phone="•••-1111", address="•••",
        city="Memphis"), mech)
    assert out["email"] == "p•••@ruiz.com" and out["city"] == "Memphis"
    raw = customers.get_customer(c["id"])
    assert raw["email"] == "pedro@ruiz.com" and raw["address"] == "77 Elm"
    ct = routes.customers_patch_contact(
        c["id"], a["id"], routes.CustomerContactPatch(
            email="a•••@ruiz.com", role="Owner's wife"), mech)
    assert ct["role"] == "Owner's wife"
    full = customers.profile(c["id"])
    assert any(x["email"] == "ana@ruiz.com" for x in full["contacts"])
    assert routes.customers_delete_contact(c["id"], b["id"]) == {"ok": True}
    _http(routes.customers_delete_contact, 404, c["id"], b["id"])
    print("OK contactos + PII enmascarada (GET y escrituras)")


def test_units_ownership_and_wo_default():
    a = customers.create_customer({"name": "Owner A"})
    b = customers.create_customer({"name": "Owner B"})
    r = customers.set_unit(a["id"], "mem77", known_units=["MEM 77"])
    assert r["unit"] == "MEM 77" and r["moved_from"] == [], r
    # Mover la propiedad a B (otra grafía de la misma unidad).
    r = asyncio.run(routes.customers_set_unit(
        b["id"], routes.CustomerUnitIn(unit="Mem 77")))
    assert r["moved_from"] == [a["id"]] and r["units"] == ["MEM 77"], r
    assert customers.profile(a["id"])["units"] == []
    pb = customers.profile(b["id"], {"MEM77": {"model": "Cascadia",
                                               "make": "Freightliner",
                                               "year": "2021"}})
    assert pb["units"][0]["model"] == "Cascadia", pb["units"]
    assert customers.owner_of("MEM77") == {"id": b["id"], "name": "Owner B"}
    _raises(customers.set_unit, "unit is required", b["id"], "  ")
    assert customers.set_unit(9999, "X") is None

    # WO sin customer_id => hereda el dueño; 0 => Self; id inválido => 400.
    w1 = workorders.create_wo("MEM 77", "Brakes")
    assert w1["customer_id"] == b["id"] and w1["customer_name"] == "Owner B"
    w2 = workorders.create_wo("MEM 77", "Self job", customer_id=0)
    assert w2["customer_id"] is None and w2["customer_name"] == ""
    w3 = workorders.create_wo("TRL 999", "Other", customer_id=a["id"])
    assert w3["customer_id"] == a["id"]
    _raises(workorders.create_wo, "customer not found", "TRL 999", "x",
            customer_id=424242)
    _http(routes.wo_create, 400, routes.WorkOrderIn(
        unit="TRL 999", title="x", customer_id=424242), _req("admin"))
    # El flujo de Service Requests también hereda el dueño.
    req = sr.create_manual("MEM 77", "Check lights")
    out = sr.create_wo([req["id"]])
    assert out["workorder"]["customer_id"] == b["id"], out["workorder"]
    # Dueño inactivo => no se hereda.
    customers.update_customer(b["id"], {"active": False})
    w4 = workorders.create_wo("MEM 77", "After deactivation")
    assert w4["customer_id"] is None
    customers.update_customer(b["id"], {"active": True})
    # PATCH: cambiar a otro customer / Self (0) / inexistente.
    w = workorders.update_wo(w2["id"], {"customer_id": a["id"]})
    assert w["customer_id"] == a["id"]
    w = workorders.update_wo(w2["id"], {"customer_id": 0})
    assert w["customer_id"] is None
    _raises(workorders.update_wo, "customer not found", w2["id"],
            {"customer_id": 777})
    # Quitar la unidad.
    assert customers.remove_unit(b["id"], "MEM 77") is True
    assert customers.remove_unit(b["id"], "MEM 77") is False
    _http(routes.customers_remove_unit, 404, b["id"], "MEM 77")
    assert customers.owner_of("MEM 77") is None
    print("OK unidades (un dueño, mover) + customer por defecto en la WO")


def test_invoice_snapshot_billable_and_payment():
    c = customers.create_customer({"name": "Price Co",
                                   "parts_markup_pct": 20,
                                   "labor_markup_pct": 10})
    wo = workorders.create_wo("TRL 500", "Reefer repair",
                              customer_id=c["id"], mechanic="Luis")
    _line(wo["id"], "part", "Filter", 2, 100, "FLT-1")
    wo = _line(wo["id"], "labor", "Labor", 3, 50)
    # En vivo (sin snapshot): 2×120 + 3×55 = 405; costo = 350.
    assert wo["total"] == 350.0 and wo["billable_total"] == 405.0, wo
    assert wo["customer_markup"] == {"parts_pct": 20.0, "labor_pct": 10.0}
    assert all(ln["unit_price"] is None for ln in wo["lines"])
    assert [ln["billable_unit_price"] for ln in wo["lines"]] == [120.0, 55.0]
    wo = _invoice(wo["id"])
    assert wo["status"] == "invoiced"
    assert [ln["unit_price"] for ln in wo["lines"]] == [120.0, 55.0], \
        wo["lines"]
    # Cambiar el markup NO re-precia lo facturado.
    customers.update_customer(c["id"], {"parts_markup_pct": 50})
    wo = workorders.get_wo(wo["id"])
    assert wo["billable_total"] == 405.0, wo["billable_total"]
    # No se cambia el customer de una WO facturada.
    _raises(workorders.update_wo, "un-invoice the work order", wo["id"],
            {"customer_id": 0})
    # Des-facturar + línea nueva + re-facturar: solo la nueva se congela
    # (con el markup NUEVO); las viejas quedan.
    workorders.update_wo(wo["id"], {"status": "completed"})
    _line(wo["id"], "part", "Belt", 1, 10, "BLT-1")
    wo = workorders.update_wo(wo["id"], {"status": "invoiced"})
    prices = sorted(ln["unit_price"] for ln in wo["lines"])
    assert prices == [15.0, 55.0, 120.0], prices
    assert wo["billable_total"] == 420.0
    # Cobro: unpaid -> paid (paid_at) -> unpaid.
    assert wo["payment_status"] == "unpaid" and wo["paid_at"] is None
    w = workorders.update_wo(wo["id"], {"payment_status": "paid"})
    assert w["payment_status"] == "paid" and w["paid_at"]
    _raises(workorders.update_wo, "payment_status must be", wo["id"],
            {"payment_status": "maybe"})
    # La ruta exige wo.invoice para marcar el cobro (mechanic no lo tiene).
    exc = _http(routes.wo_patch, 403, wo["id"],
                routes.WorkOrderPatch(payment_status="unpaid"),
                _req("mechanic"))
    assert "can't do this" in exc.detail
    w = asyncio.run(routes.wo_patch(
        wo["id"], routes.WorkOrderPatch(payment_status="unpaid"),
        _req("dispatcher")))
    assert w["payment_status"] == "unpaid" and w["paid_at"] is None
    # Crear YA cobrada también exige wo.invoice (sin bypass por el POST).
    # (Otro customer: no mueve los totales que se verifican abajo.)
    cg = customers.create_customer({"name": "Pay Gate Co"})
    exc = _http(routes.wo_create, 403, routes.WorkOrderIn(
        unit="PG 1", title="Paid?", customer_id=cg["id"],
        payment_status="paid"), _req("mechanic"))
    assert "can't do this" in exc.detail
    ok = routes.wo_create(routes.WorkOrderIn(
        unit="PG 1", title="Unpaid ok", customer_id=cg["id"]),
        _req("mechanic"))
    assert ok["payment_status"] == "unpaid"
    paid = routes.wo_create(routes.WorkOrderIn(
        unit="PG 1", title="Paid ok", customer_id=cg["id"],
        payment_status="paid"), _req("dispatcher"))
    assert paid["payment_status"] == "paid" and paid["paid_at"]

    # Cambiar de customer (WO sin facturar) borra los precios congelados.
    w5 = workorders.create_wo("TRL 500", "Second", customer_id=c["id"],
                              mechanic="Luis")
    _line(w5["id"], "part", "Lamp", 1, 10)
    w5 = _invoice(w5["id"])
    assert w5["lines"][0]["unit_price"] == 15.0
    workorders.update_wo(w5["id"], {"status": "completed"})
    w5 = workorders.update_wo(w5["id"], {"customer_id": 0})
    assert w5["lines"][0]["unit_price"] is None
    assert w5["billable_total"] == 10.0

    # Self: billable == total exacto (sin redondeos raros).
    s = workorders.create_wo("TRL 501", "Self", customer_id=0)
    s = _line(s["id"], "part", "Odd", 3, 12.345)
    assert s["billable_total"] == s["total"] == round(3 * 12.345, 2)

    # Perfil + listado: billed, open balance, parts billed.
    wo_paid = workorders.create_wo("TRL 500", "Paid one",
                                   customer_id=c["id"], mechanic="Luis")
    _line(wo_paid["id"], "part", "Filter", 1, 100, "FLT-1")
    _invoice(wo_paid["id"])          # parts 50% => 150
    workorders.update_wo(wo_paid["id"], {"payment_status": "paid"})
    open_wo = workorders.create_wo("TRL 500", "Open one",
                                   customer_id=c["id"])
    prof = customers.profile(c["id"])
    t = prof["totals"]
    assert t["billed_all"] == 570.0 and t["billed_ytd"] == 570.0, t
    assert t["open_balance"] == 420.0 and t["paid_all"] == 150.0, t
    assert t["wo_count"] == 3 and t["open_wos"] == 1, t   # w5 pasó a Self
    flt = next(p for p in prof["parts_billed"] if p["part_number"] == "FLT-1")
    assert flt["qty"] == 3 and flt["amount"] == 390.0, flt
    assert flt["wo_count"] == 2
    ids = [w["id"] for w in prof["work_orders"]]
    assert open_wo["id"] in ids and ids == sorted(ids, reverse=True)
    row = next(x for x in customers.list_customers("price")
               if x["id"] == c["id"])
    assert row["balance"] == 420.0 and row["open_wos"] == 1, row
    # El listado de WOs trae el customer (prefetch).
    lst = {w["id"]: w for w in workorders.list_wos()}
    assert lst[wo["id"]]["customer_name"] == "Price Co"
    assert lst[wo["id"]]["billable_total"] == 420.0
    print("OK snapshot al facturar + billable + cobro + perfil/totales")


def test_email_invoice_bill_to():
    org_config.save({"billing": {"CHASER": {
        "name": "Chaser Inc", "address": "1 Fleet Way", "city": "Memphis",
        "state": "TN", "zip": "38118", "phone": "", "email": ""}},
        "invoice": {"terms": "Due on receipt"}})
    c = customers.create_customer({
        "name": "Bill Me LLC", "address": "500 Owner Rd", "city": "Olive Branch",
        "state": "MS", "zip": "38654", "phone": "6625550000",
        "email": "owner@billme.com", "terms": "net15",
        "parts_markup_pct": 25})
    customers.add_contact(c["id"], {"name": "Rosa", "email": "ap@billme.com",
                                    "is_billing": True})
    wo = workorders.create_wo("TRL 600", "Tires", company="CHASER",
                              customer_id=c["id"], mechanic="Luis")
    _line(wo["id"], "part", "Tire", 2, 200, "TIRE-1")
    wo = _invoice(wo["id"])
    subject, text, html_doc = wo_invoice.render(wo)
    assert "Bill Me LLC" in html_doc and "500 Owner Rd" in html_doc
    assert "Attn: Rosa" in text and "ap@billme.com" in text, text
    assert "Olive Branch, MS 38654" in text
    assert "Chaser Inc" not in text
    assert "Terms: Net 15" in text, text
    assert "$250.00" in html_doc and "Total:  $500.00" in text, text
    assert "total $500.00" in wo_invoice.sms_summary(wo)
    # Self (sin customer): Bill-To = billing de la empresa, tarifas = costo.
    s = workorders.create_wo("TRL 600", "Self tires", company="CHASER",
                             customer_id=0)
    s = _line(s["id"], "part", "Tire", 1, 200, "TIRE-1")
    _, text2, _ = wo_invoice.render(s)
    assert "Chaser Inc" in text2 and "1 Fleet Way" in text2, text2
    assert "Terms: Due on receipt" in text2
    assert "Total:  $200.00" in text2
    print("OK invoice por email: Bill-To del customer + precios")


def test_delete_soft_and_hard():
    a = customers.create_customer({"name": "Temp Hard"})
    customers.add_contact(a["id"], {"name": "x"})
    customers.set_unit(a["id"], "HARD 1")
    r = routes.customers_delete(a["id"])
    assert r["deleted"] is True and r["customer"] is None
    assert customers.get_customer(a["id"]) is None
    with db.SessionLocal() as s:
        assert not s.scalars(select(db.CustomerUnit).where(
            db.CustomerUnit.customer_id == a["id"])).all()
        assert not s.scalars(select(db.CustomerContact).where(
            db.CustomerContact.customer_id == a["id"])).all()
    b = customers.create_customer({"name": "Temp Soft",
                                   "email": "soft@x.com"})
    workorders.create_wo("SOFT 1", "job", customer_id=b["id"])
    r = routes.customers_delete(b["id"], _req("mechanic"))
    assert r["deleted"] is False and r["deactivated"] is True
    assert r["customer"]["active"] is False
    assert r["customer"]["email"] == "s•••@x.com"
    assert all(x["id"] != b["id"]
               for x in customers.list_customers(active=True))
    assert any(x["id"] == b["id"]
               for x in customers.list_customers(active=False))
    _http(routes.customers_delete, 404, 98765)
    print("OK borrado suave (con WOs) / duro (sin WOs)")


def test_backfill_and_add_unit_hook():
    org2 = _new_org("backfill")
    tok = tenant.set_current_org(org2)
    try:
        now = datetime.now()
        with db.SessionLocal() as s:
            for unit, cust in (("BF 1", "Sam Ortega"), ("BF 2", "sam  ortega"),
                               ("BF 3", "New Guy"), ("BF 4", "")):
                s.add(db.Unit(unit=unit, customer=cust, created_at=now))
            s.add(db.Customer(name="Sam Ortega", kind="carrier", active=True,
                              created_at=now, updated_at=now))
            s.commit()
        rows = routes.customers_list(q="", active="")["customers"]
        by = {r["name"]: r for r in rows}
        assert set(by) == {"Sam Ortega", "New Guy"}, by
        assert by["Sam Ortega"]["units"] == ["BF 1", "BF 2"]
        assert by["Sam Ortega"]["kind"] == "carrier"  # el existente se respeta
        assert by["New Guy"]["kind"] == "owner_operator"
        # Una sola vez: borrar las ligas no las recrea.
        customers.remove_unit(by["New Guy"]["id"], "BF 3")
        customers.reset_backfill_cache()
        customers.list_customers()
        assert customers.owner_of("BF 3") is None
        # Hook de Fleet → Add New Unit.
        manual_units.add({"unit": "BF 9", "customer": "Hook Customer"})
        assert customers.owner_of("BF 9")["name"] == "Hook Customer"
        # Una unidad con dueño NO se mueve por el texto.
        manual_units.add({"unit": "BF 9", "customer": "Someone Else"})
        assert customers.owner_of("BF 9")["name"] == "Hook Customer"
        # La WO nueva de una unidad backfilleada hereda el dueño.
        w = workorders.create_wo("BF 1", "first")
        assert w["customer_name"] == "Sam Ortega"
    finally:
        tenant.reset_current_org(tok)
    print("OK backfill desde Unit.customer (una vez) + hook Add New Unit")


def _new_org(slug: str) -> int:
    with db.SessionLocal() as s:
        o = db.Organization(slug=slug, name=slug, active=True,
                            created_at=datetime.now())
        s.add(o)
        s.commit()
        return o.id


def test_tenant_isolation():
    org3 = _new_org("other")
    mine = customers.create_customer({"name": "Isolated Mine"})
    customers.set_unit(mine["id"], "ISO 1")
    tok = tenant.set_current_org(org3)
    try:
        assert all(c["name"] != "Isolated Mine"
                   for c in customers.list_customers())
        assert customers.get_customer(mine["id"]) is None
        assert customers.update_customer(mine["id"], {"city": "x"}) is None
        # Mismo nombre en otra org: permitido.
        theirs = customers.create_customer({"name": "Isolated Mine"})
        assert customers.owner_of("ISO 1") is None
        w = workorders.create_wo("ISO 1", "no owner here")
        assert w["customer_id"] is None
        _raises(workorders.create_wo, "customer not found", "ISO 1", "x",
                customer_id=mine["id"])
        # set_unit en esta org no le quita la unidad a la otra org.
        customers.set_unit(theirs["id"], "ISO 1")
    finally:
        tenant.reset_current_org(tok)
    assert customers.owner_of("ISO 1")["id"] == mine["id"]
    print("OK aislamiento por tenant")


def test_rbac_and_route_order():
    assert _scope_for("POST", "/api/customers") == "maint.edit"
    assert _scope_for("POST", "/api/customers/quick") == "maint.edit"
    assert _scope_for("PATCH", "/api/customers/3") == "maint.edit"
    assert _scope_for("DELETE", "/api/customers/3/units/X") == "maint.edit"
    assert _scope_for("GET", "/api/customers/3") is None
    assert _scope_for("GET", "/api/search") is None
    assert _scope_for("GET", "/api/home/summary") is None
    paths = [r.path for r in routes.router.routes
             if "GET" in getattr(r, "methods", set())]
    assert paths.index("/api/customers/owner") < paths.index(
        "/api/customers/{customer_id}")
    r = routes.customers_quick(routes.CustomerQuickIn(name="Route Quick"))
    assert r["existing"] is False
    r2 = routes.customers_quick(routes.CustomerQuickIn(name="route quick"))
    assert r2["existing"] is True and r2["id"] == r["id"]
    own = routes.customers_owner(unit="nothing")
    assert own == {"unit": "nothing", "customer": None}
    print("OK RBAC (/api/customers = maint.edit) + orden de rutas")


def test_customer_tax():
    """v2.22 finisher: la tasa del customer se aplica a las partes
    facturadas, se congela al facturar y entra a saldos / invoice."""
    c = customers.create_customer({"name": "Tax Co", "tax_rate_pct": 8.25,
                                   "parts_markup_pct": 0})
    wo = workorders.create_wo("TAX 1", "Brakes", customer_id=c["id"],
                              mechanic="Luis")
    _line(wo["id"], "part", "Pads", 1, 100, "PAD-1")
    _line(wo["id"], "labor", "Labor", 1, 50)
    w = workorders.get_wo(wo["id"])
    assert (w["billable_total"], w["tax_pct"], w["billable_tax"],
            w["billable_due"]) == (150.0, 8.25, 8.25, 158.25), w
    w = _invoice(wo["id"])
    # La tasa queda congelada: cambiarla después no reescribe el invoice.
    customers.update_customer(c["id"], {"tax_rate_pct": 10})
    w = workorders.get_wo(wo["id"])
    assert w["billable_tax"] == 8.25 and w["billable_due"] == 158.25, w
    row = next(x for x in customers.list_customers("Tax Co")
               if x["id"] == c["id"])
    assert row["balance"] == 158.25, row
    prof = customers.profile(c["id"])
    assert prof["totals"]["open_balance"] == 158.25, prof["totals"]
    assert prof["work_orders"][0]["billable_due"] == 158.25
    _s, text, html_doc = wo_invoice.render(w)
    assert "Tax (8.25% on parts):  $8.25" in text, text
    assert "Total:  $158.25" in text and "on parts" in html_doc
    # Exento: sin impuesto (la vigente se aplica a una WO sin facturar).
    customers.update_customer(c["id"], {"tax_exempt": True})
    w2 = workorders.create_wo("TAX 1", "Tires", customer_id=c["id"],
                              mechanic="Luis")
    _line(w2["id"], "part", "Tire", 1, 200)
    w2 = workorders.get_wo(w2["id"])
    assert w2["billable_tax"] == 0 and w2["billable_due"] == 200.0, w2
    # Self: nunca impuesto.
    s = workorders.create_wo("TAX 9", "Self", mechanic="Luis")
    _line(s["id"], "part", "Belt", 1, 10)
    assert workorders.get_wo(s["id"])["billable_tax"] == 0
    print("OK impuesto del customer: partes, congelado al facturar, saldos, "
          "invoice")


if __name__ == "__main__":
    test_crud_and_validation()
    test_contacts_and_pii_masking()
    test_units_ownership_and_wo_default()
    test_invoice_snapshot_billable_and_payment()
    test_email_invoice_bill_to()
    test_delete_soft_and_hard()
    test_backfill_and_add_unit_hook()
    test_tenant_isolation()
    test_rbac_and_route_order()
    test_customer_tax()
    print("\nALL CUSTOMER TESTS PASSED")
