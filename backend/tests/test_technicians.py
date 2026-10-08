# -*- coding: utf-8 -*-
"""Tests del roster de técnicos (v2.21, benchmark SquareRigger).

`python backend/tests/test_technicians.py`. DB SQLite temporal fresca.

Lo que NO hay que perder:
  - la primera lectura siembra el roster: mecánicos distintos de las WOs +
    usuarios con rol 'mechanic' (con user_id), dedupe case-insensitive;
  - nombre duplicado (case-insensitive) => 400 "technician already exists";
  - renombrar actualiza en cascada WorkOrder.mechanic (y solo en la org);
  - desactivar es suave: sale del listado activo, sigue con ?all=1;
  - crear/editar una WO con un mecánico desconocido lo agrega solo (el
    roster nunca bloquea una asignación); GET /workorders.mechanics = activos;
  - rutas: GET/POST /technicians, PATCH/DELETE /technicians/{id}, listado
    ordenado por nombre; RBAC maint.edit (NO settings.manage);
  - aislamiento por tenant.
"""
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

_TMP = Path(tempfile.mkdtemp())
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP / 'technicians_test.db'}"

from fastapi import HTTPException                       # noqa: E402
from sqlalchemy import select                           # noqa: E402

from app import db                                      # noqa: E402
from app.api import routes                              # noqa: E402
from app.core import auth, technicians, tenant, workorders  # noqa: E402
from app.main import _scope_for                         # noqa: E402

ORG = db.default_org_id()
tenant.set_current_org(ORG)


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


def _names(active_only=True):
    return [t["name"] for t in technicians.list_technicians(active_only)]


def _mechanic_of(wo_id: int) -> str:
    with db.SessionLocal() as s:
        return s.get(db.WorkOrder, wo_id).mechanic


def _raw_wo(unit: str, mechanic: str) -> int:
    """WO insertada a mano (sin pasar por create_wo, que ya auto-agrega):
    simula el historial previo a v2.21."""
    now = datetime.now()
    with db.SessionLocal() as s:
        wo = db.WorkOrder(created_at=now, updated_at=now, unit=unit,
                          title="legacy", mechanic=mechanic,
                          status="assigned" if mechanic else "open")
        s.add(wo)
        s.commit()
        return wo.id


def test_seed_from_wos_and_users():
    w1 = _raw_wo("U-1", "Luis")
    w2 = _raw_wo("U-1", "Luis")
    w3 = _raw_wo("U-2", "ana")
    _raw_wo("U-3", "")
    _raw_wo("U-3", "  ")
    pedro = auth.create_user("Pedro Gomez", "pedro", "secretpass1",
                             role="mechanic")
    auth.create_user("Dana Dispatch", "dana", "secretpass1",
                     role="dispatcher")
    luis_user = auth.create_user("LUIS", "luis", "secretpass1",
                                 role="mechanic")
    assert db.get_setting("technicians") is None
    rows = technicians.list_technicians()
    assert [t["name"] for t in rows] == ["ana", "Luis", "Pedro Gomez"], rows
    assert all(t["active"] for t in rows)
    by = {t["name"]: t for t in rows}
    assert by["Pedro Gomez"]["user_id"] == pedro["id"]
    # 'LUIS' (usuario) se funde con 'Luis' (WOs) y aporta el user_id.
    assert by["Luis"]["user_id"] == luis_user["id"]
    assert by["ana"]["user_id"] is None
    assert all(t["created_at"] for t in rows)
    assert {t["id"] for t in rows} == {1, 2, 3}
    # Persistido: la segunda lectura no re-siembra.
    assert db.get_setting("technicians")["technicians"]
    assert _names() == ["ana", "Luis", "Pedro Gomez"]
    # El GET /workorders expone los activos.
    assert routes.wo_list()["mechanics"] == ["ana", "Luis", "Pedro Gomez"]
    assert workorders.mechanics() == ["ana", "Luis", "Pedro Gomez"]
    globals().update(W1=w1, W2=w2, W3=w3)
    print("OK siembra desde WOs + usuarios mechanic (dedupe, user_id)")


def test_duplicate_name_400():
    _raises(technicians.add, "technician already exists", "luis")
    _raises(technicians.add, "technician already exists", "  LUIS ")
    _raises(technicians.add, "technician name is required", "   ")
    t = technicians.add("New Guy", user_id=None)
    assert t["name"] == "New Guy" and t["active"] and t["id"] == 4
    exc = _http(routes.technicians_create, 400,
                routes.TechnicianIn(name="new guy"))
    assert exc.detail == "technician already exists"
    r = routes.technicians_create(routes.TechnicianIn(name="Route Tech",
                                                      user_id=0))
    assert r["name"] == "Route Tech" and r["user_id"] is None
    print("OK duplicado => 400; alta por ruta")


def test_rename_cascades_to_wos():
    luis = next(t for t in technicians.list_technicians()
                if t["name"] == "Luis")
    other = workorders.create_wo("U-9", "Other", mechanic="ana")
    t = technicians.update(luis["id"], {"name": "Luis Perez"})
    assert t["name"] == "Luis Perez" and t["user_id"] == luis["user_id"]
    assert _mechanic_of(W1) == "Luis Perez" and _mechanic_of(W2) == "Luis Perez"
    assert _mechanic_of(W3) == "ana" and _mechanic_of(other["id"]) == "ana"
    assert workorders.get_wo(W1)["mechanic"] == "Luis Perez"
    assert "Luis" not in _names() and "Luis Perez" in _names()
    # Renombrar a un nombre existente => 400 (y no cambia nada).
    _raises(technicians.update, "technician already exists",
            luis["id"], {"name": "ANA"})
    assert _mechanic_of(W1) == "Luis Perez"
    _raises(technicians.update, "technician name is required",
            luis["id"], {"name": ""})
    # user_id editable; null explícito lo desliga.
    t = technicians.update(luis["id"], {"user_id": None})
    assert t["user_id"] is None
    assert technicians.update(999, {"name": "x"}) is None
    # Ruta: solo campos presentes.
    r = routes.technicians_update(luis["id"],
                                  routes.TechnicianPatch(name="Luis P."))
    assert r["name"] == "Luis P." and _mechanic_of(W1) == "Luis P."
    _http(routes.technicians_update, 404, 999,
          routes.TechnicianPatch(name="x"))
    _http(routes.technicians_update, 400, luis["id"],
          routes.TechnicianPatch(name="ana"))
    print("OK renombrar cascada a WOs; duplicado 400")


def test_deactivate_is_soft():
    ana = next(t for t in technicians.list_technicians() if t["name"] == "ana")
    t = technicians.deactivate(ana["id"])
    assert t["active"] is False
    assert "ana" not in _names()
    assert "ana" in _names(active_only=False)
    assert technicians.get(ana["id"])["active"] is False
    # Sigue nombrada en las WOs (no se borra nada).
    assert _mechanic_of(W3) == "ana"
    assert technicians.deactivate(999) is None
    # Reactivar.
    t = technicians.update(ana["id"], {"active": True})
    assert t["active"] and "ana" in _names()
    # Ruta DELETE = baja suave; GET ?all=1 la incluye.
    r = routes.technicians_deactivate(ana["id"])
    assert r["active"] is False
    assert "ana" not in [t["name"] for t in
                         routes.technicians_list(0)["technicians"]]
    assert "ana" in [t["name"] for t in
                     routes.technicians_list(1)["technicians"]]
    _http(routes.technicians_deactivate, 404, 999)
    # Un nombre dado de baja sigue contando como duplicado (no se duplica).
    _raises(technicians.add, "technician already exists", "Ana")
    # Asignar a una WO a un técnico inactivo no se bloquea ni lo duplica.
    wo = workorders.create_wo("U-10", "Inactive ok", mechanic="ana")
    assert wo["mechanic"] == "ana"
    assert [t["name"] for t in technicians.list_technicians(False)].count(
        "ana") == 1
    print("OK baja suave; ?all=1; nunca bloquea asignación")


def test_auto_add_on_wo_mechanic():
    assert "Zoe" not in _names()
    wo = workorders.create_wo("U-11", "Patch me")
    out = workorders.update_wo(wo["id"], {"mechanic": "Zoe",
                                          "status": "assigned"})
    assert out["mechanic"] == "Zoe" and out["status"] == "assigned"
    assert "Zoe" in _names()
    # Crear con mecánico desconocido también.
    workorders.create_wo("U-11", "Create", mechanic="Yan Li")
    assert "Yan Li" in _names()
    # Existente (otra grafía) no duplica; vacío no agrega.
    before = len(_names(active_only=False))
    workorders.update_wo(wo["id"], {"mechanic": "zoe"})
    workorders.update_wo(wo["id"], {"mechanic": ""})
    assert len(_names(active_only=False)) == before
    assert "" not in _names(active_only=False)
    # Via ruta PATCH /workorders.
    import asyncio
    from app.core import telegram_notify
    real = telegram_notify.notify_wo

    async def _no_tg(wo, prev):
        return None
    telegram_notify.notify_wo = _no_tg
    try:
        asyncio.run(routes.wo_patch(wo["id"],
                                    routes.WorkOrderPatch(mechanic="Route Guy"),
                                    None))
    finally:
        telegram_notify.notify_wo = real
    assert "Route Guy" in _names()
    assert routes.wo_list()["mechanics"] == _names()
    print("OK mecánico desconocido en WO => se agrega solo")


def test_list_route_order_and_rbac():
    names = [t["name"] for t in routes.technicians_list(0)["technicians"]]
    assert names == sorted(names, key=str.lower), names
    assert all(t["active"] for t in routes.technicians_list(0)["technicians"])
    allrows = routes.technicians_list(1)["technicians"]
    assert len(allrows) >= len(names)
    assert all(set(t) == {"id", "name", "active", "user_id", "created_at"}
               for t in allrows)
    paths = [r.path for r in routes.router.routes]
    assert "/api/technicians" in paths
    assert "/api/technicians/{tech_id}" in paths
    assert paths.index("/api/technicians") < \
        paths.index("/api/technicians/{tech_id}")
    methods = {}
    for r in routes.router.routes:
        if r.path.startswith("/api/technicians"):
            methods.setdefault(r.path, set()).update(r.methods)
    assert methods["/api/technicians"] == {"GET", "POST"}
    assert methods["/api/technicians/{tech_id}"] == {"PATCH", "DELETE"}
    # RBAC: escrituras = maint.edit (dispatcher Y mechanic), nunca
    # settings.manage; GET abierto a cualquier autenticado.
    from app.core import permissions
    for m, p in (("POST", "/api/technicians"),
                 ("PATCH", "/api/technicians/3"),
                 ("DELETE", "/api/technicians/3")):
        assert _scope_for(m, p) == "maint.edit", (m, p)
        for role in ("admin", "dispatcher", "mechanic"):
            assert permissions.has_scope(ORG, role, _scope_for(m, p)), role
        assert not permissions.has_scope(ORG, "viewer", _scope_for(m, p))
    assert _scope_for("GET", "/api/technicians") is None
    print("OK listado ordenado, rutas y RBAC maint.edit")


def test_tenant_isolation():
    with db.SessionLocal() as s:
        org2 = db.Organization(slug="other", name="Other", active=True,
                               created_at=datetime.now())
        s.add(org2)
        s.commit()
        org2_id = org2.id
    token = tenant.set_current_org(org2_id)
    try:
        assert technicians.list_technicians() == []
        technicians.add("Only Here")
        assert _names() == ["Only Here"]
        # Renombrar en la org 2 no toca las WOs de la org 1 con ese nombre.
        _raw_wo("X-1", "Shared Name")
        t = technicians.add("Shared Name")
    finally:
        tenant.reset_current_org(token)
    tenant.set_current_org(ORG)
    assert "Only Here" not in _names(active_only=False)
    w = _raw_wo("U-20", "Shared Name")
    token = tenant.set_current_org(org2_id)
    try:
        technicians.update(t["id"], {"name": "Renamed Elsewhere"})
    finally:
        tenant.reset_current_org(token)
    tenant.set_current_org(ORG)
    assert _mechanic_of(w) == "Shared Name"
    print("OK aislamiento por tenant")


def test_rename_cascade_merges_spellings():
    """Grafías 'Casey' / 'CASEY' / ' casey ' (historial pre-v2.21) siguen el
    renombre, y una WO nueva lleva la grafía del roster."""
    w_a = _raw_wo("U-30", "Casey")
    w_b = _raw_wo("U-30", "CASEY")
    w_c = _raw_wo("U-30", " casey ")
    assert "Casey" not in _names(active_only=False)
    wo = workorders.create_wo("U-30", "Mixed", mechanic="casey")
    # No estaba en el roster: se guarda como vino y se agrega así.
    assert wo["mechanic"] == "casey"
    casey = technicians.ensure("CASEY")
    assert casey["name"] == "casey"
    # La grafía del roster se escribe en la WO (create y patch).
    wo2 = workorders.create_wo("U-30", "Canon", mechanic="CASEY")
    assert wo2["mechanic"] == "casey"
    assert workorders.update_wo(w_a, {"mechanic": "Casey "})["mechanic"] \
        == "casey"
    # Renombrar arrastra TODAS las grafías (W_a ya quedó canónica).
    before = len(_names(active_only=False))
    t = technicians.update(casey["id"], {"name": "Casey Jones"})
    assert t["name"] == "Casey Jones"
    for w in (w_a, w_b, w_c, wo["id"], wo2["id"]):
        assert _mechanic_of(w) == "Casey Jones", (w, _mechanic_of(w))
    assert _names(active_only=False).count("Casey Jones") == 1
    assert "casey" not in _names(active_only=False)
    # Otra grafía del nombre nuevo => canónica, sin duplicar el roster.
    wo3 = workorders.create_wo("U-30", "After", mechanic="casey  jones")
    assert wo3["mechanic"] == "Casey Jones"
    assert len(_names(active_only=False)) == before
    print("OK renombrar funde grafías; la WO lleva la grafía del roster")


def test_seed_spelling_is_deterministic():
    """La siembra elige la grafía MÁS usada en las WOs y, a igual uso, la de
    nombre propio; no la que dicte el orden de iteración de un set."""
    for m in ("Kim Lee", "KIM LEE", "KIM LEE", "kim lee"):
        _raw_wo("U-31", m)
    rows = technicians._seed()
    names = [r["name"] for r in rows
             if technicians._key(r["name"]) == "kim lee"]
    assert names == ["KIM LEE"], names
    for m in ("PAT ROE", "Pat Roe"):
        _raw_wo("U-31", m)
    rows = technicians._seed()
    names = [r["name"] for r in rows
             if technicians._key(r["name"]) == "pat roe"]
    assert names == ["Pat Roe"], names
    print("OK siembra determinista (grafía más usada / nombre propio)")


def test_user_id_must_exist_in_org():
    """user_id debe ser un usuario de la org (DATA-3): inexistente u de otra
    org => 400 'user not found'."""
    _raises(technicians.add, "user not found", "Ghost Link", user_id=99999)
    assert "Ghost Link" not in _names(active_only=False)
    t = technicians.add("Linked Later")
    _raises(technicians.update, "user not found", t["id"],
            {"user_id": 99999})
    pedro = next(u for u in auth.list_users() if u["username"] == "pedro")
    assert technicians.update(t["id"], {"user_id": pedro["id"]})["user_id"] \
        == pedro["id"]
    with db.SessionLocal() as s:
        org2 = db.Organization(slug="other-users", name="Other", active=True,
                               created_at=datetime.now())
        s.add(org2)
        s.commit()
        org2_id = org2.id
    foreign = auth.create_user("Foreign Mech", "foreign", "secretpass1",
                               role="mechanic", org_id=org2_id)
    _raises(technicians.update, "user not found", t["id"],
            {"user_id": foreign["id"]})
    assert technicians.get(t["id"])["user_id"] == pedro["id"]
    exc = _http(routes.technicians_create, 400,
                routes.TechnicianIn(name="Route Ghost", user_id=424242))
    assert exc.detail == "user not found"
    print("OK user_id validado contra los usuarios de la org")


def test_failed_create_leaves_no_ghost():
    """Si la creación de la WO falla, el mecánico NO queda en el roster (el
    alta va después del commit)."""
    _raises(workorders.create_wo, "parent work order not found",
            "U-32", "child", mechanic="Ghost Tech", parent_id=9999)
    assert "Ghost Tech" not in _names(active_only=False)
    print("OK creación fallida => sin técnico fantasma")


def test_concurrent_ensure_keeps_everyone():
    """Altas concurrentes no se pisan ni comparten id (read-modify-write en
    una transacción bajo lock: db.update_setting)."""
    import threading
    names = [f"Thread Tech {i}" for i in range(12)]
    results: dict = {}
    errors: list = []
    barrier = threading.Barrier(len(names))

    def run(n):
        try:
            barrier.wait(timeout=10)
            tok = tenant.set_current_org(ORG)
            try:
                results[n] = technicians.ensure(n)["id"]
            finally:
                tenant.reset_current_org(tok)
        except Exception as exc:          # noqa: BLE001
            errors.append(exc)
    ths = [threading.Thread(target=run, args=(n,)) for n in names]
    for th in ths:
        th.start()
    for th in ths:
        th.join(60)
    assert not errors, errors
    roster = _names(active_only=False)
    assert all(n in roster for n in names), [n for n in names
                                             if n not in roster]
    assert len(set(results.values())) == len(names), results
    ids = [t["id"] for t in technicians.list_technicians(False)]
    assert len(ids) == len(set(ids))
    print("OK ensure concurrente: nadie se pierde, ids únicos")


if __name__ == "__main__":
    test_seed_from_wos_and_users()
    test_duplicate_name_400()
    test_rename_cascades_to_wos()
    test_deactivate_is_soft()
    test_auto_add_on_wo_mechanic()
    test_list_route_order_and_rbac()
    test_rename_cascade_merges_spellings()
    test_seed_spelling_is_deterministic()
    test_user_id_must_exist_in_org()
    test_failed_create_leaves_no_ghost()
    test_concurrent_ensure_keeps_everyone()
    test_tenant_isolation()
    print("\nALL TECHNICIAN TESTS PASSED")
