# -*- coding: utf-8 -*-
"""Tests de recepción parcial de POs + backorders (Purchasing v2.3).

Corre como script suelto (pytest no está instalado): `python backend/tests/
test_receiving.py`. Setea DATABASE_URL a una DB SQLite temporal ANTES de
importar app.db, así corre sobre un esquema fresco sin tocar dvir.db.

Verifica las propiedades críticas (tocan stock en prod):
  - recepción parcial actualiza qty_received y repone SOLO el delta
  - idempotencia: reenviar el mismo (payload+token) NO duplica stock ni qty
  - clamp: no se puede recibir más de lo pendiente (no sobre-stock)
  - backorder: el faltante genera una PO draft linkeada y cierra la original
  - legacy: update_po status='received' completa el remanente una sola vez
"""

import os
import sys
import tempfile
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

# DB temporal fresca ANTES de importar app.db (lee DATABASE_URL a nivel módulo).
_TMP = Path(tempfile.mkdtemp()) / "recv_test.db"
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP}"

from app import db                       # noqa: E402
from app.core import inventory, purchasing, tenant  # noqa: E402

tenant.set_current_org(db.default_org_id())


def _on_hand(pn: str) -> float:
    with db.SessionLocal() as s:
        from sqlalchemy import select
        p = s.scalar(select(db.Part).where(db.Part.part_number == pn))
        return float(p.on_hand or 0) if p else 0.0


def _seed_part(pn: str) -> None:
    from datetime import datetime
    now = datetime.now()
    with db.SessionLocal() as s:
        s.add(db.Part(part_number=pn, description=pn, on_hand=0.0, cost=1.0,
                      created_at=now, updated_at=now))
        s.commit()


def _line(po: dict, idx: int) -> dict:
    return po["lines"][idx]


def test_partial_and_idempotent():
    _seed_part("A1"); _seed_part("A2")
    po = purchasing.create_po("Acme", lines=[
        {"part_number": "A1", "description": "Part A1", "qty": 10, "unit_cost": 2},
        {"part_number": "A2", "description": "Part A2", "qty": 5, "unit_cost": 3},
    ])
    pid = po["id"]
    la, lb = _line(po, 0)["id"], _line(po, 1)["id"]
    purchasing.update_po(pid, {"status": "ordered"})   # flujo real: enviada

    # Recepción parcial: A1 4/10, A2 5/5. Sin backorder.
    res = purchasing.receive_po(pid, [
        {"line_id": la, "qty_now": 4}, {"line_id": lb, "qty_now": 5},
    ], token="t1", create_backorder=False)
    p = res["po"]
    assert res["backorder"] is None, "no backorder pedido"
    assert p["status"] == "ordered", f"parcial no cierra la PO: {p['status']}"
    assert p["receiving_state"] == "partial", p["receiving_state"]
    la_d = next(x for x in p["lines"] if x["id"] == la)
    lb_d = next(x for x in p["lines"] if x["id"] == lb)
    assert la_d["qty_received"] == 4 and la_d["qty_outstanding"] == 6, la_d
    assert lb_d["qty_received"] == 5 and lb_d["qty_outstanding"] == 0, lb_d
    assert _on_hand("A1") == 4, _on_hand("A1")
    assert _on_hand("A2") == 5, _on_hand("A2")

    # Idempotencia: MISMO token+payload no duplica.
    purchasing.receive_po(pid, [{"line_id": la, "qty_now": 4}],
                          token="t1", create_backorder=False)
    assert _on_hand("A1") == 4, f"idempotencia rota: {_on_hand('A1')}"
    with db.SessionLocal() as s:
        from sqlalchemy import select
        ln = s.get(db.POLine, la)
        assert ln.qty_received == 4, f"qty_received duplicado: {ln.qty_received}"

    # Over-receive: pedir 100 de A1 (pendiente 6) -> clamp a 6. Ahora todo full.
    res2 = purchasing.receive_po(pid, [{"line_id": la, "qty_now": 100}],
                                 token="t2", create_backorder=True)
    assert _on_hand("A1") == 10, f"over-receive no clampeado: {_on_hand('A1')}"
    assert res2["po"]["status"] == "received", res2["po"]["status"]
    assert res2["po"]["receiving_state"] == "full"
    assert res2["backorder"] is None, "todo recibido -> sin backorder"
    print("OK partial + idempotent + clamp + auto-close")


def test_backorder():
    _seed_part("B1")
    po = purchasing.create_po("Bravo", lines=[
        {"part_number": "B1", "description": "Part B1", "qty": 10, "unit_cost": 5},
    ])
    pid = po["id"]
    lid = _line(po, 0)["id"]
    res = purchasing.receive_po(pid, [{"line_id": lid, "qty_now": 3}],
                                token="bk1", create_backorder=True)
    assert _on_hand("B1") == 3, _on_hand("B1")
    assert res["po"]["status"] == "received", "backorder cierra la original"
    bo = res["backorder"]
    assert bo is not None, "se esperaba backorder"
    assert bo["status"] == "draft", bo["status"]
    assert bo["backorder_of_po_id"] == pid, bo["backorder_of_po_id"]
    assert len(bo["lines"]) == 1 and bo["lines"][0]["qty"] == 7, bo["lines"]
    assert bo["lines"][0]["part_number"] == "B1"
    print("OK backorder created + linked + short qty correct")


def test_legacy_full_receive():
    _seed_part("C1")
    po = purchasing.create_po("Charlie", lines=[
        {"part_number": "C1", "description": "Part C1", "qty": 8, "unit_cost": 1},
    ])
    pid = po["id"]
    # Camino legacy: marcar 'received' vía update_po.
    r = purchasing.update_po(pid, {"status": "received"})
    assert r["status"] == "received"
    assert _on_hand("C1") == 8, _on_hand("C1")
    # Re-marcar received NO duplica (remaining=0 + ref_id ':full' guard).
    purchasing.update_po(pid, {"status": "received"})
    assert _on_hand("C1") == 8, f"legacy double-add: {_on_hand('C1')}"
    print("OK legacy full-receive + no double-add")


def test_empty_noop():
    _seed_part("D1")
    po = purchasing.create_po("Delta", lines=[
        {"part_number": "D1", "description": "Part D1", "qty": 4, "unit_cost": 2},
    ])
    pid = po["id"]
    purchasing.update_po(pid, {"status": "ordered"})
    before = _on_hand("D1")
    # receipts vacío + backorder=True: NO debe cerrar la PO ni backordear.
    res = purchasing.receive_po(pid, [], token="x", create_backorder=True)
    assert res["po"]["status"] == "ordered", res["po"]["status"]
    assert res["backorder"] is None, "empty receive creó backorder"
    assert _on_hand("D1") == before, "empty receive tocó el stock"
    print("OK empty receipts = no-op (no close, no backorder, no stock)")


if __name__ == "__main__":
    test_partial_and_idempotent()
    test_backorder()
    test_legacy_full_receive()
    test_empty_noop()
    print("\nALL RECEIVING TESTS PASSED")
