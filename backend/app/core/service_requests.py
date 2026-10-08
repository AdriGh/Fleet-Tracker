# -*- coding: utf-8 -*-
"""Service Requests (v2.20 — benchmark SquareRigger).

El BACKLOG por unidad desde el que se despacha el taller. Antes los defectos
del driver y los PM/DOT vencidos generaban WOs sueltas, cada uno por su lado;
ahora todo cae en una sola cola por unidad y la WO nace desde acá:

    defecto DVIR abierto ─┐
    PM / DOT por vencer  ─┼─> service_request ─> Deny | Snooze | Add to WO
    pedido manual        ─┘                       | Create WO (agrupa varios)

Fuentes de sistema (defect/pm/dot) se MATERIALIZAN con `sync()`: idempotente
gracias a `source_key` (clave estable, única por org). Reglas del sync:
  - Defectos: del feed actual (open_defects.current_feed). Un defecto que deja
    de aparecer en un feed EXITOSO se da por resuelto ('cleared'); si el feed
    falló o cayó al CSV por error NO se resuelve nada (nunca vaciar el backlog
    por una caída de Samsara).
  - PM / DOT: de maint.board(). El vencimiento se calcula con `to_due` +
    umbrales del board, NO con row['status'] (ops_status lo pisa). La clave
    lleva el CICLO (últimas millas / última fecha): registrar el PM cambia el
    ciclo y el próximo vencimiento es un request NUEVO. Si el board vino
    incompleto (Samsara caído: board['errors']) no se resuelve nada, y una
    unidad SIN dato (to_due None) tampoco: "sin dato" no es "al día".
  - Los snoozes vencidos vuelven a 'open'.
  - Las transiciones de estado del sync son UPDATEs condicionales (WHERE
    status ...): si una persona actuó sobre la fila mientras el sync corría
    (create_wo, deny…), gana la persona.
Los estados que decidió una persona (on_wo, done por WO, denied, deleted) el
sync no los toca; si un defecto así cerrado había desaparecido del feed y se
vuelve a reportar, la fila vieja se archiva y entra un request nuevo. Los
hooks de WO (completar / retroceder / borrar) los llama core/workorders.py
dentro de SU transacción.

Addendum v2.20 (pedidos del dueño):
  - UNIDAD CANÓNICA: la unidad sale del universo de GET /api/fleet
    (core/fleet_inventory: Samsara + manuales). El sync guarda el nombre
    canónico ('MEM77' del feed -> 'MEM 77' de la flota) y renombra las filas
    existentes; las claves van por `_norm_unit`, así que el rename no duplica.
    create_manual / defect_to_wo rechazan una unidad que la app no conoce
    (flota, backlog o fuentes del sync; si la flota no está disponible se
    acepta como vino). El resumen por unidad agrupa por unidad normalizada:
    las variantes de escritura se funden. Los PM/DOT guardan además la
    escritura de la fila del board (meta['board_unit']): el registro del
    servicio al facturar la WO va a ESA fila (maint_unit_for_wo).
  - BORRADO SUAVE: status 'deleted' (resolution 'deleted'); no sale en
    ninguna lista ni conteo, se puede restaurar (Undo: vuelve al estado que
    tenía, meta['_pre_delete']) y el sync NUNCA lo revive mientras su
    fuente siga activa.
  - DUPLICADOS: `duplicate_of` se calcula al listar (no se guarda) entre los
    requests accionables de la misma unidad, contra un KEEPER elegido por
    preferencia (_keeper_rank); delete_duplicates los borra.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
import uuid
import weakref
from datetime import date, datetime

from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError

from ..db import ServiceRequest, SessionLocal, WorkOrder
from . import (fleet_inventory, maint, manual_units, open_defects, pm,
               tenant, workorders)

log = logging.getLogger(__name__)

SOURCES = ("defect", "pm", "dot", "manual")
SYSTEM_SOURCES = ("defect", "pm", "dot")
PRIORITIES = ("low", "normal", "urgent", "emergency")
_PRIO_RANK = {p: i for i, p in enumerate(PRIORITIES)}
# Estados LISTABLES (filtro ?status= y conteos). 'deleted' (borrado suave)
# existe en la tabla pero no se lista, no se cuenta y no es un filtro válido.
STATUSES = ("open", "snoozed", "on_wo", "done", "denied")
DELETED = "deleted"
_ACTIONABLE = ("open", "snoozed")
# Lo que se puede borrar: todo menos on_wo (primero se desliga de la WO).
_DELETABLE = ("open", "snoozed", "done", "denied")
# Etiqueta de cada fuente en el complaint de la WO ("• [PM due] …").
_LABELS = {"defect": "DVIR defect", "pm": "PM due", "dot": "DOT due",
           "manual": "Request"}
# Prioridad del request -> prioridad de la WO (low | normal | high).
_WO_PRIORITY = {"emergency": "high", "urgent": "high", "normal": "normal",
                "low": "low"}
_CLOSED_WO = ("completed", "invoiced")
_TITLES = {"pm": "Preventive maintenance (PM) due",
           "dot": "Annual DOT inspection due"}

SYNC_TTL_S = 300
# Tope del historial (done / denied / all) en la lista; lo accionable va
# completo.
HISTORY_LIMIT = 1000
# Último sync por org: org_id -> (monotonic, synced_at ISO). Por proceso.
_last_sync: dict[int | None, tuple[float, str]] = {}
# Último índice de unidades de la flota por org: org_id -> (monotonic,
# {unidad normalizada: nombre canónico}). Lo arma cada sync (UNA vez por
# corrida) y lo reusan create_manual / defect_to_wo y el resumen por unidad.
_unit_index_cache: dict[int | None, tuple[float, dict[str, str]]] = {}
# Unidades que trajeron las FUENTES en el último sync (feed de defectos +
# todas las filas de los boards de PM/DOT, vencidas o no): org_id ->
# {unidad normalizada: escritura de la fuente}. Completa la validación de
# create_manual para unidades que la app muestra pero GET /fleet no tiene.
_source_units_cache: dict[int | None, dict[str, str]] = {}
# Un Lock por event loop (asyncio.Lock queda atado al loop donde espera; los
# tests corren varios asyncio.run y el server uno solo).
_locks: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock]" \
    = weakref.WeakKeyDictionary()


def _lock() -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    lk = _locks.get(loop)
    if lk is None:
        lk = _locks[loop] = asyncio.Lock()
    return lk


# ----- Claves y normalización ----------------------------------------------

def _norm_unit(unit: str) -> str:
    """Unidad comparable: mayúsculas y sin espacios ('mem 412' == 'MEM412')."""
    return "".join((unit or "").split()).upper()


def _norm_detail(detail: str) -> str:
    return " ".join((detail or "").lower().split())


def defect_key(unit: str, detail: str) -> str:
    """Clave estable de un defecto: misma unidad + mismo texto (normalizados)
    = mismo request, aunque Samsara lo re-reporte cada día."""
    raw = f"{_norm_unit(unit)}|{_norm_detail(detail)}".encode("utf-8")
    return "defect:" + hashlib.sha1(raw).hexdigest()[:24]


def _unit_ids(session, unit: str, *where) -> list[int]:
    """Ids de las filas (no borradas, + `where`) cuya unidad normaliza igual
    que `unit`. El filtro va en PYTHON con `_norm_unit`: un upper/replace de
    SQL no coincide con él (SQLite solo sube ASCII y no saca tabs ni NBSP),
    y entonces el ?unit= / delete_duplicates(unit) no veían filas que
    units[] sí agrupaba. Solo lee (id, unit)."""
    norm = _norm_unit(unit)
    pairs = session.execute(select(ServiceRequest.id, ServiceRequest.unit)
                            .where(ServiceRequest.status != DELETED, *where))
    return [i for i, u in pairs if _norm_unit(u) == norm]


# ----- Unidades canónicas (universo de GET /api/fleet) ----------------------

UNKNOWN_UNIT = "unknown unit — pick one from the fleet list"


async def _build_unit_index() -> dict[str, str]:
    """{unidad normalizada: nombre canónico} del MISMO universo que GET
    /api/fleet (Samsara + manuales; Samsara gana). Vacío si la flota no está
    disponible o vino PARCIAL (Samsara falló y solo quedan las manuales): con
    un universo incompleto no se puede decir que una unidad "no existe"."""
    try:
        inv = await fleet_inventory.load()
    except Exception as exc:  # noqa: BLE001 — sin flota se acepta lo tipeado
        log.warning("service_requests: fleet index failed: %s", exc)
        return {}
    if inv.get("error"):
        return {}
    out: dict[str, str] = {}
    # Ante dos grafías de la misma unidad gana la ACTIVA (un asset archivado
    # suele ser el duplicado / mal etiquetado de Samsara). Misma regla que el
    # front (unitMatch.ts). sorted es estable: entre activas, el orden de la
    # flota.
    units = sorted(inv.get("units") or [],
                   key=lambda u: bool(u.get("archived")))
    for u in units:
        name = str(u.get("unit") or "").strip()[:64]
        if name:
            out.setdefault(_norm_unit(name), name)
    return out


async def unit_index(unit: str = "") -> dict[str, str]:
    """Índice de unidades para validar / canonizar `unit` (rutas de
    create_manual y defect_to_wo). Reusa el del último sync si es reciente
    y YA tiene la unidad; si no, lo reconstruye (una unidad recién agregada en
    Fleet entra sin esperar al próximo sync)."""
    org = tenant.get_current_org()
    hit = _unit_index_cache.get(org)
    if (unit and hit is not None
            and time.monotonic() - hit[0] < SYNC_TTL_S
            and _norm_unit(unit) in hit[1]):
        return hit[1]
    idx = await _build_unit_index()
    _unit_index_cache[org] = (time.monotonic(), idx)
    return idx


async def defect_unit_index(unit: str) -> dict[str, str]:
    """Índice para defect_to_wo: la flota + la unidad del feed de defectos.
    Un defecto del CSV (p.ej. MCC, que Samsara no cubre) puede ser de una
    unidad que no está en GET /api/fleet: el defecto es real, así que esa
    unidad también es válida (con la escritura del feed)."""
    idx = await unit_index(unit)
    norm = _norm_unit(unit)
    if not idx or norm in idx:
        return idx
    try:
        feed = await open_defects.current_feed()
    except Exception:  # noqa: BLE001 — sin feed, solo la flota
        return idx
    for d in (feed or {}).get("defects") or []:
        name = str(d.get("unit") or "").strip()[:64]
        if name and _norm_unit(name) == norm:
            return {**idx, norm: name}
    return idx


def _canonical_unit(unit: str, units: dict[str, str] | None) -> str:
    """Nombre canónico de `unit` según el índice de la flota. Índice vacío o
    None (flota no disponible): se acepta como vino. Índice con datos y la
    unidad no está: ValueError (mensaje en inglés: UI)."""
    if not units:
        return unit
    canon = units.get(_norm_unit(unit))
    if canon is None:
        raise ValueError(UNKNOWN_UNIT)
    return canon


def _cached_names() -> dict[str, str]:
    hit = _unit_index_cache.get(tenant.get_current_org())
    return hit[1] if hit else {}


def _known_unit(session, norm: str) -> str | None:
    """Escritura de una unidad que la app YA muestra aunque no esté en GET
    /api/fleet: la de un request (no borrado) del backlog de la org — el más
    reciente — o la de las fuentes del último sync (defectos del CSV de MCC,
    camiones del CSV de PM / del board). Si la app la lista, tiene que poder
    recibir un pedido manual (como defect_to_wo con las unidades del feed)."""
    best: tuple[str, datetime] | None = None
    for u, upd in session.execute(
            select(ServiceRequest.unit, ServiceRequest.updated_at)
            .where(ServiceRequest.status != DELETED)):
        if _norm_unit(u) == norm:
            when = upd or datetime.min
            if best is None or when > best[1]:
                best = (u, when)
    if best is not None:
        return best[0]
    return _source_units_cache.get(tenant.get_current_org(), {}).get(norm)


# ----- Duplicados (se calculan al listar, no se guardan) --------------------

_NON_ALNUM = re.compile(r"[\W_]+")

# Palabras de POSICIÓN / LADO. Dos textos casi iguales que difieren en una
# de estas ('driver side' vs 'passenger side', 'left front' vs 'right
# front') son defectos DISTINTOS, no un duplicado: borrar uno escondería una
# falla real que el sync no revive mientras siga reportada.
_POSITION_WORDS = frozenset("""
    left right lh rh l r front rear back fwd forward aft driver drivers
    passenger passengers ds ps curb curbside street streetside roadside
    inner outer inside outside inboard outboard upper lower top bottom
    center centre middle mid steer drive tag pusher lf rf lr rr lfo lfi
    rfo rfi lro lri rro rri first second third fourth 1st 2nd 3rd 4th
    primary secondary
""".split())


def _dup_text(r: ServiceRequest) -> str:
    """detail (o title si no hay) en minúsculas, lo no alfanumérico a
    espacio y espacios colapsados."""
    raw = (r.detail or "").strip() or (r.title or "")
    return " ".join(_NON_ALNUM.sub(" ", raw.lower()).split())


def _positional(tokens: set[str]) -> bool:
    """¿Alguna palabra de posición o número (eje 2, 4/32, lado)?"""
    return any(t in _POSITION_WORDS or any(c.isdigit() for c in t)
               for t in tokens)


def _is_dup(a: ServiceRequest, b: ServiceRequest, ta: str, tb: str,
            ka: set[str], kb: set[str]) -> bool:
    """¿a y b (misma unidad) piden lo mismo?
      - mismo tipo de vencimiento (pm↔pm, dot↔dot);
      - mismo texto normalizado;
      - el más corto (≥ 12 caracteres) está contenido en el más largo
        (por palabras completas: 'brake light out' no matchea 'outlet');
      - Jaccard de palabras ≥ 0.8 con ≥ 3 palabras cada uno.
    Veto: si CADA texto tiene una palabra de posición o un número que el
    otro no tiene ('driver' vs 'passenger', 'left' vs 'right', 'axle 2' vs
    'axle 3') son fallas distintas aunque el resto coincida. (Un texto
    contenido en otro nunca tiene palabras propias: el veto no lo toca.)"""
    if a.source == b.source and a.source in ("pm", "dot"):
        return True
    if not ta or not tb:
        return False
    if ta == tb:
        return True
    if _positional(ka - kb) and _positional(kb - ka):
        return False
    short, long_ = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
    if len(short) >= 12 and f" {short} " in f" {long_} ":
        return True
    if len(ka) >= 3 and len(kb) >= 3:
        return len(ka & kb) / len(ka | kb) >= 0.8
    return False


_FAR = datetime.max - datetime.min


def _keeper_rank(r: ServiceRequest) -> tuple:
    """Orden de preferencia para quedarse con un request de un grupo de
    duplicados (el primero gana):
      1. fila de SISTEMA con la fuente activa (defect/pm/dot) antes que un
         manual o una fila vieja: borrar una de sistema es para siempre (el
         sync no la revive) y el manual no lleva campaña ni millaje a la WO;
      2. open antes que snoozed: un re-reporte abierto no se esconde detrás
         de uno pospuesto;
      3. la vista más RECIENTEMENTE por su fuente (source_seen_at): entre
         dos ciclos de PM/DOT gana el vigente, no el viejo que una caída de
         Samsara dejó sin cerrar;
      4. la más vieja (created_at; empate -> id menor)."""
    live = r.source in SYSTEM_SOURCES and bool(r.source_active)
    seen = (datetime.max - r.source_seen_at
            if live and r.source_seen_at else _FAR)
    return (0 if live else 1, 0 if r.status == "open" else 1, seen,
            r.created_at or datetime.max, r.id)


def _duplicates(rows) -> dict[int, int]:
    """{id: id del que se queda} de los requests duplicados. Solo entre los
    ACCIONABLES (open/snoozed) de la misma unidad normalizada.
    Agrupa contra el KEEPER directamente (no en cadena): se recorren en
    orden de preferencia (_keeper_rank); cada request se suma al primer
    keeper con el que es duplicado y, si no matchea con ninguno, pasa a ser
    keeper de su propio grupo. Así un request combinado ('mirror and door
    handle') no arrastra a otro distinto ('door handle') al grupo del
    primero ('mirror'), y cada duplicado se parece de verdad a su keeper."""
    by_unit: dict[str, list[ServiceRequest]] = {}
    for r in rows:
        if r.status in _ACTIONABLE:
            by_unit.setdefault(_norm_unit(r.unit), []).append(r)
    out: dict[int, int] = {}
    for members in by_unit.values():
        if len(members) < 2:
            continue
        members = sorted(members, key=_keeper_rank)
        texts = [_dup_text(r) for r in members]
        toks = [set(t.split()) for t in texts]
        keepers: list[int] = []
        for i, r in enumerate(members):
            for k in keepers:
                if _is_dup(members[k], r, texts[k], texts[i],
                           toks[k], toks[i]):
                    out[r.id] = members[k].id
                    break
            else:
                keepers.append(i)
    return out


def _dup_map(session, unit: str = "") -> dict[int, int]:
    """_duplicates sobre los accionables de la org (o de una unidad,
    comparando con `_norm_unit` en Python — ver _unit_ids)."""
    rows = session.scalars(select(ServiceRequest).where(
        ServiceRequest.status.in_(_ACTIONABLE))).all()
    if unit:
        norm = _norm_unit(unit)
        rows = [r for r in rows if _norm_unit(r.unit) == norm]
    return _duplicates(rows)


_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _valid_date(value: str | None, field: str) -> str | None:
    """'' / None -> None; si no, exige YYYY-MM-DD (mensaje en inglés: UI).
    Formato ESTRICTO: desde Python 3.11 fromisoformat también acepta
    '20261001' o '2026-W40-1', y como las fechas se comparan como texto
    ('snooze_until <= hoy') un snooze así no vencería nunca."""
    v = (value or "").strip()
    if not v:
        return None
    if not _DATE_RE.fullmatch(v):
        raise ValueError(f"{field} must be YYYY-MM-DD")
    try:
        return date.fromisoformat(v).isoformat()
    except ValueError:
        raise ValueError(f"{field} must be YYYY-MM-DD")


def _meta(r: ServiceRequest) -> dict:
    try:
        m = json.loads(r.meta or "{}")
    except (TypeError, ValueError):
        return {}
    return m if isinstance(m, dict) else {}


# ----- Serialización ---------------------------------------------------------

def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _public_meta(r: ServiceRequest) -> dict:
    """meta sin las claves internas ('_pre_delete': estado previo al borrado,
    solo lo lee restore_requests)."""
    return {k: v for k, v in _meta(r).items() if not k.startswith("_")}


def _sr_dict(r: ServiceRequest, wo: WorkOrder | None = None,
             duplicate_of: int | None = None) -> dict:
    return {
        "id": r.id,
        "unit": r.unit,
        "company": r.company or "",
        "source": r.source,
        "source_key": r.source_key,
        "title": r.title,
        "detail": r.detail or "",
        "priority": r.priority,
        "status": r.status,
        "wo_id": r.wo_id,
        "wo_display_no": workorders._display_no(wo) if wo else None,
        "wo_status": wo.status if wo else None,
        "resolution": r.resolution or "",
        "meta": _public_meta(r),
        "source_active": bool(r.source_active),
        "snooze_until": r.snooze_until,
        "follow_up_date": r.follow_up_date,
        "deny_reason": r.deny_reason or "",
        "created_by": r.created_by or "",
        "created_at": _iso(r.created_at),
        "updated_at": _iso(r.updated_at),
        "resolved_at": _iso(r.resolved_at),
        "duplicate_of": duplicate_of,
    }


def _wo_map(session, rows: list[ServiceRequest]) -> dict[int, WorkOrder]:
    ids = {r.wo_id for r in rows if r.wo_id}
    if not ids:
        return {}
    wos = session.scalars(select(WorkOrder).where(WorkOrder.id.in_(ids)))
    return {w.id: w for w in wos}


def _dicts(session, rows: list[ServiceRequest],
           dups: dict[int, int] | None = None) -> list[dict]:
    wos = _wo_map(session, rows)
    dups = dups or {}
    return [_sr_dict(r, wos.get(r.wo_id), dups.get(r.id)) for r in rows]


def _one(session, r: ServiceRequest) -> dict:
    wo = session.get(WorkOrder, r.wo_id) if r.wo_id else None
    dup = (_dup_map(session, r.unit).get(r.id)
           if r.status in _ACTIONABLE else None)
    return _sr_dict(r, wo, dup)


# ----- Sync (materializa defectos + PM/DOT) ---------------------------------

def _spec_unit(unit: str, units: dict[str, str] | None) -> tuple[str, bool]:
    """(unidad a guardar, ¿es la canónica de la flota?). Fuera de la flota
    (o sin índice) queda como vino del feed/board."""
    canon = (units or {}).get(_norm_unit(unit))
    return (canon or unit)[:64], canon is not None


def _defect_specs(feed: dict | None,
                  units: dict[str, str] | None = None) -> dict[str, dict]:
    """key -> spec de los defectos del feed (re-reportes que normalizan igual
    se funden sumando `reports`)."""
    out: dict[str, dict] = {}
    for d in (feed or {}).get("defects") or []:
        unit = (d.get("unit") or "").strip()
        detail = (d.get("detail") or "").strip()
        if not unit or not detail:
            continue
        key = defect_key(unit, detail)
        reports = int(d.get("reports") or 1)
        if key in out:
            out[key]["meta"]["reports"] += reports
            continue
        name, canonical = _spec_unit(unit, units)
        out[key] = {
            "source": "defect", "unit": name, "canonical": canonical,
            "company": (d.get("company") or "")[:64],
            "title": detail[:160], "detail": detail,
            "priority": "normal", "overdue": False,
            "meta": {
                "dvir_type": d.get("dvir_type") or "",
                "reports": reports,
                "date_label": d.get("date_label") or "",
                "block_date": d.get("block_date") or "",
                "unit_kind": d.get("unit_kind") or "",
            },
        }
    return out


def _due_key(kind: str, unit: str, row: dict) -> str:
    """Clave del vencimiento: tipo + unidad NORMALIZADA + CICLO (últimas
    millas del PM / fecha de la última DOT). Registrar el servicio cambia el
    ciclo. La unidad va normalizada (como en defect_key): renombrar a la
    canónica o una variante de escritura no crea un request duplicado."""
    cycle = row.get("last_miles") if kind == "pm" else row.get("last_date")
    if cycle in (None, ""):
        cycle = "never"
    return f"{kind}:{_norm_unit(unit)}:{cycle}"[:120]


def _nodata_keys(kind: str, board: dict) -> set[str]:
    """Claves de las unidades del board SIN dato (to_due None: sin odómetro
    de Samsara, never). "Sin dato" no es "al día": un request de ESE ciclo no
    se auto-cierra (si el ciclo cambió, la clave es otra y sí se cierra)."""
    out: set[str] = set()
    for row in board.get("units") or []:
        unit = (row.get("unit") or "").strip()
        if unit and row.get("to_due") is None:
            out.add(_due_key(kind, unit, row))
    return out


def _due_specs(kind: str, board: dict, companies: dict[str, str],
               units: dict[str, str] | None = None) -> dict[str, dict]:
    """key -> spec de las unidades con PM/DOT vencido o por vencer."""
    out: dict[str, dict] = {}
    window = (board.get("upcoming_miles") if kind == "pm"
              else board.get("upcoming_days")) or 0
    for row in board.get("units") or []:
        unit = (row.get("unit") or "").strip()
        to_due = row.get("to_due")
        if not unit or to_due is None:          # never / no_meter: sin dato
            continue
        overdue = to_due < 0
        if not overdue and to_due > window:     # on_track
            continue
        last_miles = row.get("last_miles")
        last_date = row.get("last_date")
        key = _due_key(kind, unit, row)
        model = row.get("model") or ""
        if kind == "pm":
            nxt = row.get("next_due_miles")
            detail = maint.pm_label(model)
            if nxt is not None:
                detail += f" — next due at {nxt:,} mi"
            if last_miles is not None:
                detail += f" (last at {last_miles:,} mi"
                detail += f" on {last_date})" if last_date else ")"
            meta = {"kind": "miles", "to_due": to_due,
                    "next_due_miles": nxt}
        else:
            nxt = row.get("next_due_date")
            detail = maint.CAMPAIGNS["dot"]["label"]
            if nxt:
                detail += f" — due {nxt}"
            if last_date:
                detail += f" (last {last_date})"
            meta = {"kind": "days", "to_due": to_due,
                    "next_due_date": nxt}
        meta.update({
            "current_miles": row.get("current_miles"),
            "last_miles": last_miles, "last_date": last_date,
            "model": model, "overdue": overdue,
            # Escritura de la fila del BOARD ('CAN1' aunque la flota diga
            # 'CAN 1'): el registro del PM/DOT al facturar la WO va a ESTA
            # fila (maint.board cruza registros por nombre exacto). Ver
            # maint_unit_for_wo.
            "board_unit": unit,
        })
        name, canonical = _spec_unit(unit, units)
        out[key] = {
            "source": kind, "unit": name, "canonical": canonical,
            "company": companies.get(_norm_unit(unit), "")[:64],
            "title": _TITLES[kind], "detail": detail,
            "priority": (("urgent" if kind == "pm" else "emergency")
                         if overdue else "normal"),
            "overdue": overdue, "meta": meta,
        }
    return out


def _company_map(feed: dict | None) -> dict[str, str]:
    """unidad normalizada -> empresa, para los PM/DOT (el board no la trae):
    de los defectos del feed y de las unidades manuales (sin red)."""
    out: dict[str, str] = {}
    for d in (feed or {}).get("defects") or []:
        if d.get("unit") and d.get("company"):
            out.setdefault(_norm_unit(d["unit"]), d["company"])
    try:
        for mu in manual_units.list_units():
            if mu.get("unit") and mu.get("company"):
                out.setdefault(_norm_unit(mu["unit"]), mu["company"])
    except Exception:  # noqa: BLE001 — la empresa es cosmética, nunca rompe
        pass
    return out


def _guarded(session, r: ServiceRequest, allowed: tuple[str, ...],
             *where, **values) -> bool:
    """Transición de estado CONDICIONAL: UPDATE … WHERE id AND status IN
    allowed (+ `where`). El sync decide con lo que LEYÓ; si una persona
    cambió la fila en el medio (create_wo, deny… corren en otro thread) el
    WHERE no matchea y gana la persona (sin esto quedaba, p.ej., un request
    'cleared' todavía ligado a una WO viva). Por id: la fila ya salió de un
    SELECT acotado al tenant."""
    res = session.execute(
        update(ServiceRequest)
        .where(ServiceRequest.id == r.id,
               ServiceRequest.status.in_(allowed), *where)
        .values(**values)
        .execution_options(synchronize_session=False))
    return bool(res.rowcount)


def _apply_sync(desired: dict[str, dict], handled: set[str],
                keep: set[str] | frozenset = frozenset(),
                units: dict[str, str] | None = None) -> dict | None:
    """Aplica el estado deseado a la tabla (una transacción). `handled` = las
    fuentes cuyo feed fue EXITOSO: solo esas se pueden dar por resueltas
    ('cleared') cuando un request deja de aparecer. `keep` = claves SIN dato
    en este sync (no se cierran). `units` = índice de la flota: las filas
    vivas con otra escritura de una unidad de la flota pasan a la canónica.
    None si otro proceso/thread insertó la misma clave en paralelo (el
    próximo sync lo arregla)."""
    now = datetime.now()
    today = date.today().isoformat()
    created = resolved = reopened = 0
    with SessionLocal() as session:
        # TODO lo que escribe va dentro del try: los INSERT se mandan antes
        # del commit (flush explícito / autoflush de las queries), y ahí es
        # donde salta la clave duplicada de un insert concurrente.
        try:
            existing = session.scalars(
                select(ServiceRequest).where(
                    ServiceRequest.source.in_(SYSTEM_SOURCES),
                    or_(ServiceRequest.source_active.is_(True),
                        ServiceRequest.source_key.in_(list(desired))))).all()
            by_key = {r.source_key: r for r in existing}

            for key, spec in desired.items():
                r = by_key.get(key)
                # Defecto RE-REPORTADO: la clave de un defecto no lleva ciclo
                # (unidad + texto), así que si una persona ya lo cerró (WO
                # completada, denegado o BORRADO) y el defecto había
                # DESAPARECIDO de un feed exitoso (resuelto en el ELD), que
                # vuelva a aparecer es una ocurrencia NUEVA. Sin esto quedaría
                # oculto para siempre. La fila vieja se archiva (clave
                # '<key>#<id>', estado y WO intactos) y el defecto entra como
                # request nuevo. Mientras la fuente siga ACTIVA, un borrado
                # (o denegado) queda como está: el sync nunca lo revive.
                if (r is not None and spec["source"] == "defect"
                        and not r.source_active
                        and (r.status in ("denied", DELETED)
                             or (r.status == "done"
                                 and r.resolution == "wo"))):
                    r.source_key = f"{key}#{r.id}"[:120]
                    session.flush()     # libera la clave antes del INSERT
                    r = None
                if r is None:
                    session.add(ServiceRequest(
                        unit=spec["unit"], company=spec["company"],
                        source=spec["source"], source_key=key,
                        title=spec["title"], detail=spec["detail"],
                        priority=spec["priority"], status="open",
                        resolution="", meta=json.dumps(spec["meta"]),
                        source_active=True, deny_reason="", created_by="",
                        created_at=now, updated_at=now, source_seen_at=now))
                    created += 1
                    continue
                # Las claves internas ('_pre_delete' de un borrado) no son
                # de la fuente: se conservan al refrescar el meta.
                keep_meta = {k: v for k, v in _meta(r).items()
                             if k.startswith("_")}
                r.meta = json.dumps({**spec["meta"], **keep_meta})
                r.source_active = True
                r.source_seen_at = now
                if not r.company and spec["company"]:
                    r.company = spec["company"]
                # Misma clave (unidad normalizada) con otra escritura: pasa
                # al nombre canónico de la flota (no crea otra fila).
                if spec.get("canonical") and r.unit != spec["unit"]:
                    r.unit = spec["unit"]
                status = r.status
                # La fuente volvió a aparecer tras un auto-cierre ('cleared':
                # lo decidió el sistema, no una persona) -> vuelve al backlog.
                # Si estaba pospuesto y el snooze sigue vigente, vuelve
                # POSPUESTO (una caída de Samsara no le borra el snooze).
                if status == "done" and r.resolution == "cleared":
                    back = (r.snooze_until
                            if r.snooze_until and r.snooze_until > today
                            else None)
                    nxt = "snoozed" if back else "open"
                    if _guarded(session, r, ("done",),
                                ServiceRequest.resolution == "cleared",
                                status=nxt, resolution="", resolved_at=None,
                                snooze_until=back, updated_at=now):
                        status = nxt
                        if nxt == "open":
                            reopened += 1
                # PM/DOT que pasó a vencido: sube a la prioridad de vencido.
                if (spec["overdue"] and status in _ACTIONABLE
                        and _PRIO_RANK.get(spec["priority"], 1)
                        > _PRIO_RANK.get(r.priority, 1)):
                    r.priority = spec["priority"]
                    r.updated_at = now

            # Fuentes que desaparecieron de un feed exitoso. El snooze se
            # CONSERVA: si la fuente vuelve, el request vuelve pospuesto.
            for r in existing:
                if (r.source in handled and r.source_active
                        and r.source_key not in desired
                        and r.source_key not in keep):
                    r.source_active = False
                    if (r.status in _ACTIONABLE and _guarded(
                            session, r, _ACTIONABLE, status="done",
                            resolution="cleared", resolved_at=now,
                            updated_at=now)):
                        resolved += 1

            # Snoozes vencidos (cualquier fuente, incluidos los manuales).
            for r in session.scalars(select(ServiceRequest).where(
                    ServiceRequest.status == "snoozed",
                    ServiceRequest.snooze_until <= today)).all():
                if _guarded(session, r, ("snoozed",),
                            ServiceRequest.snooze_until == r.snooze_until,
                            status="open", snooze_until=None,
                            updated_at=now):
                    reopened += 1

            # Filas VIVAS (cualquier fuente, incluidos los manuales viejos)
            # con otra escritura de una unidad de la flota -> la canónica,
            # para que 'MEM77' y 'MEM 77' no queden como dos unidades.
            if units:
                for r in session.scalars(select(ServiceRequest).where(
                        ServiceRequest.status.in_(
                            (*_ACTIONABLE, "on_wo")))).all():
                    canon = units.get(_norm_unit(r.unit))
                    if canon and r.unit != canon:
                        r.unit = canon

            session.commit()
        except IntegrityError:
            session.rollback()
            log.warning("service_requests.sync: concurrent insert, skipped")
            return None
    return {"created": created, "resolved": resolved, "reopened": reopened}


async def sync(force: bool = False) -> dict:
    """Materializa las fuentes de sistema en service_request. Idempotente.
    Sin `force`, respeta un TTL de 5 min por org (lo llama cada GET de la
    lista). Devuelve {created, resolved, reopened, synced_at}."""
    org = tenant.get_current_org()
    async with _lock():
        hit = _last_sync.get(org)
        if (not force and hit is not None
                and time.monotonic() - hit[0] < SYNC_TTL_S):
            return {"created": 0, "resolved": 0, "reopened": 0,
                    "synced_at": hit[1]}

        desired: dict[str, dict] = {}
        handled: set[str] = set()
        keep: set[str] = set()
        # Índice de la flota: UNA vez por sync (lo usan todas las fuentes) y
        # queda cacheado para create_manual / defect_to_wo / el resumen.
        units = await _build_unit_index()
        _unit_index_cache[org] = (time.monotonic(), units)
        # Unidades que traen las fuentes (todas, vencidas o no): completan
        # la validación de create_manual (_known_unit).
        src_units: dict[str, str] = {}

        def _collect(rows) -> None:
            for x in rows or []:
                name = str(x.get("unit") or "").strip()[:64]
                if name:
                    src_units.setdefault(_norm_unit(name), name)

        feed: dict | None = None
        try:
            feed = await open_defects.current_feed()
        except Exception as exc:  # noqa: BLE001 — sin feed, sin defectos
            log.warning("service_requests.sync: defect feed failed: %s", exc)
        if feed is not None:
            _collect(feed.get("defects"))
            desired.update(_defect_specs(feed, units))
            # Solo un feed EXITOSO puede dar defectos por resueltos.
            if feed.get("available") and not feed.get("error"):
                handled.add("defect")
        companies = _company_map(feed)
        for kind in ("pm", "dot"):
            try:
                board = await maint.board(kind)
            except Exception as exc:  # noqa: BLE001 — se salta esa fuente
                log.warning("service_requests.sync: %s board failed: %s",
                            kind, exc)
                continue
            _collect(board.get("units"))
            desired.update(_due_specs(kind, board, companies, units))
            keep |= _nodata_keys(kind, board)
            # maint.board NO levanta si Samsara falla (odómetros / fleet):
            # devuelve el board igual y lo avisa en `errors`. Sin odómetro
            # el to_due sale None o con millas viejas del CSV, así que ese
            # board no sirve para dar nada por resuelto (igual que un feed
            # de defectos con error).
            if board.get("errors"):
                log.warning("service_requests.sync: %s board incomplete "
                            "(%s), not clearing", kind,
                            ", ".join(board["errors"]))
                continue
            handled.add(kind)

        if src_units:
            _source_units_cache[org] = src_units
        stats = _apply_sync(desired, handled, keep, units)
        synced_at = datetime.now().isoformat(timespec="seconds")
        if stats is None:
            return {"created": 0, "resolved": 0, "reopened": 0,
                    "synced_at": hit[1] if hit else None}
        _last_sync[org] = (time.monotonic(), synced_at)
        return {**stats, "synced_at": synced_at}


async def sync_quietly() -> None:
    """sync() con TTL que NUNCA rompe al caller: la lista de requests se
    sirve igual con lo que ya hay en la tabla aunque Samsara/PM fallen."""
    try:
        await sync()
    except Exception as exc:  # noqa: BLE001 — log & continue (GET de la lista)
        log.warning("service_requests.sync failed: %s", exc)


def reset_sync_cache() -> None:
    """Olvida el TTL y el índice de unidades (tests / cambios de config)."""
    _last_sync.clear()
    _unit_index_cache.clear()
    _source_units_cache.clear()


def mark_stale() -> None:
    """Olvida el TTL del org actual. Lo llaman los cambios de PM/DOT
    (registro, override de millas, exclusión): sin esto el 'PM due' ya
    registrado seguía abierto hasta 5 min, invitando a una WO duplicada.
    El próximo GET de la lista re-sincroniza."""
    _last_sync.pop(tenant.get_current_org(), None)


# ----- Lectura ---------------------------------------------------------------

def list_requests(status: str = "open", unit: str = "",
                  source: str = "") -> dict:
    """Lista + conteos + resumen por unidad.

    - `requests`: filtrados por status (open|snoozed|on_wo|done|denied|all),
      unit (normalizada: 'mem 77' == 'MEM77') y source. Cada uno trae
      `duplicate_of` (id del que se queda, o None).
    - `counts`: por status, respetando unit/source (no el status).
    - `units`: resumen de los requests OPEN de TODAS las unidades (respeta
      source, ignora unit/status: la lista de la izquierda no se achica al
      elegir una unidad), agrupado por unidad normalizada con el nombre
      canónico. Orden: emergency > urgent > normal > low y después el peor
      vencido (millas de PM pasadas, positivo). `duplicates` = requests
      accionables de la unidad con duplicate_of (todas las fuentes: es lo
      que borra delete_duplicates(unit)).
    - `truncated`: True si el historial (done / denied / all) pasó el tope
      de HISTORY_LIMIT y se devuelven solo los más recientes. Los estados
      accionables (open / snoozed / on_wo) van SIEMPRE completos: con un
      tope por updated_at los vencidos viejos (los más urgentes) eran los
      primeros en desaparecer de la página.
    Los borrados ('deleted') no salen en nada: ni en `all`, ni en conteos,
    ni en `units`."""
    status = (status or "open").strip()
    unit = (unit or "").strip()
    source = (source or "").strip()
    if status != "all" and status not in STATUSES:
        raise ValueError(
            "status must be one of: " + ", ".join(STATUSES) + ", all")
    if source and source not in SOURCES:
        raise ValueError("source must be one of: " + ", ".join(SOURCES))

    with SessionLocal() as session:
        # ?unit= normalizado en Python (_unit_ids): los ids de esa unidad.
        unit_ids = (_unit_ids(session, unit,
                              *([ServiceRequest.source == source]
                                if source else []))
                    if unit else None)

        def _filtered(q):
            q = q.where(ServiceRequest.status != DELETED)
            if source:
                q = q.where(ServiceRequest.source == source)
            if unit_ids is not None:
                q = q.where(ServiceRequest.id.in_(unit_ids))
            return q

        cq = _filtered(select(ServiceRequest.status,
                              func.count(ServiceRequest.id)))
        by_status = dict(session.execute(
            cq.group_by(ServiceRequest.status)).all())
        counts = {s: int(by_status.get(s, 0)) for s in STATUSES}

        q = _filtered(select(ServiceRequest))
        if status != "all":
            q = q.where(ServiceRequest.status == status)
        q = q.order_by(ServiceRequest.updated_at.desc(),
                       ServiceRequest.id.desc())
        actionable = status in ("open", "snoozed", "on_wo")
        if not actionable:
            q = q.limit(HISTORY_LIMIT + 1)
        rows = list(session.scalars(q).all())
        truncated = len(rows) > HISTORY_LIMIT and not actionable
        if truncated:
            rows = rows[:HISTORY_LIMIT]
        if actionable:
            rows.sort(key=lambda r: (-_PRIO_RANK.get(r.priority, 1),
                                     r.unit, SOURCES.index(r.source)
                                     if r.source in SOURCES else 9, r.id))

        # Duplicados entre TODOS los accionables de la org (sin los filtros
        # de la lista: el keeper de un request no cambia según el filtro).
        live = session.scalars(select(ServiceRequest).where(
            ServiceRequest.status.in_(_ACTIONABLE))).all()
        dups = _duplicates(live)
        requests = _dicts(session, rows, dups)

        by_id = {r.id: r for r in live}
        dup_counts: dict[str, int] = {}
        for rid in dups:
            k = _norm_unit(by_id[rid].unit)
            dup_counts[k] = dup_counts.get(k, 0) + 1
        open_rows = [r for r in live if r.status == "open"
                     and (not source or r.source == source)]
        units = _unit_summaries(open_rows, dup_counts, _cached_names())

    hit = _last_sync.get(tenant.get_current_org())
    return {"requests": requests, "counts": counts, "units": units,
            "synced_at": hit[1] if hit else None, "truncated": truncated}


def _unit_summaries(rows, dup_counts: dict[str, int] | None = None,
                    names: dict[str, str] | None = None) -> list[dict]:
    """Resumen por unidad NORMALIZADA ('MEM77' y 'MEM 77' = una fila). El
    nombre es el canónico de la flota (`names`, índice del último sync) o,
    si la unidad no está en la flota, la escritura más usada (empate: la del
    request más reciente)."""
    dup_counts = dup_counts or {}
    names = names or {}
    agg: dict[str, dict] = {}
    spellings: dict[str, dict[str, tuple[int, datetime]]] = {}
    for r in rows:
        k = _norm_unit(r.unit)
        u = agg.get(k)
        if u is None:
            u = agg[k] = {
                "unit": r.unit, "company": r.company or "", "model": "",
                "open": 0, "by_source": {s: 0 for s in SOURCES},
                "top_priority": r.priority if r.priority in _PRIO_RANK
                else "normal",
                "worst_overdue_miles": None,
                "duplicates": dup_counts.get(k, 0),
            }
        seen = spellings.setdefault(k, {})
        n, last = seen.get(r.unit, (0, datetime.min))
        seen[r.unit] = (n + 1, max(last, r.updated_at or datetime.min))
        u["open"] += 1
        if r.source in u["by_source"]:
            u["by_source"][r.source] += 1
        if _PRIO_RANK.get(r.priority, 1) > _PRIO_RANK[u["top_priority"]]:
            u["top_priority"] = r.priority
        if not u["company"] and r.company:
            u["company"] = r.company
        m = _meta(r)
        if not u["model"] and m.get("model"):
            u["model"] = m["model"]
        to_due = m.get("to_due")
        if (r.source == "pm" and isinstance(to_due, (int, float))
                and to_due < 0):
            over = int(-to_due)
            if u["worst_overdue_miles"] is None \
                    or over > u["worst_overdue_miles"]:
                u["worst_overdue_miles"] = over
    for k, u in agg.items():
        u["unit"] = names.get(k) or max(
            spellings[k].items(), key=lambda kv: (kv[1], kv[0]))[0]
    return sorted(agg.values(), key=lambda u: (
        -_PRIO_RANK[u["top_priority"]], -(u["worst_overdue_miles"] or 0),
        u["unit"]))


def get_request(req_id: int) -> dict | None:
    with SessionLocal() as session:
        r = session.get(ServiceRequest, req_id)
        return None if r is None else _one(session, r)


def for_wo(session, wo_id: int) -> list[dict]:
    """Requests ligados a una WO (resumen para el drawer de la WO). Los
    borrados no se listan."""
    rows = session.scalars(
        select(ServiceRequest).where(ServiceRequest.wo_id == wo_id,
                                     ServiceRequest.status != DELETED)
        .order_by(ServiceRequest.id)).all()
    return [{"id": r.id, "source": r.source, "title": r.title,
             "status": r.status, "priority": r.priority} for r in rows]


# ----- Escritura -------------------------------------------------------------

def create_manual(unit: str, title: str, detail: str = "",
                  priority: str = "normal", follow_up_date: str | None = None,
                  company: str = "", created_by: str = "",
                  units: dict[str, str] | None = None) -> dict:
    """Pedido manual (el '+ Add Service' de la unidad). `units` = índice de
    la flota (unit_index(), lo arma la ruta): la unidad se guarda con su
    nombre canónico y, si el índice tiene datos y la unidad no está, se
    rechaza — salvo que la app ya la muestre fuera de la flota (requests
    del backlog o unidades de las fuentes del último sync: _known_unit;
    p.ej. un defecto del CSV de MCC o un camión solo del CSV de PM). Sin
    índice (None / vacío: flota no disponible) se acepta como vino."""
    unit = (unit or "").strip()
    title = (title or "").strip()
    if not unit or not title:
        raise ValueError("unit and title are required")
    priority = (priority or "normal").strip()
    if priority not in PRIORITIES:
        raise ValueError("priority must be one of: " + ", ".join(PRIORITIES))
    follow = _valid_date(follow_up_date, "follow_up_date")
    now = datetime.now()
    with SessionLocal() as session:
        norm = _norm_unit(unit)
        if units and norm not in units:
            known = _known_unit(session, norm)
            if known:
                units = {**units, norm: known}
        unit = _canonical_unit(unit, units)
        r = ServiceRequest(
            unit=unit[:64], company=(company or "").strip()[:64],
            source="manual", source_key="manual:" + uuid.uuid4().hex,
            title=title[:160], detail=(detail or "").strip(),
            priority=priority, status="open", resolution="", meta="{}",
            source_active=True, follow_up_date=follow, deny_reason="",
            created_by=(created_by or "").strip()[:80],
            created_at=now, updated_at=now)
        session.add(r)
        session.commit()
        return _one(session, r)


def update_request(req_id: int, fields: dict) -> dict | None:
    """Edita title / detail / priority / follow_up_date."""
    with SessionLocal() as session:
        r = session.get(ServiceRequest, req_id)
        if r is None:
            return None
        if "title" in fields:
            title = str(fields["title"] or "").strip()
            if not title:
                raise ValueError("title is required")
            r.title = title[:160]
        if "detail" in fields:
            r.detail = str(fields["detail"] or "").strip()
        if "priority" in fields:
            p = str(fields["priority"] or "").strip()
            if p not in PRIORITIES:
                raise ValueError(
                    "priority must be one of: " + ", ".join(PRIORITIES))
            r.priority = p
        if "follow_up_date" in fields:
            r.follow_up_date = _valid_date(fields["follow_up_date"],
                                           "follow_up_date")
        r.updated_at = datetime.now()
        session.commit()
        return _one(session, r)


def deny(req_id: int, reason: str = "") -> dict | None:
    """Descarta el request (no se va a hacer). Solo desde open/snoozed."""
    with SessionLocal() as session:
        r = session.get(ServiceRequest, req_id)
        if r is None:
            return None
        if r.status not in _ACTIONABLE:
            raise ValueError("only open or snoozed requests can be denied")
        now = datetime.now()
        r.status = "denied"
        r.resolution = "denied"
        r.deny_reason = (reason or "").strip()[:200]
        r.snooze_until = None
        r.resolved_at = now
        r.updated_at = now
        session.commit()
        return _one(session, r)


def snooze(req_id: int, until: str) -> dict | None:
    """Pospone el request hasta `until` (fecha futura). Solo desde open."""
    day = _valid_date(until, "snooze date")
    if day is None:
        raise ValueError("snooze date is required")
    if date.fromisoformat(day) <= date.today():
        raise ValueError("snooze date must be in the future")
    with SessionLocal() as session:
        r = session.get(ServiceRequest, req_id)
        if r is None:
            return None
        if r.status != "open":
            raise ValueError("only open requests can be snoozed")
        r.status = "snoozed"
        r.snooze_until = day
        r.updated_at = datetime.now()
        session.commit()
        return _one(session, r)


def reopen(req_id: int) -> dict | None:
    """Devuelve al backlog un request denegado, pospuesto o auto-cerrado
    ('cleared'). Uno cerrado por su WO no se re-abre acá (se retrocede la WO)."""
    with SessionLocal() as session:
        r = session.get(ServiceRequest, req_id)
        if r is None:
            return None
        if r.status == "on_wo":
            raise ValueError(
                "request is on a work order; unlink it first")
        if r.status == DELETED:
            raise ValueError("request was deleted; restore it instead")
        if r.status == "done" and r.resolution != "cleared":
            raise ValueError(
                "request was completed by a work order and can't be reopened")
        if r.status == "open":
            raise ValueError("request is already open")
        r.status = "open"
        r.resolution = ""
        r.resolved_at = None
        r.snooze_until = None
        r.deny_reason = ""
        # Un request en el backlog no apunta a ninguna WO (red de seguridad
        # por si quedó un wo_id viejo de una carrera con el sync).
        r.wo_id = None
        r.updated_at = datetime.now()
        session.commit()
        return _one(session, r)


def _bullet(r: ServiceRequest) -> str:
    label = _LABELS.get(r.source, "Request")
    return f"• [{label}] {(r.detail or '').strip() or r.title}"


def _create_wo_from(session, rows: list[ServiceRequest], title: str = "",
                    mechanic: str = "", priority: str = "") -> WorkOrder:
    """Crea la WO de `rows` y los liga, DENTRO de `session` (sin commit)."""
    if not rows:
        raise ValueError("select at least one request")
    for r in rows:
        if r.status not in _ACTIONABLE:
            raise ValueError(f"request {r.id} is not open")
    if len({_norm_unit(r.unit) for r in rows}) > 1:
        raise ValueError("requests must belong to the same unit")

    title = (title or "").strip()
    if not title:
        title = (rows[0].title[:140] if len(rows) == 1 else
                 f"{rows[0].title[:110]} (+{len(rows) - 1} more)")
    priority = (priority or "").strip()
    if priority in _WO_PRIORITY:                # prioridad de request
        priority = _WO_PRIORITY[priority]
    if priority not in workorders.PRIORITIES:   # vacía / inválida: la peor
        worst = max(rows, key=lambda r: _PRIO_RANK.get(r.priority, 1))
        priority = _WO_PRIORITY.get(worst.priority, "normal")
    sources = {r.source for r in rows}
    campaign = "pm" if "pm" in sources else ("dot" if "dot" in sources
                                              else "")
    mileage = None
    for r in rows:
        if r.source == "pm" and _meta(r).get("current_miles") is not None:
            mileage = _meta(r)["current_miles"]
            break
    company = next((r.company for r in rows if r.company), "")

    wo = workorders.create_wo_in(
        session, rows[0].unit, title,
        complaint="\n".join(_bullet(r) for r in rows),
        company=company, mechanic=mechanic, priority=priority,
        source="request", mileage=mileage, campaign=campaign)
    now = datetime.now()
    for r in rows:
        r.status = "on_wo"
        r.wo_id = wo.id
        r.resolution = ""
        r.resolved_at = None
        r.snooze_until = None
        r.updated_at = now
    return wo


def _commit_wo(session) -> None:
    """Commit de la WO + requests. El mecánico (si vino uno) entra al roster
    de técnicos DESPUÉS, en el caller (workorders.ensure_technician):
    technicians escribe org_setting en su propia transacción y en SQLite no
    puede hacerlo mientras esta sesión tenga escrituras a medias
    (defect_to_wo flushea el archivado del request viejo antes de crear la
    WO) -> "database is locked"."""
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise ValueError(
            "work order number collision (concurrent create), retry")


def create_wo(ids: list[int], title: str = "", mechanic: str = "",
              priority: str = "", created_by: str = "") -> dict:
    """UNA WO nueva con los requests `ids` (misma unidad, open/snoozed). Todo
    en una transacción: si algo falla no queda ni la WO ni ningún vínculo.
    `created_by` se acepta por simetría con la API (WorkOrder no tiene columna
    de autor todavía)."""
    ids = list(dict.fromkeys(int(i) for i in (ids or [])))
    if not ids:
        raise ValueError("select at least one request")
    with SessionLocal() as session:
        found = {r.id: r for r in session.scalars(
            select(ServiceRequest).where(ServiceRequest.id.in_(ids))).all()}
        missing = [i for i in ids if i not in found]
        if missing:
            raise ValueError(f"request {missing[0]} not found")
        rows = [found[i] for i in ids]
        wo = _create_wo_from(session, rows, title, mechanic, priority)
        wo_id = wo.id
        _commit_wo(session)
        workorders.ensure_technician(mechanic)      # tras el commit (v2.21)
        out_rows = _dicts(session, rows)
    return {"workorder": workorders.get_wo(wo_id), "requests": out_rows}


def add_to_wo(req_id: int, wo_id: int) -> dict | None:
    """Suma el request a una WO existente (misma unidad, no cerrada): agrega
    la línea al complaint y liga el request. Una transacción."""
    with SessionLocal() as session:
        r = session.get(ServiceRequest, req_id)
        if r is None:
            return None
        if r.status not in _ACTIONABLE:
            raise ValueError(f"request {r.id} is not open")
        wo = session.get(WorkOrder, wo_id)
        if wo is None:
            raise ValueError("work order not found")
        if _norm_unit(wo.unit) != _norm_unit(r.unit):
            raise ValueError("work order belongs to another unit")
        if wo.status in _CLOSED_WO:
            raise ValueError("work order is already completed")
        line = _bullet(r)
        wo.complaint = (f"{wo.complaint.rstrip()}\n{line}"
                        if (wo.complaint or "").strip() else line)
        if not wo.campaign and r.source in ("pm", "dot"):
            wo.campaign = r.source
            if r.source == "pm":
                wo.is_pm = True
        # PM sin millaje en la WO: el odómetro del request alimenta el
        # registro del PM al facturar (si no, el tracker queda sin millas).
        if r.source == "pm" and wo.mileage is None:
            cur = _meta(r).get("current_miles")
            if cur is not None:
                wo.mileage = int(cur)
        now = datetime.now()
        wo.updated_at = now
        r.status = "on_wo"
        r.wo_id = wo.id
        r.resolution = ""
        r.resolved_at = None
        r.snooze_until = None
        r.updated_at = now
        session.commit()
        req = _one(session, r)
    return {"workorder": workorders.get_wo(wo_id), "request": req}


def unlink(req_id: int) -> dict | None:
    """Saca el request de su WO (vuelve a open). No edita el texto de la WO."""
    with SessionLocal() as session:
        r = session.get(ServiceRequest, req_id)
        if r is None:
            return None
        if r.status != "on_wo":
            raise ValueError("request is not on a work order")
        r.status = "open"
        r.wo_id = None
        # El sync re-evalúa la fuente (si ya no está, se auto-cierra).
        r.source_active = True
        r.updated_at = datetime.now()
        session.commit()
        return _one(session, r)


def defect_to_wo(unit: str, detail: str, dvir_type: str = "",
                 company: str = "", mechanic: str = "",
                 units: dict[str, str] | None = None) -> dict:
    """'Create WO' desde un defecto abierto (UnitDrawer): asegura el request
    del defecto (misma clave que el sync; lo crea si falta) y le crea la WO,
    todo en una transacción — así ese camino también queda ligado. `units`
    = defect_unit_index() (flota + unidades del feed): canoniza la unidad y
    rechaza una desconocida, igual que create_manual."""
    unit = (unit or "").strip()
    detail = (detail or "").strip()
    if not unit or not detail:
        raise ValueError("unit and detail are required")
    unit = _canonical_unit(unit, units)
    key = defect_key(unit, detail)
    now = datetime.now()

    def _new_row() -> ServiceRequest:
        return ServiceRequest(
            unit=unit[:64], company=(company or "").strip()[:64],
            source="defect", source_key=key, title=detail[:160],
            detail=detail, priority="normal", status="open",
            resolution="", source_active=True, deny_reason="",
            created_by="", created_at=now, updated_at=now,
            source_seen_at=now,
            meta=json.dumps({
                "dvir_type": dvir_type or "", "reports": 1,
                "date_label": f"{now.month}.{now.day}"}))

    with SessionLocal() as session:
        r = session.scalars(select(ServiceRequest).where(
            ServiceRequest.source_key == key)).first()
        if r is not None and r.status == "on_wo":
            wo = session.get(WorkOrder, r.wo_id) if r.wo_id else None
            no = workorders._display_no(wo) if wo else str(r.wo_id)
            raise ValueError(f"this defect is already on work order #{no}")
        try:
            if r is None:
                r = _new_row()
                session.add(r)
            elif ((r.status == "done" and r.resolution == "wo")
                  or (r.status == DELETED and r.wo_id)):
                # Ya lo cerró una WO (completada; o se cerró por WO y después
                # se borró) y el defecto sigue en el ELD: es una ocurrencia
                # NUEVA. Misma regla que el sync: la fila vieja se archiva
                # ('<key>#<id>', estado y WO intactos) para que la WO cerrada
                # conserve su vínculo e historial, y entra un request nuevo
                # con la clave original.
                r.source_key = f"{key}#{r.id}"[:120]
                session.flush()         # libera la clave antes del INSERT
                r = _new_row()
                session.add(r)
            elif r.status in ("done", "denied", DELETED):
                # Auto-cerrado ('cleared'), denegado o borrado: no hay WO que
                # pierda el vínculo. El usuario pide la WO explícitamente y
                # el defecto sigue abierto en el ELD -> se reusa la fila.
                r.status = "open"
                r.resolution = ""
                r.resolved_at = None
                r.deny_reason = ""
            if units and r.unit != unit:     # misma clave, otra escritura
                r.unit = unit
            wo = _create_wo_from(session, [r], mechanic=mechanic)
        except IntegrityError:
            session.rollback()
            raise ValueError("this defect was just added, retry")
        wo_id = wo.id
        _commit_wo(session)
        workorders.ensure_technician(mechanic)      # tras el commit (v2.21)
        req = _one(session, r)
    return {"workorder": workorders.get_wo(wo_id), "request": req}


# ----- Borrado suave + restore (v2.20 addendum) ------------------------------

def _clean_ids(ids) -> list[int]:
    return list(dict.fromkeys(int(i) for i in (ids or [])))


def _pre_delete(r: ServiceRequest) -> dict:
    """Estado de la fila ANTES del borrado (va en meta['_pre_delete']): el
    Undo lo devuelve tal cual estaba — un pospuesto vuelve pospuesto, un
    denegado con su motivo, uno cerrado por su WO cerrado y ligado."""
    return {"status": r.status, "resolution": r.resolution or "",
            "resolved_at": _iso(r.resolved_at),
            "snooze_until": r.snooze_until,
            "deny_reason": r.deny_reason or ""}


def _restored_state(session, r: ServiceRequest, today: str) -> dict:
    """Valores con los que vuelve un borrado (restore_requests). Lo que ya
    no aplica cae al backlog: un snooze vencido -> open; cerrado por una WO
    que ya no existe -> open sin WO; si la WO volvió atrás (abierta) ->
    on_wo. Sin estado guardado -> open."""
    pre = _meta(r).get("_pre_delete") or {}
    status = pre.get("status")
    resolved = None
    if pre.get("resolved_at"):
        try:
            resolved = datetime.fromisoformat(pre["resolved_at"])
        except (TypeError, ValueError):
            resolved = None
    out = {"status": "open", "resolution": "", "resolved_at": None,
           "snooze_until": None, "wo_id": None, "deny_reason": ""}
    if status == "snoozed":
        until = pre.get("snooze_until")
        if until and until > today:
            out.update(status="snoozed", snooze_until=until)
    elif status == "denied":
        out.update(status="denied", resolution="denied",
                   resolved_at=resolved or datetime.now(),
                   deny_reason=pre.get("deny_reason") or r.deny_reason or "")
    elif status == "done" and pre.get("resolution") == "wo":
        wo = session.get(WorkOrder, r.wo_id) if r.wo_id else None
        if wo is not None and wo.status in _CLOSED_WO:
            out.update(status="done", resolution="wo", wo_id=wo.id,
                       resolved_at=resolved or datetime.now())
        elif wo is not None:
            out.update(status="on_wo", wo_id=wo.id)
    elif status == "done" and pre.get("resolution") == "cleared":
        # Auto-cerrado: vuelve cerrado; si la fuente sigue (o vuelve) el
        # sync lo re-abre como a cualquier 'cleared'.
        out.update(status="done", resolution="cleared",
                   resolved_at=resolved or datetime.now())
    return out


def _delete_in(session, ids: list[int]) -> dict:
    """Borra (suave) `ids` DENTRO de `session` (sin commit). Cualquier
    estado menos on_wo (se saltea con el motivo); los ya borrados se ignoran
    en silencio; los que no existen se saltean ('not found'). UPDATE
    condicional: si otra persona lo cambió en el medio (p.ej. lo mandó a una
    WO) gana esa persona."""
    deleted: list[int] = []
    skipped: list[dict] = []
    if not ids:
        return {"deleted": deleted, "skipped": skipped}
    found = {r.id: r for r in session.scalars(
        select(ServiceRequest).where(ServiceRequest.id.in_(ids))).all()}
    wos = _wo_map(session, [r for r in found.values()
                            if r.status == "on_wo"])
    now = datetime.now()
    for i in ids:
        r = found.get(i)
        if r is None:
            skipped.append({"id": i, "reason": "not found"})
        elif r.status == DELETED:
            continue
        elif r.status == "on_wo":
            wo = wos.get(r.wo_id)
            no = workorders._display_no(wo) if wo else str(r.wo_id or "")
            skipped.append({"id": i, "reason":
                            f"on work order #{no} — unlink it first"})
        elif _guarded(session, r, _DELETABLE,
                      ServiceRequest.status == r.status,
                      status=DELETED, resolution=DELETED, resolved_at=now,
                      snooze_until=None, updated_at=now,
                      meta=json.dumps({**_meta(r),
                                       "_pre_delete": _pre_delete(r)})):
            deleted.append(i)
        else:
            skipped.append({"id": i, "reason":
                            "request changed while deleting — retry"})
    return {"deleted": deleted, "skipped": skipped}


def delete_requests(ids: list[int]) -> dict:
    """Borrado suave de varios requests (una transacción). Devuelve
    {deleted: [ids], skipped: [{id, reason}]}. Se deshace con
    restore_requests (el 'Undo' del toast)."""
    ids = _clean_ids(ids)
    with SessionLocal() as session:
        out = _delete_in(session, ids)
        session.commit()
    return out


def restore_requests(ids: list[int]) -> dict:
    """Undo del borrado: la fila vuelve al estado que tenía ANTES de borrarse
    (meta['_pre_delete']): open -> open, snoozed -> snoozed (si el snooze
    sigue vigente; si no, open), denied -> denied con su motivo, done por
    WO -> done ligado a su WO (on_wo si la WO volvió atrás; open si la WO ya
    no existe), cleared -> cleared. Sin estado guardado -> open. Así un Undo
    nunca convierte trabajo ya hecho en backlog pendiente (reopen() tampoco
    lo permite). Lo que no está borrado se ignora. La fuente se marca activa
    para que el sync la re-evalúe (si ya no está, se auto-cierra)."""
    ids = _clean_ids(ids)
    restored: list[int] = []
    if not ids:
        return {"restored": restored}
    with SessionLocal() as session:
        found = {r.id: r for r in session.scalars(
            select(ServiceRequest).where(ServiceRequest.id.in_(ids),
                                         ServiceRequest.status == DELETED))}
        now = datetime.now()
        today = date.today().isoformat()
        for i in ids:
            r = found.get(i)
            if r is None:
                continue
            meta = {k: v for k, v in _meta(r).items() if k != "_pre_delete"}
            if _guarded(session, r, (DELETED,),
                        **_restored_state(session, r, today),
                        meta=json.dumps(meta), source_active=True,
                        updated_at=now):
                restored.append(i)
        session.commit()
    return {"restored": restored}


def delete_duplicates(unit: str = "") -> dict:
    """Borra (suave) todos los requests accionables con duplicate_of (de la
    flota, o de `unit` comparando normalizado). Mismo formato que
    delete_requests. Se queda el keeper de cada grupo (_keeper_rank: fila
    de sistema activa > open > vista más reciente > más vieja)."""
    with SessionLocal() as session:
        dups = _dup_map(session, (unit or "").strip())
        out = _delete_in(session, sorted(dups))
        session.commit()
    return out


# ----- Hooks de Work Orders (los llama core/workorders.py) -------------------

def maint_unit_for_wo(session, wo: WorkOrder, kind: str) -> str:
    """Nombre con el que se REGISTRA el PM/DOT (`kind`) de la WO en el
    tracker (maint.add_record / pm.set_override). La WO lleva el nombre
    canónico de la flota ('CAN 1'), pero maint.board cruza los registros con
    sus filas por nombre EXACTO: si la fila del board se escribe distinto
    ('CAN1', del CSV de Fullbay o de un registro viejo) el registro caería
    en otra fila y la original seguiría vencida para siempre. Se usa la
    escritura del board que guardó el request de ese tipo ligado a la WO
    (meta['board_unit']). Sin request ligado (WO creada a mano con el picker
    de la flota), la escritura con la que el tracker YA conoce a la unidad
    (fila del CSV de PM o registros previos de ese tipo), si difiere solo
    en espacios / mayúsculas. Si no, la unidad de la WO."""
    norm = _norm_unit(wo.unit)
    for r in session.scalars(select(ServiceRequest).where(
            ServiceRequest.wo_id == wo.id, ServiceRequest.source == kind)
            .order_by(ServiceRequest.id)).all():
        board = str(_meta(r).get("board_unit") or "").strip()
        if board and _norm_unit(board) == norm:
            return board[:64]
    try:
        names = [str(x.get("unit") or "") for x in pm.load()]
        names += list(maint.latest_by_unit(kind))
    except Exception:  # noqa: BLE001 — sin CSV/registros, la de la WO
        return wo.unit
    if wo.unit in names:
        return wo.unit
    return next((n.strip()[:64] for n in names
                 if n.strip() and _norm_unit(n) == norm), wo.unit)

def on_wo_status(session, wo_id: int, status: str) -> None:
    """La WO cambió de estado (dentro de la transacción de la WO).
    completed/invoiced -> los on_wo pasan a done (resolution 'wo');
    debajo de completed -> los done por esta WO vuelven a on_wo."""
    now = datetime.now()
    rows = session.scalars(select(ServiceRequest).where(
        ServiceRequest.wo_id == wo_id)).all()
    closing = status in _CLOSED_WO
    for r in rows:
        if closing and r.status == "on_wo":
            r.status = "done"
            r.resolution = "wo"
            r.resolved_at = now
            r.updated_at = now
        elif not closing and r.status == "done" and r.resolution == "wo":
            r.status = "on_wo"
            r.resolution = ""
            r.resolved_at = None
            r.updated_at = now


def on_wo_deleted(session, wo_ids: list[int]) -> None:
    """Se borraron WOs (padre + hijas): sus requests vuelven al backlog."""
    if not wo_ids:
        return
    now = datetime.now()
    rows = session.scalars(select(ServiceRequest).where(
        ServiceRequest.wo_id.in_(list(wo_ids)))).all()
    for r in rows:
        if r.status == "on_wo" or (r.status == "done"
                                   and r.resolution == "wo"):
            r.status = "open"
            r.wo_id = None
            r.resolution = ""
            r.resolved_at = None
            # El sync re-evalúa la fuente (si ya no está, se auto-cierra).
            r.source_active = True
            r.updated_at = now
