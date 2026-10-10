# -*- coding: utf-8 -*-
"""Envíos programados de reportes por email (v2.22, "Schedule email…").

Un schedule apunta a un reporte ('sys:<slug>' + versión, o 'saved:<id>'),
con cadencia daily | weekly (weekday 0=lunes) | monthly (day_of_month,
recortado al último día del mes) a una HORA de la zona de la org, una lista
de destinatarios y el formato del adjunto (csv | xlsx).

Scheduler: `maybe_run()` lo llama alerts.run_loop cada minuto. Recorre las
organizaciones activas fijando el tenant de cada una, busca los schedules
vencidos y los RECLAMA con un UPDATE condicional
(`WHERE id = ? AND org_id = ? AND next_run_at = <valor leído>`) que avanza
next_run_at al próximo turno: si dos workers compiten, solo uno ve
rowcount = 1 y envía. El estado queda en la base (last_run_at,
last_status, last_error), así un reinicio no reenvía.

`last_status`: sent | dry_run (el mailer está en modo simulado o sin
configurar: no se mandó nada de verdad, y se dice) | error.

Los datos personales (PII) SIEMPRE salen enmascarados en un envío
programado: los destinatarios no son usuarios con permisos.
"""

from __future__ import annotations

import asyncio
import calendar
import re
from datetime import date, datetime, time as dtime, timedelta

from sqlalchemy import select, update

from ..db import Organization, ReportSchedule, SessionLocal
from . import (mailer, org_config, report_engine, report_export,
               report_saved, tenant)

CADENCES = ("daily", "weekly", "monthly")
FORMATS = ("csv", "xlsx")
MAX_RECIPIENTS = 20
_EMAIL_RE = re.compile(r"^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$")
_WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
             "Saturday", "Sunday")


def _org() -> int:
    org = tenant.get_current_org()
    if org is None:
        raise ValueError("no organization in context")
    return org


def _server_naive(aware: datetime) -> datetime:
    """Aware (zona de la org) -> naive en hora del servidor (como se guardan
    todos los DateTime de la base), sin microsegundos (el reclamo compara
    por igualdad)."""
    return aware.astimezone().replace(tzinfo=None, microsecond=0)


def _org_iso(dt: datetime | None, tz) -> str | None:
    if dt is None:
        return None
    aware = dt.astimezone() if dt.tzinfo is None else dt
    return aware.astimezone(tz).replace(tzinfo=None,
                                        microsecond=0).isoformat()


def next_run(cadence: str, hour: int, weekday: int | None,
             day_of_month: int | None, after: datetime,
             tz) -> datetime:
    """Próximo envío ESTRICTAMENTE posterior a `after` (aware), como
    datetime aware en la zona `tz` de la org."""
    local = after.astimezone(tz)
    d = local.date()

    def at(day: date) -> datetime:
        return datetime.combine(day, dtime(hour, 0), tzinfo=tz)

    if cadence == "daily":
        cand = at(d)
        if cand <= local:
            cand = at(d + timedelta(days=1))
        return cand
    if cadence == "weekly":
        wd = 0 if weekday is None else int(weekday)
        cand = at(d + timedelta(days=(wd - d.weekday()) % 7))
        if cand <= local:
            cand = at(cand.date() + timedelta(days=7))
        return cand
    dom = max(1, min(31, int(day_of_month or 1)))

    def month_day(y: int, m: int) -> date:
        return date(y, m, min(dom, calendar.monthrange(y, m)[1]))
    cand = at(month_day(d.year, d.month))
    if cand <= local:
        y, m = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
        cand = at(month_day(y, m))
    return cand


def _recipients(raw) -> list[str]:
    items = raw if isinstance(raw, list) else re.split(r"[,;\s]+",
                                                       str(raw or ""))
    out: list[str] = []
    for e in items:
        e = str(e or "").strip()
        if not e:
            continue
        if not _EMAIL_RE.match(e) or len(e) > 120:
            raise ValueError(f"invalid email: {e}")
        if e.lower() not in {x.lower() for x in out}:
            out.append(e)
    if not out:
        raise ValueError("add at least one recipient email")
    if len(out) > MAX_RECIPIENTS:
        raise ValueError(f"at most {MAX_RECIPIENTS} recipients")
    return out


def _clean_timing(data: dict, cur: ReportSchedule | None = None) -> dict:
    cadence = str(data.get("cadence", cur.cadence if cur else "weekly")
                  or "")
    if cadence not in CADENCES:
        raise ValueError("cadence must be daily, weekly or monthly")
    try:
        hour = int(data.get("hour", cur.hour if cur else 7))
    except (TypeError, ValueError):
        raise ValueError("hour must be 0-23") from None
    if not 0 <= hour <= 23:
        raise ValueError("hour must be 0-23")
    weekday = data.get("weekday", cur.weekday if cur else None)
    dom = data.get("day_of_month", cur.day_of_month if cur else None)
    if cadence == "weekly":
        try:
            weekday = int(0 if weekday is None else weekday)
        except (TypeError, ValueError):
            raise ValueError("weekday must be 0 (Monday) to 6 (Sunday)") \
                from None
        if not 0 <= weekday <= 6:
            raise ValueError("weekday must be 0 (Monday) to 6 (Sunday)")
        dom = None
    elif cadence == "monthly":
        try:
            dom = int(1 if dom is None else dom)
        except (TypeError, ValueError):
            raise ValueError("day_of_month must be 1-31") from None
        if not 1 <= dom <= 31:
            raise ValueError("day_of_month must be 1-31")
        weekday = None
    else:
        weekday = dom = None
    return {"cadence": cadence, "hour": hour, "weekday": weekday,
            "day_of_month": dom}


def _check_report(ref: str, version: str, user_id: int | None) -> dict:
    spec, meta = report_saved.resolve(ref, version or None,
                                      user_id=user_id)
    report_engine.validate(spec, mask_pii=True)
    return meta


def _describe(r: ReportSchedule) -> str:
    h = f"{r.hour:02d}:00"
    if r.cadence == "daily":
        return f"Daily at {h}"
    if r.cadence == "weekly":
        return f"Every {_WEEKDAYS[r.weekday or 0]} at {h}"
    return f"Monthly on day {r.day_of_month or 1} at {h}"


def schedule_dict(r: ReportSchedule, tz=None) -> dict:
    tz = tz or org_config.org_tz()
    return {
        "id": r.id,
        "report_ref": r.report_ref,
        "version": r.version or "",
        "name": r.name,
        "cadence": r.cadence,
        "weekday": r.weekday,
        "day_of_month": r.day_of_month,
        "hour": r.hour,
        "when": _describe(r),
        "recipients": [e for e in (r.recipients or "").split(",") if e],
        "format": r.format,
        "active": bool(r.active),
        "last_run_at": _org_iso(r.last_run_at, tz),
        "next_run_at": _org_iso(r.next_run_at, tz) if r.active else None,
        "last_status": r.last_status or "",
        "last_error": r.last_error or "",
        "created_by": r.created_by or "",
        "created_at": _org_iso(r.created_at, tz),
        "updated_at": _org_iso(r.updated_at, tz),
    }


# ----- CRUD -----------------------------------------------------------------------

def list_schedules(report_ref: str = "") -> list[dict]:
    org = _org()
    tz = org_config.org_tz()
    with SessionLocal() as s:
        q = select(ReportSchedule).where(ReportSchedule.org_id == org)
        if report_ref:
            q = q.where(ReportSchedule.report_ref == report_ref)
        rows = s.scalars(q.order_by(ReportSchedule.id)).all()
        return [schedule_dict(r, tz) for r in rows]


def create_schedule(data: dict, actor: str = "",
                    user_id: int | None = None) -> dict:
    org = _org()
    ref = str(data.get("report_ref") or "").strip()
    version = str(data.get("version") or "").strip()[:40]
    meta = _check_report(ref, version, user_id)
    timing = _clean_timing(data)
    fmt = str(data.get("format") or "csv").lower()
    if fmt not in FORMATS:
        raise ValueError("format must be csv or xlsx")
    recips = _recipients(data.get("recipients"))
    name = " ".join(str(data.get("name") or "").split())[:160]
    if not name:
        name = meta.get("name") or ref
        if meta.get("version_label"):
            name = f"{name} — {meta['version_label']}"
    active = bool(data.get("active", True))
    now = datetime.now()
    tz = org_config.org_tz()
    nxt = next_run(timing["cadence"], timing["hour"], timing["weekday"],
                   timing["day_of_month"], org_config.org_now(), tz)
    r = ReportSchedule(
        org_id=org, report_ref=meta["ref"], version=meta.get("version")
        or "", name=name[:160], **timing, recipients=",".join(recips),
        format=fmt, active=active,
        next_run_at=_server_naive(nxt) if active else None,
        last_status="", last_error="", created_by=(actor or "")[:80],
        created_at=now, updated_at=now)
    with SessionLocal() as s:
        s.add(r)
        s.commit()
        return schedule_dict(r, tz)


def update_schedule(schedule_id: int, data: dict,
                    user_id: int | None = None) -> dict | None:
    org = _org()
    tz = org_config.org_tz()
    with SessionLocal() as s:
        r = s.get(ReportSchedule, schedule_id)
        if r is None or r.org_id != org:
            return None
        if "report_ref" in data or "version" in data:
            ref = str(data.get("report_ref", r.report_ref) or "").strip()
            version = str(data.get("version", r.version) or "").strip()[:40]
            # Solo se re-valida (con la visibilidad de QUIEN edita) si el
            # reporte cambia: editar destinatarios / hora de un schedule de
            # un reporte 'mine' de otro usuario no debe fallar (el envío
            # resuelve con system=True).
            if ref != (r.report_ref or "") or version != (r.version or ""):
                meta = _check_report(ref, version, user_id)
                r.report_ref = meta["ref"]
                r.version = meta.get("version") or ""
        timing_keys = {"cadence", "hour", "weekday", "day_of_month"}
        reschedule = False
        if timing_keys & set(data):
            for k, v in _clean_timing(data, r).items():
                setattr(r, k, v)
            reschedule = True
        if "format" in data:
            fmt = str(data.get("format") or "").lower()
            if fmt not in FORMATS:
                raise ValueError("format must be csv or xlsx")
            r.format = fmt
        if "recipients" in data:
            r.recipients = ",".join(_recipients(data.get("recipients")))
        if "name" in data:
            name = " ".join(str(data.get("name") or "").split())[:160]
            if not name:
                raise ValueError("schedule name is required")
            r.name = name
        if "active" in data:
            was = bool(r.active)
            r.active = bool(data.get("active"))
            if r.active and not was:
                reschedule = True
        if reschedule or (r.active and r.next_run_at is None):
            r.next_run_at = _server_naive(next_run(
                r.cadence, r.hour, r.weekday, r.day_of_month,
                org_config.org_now(), tz)) if r.active else None
        if not r.active:
            r.next_run_at = None
        r.updated_at = datetime.now()
        s.commit()
        return schedule_dict(r, tz)


def delete_schedule(schedule_id: int) -> bool:
    org = _org()
    with SessionLocal() as s:
        r = s.get(ReportSchedule, schedule_id)
        if r is None or r.org_id != org:
            return False
        s.delete(r)
        s.commit()
        return True


# ----- Ejecución -----------------------------------------------------------------------

async def _execute(snap: dict) -> tuple[str, str, int]:
    """Corre el reporte del schedule y lo envía. (status, error, filas).
    No toca la base (el llamador registra el resultado)."""
    try:
        spec, meta = report_saved.resolve(snap["report_ref"],
                                          snap["version"] or None,
                                          system=True)
        result = await report_engine.run(spec, mask_pii=True)
    except ValueError as exc:
        return "error", f"report failed: {exc}"[:300], 0
    title = meta.get("name") or snap["name"]
    period = ""
    if result.get("time"):
        t = result["time"]
        period = t["label"]
        if t.get("from") or t.get("to"):
            period += f" ({t.get('from') or '…'} – {t.get('to') or '…'})"
    subtitle = " · ".join(x for x in (meta.get("version_label"), period)
                          if x)
    data, mime, fname = report_export.render(result, snap["format"], title,
                                             subtitle)
    filters = report_engine.describe_filters(result["spec"])
    lines = [
        title,
        subtitle,
        "",
        f"{result['row_count']:,} row(s) — attached as "
        f"{snap['format'].upper()} ({fname}).",
    ]
    if result.get("truncated"):
        lines.append(f"Showing the first {result['row_count']:,} of "
                     f"{result['total_count']:,} rows.")
    if filters:
        lines.append("Filters: " + "; ".join(filters))
    lines += ["", f"Scheduled report \"{snap['name']}\" "
                  f"({snap['when']}). Contact details are hidden in "
                  "scheduled emails.", "", "Rigsmith"]
    recips = [e for e in snap["recipients"] if e]
    settings = mailer.load_settings()
    res = await asyncio.to_thread(
        mailer.send_email, settings, recips[0], recips[1:],
        f"Rigsmith report: {title}"
        + (f" ({meta['version_label']})" if meta.get("version_label")
           else ""),
        "\n".join(x for x in lines if x is not None),
        "", [(fname, data, mime)])
    if res.get("simulated"):
        return ("dry_run", "Email isn't configured or is in test mode — "
                "nothing was sent.", result["row_count"])
    if not res.get("ok"):
        return "error", f"email failed: {res.get('error')}"[:300], \
            result["row_count"]
    return "sent", "", result["row_count"]


def _snap(r: ReportSchedule) -> dict:
    return {"id": r.id, "report_ref": r.report_ref,
            "version": r.version or "", "name": r.name,
            "format": r.format, "when": _describe(r),
            "recipients": [e for e in (r.recipients or "").split(",") if e]}


def _record(org: int, schedule_id: int, status: str, error: str) -> None:
    with SessionLocal() as s:
        s.execute(update(ReportSchedule)
                  .where(ReportSchedule.id == schedule_id,
                         ReportSchedule.org_id == org)
                  .values(last_run_at=datetime.now().replace(microsecond=0),
                          last_status=status, last_error=error[:300]))
        s.commit()


async def send_now(schedule_id: int) -> dict | None:
    """Envío manual inmediato ("Send now"): no mueve next_run_at."""
    org = _org()
    with SessionLocal() as s:
        r = s.get(ReportSchedule, schedule_id)
        if r is None or r.org_id != org:
            return None
        snap = _snap(r)
    status, error, rows = await _execute(snap)
    _record(org, schedule_id, status, error)
    with SessionLocal() as s:
        out = schedule_dict(s.get(ReportSchedule, schedule_id))
    out["rows"] = rows
    return out


def _claim(org: int, r: ReportSchedule, tz) -> bool:
    """Avanza next_run_at SOLO si nadie lo hizo antes (UPDATE condicional
    sobre el valor leído). True = este worker es el dueño del envío."""
    nxt = _server_naive(next_run(r.cadence, r.hour, r.weekday,
                                 r.day_of_month, org_config.org_now(), tz))
    with SessionLocal() as s:
        res = s.execute(update(ReportSchedule)
                        .where(ReportSchedule.id == r.id,
                               ReportSchedule.org_id == org,
                               ReportSchedule.next_run_at == r.next_run_at)
                        .values(next_run_at=nxt))
        s.commit()
        return (res.rowcount or 0) == 1


async def run_due(org: int) -> int:
    """Envía los schedules vencidos de UNA org (tenant ya fijado)."""
    now = datetime.now()
    tz = org_config.org_tz()
    with SessionLocal() as s:
        due = s.scalars(select(ReportSchedule).where(
            ReportSchedule.org_id == org,
            ReportSchedule.active.is_(True),
            ReportSchedule.next_run_at.is_not(None),
            ReportSchedule.next_run_at <= now)
            .order_by(ReportSchedule.next_run_at)).all()
        s.expunge_all()
    sent = 0
    for r in due:
        if not _claim(org, r, tz):
            continue
        try:
            status, error, _rows = await _execute(_snap(r))
        except Exception as exc:  # noqa: BLE001 — un envío roto no frena
            status, error = "error", f"unexpected error: {exc}"[:300]
        _record(org, r.id, status, error)
        sent += 1
    return sent


async def maybe_run() -> int:
    """Hook del loop de background (cada minuto): recorre las orgs activas
    con su tenant fijado. Nunca lanza."""
    total = 0
    try:
        with SessionLocal() as s:
            orgs = [o for (o,) in s.execute(select(Organization.id).where(
                Organization.active.is_(True))).all()]
    except Exception:  # noqa: BLE001
        return 0
    for org in orgs:
        token = tenant.set_current_org(org)
        try:
            total += await run_due(org)
        except Exception:  # noqa: BLE001
            pass
        finally:
            tenant.reset_current_org(token)
    return total
