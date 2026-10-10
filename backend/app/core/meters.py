# -*- coding: utf-8 -*-
"""Medidores por unidad que NO son el odómetro (v2.22): horas de motor.

El PM del reefer se vence por HORAS de motor del equipo de frío, no por
millas. SquareRigger calcula los intervalos "por horas" contra el ODÓMETRO
(el error que acá no se repite): las horas viven en su propia tabla
`meter_reading` y nunca se mezclan con `odometer_reading` (que alimenta el
cost-per-mile sin filtro de tipo).

Fuentes de lecturas (`source`):
  - manual      -> el taller la carga desde el perfil de la unidad;
  - wo / maint  -> capturadas en una work order o en un registro de PM;
  - lynx / thermoking / traccar -> foto del feed del reefer (snapshot_now);
  - demo        -> simulador determinista del ELD demo (seed_demo_history).

Reglas de log_reading: misma unidad + medidor + día + fuente = CORRECCIÓN
(actualiza, no duplica); una lectura más de 5 % por debajo de la anterior o
que sume más de 24 h por día transcurrido se rechaza salvo `force` (cambio
de controlador, horómetro reseteado). Las unidades se comparan con
`norm_unit` (misma regla que Service Requests: sin espacios, mayúsculas),
así 'TRL 53108' y 'trl53108' son la misma unidad.

TRAMOS (reseteo): una lectura forzada MÁS BAJA que la vigente se guarda con
`is_reset` y abre un tramo nuevo del medidor. Desde ahí, para "vigente",
plausibilidad y value_at solo cuentan las lecturas del tramo (_segment): las
de fechas anteriores al reseteo no, y las del MISMO día (u otras posteriores
cargadas antes del reseteo) solo si son creíbles frente a él — p.ej. la foto
del feed de esa mañana con el horómetro viejo queda afuera. Sin esto, la
lectura alta del día ganaba el empate y el feed quedaba rechazado para
siempre contra ella. El feed también se recupera solo: si reporta un valor
bajo DOS días seguidos de forma consistente, se toma como reseteo
(snapshot_now).

Tenant: como odometer.py, respeta el contexto del caller (el loop de fondo
fija la org 'default'; una ruta usa la del request).
"""
from __future__ import annotations

import logging
import math
import time
from datetime import date, datetime, timedelta

from sqlalchemy import and_, func, select
from sqlalchemy.exc import IntegrityError

from ..db import MaintRecord, MeterReading, SessionLocal, WorkOrder
from . import org_config, tenant

log = logging.getLogger(__name__)

ENGINE_HOURS = "engine_hours"
METERS = (ENGINE_HOURS,)
SOURCES = ("manual", "wo", "maint", "lynx", "thermoking", "traccar", "demo")
_FEED_SOURCES = ("lynx", "thermoking", "traccar")

# Plausibilidad: un día tiene 24 h, y un horómetro no baja (más de un 5 %
# de tolerancia por redondeos/fuentes distintas) salvo reseteo explícito.
_MAX_PER_DAY = {ENGINE_HOURS: 24.0}
_DROP_TOLERANCE = 0.05
_MAX_VALUE = 200_000.0
# Lectura "del día" de un registro sin horas: la última lectura dentro de
# esta ventana antes de la fecha del servicio (value_at).
VALUE_AT_MAX_AGE_DAYS = 30


def norm_unit(unit: str) -> str:
    """Unidad comparable: mayúsculas y sin espacios ('trl 53108' ==
    'TRL53108'). MISMA regla que service_requests._norm_unit."""
    return "".join((unit or "").split()).upper()


def _today() -> date:
    return org_config.org_today()


def _valid_date(value: str | None) -> str | None:
    """'YYYY-MM-DD' estricto -> el mismo string; otra cosa -> None."""
    s = (value or "").strip()
    if len(s) != 10:
        return None
    try:
        return date.fromisoformat(s).isoformat()
    except ValueError:
        return None


def _clean_value(value) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise ValueError("engine hours must be a number")
    if not math.isfinite(v) or v <= 0 or v >= _MAX_VALUE:
        raise ValueError("engine hours must be a positive number "
                         "(below 200,000)")
    return round(v, 1)


def _row_dict(r: MeterReading) -> dict:
    return {"id": r.id, "unit": r.unit, "meter": r.meter, "date": r.date,
            "value": r.value, "source": r.source,
            "is_reset": bool(r.is_reset)}


def _include_demo() -> bool:
    """¿Cuentan las lecturas del simulador ('demo')? Solo con la app en
    demo (samsara._demo()). Si la org sale del demo (configura Samsara),
    las lecturas demo que quedaron en la base no se muestran como vigentes
    ni meten unidades fantasma al board del reefer."""
    from . import samsara              # import diferido (orden de carga)
    try:
        return bool(samsara._demo())
    except Exception:  # noqa: BLE001 — config ilegible: como antes
        return True


def _unit_rows(session, unit: str, meter: str) -> list[MeterReading]:
    """Lecturas de `unit` (cualquier escritura que normalice igual) para
    `meter`. Dos consultas baratas: las escrituras distintas del medidor y
    luego sus filas (la normalización va en Python: un upper/replace de SQL
    no coincide con norm_unit para tabs/NBSP). Sin las 'demo' fuera de
    demo (_include_demo)."""
    norm = norm_unit(unit)
    spellings = [u for (u,) in session.execute(
        select(MeterReading.unit).where(MeterReading.meter == meter)
        .distinct()).all() if norm_unit(u) == norm]
    if not spellings:
        return []
    q = select(MeterReading).where(MeterReading.meter == meter,
                                   MeterReading.unit.in_(spellings))
    if not _include_demo():
        q = q.where(MeterReading.source != "demo")
    return list(session.scalars(q).all())


def _days(a: str, b: str) -> int:
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def _fits_after(r, base, meter: str = ENGINE_HOURS) -> bool:
    """¿La lectura `r` es creíble como posterior a `base` (no baja más del
    5 %, no suma más de 24 h por día)?"""
    days = max(1, _days(base.date, r.date))
    cap = _MAX_PER_DAY.get(meter, 24.0) * days
    return (base.value * (1 - _DROP_TOLERANCE) <= r.value
            <= base.value + cap)


def _segment(rows: list, as_of: str | None = None,
             meter: str = ENGINE_HOURS) -> list:
    """Lecturas del TRAMO vigente del medidor (ver docstring del módulo).
    `as_of` = el tramo vigente a esa fecha (reseteos posteriores no cuentan
    y cortan el tramo). Las lecturas deben tener id, date, value, is_reset."""
    resets = [r for r in rows if getattr(r, "is_reset", False)
              and (as_of is None or r.date <= as_of)]
    out = list(rows)
    if resets:
        rs = max(resets, key=lambda r: (r.date, r.id or 0))
        out = [r for r in rows if r is rs or (
            r.date >= rs.date and (
                ((r.id or 0) > (rs.id or 0) and r.date > rs.date)
                or _fits_after(r, rs, meter)))]
    if as_of is not None:
        later = [r for r in rows if getattr(r, "is_reset", False)
                 and r.date > as_of]
        if later:
            cut = min(r.date for r in later)
            out = [r for r in out if r.date < cut]
    return out


def _check_plausible(value: float, d: str, others: list[MeterReading],
                     meter: str) -> MeterReading | None:
    """ValueError (mensaje en inglés: UI) si la lectura no es creíble frente
    a las vecinas DEL TRAMO: más de 5 % por debajo de la anterior, más de
    24 h por día transcurrido desde la anterior, o más de 5 % por encima de
    una POSTERIOR (una lectura cargada con fecha vieja). Devuelve la
    anterior (o None)."""
    seg = _segment(others, as_of=d, meter=meter)
    prev = max((r for r in seg if r.date <= d),
               key=lambda r: (r.date, r.value), default=None)
    nxt = min((r for r in seg if r.date > d),
              key=lambda r: (r.date, r.value), default=None)
    hint = " — check the value, or confirm to save it anyway"
    if prev is not None:
        if value < prev.value * (1 - _DROP_TOLERANCE):
            raise ValueError(
                f"{value:,.1f} hrs is lower than the previous reading "
                f"({prev.value:,.1f} hrs on {prev.date}){hint}")
        days = max(1, (date.fromisoformat(d)
                       - date.fromisoformat(prev.date)).days)
        cap = _MAX_PER_DAY.get(meter, 24.0) * days
        if value - prev.value > cap:
            raise ValueError(
                f"{value - prev.value:,.1f} hrs since {prev.date} is more "
                f"than {cap:,.0f} hrs in {days} day(s){hint}")
    if nxt is not None and value > nxt.value * (1 + _DROP_TOLERANCE):
        raise ValueError(
            f"{value:,.1f} hrs is higher than a later reading "
            f"({nxt.value:,.1f} hrs on {nxt.date}){hint}")
    return prev


def _prev_in_segment(d: str, others: list, meter: str):
    seg = _segment(others, as_of=d, meter=meter)
    return max((r for r in seg if r.date <= d),
               key=lambda r: (r.date, r.value), default=None)


def log_reading(unit: str, value, date_str: str | None = None,
                source: str = "manual", meter: str = ENGINE_HOURS,
                force: bool = False) -> dict:
    """Registra (o CORRIGE: mismo día + fuente) una lectura del medidor.
    Fecha vacía = hoy (zona de la org); no se aceptan fechas futuras.
    Plausibilidad (ver _check_plausible) salvo `force`. Una lectura forzada
    más baja que la vigente del tramo es un RESETEO (is_reset: abre tramo
    nuevo). Devuelve la lectura {id, unit, meter, date, value, source,
    is_reset}; ValueError si no valida."""
    u = (unit or "").strip()[:64]
    if not u:
        raise ValueError("unit is required")
    if meter not in METERS:
        raise ValueError(f"unknown meter: {meter}")
    if source not in SOURCES:
        raise ValueError(f"invalid source: {source}")
    v = _clean_value(value)
    raw = (date_str or "").strip()
    d = _valid_date(raw) if raw else _today().isoformat()
    if d is None:
        raise ValueError("date must be YYYY-MM-DD")
    if d > _today().isoformat():
        raise ValueError("date can't be in the future")
    with SessionLocal() as s:
        rows = _unit_rows(s, u, meter)
        mine = next((r for r in rows if r.date == d and r.source == source),
                    None)
        others = [r for r in rows if r is not mine]
        reset = False
        if not force:
            _check_plausible(v, d, others, meter)
        else:
            prev = _prev_in_segment(d, others, meter)
            reset = prev is not None and v < prev.value * (1 - _DROP_TOLERANCE)
        if mine is not None:
            mine.value = v
            mine.is_reset = reset
            row = mine
        else:
            row = MeterReading(unit=u, meter=meter, date=d, value=v,
                               source=source, created_at=datetime.now(),
                               is_reset=reset)
            s.add(row)
        try:
            s.commit()
        except IntegrityError:
            # Otro proceso insertó la misma (unidad, día, fuente) en paralelo.
            s.rollback()
            raise ValueError("a reading for that day was just saved — retry")
        return _row_dict(row)


def _pick_latest(rows) -> tuple | None:
    """La lectura vigente: la de fecha más nueva y, a igual fecha, la de
    mayor valor (el horómetro solo sube dentro de un tramo; varias fuentes
    el mismo día). Recibe tuplas (unit, date, value, source) YA acotadas al
    tramo vigente (_segment)."""
    return max(rows, key=lambda r: (r[1], r[2]), default=None)


def _tuples(rows) -> list[tuple]:
    return [(r.unit, r.date, r.value, r.source) for r in rows]


def latest(unit: str, meter: str = ENGINE_HOURS) -> dict | None:
    """{value, date, source} vigente de la unidad (tramo actual), o None."""
    with SessionLocal() as s:
        rows = _tuples(_segment(_unit_rows(s, unit, meter), meter=meter))
    best = _pick_latest(rows)
    if best is None:
        return None
    return {"value": best[2], "date": best[1], "source": best[3]}


def latest_all(meter: str = ENGINE_HOURS) -> dict[str, dict]:
    """{unidad normalizada: {unit, value, date, source}} con la lectura
    vigente de cada unidad. Una consulta (subconsulta de la fecha máxima
    por escritura, con el filtro de org EXPLÍCITO: no se depende de que el
    criterio de tenant se propague a la subconsulta)."""
    org = tenant.get_current_org()
    # Mismo filtro de fuentes en la subconsulta y en la consulta externa.
    src_ok = (MeterReading.source != "demo") if not _include_demo() \
        else (MeterReading.id.isnot(None))
    with SessionLocal() as s:
        sub_q = (select(MeterReading.unit.label("u"),
                        func.max(MeterReading.date).label("md"))
                 .where(MeterReading.meter == meter, src_ok))
        if org is not None:
            sub_q = sub_q.where(MeterReading.org_id == org)
        sub = sub_q.group_by(MeterReading.unit).subquery()
        rows = s.execute(
            select(MeterReading.unit, MeterReading.date, MeterReading.value,
                   MeterReading.source)
            .join(sub, and_(MeterReading.unit == sub.c.u,
                            MeterReading.date == sub.c.md))
            .where(MeterReading.meter == meter, src_ok)).all()
        # Unidades con reseteo: su vigente sale del TRAMO (la fecha máxima
        # puede ser una foto del horómetro viejo del mismo día del reseteo).
        reset_units = {norm_unit(u) for (u,) in s.execute(
            select(MeterReading.unit).where(
                MeterReading.meter == meter, src_ok,
                MeterReading.is_reset.is_(True),
                *([MeterReading.org_id == org] if org is not None else []))
            .distinct()).all()}
        seg_rows: dict[str, list] = {}
        for norm in reset_units:
            rs = _segment(_unit_rows(s, norm, meter), meter=meter)
            if rs:
                seg_rows[norm] = _tuples(rs)
    grouped: dict[str, list] = {}
    for r in rows:
        if norm_unit(r[0]) in reset_units:
            continue
        grouped.setdefault(norm_unit(r[0]), []).append(tuple(r))
    grouped.update(seg_rows)
    out: dict[str, dict] = {}
    for norm, rs in grouped.items():
        best = _pick_latest(rs)
        out[norm] = {"unit": best[0], "date": best[1], "value": best[2],
                     "source": best[3]}
    return out


def unit_readings(unit: str, meter: str = ENGINE_HOURS,
                  limit: int = 60) -> dict:
    """Lecturas de la unidad (todas las fuentes), más nuevas primero, para
    el perfil. {unit, meter, latest, count, readings:[{id,date,value,
    source}]}."""
    with SessionLocal() as s:
        rows = _unit_rows(s, unit, meter)
        current = {id(r) for r in _segment(rows, meter=meter)}
        items = sorted(({"id": r.id, "date": r.date, "value": r.value,
                         "source": r.source, "is_reset": bool(r.is_reset),
                         # Lectura del tramo anterior a un reseteo.
                         "superseded": id(r) not in current}
                        for r in rows),
                       key=lambda x: (x["date"], x["value"]), reverse=True)
    live = [x for x in items if not x["superseded"]]
    top = max(live, key=lambda x: (x["date"], x["value"])) if live else None
    return {
        "unit": (unit or "").strip(), "meter": meter,
        "latest": ({"value": top["value"], "date": top["date"],
                    "source": top["source"]} if top else None),
        "count": len(items),
        "readings": items[:max(1, int(limit or 60))],
    }


def value_at(unit: str, date_iso: str, meter: str = ENGINE_HOURS,
             max_age_days: int = VALUE_AT_MAX_AGE_DAYS) -> float | None:
    """Horas de la unidad AL día `date_iso`: la lectura vigente en esa fecha
    o antes (hasta `max_age_days` atrás). La usa maint.add_record cuando un
    PM por horas se registra sin horas (p.ej. al facturar una WO sin el
    dato): el registro guarda la lectura del medidor de ese día."""
    d = _valid_date(date_iso)
    if d is None:
        return None
    floor = (date.fromisoformat(d) - timedelta(days=max_age_days)).isoformat()
    with SessionLocal() as s:
        rows = [r for r in _segment(_unit_rows(s, unit, meter), as_of=d,
                                    meter=meter)
                if floor <= r.date <= d]
    best = _pick_latest(_tuples(rows))
    return best[2] if best else None


# ---------------------------------------------------------------------------
# Detección de reefers (universo del board "Reefer PM")
# ---------------------------------------------------------------------------

# Parte con RED de la detección (flota de Samsara + feed del reefer), por
# org: org -> (monotonic, {norm: nombre}, {norm: año/marca/modelo}, errores).
# Lo de la base (lecturas, registros, opt-in/out) se lee siempre fresco.
_NET_TTL_S = 120
_net_cache: dict[int | None, tuple[float, dict, dict, list]] = {}


def _ymm(u: dict) -> str:
    return " ".join(str(x).strip() for x in
                    (u.get("year"), u.get("make"), u.get("model"))
                    if str(x or "").strip())


def _is_reefer_subtype(value) -> bool:
    return "reefer" in str(value or "").lower()


async def _network_reefers(refresh: bool = False) -> tuple[dict, dict, list]:
    """({norm: nombre}, {norm: modelo}, errores) de la flota (subtype
    'reefer': flota demo; Samsara real no trae subtipo) + las unidades del
    feed del reefer (Lynx / Thermo King / Traccar). El feed DEMO solo cuenta
    si toda la app está en demo (samsara._demo()): sin integración de reefer
    en producción, load_live cae al simulador y sus unidades no son de la
    flota."""
    from . import reefer, samsara      # import diferido (orden de carga)
    org = tenant.get_current_org()
    hit = _net_cache.get(org)
    if (not refresh and hit is not None
            and time.monotonic() - hit[0] < _NET_TTL_S):
        return hit[1], hit[2], hit[3]
    names: dict[str, str] = {}
    models: dict[str, str] = {}
    errors: list[str] = []
    if samsara.is_available():
        try:
            for fu in await samsara.list_fleet():
                name = str(fu.get("unit") or "").strip()
                if not name:
                    continue
                models.setdefault(norm_unit(name), _ymm(fu))
                if _is_reefer_subtype(fu.get("subtype")):
                    names.setdefault(norm_unit(name), name[:64])
        except Exception:  # noqa: BLE001 — universo parcial, se avisa
            errors.append("fleet")
    try:
        feed = await reefer.load_live()
        if not feed.get("demo") or samsara._demo():
            for ru in feed.get("units") or []:
                name = str(ru.get("unit") or "").strip()
                if name:
                    names.setdefault(norm_unit(name), name[:64])
    except Exception:  # noqa: BLE001
        errors.append("reefer_feed")
    _net_cache[org] = (time.monotonic(), names, models, errors)
    return names, models, errors


def clear_cache() -> None:
    """Olvida la detección cacheada (tests / refresh)."""
    _net_cache.clear()


async def reefer_units(refresh: bool = False) -> dict:
    """Universo del PM del reefer: {units: {norm: nombre}, models: {norm:
    modelo}, errors: [...]}. Reefer = subtipo 'reefer' en la flota (demo) o
    en las unidades manuales ∪ unidades del feed del reefer ∪ unidades con
    lecturas de horas ∪ unidades con registros de PM del reefer ∪ opt-in
    explícito (campaña prendida en el perfil); menos las que la apagaron a
    mano (opt-out), salvo que tengan opt-in."""
    from . import manual_units, unit_settings   # import diferido
    net_names, models, errors = await _network_reefers(refresh)
    names: dict[str, str] = {}
    # La escritura de la flota manda (es la que muestra GET /api/fleet).
    for n, name in net_names.items():
        names.setdefault(n, name)
    for mu in manual_units.list_units():
        name = str(mu.get("unit") or "").strip()
        if not name:
            continue
        models.setdefault(norm_unit(name), _ymm(mu))
        if _is_reefer_subtype(mu.get("subtype")):
            names.setdefault(norm_unit(name), name[:64])
    with SessionLocal() as s:
        rec_units = {u for (u,) in s.execute(
            select(MaintRecord.unit).where(MaintRecord.kind == "reefer")
            .distinct()).all()}
    for u in sorted(rec_units):
        if u.strip():
            names.setdefault(norm_unit(u), u.strip()[:64])
    for n, cur in latest_all(ENGINE_HOURS).items():
        names.setdefault(n, cur["unit"])
    on, off = unit_settings.campaign_units("reefer")
    for u in sorted(on):
        if u.strip():
            names.setdefault(norm_unit(u), u.strip()[:64])
    on_norm = {norm_unit(u) for u in on}
    for u in off:
        n = norm_unit(u)
        if n not in on_norm:
            names.pop(n, None)
    return {"units": names, "models": models, "errors": list(errors)}


async def is_reefer(unit: str) -> bool:
    """¿La unidad entra al PM del reefer? (misma regla que reefer_units)."""
    return norm_unit(unit) in (await reefer_units())["units"]


# ---------------------------------------------------------------------------
# Ingesta: feed del reefer, demo e historial
# ---------------------------------------------------------------------------

async def snapshot_now() -> int:
    """Foto del horómetro desde el feed del reefer como lectura de HOY
    (fuente = la del feed). Re-correrla el mismo día CORRIGE la lectura del
    día (así el valor vigente sigue al feed). Las que no son creíbles se
    saltean (log). El feed demo solo si toda la app está en demo (ver
    _network_reefers). Devuelve cuántas escribió."""
    from . import reefer, samsara      # import diferido (orden de carga)
    try:
        feed = await reefer.load_live()
    except Exception as exc:  # noqa: BLE001 — sin feed, sin lecturas
        log.warning("meters.snapshot_now: reefer feed failed: %s", exc)
        return 0
    if feed.get("demo") and not samsara._demo():
        return 0
    today = _today().isoformat()
    org = tenant.get_current_org()
    n = 0
    for ru in feed.get("units") or []:
        name = str(ru.get("unit") or "").strip()
        hrs = ru.get("engine_hours")
        if not name or hrs in (None, ""):
            continue
        src = ("demo" if feed.get("demo") or ru.get("demo")
               else str(ru.get("source") or ""))
        if src not in SOURCES:
            continue
        try:
            log_reading(name, hrs, today, src)
            n += 1
            _pending_reset.pop((org, norm_unit(name), src), None)
        except ValueError as exc:
            if _feed_reset(org, name, hrs, today, src, exc):
                n += 1
                continue
            log.info("meters.snapshot_now: skipped %s (%s): %s",
                     name, src, exc)
    return n


# Feed que reporta un valor MÁS BAJO que el vigente (controlador cambiado o
# horómetro reseteado y nadie lo cargó a mano): se recuerda la lectura
# rechazada; si al DÍA SIGUIENTE (o después) el mismo feed sigue reportando
# un valor consistente con ella, se toma como reseteo (lectura forzada) y se
# loguea. Así el feed no queda rechazado para siempre.
# (org, unidad normalizada, fuente) -> (fecha, valor).
_pending_reset: dict[tuple, tuple[str, float]] = {}


def _feed_reset(org, name: str, hrs, today: str, src: str,
                exc: Exception) -> bool:
    try:
        v = float(hrs)
    except (TypeError, ValueError):
        return False
    if "lower than the previous reading" not in str(exc):
        return False
    key = (org, norm_unit(name), src)
    pend = _pending_reset.get(key)
    if pend is not None and pend[0] < today:
        days = max(1, _days(pend[0], today))
        cap = _MAX_PER_DAY.get(ENGINE_HOURS, 24.0) * days
        if pend[1] * (1 - _DROP_TOLERANCE) <= v <= pend[1] + cap:
            try:
                log_reading(name, v, today, src, force=True)
            except ValueError:
                return False
            _pending_reset.pop(key, None)
            log.warning("meters: %s feed (%s) dropped to %.1f hrs for 2+ "
                        "days — recorded as an hour-meter reset",
                        name, src, v)
            return True
    if pend is None or pend[0] < today:
        _pending_reset[key] = (today, v)
    return False


def seed_demo_history(days: int = 90) -> int:
    """DEMO: siembra lecturas PASADAS (hasta ayer) del horómetro simulado de
    los reefers demo, para que el perfil tenga historial y el board del
    reefer tenga "horas actuales" desde el primer arranque. No-op fuera de
    demo (samsara._demo()). Idempotente por (unidad, fecha, 'demo')."""
    from . import demo_eld, samsara    # import diferido (orden de carga)
    if not samsara._demo():
        return 0
    today = _today()
    span = max(1, min(int(days or 90), 400))
    now = datetime.now()
    added = 0
    with SessionLocal() as s:
        have = {(norm_unit(u), d) for (u, d) in s.execute(
            select(MeterReading.unit, MeterReading.date).where(
                MeterReading.meter == ENGINE_HOURS,
                MeterReading.source == "demo")).all()}
        for unit in demo_eld.reefer_units():
            for k in range(span, 0, -1):
                d = today - timedelta(days=k)
                key = (norm_unit(unit), d.isoformat())
                if key in have:
                    continue
                hrs = demo_eld.engine_hours_at(unit, d)
                if hrs <= 0:
                    continue
                have.add(key)
                s.add(MeterReading(unit=unit, meter=ENGINE_HOURS,
                                   date=d.isoformat(), value=hrs,
                                   source="demo", created_at=now))
                added += 1
        if added:
            s.commit()
    return added


def _wo_date(service_date, closed_at, created_at) -> str | None:
    d = _valid_date(service_date)
    if d:
        return d
    for dt in (closed_at, created_at):
        if dt is not None:
            return dt.date().isoformat()
    return None


def backfill_from_history() -> int:
    """Lecturas desde las horas ya capturadas en MaintRecord.hours (fuente
    'maint') y WorkOrder.engine_hours (fuente 'wo', fecha efectiva de la
    WO). Solo las que falten por (unidad normalizada, fecha, fuente) y que
    pasen la plausibilidad (las demás se saltean). Devuelve cuántas creó."""
    with SessionLocal() as s:
        have = {(norm_unit(u), d, src) for (u, d, src) in s.execute(
            select(MeterReading.unit, MeterReading.date,
                   MeterReading.source).where(
                MeterReading.meter == ENGINE_HOURS)).all()}
        todo: list[tuple[str, float, str, str]] = []
        for unit, d0, hrs in s.execute(
                select(MaintRecord.unit, MaintRecord.date, MaintRecord.hours)
                .where(MaintRecord.hours.isnot(None))).all():
            d = _valid_date(d0)
            if unit and d and hrs and hrs > 0:
                todo.append((unit, hrs, d, "maint"))
        for unit, sd, closed, created, hrs in s.execute(
                select(WorkOrder.unit, WorkOrder.service_date,
                       WorkOrder.closed_at, WorkOrder.created_at,
                       WorkOrder.engine_hours)
                .where(WorkOrder.engine_hours.isnot(None))).all():
            d = _wo_date(sd, closed, created)
            if unit and d and hrs and hrs > 0:
                todo.append((unit, hrs, d, "wo"))
    today = _today().isoformat()
    added = 0
    for unit, hrs, d, src in todo:
        key = (norm_unit(unit), d, src)
        if key in have or d > today:
            continue
        have.add(key)
        try:
            log_reading(unit, hrs, d, src)
            added += 1
        except ValueError as exc:
            log.info("meters.backfill: skipped %s %s (%s): %s",
                     unit, d, src, exc)
    return added


# Guardas en memoria por org: la foto del feed a lo sumo una vez por HORA
# (el valor del día se va corrigiendo), backfill + siembra demo una vez por
# DÍA. El backstop durable es el UNIQUE de la tabla + la corrección por día.
_last_hour: dict[int | None, str] = {}
_last_day: dict[int | None, str] = {}


async def maybe_snapshot() -> int:
    """Ingesta para el loop de fondo (lo llama odometer.maybe_snapshot).
    Nunca levanta: cualquier falla se loguea y se reintenta en la próxima
    vuelta. Devuelve cuántas lecturas del feed escribió."""
    org = tenant.get_current_org()
    hour = datetime.now().strftime("%Y-%m-%d %H")
    if _last_hour.get(org) == hour:
        return 0
    try:
        day = hour[:10]
        if _last_day.get(org) != day:
            backfill_from_history()
            seed_demo_history()
            _last_day[org] = day
        n = await snapshot_now()
    except Exception as exc:  # noqa: BLE001 — log & retry
        log.warning("meters.maybe_snapshot failed: %s", exc)
        return 0
    _last_hour[org] = hour
    return n
