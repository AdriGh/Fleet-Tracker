# -*- coding: utf-8 -*-
"""Tests de POs editables post-recepción + costeo (v2.22, benchmark SR).

Corre como script suelto: `py backend/tests/test_po_costing.py`. DB SQLite
temporal fresca (DATABASE_URL antes de importar app.db).

Lo que NO hay que perder (toca valuación de inventario en prod):
  - avg_cost = promedio ponderado móvil en cada recepción (fallback al cost
    estándar cuando no había avg; oh<=0 -> c); last_cost = costo landed;
    cada movimiento guarda unit_cost/value_delta/actor;
  - editar el costo de una línea YA recibida (a cualquier status / con la PO
    cerrada) escribe UN po_cost_adj (delta 0, value_delta = Δc × qr,
    ref '<line>:c<n>') y revalúa avg SOLO por la porción en stock; lo
    consumido queda como varianza; dry_run no persiste;
  - qty no baja de lo recibido; no se borra una línea / PO con recibido;
    borrar una PO desliga sus parts requests;
  - unreceive: po_unreceive negativo, revierte avg, anula cores pendientes,
    status received -> ordered, y se puede re-recibir (refs versionados);
    PATCH status received->ordered = 400 "unreceive lines instead";
  - ajustes: financial summary, allocate prorratea landed (tax solo a las
    gravadas), revalúa lo recibido; payment nunca prorratea; void revierte;
  - close/reopen solo fin_status; stats.open_value excluye cerradas y
    recibidas; request_stats usa received_at;
  - auditoría por PO; rutas (actor, 400/404) + RBAC maint.edit;
  - zona horaria de la org (org_now/org_today/week_bounds/org_day_start).
"""

import os
import sys
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

_TMP = Path(tempfile.mkdtemp())
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP / 'po_costing_test.db'}"

from fastapi import HTTPException                       # noqa: E402
from sqlalchemy import select                           # noqa: E402

from app import db                                      # noqa: E402
from app.api import routes                              # noqa: E402
from app.core import (                                  # noqa: E402
    inventory, org_config, parts, purchasing, tenant,
)
from app.main import _scope_for                         # noqa: E402

ORG = db.default_org_id()
tenant.set_current_org(ORG)
REQ = SimpleNamespace(state=SimpleNamespace(user={"name": "Ana Tester"}))


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


def _seed_part(pn: str, on_hand: float = 0.0, cost: float = 1.0,
               avg: float = 0.0, core: float = 0.0) -> None:
    now = datetime.now()
    with db.SessionLocal() as s:
        s.add(db.Part(part_number=pn, description=pn, on_hand=on_hand,
                      cost=cost, avg_cost=avg, core_charge=core,
                      created_at=now, updated_at=now))
        s.commit()


def _part(pn: str) -> db.Part:
    with db.SessionLocal() as s:
        p = s.scalar(select(db.Part).where(db.Part.part_number == pn))
        s.expunge(p)
        return p


def _moves(pn: str, reason: str | None = None) -> list[db.PartStockMovement]:
    with db.SessionLocal() as s:
        q = select(db.PartStockMovement).where(
            db.PartStockMovement.part_number == pn)
        if reason:
            q = q.where(db.PartStockMovement.reason == reason)
        rows = s.scalars(q.order_by(db.PartStockMovement.id)).all()
        for r in rows:
            s.expunge(r)
        return rows


def _approx(a, b, tol=1e-4):
    assert a is not None and abs(float(a) - float(b)) <= tol, (a, b)


def _line(po: dict, pn: str) -> dict:
    return next(x for x in po["lines"] if x["part_number"] == pn)


def _received_po(vendor: str, lines: list[dict], token: str) -> dict:
    po = purchasing.create_po(vendor, lines=lines, actor="Ana")
    purchasing.update_po(po["id"], {"status": "ordered"}, actor="Ana")
    res = purchasing.receive_po(
        po["id"], [{"line_id": ln["id"], "qty_now": ln["qty"]}
                   for ln in po["lines"]],
        token=token, create_backorder=False, actor="Ana")
    return res["po"]


# ----- Tests -----------------------------------------------------------------

def test_weighted_average_on_receive():
    # Sin stock: avg = c, last_cost = c, el movimiento guarda costo y actor.
    _seed_part("W1", on_hand=0, cost=3.0)
    po = _received_po("Acme", [{"part_number": "W1", "qty": 10,
                                "unit_cost": 5}], "w1")
    p = _part("W1")
    _approx(p.on_hand, 10)
    _approx(p.avg_cost, 5)
    _approx(p.last_cost, 5)
    m = _moves("W1", "po_receive")[-1]
    _approx(m.unit_cost, 5)
    _approx(m.value_delta, 50)
    assert m.actor == "Ana", m.actor
    # Segunda recepción a otro costo: promedio ponderado.
    _received_po("Acme", [{"part_number": "W1", "qty": 10,
                           "unit_cost": 7}], "w2")
    p = _part("W1")
    _approx(p.avg_cost, 6)
    _approx(p.last_cost, 7)
    # Stock previo sin avg calculado: el base es el cost estándar.
    _seed_part("W2", on_hand=5, cost=10.0, avg=0.0)
    _received_po("Acme", [{"part_number": "W2", "qty": 5,
                           "unit_cost": 12}], "w3")
    _approx(_part("W2").avg_cost, 11)
    # El consumo de WO sale al avg vigente (no lo mueve) y queda valuado.
    inventory.adjust("W2", -2, "wo_consume", ref_type="wo_line", ref_id="9")
    _approx(_part("W2").avg_cost, 11)
    m = _moves("W2", "wo_consume")[-1]
    _approx(m.unit_cost, 11)
    _approx(m.value_delta, -22)
    # La ficha de la parte expone avg_cost + last_cost.
    pd = next(x for x in parts.list_parts() if x["part_number"] == "W2")
    assert pd["avg_cost"] == 11 and pd["last_cost"] == 12, pd
    assert po["financial"]["total"] == 50, po["financial"]
    print("OK weighted average + last_cost + valued movements")


def test_cost_edit_after_receipt():
    # 10 en stock de otra PO a $4, esta PO recibe 10 a $5 -> avg 4.5, oh 20.
    _seed_part("R1", on_hand=0, cost=4.0)
    _received_po("Old", [{"part_number": "R1", "qty": 10, "unit_cost": 4}],
                 "r0")
    po = _received_po("Acme", [{"part_number": "R1", "qty": 10,
                                "unit_cost": 5}], "r1")
    assert po["status"] == "received"
    lid = _line(po, "R1")["id"]
    _approx(_part("R1").avg_cost, 4.5)
    # Se consumen 6 (WO facturada) -> oh 14.
    inventory.adjust("R1", -6, "wo_consume", ref_type="wo_line", ref_id="1")
    _approx(_part("R1").on_hand, 14)
    # La PO se cierra financieramente: SIGUE editable.
    closed = purchasing.close_po(po["id"], actor="Ana")
    assert closed["fin_status"] == "closed" and closed["closed_at"]
    # dry_run: preview sin persistir.
    prev = purchasing.update_line(po["id"], lid, {"unit_cost": 6},
                                  actor="Ana", dry_run=True)
    assert prev["dry_run"] is True
    rv = prev["revaluations"][0]
    _approx(rv["avg_old"], 4.5)
    # Promedio móvil: los 6 consumidos salieron en proporción (3 viejos + 3
    # de esta PO) -> quedan 7 de esta recepción; avg = 4.5 + 1*7/14 = 5.0,
    # lo mismo que si se hubiera recibido a $6 desde el principio.
    _approx(rv["avg_new"], 5.0)
    _approx(rv["revalued_qty"], 7)
    _approx(rv["consumed_qty"], 3)
    _approx(rv["value_delta"], 10)
    _approx(_part("R1").avg_cost, 4.5)
    assert not _moves("R1", "po_cost_adj"), "dry_run persistió"
    assert purchasing.get_po(po["id"])["lines"][0]["unit_cost"] == 5
    # Real: UN po_cost_adj delta 0, value Δc×qr, ref ':c1', avg por lo en stock.
    out = purchasing.update_line(po["id"], lid, {"unit_cost": 6},
                                 actor="Ana")
    assert out["fin_status"] == "closed", "editar no reabre"
    adj = _moves("R1", "po_cost_adj")
    assert len(adj) == 1, adj
    assert adj[0].delta == 0 and adj[0].ref_id == f"{lid}:c1", adj[0].ref_id
    _approx(adj[0].value_delta, 10)
    _approx(adj[0].unit_cost, 6)
    p = _part("R1")
    _approx(p.avg_cost, 5.0)
    _approx(p.on_hand, 14)
    _approx(p.last_cost, 6)            # esta línea es la última recepción
    # Más consumo que lo de esta PO: solo revalúa lo que queda.
    inventory.adjust("R1", -12, "wo_consume", ref_type="wo_line", ref_id="2")
    _approx(_part("R1").on_hand, 2)
    avg_before = _part("R1").avg_cost
    out = purchasing.update_line(po["id"], lid, {"unit_cost": 5},
                                 actor="Ana")
    rv = out["revaluations"][0]
    # De los 7 de esta recepción, 12/14 del stock salió -> queda 1.
    _approx(rv["revalued_qty"], 1)
    _approx(rv["consumed_qty"], 9)
    _approx(rv["value_delta"], -10)
    _approx(_part("R1").avg_cost, avg_before - 1 * 1 / 2)
    assert _moves("R1", "po_cost_adj")[-1].ref_id == f"{lid}:c2"
    # received_log por línea (recepción + 2 correcciones) y auditoría.
    full = purchasing.get_po(po["id"])
    log = full["lines"][0]["received_log"]
    assert [e["reason"] for e in log] == ["po_receive", "po_cost_adj",
                                          "po_cost_adj"], log
    assert log[0]["qty"] == 10 and log[0]["actor"] == "Ana", log[0]
    acts = {(e["action"], e["field"]) for e in full["audit"]}
    assert ("update", "unit_cost") in acts and ("revalue", "avg_cost") in acts
    assert ("close", "fin_status") in acts, acts
    # qty no baja de lo recibido; sí puede subir; validaciones.
    _raises(purchasing.update_line, "can't go below what was received",
            po["id"], lid, {"qty": 5})
    _raises(purchasing.update_line, "unit cost can't be negative",
            po["id"], lid, {"unit_cost": -1})
    up = purchasing.update_line(po["id"], lid, {"qty": 12, "taxable": True,
                                                "description": "Filter"})
    ln = up["lines"][0]
    assert ln["qty"] == 12 and ln["qty_outstanding"] == 2 and ln["taxable"]
    assert ln["description"] == "Filter"
    assert purchasing.update_line(po["id"], 999999, {"qty": 1}) is None
    # Reabrir: solo fin_status, stock intacto.
    oh = _part("R1").on_hand
    r = purchasing.reopen_po(po["id"], actor="Ana")
    assert r["fin_status"] == "open" and r["closed_at"] is None
    _approx(_part("R1").on_hand, oh)
    print("OK cost edit after receipt (revalue on-hand only, closed PO "
          "editable, dry_run, log, audit)")


def test_guards_and_unreceive():
    _seed_part("U1", on_hand=0, cost=2.0, core=15.0)
    _seed_part("U2", on_hand=0, cost=2.0)
    po = _received_po("Bravo", [
        {"part_number": "U1", "qty": 4, "unit_cost": 10},
        {"part_number": "U2", "qty": 2, "unit_cost": 3},
    ], "u1")
    pid = po["id"]
    l1, l2 = _line(po, "U1")["id"], _line(po, "U2")["id"]
    with db.SessionLocal() as s:
        cores = s.scalars(select(db.CoreItem).where(
            db.CoreItem.po_id == pid)).all()
        assert len(cores) == 1 and cores[0].status == "pending"
    # Guards.
    _raises(purchasing.delete_line, "unreceive first", pid, l1)
    _raises(purchasing.delete_po, "unreceive first", pid)
    _raises(purchasing.update_po, "unreceive lines instead", pid,
            {"status": "ordered"})
    # Otra parte entra a $20 -> avg de U1 = (4*10 + 4*20)/8 = 15.
    _received_po("Other", [{"part_number": "U1", "qty": 4,
                            "unit_cost": 20}], "u0")
    _approx(_part("U1").avg_cost, 15)
    # Unreceive de la línea U1: -4 a $10 -> avg vuelve a 20; core anulado.
    out = purchasing.unreceive_line(pid, l1, actor="Ana")
    assert out["status"] == "ordered" and out["received_at"] is None, out
    assert _line(out, "U1")["qty_received"] == 0
    p = _part("U1")
    _approx(p.on_hand, 4)
    _approx(p.avg_cost, 20)
    m = _moves("U1", "po_unreceive")
    assert len(m) == 1 and m[0].delta == -4 and m[0].ref_id == f"{l1}:u1"
    _approx(m[0].value_delta, -40)
    with db.SessionLocal() as s:
        assert not s.scalars(select(db.CoreItem).where(
            db.CoreItem.po_id == pid,
            db.CoreItem.status == "pending")).all(), "core no anulado"
    _raises(purchasing.unreceive_line, "nothing received", pid, l1)
    # Re-recibir: el ref ':full' viejo no bloquea (versionado) y el core
    # vuelve a crearse.
    again = purchasing.update_po(pid, {"status": "received"}, actor="Ana")
    assert again["status"] == "received"
    _approx(_part("U1").on_hand, 8)
    assert _moves("U1", "po_receive")[-1].ref_id == f"{l1}:full-r1"
    # Unreceive + receive_po con el MISMO token del primer evento: aplica.
    purchasing.unreceive_line(pid, l1)
    res = purchasing.receive_po(pid, [{"line_id": l1, "qty_now": 4}],
                                token="u1", create_backorder=False)
    assert _line(res["po"], "U1")["qty_received"] == 4
    _approx(_part("U1").on_hand, 8)
    assert _moves("U1", "po_receive")[-1].ref_id == f"{l1}:u1~2"
    # Quitar todo lo recibido -> ahí sí se borra la línea / la PO.
    purchasing.unreceive_line(pid, l1)
    purchasing.unreceive_line(pid, l2)
    after = purchasing.delete_line(pid, l2)
    assert len(after["lines"]) == 1
    # PO de una PO sin recibir: status puede retroceder libre.
    p2 = purchasing.create_po("Charlie", lines=[
        {"part_number": "U2", "qty": 1, "unit_cost": 1}])
    purchasing.update_po(p2["id"], {"status": "ordered"})
    assert purchasing.update_po(p2["id"],
                                {"status": "draft"})["status"] == "draft"
    # Borrar una PO bundleada desliga los requests (vuelven a pending).
    r = purchasing.create_request("U2", "U2", 3, 2.0, vendor="Delta")
    b = purchasing.bundle_requests([r["id"]], actor="Ana")
    assert purchasing.delete_po(b["po"]["id"], actor="Ana") is True
    rq = next(x for x in purchasing.list_requests("pending")
              if x["id"] == r["id"])
    assert rq["po_id"] is None and rq["status"] == "pending", rq
    assert purchasing.delete_po(pid) is True
    print("OK guards + unreceive (avg revert, core void, re-receive) + "
          "delete unlinks requests")


def test_adjustments_and_landed_cost():
    _seed_part("L1", on_hand=0, cost=1.0)
    _seed_part("L2", on_hand=0, cost=1.0)
    po = purchasing.create_po("Echo", lines=[
        {"part_number": "L1", "qty": 10, "unit_cost": 6},    # $60
        {"part_number": "L2", "qty": 4, "unit_cost": 10, "taxable": True},
    ])                                                          # $40
    pid = po["id"]
    l1, l2 = _line(po, "L1")["id"], _line(po, "L2")["id"]
    _raises(purchasing.add_adjustment, "invalid adjustment kind", pid,
            "bribe", 5)
    _raises(purchasing.add_adjustment, "greater than 0", pid, "fee", 0)
    # Flete $10 asignado ANTES de recibir: landed pro-rata por valor.
    out = purchasing.add_adjustment(pid, "shipping", 10, note="UPS",
                                    allocate=True, actor="Ana")
    _approx(_line(out, "L1")["landed_unit_cost"], 6 + 6 / 10)
    _approx(_line(out, "L2")["landed_unit_cost"], 10 + 4 / 4)
    assert out["revaluations"] == [], "nada recibido -> sin revaluación"
    # Recibir: entra al costo LANDED.
    purchasing.receive_po(pid, [{"line_id": l1, "qty_now": 10},
                                {"line_id": l2, "qty_now": 4}],
                          token="e1", create_backorder=False)
    _approx(_part("L1").avg_cost, 6.6)
    _approx(_part("L1").last_cost, 6.6)
    # Tax $8 asignado: solo a la línea gravada (L2) -> +2/u; revalúa L2.
    out = purchasing.add_adjustment(pid, "tax", 8, allocate=True, actor="Ana")
    _approx(_line(out, "L2")["landed_unit_cost"], 13)
    _approx(_line(out, "L1")["landed_unit_cost"], 6.6)
    assert [r["line_id"] for r in out["revaluations"]] == [l2]
    _approx(_part("L2").avg_cost, 13)
    # Descuento $20 asignado + pago (nunca prorratea, aunque se pida).
    out = purchasing.add_adjustment(pid, "discount", 20, allocate=True)
    _approx(_line(out, "L1")["landed_unit_cost"], 6.6 - 1.2)
    out = purchasing.add_adjustment(pid, "payment", 50, allocate=True)
    pay = next(a for a in out["adjustments"] if a["kind"] == "payment")
    assert pay["allocate"] is False and pay["signed_amount"] == -50
    fin = out["financial"]
    assert fin == {"subtotal": 100.0, "taxable_subtotal": 40.0,
                   "discount": 20.0, "credit": 0.0, "shipping": 10.0,
                   "tax": 8.0, "fees": 0.0, "total": 98.0, "paid": 50.0,
                   "balance": 48.0}, fin
    assert out["total"] == 98.0
    # Anular el descuento: landed vuelve y lo recibido se revalúa de nuevo.
    disc = next(a for a in out["adjustments"] if a["kind"] == "discount")
    out = purchasing.void_adjustment(pid, disc["id"], "wrong", actor="Ana")
    _approx(_line(out, "L1")["landed_unit_cost"], 6.6)
    _approx(_part("L1").avg_cost, 6.6)
    v = next(a for a in out["adjustments"] if a["id"] == disc["id"])
    assert v["voided"] and v["void_reason"] == "wrong"
    assert out["financial"]["discount"] == 0 and out["total"] == 118.0
    _raises(purchasing.void_adjustment, "already voided", pid, disc["id"])
    assert purchasing.void_adjustment(pid, 999999) is None
    # Agregar una línea re-prorratea (el flete ahora se reparte en 3).
    out = purchasing.add_line(pid, "L3", "L3", 1, 100)
    _approx(_line(out, "L1")["landed_unit_cost"], 6 + 60 / 200 * 10 / 10)
    print("OK adjustments: allocation (tax->taxable), landed receive, "
          "revalue, payment, void, financial summary")


def test_header_stats_and_routes():
    v = parts.create_vendor({"name": "Fleet Pride"})
    po = purchasing.create_po("fleet pride", lines=[
        {"part_number": "S1", "qty": 2, "unit_cost": 50}])
    assert po["vendor_id"] == v["id"], po["vendor_id"]
    pid = po["id"]
    out = purchasing.update_po(pid, {
        "invoice_no": "INV-77", "invoice_date": "2026-10-01",
        "tracking_no": "1Z999", "payment_method": "card"}, actor="Ana")
    assert (out["invoice_no"], out["invoice_date"], out["tracking_no"],
            out["payment_method"]) == ("INV-77", "2026-10-01", "1Z999",
                                       "card")
    _raises(purchasing.update_po, "YYYY-MM-DD", pid,
            {"invoice_date": "10/01/2026"})
    _raises(purchasing.update_po, "invalid payment method", pid,
            {"payment_method": "bitcoin"})
    # stats: open_value = no recibidas Y fin open.
    base = purchasing.stats()["open_value"]
    purchasing.close_po(pid)
    st = purchasing.stats()
    _approx(st["open_value"], base - 100)
    assert st["closed"] >= 1
    purchasing.reopen_po(pid)
    # request_stats por received_at: una PO recibida hace 40 días y editada
    # hoy NO cuenta en "recibido 30d".
    rec = _received_po("Old", [{"part_number": "S2", "qty": 1,
                                "unit_cost": 100}], "s2")
    before = purchasing.request_stats()["received_30d_count"]
    with db.SessionLocal() as s:
        row = s.get(db.PurchaseOrder, rec["id"])
        row.received_at = datetime.now() - timedelta(days=40)
        s.commit()
    purchasing.update_po(rec["id"], {"notes": "edited today"})
    assert purchasing.request_stats()["received_30d_count"] == before - 1

    # ----- Rutas: actor, 400/404, audit, RBAC.
    r = routes.po_add_adjustment(pid, routes.PoAdjustmentIn(
        kind="fee", amount=5), REQ)
    fee = next(a for a in r["adjustments"] if a["kind"] == "fee")
    assert fee["actor"] == "Ana Tester", fee
    _http(routes.po_add_adjustment, 400, pid,
          routes.PoAdjustmentIn(kind="fee", amount=-1), REQ)
    _http(routes.po_add_adjustment, 404, 999999,
          routes.PoAdjustmentIn(kind="fee", amount=1), REQ)
    lid = po["lines"][0]["id"]
    r = routes.po_patch_line(pid, lid, routes.POLinePatch(unit_cost=55), REQ)
    assert r["lines"][0]["unit_cost"] == 55
    _http(routes.po_patch_line, 404, pid, 999999,
          routes.POLinePatch(qty=1), REQ)
    _http(routes.po_unreceive_line, 400, pid, lid, REQ)   # nada recibido
    rec_line = rec["lines"][0]["id"]
    _http(routes.po_del_line, 400, rec["id"], rec_line, REQ)
    _http(routes.po_delete, 400, rec["id"], REQ)
    _http(routes.po_patch, 400, rec["id"],
          routes.PurchaseOrderPatch(status="draft"), REQ)
    r = routes.po_unreceive_line(rec["id"], rec_line, REQ)
    assert r["status"] == "ordered"
    r = routes.po_close(pid, REQ)
    assert r["fin_status"] == "closed"
    r = routes.po_reopen(pid, REQ)
    assert r["fin_status"] == "open"
    r = routes.po_void_adjustment(pid, fee["id"], REQ,
                                  routes.PoVoidIn(reason="dup"))
    v_adj = next(a for a in r["adjustments"] if a["id"] == fee["id"])
    assert v_adj["voided"] and v_adj["void_reason"] == "dup", v_adj
    _http(routes.po_void_adjustment, 404, pid, 999999, REQ)   # sin body
    # Borrar un vendor con POs ligadas: la PO conserva el nombre.
    tmp_v = parts.create_vendor({"name": "Gone Vendor"})
    gpo = purchasing.create_po("Gone Vendor")
    assert gpo["vendor_id"] == tmp_v["id"]
    assert parts.delete_vendor(tmp_v["id"]) is True
    gpo = purchasing.get_po(gpo["id"])
    assert gpo["vendor_id"] is None and gpo["vendor"] == "Gone Vendor"
    aud = routes.po_audit(pid)
    by_route = {(e["action"], e["field"]) for e in aud["events"]
                if e["actor"] == "Ana Tester"}
    for want in (("adjustment_add", "fee"), ("adjustment_void", "fee"),
                 ("close", "fin_status"), ("reopen", "fin_status"),
                 ("update", "unit_cost")):
        assert want in by_route, (want, by_route)
    _http(routes.po_audit, 404, 999999)
    r = routes.po_add_line(pid, routes.POLineIn(part_number="S9", qty=1,
                                                unit_cost=1, taxable=True),
                           REQ)
    assert _line(r, "S9")["taxable"] is True
    created = routes.po_create(routes.PurchaseOrderIn(vendor_id=v["id"]),
                               REQ)
    assert created["vendor"] == "Fleet Pride" and created["vendor_id"] == v["id"]
    lst = routes.po_list(fin_status="open")
    assert all(p["fin_status"] == "open" for p in lst["purchase_orders"])
    assert "financial" in lst["purchase_orders"][0]
    for path in ("/api/purchase-orders/1/lines/2",
                 "/api/purchase-orders/1/lines/2/unreceive",
                 "/api/purchase-orders/1/adjustments",
                 "/api/purchase-orders/1/adjustments/3/void",
                 "/api/purchase-orders/1/close",
                 "/api/purchase-orders/1/reopen"):
        method = "PATCH" if path.endswith("/lines/2") else "POST"
        assert _scope_for(method, path) == "maint.edit", path
    assert _scope_for("GET", "/api/purchase-orders/1/audit") is None
    print("OK header fields + vendor_id + stats/request_stats + routes + RBAC")


def test_org_timezone():
    assert org_config.get()["timezone"] == "America/Chicago"
    assert org_config.timezone_name() == "America/Chicago"
    now = org_config.org_now()
    assert now.tzinfo is not None
    assert str(now.tzinfo) == "America/Chicago", now.tzinfo
    assert org_config.org_today() == now.date()
    _raises(org_config.save, "invalid timezone", {"timezone": "Mars/Base"})
    assert org_config.get()["timezone"] == "America/Chicago"
    org_config.save({"timezone": "Asia/Tokyo"})
    assert org_config.timezone_name() == "Asia/Tokyo"
    # Semana lun–dom.
    mon, sun = org_config.week_bounds(date(2026, 10, 8))     # jueves
    assert (mon, sun) == (date(2026, 10, 5), date(2026, 10, 11))
    # Medianoche de la org como naive del servidor -> vuelve a ser ese día.
    d = date(2026, 3, 8)
    start = org_config.org_day_start(d)
    assert start.tzinfo is None
    assert org_config.to_org_date(start) == d
    assert org_config.to_org_date(start - timedelta(seconds=1)) == \
        d - timedelta(days=1)
    a, b = org_config.org_range(d, d)
    assert org_config.to_org_date(b) == d + timedelta(days=1)
    assert org_config.to_org(None) is None
    # La ruta /org devuelve 400 ante una zona inválida.
    exc = _http(routes.org_save, 400, {"timezone": "Nope/Nope"},
                SimpleNamespace(state=SimpleNamespace(
                    user={"role": "admin", "name": "x"})))
    assert "invalid timezone" in exc.detail, exc.detail
    org_config.save({"timezone": ""})          # vacío -> default
    assert org_config.timezone_name() == "America/Chicago"
    print("OK org timezone (org_now/today/week_bounds/day_start/range)")


def test_finisher_regressions():
    """v2.22 finisher: backorder sin doble conteo, unreceive tras consumo,
    unreceive sin stock, revaluación proporcional, in-flight sin cerradas,
    dry_run de add/delete line."""
    # 1) Backorder MUEVE lo corto: la original baja a lo recibido.
    _seed_part("BO1", on_hand=0, cost=10.0)
    po = purchasing.create_po("Bo", lines=[
        {"part_number": "BO1", "qty": 10, "unit_cost": 10},
        {"part_number": "BO1", "description": "spare", "qty": 2,
         "unit_cost": 10}])
    purchasing.update_po(po["id"], {"status": "ordered"})
    l1, l2 = po["lines"][0]["id"], po["lines"][1]["id"]
    res = purchasing.receive_po(po["id"], [{"line_id": l1, "qty_now": 4}],
                                token="bo", create_backorder=True)
    parent, child = res["po"], res["backorder"]
    assert parent["status"] == "received"
    assert len(parent["lines"]) == 1, "línea sin recibir -> se mueve entera"
    pl = parent["lines"][0]
    assert pl["qty"] == 4 and pl["qty_outstanding"] == 0, pl
    _approx(parent["financial"]["total"], 40)
    assert child["backorder_of_po_id"] == po["id"]
    assert sorted(x["qty"] for x in child["lines"]) == [2, 6], child["lines"]
    assert purchasing.get_po(po["id"])["backorder_po_ids"] == [child["id"]]
    # Reintento del mismo evento: no-op total (no otro backorder).
    again = purchasing.receive_po(po["id"], [{"line_id": l1, "qty_now": 4}],
                                  token="bo", create_backorder=True)
    assert again["backorder"] is None
    _approx(_part("BO1").on_hand, 4)
    acts = {(e["action"], e["field"]) for e in
            purchasing.get_po(po["id"])["audit"]}
    assert ("backorder", "qty") in acts and ("backorder", "line") in acts
    # Recibir el backorder completa 12 (nunca 16+).
    purchasing.update_po(child["id"], {"status": "ordered"})
    purchasing.update_po(child["id"], {"status": "received"})
    _approx(_part("BO1").on_hand, 12)
    # Datos legacy (original 'received' con pendiente + hija): se rechaza.
    with db.SessionLocal() as s:
        ln = s.get(db.POLine, l1)
        ln.qty = 10
        s.commit()
    _raises(purchasing.receive_po, "receive it there", po["id"],
            [{"line_id": l1, "qty_now": 6}], token="bo2")

    # 2) Unreceive tras consumo: el avg no colapsa (caso A y B).
    _seed_part("UA", on_hand=0, cost=5.0)
    _received_po("Old", [{"part_number": "UA", "qty": 20,
                          "unit_cost": 5}], "ua0")
    pa = _received_po("New", [{"part_number": "UA", "qty": 10,
                               "unit_cost": 10}], "ua1")
    _approx(_part("UA").avg_cost, 20 / 3)
    inventory.adjust("UA", -15, "wo_consume", ref_type="wo_line",
                     ref_id="ua")
    purchasing.unreceive_line(pa["id"], _line(pa, "UA")["id"])
    p = _part("UA")
    _approx(p.on_hand, 5)
    _approx(p.avg_cost, 5.0)            # lo que queda son unidades de $5
    _approx(p.last_cost, 5.0)           # vuelve a la última recepción vigente
    mv = _moves("UA", "po_unreceive")[-1]
    _approx(mv.value_delta, -75)        # 5 de la línea a $10 + 5 viejas a $5
    _seed_part("UB", on_hand=0, cost=10.0)
    _received_po("Old", [{"part_number": "UB", "qty": 20,
                          "unit_cost": 10}], "ub0")
    pb = _received_po("New", [{"part_number": "UB", "qty": 10,
                               "unit_cost": 5}], "ub1")
    inventory.adjust("UB", -15, "wo_consume", ref_type="wo_line",
                     ref_id="ub")
    purchasing.unreceive_line(pb["id"], _line(pb, "UB")["id"])
    _approx(_part("UB").avg_cost, 10.0)

    # 3) Unreceive sin stock: restaura costo previo y last_cost.
    _seed_part("TY", on_hand=0, cost=5.0)
    pt = _received_po("Typo", [{"part_number": "TY", "qty": 2,
                                "unit_cost": 50}], "ty")
    _approx(_part("TY").avg_cost, 50)
    purchasing.unreceive_line(pt["id"], _line(pt, "TY")["id"])
    p = _part("TY")
    _approx(p.on_hand, 0)
    assert p.avg_cost == 0 and p.last_cost is None, (p.avg_cost, p.last_cost)
    _approx(inventory.effective_avg(p), 5.0)   # cae al costo estándar
    # Con una recepción previa vigente: vuelve a ese costo.
    _received_po("Good", [{"part_number": "TY", "qty": 1,
                           "unit_cost": 7}], "ty1")
    inventory.adjust("TY", -1, "wo_consume", ref_type="wo_line", ref_id="ty")
    pt2 = _received_po("Typo", [{"part_number": "TY", "qty": 2,
                                 "unit_cost": 70}], "ty2")
    purchasing.unreceive_line(pt2["id"], _line(pt2, "TY")["id"])
    p = _part("TY")
    _approx(p.avg_cost, 7)
    _approx(p.last_cost, 7)

    # 4) Revaluación proporcional con stock previo.
    _seed_part("RV", on_hand=0, cost=5.0)
    _received_po("Old", [{"part_number": "RV", "qty": 10,
                          "unit_cost": 5}], "rv0")
    pr = _received_po("New", [{"part_number": "RV", "qty": 10,
                               "unit_cost": 10}], "rv1")
    inventory.adjust("RV", -10, "wo_consume", ref_type="wo_line",
                     ref_id="rv")
    out = purchasing.update_line(pr["id"], _line(pr, "RV")["id"],
                                 {"unit_cost": 20})
    rv = out["revaluations"][0]
    _approx(rv["revalued_qty"], 5)
    _approx(rv["consumed_qty"], 5)
    _approx(_part("RV").avg_cost, 12.5)

    # 5) request_stats: una PO cerrada no está "en vuelo".
    base = purchasing.request_stats()
    d = purchasing.create_po("Closed", lines=[
        {"part_number": "RV", "qty": 1, "unit_cost": 99}])
    _approx(purchasing.request_stats()["in_flight_value"],
            base["in_flight_value"] + 99)
    purchasing.close_po(d["id"])
    st = purchasing.request_stats()
    _approx(st["in_flight_value"], base["in_flight_value"])
    assert st["pos_in_flight"] == base["pos_in_flight"]

    # 6) add/delete line con dry_run: preview del re-prorrateo sin guardar.
    _seed_part("DR", on_hand=0, cost=10.0)
    pd = _received_po("Dry", [{"part_number": "DR", "qty": 10,
                               "unit_cost": 10}], "dr")
    purchasing.add_adjustment(pd["id"], "shipping", 50, allocate=True)
    _approx(_part("DR").avg_cost, 15)
    prev = purchasing.add_line(pd["id"], "", "Misc", 1, 100, dry_run=True)
    assert prev["dry_run"] and prev["revaluations"], prev.get("revaluations")
    _approx(prev["revaluations"][0]["avg_new"], 12.5)
    assert len(purchasing.get_po(pd["id"])["lines"]) == 1
    _approx(_part("DR").avg_cost, 15)
    added = purchasing.add_line(pd["id"], "", "Misc", 1, 100)
    misc = next(x for x in added["lines"] if x["description"] == "Misc")
    prev = purchasing.delete_line(pd["id"], misc["id"], dry_run=True)
    assert prev["dry_run"] and len(prev["lines"]) == 1
    assert len(purchasing.get_po(pd["id"])["lines"]) == 2
    _http(routes.po_del_line, 404, 999999, 1, REQ)
    out = routes.po_del_line(pd["id"], misc["id"], REQ, dry_run=True)
    assert out["dry_run"] is True
    print("OK finisher: backorder moves short qty, unreceive after "
          "consumption / with no stock, proportional revalue, in-flight, "
          "dry_run add/delete line")


if __name__ == "__main__":
    test_weighted_average_on_receive()
    test_cost_edit_after_receipt()
    test_guards_and_unreceive()
    test_adjustments_and_landed_cost()
    test_header_stats_and_routes()
    test_org_timezone()
    test_finisher_regressions()
    print("\nALL PO COSTING TESTS PASSED")
