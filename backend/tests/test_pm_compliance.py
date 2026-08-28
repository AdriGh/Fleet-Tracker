# -*- coding: utf-8 -*-
"""Tests del reporte de cumplimiento de PM por variante de motor (v2.18).

`python backend/tests/test_pm_compliance.py`. DB SQLite temporal + demo ELD.

Lo que NO hay que perder:
  - la variante sale del year/make/model COMPLETO (un "2020 International LT"
    es ISX aunque el model pelado diga "LT" — el gap que motivó el reporte);
  - los grupos particionan el universo del PM Tracker (mismos totales:
    el reporte nunca contradice al tablero);
  - los conteos por estado suman el total del grupo;
  - registrar un PM mueve la unidad de estado en el reporte.
"""
import asyncio
import os
import sys
import tempfile
from datetime import date
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

_TMP = Path(tempfile.mkdtemp())
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP / 'pmc_test.db'}"
os.environ["FLEET_DEMO"] = "1"

from app import db                                   # noqa: E402
from app.core import maint, tenant                   # noqa: E402

tenant.set_current_org(db.default_org_id())

STATUSES = ("on_track", "upcoming", "overdue", "never", "no_meter")


def _report():
    return asyncio.run(maint.pm_compliance())


def test_groups_and_variants():
    r = _report()
    assert r["available"] is True
    by = {g["key"]: g for g in r["groups"]}
    # Flota demo: Freightliners -> DD, Internationals -> ISX, resto generico.
    assert "pm_dd" in by and "pm_isx" in by and "pm_generic" in by
    assert "DD13/DD15" in by["pm_dd"]["label"]
    assert "ISX" in by["pm_isx"]["label"]
    dd_units = {row["unit"] for row in by["pm_dd"]["rows"]}
    isx_units = {row["unit"] for row in by["pm_isx"]["rows"]}
    gen_units = {row["unit"] for row in by["pm_generic"]["rows"]}
    assert "418" in dd_units, "Cascadia es DD13/DD15"
    assert "308" in isx_units and "214" in isx_units, \
        "los International son ISX (via make en el ymm completo)"
    assert "412" in gen_units and "503" in gen_units, \
        "Peterbilt/Volvo sin variante conocida -> generico"
    print(f"OK variantes: DD={len(dd_units)} ISX={len(isx_units)} "
          f"gen={len(gen_units)}")


def test_partition_matches_board():
    r = _report()
    pm_groups = [g for g in r["groups"] if g["kind"] == "pm"]
    total = sum(g["units"] for g in pm_groups)
    board = asyncio.run(maint.board("pm"))
    assert total == len(board["units"]), \
        "los grupos PM deben particionar el universo del PM Tracker"
    # Sin unidades repetidas entre variantes.
    all_units = [row["unit"] for g in pm_groups for row in g["rows"]]
    assert len(all_units) == len(set(all_units))
    print(f"OK particion: {total} camiones = universo del tablero")


def test_counts_sum():
    r = _report()
    for g in r["groups"]:
        s = sum(g[k] for k in STATUSES) + g["ops"]
        assert s == g["units"] == len(g["rows"]), \
            f"{g['key']}: conteos {s} != units {g['units']}"
        for row in g["rows"]:
            assert row["to_due_unit"] == ("days" if g["kind"] == "dot"
                                          else "mi")
    print("OK conteos por estado suman el total de cada grupo")


def test_recording_moves_status():
    by = {g["key"]: g for g in _report()["groups"]}
    row = by["pm_isx"]["rows"][0]
    before = row["status"]
    maint.add_record(row["unit"], "pm", date.today().isoformat(),
                     mileage=999_999)     # PM recien hecho, con millaje alto
    by2 = {g["key"]: g for g in _report()["groups"]}
    row2 = next(x for x in by2["pm_isx"]["rows"] if x["unit"] == row["unit"])
    assert row2["status"] == "on_track", (before, row2["status"])
    print(f"OK registrar PM: {row['unit']} {before} -> on_track")


if __name__ == "__main__":
    test_groups_and_variants()
    test_partition_matches_board()
    test_counts_sum()
    test_recording_moves_status()
    print("\nALL PM COMPLIANCE TESTS PASSED")
