# -*- coding: utf-8 -*-
"""Tests de core tracking (banco de cores, v2.5).

`python backend/tests/test_cores.py`. DB SQLite temporal fresca. Verifica que
recibir una PO de una parte CON core crea el core pendiente (idempotente), que
una parte SIN core no crea nada, y el ciclo devolver/revertir + stats.
"""
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

_TMP = Path(tempfile.mkdtemp()) / "cores_test.db"
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP}"

from app import db                                        # noqa: E402
from app.core import cores, purchasing, tenant            # noqa: E402
from sqlalchemy import select                             # noqa: E402

tenant.set_current_org(db.default_org_id())


def _seed_part(pn: str, core_charge: float = 0.0) -> None:
    now = datetime.now()
    with db.SessionLocal() as s:
        s.add(db.Part(part_number=pn, description=pn, on_hand=0.0, cost=1.0,
                      core_charge=core_charge, created_at=now, updated_at=now))
        s.commit()


def _n_cores() -> int:
    with db.SessionLocal() as s:
        return len(s.scalars(select(db.CoreItem)).all())


def test_core_created_on_receive():
    _seed_part("ALT-160", core_charge=120.0)   # alternador con core
    _seed_part("FLTR-1", core_charge=0.0)       # filtro sin core
    po = purchasing.create_po("Acme", lines=[
        {"part_number": "ALT-160", "description": "Alternator", "qty": 2, "unit_cost": 300},
        {"part_number": "FLTR-1", "description": "Filter", "qty": 4, "unit_cost": 10},
    ])
    pid = po["id"]
    la = po["lines"][0]["id"]
    lb = po["lines"][1]["id"]
    purchasing.update_po(pid, {"status": "ordered"})

    # Recibir TODO. Debe crear UN core (por la parte con core), qty 2, no por el filtro.
    purchasing.receive_po(pid, [
        {"line_id": la, "qty_now": 2}, {"line_id": lb, "qty_now": 4},
    ], token="c1", create_backorder=False)
    cs = cores.list_cores("pending")
    assert len(cs) == 1, f"se esperaba 1 core, hay {len(cs)}"
    c = cs[0]
    assert c["part_number"] == "ALT-160"
    assert c["qty"] == 2 and c["core_charge"] == 120.0
    assert c["deposit"] == 240.0, c["deposit"]
    assert c["vendor"] == "Acme"
    assert c["status"] == "pending"

    # Idempotencia: reenviar el mismo token NO duplica el core.
    purchasing.receive_po(pid, [{"line_id": la, "qty_now": 2}],
                          token="c1", create_backorder=False)
    assert _n_cores() == 1, f"idempotencia rota: {_n_cores()} cores"
    print("OK core created on receive (part with core only) + idempotent")


def test_return_and_stats():
    _seed_part("STR-9", core_charge=85.0)
    po = purchasing.create_po("Bravo", lines=[
        {"part_number": "STR-9", "description": "Starter", "qty": 1, "unit_cost": 210},
    ])
    pid = po["id"]
    lid = po["lines"][0]["id"]
    purchasing.update_po(pid, {"status": "ordered"})
    purchasing.receive_po(pid, [{"line_id": lid, "qty_now": 1}],
                          token="s1", create_backorder=False)
    core = next(c for c in cores.list_cores("pending") if c["part_number"] == "STR-9")

    st = cores.core_stats()
    assert st["pending"] >= 2, st           # ALT-160 + STR-9 pendientes
    dep_before = st["pending_deposit"]
    assert dep_before >= 240 + 85, dep_before

    # Devolver el core: sale de pending, cuenta como crédito.
    r = cores.return_core(core["id"])
    assert r["status"] == "returned" and r["returned_at"], r
    st2 = cores.core_stats()
    assert st2["pending"] == st["pending"] - 1, st2
    assert st2["credited_30d"] >= 85, st2["credited_30d"]

    # Idempotente: devolver de nuevo no cambia nada.
    cores.return_core(core["id"])
    assert cores.core_stats()["pending"] == st2["pending"]

    # Revertir: vuelve a pending.
    cores.unreturn_core(core["id"])
    assert cores.core_stats()["pending"] == st2["pending"] + 1
    print("OK return + credit + stats + idempotent + unreturn")


if __name__ == "__main__":
    test_core_created_on_receive()
    test_return_and_stats()
    print("\nALL CORE TRACKING TESTS PASSED")
