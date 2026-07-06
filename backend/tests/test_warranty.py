# -*- coding: utf-8 -*-
"""Tests de warranty tracking (reclamos de garantía, v2.6).

`python backend/tests/test_warranty.py`. DB SQLite temporal fresca. Verifica
que la MISMA parte reusada en la MISMA unidad DENTRO de la ventana de garantía
genera un claim (con montos/fechas correctos), que fuera de la ventana o sin
garantía no, idempotencia del scan, y el ciclo de estados + stats.
"""
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

_TMP = Path(tempfile.mkdtemp()) / "warranty_test.db"
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP}"

from app import db                                   # noqa: E402
from app.core import tenant, warranty                # noqa: E402
from sqlalchemy import select                        # noqa: E402

tenant.set_current_org(db.default_org_id())


def _seed_part(pn: str, warranty_months: int = 0) -> None:
    now = datetime.now()
    with db.SessionLocal() as s:
        s.add(db.Part(part_number=pn, description=pn, on_hand=0, cost=1.0,
                      warranty_months=warranty_months,
                      created_at=now, updated_at=now))
        s.commit()


def _seed_wo(unit: str, service_date: str, part_number: str,
             qty: float = 1, unit_cost: float = 200) -> int:
    now = datetime.now()
    with db.SessionLocal() as s:
        wo = db.WorkOrder(
            created_at=now, updated_at=now, child_seq=0, unit=unit,
            company="", status="invoiced", priority="normal", title="svc",
            complaint="", mechanic="M", notes="", is_pm=False,
            waiting_parts=False, campaign="", source="", invoice_number="",
            po_number="", authorizer="", shop_invoice="",
            service_date=service_date)
        s.add(wo)
        s.flush()
        s.add(db.WorkOrderLine(
            wo_id=wo.id, kind="part", description=part_number,
            qty=qty, unit_cost=unit_cost, part_number=part_number))
        s.commit()
        return wo.id


def _seed_wo_multi(unit: str, service_date: str, lines: list) -> int:
    """Una WO con varias líneas. `lines`: [(part_number, qty, unit_cost), ...]."""
    now = datetime.now()
    with db.SessionLocal() as s:
        wo = db.WorkOrder(
            created_at=now, updated_at=now, child_seq=0, unit=unit,
            company="", status="invoiced", priority="normal", title="svc",
            complaint="", mechanic="M", notes="", is_pm=False,
            waiting_parts=False, campaign="", source="", invoice_number="",
            po_number="", authorizer="", shop_invoice="",
            service_date=service_date)
        s.add(wo)
        s.flush()
        for pn, qty, uc in lines:
            s.add(db.WorkOrderLine(wo_id=wo.id, kind="part", description=pn,
                                   qty=qty, unit_cost=uc, part_number=pn))
        s.commit()
        return wo.id


def test_detect_within_window():
    _seed_part("ALT", warranty_months=12)   # alternador, 12 meses de garantía
    _seed_part("FLT", warranty_months=0)     # filtro, sin garantía

    # U1: ALT instalado 2026-01-10, re-usado 2026-06-10 (5 meses -> DENTRO) => claim
    _seed_wo("U1", "2026-01-10", "ALT", qty=1, unit_cost=300)
    wo_fail = _seed_wo("U1", "2026-06-10", "ALT", qty=1, unit_cost=320)
    # U1: FLT dos veces (sin garantía) => NO claim
    _seed_wo("U1", "2026-01-10", "FLT")
    _seed_wo("U1", "2026-06-10", "FLT")
    # U2: ALT 2026-01-10 y 2027-06-10 (17 meses -> FUERA) => NO claim
    _seed_wo("U2", "2026-01-10", "ALT")
    _seed_wo("U2", "2027-06-10", "ALT")

    n = warranty.scan()
    assert n == 1, f"se esperaba 1 claim, scan creó {n}"
    claims = warranty.list_claims("open")
    assert len(claims) == 1, len(claims)
    c = claims[0]
    assert c["part_number"] == "ALT" and c["unit"] == "U1", c
    assert c["install_date"] == "2026-01-10", c["install_date"]
    assert c["failure_date"] == "2026-06-10", c["failure_date"]
    assert c["warranty_until"] == "2027-01-10", c["warranty_until"]
    assert c["failure_wo"] == wo_fail, c["failure_wo"]
    assert c["amount"] == 320.0, c["amount"]   # costo del reemplazo

    # Idempotencia: re-escanear NO duplica.
    assert warranty.scan() == 0, "scan duplicó el claim"
    print("OK detect within window + not out-of-window + not no-warranty + idempotent")


def test_status_and_stats():
    claims = warranty.list_claims("open")
    cid = claims[0]["id"]
    st = warranty.claim_stats()
    assert st["open"] == 1 and st["open_amount"] == 320.0, st

    # Marcar recuperado.
    r = warranty.set_status(cid, "recovered")
    assert r["status"] == "recovered", r
    st2 = warranty.claim_stats()
    assert st2["open"] == 0, st2
    assert st2["recovered"] == 1 and st2["recovered_amount"] == 320.0, st2

    # Estado inválido -> ValueError.
    try:
        warranty.set_status(cid, "bogus")
        assert False, "aceptó estado inválido"
    except ValueError:
        pass
    print("OK status transitions + stats + invalid rejected")


def test_multiline_amount_and_negative():
    """Una WO de falla con VARIAS líneas de la misma parte cuenta la SUMA de
    todas (no solo la primera); las líneas con qty<=0 (reversas) se ignoran."""
    _seed_part("STR", warranty_months=12)   # starter, 12 meses
    _seed_wo("U3", "2026-02-01", "STR", qty=1, unit_cost=100)   # instalación
    # Falla dentro de garantía: 2 líneas STR (150+150) + una reversa negativa
    # que NO debe restar. Monto esperado del claim = 300.
    fail = _seed_wo_multi("U3", "2026-05-01",
                          [("STR", 1, 150), ("STR", 1, 150), ("STR", -1, 150)])

    n = warranty.scan()
    assert n == 1, f"se esperaba 1 claim nuevo, scan creó {n}"
    c = [x for x in warranty.list_claims("open") if x["unit"] == "U3"]
    assert len(c) == 1, c
    assert c[0]["failure_wo"] == fail, c[0]
    assert c[0]["amount"] == 300.0, c[0]["amount"]   # sumado, reversa ignorada
    assert warranty.scan() == 0, "scan duplicó el claim multi-línea"
    print("OK multi-line amount summed + negative-qty line ignored")


if __name__ == "__main__":
    test_detect_within_window()
    test_status_and_stats()
    test_multiline_amount_and_negative()
    print("\nALL WARRANTY TESTS PASSED")
