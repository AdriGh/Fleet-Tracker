# -*- coding: utf-8 -*-
"""Tests del reporte de compliance de conductores (v2.11).

`python backend/tests/test_driver_compliance.py`. Función pura: sin DB ni red.

Este reporte reemplaza a los KPIs de la página "Driver Compliance" que se
eliminó, así que lo que se testea es justo lo que NO hay que perder:
  - 'sin fecha' se cuenta aparte de 'vigente' (un CDL en blanco es peor que uno
    por vencer, y antes se veía igual);
  - el mix de roles cuenta SOLO los que tienen perfil (el modelo default-ea
    'owner_operator', así que contar los sin-perfil reportaría 100% owner-ops);
  - la cola de atención sale ordenada por urgencia real (vencidos primero).
"""
import datetime as dt
import os
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

os.environ["FLEET_SKIP_DB_INIT"] = "1"

from app.core.reports import (                      # noqa: E402
    doc_state, driver_compliance_report)

TODAY = dt.date(2026, 7, 29)


def _iso(offset: int) -> str:
    return (TODAY + dt.timedelta(days=offset)).isoformat()


def _driver(name, **kw):
    base = {
        "name": name, "has_profile": True, "role": "company_driver",
        "truck": "", "cdl_exp": "", "med_exp": "", "mvr_exp": "",
        "chouse_exp": "",
    }
    base.update(kw)
    return base


def test_doc_state():
    assert doc_state("", TODAY) == ("missing", None)
    assert doc_state(None, TODAY) == ("missing", None)
    assert doc_state("basura", TODAY) == ("missing", None)
    st, days = doc_state(_iso(-5), TODAY)
    assert (st, days) == ("expired", -5)
    st, days = doc_state(_iso(10), TODAY)
    assert (st, days) == ("soon", 10)
    st, days = doc_state(_iso(30), TODAY)
    assert st == "soon", "30 días justo todavía es 'soon'"
    st, days = doc_state(_iso(31), TODAY)
    assert st == "valid", "31 días ya es vigente"
    print("OK doc_state: missing / expired / soon (<=30d) / valid")


def test_report_counts_and_order():
    drivers = [
        # vencido (CDL) + el resto vigente
        _driver("Ana", truck="101", cdl_exp=_iso(-14), med_exp=_iso(200),
                mvr_exp=_iso(300), chouse_exp=_iso(150)),
        # por vencer (médico)
        _driver("Beto", truck="102", cdl_exp=_iso(400),
                med_exp=_iso(9), mvr_exp=_iso(300), chouse_exp=_iso(150)),
        # todo vigente
        _driver("Caro", truck="103", cdl_exp=_iso(400), med_exp=_iso(300),
                mvr_exp=_iso(280), chouse_exp=_iso(260)),
        # sin perfil y sin ninguna fecha: 4 'missing'
        _driver("Dani", has_profile=False, role="owner_operator"),
        # vencido más viejo que Ana -> debe ir PRIMERO en la cola
        _driver("Eze", truck="105", cdl_exp=_iso(-40), med_exp=_iso(300),
                mvr_exp=_iso(300), chouse_exp=_iso(300)),
    ]
    r = driver_compliance_report(drivers, TODAY)
    t = r["totals"]

    assert t["drivers"] == 5
    assert t["with_profile"] == 4 and t["without_profile"] == 1
    assert t["expired"] == 2, t["expired"]           # Ana + Eze (CDL)
    assert t["expiring_soon"] == 1, t["expiring_soon"]   # Beto (médico)
    assert t["missing_dates"] == 4, t["missing_dates"]   # los 4 docs de Dani
    assert t["with_truck"] == 4 and t["without_truck"] == 1
    # Conductores (no documentos) que necesitan algo: Ana, Beto, Dani, Eze.
    assert t["needs_attention"] == 4, t["needs_attention"]

    # 'sin fecha' NO se cuenta como vigente.
    cdl = next(d for d in r["by_doc"] if d["key"] == "cdl_exp")
    assert cdl["expired"] == 2 and cdl["missing"] == 1 and cdl["valid"] == 2, cdl

    # El mix de roles ignora a los sin perfil (si no, Dani metería un
    # owner_operator fantasma que nadie cargó).
    assert r["role_mix"] == [{"key": "company_driver",
                              "label": "Company driver", "count": 4}], r["role_mix"]

    # Orden de la cola: vencidos primero y el más vencido arriba.
    names = [a["name"] for a in r["attention"]]
    assert names[0] == "Eze" and names[1] == "Ana", names[:3]
    assert r["attention"][0]["state"] == "expired"
    # Los 'missing' van al final del ranking.
    assert r["attention"][-1]["state"] == "missing", r["attention"][-1]
    print("OK conteos, 'sin fecha' separado, mix de roles con guardia, orden")


def test_empty_roster():
    r = driver_compliance_report([], TODAY)
    assert r["totals"]["drivers"] == 0
    assert r["totals"]["needs_attention"] == 0
    assert r["attention"] == [] and r["role_mix"] == []
    # by_doc sigue trayendo las 4 filas (en cero), así la UI no parpadea.
    assert len(r["by_doc"]) == 4
    print("OK roster vacío no rompe")


if __name__ == "__main__":
    test_doc_state()
    test_report_counts_and_order()
    test_empty_roster()
    print("\nALL DRIVER COMPLIANCE TESTS PASSED")
