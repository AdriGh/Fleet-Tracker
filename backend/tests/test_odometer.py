# -*- coding: utf-8 -*-
"""Tests del habilitador de CPM: odometer_reading + millas por período + CPM.

`python backend/tests/test_odometer.py`. DB SQLite temporal fresca. Verifica el
backfill desde WO/MaintRecord.mileage (idempotente), el cálculo de millas por
delta de odómetro (conservador, dentro del rango), y cpm_report (Fleet CPM solo
sobre unidades con millas, unidades sin millas contadas aparte).
"""
import os
import sys
import tempfile
from datetime import date, datetime
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

_TMP = Path(tempfile.mkdtemp()) / "odo_test.db"
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP}"

from app import db                                   # noqa: E402
from app.core import odometer, reports, tenant       # noqa: E402

tenant.set_current_org(db.default_org_id())


def _wo(unit, service_date, mileage, lines):
    now = datetime.now()
    with db.SessionLocal() as s:
        wo = db.WorkOrder(
            created_at=now, updated_at=now, child_seq=0, unit=unit, company="",
            status="open", priority="normal", title="svc", complaint="",
            mechanic="M", notes="", is_pm=False, waiting_parts=False,
            campaign="", source="manual", invoice_number="", po_number="",
            authorizer="", shop_invoice="", service_date=service_date,
            mileage=mileage)
        s.add(wo)
        s.flush()
        for kind, desc, qty, uc in lines:
            s.add(db.WorkOrderLine(wo_id=wo.id, kind=kind, description=desc,
                                   qty=qty, unit_cost=uc, part_number=""))
        s.commit()


def _maint(unit, d, mileage):
    now = datetime.now()
    with db.SessionLocal() as s:
        s.add(db.MaintRecord(unit=unit, kind="pm", date=d, mileage=mileage,
                             notes="", created_at=now))
        s.commit()


def test_backfill_miles_and_cpm():
    # U1: dos WOs con odómetro + gasto, + un registro PM intermedio.
    _wo("U1", "2026-01-01", 100000, [("part", "brake pad", 1, 200)])   # $200
    _wo("U1", "2026-04-01", 110000, [("labor", "brake job", 1, 300)])  # $300
    _maint("U1", "2026-02-15", 105000)
    # U2: una sola lectura -> no hay delta -> sin millas.
    _wo("U2", "2026-03-01", 50000, [("part", "filter", 1, 150)])       # $150

    # Backfill: U1 = 3 lecturas (2 wo + 1 maint), U2 = 1 (wo) => 4.
    n = odometer.backfill_from_history()
    assert n == 4, f"se esperaban 4 lecturas, backfill creó {n}"
    # Idempotente.
    assert odometer.backfill_from_history() == 0, "backfill duplicó lecturas"

    # Millas por unidad (all time): U1 = 110000-100000 = 10000; U2 sin delta.
    miles = odometer.miles_by_unit(None, None)
    assert miles == {"U1": 10000}, miles

    # Rango acotado [feb-1 .. abr-30]: U1 usa feb15(105000)->abr1(110000)=5000
    # (conservador: NO cuenta ene->feb, fuera del rango).
    sub = odometer.miles_by_unit(date(2026, 2, 1), date(2026, 4, 30))
    assert sub == {"U1": 5000}, sub

    # CPM: U1 = $500 / 10000 mi = 0.05; U2 tiene gasto pero sin millas.
    r = reports.cpm_report()
    assert r["fleet_cpm"] == 0.05, r["fleet_cpm"]
    assert r["fleet_miles"] == 10000, r["fleet_miles"]
    assert r["fleet_spend"] == 500.0, r["fleet_spend"]
    assert r["total_spend"] == 650.0, r["total_spend"]
    assert r["units_with_miles"] == 1, r["units_with_miles"]
    assert r["units_without_miles"] == 1, r["units_without_miles"]
    assert r["spend_without_miles"] == 150.0, r["spend_without_miles"]

    u1 = next(x for x in r["by_unit"] if x["unit"] == "U1")
    u2 = next(x for x in r["by_unit"] if x["unit"] == "U2")
    assert u1["cpm"] == 0.05 and u1["miles"] == 10000, u1
    assert u2["cpm"] is None and u2["miles"] == 0, u2
    # coverage.since = fecha de la lectura más vieja.
    assert r["coverage"]["since"] == "2026-01-01", r["coverage"]
    print("OK backfill + millas por delta (conservador) + Fleet/Per-Unit CPM")


if __name__ == "__main__":
    test_backfill_miles_and_cpm()
    print("\nALL ODOMETER/CPM TESTS PASSED")
