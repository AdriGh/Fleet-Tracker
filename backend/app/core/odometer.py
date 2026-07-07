# -*- coding: utf-8 -*-
"""Persistencia de odómetro + millas por período (habilitador del CPM, v2.8).

El cost-per-mile necesita un DENOMINADOR: las millas manejadas en un período.
Hoy Samsara da el odómetro EN VIVO pero no se guarda, así que no hay forma de
saber "cuántas millas hizo esta unidad este mes". Este módulo persiste el
odómetro en `odometer_reading` (serie temporal por unidad+fecha) por dos vías:

  - BACKFILL de los `mileage` ya capturados en WorkOrder y MaintRecord: es
    historial REAL que ya existe → da un CPM utilizable desde el día uno, sin
    esperar a acumular snapshots.
  - SNAPSHOT diario del odómetro de Samsara (en el loop de alertas): acumula
    lecturas hacia adelante. NO hay backfill posible antes del primer snapshot.

Millas de un período = odo_fin − odo_inicio (delta entre la primera y la última
lectura DENTRO del rango; conservador: nunca cuenta millas fuera del período).
Provider-agnóstico: `snapshot_now` usa `samsara.vehicle_odometers()`, que ya
auto-rutea real vs demo; un futuro adapter de Panda ELD alimenta la MISMA tabla.

Tenant: las funciones NO fijan el org — respetan el contexto del caller (el
loop de alertas fija 'default'; un endpoint usa el org del request). Los inserts
OrgScoped autocompletan org_id del ContextVar, igual que el resto de la app.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime

from sqlalchemy import select

from ..db import (MaintRecord, OdometerReading, SessionLocal, WorkOrder)
from . import samsara


def _norm_date(value: str | None) -> str | None:
    """Valida 'YYYY-MM-DD' (o None). Devuelve los primeros 10 chars si parsea."""
    s = (value or "").strip()
    if not s:
        return None
    try:
        datetime.strptime(s[:10], "%Y-%m-%d")
    except ValueError:
        return None
    return s[:10]


def _wo_date(service_date: str | None, closed_at, created_at) -> str | None:
    """Fecha efectiva de una WO para la lectura: service_date -> closed_at ->
    created_at (misma cascada que reports._effective_date)."""
    d = _norm_date(service_date)
    if d:
        return d
    if closed_at is not None:
        return closed_at.date().isoformat()
    if created_at is not None:
        return created_at.date().isoformat()
    return None


# ---------------------------------------------------------------------------
# Ingesta
# ---------------------------------------------------------------------------

async def snapshot_now() -> int:
    """Persiste el odómetro actual de Samsara como lecturas de HOY (source
    'samsara'). Idempotente: no duplica si la unidad ya tiene lectura de hoy.
    Devuelve cuántas insertó. Sin Samsara configurado, vehicle_odometers()
    devuelve {} y no hace nada."""
    odos = await samsara.vehicle_odometers()   # {unit: {miles, source}}
    if not odos:
        return 0
    today = date.today().isoformat()
    now = datetime.now()
    with SessionLocal() as s:
        have = {u for (u,) in s.execute(
            select(OdometerReading.unit).where(
                OdometerReading.date == today,
                OdometerReading.source == "samsara")).all()}
        added = 0
        for unit, info in odos.items():
            u = (unit or "").strip()
            if not u or u in have:
                continue
            miles = (info or {}).get("miles")
            if not miles or miles <= 0:
                continue
            s.add(OdometerReading(unit=u, date=today, miles=int(miles),
                                  source="samsara", created_at=now))
            have.add(u)
            added += 1
        if added:
            s.commit()
        return added


def backfill_from_history() -> int:
    """Siembra `odometer_reading` desde los `mileage` ya capturados en
    WorkOrder (source 'wo') y MaintRecord (source 'maint'). Idempotente por
    (unit, date, source). Barato y seguro de re-correr. Devuelve cuántas
    insertó."""
    now = datetime.now()
    added = 0
    with SessionLocal() as s:
        existing = {(u, d, src) for (u, d, src) in s.execute(
            select(OdometerReading.unit, OdometerReading.date,
                   OdometerReading.source)).all()}

        # WorkOrder.mileage (fecha efectiva service_date -> closed_at -> created)
        for unit, sd, closed_at, created_at, mileage in s.execute(
            select(WorkOrder.unit, WorkOrder.service_date, WorkOrder.closed_at,
                   WorkOrder.created_at, WorkOrder.mileage)
                .where(WorkOrder.mileage.isnot(None))).all():
            u = (unit or "").strip()
            d = _wo_date(sd, closed_at, created_at)
            if not u or not d or not mileage or mileage <= 0:
                continue
            key = (u, d, "wo")
            if key in existing:
                continue
            existing.add(key)
            s.add(OdometerReading(unit=u, date=d, miles=int(mileage),
                                  source="wo", created_at=now))
            added += 1

        # MaintRecord.mileage (date es requerida, YYYY-MM-DD)
        for unit, d0, mileage in s.execute(
            select(MaintRecord.unit, MaintRecord.date, MaintRecord.mileage)
                .where(MaintRecord.mileage.isnot(None))).all():
            u = (unit or "").strip()
            d = _norm_date(d0)
            if not u or not d or not mileage or mileage <= 0:
                continue
            key = (u, d, "maint")
            if key in existing:
                continue
            existing.add(key)
            s.add(OdometerReading(unit=u, date=d, miles=int(mileage),
                                  source="maint", created_at=now))
            added += 1

        if added:
            s.commit()
    return added


# Guarda en memoria para no golpear la API de Samsara cada 60 s: el snapshot
# se hace UNA vez por día calendario. El backstop durable es el UNIQUE de la
# tabla + el chequeo `have` en snapshot_now.
_last_snapshot_date: str | None = None


async def maybe_snapshot() -> int:
    """Ingesta diaria (para el loop de alertas), a lo sumo una vez por día:
    backfilllea odómetro de los mileage nuevos de WOs/PM + toma snapshot de
    Samsara. Si Samsara falla, no marca el día como hecho (reintenta). Devuelve
    cuántas lecturas de Samsara agregó."""
    global _last_snapshot_date
    today = date.today().isoformat()
    if _last_snapshot_date == today:
        return 0
    backfill_from_history()
    n = await snapshot_now()
    _last_snapshot_date = today
    return n


# ---------------------------------------------------------------------------
# Consulta: millas por período (el denominador del CPM)
# ---------------------------------------------------------------------------

def miles_by_unit(d_from: date | None,
                  d_to: date | None) -> dict[str, int]:
    """Millas manejadas por unidad en [d_from, d_to] = última − primera lectura
    DENTRO del rango. Colapsa múltiples fuentes de la misma fecha al máximo (el
    odómetro solo sube). Devuelve solo unidades con delta > 0 (se necesitan ≥2
    lecturas en el rango). Conservador: nunca cuenta millas fuera del período."""
    with SessionLocal() as s:
        rows = s.execute(
            select(OdometerReading.unit, OdometerReading.date,
                   OdometerReading.miles)).all()

    # unit -> {date(date): miles} (una por fecha, el máximo)
    per_unit: dict[str, dict] = defaultdict(dict)
    for unit, dstr, miles in rows:
        try:
            d = datetime.strptime((dstr or "")[:10], "%Y-%m-%d").date()
        except ValueError:
            continue
        cur = per_unit[unit].get(d)
        if cur is None or miles > cur:
            per_unit[unit][d] = miles

    out: dict[str, int] = {}
    for unit, dm in per_unit.items():
        in_range = sorted(dt for dt in dm
                          if (d_from is None or dt >= d_from)
                          and (d_to is None or dt <= d_to))
        if len(in_range) < 2:
            continue
        delta = dm[in_range[-1]] - dm[in_range[0]]
        if delta > 0:
            out[unit] = int(delta)
    return out


def coverage() -> dict:
    """Cobertura de la serie de odómetro: cuántas lecturas hay y desde/hasta
    qué fecha (para el rótulo honesto 'datos desde X' — no hay backfill previo
    al primer dato)."""
    with SessionLocal() as s:
        dates = sorted(
            d for (d,) in s.execute(select(OdometerReading.date)).all() if d)
    return {
        "readings": len(dates),
        "since": dates[0] if dates else None,
        "latest": dates[-1] if dates else None,
    }
