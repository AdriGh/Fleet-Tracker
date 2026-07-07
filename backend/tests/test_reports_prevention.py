# -*- coding: utf-8 -*-
"""Tests del split preventivo-vs-reactivo + mediana en spend_report (CPM story).

`python backend/tests/test_reports_prevention.py`. DB SQLite temporal fresca.
Verifica que el gasto se parte por WO en planificado (is_pm o campaign) vs
reactivo, que los montos y el pm_pct cierran, que la mediana por WO es robusta
a outliers, y que los campos viejos siguen intactos (backward-compat).
"""
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

_TMP = Path(tempfile.mkdtemp()) / "reports_test.db"
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP}"

from app import db                                   # noqa: E402
from app.core import reports, tenant                 # noqa: E402

tenant.set_current_org(db.default_org_id())


def _wo(unit, service_date, lines, *, is_pm=False, campaign=""):
    """Crea una WO con líneas [(kind, desc, qty, unit_cost), ...]."""
    now = datetime.now()
    with db.SessionLocal() as s:
        wo = db.WorkOrder(
            created_at=now, updated_at=now, child_seq=0, unit=unit,
            company="", status="open", priority="normal", title="svc",
            complaint="", mechanic="M", notes="", is_pm=is_pm,
            waiting_parts=False, campaign=campaign, source="", invoice_number="",
            po_number="", authorizer="", shop_invoice="",
            service_date=service_date)
        s.add(wo)
        s.flush()
        for kind, desc, qty, uc in lines:
            s.add(db.WorkOrderLine(wo_id=wo.id, kind=kind, description=desc,
                                   qty=qty, unit_cost=uc, part_number=""))
        s.commit()
        return wo.id


def test_prevention_split_and_median():
    # Planificadas (una is_pm, otra por campaña 'dot'):
    _wo("U1", "2026-06-01", [("part", "oil filter", 1, 100),
                             ("labor", "pm labor", 2, 50)], is_pm=True)   # 200
    _wo("U2", "2026-06-02", [("labor", "dot inspection", 1, 150)],
        campaign="dot")                                                    # 150
    # Reactivas (sin is_pm ni campaña):
    _wo("U1", "2026-06-03", [("part", "alternator", 1, 300)])             # 300
    _wo("U3", "2026-06-04", [("part", "clutch", 1, 1350)])               # 1350 (outlier)

    r = reports.spend_report()
    t = r["totals"]

    # Totales viejos intactos.
    assert t["total_spend"] == 2000.0, t["total_spend"]
    assert t["wo_count"] == 4, t["wo_count"]
    assert t["parts_spend"] == 1750.0, t["parts_spend"]   # 100+300+1350
    assert t["labor_spend"] == 250.0, t["labor_spend"]    # 100+150

    # Split planificado vs reactivo POR WO (no por línea):
    #  planificado = U1(pm,200) + U2(dot,150) = 350
    #  reactivo    = U1(300) + U3(1350) = 1650
    assert t["pm_spend"] == 350.0, t["pm_spend"]
    assert t["reactive_spend"] == 1650.0, t["reactive_spend"]
    assert t["pm_spend"] + t["reactive_spend"] == t["total_spend"], t
    assert t["pm_pct"] == 17.5, t["pm_pct"]               # 350/2000

    # Mediana de [200,150,300,1350] = (200+300)/2 = 250 (robusta al outlier
    # de 1350 que sí infla el promedio: avg = 500).
    assert t["avg_per_wo"] == 500.0, t["avg_per_wo"]
    assert t["median_per_wo"] == 250.0, t["median_per_wo"]
    print("OK split PM/reactivo por WO + mediana robusta + totales intactos")


def test_empty_range_safe():
    # Rango sin datos: ceros, no rompe.
    r = reports.spend_report(date_from="2000-01-01", date_to="2000-12-31")
    t = r["totals"]
    assert t["total_spend"] == 0.0 and t["pm_spend"] == 0.0
    assert t["reactive_spend"] == 0.0 and t["pm_pct"] == 0.0
    assert t["median_per_wo"] == 0.0
    print("OK rango vacío devuelve ceros sin romper")


if __name__ == "__main__":
    test_prevention_split_and_median()
    test_empty_range_safe()
    print("\nALL REPORTS PREVENTION TESTS PASSED")
