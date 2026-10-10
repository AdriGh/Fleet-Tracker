# -*- coding: utf-8 -*-
"""Home (v2.22, benchmark SquareRigger): GET /api/home/summary.

Todo en la zona horaria de la org (org_config): "hoy" y las semanas
lunes–domingo. Semana ACTUAL vs ANTERIOR para la tarjeta ancha de Work
Orders del Home.

Definiciones (las mismas en todos los números):
- closed = la WO llegó a completed (sello `closed_at`, status completed o
  invoiced). closed_value = Σ costo de sus líneas; inside/outside = cuántas
  de las cerradas son de cada tipo; avg_days_to_close = promedio de
  closed_at − created_at (días, 1 decimal; null sin cerradas).
- new_pm = WOs CREADAS en la semana que son PM (is_pm o campaña pm/reefer).
- service_requests = requests creados en la semana (sin los borrados).
- invoiced_value = Σ total a cobrar (billable, con markup del customer) de
  las WOs facturadas en la semana (`invoiced_at`).
- parts_spend / labor_spend / top_units_week / labor_hours_week = por FECHA
  EFECTIVA de la WO (service_date -> closed_at -> created_at), igual que el
  reporte de gasto. "Labor hours this week" = Σ qty de las líneas de labor
  (no hay reloj de taller todavía).
- pm_due = conteos de maint.due() (PM por millas + DOT + Reefer PM por
  horas de motor): el mismo cálculo que la tarjeta "PMs Due & Overdue".
"""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.orm import selectinload

from ..db import Customer, ServiceRequest, SessionLocal, WorkOrder
from . import customers, org_config, workorders

log = logging.getLogger(__name__)

_PM_TIMEOUT_S = 25.0
_PM_CAMPAIGNS = ("pm", "reefer")


def _empty_week() -> dict:
    return {"closed_wos": 0, "closed_value": 0.0, "inside": 0, "outside": 0,
            "new_pm": 0, "service_requests": 0, "avg_days_to_close": None,
            "invoiced_value": 0.0, "parts_spend": 0.0, "labor_spend": 0.0,
            "labor_hours": 0.0}


def first_name(user: dict | None) -> str:
    if not user:
        return ""
    name = (user.get("name") or "").strip() or (user.get("username") or "")
    return name.split()[0] if name.split() else ""


def _wo_numbers() -> tuple[dict, int, int, int]:
    """(conteo por status, parts_blocking, completed_today, in_progress)."""
    today = org_config.org_today()
    t0, t1 = org_config.org_range(today, today)
    with SessionLocal() as session:
        by_status = dict(session.execute(
            select(WorkOrder.status, func.count())
            .group_by(WorkOrder.status)).all())
        blocking = session.scalar(
            select(func.count()).select_from(WorkOrder).where(
                WorkOrder.waiting_parts.is_(True),
                WorkOrder.status != "invoiced")) or 0
        done_today = session.scalar(
            select(func.count()).select_from(WorkOrder).where(
                WorkOrder.status.in_(("completed", "invoiced")),
                WorkOrder.closed_at >= t0, WorkOrder.closed_at < t1)) or 0
    return by_status, int(blocking), int(done_today), int(
        by_status.get("in_progress", 0))


def weekly(today=None) -> dict:
    """Semana actual vs anterior + top de unidades de la semana actual."""
    today = today or org_config.org_today()
    mon, sun = org_config.week_bounds(today)
    last_mon, last_sun = mon - timedelta(days=7), sun - timedelta(days=7)
    lo, hi = org_config.org_range(last_mon, sun)

    def bucket(d):
        if d is None:
            return None
        if mon <= d <= sun:
            return "this"
        if last_mon <= d <= last_sun:
            return "last"
        return None

    weeks = {"this": _empty_week(), "last": _empty_week()}
    days_to_close: dict[str, list[float]] = {"this": [], "last": []}
    by_unit: dict[str, float] = {}
    with SessionLocal() as session:
        # Superconjunto de las WOs que pueden tocar alguna de las dos
        # semanas (por cualquiera de sus fechas); el corte fino es en Python.
        wos = session.scalars(
            select(WorkOrder).options(selectinload(WorkOrder.lines))
            .where(or_(WorkOrder.closed_at >= lo, WorkOrder.created_at >= lo,
                       WorkOrder.invoiced_at >= lo,
                       WorkOrder.service_date >= last_mon.isoformat()))
        ).all()
        cids = {w.customer_id for w in wos if w.customer_id}
        cmap = ({c.id: c for c in session.scalars(
            select(Customer).where(Customer.id.in_(cids))).all()}
            if cids else {})
        for wo in wos:
            parts = sum(float(ln.qty or 0) * float(ln.unit_cost or 0)
                        for ln in wo.lines if ln.kind == "part")
            labor = sum(float(ln.qty or 0) * float(ln.unit_cost or 0)
                        for ln in wo.lines if ln.kind == "labor")
            hours = sum(float(ln.qty or 0)
                        for ln in wo.lines if ln.kind == "labor")
            total = parts + labor
            if (wo.closed_at is not None
                    and wo.status in ("completed", "invoiced")):
                b = bucket(org_config.to_org_date(wo.closed_at))
                if b:
                    w = weeks[b]
                    w["closed_wos"] += 1
                    w["closed_value"] += total
                    w["outside" if wo.wo_type == "outside" else "inside"] += 1
                    if wo.created_at is not None:
                        days_to_close[b].append(max(0.0, (
                            wo.closed_at - wo.created_at).total_seconds()
                            / 86400.0))
            b = bucket(org_config.to_org_date(wo.created_at))
            if b and (wo.is_pm or (wo.campaign or "") in _PM_CAMPAIGNS):
                weeks[b]["new_pm"] += 1
            if wo.invoiced_at is not None:
                b = bucket(org_config.to_org_date(wo.invoiced_at))
                if b:
                    weeks[b]["invoiced_value"] += customers.billable_total(
                        wo, cmap.get(wo.customer_id))
            b = bucket(workorders.effective_date(wo))
            if b:
                weeks[b]["parts_spend"] += parts
                weeks[b]["labor_spend"] += labor
                weeks[b]["labor_hours"] += hours
                if b == "this" and total > 0:
                    by_unit[wo.unit] = by_unit.get(wo.unit, 0.0) + total
        srs = session.scalars(
            select(ServiceRequest.created_at).where(
                ServiceRequest.created_at >= lo,
                ServiceRequest.created_at < hi,
                ServiceRequest.status != "deleted")).all()
        for created in srs:
            b = bucket(org_config.to_org_date(created))
            if b:
                weeks[b]["service_requests"] += 1
    for b, w in weeks.items():
        vals = days_to_close[b]
        w["avg_days_to_close"] = (round(sum(vals) / len(vals), 1)
                                  if vals else None)
        for k in ("closed_value", "invoiced_value", "parts_spend",
                  "labor_spend"):
            w[k] = round(w[k], 2)
        w["labor_hours"] = round(w["labor_hours"], 2)
    top = sorted(by_unit.items(), key=lambda kv: (-kv[1], kv[0]))[:5]
    return {
        "weeks": weeks,
        "top_units_week": [{"unit": u, "total": round(t, 2)} for u, t in top],
        "ranges": {"this": {"from": mon.isoformat(), "to": sun.isoformat()},
                   "last": {"from": last_mon.isoformat(),
                            "to": last_sun.isoformat()}},
    }


async def _pm_due() -> tuple[dict, bool]:
    from . import maint                   # import diferido (orden de carga)
    try:
        d = await asyncio.wait_for(maint.due(), _PM_TIMEOUT_S)
        c = d.get("counts") or {}
        return {"overdue": int(c.get("overdue", 0)),
                "upcoming": int(c.get("upcoming", 0))}, False
    except Exception:  # noqa: BLE001 — el Home nunca cae por los boards
        log.exception("home: maint.due failed")
        return {"overdue": 0, "upcoming": 0}, True


async def summary(user: dict | None = None) -> dict:
    by_status, blocking, done_today, in_progress = _wo_numbers()
    wk = weekly()
    with SessionLocal() as session:
        open_srs = session.scalar(
            select(func.count()).select_from(ServiceRequest).where(
                ServiceRequest.status == "open")) or 0
    pm_due, pm_error = await _pm_due()
    return {
        "user_first_name": first_name(user),
        "today": org_config.org_today().isoformat(),
        "timezone": org_config.timezone_name(),
        "kpis": {
            "in_progress": in_progress,
            "completed_today": done_today,
            "labor_hours_week": wk["weeks"]["this"]["labor_hours"],
            "parts_blocking": blocking,
            "open_service_requests": int(open_srs),
        },
        "wo_by_status": {
            "open": int(by_status.get("open", 0)),
            "assigned": int(by_status.get("assigned", 0)),
            "in_progress": in_progress,
            "completed": int(by_status.get("completed", 0)),
            "waiting_parts": blocking,
        },
        "weeks": wk["weeks"],
        "week_ranges": wk["ranges"],
        "top_units_week": wk["top_units_week"],
        "pm_due": pm_due,
        "pm_due_error": pm_error,
    }
