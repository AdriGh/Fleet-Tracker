# -*- coding: utf-8 -*-
"""Roster de técnicos (v2.21, benchmark SquareRigger).

El dueño quiere que asignar un técnico a una work order sea FÁCIL y que
ningún permiso lo bloquee. El roster vive en org_setting (clave
'technicians') como lista de {id, name, active, user_id, created_at} — SIN
tabla nueva ni cambio de esquema: `WorkOrder.mechanic` sigue siendo el
nombre como texto.

Reglas:
- La PRIMERA lectura con la lista vacía la siembra sola: los nombres
  distintos ya usados en WorkOrder.mechanic (grafías que solo difieren en
  mayúsculas/espacios se funden en UNA; gana la más usada) + los usuarios
  con rol 'mechanic' (auth.list_users), todos activos. Así el roster nace
  con lo que el taller ya usa.
- Renombrar un técnico actualiza en cascada WorkOrder.mechanic en las WOs
  que llevan el nombre viejo con CUALQUIER grafía (misma clave
  case/espacios-insensitive con la que el roster funde nombres; acotado a
  la org).
- Desactivar es SUAVE (active=False): nunca se borra (el historial de WOs
  lo sigue nombrando). El listado por defecto muestra solo activos.
- `canonical_name(name)` (solo lectura) devuelve la grafía del roster para
  que toda WO lleve UNA sola escritura del nombre; `ensure(name)` agrega el
  nombre si falta. core/workorders las llama: canonical_name dentro de la
  transacción de la WO, ensure DESPUÉS del commit (escribe org_setting en
  su propia transacción; en SQLite no puede hacerlo con la WO a medias).
  El roster nunca bloquea una asignación.
- `user_id` opcional debe ser un usuario de la org (User no es OrgScoped:
  misma guarda DATA-3 que auth.update_user).

Toda mutación es un read-modify-write en UNA transacción con la fila
bloqueada (db.update_setting): dos altas concurrentes no se pisan ni
reparten el mismo id.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select

from .. import db
from . import tenant

SETTING_KEY = "technicians"
_USER_MSG = "user not found"


def _rows_of(data) -> list[dict]:
    rows = data.get("technicians") if isinstance(data, dict) else None
    return [dict(r) for r in rows] if isinstance(rows, list) else []


def _load() -> list[dict]:
    """Lectura simple (sin sembrar ni escribir)."""
    return _rows_of(db.get_setting(SETTING_KEY))


def _key(name: str) -> str:
    """Clave de comparación de nombres (case-insensitive, sin espacios
    extra)."""
    return " ".join((name or "").split()).lower()


def _clean(name: str) -> str:
    return " ".join((name or "").split())[:80]


def _dict(t: dict) -> dict:
    return {
        "id": int(t.get("id") or 0),
        "name": t.get("name") or "",
        "active": bool(t.get("active", True)),
        "user_id": t.get("user_id"),
        "created_at": t.get("created_at") or "",
    }


def _next_id(rows: list[dict]) -> int:
    return max((int(r.get("id") or 0) for r in rows), default=0) + 1


def _find(rows: list[dict], name: str) -> dict | None:
    k = _key(name)
    return next((r for r in rows if _key(r.get("name") or "") == k), None)


def _new(rows: list[dict], name: str, user_id: int | None) -> dict:
    return {"id": _next_id(rows), "name": name, "active": True,
            "user_id": user_id, "created_at": datetime.now().isoformat()}


def _clean_user_id(raw) -> int | None:
    """user_id del body: None/''/0 => sin usuario. Si viene, debe existir y
    ser de la org actual (User NO es OrgScoped, así que se filtra a mano:
    DATA-3, igual que auth.update_user). Si no, ValueError."""
    if raw in (None, "", 0, "0"):
        return None
    try:
        uid = int(raw)
    except (TypeError, ValueError):
        raise ValueError(_USER_MSG)
    org = tenant.get_current_org()
    with db.SessionLocal() as session:
        u = session.get(db.User, uid)
        if u is None or (org is not None and u.org_id != org):
            raise ValueError(_USER_MSG)
    return uid


def _seed() -> list[dict]:
    """Roster inicial: mecánicos ya usados en WOs + usuarios rol 'mechanic'.
    Dedupe case-insensitive; los usuarios aportan user_id. La grafía de cada
    nombre es DETERMINISTA: la más usada en las WOs y, a igual uso, la que
    parece nombre propio ('Luis' antes que 'LUIS'/'luis')."""
    from . import auth                 # import diferido (orden de carga)
    rows: list[dict] = []
    seen: set[str] = set()
    now = datetime.now().isoformat()

    def _push(name: str, user_id: int | None) -> None:
        name = _clean(name)
        k = _key(name)
        if not k:
            return
        if k in seen:
            # Ya está por el nombre (vino de una WO): liga el user_id.
            if user_id is not None:
                for r in rows:
                    if _key(r["name"]) == k and r.get("user_id") is None:
                        r["user_id"] = user_id
            return
        seen.add(k)
        rows.append({"id": _next_id(rows), "name": name, "active": True,
                     "user_id": user_id, "created_at": now})

    with db.SessionLocal() as session:
        used = session.execute(
            select(db.WorkOrder.mechanic, func.count())
            .group_by(db.WorkOrder.mechanic)).all()
    spellings: dict[str, dict[str, int]] = {}
    for m, n in used:
        m = _clean(m or "")
        k = _key(m)
        if k:
            bucket = spellings.setdefault(k, {})
            bucket[m] = bucket.get(m, 0) + int(n or 0)
    names = [
        sorted(bucket.items(),
               key=lambda kv: (-kv[1], kv[0] != kv[0].title(), kv[0]))[0][0]
        for bucket in spellings.values()
    ]
    for m in sorted(names, key=lambda m: (m.lower(), m)):
        _push(m, None)
    try:
        users = auth.list_users()
    except Exception:
        users = []
    for u in users:
        if u.get("role") == "mechanic" and u.get("active", True):
            _push(u.get("name") or u.get("username") or "", u.get("id"))
    return rows


def _mutate(fn):
    """Read-modify-write del roster en UNA transacción con la fila de
    org_setting bloqueada (db.update_setting). `fn(rows)` muta la lista en
    sitio y devuelve lo que el caller necesita; si lanza, no se escribe
    nada. Si la lista está vacía se siembra antes de aplicar `fn`."""
    out: dict = {}

    def _apply(data):
        rows = _rows_of(data)
        if not rows:
            rows = _seed()
        out["value"] = fn(rows)
        return {"technicians": rows}

    db.update_setting(SETTING_KEY, _apply)
    return out["value"]


def _rows() -> list[dict]:
    """Lista persistida; si está vacía se siembra (y se guarda si salió
    algo)."""
    rows = _load()
    if not rows:
        rows = _mutate(lambda rows: rows)
    return rows


def list_technicians(active_only: bool = True) -> list[dict]:
    rows = _rows()
    if active_only:
        rows = [r for r in rows if r.get("active", True)]
    return [_dict(r) for r in sorted(rows, key=lambda r: _key(r["name"]))]


def active_names() -> list[str]:
    """Nombres de los técnicos activos, ordenados (el campo `mechanics` del
    GET /workorders)."""
    return [t["name"] for t in list_technicians(active_only=True)]


def get(tech_id: int) -> dict | None:
    for r in _rows():
        if int(r.get("id") or 0) == int(tech_id):
            return _dict(r)
    return None


def add(name: str, user_id: int | None = None) -> dict:
    name = _clean(name)
    if not name:
        raise ValueError("technician name is required")
    uid = _clean_user_id(user_id)

    def _fn(rows: list[dict]) -> dict:
        if _find(rows, name) is not None:
            raise ValueError("technician already exists")
        t = _new(rows, name, uid)
        rows.append(t)
        return _dict(t)
    return _mutate(_fn)


def canonical_name(name: str) -> str:
    """Grafía del roster para `name` (match case/espacios-insensitive), o
    el nombre limpio si todavía no está. SOLO lectura: core/workorders lo
    llama dentro de la transacción de la WO (donde no se puede escribir
    org_setting); el alta la hace ensure() después del commit."""
    name = _clean(name)
    if not name:
        return ""
    hit = _find(_load(), name)
    return hit["name"] if hit else name


def ensure(name: str) -> dict | None:
    """Garantiza que `name` esté en el roster (lo agrega activo si falta).
    Devuelve el técnico, o None si el nombre viene vacío. Nunca lanza por
    duplicado: si ya existe (activo o no) lo devuelve tal cual. Llamar
    DESPUÉS de commitear la WO (escribe org_setting)."""
    name = _clean(name)
    if not name:
        return None
    hit = _find(_load(), name)            # camino común: ya está
    if hit is not None:
        return _dict(hit)

    def _fn(rows: list[dict]) -> dict:
        t = _find(rows, name)
        if t is None:
            t = _new(rows, name, None)
            rows.append(t)
        return _dict(t)
    return _mutate(_fn)


def update(tech_id: int, fields: dict) -> dict | None:
    """Edita name/active/user_id. Renombrar actualiza en cascada el
    `mechanic` de las WOs que llevan el nombre viejo con cualquier grafía
    (org-scoped)."""
    uid_given = "user_id" in fields
    uid = _clean_user_id(fields["user_id"]) if uid_given else None

    def _fn(rows: list[dict]):
        t = next((r for r in rows if int(r.get("id") or 0) == int(tech_id)),
                 None)
        if t is None:
            return None
        old_name = t["name"]
        if "name" in fields and fields["name"] is not None:
            new_name = _clean(str(fields["name"]))
            if not new_name:
                raise ValueError("technician name is required")
            if any(_key(r["name"]) == _key(new_name) and r is not t
                   for r in rows):
                raise ValueError("technician already exists")
            t["name"] = new_name
        if "active" in fields and fields["active"] is not None:
            t["active"] = bool(fields["active"])
        if uid_given:
            t["user_id"] = uid
        return old_name, dict(t)

    res = _mutate(_fn)
    if res is None:
        return None
    old_name, t = res
    if t["name"] != old_name:
        _rename_in_wos(old_name, t["name"])
    return _dict(t)


def _rename_in_wos(old_name: str, new_name: str) -> int:
    """Cascada del renombre a las WOs: TODAS las grafías del nombre viejo
    ('Luis', 'LUIS', ' luis ') pasan a la nueva. Se recorren filas (SELECT
    acotado al tenant por el filtro OrgScoped) en vez de un UPDATE masivo,
    que no pasa por ese filtro. El prefiltro SQL (sin espacios, minúsculas)
    es un superconjunto; la confirmación usa _key, la MISMA clave con la que
    el roster funde nombres."""
    key = _key(old_name)
    compact = key.replace(" ", "")
    n = 0
    with db.SessionLocal() as session:
        wos = session.scalars(select(db.WorkOrder).where(
            func.lower(func.replace(db.WorkOrder.mechanic, " ", ""))
            == compact)).all()
        for wo in wos:
            if _key(wo.mechanic) == key:
                wo.mechanic = new_name
                n += 1
        if n:
            session.commit()
    return n


def deactivate(tech_id: int) -> dict | None:
    """Baja SUAVE: active=False. Nunca se borra del roster."""
    return update(tech_id, {"active": False})
