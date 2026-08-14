# -*- coding: utf-8 -*-
"""Tests del walkaround del driver (v2.16, elemento 02 — el que integra todo).

`python backend/tests/test_walkarounds.py`. DB SQLite temporal fresca.

Lo que NO hay que perder:
  - los pasos son SNAPSHOT: editar el workflow a mitad de corrida no la mueve;
  - la validación es fail-first: si falta algo NO se materializa nada;
  - un paso con defecto crea una fila REAL en `defect` (source walkaround,
    block_id NULL) con la nota y las fotos re-parentadas;
  - el paso 'read' alimenta el odómetro (idempotente por día);
  - submit dos veces falla (la corrida se sella).
"""
import os
import sys
import tempfile
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

_TMP = Path(tempfile.mkdtemp())
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP / 'walk_test.db'}"
os.environ["FLEET_DEMO"] = "1"

from app import db                                      # noqa: E402
from app.core import (                                  # noqa: E402
    evidence, odometer, tenant, walkarounds, workflows)

tenant.set_current_org(db.default_org_id())
evidence.UPLOADS_DIR = _TMP / "uploads"

JPG = b"\xff\xd8\xff\xe0" + b"x" * 64


def _fresh_run():
    workflows.ensure_default()
    return walkarounds.start("412", "M. Herrera", "SUMMIT FREIGHT")


def test_start_snapshot():
    try:
        walkarounds.start("", "X")
        raise AssertionError("sin unidad debió fallar")
    except ValueError:
        pass
    run = _fresh_run()
    assert run["status"] == "in_progress"
    assert len(run["steps"]) == 5, "snapshot de los 5 pasos del seed"
    assert run["steps"][0]["type"] == "photo"

    # Editar el workflow DESPUÉS no mueve la corrida (snapshot).
    wf = workflows.active_workflow()
    workflows.save_workflow(wf["id"], {
        "name": wf["name"],
        "steps": [{"type": "check", "label": "Only one", "required": True}],
    })
    again = walkarounds.get(run["id"])
    assert len(again["steps"]) == 5, "la corrida no cambia con el workflow"
    # Restaurar el seed para el resto de los tests.
    workflows.save_workflow(wf["id"], {
        "name": wf["name"],
        "steps": [{"type": s["type"], "label": s["label"],
                   "required": s["required"]} for s in run["steps"]],
    })
    print("OK start: valida, snapshotea y no se mueve con el workflow")


def test_validation_fail_first():
    run = _fresh_run()
    steps = run["steps"]
    # Falta todo: el primer paso requerido de foto corta el submit.
    try:
        walkarounds.submit(run["id"], [])
        raise AssertionError("sin resultados debió fallar")
    except ValueError as exc:
        assert "Step 1" in str(exc)
    # Nada se materializó (fail-first de verdad).
    assert db.list_defects() == []
    assert walkarounds.get(run["id"])["status"] == "in_progress"
    # Defecto sin nota también corta.
    for s in steps[:2]:
        evidence.save_photo("walkstep", s["id"], "p.jpg", JPG)
    results = [{"step_id": s["id"], "verdict": "ok"} for s in steps[:3]]
    results[1] = {"step_id": steps[1]["id"], "verdict": "defect", "note": ""}
    try:
        walkarounds.submit(run["id"], results)
        raise AssertionError("defecto sin nota debió fallar")
    except ValueError as exc:
        assert "note" in str(exc).lower() or "describe" in str(exc)
    print("OK validación fail-first: nada se materializa si falta algo")


def test_submit_materializes():
    run = _fresh_run()
    steps = run["steps"]
    # Fotos en los dos pasos de foto + firma; una del paso 2 irá al defecto.
    evidence.save_photo("walkstep", steps[0]["id"], "lights.jpg", JPG)
    evidence.save_photo("walkstep", steps[1]["id"], "tire1.jpg", JPG)
    evidence.save_photo("walkstep", steps[1]["id"], "tire2.jpg", JPG)
    evidence.save_photo("walkstep", steps[4]["id"], "sig.png",
                        b"\x89PNG\r\n" + b"x" * 64)
    results = [
        {"step_id": steps[0]["id"], "verdict": "ok"},
        {"step_id": steps[1]["id"], "verdict": "defect",
         "note": "Right rear inner tire worn to cords"},
        {"step_id": steps[2]["id"], "verdict": "ok"},
        {"step_id": steps[3]["id"], "value": "481200"},
        {"step_id": steps[4]["id"]},
    ]
    out = walkarounds.submit(run["id"], results)
    assert out["status"] == "submitted"
    assert out["defects_created"] == 1
    assert out["odometer_logged"] is True

    # El defecto es una fila real, denormalizada, con las fotos re-parentadas.
    ds = db.list_defects(unit="412")
    assert len(ds) == 1
    d = ds[0]
    assert d["status"] == "open" and "tire worn" in d["detail"].lower()
    photos = evidence.list_photos("defect", d["id"])
    assert len(photos) == 2, "las 2 fotos del paso siguieron al defecto"
    # Las del paso OK quedaron en el paso (prueba de inspección).
    assert len(evidence.list_photos("walkstep", steps[0]["id"])) == 1

    # Odómetro registrado hoy para la unidad.
    reads = odometer.unit_readings("412")
    assert any(r["miles"] == 481200 for r in reads["readings"])

    # Sellada: submit de nuevo falla.
    try:
        walkarounds.submit(run["id"], results)
        raise AssertionError("re-submit debió fallar")
    except ValueError:
        pass
    # Y aparece en recent.
    rec = walkarounds.recent()
    assert rec[0]["id"] == run["id"] and rec[0]["defects_created"] == 1
    print("OK submit: defecto real + fotos re-parentadas + odómetro + sello")


if __name__ == "__main__":
    test_start_snapshot()
    test_validation_fail_first()
    test_submit_materializes()
    print("\nALL WALKAROUND TESTS PASSED")
