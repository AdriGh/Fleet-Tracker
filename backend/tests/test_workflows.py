# -*- coding: utf-8 -*-
"""Tests del editor de workflows del driver (v2.15, elemento 03).

`python backend/tests/test_workflows.py`. DB SQLite temporal fresca.

Lo que NO hay que perder:
  - ensure_default siembra UNA vez (dos llamadas no duplican);
  - save_workflow es replace-all: preserva el orden mandado, reescribe pos
    secuencial y valida type/label con ValueError claro;
  - set_active es exclusivo (UN activo por org, siempre);
  - borrar el único workflow está prohibido; borrar el activo pasa la
    antorcha a otro (el invariante 'un activo' se sostiene);
  - active_workflow devuelve el activo con pasos ordenados por pos;
  - /api/workflows/active queda registrado ANTES que /api/workflows/{wid}
    (si no, FastAPI parsea "active" como wid y la ruta muere con 422).
"""
import os
import sys
import tempfile
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

_TMP = Path(tempfile.mkdtemp())
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP / 'workflows_test.db'}"

from app import db                                  # noqa: E402
from app.core import tenant, workflows              # noqa: E402

tenant.set_current_org(db.default_org_id())


def test_seed_idempotent():
    workflows.ensure_default()
    workflows.ensure_default()          # la segunda NO debe duplicar
    wfs = workflows.list_workflows()
    assert len(wfs) == 1, "dos ensure_default no pueden sembrar dos veces"
    assert wfs[0]["name"] == "Pre-trip" and wfs[0]["active"] is True
    assert wfs[0]["n_steps"] == 5
    full = workflows.get_workflow(wfs[0]["id"])
    assert [s["type"] for s in full["steps"]] == \
        ["photo", "photo", "check", "read", "sign"]
    assert full["steps"][0]["label"] == "Lights & reflectors"
    assert full["steps"][0]["required"] is True
    assert full["steps"][3]["required"] is False, "Odometer es opcional"
    print("OK seed idempotente: 1 Pre-trip activo con 5 pasos")


def test_save_replace_all():
    created = workflows.save_workflow(None, {
        "name": "Reefer pre-trip",
        "steps": [
            {"type": "photo", "label": "Reefer unit & fuel", "required": True},
            {"type": "read", "label": "Box temperature", "required": True},
            {"type": "sign", "label": "Driver signature", "required": True},
        ],
    })
    assert created["active"] is False, "nuevo workflow nace inactivo"
    wid = created["id"]

    # Replace-all: reordena, borra uno, agrega otro -> el orden guardado es
    # EXACTAMENTE el mandado, con pos secuencial desde 0.
    saved = workflows.save_workflow(wid, {
        "name": "Reefer pre-trip v2",
        "steps": [
            {"type": "read", "label": "Box temperature", "required": True},
            {"type": "check", "label": "Door seals", "required": False},
            {"type": "photo", "label": "Reefer unit & fuel", "required": True},
        ],
    })
    assert saved["name"] == "Reefer pre-trip v2"
    assert [s["label"] for s in saved["steps"]] == \
        ["Box temperature", "Door seals", "Reefer unit & fuel"]
    assert [s["pos"] for s in saved["steps"]] == [0, 1, 2]

    # Validación: type fuera del enum / label vacío / sin nombre / sin pasos
    # -> ValueError SIN tocar la base (el workflow queda como estaba).
    for payload, why in [
        ({"name": "X", "steps": [{"type": "video", "label": "L"}]}, "type"),
        ({"name": "X", "steps": [{"type": "check", "label": "  "}]}, "label"),
        ({"name": " ", "steps": [{"type": "check", "label": "L"}]}, "nombre"),
        ({"name": "X", "steps": []}, "sin pasos"),
    ]:
        try:
            workflows.save_workflow(wid, payload)
            raise AssertionError(f"debió rechazar por {why}")
        except ValueError:
            pass
    intact = workflows.get_workflow(wid)
    assert len(intact["steps"]) == 3, "el save inválido no debe tocar nada"
    print("OK replace-all: orden preservado, pos secuencial, validación")


def test_set_active_exclusive():
    wfs = workflows.list_workflows()
    assert len(wfs) == 2
    reefer = next(w for w in wfs if w["name"].startswith("Reefer"))
    workflows.set_active(reefer["id"])
    wfs = workflows.list_workflows()
    actives = [w for w in wfs if w["active"]]
    assert len(actives) == 1 and actives[0]["id"] == reefer["id"], \
        "activar uno debe desactivar el resto"
    try:
        workflows.set_active(99999)
        raise AssertionError("set_active de un id inexistente debió fallar")
    except ValueError:
        pass
    print("OK set_active exclusivo: un solo activo por org")


def test_active_workflow_ordered():
    wf = workflows.active_workflow()
    assert wf is not None and wf["name"] == "Reefer pre-trip v2"
    assert [s["pos"] for s in wf["steps"]] == \
        sorted(s["pos"] for s in wf["steps"]), "pasos ordenados por pos"
    assert [s["label"] for s in wf["steps"]] == \
        ["Box temperature", "Door seals", "Reefer unit & fuel"]
    print("OK active_workflow: el activo con pasos ordenados")


def test_delete_rules():
    wfs = workflows.list_workflows()
    reefer = next(w for w in wfs if w["active"])
    # Borrar el ACTIVO pasa la antorcha: el otro queda activo.
    workflows.delete_workflow(reefer["id"])
    wfs = workflows.list_workflows()
    assert len(wfs) == 1 and wfs[0]["active"] is True, \
        "borrar el activo debe activar otro"
    # Borrar el ÚNICO está prohibido.
    try:
        workflows.delete_workflow(wfs[0]["id"])
        raise AssertionError("borrar el único workflow debió fallar")
    except ValueError:
        pass
    assert len(workflows.list_workflows()) == 1
    print("OK delete: el activo pasa la antorcha, el único no se borra")


def test_route_order_and_endpoints():
    # In-process, sin server: las funciones de routes directo + el orden de
    # registro del router (la única forma de pescar la colisión active/{wid}).
    from app.api import routes

    paths = [r.path for r in routes.router.routes]
    assert "/api/workflows/active" in paths and "/api/workflows/{wid}" in paths
    assert paths.index("/api/workflows/active") < \
        paths.index("/api/workflows/{wid}"), \
        "/workflows/active debe registrarse ANTES que /workflows/{wid}"

    listed = routes.workflows_list()
    assert len(listed["workflows"]) == 1
    active = routes.workflows_active()
    assert active["id"] == listed["workflows"][0]["id"]
    # ValueError del core -> HTTPException 400 con el mensaje tal cual.
    try:
        routes.workflows_delete(active["id"])
        raise AssertionError("debió responder 400")
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 400
    print("OK rutas: /active antes de /{wid}, ValueError -> 400")


if __name__ == "__main__":
    test_seed_idempotent()
    test_save_replace_all()
    test_set_active_exclusive()
    test_active_workflow_ordered()
    test_delete_rules()
    test_route_order_and_endpoints()
    print("\nALL WORKFLOW TESTS PASSED")
