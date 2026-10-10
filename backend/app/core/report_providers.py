# -*- coding: utf-8 -*-
"""Providers de Reports (v2.22): fuentes "computadas" del registro.

Cada provider es `async def fn(ctx) -> list[dict]` y arma las filas sobre la
lógica que YA existe en la app (nunca la re-implementa):
  - units           -> fleet_inventory.load() (Samsara/demo + manuales)
  - technicians     -> technicians (roster) + WOs asignadas por nombre
  - drivers         -> tms.list_drivers() + reports.doc_state
  - driver_docs     -> idem, una fila por conductor × documento
  - pm_due          -> maint.due()   (la tarjeta del Home)
  - maint_board     -> maint.board('pm'|'dot'|'reefer')
  - pm_compliance   -> maint.pm_compliance()
  - spend_lines     -> reports.spend_lines()  (paridad con spend_report)
  - cpm             -> reports.cpm_rows()     (paridad con cpm_report)
  - unit_miles      -> odometer.miles_by_unit()

`ctx` (core/report_engine.RunContext) trae: org, today, tz, needed (campos
pedidos), date_from/date_to (rango resuelto de la spec), time_field, cache
y warnings (lista donde el provider avisa datos parciales).

Las llamadas a la base son síncronas: se corren con asyncio.to_thread (el
ContextVar del tenant se copia al hilo).
"""

from __future__ import annotations

import asyncio
from datetime import date, datetime

from sqlalchemy import select


def _period(ctx) -> str:
    a, b = ctx.date_from, ctx.date_to
    if a is None and b is None:
        return "All time"
    return f"{a.isoformat() if a else '…'} – {b.isoformat() if b else '…'}"


def _norm(u: str) -> str:
    return "".join(str(u or "").split()).upper()


def _owners() -> dict[str, str]:
    """{unidad normalizada -> nombre del customer dueño}."""
    from ..db import Customer, CustomerUnit, SessionLocal
    from . import tenant
    org = tenant.get_current_org()
    out: dict[str, str] = {}
    with SessionLocal() as s:
        q = (select(CustomerUnit.unit, Customer.name)
             .join(Customer, (CustomerUnit.customer_id == Customer.id)
                   & (Customer.org_id == org))
             .where(CustomerUnit.org_id == org))
        for unit, name in s.execute(q):
            out[_norm(unit)] = name or ""
    return out


def _odometer_series() -> dict[str, list[tuple[str, int]]]:
    """{unidad -> [(fecha, millas)] ordenado} (máximo por fecha)."""
    from ..db import OdometerReading, SessionLocal
    from . import tenant
    per: dict[str, dict[str, int]] = {}
    with SessionLocal() as s:
        q = select(OdometerReading.unit, OdometerReading.date,
                   OdometerReading.miles).where(
            OdometerReading.org_id == tenant.get_current_org())
        for unit, d, mi in s.execute(q):
            if not d or mi is None:
                continue
            e = per.setdefault(unit, {})
            if d not in e or mi > e[d]:
                e[d] = mi
    return {u: sorted(e.items()) for u, e in per.items()}


def _reading_at(series: list[tuple[str, int]], day: str):
    """Lectura vigente al inicio de `day`: la última <= day; si no hay, la
    primera posterior (datos que arrancan a mitad del período)."""
    before = [x for x in series if x[0] <= day]
    if before:
        return before[-1]
    return series[0] if series else None


def _ctx_terminal(unit: str, company: str, ctx) -> str:
    from . import report_registry
    return report_registry.terminal_label(unit, company, ctx)


def _ctx_group(unit: str, ctx) -> str:
    from . import report_registry
    return report_registry.unit_group(unit, ctx)


# ----- Equipment -------------------------------------------------------------

async def units(ctx) -> list[dict]:
    from . import fleet_inventory, manual_units, meters, unit_settings
    try:
        inv = await fleet_inventory.load()
    except Exception as exc:  # noqa: BLE001 — flota caída: se avisa
        ctx.warnings.append(f"Fleet data unavailable ({exc}); showing "
                            "manually added units only.")
        inv = {"units": manual_units.merge_into_fleet([])}
    if inv.get("error"):
        ctx.warnings.append("The ELD fleet could not be loaded; showing "
                            "manually added units only.")

    def _db_part():
        manual = {m["unit"]: m for m in manual_units.list_units()}
        owners = _owners()
        settings = unit_settings.all_settings()
        need_odo = bool(ctx.needed & {"odometer", "odometer_date",
                                      "odometer_month_start",
                                      "odometer_year_start"})
        series = _odometer_series() if need_odo else {}
        hours = (meters.latest_all(meters.ENGINE_HOURS)
                 if ctx.needed & {"engine_hours", "engine_hours_date"}
                 else {})
        return manual, owners, settings, series, hours

    manual, owners, settings, series, hours = await asyncio.to_thread(
        _db_part)
    month_start = ctx.today.replace(day=1).isoformat()
    year_start = ctx.today.replace(month=1, day=1).isoformat()
    out = []
    for u in inv.get("units") or []:
        unit = str(u.get("unit") or "").strip()
        if not unit:
            continue
        m = manual.get(unit, {})
        st = settings.get(unit) or {}
        s = series.get(unit) or []
        last = s[-1] if s else None
        ms = _reading_at(s, month_start) if s else None
        ys = _reading_at(s, year_start) if s else None
        h = hours.get(meters.norm_unit(unit))
        out.append({
            "unit": unit,
            "name": st.get("nickname") or "",
            "unit_type": u.get("unit_type") or u.get("kind") or "",
            "subtype": m.get("subtype") or u.get("subtype") or "",
            "year": str(u.get("year") or ""),
            "make": u.get("make") or "",
            "model": u.get("model") or "",
            "vin": u.get("vin") or "",
            "plate": u.get("plate") or m.get("plate") or "",
            "plate_state": m.get("plate_state") or "",
            "company": u.get("company") or "",
            "terminal": _ctx_terminal(unit, u.get("company") or "", ctx),
            "group": st.get("group") or "",
            "ops_status": st.get("ops_status") or "",
            "archived": bool(u.get("archived")),
            "customer": owners.get(_norm(unit)) or m.get("customer") or "",
            "source": u.get("source") or ("manual" if m else "samsara"),
            "open_defects": int(u.get("open_defects") or 0),
            "odometer": last[1] if last else None,
            "odometer_date": last[0] if last else None,
            "odometer_month_start": ms[1] if ms else None,
            "odometer_year_start": ys[1] if ys else None,
            "engine_hours": h["value"] if h else None,
            "engine_hours_date": h["date"] if h else None,
        })
    return out


async def unit_miles(ctx) -> list[dict]:
    from . import odometer

    def _run():
        miles = odometer.miles_by_unit(ctx.date_from, ctx.date_to)
        series = _odometer_series()
        return miles, series

    miles, series = await asyncio.to_thread(_run)
    period = _period(ctx)
    lo = ctx.date_from.isoformat() if ctx.date_from else ""
    hi = ctx.date_to.isoformat() if ctx.date_to else "9999-12-31"
    out = []
    for unit, mi in miles.items():
        s = [x for x in series.get(unit) or [] if lo <= x[0] <= hi]
        out.append({
            "period": period, "unit": unit, "miles": mi,
            "terminal": _ctx_terminal(unit, "", ctx),
            "group": _ctx_group(unit, ctx),
            "first_reading": s[0][1] if s else None,
            "last_reading": s[-1][1] if s else None,
        })
    return out


# ----- Personas ----------------------------------------------------------------

async def technicians(ctx) -> list[dict]:
    from ..db import SessionLocal, WorkOrder
    from . import technicians as tech

    def _run():
        rows = tech.list_technicians(active_only=False)
        counts: dict[str, list[int]] = {}
        from . import tenant
        with SessionLocal() as s:
            for mech, status in s.execute(
                    select(WorkOrder.mechanic, WorkOrder.status).where(
                        WorkOrder.org_id == tenant.get_current_org())):
                k = " ".join((mech or "").split()).lower()
                if not k:
                    continue
                e = counts.setdefault(k, [0, 0])
                e[1] += 1
                if status not in ("completed", "invoiced"):
                    e[0] += 1
        return rows, counts

    rows, counts = await asyncio.to_thread(_run)
    out = []
    for t in rows:
        c = counts.get(" ".join((t.get("name") or "").split()).lower(),
                       [0, 0])
        out.append({
            "id": t.get("id"), "name": t.get("name") or "",
            "active": bool(t.get("active", True)),
            "role": t.get("role") or "", "phone": t.get("phone") or "",
            "email": t.get("email") or "",
            "hourly_rate": t.get("hourly_rate"),
            "hire_date": t.get("hire_date") or None,
            "open_wos": c[0], "wo_count": c[1],
        })
    return out


async def _driver_rows(ctx) -> list[dict]:
    from . import tms
    if "drivers" in ctx.cache:
        return ctx.cache["drivers"]
    try:
        rows = await tms.list_drivers()
    except Exception as exc:  # noqa: BLE001
        ctx.warnings.append(f"Driver roster unavailable ({exc}).")
        rows = []
    ctx.cache["drivers"] = rows
    return rows


async def drivers(ctx) -> list[dict]:
    from . import reports
    out = []
    for d in await _driver_rows(ctx):
        row = {
            "name": d.get("name") or "", "company": d.get("company") or "",
            "role": d.get("role") or "", "truck": d.get("truck") or "",
            "trailer": d.get("trailer") or "",
            "hired_date": d.get("hired_date") or None,
            "phone": d.get("phone") or "", "email": d.get("email") or "",
            "license_number": d.get("license_number") or "",
            "license_state": d.get("license_state") or "",
            "has_profile": bool(d.get("has_profile")),
        }
        for key in ("cdl_exp", "med_exp", "mvr_exp", "chouse_exp"):
            state, days = reports.doc_state(str(d.get(key) or ""),
                                            ctx.today)
            short = key[:-4]
            row[key] = str(d.get(key) or "") or None
            row[f"{short}_state"] = state
            row[f"{short}_days"] = days
        out.append(row)
    return out


async def driver_docs(ctx) -> list[dict]:
    from . import reports
    out = []
    for d in await _driver_rows(ctx):
        for key, label in reports.DRIVER_DOCS:
            state, days = reports.doc_state(str(d.get(key) or ""),
                                            ctx.today)
            out.append({
                "driver": d.get("name") or "", "truck": d.get("truck") or "",
                "company": d.get("company") or "",
                "role": d.get("role") or "",
                "doc": key, "doc_label": label,
                "date": str(d.get(key) or "") or None,
                "state": state, "days": days,
                "needs_attention": state in ("expired", "soon", "missing"),
            })
    return out


# ----- PM / compliance -----------------------------------------------------------

async def pm_due(ctx) -> list[dict]:
    from . import maint
    res = await maint.due()
    if res.get("errors"):
        ctx.warnings.append("Some PM data sources were unavailable: "
                            + ", ".join(map(str, res["errors"])))
    owners = await asyncio.to_thread(_owners)
    out = []
    for i in res.get("items") or []:
        unit = i.get("unit") or ""
        out.append({
            "unit": unit, "model": i.get("model") or "",
            "campaign": i.get("campaign"), "label": i.get("label") or "",
            "status": i.get("status"), "due_by": i.get("due_by"),
            "to_due": i.get("to_due"), "unit_label": i.get("unit_label"),
            "to_due_days": i.get("to_due_days"),
            "next_due": i.get("next_due") or "",
            "next_due_date": i.get("next_due_date"),
            "current_hours": i.get("current_hours"),
            "ops_status": i.get("ops_status") or "",
            "customer": owners.get(_norm(unit), ""),
            "terminal": _ctx_terminal(unit, "", ctx),
        })
    return out


_SERVICE = {"pm": "Full Wet Service (PM)",
            "dot": "Federal Annual DOT Inspection",
            "reefer": "Reefer PM (engine hours)"}
_UNIT_LABEL = {"miles": "mi", "days": "days", "hours": "hrs"}


def _days_since(last_date, today: date):
    try:
        d = datetime.strptime(str(last_date)[:10], "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None
    return (today - d).days


async def maint_board(ctx) -> list[dict]:
    from . import maint
    owners = await asyncio.to_thread(_owners)
    out = []
    for kind in ("pm", "dot", "reefer"):
        try:
            b = await maint.board(kind)
        except Exception as exc:  # noqa: BLE001
            ctx.warnings.append(f"{kind.upper()} board unavailable ({exc}).")
            continue
        if b.get("errors"):
            ctx.warnings.append(f"{kind.upper()} board is partial: "
                                + ", ".join(map(str, b["errors"])))
        for r in b.get("units") or []:
            unit = r.get("unit") or ""
            if kind == "pm":
                due_by = "miles"
                to_due = r.get("to_due")
                to_due_days = None
                since = (r["current_miles"] - r["last_miles"]
                         if r.get("current_miles") is not None
                         and r.get("last_miles") is not None else None)
                service = maint.pm_label(r.get("model") or "")
            elif kind == "dot":
                due_by = "days"
                to_due = r.get("to_due")
                to_due_days = r.get("to_due")
                since = _days_since(r.get("last_date"), ctx.today)
                service = _SERVICE["dot"]
            else:
                due_by = r.get("due_by") or "days"
                to_due = (r.get("to_due") if due_by == "hours"
                          else r.get("to_due_days"))
                to_due_days = r.get("to_due_days")
                since = (round(r["current_hours"] - r["last_hours"], 1)
                         if r.get("current_hours") is not None
                         and r.get("last_hours") is not None else None)
                service = _SERVICE["reefer"]
            out.append({
                "campaign": kind, "service": service, "unit": unit,
                "model": r.get("model") or "", "driver": r.get("driver") or "",
                "status": r.get("status") or "",
                "due_status": r.get("due_status") or r.get("status") or "",
                "ops_status": r.get("ops_status") or "",
                "current_miles": r.get("current_miles"),
                "current_hours": r.get("current_hours"),
                "last_date": r.get("last_date"),
                "last_miles": r.get("last_miles"),
                "last_hours": r.get("last_hours"),
                "next_due_miles": r.get("next_due_miles"),
                "next_due_hours": r.get("next_due_hours"),
                "next_due_date": r.get("next_due_date"),
                "to_due": to_due, "to_due_days": to_due_days,
                "due_by": due_by, "unit_label": _UNIT_LABEL.get(due_by, ""),
                "overdue_by": (-to_due if isinstance(to_due, (int, float))
                               and to_due < 0 else 0),
                "since_last": since,
                "meter_missing": bool(r.get("meter_missing")),
                "customer": owners.get(_norm(unit), ""),
                "terminal": _ctx_terminal(unit, "", ctx),
                "group": _ctx_group(unit, ctx),
            })
    return out


async def pm_compliance(ctx) -> list[dict]:
    from . import maint
    res = await maint.pm_compliance()
    out = []
    for g in res.get("groups") or []:
        for r in g.get("rows") or []:
            st = r.get("status") or ""
            out.append({
                "group_key": g.get("key"), "group": g.get("label") or "",
                "kind": g.get("kind"), "unit": r.get("unit") or "",
                "model": r.get("model") or "",
                "driver": r.get("driver") or "", "status": st,
                "compliant": st in ("on_track", "upcoming"),
                "last_date": r.get("last_date"),
                "next_due_miles": r.get("next_due_miles"),
                "next_due_date": r.get("next_due_date"),
                "to_due": r.get("to_due"),
                "to_due_unit": r.get("to_due_unit") or "",
            })
    return out


# ----- Gasto / CPM (paridad con core/reports) -------------------------------

async def spend_lines(ctx) -> list[dict]:
    from . import reports
    # Pre-filtro por el rango solo si la spec filtra por la fecha del gasto
    # (el motor vuelve a aplicar el filtro: idempotente).
    use_range = ctx.time_field == "date"
    rows = await asyncio.to_thread(
        reports.spend_lines,
        ctx.date_from if use_range else None,
        ctx.date_to if use_range else None)
    return rows


async def cpm(ctx) -> list[dict]:
    from . import reports, unit_settings

    def _run():
        rep = reports.cpm_rows(ctx.date_from, ctx.date_to)
        need_odo = bool(ctx.needed & {"odometer"})
        series = _odometer_series() if need_odo else {}
        return rep, unit_settings.all_settings(), series

    rep, settings, series = await asyncio.to_thread(_run)
    period = _period(ctx)
    out = []
    for r in rep.get("by_unit") or []:
        unit = r["unit"]
        st = settings.get(unit) or {}
        s = series.get(unit) or []
        out.append({
            "period": period, "unit": unit,
            "name": st.get("nickname") or "",
            "terminal": _ctx_terminal(unit, "", ctx),
            "group": st.get("group") or "",
            "ops_status": st.get("ops_status") or "",
            "odometer": s[-1][1] if s else None,
            "miles": r.get("miles") or 0,
            "spend": r.get("spend"),
            "labor_spend": r.get("labor_spend"),
            "parts_spend": r.get("parts_spend"),
            "cpm": r.get("cpm"),
            "labor_cpm": r.get("labor_cpm"),
            "parts_cpm": r.get("parts_cpm"),
        })
    if rep.get("units_without_miles"):
        ctx.warnings.append(
            f"{rep['units_without_miles']} unit(s) had spend but no "
            "odometer miles in the period; their CPM is empty.")
    return out
