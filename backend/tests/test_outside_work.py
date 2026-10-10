# -*- coding: utf-8 -*-
"""Tests de Outside work + Smart Fill (v2.21, benchmark SquareRigger).

`python backend/tests/test_outside_work.py`. DB SQLite temporal fresca; el
escáner (docscan.scan) se reemplaza por un fake (sin red).

Lo que NO hay que perder:
  - una WO outside exige vendor al crear; inside puede llevarlo o no al
    crear;
  - v2.23: el tipo (inside/outside) es FIJO desde la creación: un PATCH o
    Smart Fill que lo cambia => 400 TYPE_LOCKED_MSG, sin dejar nada a
    medias (mismo tipo = no-op); en una outside el vendor se REASIGNA pero
    no se quita; a una inside no se le liga vendor (INSIDE_VENDOR_MSG);
  - el gate "assign a mechanic" NO aplica a outside; el de líneas sí;
  - facturar una WO outside NO consume stock; una inside sí (idempotente);
  - match de vendors: marca de cadena (Love's/Speedco), desempate por
    ciudad, sin match bajo el umbral, máx. 5 candidatos;
  - propose/apply de Smart Fill: mapeo del extract, transacción todo-o-nada
    (campos + vendor nuevo kind 'shop' + replace de líneas), bloqueado si la
    WO está facturada; la ruta acepta multipart (adjunta el archivo) o JSON
    {use_attached}; v2.23: sobre una WO existente nunca cambia el tipo (una
    inside importa fecha/invoice #/líneas SIN ligar el taller y rechaza
    vendor_id/vendor_create sin crear un vendor fantasma); una WO NUEVA
    (/workorders/scan) sigue decidiendo inside/outside por el documento;
  - lines/bulk (append/replace, validación atómica);
  - borrar un vendor con WOs ligadas => 400; v2.23: una inside legacy con
    vendor se desliga (vendor_id 0, lo que manda el "Unlink shop" del
    detalle) y entonces el vendor sí se borra;
  - v2.23 puente reefer -> WO: borrar la WO automática (el camino para
    pasarla a outside, porque el tipo es fijo) NO la recrea mientras el
    fault siga activo; cuando el fault se va, una nueva ocurrencia sí abre
    WO; el marker [rf:…] en cualquier WO viva de la unidad deduplica;
  - list_wos filtra por wo_type/vendor_id; stats.outside_open;
  - service_requests.create_wo crea inside por defecto; v2.23: outside con
    vendor obligatorio (el técnico se ignora), igual que POST /workorders;
  - rutas + RBAC: /vendors/match literal antes de /vendors/{id}, todo
    maint.edit.
"""
import asyncio
import json
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

_TMP = Path(tempfile.mkdtemp())
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP / 'outside_work_test.db'}"

from fastapi import HTTPException                       # noqa: E402
from sqlalchemy import select                           # noqa: E402
from starlette.requests import Request                  # noqa: E402

from app import db                                      # noqa: E402
from app.api import routes                              # noqa: E402
from app.core import (                                  # noqa: E402
    docscan, fleet_inventory, parts, reefer_wo, service_requests as sr,
    smart_fill, technicians, tenant, vendors, wo_invoices, workorders,
)
from app.main import _scope_for                         # noqa: E402

ORG = db.default_org_id()
tenant.set_current_org(ORG)
# Los adjuntos de factura del test van a un dir temporal.
wo_invoices.UPLOADS_DIR = _TMP / "wo_invoices"


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
        fn(*args, **kw)
    except HTTPException as exc:
        assert exc.status_code == status, (exc.status_code, exc.detail)
        return exc
    raise AssertionError(f"debió dar {status}")


def _vendor(name, **kw) -> dict:
    return parts.create_vendor({"name": name, **kw})


def _seed_part(pn: str, on_hand: float) -> None:
    now = datetime.now()
    with db.SessionLocal() as s:
        s.add(db.Part(part_number=pn, description=pn, on_hand=on_hand,
                      cost=1.0, created_at=now, updated_at=now))
        s.commit()


def _on_hand(pn: str) -> float:
    with db.SessionLocal() as s:
        p = s.scalar(select(db.Part).where(db.Part.part_number == pn))
        return float(p.on_hand or 0) if p else 0.0


def _request(payload=None, multipart: bytes | None = None,
             boundary: str = "----rigsmith") -> Request:
    """Request de Starlette a mano (JSON o multipart) para las rutas que
    leen el body crudo."""
    if multipart is not None:
        body = multipart
        ctype = f"multipart/form-data; boundary={boundary}".encode()
    else:
        body = json.dumps(payload or {}).encode()
        ctype = b"application/json"
    scope = {
        "type": "http", "method": "POST", "path": "/api/x",
        "headers": [(b"content-type", ctype),
                    (b"content-length", str(len(body)).encode())],
        "query_string": b"", "client": ("127.0.0.1", 5555),
        "server": ("test", 80), "scheme": "http",
    }

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}
    return Request(scope, receive)


def _multipart_file(name: str, content: bytes, ctype: str,
                    boundary: str = "----rigsmith") -> bytes:
    head = (f"--{boundary}\r\nContent-Disposition: form-data; "
            f"name=\"file\"; filename=\"{name}\"\r\n"
            f"Content-Type: {ctype}\r\n\r\n").encode()
    return head + content + f"\r\n--{boundary}--\r\n".encode()


FAKE_EXTRACT = {
    "service_date": "2026-09-30",
    "vendor": "LOVES TRAVEL STOP #418 TOTAL TRUCK CARE",
    "vendor_city": "Amarillo",
    "vendor_state": "TX",
    "invoice_number": "4009978541",
    "mechanic": None,
    "grand_total": 536.88,
    "complaints": [
        {"unit": "TRL-9", "mileage": None, "detail": "Tire", "is_pm": False},
        {"unit": "CF2246", "mileage": 412_300,
         "detail": "PM service", "is_pm": True},
    ],
    "lines": [
        {"kind": "Labor", "description": "PM service", "qty": 1.5,
         "unit_cost": 100, "part_number": ""},
        {"kind": "part", "description": "Oil 15W40", "qty": 39,
         "unit_cost": 3.51, "part_number": "OIL-1540"},
        {"kind": "part", "description": "", "qty": 1, "unit_cost": 5},
        {"kind": "part", "description": "Filter", "qty": None,
         "unit_cost": None, "part_number": None},
    ],
}


async def _fake_scan(raw: bytes, media_type: str) -> dict:
    return {"extract": json.loads(json.dumps(FAKE_EXTRACT)),
            "model": "fake", "tokens": {}}


# ----- Tests -----------------------------------------------------------------

def test_outside_requires_vendor():
    _raises(workorders.create_wo, "outside work needs a vendor",
            "U-1", "Brakes", wo_type="outside")
    _raises(workorders.create_wo, "vendor not found",
            "U-1", "Brakes", wo_type="outside", vendor_id=999_999)
    _raises(workorders.create_wo, "wo_type must be inside or outside",
            "U-1", "Brakes", wo_type="bogus")
    shop = _vendor("Speedco", kind="shop", city="Fort Worth", state="tx")
    assert shop["kind"] == "shop" and shop["state"] == "TX", shop
    wo = workorders.create_wo("U-1", "Brakes", wo_type="outside",
                              vendor_id=shop["id"])
    assert wo["wo_type"] == "outside" and wo["vendor_id"] == shop["id"]
    assert wo["vendor_name"] == "Speedco" and wo["vendor_city"] == "Fort Worth"
    assert wo["vendor_state"] == "TX"
    # Sin mecánico nace open (no se exige); con mecánico, assigned.
    assert wo["status"] == "open"
    wo2 = workorders.create_wo("U-1", "Tires", wo_type="outside",
                               vendor_id=shop["id"], mechanic="Luis")
    assert wo2["status"] == "assigned"
    # Inside: con o sin vendor.
    ins = workorders.create_wo("U-1", "Oil change")
    assert ins["wo_type"] == "inside" and ins["vendor_id"] is None
    assert ins["vendor_name"] == ""
    ins2 = workorders.create_wo("U-1", "Oil change", vendor_id=shop["id"])
    assert ins2["wo_type"] == "inside" and ins2["vendor_name"] == "Speedco"
    # Las rutas traducen a 400.
    _http(routes.wo_create, 400,
          routes.WorkOrderIn(unit="U-1", title="x", wo_type="outside"), None)
    # Listado: todas las WOs traen los campos nuevos.
    for w in workorders.list_wos():
        for k in ("wo_type", "vendor_id", "vendor_name", "vendor_city",
                  "vendor_state"):
            assert k in w, k
    print("OK outside exige vendor al crear; inside opcional")


def test_type_locked_after_create():
    """v2.23: inside/outside se elige al crear y NO cambia después (ni en
    progreso). Mismo tipo = no-op; en una outside el vendor se reasigna
    pero no se quita; a una inside no se le liga vendor."""
    locked = workorders.TYPE_LOCKED_MSG
    assert locked == ("Work type can't be changed after the work order is "
                      "created. Delete it and create a new one.")
    shop = _vendor("Lock Shop", kind="shop")
    shop2 = _vendor("Reassign Shop", kind="shop")
    ins = workorders.create_wo("U-LT", "Oil change", mechanic="Luis")
    legacy = workorders.create_wo("U-LT", "Legacy inside",
                                  vendor_id=shop["id"])
    out = workorders.create_wo("U-LT", "Brakes @ shop", wo_type="outside",
                               vendor_id=shop["id"])
    workorders.update_wo(ins["id"], {"status": "in_progress"})
    # inside -> outside (con o sin vendor) y outside -> inside: bloqueado.
    _raises(workorders.update_wo, locked, ins["id"], {"wo_type": "outside"})
    _raises(workorders.update_wo, locked, ins["id"],
            {"wo_type": "outside", "vendor_id": shop["id"]})
    _raises(workorders.update_wo, locked, legacy["id"], {"wo_type": "outside"})
    _raises(workorders.update_wo, locked, out["id"],
            {"wo_type": "inside", "vendor_id": 0})
    _raises(workorders.update_wo, locked, out["id"], {"wo_type": "INSIDE"})
    _raises(workorders.update_wo, "wo_type must be inside or outside",
            out["id"], {"wo_type": "bogus"})
    # Un PATCH rechazado no deja nada a medias (ni el título que venía junto).
    _raises(workorders.update_wo, locked, ins["id"],
            {"title": "should not stick", "wo_type": "outside",
             "vendor_id": shop["id"]})
    again = workorders.get_wo(ins["id"])
    assert again["wo_type"] == "inside" and again["vendor_id"] is None
    assert again["title"] == "Oil change"
    assert again["status"] == "in_progress"
    again = workorders.get_wo(out["id"])
    assert again["wo_type"] == "outside" and again["vendor_id"] == shop["id"]
    # Mismo tipo = no-op (un cliente que reenvía el tipo sigue funcionando).
    w = workorders.update_wo(out["id"], {"wo_type": "outside",
                                         "title": "Brakes @ Lock Shop"})
    assert w["wo_type"] == "outside" and w["title"] == "Brakes @ Lock Shop"
    w = workorders.update_wo(ins["id"], {"wo_type": "inside",
                                         "complaint": "Leaking"})
    assert w["wo_type"] == "inside" and w["complaint"] == "Leaking"
    # Outside: el vendor se REASIGNA (con o sin el tipo en el PATCH)...
    w = workorders.update_wo(out["id"], {"vendor_id": shop2["id"]})
    assert w["vendor_id"] == shop2["id"]
    assert w["vendor_name"] == "Reassign Shop"
    w = workorders.update_wo(out["id"], {"wo_type": "outside",
                                         "vendor_id": shop["id"]})
    assert w["wo_type"] == "outside" and w["vendor_id"] == shop["id"]
    # ...pero no se quita (0 = quitar) ni apunta a uno inexistente.
    _raises(workorders.update_wo, "outside work needs a vendor",
            out["id"], {"vendor_id": 0})
    _raises(workorders.update_wo, "vendor not found",
            out["id"], {"vendor_id": 424242})
    assert workorders.get_wo(out["id"])["vendor_id"] == shop["id"]
    # Inside: no se liga un vendor; uno legacy se puede reenviar (no-op) o
    # quitar.
    _raises(workorders.update_wo, workorders.INSIDE_VENDOR_MSG,
            ins["id"], {"vendor_id": shop["id"]})
    assert workorders.get_wo(ins["id"])["vendor_id"] is None
    _raises(workorders.update_wo, workorders.INSIDE_VENDOR_MSG,
            legacy["id"], {"vendor_id": shop2["id"]})
    w = workorders.update_wo(legacy["id"], {"vendor_id": shop["id"]})
    assert w["wo_type"] == "inside" and w["vendor_id"] == shop["id"]
    w = workorders.update_wo(legacy["id"], {"vendor_id": 0})
    assert w["wo_type"] == "inside" and w["vendor_id"] is None
    # Ruta: el cambio de tipo es un 400 con el mensaje tal cual (para la UI).
    exc = _http(lambda: asyncio.run(routes.wo_patch(
        ins["id"], routes.WorkOrderPatch(wo_type="outside",
                                         vendor_id=shop["id"]),
        _request({}))), 400)
    assert exc.detail == locked
    exc = _http(lambda: asyncio.run(routes.wo_patch(
        out["id"], routes.WorkOrderPatch(wo_type="inside", vendor_id=0),
        _request({}))), 400)
    assert exc.detail == locked
    exc = _http(lambda: asyncio.run(routes.wo_patch(
        ins["id"], routes.WorkOrderPatch(vendor_id=shop["id"]),
        _request({}))), 400)
    assert exc.detail == workorders.INSIDE_VENDOR_MSG
    exc = _http(lambda: asyncio.run(routes.wo_patch(
        out["id"], routes.WorkOrderPatch(vendor_id=0), _request({}))), 400)
    assert "outside work needs a vendor" in exc.detail
    # La ruta sí reasigna el vendor de una outside y edita lo demás.
    w = asyncio.run(routes.wo_patch(
        out["id"], routes.WorkOrderPatch(vendor_id=shop2["id"],
                                         notes="Picked up Friday"),
        _request({})))
    assert w["wo_type"] == "outside" and w["vendor_id"] == shop2["id"]
    assert w["notes"] == "Picked up Friday"
    assert workorders.get_wo(ins["id"])["wo_type"] == "inside"
    print("OK tipo fijo tras crear (PATCH core + ruta 400); vendor "
          "reasignable")


def test_gate_skips_mechanic_for_outside():
    shop = _vendor("Boss Shop", kind="shop")
    out = workorders.create_wo("U-2", "Clutch", wo_type="outside",
                               vendor_id=shop["id"])
    assert out["mechanic"] == "" and out["status"] == "open"
    # Avanza sin mecánico.
    w = workorders.update_wo(out["id"], {"status": "in_progress"})
    assert w["status"] == "in_progress"
    w = workorders.update_wo(out["id"], {"status": "completed"})
    assert w["status"] == "completed"
    # El gate de líneas sigue aplicando a outside.
    _raises(workorders.update_wo, "add parts or labor lines before invoicing",
            out["id"], {"status": "invoiced"})
    workorders.add_line(out["id"], "labor", "Clutch R&R", 4, 120)
    w = workorders.update_wo(out["id"], {"status": "invoiced"})
    assert w["status"] == "invoiced" and w["invoiced_at"]
    # Inside: sin cambios — exige mecánico.
    ins = workorders.create_wo("U-2", "Clutch inside")
    _raises(workorders.update_wo, "assign a mechanic before moving past Open",
            ins["id"], {"status": "assigned"})
    w = workorders.update_wo(ins["id"], {"status": "assigned",
                                         "mechanic": "Luis"})
    assert w["status"] == "assigned"
    # gate_error directo (firma nueva: recibe la WO).
    with db.SessionLocal() as s:
        wo_o = s.get(db.WorkOrder, out["id"])
        wo_i = s.get(db.WorkOrder, ins["id"])
        assert workorders.gate_error("assigned", wo_o, 0.0) is None
        assert workorders.gate_error("invoiced", wo_o, 0.0) == \
            "add parts or labor lines before invoicing"
        wo_i.mechanic = ""
        assert workorders.gate_error("assigned", wo_i, 0.0) == \
            "assign a mechanic before moving past Open"
    print("OK gate de mecánico no aplica a outside; el de líneas sí")


def test_inventory_not_consumed_for_outside():
    _seed_part("P-OUT", 10)
    _seed_part("P-IN", 10)
    shop = _vendor("TA Truck Service", kind="shop")
    out = workorders.create_wo("U-3", "Outside brakes", wo_type="outside",
                               vendor_id=shop["id"])
    workorders.add_line(out["id"], "part", "Brake pads", 2, 50,
                        part_number="P-OUT")
    workorders.update_wo(out["id"], {"status": "invoiced"})
    assert _on_hand("P-OUT") == 10, "outside consumió stock"
    # Des-facturar y re-facturar tampoco.
    workorders.update_wo(out["id"], {"status": "completed"})
    workorders.update_wo(out["id"], {"status": "invoiced"})
    assert _on_hand("P-OUT") == 10
    ins = workorders.create_wo("U-3", "Inside brakes", mechanic="Luis")
    workorders.add_line(ins["id"], "part", "Brake pads", 2, 50,
                        part_number="P-IN")
    workorders.update_wo(ins["id"], {"status": "invoiced"})
    assert _on_hand("P-IN") == 8, _on_hand("P-IN")
    # Idempotente (guard de inventory.adjust).
    workorders.update_wo(ins["id"], {"status": "completed"})
    workorders.update_wo(ins["id"], {"status": "invoiced"})
    assert _on_hand("P-IN") == 8
    print("OK inventario: outside no consume; inside sí (idempotente)")


def test_vendor_match_scoring():
    loves = _vendor("Love's Truck Care", kind="shop", city="Amarillo",
                    state="TX")
    sp_dal = _vendor("Speedco", kind="shop", city="Dallas", state="TX")
    sp_okc = _vendor("Speedco", kind="shop", city="Oklahoma City",
                     state="OK")
    sounders = _vendor("Sounders Truck Repair", kind="shop")
    for i in range(7):
        _vendor(f"Generic Parts {i}", kind="parts")
    # Marca de cadena: el header genérico de Love's se normaliza a la marca.
    m = vendors.match("LOVES TRAVEL STOP #418 TOTAL TRUCK CARE", "Amarillo",
                      "TX")
    assert m["vendor"] and m["vendor"]["id"] == loves["id"], m
    assert m["candidates"][0]["id"] == loves["id"]
    assert m["candidates"][0]["score"] <= 1.0
    assert "kind" in m["vendor"] and m["vendor"]["kind"] == "shop"
    # Desempate por ciudad entre dos Speedco.
    m = vendors.match("Speedco", city="Oklahoma City")
    assert m["vendor"]["id"] == sp_okc["id"], m
    m = vendors.match("SPEEDCO TRUCK LUBE", city="dallas", state="TX")
    assert m["vendor"]["id"] == sp_dal["id"], m
    # Nombre parecido sin cadena conocida: ratio alto => match.
    m = vendors.match("Sounders Truck Repair Inc")
    assert m["vendor"] and m["vendor"]["id"] == sounders["id"], m
    # Bajo el umbral: sin match (los candidatos, si los hay, van con score).
    m = vendors.match("Bob's Garage")
    assert m["vendor"] is None, m
    assert len(m["candidates"]) <= 5
    # Máximo 5 candidatos.
    m = vendors.match("Generic Parts")
    assert m["vendor"] is None or m["vendor"]["name"].startswith("Generic")
    assert len(m["candidates"]) == 5, len(m["candidates"])
    assert all(set(c) == {"id", "name", "city", "state", "score"}
               for c in m["candidates"])
    # Nombre vacío: nada.
    assert vendors.match("") == {"vendor": None, "candidates": []}
    # Normalización pura.
    assert vendors.normalize("Love's Truck Care") == \
        vendors.normalize("LOVES TRAVEL STOP TOTAL TRUCK CARE")
    assert vendors.normalize("A&B Tire, Inc.") == "a and b tire inc"
    # Ruta.
    r = routes.vendors_match(routes.VendorMatchIn(name="speedco",
                                                  city="Oklahoma City"))
    assert r["vendor"]["id"] == sp_okc["id"]
    print("OK match de vendors: marca, ciudad, umbral, 5 candidatos")


def test_smart_fill_propose():
    loves = parts.list_vendors()
    loves = next(v for v in loves if v["name"] == "Love's Truck Care")
    wo = workorders.create_wo("CF2246", "PM")
    match = vendors.match(FAKE_EXTRACT["vendor"], "Amarillo", "TX")
    p = smart_fill.propose(FAKE_EXTRACT, wo, match)
    f = p["fields"]
    assert f["service_date"] == "2026-09-30"
    assert f["shop_invoice"] == "4009978541"
    assert f["mileage"] == 412_300          # el complaint de ESTA unidad
    # v2.23: WO inside existente => el tipo NO cambia aunque la factura
    # traiga taller, y no se propone vendor (se importa sin ligar el taller).
    assert f["wo_type"] == "inside"
    assert set(f) == {"service_date", "shop_invoice", "mileage", "wo_type"}, f
    # Líneas normalizadas: 'Labor' -> labor, descripción vacía fuera,
    # qty None -> 1, part_number None -> ''.
    ls = p["lines"]
    assert [ln["kind"] for ln in ls] == ["labor", "part", "part"], ls
    assert ls[0]["qty"] == 1.5 and ls[1]["qty"] == 39
    assert ls[2] == {"kind": "part", "description": "Filter", "qty": 1.0,
                     "unit_cost": 0.0, "part_number": ""}
    assert all(set(ln) == {"kind", "description", "qty", "unit_cost",
                           "part_number"} for ln in ls)
    # WO outside existente: sigue outside y propone el vendor del match
    # (reasignar el taller); sin match, sin vendor_id (queda el actual).
    out = workorders.create_wo("CF2246", "PM @ shop", wo_type="outside",
                               vendor_id=loves["id"])
    p = smart_fill.propose(FAKE_EXTRACT, out, match)
    assert p["fields"]["wo_type"] == "outside"
    assert p["fields"]["vendor_id"] == loves["id"]
    p = smart_fill.propose(FAKE_EXTRACT, out, None)
    assert p["fields"]["wo_type"] == "outside"
    assert "vendor_id" not in p["fields"]
    p = smart_fill.propose(dict(FAKE_EXTRACT, vendor=None), out, None)
    assert p["fields"]["wo_type"] == "outside"
    # WO NUEVA (None = /workorders/scan): la factura con taller decide
    # outside + vendor del match (sin cambios en v2.23).
    p = smart_fill.propose(FAKE_EXTRACT, None, match)
    assert p["fields"]["wo_type"] == "outside"
    assert p["fields"]["vendor_id"] == loves["id"]
    assert set(p["fields"]) == {"service_date", "shop_invoice", "mileage",
                                "wo_type", "vendor_id"}, p["fields"]
    # Sin vendor en el documento: conserva el tipo actual; sin match: sin
    # vendor_id; millaje del primer complaint si la unidad no coincide.
    x = dict(FAKE_EXTRACT, vendor=None)
    p = smart_fill.propose(x, {"unit": "ZZZ", "wo_type": "inside"}, None)
    assert p["fields"]["wo_type"] == "inside"
    assert "vendor_id" not in p["fields"]
    assert p["fields"]["mileage"] == 412_300
    # WO nueva (None): inside por defecto si no hay taller.
    assert smart_fill.propose({}, None, None) == {
        "fields": {"wo_type": "inside"}, "lines": []}
    print("OK propose: campos + líneas; tipo fijo en WO existente, por "
          "taller en WO nueva")


def test_smart_fill_apply_transaction():
    # v2.23: el alta del vendor por Smart Fill solo aplica a una WO outside
    # (reasigna el taller); el caso inside está en
    # test_smart_fill_inside_keeps_type.
    first = _vendor("First Scan Shop", kind="shop")
    wo = workorders.create_wo("CF2246", "PM from scan", wo_type="outside",
                              vendor_id=first["id"])
    workorders.add_line(wo["id"], "labor", "Old line", 1, 10)
    n_vendors = len(parts.list_vendors())
    out = smart_fill.apply(
        wo["id"],
        {"service_date": "2026-09-30", "shop_invoice": "INV-7",
         "mileage": 412_300, "wo_type": "outside", "title": "PM @ shop",
         "status": "invoiced", "mechanic": "hacker"},   # ignorados
        {"name": "New Shop LLC", "city": "Tulsa", "state": "ok"},
        [{"kind": "labor", "description": "PM", "qty": 1, "unit_cost": 100},
         {"kind": "part", "description": "Oil", "qty": 39,
          "unit_cost": 3.51, "part_number": "OIL"}],
        "replace")
    assert out["status"] == "open" and out["mechanic"] == ""
    assert out["title"] == "PM @ shop" and out["service_date"] == "2026-09-30"
    assert out["shop_invoice"] == "INV-7" and out["mileage"] == 412_300
    assert out["wo_type"] == "outside" and out["vendor_name"] == "New Shop LLC"
    assert out["vendor_city"] == "Tulsa" and out["vendor_state"] == "OK"
    assert [ln["description"] for ln in out["lines"]] == ["PM", "Oil"]
    assert out["total"] == round(100 + 39 * 3.51, 2)
    assert "links" in out and "service_requests" in out
    vs = parts.list_vendors()
    assert len(vs) == n_vendors + 1
    nv = next(v for v in vs if v["name"] == "New Shop LLC")
    assert nv["kind"] == "shop" and nv["wo_count"] == 1
    assert next(v for v in vs if v["id"] == first["id"])["wo_count"] == 0
    # Atómico: una línea inválida tira TODO (ni vendor, ni campos, ni líneas).
    _raises(smart_fill.apply, "invalid kind", wo["id"],
            {"title": "should not stick"}, {"name": "Ghost Vendor"},
            [{"kind": "bogus", "description": "x", "qty": 1, "unit_cost": 1}],
            "replace")
    after = workorders.get_wo(wo["id"])
    assert after["title"] == "PM @ shop"
    assert [ln["description"] for ln in after["lines"]] == ["PM", "Oil"]
    assert not [v for v in parts.list_vendors() if v["name"] == "Ghost Vendor"]
    # v2.23: cambiar el tipo => TYPE_LOCKED_MSG ANTES de crear el vendor.
    _raises(smart_fill.apply, workorders.TYPE_LOCKED_MSG, wo["id"],
            {"wo_type": "inside", "title": "should not stick"},
            {"name": "Ghost Vendor"}, [], "append")
    after = workorders.get_wo(wo["id"])
    assert after["title"] == "PM @ shop" and after["wo_type"] == "outside"
    assert after["vendor_name"] == "New Shop LLC"
    assert not [v for v in parts.list_vendors() if v["name"] == "Ghost Vendor"]
    assert len(parts.list_vendors()) == n_vendors + 1
    # Outside: también reasigna a un vendor existente (vendor_id).
    out = smart_fill.apply(wo["id"], {"vendor_id": first["id"]}, None, [],
                           "append")
    assert out["vendor_id"] == first["id"] and out["wo_type"] == "outside"
    out = smart_fill.apply(wo["id"], {"vendor_id": nv["id"]}, None, [],
                           "append")
    assert out["vendor_name"] == "New Shop LLC"
    _raises(smart_fill.apply, "lines_mode must be append or replace",
            wo["id"], {}, None, [], "merge")
    _raises(smart_fill.apply, "Vendor name is required",
            wo["id"], {}, {"name": "  "}, [], "append")
    # append conserva las existentes.
    out = smart_fill.apply(wo["id"], {}, None,
                           [{"kind": "part", "description": "Filter",
                             "qty": 1, "unit_cost": 20}], "append")
    assert len(out["lines"]) == 3
    # WO inexistente: None (ruta 404).
    assert smart_fill.apply(999_999, {}, None, [], "append") is None
    _http(routes.wo_smart_fill_apply, 404, 999_999,
          routes.SmartFillApplyIn())
    # Facturada: bloqueado (core y ruta).
    workorders.update_wo(wo["id"], {"status": "invoiced"})
    _raises(smart_fill.apply, smart_fill.INVOICED_MSG,
            wo["id"], {"title": "nope"}, None, [], "append")
    exc = _http(routes.wo_smart_fill_apply, 400, wo["id"],
                routes.SmartFillApplyIn(fields={"title": "nope"}))
    assert exc.detail == "un-invoice the work order before importing"
    print("OK apply: transacción todo-o-nada, vendor shop, replace/append")


def test_smart_fill_inside_keeps_type():
    """v2.23: Smart Fill sobre una WO INSIDE importa fecha, invoice #,
    millaje y líneas SIN ligar el taller. Ligar/crear un vendor o cambiar el
    tipo => 400 atómico: ni campos, ni líneas, ni vendor fantasma."""
    shop = _vendor("Inside Guard Shop", kind="shop")
    wo = workorders.create_wo("CF2246", "Inside import", mechanic="Luis")
    workorders.add_line(wo["id"], "labor", "Old", 1, 10)
    n_vendors = len(parts.list_vendors())
    ghost_line = [{"kind": "part", "description": "Ghost line", "qty": 1,
                   "unit_cost": 1}]
    # vendor_create en una inside: rechazado antes de crear el vendor.
    _raises(smart_fill.apply, workorders.INSIDE_VENDOR_MSG, wo["id"],
            {"title": "should not stick", "shop_invoice": "X-1"},
            {"name": "Ghost Inside Shop"}, ghost_line, "replace")
    # vendor_id en una inside: rechazado (rollback de lo demás).
    _raises(smart_fill.apply, workorders.INSIDE_VENDOR_MSG, wo["id"],
            {"vendor_id": shop["id"], "title": "should not stick"}, None,
            ghost_line, "append")
    # El flujo viejo (pasar a outside + crear/ligar el taller): tipo fijo.
    _raises(smart_fill.apply, workorders.TYPE_LOCKED_MSG, wo["id"],
            {"wo_type": "outside", "title": "should not stick"},
            {"name": "Ghost Inside Shop"}, ghost_line, "append")
    _raises(smart_fill.apply, workorders.TYPE_LOCKED_MSG, wo["id"],
            {"wo_type": "outside", "vendor_id": shop["id"]}, None, [],
            "append")
    # Ruta: el mismo rechazo es un 400 con el mensaje.
    exc = _http(routes.wo_smart_fill_apply, 400, wo["id"],
                routes.SmartFillApplyIn(
                    fields={"title": "should not stick"},
                    vendor_create=routes.SmartFillVendorCreate(
                        name="Ghost Inside Shop")))
    assert exc.detail == workorders.INSIDE_VENDOR_MSG
    exc = _http(routes.wo_smart_fill_apply, 400, wo["id"],
                routes.SmartFillApplyIn(fields={"wo_type": "outside"}))
    assert exc.detail == workorders.TYPE_LOCKED_MSG
    after = workorders.get_wo(wo["id"])
    assert after["title"] == "Inside import" and after["wo_type"] == "inside"
    assert after["vendor_id"] is None and after["shop_invoice"] == ""
    assert [ln["description"] for ln in after["lines"]] == ["Old"]
    assert len(parts.list_vendors()) == n_vendors
    assert not [v for v in parts.list_vendors()
                if v["name"] == "Ghost Inside Shop"]
    # Import solo de datos + líneas: funciona (wo_type igual = no-op).
    out = smart_fill.apply(
        wo["id"],
        {"service_date": "2026-09-30", "shop_invoice": "4009978541",
         "mileage": 412_300, "wo_type": "inside"},
        None,
        [{"kind": "part", "description": "Oil 15W40", "qty": 39,
          "unit_cost": 3.51, "part_number": "OIL-1540"}],
        "append")
    assert out["wo_type"] == "inside" and out["vendor_id"] is None
    assert out["vendor_name"] == "" and out["mechanic"] == "Luis"
    assert out["service_date"] == "2026-09-30"
    assert out["shop_invoice"] == "4009978541" and out["mileage"] == 412_300
    assert [ln["description"] for ln in out["lines"]] == ["Old", "Oil 15W40"]
    # Ida y vuelta: la propuesta para la inside (con taller en la factura y
    # match) se aplica tal cual, sin ligar el taller.
    match = vendors.match(FAKE_EXTRACT["vendor"], "Amarillo", "TX")
    assert match["vendor"] is not None
    p = smart_fill.propose(FAKE_EXTRACT, workorders.get_wo(wo["id"]), match)
    out = smart_fill.apply(wo["id"], p["fields"], None, p["lines"], "replace")
    assert out["wo_type"] == "inside" and out["vendor_id"] is None
    assert [ln["description"] for ln in out["lines"]] == [
        "PM service", "Oil 15W40", "Filter"]
    assert len(parts.list_vendors()) == n_vendors
    print("OK smart fill en WO inside: importa sin ligar taller; vendor/tipo "
          "=> 400 atómico")


def test_smart_fill_route():
    real_scan = docscan.scan
    docscan.scan = _fake_scan
    try:
        wo = workorders.create_wo("CF2246", "Scan me")
        # Sin archivo adjunto y use_attached: 400.
        exc = _http(lambda: asyncio.run(routes.wo_smart_fill(
            wo["id"], _request({"use_attached": True}))), 400)
        assert exc.detail == "no invoice file attached"
        # JSON sin use_attached: 400.
        _http(lambda: asyncio.run(routes.wo_smart_fill(
            wo["id"], _request({}))), 400)
        # WO inexistente: 404.
        _http(lambda: asyncio.run(routes.wo_smart_fill(
            999_999, _request({"use_attached": True}))), 404)
        # Multipart: escanea Y deja el archivo adjunto a la WO.
        body = _multipart_file("loves.pdf", b"%PDF-1.4 fake invoice",
                               "application/pdf")
        res = asyncio.run(routes.wo_smart_fill(
            wo["id"], _request(multipart=body)))
        assert set(res) == {"extract", "vendor_match", "proposed", "model"}
        assert res["model"] == "fake"
        assert res["extract"]["invoice_number"] == "4009978541"
        assert res["vendor_match"]["vendor"]["name"] == "Love's Truck Care"
        # v2.23: WO inside existente => el tipo no cambia y no se propone
        # vendor (el match igual viaja en vendor_match).
        assert res["proposed"]["fields"]["wo_type"] == "inside"
        assert "vendor_id" not in res["proposed"]["fields"]
        assert res["proposed"]["fields"]["mileage"] == 412_300
        assert len(res["proposed"]["lines"]) == 3
        assert wo_invoices.file_name(wo["id"]) == "loves.pdf"
        assert workorders.get_wo(wo["id"])["has_invoice_file"]
        # Tipo no soportado: 400 y no reemplaza el adjunto.
        _http(lambda: asyncio.run(routes.wo_smart_fill(
            wo["id"], _request(multipart=_multipart_file(
                "x.txt", b"hello", "text/plain")))), 400)
        assert wo_invoices.file_name(wo["id"]) == "loves.pdf"
        # Vacío: 400.
        _http(lambda: asyncio.run(routes.wo_smart_fill(
            wo["id"], _request(multipart=_multipart_file(
                "e.pdf", b"", "application/pdf")))), 400)
        # use_attached re-escanea el adjunto.
        res2 = asyncio.run(routes.wo_smart_fill(
            wo["id"], _request({"use_attached": True})))
        assert res2["proposed"] == res["proposed"]
        # El escáner falla => 400 con su mensaje.
        async def _boom(raw, media_type):
            raise ValueError("Ollama is not running")
        docscan.scan = _boom
        exc = _http(lambda: asyncio.run(routes.wo_smart_fill(
            wo["id"], _request({"use_attached": True}))), 400)
        assert "Ollama" in exc.detail
        docscan.scan = _fake_scan
        # Facturada: 400 antes de escanear.
        workorders.add_line(wo["id"], "labor", "x", 1, 10)
        workorders.update_wo(wo["id"], {"status": "invoiced",
                                        "mechanic": "Luis"})
        exc = _http(lambda: asyncio.run(routes.wo_smart_fill(
            wo["id"], _request({"use_attached": True}))), 400)
        assert exc.detail == smart_fill.INVOICED_MSG
        # /workorders/scan también devuelve vendor_match + proposed.
        class _Up:
            filename = "a.pdf"
            content_type = "application/pdf"

            async def read(self):
                return b"%PDF fake"
        out = asyncio.run(routes.wo_scan(_request({}), _Up()))
        assert out["model"] == "fake" and "extract" in out
        assert out["vendor_match"]["vendor"]["name"] == "Love's Truck Care"
        # WO NUEVA: el documento sigue decidiendo inside/outside.
        assert out["proposed"]["fields"]["wo_type"] == "outside"
        assert out["proposed"]["fields"]["vendor_id"] == \
            out["vendor_match"]["vendor"]["id"]
    finally:
        docscan.scan = real_scan
    print("OK ruta smart-fill: multipart adjunta, use_attached, 400s")


def test_lines_bulk():
    wo = workorders.create_wo("U-5", "Bulk")
    out = workorders.add_lines_bulk(wo["id"], [
        {"kind": "part", "description": "A", "qty": 2, "unit_cost": 5},
        {"kind": "labor", "description": "B", "qty": 1, "unit_cost": 50},
    ])
    assert out["n_lines"] == 2 and out["total"] == 60
    out = workorders.add_lines_bulk(wo["id"], [
        {"kind": "part", "description": "C", "qty": 1, "unit_cost": 7}])
    assert [ln["description"] for ln in out["lines"]] == ["A", "B", "C"]
    out = workorders.add_lines_bulk(wo["id"], [
        {"kind": "part", "description": "D", "qty": 1, "unit_cost": 1}],
        replace=True)
    assert [ln["description"] for ln in out["lines"]] == ["D"]
    # Validación atómica: nada se guarda si una línea falla.
    _raises(workorders.add_lines_bulk, "description is required", wo["id"],
            [{"kind": "part", "description": "E", "qty": 1, "unit_cost": 1},
             {"kind": "part", "description": " ", "qty": 1, "unit_cost": 1}])
    assert [ln["description"] for ln in workorders.get_wo(wo["id"])["lines"]] \
        == ["D"]
    assert workorders.add_lines_bulk(999_999, []) is None
    # Ruta.
    r = routes.wo_add_lines_bulk(wo["id"], routes.WoLinesBulkIn(
        lines=[routes.WoLineIn(kind="labor", description="R", qty=2,
                               unit_cost=10)], replace=True))
    assert [ln["description"] for ln in r["lines"]] == ["R"]
    _http(routes.wo_add_lines_bulk, 404, 999_999, routes.WoLinesBulkIn())
    _http(routes.wo_add_lines_bulk, 400, wo["id"], routes.WoLinesBulkIn(
        lines=[routes.WoLineIn(kind="x", description="R")]))
    print("OK lines/bulk append/replace atómico")


def test_vendor_delete_blocked_with_wos():
    a = _vendor("Shop A", kind="shop")
    b = _vendor("Shop B", kind="shop")
    wo = workorders.create_wo("U-6", "Out", wo_type="outside",
                              vendor_id=a["id"])
    _raises(parts.delete_vendor, "vendor has work orders; reassign them first",
            a["id"])
    exc = _http(routes.vendors_delete, 400, a["id"])
    assert exc.detail == "vendor has work orders; reassign them first"
    assert next(v for v in parts.list_vendors()
                if v["id"] == a["id"])["wo_count"] == 1
    # Reasignar y borrar.
    workorders.update_wo(wo["id"], {"vendor_id": b["id"]})
    assert parts.delete_vendor(a["id"]) is True
    assert not [v for v in parts.list_vendors() if v["id"] == a["id"]]
    _http(routes.vendors_delete, 404, a["id"])
    # PATCH /vendors acepta kind/city/state (kind inválido => 400).
    v = parts.update_vendor(b["id"], {"kind": "both", "city": "Reno",
                                      "state": "nv"})
    assert (v["kind"], v["city"], v["state"], v["wo_count"]) == \
        ("both", "Reno", "NV", 1)
    _raises(parts.update_vendor, "kind must be", b["id"], {"kind": "weird"})
    # v2.23: una WO inside legacy con vendor (creada por API) también traba
    # el borrado; el tipo no cambia y no se reasigna, pero se DESLIGA
    # (vendor_id 0 = "Unlink shop" del detalle) y el vendor ya se borra.
    c = _vendor("Shop C", kind="shop")
    leg = workorders.create_wo("U-6", "Legacy inside", vendor_id=c["id"])
    assert leg["wo_type"] == "inside" and leg["vendor_id"] == c["id"]
    _raises(parts.delete_vendor, "reassign them first", c["id"])
    _raises(workorders.update_wo, workorders.INSIDE_VENDOR_MSG,
            leg["id"], {"vendor_id": b["id"]})
    w = asyncio.run(routes.wo_patch(
        leg["id"], routes.WorkOrderPatch(vendor_id=0), _request({})))
    assert w["wo_type"] == "inside" and w["vendor_id"] is None
    assert parts.delete_vendor(c["id"]) is True
    print("OK vendor con WOs no se borra; kind/city/state editables; "
          "inside legacy se desliga")


def test_reefer_auto_wo_delete_no_duplicate():
    """v2.23: la WO automática del puente reefer nace inside y su tipo no
    cambia. El camino que indica TYPE_LOCKED_MSG (borrarla y crear otra, p.ej.
    outside) NO debe terminar con el puente recreando una inside duplicada
    mientras el fault siga activo."""
    shop = _vendor("Reefer Dealer", kind="shop")

    def snap(*codes):
        return {"available": True, "units": [{
            "unit": "RF-1", "source": "lynx",
            "alarms": [{"code": c, "severity": 3,
                        "description": "Engine stopped"} for c in codes]}]}

    def live():
        return sorted((w["id"], w["wo_type"], w["source"])
                      for w in workorders.list_wos(unit="RF-1")
                      if w["status"] in reefer_wo._OPEN_STATUSES)

    made = reefer_wo.sync(snap("63"))
    assert len(made) == 1 and made[0]["code"] == "63", made
    auto = workorders.get_wo(made[0]["wo_id"])
    assert (auto["wo_type"], auto["source"]) == ("inside", "reefer")
    assert reefer_wo.sync(snap("63")) == []          # idempotente
    _raises(workorders.update_wo, workorders.TYPE_LOCKED_MSG, auto["id"],
            {"wo_type": "outside", "vendor_id": shop["id"]})
    # El camino del mensaje: borrar y crear una outside nueva (sin marker).
    assert workorders.delete_wo(auto["id"]) is True
    out = workorders.create_wo("RF-1", "Reefer fault 63 at dealer",
                               wo_type="outside", vendor_id=shop["id"])
    assert reefer_wo.sync(snap("63")) == []
    assert reefer_wo.sync(snap("63")) == []
    assert live() == [(out["id"], "outside", "manual")], live()
    # El fault se va (la unidad sigue en el snapshot sin ese código): el
    # descarte se olvida; una nueva ocurrencia sí abre WO.
    assert reefer_wo.sync(snap()) == []
    assert "RF-1" not in reefer_wo._dismissed()
    again = reefer_wo.sync(snap("63"))
    assert len(again) == 1, again
    # Marker en una WO viva de cualquier source/tipo => no duplica.
    workorders.create_wo("RF-1", "Fault 64 @ dealer", wo_type="outside",
                         vendor_id=shop["id"], complaint="Dealer [rf:64]")
    assert reefer_wo.sync(snap("63", "64")) == []
    # Borrar una WO del puente ya CERRADA no descarta nada; borrar una viva
    # de otra unidad tampoco toca RF-1.
    reefer_wo.on_wos_deleted([{"unit": "RF-2", "status": "invoiced",
                               "source": "reefer", "complaint": "[rf:9]"}])
    assert "RF-2" not in reefer_wo._dismissed()
    assert workorders.delete_wo(again[0]["wo_id"]) is True
    assert set(reefer_wo._dismissed().get("RF-1") or {}) == {"63"}
    assert reefer_wo.sync(snap("63", "64")) == []
    print("OK reefer: borrar la WO automática no la recrea mientras el "
          "fault siga activo")


def test_list_filters_and_stats():
    shop = _vendor("Filter Shop", kind="shop")
    other = _vendor("Other Shop", kind="shop")
    base = workorders.stats()["outside_open"]
    o1 = workorders.create_wo("U-7", "O1", wo_type="outside",
                              vendor_id=shop["id"])
    o2 = workorders.create_wo("U-7", "O2", wo_type="outside",
                              vendor_id=other["id"])
    i1 = workorders.create_wo("U-7", "I1")
    outs = workorders.list_wos(unit="U-7", wo_type="outside")
    assert {w["id"] for w in outs} == {o1["id"], o2["id"]}
    ins = workorders.list_wos(unit="U-7", wo_type="inside")
    assert {w["id"] for w in ins} == {i1["id"]}
    byv = workorders.list_wos(vendor_id=shop["id"])
    assert {w["id"] for w in byv} == {o1["id"]}
    assert {w["id"] for w in workorders.list_wos(unit="U-7")} == \
        {o1["id"], o2["id"], i1["id"]}
    # Filtro inválido se ignora.
    assert len(workorders.list_wos(unit="U-7", wo_type="bogus")) == 3
    # Ruta con query params.
    r = routes.wo_list(unit="U-7", wo_type="outside", vendor_id=other["id"])
    assert [w["id"] for w in r["workorders"]] == [o2["id"]]
    assert "outside_open" in r["stats"] and "mechanics" in r
    assert r["stats"]["outside_open"] == base + 2
    workorders.add_line(o1["id"], "labor", "x", 1, 10)
    workorders.update_wo(o1["id"], {"status": "invoiced"})
    assert workorders.stats()["outside_open"] == base + 1
    print("OK list_wos filtra por wo_type/vendor_id; stats.outside_open")


def test_service_requests_default_inside():
    real = fleet_inventory.load

    async def _no_fleet(refresh: bool = False):
        return {"available": False, "source": "none", "units": []}
    fleet_inventory.load = _no_fleet
    try:
        m = sr.create_manual("SR-1", "Brake noise")
        out = sr.create_wo([m["id"]], mechanic="Luis")
        wo = out["workorder"]
        assert wo["wo_type"] == "inside" and wo["vendor_id"] is None
        assert wo["status"] == "assigned"
        assert out["requests"][0]["status"] == "on_wo"
    finally:
        fleet_inventory.load = real
    print("OK service_requests.create_wo sigue creando WOs inside")


def test_service_requests_create_outside():
    """v2.23: 'Create work order' desde Service Requests elige inside/outside
    al crear (después no cambia). Outside = vendor obligatorio y existente,
    el técnico se ignora: la misma WO outside que crea POST /workorders.
    Inside (default) ignora un vendor. Add to… sirve para ambos tipos."""
    real = fleet_inventory.load

    async def _no_fleet(refresh: bool = False):
        return {"available": False, "source": "none", "units": []}
    fleet_inventory.load = _no_fleet
    try:
        shop = _vendor("SR Outside Shop", kind="shop")
        a = sr.create_manual("SR-2", "Transmission leak")
        b = sr.create_manual("SR-2", "Clutch slipping")
        n0 = len(workorders.list_wos(unit="SR-2"))
        # Outside sin vendor / vendor inexistente / tipo inválido => nada
        # queda (ni WO ni vínculo).
        _raises(sr.create_wo, "outside work needs a vendor", [a["id"]],
                wo_type="outside")
        _raises(sr.create_wo, "vendor not found", [a["id"]],
                wo_type="outside", vendor_id=999_999)
        _raises(sr.create_wo, "wo_type must be inside or outside",
                [a["id"]], wo_type="bogus")
        assert len(workorders.list_wos(unit="SR-2")) == n0
        assert sr.get_request(a["id"])["status"] == "open"
        assert sr.get_request(a["id"])["wo_id"] is None
        # Outside con vendor: el técnico del body se ignora (ni en la WO ni
        # en el roster) y nace open, como una outside de POST /workorders.
        out = sr.create_wo([a["id"], b["id"]], mechanic="Ghost Tech",
                           wo_type="outside", vendor_id=shop["id"])
        wo = out["workorder"]
        assert wo["wo_type"] == "outside" and wo["vendor_id"] == shop["id"]
        assert wo["vendor_name"] == "SR Outside Shop"
        assert wo["mechanic"] == "" and wo["status"] == "open"
        assert wo["source"] == "request"
        assert wo["title"] == "Transmission leak (+1 more)"
        assert sorted(x["id"] for x in wo["service_requests"]) == sorted(
            [a["id"], b["id"]])
        for r in out["requests"]:
            assert r["status"] == "on_wo" and r["wo_id"] == wo["id"]
        assert not [t for t in technicians.list_technicians(False)
                    if t["name"] == "Ghost Tech"]
        # Avanza sin técnico (gate de outside) y el tipo queda fijo.
        w = workorders.update_wo(wo["id"], {"status": "in_progress"})
        assert w["status"] == "in_progress"
        _raises(workorders.update_wo, workorders.TYPE_LOCKED_MSG, wo["id"],
                {"wo_type": "inside"})
        # Add to… sobre una WO outside sigue funcionando.
        c = sr.create_manual("SR-2", "Air leak")
        added = sr.add_to_wo(c["id"], wo["id"])
        assert added["request"]["status"] == "on_wo"
        assert added["workorder"]["wo_type"] == "outside"
        assert added["workorder"]["vendor_id"] == shop["id"]
        # Inside (default) ignora un vendor colado; el técnico sí entra.
        d = sr.create_manual("SR-2", "Wipers")
        ins = sr.create_wo([d["id"]], mechanic="Luis",
                           vendor_id=shop["id"])["workorder"]
        assert ins["wo_type"] == "inside" and ins["vendor_id"] is None
        assert ins["mechanic"] == "Luis" and ins["status"] == "assigned"
        # Ruta: body con wo_type/vendor_id; outside sin vendor => 400.
        e = sr.create_manual("SR-2", "Mud flaps")
        exc = _http(routes.sr_create_wo, 400,
                    routes.SrCreateWoIn(ids=[e["id"]], wo_type="outside"),
                    _request({}))
        assert exc.detail ==             "outside work needs a vendor (the third-party shop)"
        assert sr.get_request(e["id"])["status"] == "open"
        r = routes.sr_create_wo(routes.SrCreateWoIn(
            ids=[e["id"]], wo_type="outside", vendor_id=shop["id"]),
            _request({}))
        assert r["workorder"]["wo_type"] == "outside"
        assert r["workorder"]["vendor_id"] == shop["id"]
        m = routes.SrCreateWoIn(ids=[1])
        assert m.wo_type == "inside" and m.vendor_id is None
        assert _scope_for("POST", "/api/service-requests/create-wo") == \
            "maint.edit"
    finally:
        fleet_inventory.load = real
    print("OK service_requests.create_wo outside: vendor obligatorio, sin "
          "técnico")


def test_routes_and_rbac():
    paths = [r.path for r in routes.router.routes]
    for p in ("/api/workorders/{wo_id}/smart-fill",
              "/api/workorders/{wo_id}/smart-fill/apply",
              "/api/workorders/{wo_id}/lines/bulk",
              "/api/vendors/match",
              "/api/technicians", "/api/technicians/{tech_id}"):
        assert p in paths, p
    assert paths.index("/api/vendors/match") < \
        paths.index("/api/vendors/{vendor_id}")
    assert _scope_for("POST", "/api/vendors/match") == "maint.edit"
    assert _scope_for("POST", "/api/workorders/3/smart-fill") == "maint.edit"
    assert _scope_for("POST", "/api/workorders/3/smart-fill/apply") == \
        "maint.edit"
    assert _scope_for("POST", "/api/workorders/3/lines/bulk") == "maint.edit"
    assert _scope_for("GET", "/api/workorders") is None
    assert _scope_for("DELETE", "/api/vendors/3") == "maint.edit"
    # Modelos: el POST/PATCH de WO aceptan wo_type/vendor_id (v2.23: el
    # PATCH conserva wo_type para que un cliente viejo reciba el 400 de
    # tipo fijo, test_type_locked_after_create).
    assert routes.WorkOrderIn(unit="u", title="t").wo_type == "inside"
    p = routes.WorkOrderPatch(wo_type="outside", vendor_id=3)
    d = {k: v for k, v in p.model_dump().items() if v is not None}
    assert d == {"wo_type": "outside", "vendor_id": 3}
    print("OK rutas + RBAC v2.21")


def test_vendor_match_location_and_brand_guards():
    """Misma cadena en OTRA ciudad/estado no se liga sola; sin ciudad en la
    factura y dos talleres de la cadena => ambiguo (None); nombres ajenos que
    contienen una marca como substring ('Delta Truck', 'Autopilot', 'Gloves')
    NO colapsan a la marca."""
    # Hay varios Speedco con ciudad (Fort Worth, Dallas, OKC; tests previos):
    # otra ciudad => ninguno se liga solo y todos quedan topeados.
    m = vendors.match("SPEEDCO TRUCK LUBE #214", "Amarillo", "TX")
    assert m["vendor"] is None, m
    sp = [c for c in m["candidates"] if c["name"] == "Speedco"]
    assert len(sp) >= 2 and all(c["score"] <= 0.80 for c in sp), sp
    # Sin ciudad en la factura: los Speedco con ciudad empatan => None.
    m = vendors.match("Speedco")
    assert m["vendor"] is None, m
    assert len([c for c in m["candidates"] if c["name"] == "Speedco"]) >= 2
    # Con la ciudad sí desempata (como antes).
    assert vendors.match("Speedco", city="Dallas")["vendor"]["city"] == "Dallas"
    # Dos vendors de la misma cadena SIN ciudad en el catálogo: empate => None.
    _vendor("Petro", kind="shop")
    _vendor("Petro Stopping Center", kind="shop")
    m = vendors.match("PETRO #42")
    assert m["vendor"] is None and len(m["candidates"]) >= 2, m
    # Marca solo como palabra completa (docscan._CHAINS son substrings).
    delta = _vendor("Delta Truck Repair", kind="shop")
    auto = _vendor("Autopilot Diesel Service", kind="shop")
    gloves = _vendor("Gloves & Tools Supply", kind="parts")
    for name in ("Delta Truck Repair", "Autopilot Diesel Service",
                 "Gloves & Tools Supply"):
        assert vendors.brand_of(name) == "", name
        assert vendors.normalize(name) != vendors.normalize(
            vendors.brand_of("TA Truck Service"))
    assert vendors.brand_of("TA Truck Service #12") == "TA Truck Service"
    assert vendors.brand_of("Pilot Travel Center #330") == "Pilot / Flying J"
    assert vendors.brand_of("Love's Travel Stop #418") == "Love's Truck Care"
    assert vendors.brand_of("LOVES TRAVEL STOP") == "Love's Truck Care"
    for name, bad in (("TA Truck Service", delta["id"]),
                      ("Pilot Travel Center #330", auto["id"]),
                      ("Love's Travel Stop #418", gloves["id"])):
        m = vendors.match(name, "Houston", "TX")
        assert not (m["vendor"] and m["vendor"]["id"] == bad), (name, m)
    # El taller ajeno sigue matcheando consigo mismo (ratio).
    assert vendors.match("Delta Truck Repair Inc")["vendor"]["id"] == delta["id"]
    print("OK match: ubicación manda en cadenas, empate => None, marca entera")


def test_smart_fill_keeps_attachment_on_failed_scan():
    """Smart Fill escanea ANTES de reemplazar el adjunto: HEIC (que docscan
    no lee), proveedor caído, etc. => 400 y la factura previa intacta. La
    extensión manda sobre el Content-Type del cliente."""
    real_scan = docscan.scan
    seen: dict = {}

    async def _record(raw, media_type):
        seen["media_type"] = media_type
        return await _fake_scan(raw, media_type)
    docscan.scan = _record
    try:
        wo = workorders.create_wo("CF2246", "Keep my invoice")
        asyncio.run(routes.wo_smart_fill(wo["id"], _request(
            multipart=_multipart_file("loves.pdf", b"%PDF-1.4 real",
                                      "application/pdf"))))
        assert wo_invoices.file_name(wo["id"]) == "loves.pdf"
        # HEIC: la extensión pasa por wo_invoices pero docscan no lo lee.
        exc = _http(lambda: asyncio.run(routes.wo_smart_fill(
            wo["id"], _request(multipart=_multipart_file(
                "IMG_0001.heic", b"HEIC", "image/heic")))), 400)
        assert "Smart Fill" in exc.detail
        assert wo_invoices.file_name(wo["id"]) == "loves.pdf"
        assert wo_invoices.read_file(wo["id"])[0] == b"%PDF-1.4 real"
        # Proveedor caído con un archivo válido.
        async def _boom(raw, media_type):
            raise ValueError("Ollama is not running")
        docscan.scan = _boom
        exc = _http(lambda: asyncio.run(routes.wo_smart_fill(
            wo["id"], _request(multipart=_multipart_file(
                "blurry.jpg", b"JPGDATA", "image/jpeg")))), 400)
        assert "Ollama" in exc.detail
        assert wo_invoices.file_name(wo["id"]) == "loves.pdf"
        assert wo_invoices.read_file(wo["id"])[0] == b"%PDF-1.4 real"
        docscan.scan = _record
        # x.pdf enviado como image/png: se escanea y guarda como PDF.
        asyncio.run(routes.wo_smart_fill(wo["id"], _request(
            multipart=_multipart_file("x.pdf", b"%PDF-1.4 two",
                                      "image/png"))))
        assert seen["media_type"] == "application/pdf"
        assert wo_invoices.read_file(wo["id"])[1] == "application/pdf"
        # scan.jpg como octet-stream (Windows): image/jpeg por la extensión.
        asyncio.run(routes.wo_smart_fill(wo["id"], _request(
            multipart=_multipart_file("scan.jpg", b"JPG2",
                                      "application/octet-stream"))))
        assert seen["media_type"] == "image/jpeg"
        assert wo_invoices.file_name(wo["id"]) == "scan.jpg"
    finally:
        docscan.scan = real_scan
    print("OK smart-fill: escanea antes de guardar; la extensión manda")


def test_lines_locked_when_invoiced():
    """Las líneas de una WO facturada están congeladas (bulk replace, add,
    delete => 400): el consumo de stock ya se registró por id de línea."""
    _seed_part("P-LOCK", 10)
    wo = workorders.create_wo("U-LOCK", "Lock", mechanic="Luis")
    workorders.add_line(wo["id"], "part", "P", 2, 5, part_number="P-LOCK")
    workorders.update_wo(wo["id"], {"status": "invoiced"})
    assert _on_hand("P-LOCK") == 8
    line_id = workorders.get_wo(wo["id"])["lines"][0]["id"]
    new = [{"kind": "part", "description": "P", "qty": 2, "unit_cost": 5,
            "part_number": "P-LOCK"}]
    _raises(workorders.add_lines_bulk, workorders.LINES_LOCKED_MSG,
            wo["id"], new, True)
    _raises(workorders.add_lines_bulk, workorders.LINES_LOCKED_MSG,
            wo["id"], new)
    _raises(workorders.add_line, workorders.LINES_LOCKED_MSG,
            wo["id"], "labor", "x", 1, 1)
    _raises(workorders.delete_line, workorders.LINES_LOCKED_MSG,
            wo["id"], line_id)
    assert [ln["id"] for ln in workorders.get_wo(wo["id"])["lines"]] \
        == [line_id]
    # Rutas => 400.
    exc = _http(routes.wo_add_lines_bulk, 400, wo["id"], routes.WoLinesBulkIn(
        lines=[routes.WoLineIn(kind="labor", description="R", qty=1,
                               unit_cost=1)], replace=True))
    assert exc.detail == workorders.LINES_LOCKED_MSG
    _http(routes.wo_del_line, 400, wo["id"], line_id)
    _http(routes.wo_add_line, 400, wo["id"],
          routes.WoLineIn(kind="labor", description="R", qty=1, unit_cost=1))
    # Des-facturar habilita editar; re-facturar no duplica el consumo.
    workorders.update_wo(wo["id"], {"status": "completed"})
    workorders.add_lines_bulk(wo["id"], [
        {"kind": "labor", "description": "ok", "qty": 1, "unit_cost": 1}])
    workorders.update_wo(wo["id"], {"status": "invoiced"})
    assert _on_hand("P-LOCK") == 8
    print("OK líneas congeladas en WO facturada (bulk/add/delete => 400)")


def test_invoice_file_routes_are_org_scoped():
    """Las rutas del adjunto (ver, miniatura, borrar, smart-fill) pasan por
    la WO de la org actual: otra org recibe 404 y no toca el archivo."""
    wo = workorders.create_wo("CF2246", "Org A invoice")
    wo_invoices.save_file(wo["id"], "secret.pdf", b"%PDF-1.4 secret")
    with db.SessionLocal() as s:
        org2 = db.Organization(slug="other-ow", name="Other", active=True,
                               created_at=datetime.now())
        s.add(org2)
        s.commit()
        org2_id = org2.id
    token = tenant.set_current_org(org2_id)
    try:
        _http(routes.wo_invoice_file_download, 404, wo["id"])
        _http(routes.wo_invoice_file_thumb, 404, wo["id"])
        _http(routes.wo_invoice_file_delete, 404, wo["id"])
        _http(lambda: asyncio.run(routes.wo_smart_fill(
            wo["id"], _request({"use_attached": True}))), 404)
    finally:
        tenant.reset_current_org(token)
    tenant.set_current_org(ORG)
    assert wo_invoices.file_name(wo["id"]) == "secret.pdf"
    assert routes.wo_invoice_file_download(wo["id"]).filename == "secret.pdf"
    assert routes.wo_invoice_file_delete(wo["id"]) == {"ok": True}
    assert wo_invoices.file_name(wo["id"]) is None
    print("OK adjuntos de factura acotados a la org")


if __name__ == "__main__":
    test_outside_requires_vendor()
    test_type_locked_after_create()
    test_gate_skips_mechanic_for_outside()
    test_inventory_not_consumed_for_outside()
    test_vendor_match_scoring()
    test_vendor_match_location_and_brand_guards()
    test_smart_fill_propose()
    test_smart_fill_apply_transaction()
    test_smart_fill_inside_keeps_type()
    test_smart_fill_route()
    test_smart_fill_keeps_attachment_on_failed_scan()
    test_lines_bulk()
    test_lines_locked_when_invoiced()
    test_vendor_delete_blocked_with_wos()
    test_reefer_auto_wo_delete_no_duplicate()
    test_list_filters_and_stats()
    test_service_requests_default_inside()
    test_service_requests_create_outside()
    test_routes_and_rbac()
    test_invoice_file_routes_are_org_scoped()
    print("\nALL OUTSIDE WORK TESTS PASSED")
