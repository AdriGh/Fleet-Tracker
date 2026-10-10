# -*- coding: utf-8 -*-
"""Tableros de mantenimiento (fase H1 + v2.22): PM, DOT Inspections y
Reefer PM.

Una sola fuente de lógica para los dashboards:
- PM: combina el CSV de Fullbay (pm.py), los overrides manuales y los
  registros nuevos de la tabla `maint_record` (kind='pm'). El último PM
  es el más reciente POR FECHA entre CSV y registros; el override de
  `last_pm_miles` sigue mandando sobre las millas (corrección puntual).
- DOT: inspección anual. Universo = camiones del CSV de PM + cualquier
  unidad con registro DOT. Próxima inspección = última + 365 días.
- Reefer PM (v2.22): PM del equipo de frío por HORAS DE MOTOR (core/meters,
  tabla meter_reading — JAMÁS el odómetro, que es el error de SquareRigger)
  con la fecha como respaldo: vence lo que llegue primero (horas o días).
  Universo = meters.reefer_units() (subtipo reefer, feed del reefer,
  unidades con horas o con registros, opt-in del perfil).

Una sola evaluación de vencimiento (`eval_due`) para board(),
unit_campaigns() y due() (la tarjeta "PMs Due & Overdue" del Home): los tres
nunca se contradicen. "Hoy" es el de la zona de la org (org_config).

Estados automáticos: on_track | upcoming | overdue | never (+ no_meter
para PM sin odómetro). Estados manuales por unidad (units.local.json):
out_of_service | in_shop — pisan al automático en los tableros (la fila
conserva el automático en `due_status`).
"""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta

from sqlalchemy import select

from ..db import MaintRecord, SessionLocal, TmsDriver
from . import (manual_units, meters, org_config, pm, samsara,
               unit_settings)

OPS_STATUSES = ("", "out_of_service", "in_shop")
DOT_INTERVAL_DAYS = 365
DOT_UPCOMING_DAYS = 30

# Catálogo de campañas de mantenimiento por unidad (fase H3, estilo
# Fullbay). pm y dot vienen habilitadas por defecto; el resto se agrega
# por unidad desde el perfil. due: miles | days | hours | none (solo
# registra el último servicio, sin vencimiento).
# v2.22 'reefer': por horas de motor (+ días de respaldo). `auto`: se prende
# SOLA en las unidades reefer (meters.reefer_units); el perfil puede
# apagarla (opt-out) o prenderla en cualquier unidad (opt-in).
CAMPAIGNS = {
    "pm": {"label": "Full Wet Service (PM)", "due": "miles",
           "default": True},
    "dot": {"label": "Federal Annual DOT Inspection", "due": "days",
            "days": DOT_INTERVAL_DAYS, "default": True},
    "reefer": {"label": "Reefer PM (engine hours)", "due": "hours",
               "default": False, "auto": "reefer",
               "thresholds": {
                   "interval_hours": "reefer_pm_interval_hours",
                   "upcoming_hours": "reefer_pm_upcoming_hours",
                   "interval_days": "reefer_pm_interval_days",
                   "upcoming_days": "reefer_pm_upcoming_days",
               }},
    "kingpins": {"label": "Check kingpins", "due": "days", "days": 365,
                 "default": False},
    "dpf": {"label": "DPF replacement", "due": "none", "default": False},
    "clutch": {"label": "Clutch replacement", "due": "none",
               "default": False},
}
KINDS = tuple(CAMPAIGNS)              # kinds válidos de maint_record
_BOARD_KINDS = ("pm", "dot", "reefer")  # tableros globales
_STATUS_RANK = {"on_track": 0, "upcoming": 1, "overdue": 2}
_UNIT_LABEL = {"miles": "mi", "days": "days", "hours": "hrs"}
_MAX_HOURS = 200_000.0


def pm_label(model: str) -> str:
    """Nombre del PM según el motor del make (regla del usuario)."""
    m = (model or "").lower()
    if "freightliner" in m or "cascadia" in m:
        return "Full Wet Service (PM) DD13/DD15"
    if "international" in m or "lt625" in m:
        return "Full Wet Service (PM) ISX"
    return "Full Wet Service (PM)"


def _sr_stale() -> None:
    """Cambió lo que vence (registro de PM/DOT): el backlog de Service
    Requests re-sincroniza en el próximo GET en vez de esperar el TTL."""
    from . import service_requests       # import diferido (ciclo de imports)
    service_requests.mark_stale()


# ----- Vencimiento (compartido por board / unit_campaigns / due) ------------

def due_config(key: str) -> dict:
    """Umbrales de la campaña `key` (de org_config, editables en Settings)."""
    meta = CAMPAIGNS[key]
    due = meta["due"]
    if due == "miles":
        return {"interval_miles": org_config.threshold("pm_interval_miles"),
                "upcoming_miles": org_config.threshold("pm_upcoming_miles")}
    if due == "days":
        return {"interval_days": int(meta.get("days") or DOT_INTERVAL_DAYS),
                "upcoming_days": DOT_UPCOMING_DAYS}
    if due == "hours":
        return {k: org_config.threshold(v)
                for k, v in meta["thresholds"].items()}
    return {}


def _whole_hours(h: float) -> int:
    """Horas de motor enteras, .5 hacia arriba (igual que el frontend)."""
    return int(math.floor(h + 0.5))


def _state(to_due: float, window: float) -> str:
    if to_due < 0:
        return "overdue"
    if to_due <= window:
        return "upcoming"
    return "on_track"


def _ratio(to_due: float, window: float) -> float:
    """Cuán cerca está del vencimiento, en "ventanas de aviso" (negativo =
    vencido). Compara horas con días sin convertir unidades."""
    return to_due / window if window else float(to_due)


def eval_due(due: str, last_date: str | None, last_meter, current,
             today: date, cfg: dict) -> dict:
    """Vencimiento de UNA campaña de una unidad.

    - miles: {next_due_miles, to_due (mi), status, due_by}; never / no_meter
      igual que el PM clásico.
    - days: {next_due_date, to_due (días), to_due_days, status, due_by}.
    - hours (PM del reefer): lo que llegue PRIMERO entre horas (último PM +
      intervalo vs horómetro actual) y días (fecha del último PM +
      intervalo). {next_due_hours, next_due_date, to_due (HORAS o None),
      to_due_days, status (el peor de los dos), due_by ('hours'|'days': el
      que vence primero), meter_missing (sin lectura de horas: solo días)}.
      Si el horómetro quedó POR DEBAJO del último PM (controlador cambiado o
      reseteado) las horas no sirven: solo días + `meter_reset`.
    - none: {to_due None, status tracked | never}."""
    if due == "miles":
        interval, upcoming = cfg["interval_miles"], cfg["upcoming_miles"]
        next_due = (last_meter + interval
                    if last_meter is not None else None)
        remaining = (next_due - current
                     if next_due is not None and current is not None
                     else None)
        if last_meter is None and last_date is None:
            status = "never"
        elif remaining is None:
            status = "no_meter"
        else:
            status = _state(remaining, upcoming)
        return {"next_due_miles": next_due, "to_due": remaining,
                "to_due_days": None, "status": status, "due_by": "miles"}

    if due == "days":
        if last_date:
            nd = date.fromisoformat(last_date) \
                + timedelta(days=cfg["interval_days"])
            days = (nd - today).days
            return {"next_due_date": nd.isoformat(), "to_due": days,
                    "to_due_days": days,
                    "status": _state(days, cfg["upcoming_days"]),
                    "due_by": "days"}
        return {"next_due_date": None, "to_due": None, "to_due_days": None,
                "status": "never", "due_by": "days"}

    if due == "hours":
        ih, uh = cfg["interval_hours"], cfg["upcoming_hours"]
        idays, udays = cfg["interval_days"], cfg["upcoming_days"]
        out: dict = {"next_due_hours": None, "next_due_date": None,
                     "to_due": None, "to_due_days": None, "due_by": None,
                     "meter_missing": current is None}
        if last_date is None and last_meter is None:
            out["status"] = "never"
            return out
        parts: list[tuple[str, float, str]] = []
        if last_meter is not None:
            # Horas enteras con redondeo half-up: Python (half-even) y JS
            # (half-up) mostraban 19,480 vs 19,481 para el mismo .5.
            out["next_due_hours"] = _whole_hours(last_meter + ih)
            if current is not None:
                if current < last_meter - 1:
                    out["meter_reset"] = True
                else:
                    to_h = out["next_due_hours"] - _whole_hours(current)
                    out["to_due"] = to_h
                    parts.append((_state(to_h, uh), _ratio(to_h, uh),
                                  "hours"))
        if last_date:
            nd = date.fromisoformat(last_date) + timedelta(days=idays)
            days = (nd - today).days
            out["next_due_date"] = nd.isoformat()
            out["to_due_days"] = days
            parts.append((_state(days, udays), _ratio(days, udays), "days"))
        if not parts:
            out["status"] = "no_meter"
            return out
        worst = max(parts, key=lambda p: (_STATUS_RANK[p[0]], -p[1]))
        out["status"], out["due_by"] = worst[0], worst[2]
        return out

    return {"to_due": None, "to_due_days": None,
            "status": "tracked" if last_date else "never", "due_by": None}


def _urgency(row: dict, cfg: dict) -> float:
    """Clave de orden de una fila del board del reefer (más urgente
    primero): la menor de las dos ventanas (horas / días)."""
    rs: list[float] = []
    if row.get("to_due") is not None:
        rs.append(_ratio(row["to_due"], cfg["upcoming_hours"]))
    if row.get("to_due_days") is not None:
        rs.append(_ratio(row["to_due_days"], cfg["upcoming_days"]))
    return min(rs) if rs else 1e12


# ----- Registros --------------------------------------------------------------

def _clean_hours(hours) -> float | None:
    if hours in (None, ""):
        return None
    try:
        v = float(hours)
    except (TypeError, ValueError):
        raise ValueError("hours must be a number")
    if not math.isfinite(v) or v <= 0 or v >= _MAX_HOURS:
        raise ValueError("hours must be a positive number")
    return round(v, 1)


def add_record(unit: str, kind: str, date_iso: str,
               mileage: int | None = None, notes: str = "",
               hours: float | None = None) -> dict:
    """Registra un servicio de la campaña `kind`. `hours` (v2.22): horas de
    motor del servicio; si viene, también se registra como lectura del
    horómetro (fuente 'maint', best-effort: una lectura no creíble no
    impide el registro). En una campaña POR HORAS sin `hours` (p.ej. una WO
    facturada sin el dato) se toma la lectura del horómetro de ese día
    (meters.value_at), así el próximo vencimiento por horas sigue andando."""
    unit = (unit or "").strip()
    if not unit:
        raise ValueError("unit is required")
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {KINDS}")
    try:
        date.fromisoformat(date_iso)
    except (TypeError, ValueError):
        raise ValueError("date must be YYYY-MM-DD")
    hrs = _clean_hours(hours)
    derived = False
    if hrs is None and CAMPAIGNS[kind]["due"] == "hours":
        hrs = meters.value_at(unit, date_iso)
        derived = hrs is not None
    with SessionLocal() as session:
        rec = MaintRecord(
            unit=unit[:64], kind=kind, date=date_iso,
            mileage=int(mileage) if mileage not in (None, "") else None,
            hours=hrs,
            notes=(notes or "").strip()[:300],
            created_at=datetime.now(),
        )
        session.add(rec)
        session.commit()
        out = {"id": rec.id, "unit": rec.unit, "kind": rec.kind,
               "date": rec.date, "mileage": rec.mileage,
               "hours": rec.hours, "notes": rec.notes}
    if hrs is not None and not derived:
        try:
            meters.log_reading(unit, hrs, date_iso, source="maint")
        except ValueError:
            pass        # el registro manda; la lectura es best-effort
    _sr_stale()
    return out


def latest_by_unit(kind: str) -> dict[str, dict]:
    """Último registro por unidad (por fecha y, a igual fecha, el más
    nuevo). Devuelve {unit: {date, mileage, hours, notes}}."""
    out: dict[str, dict] = {}
    with SessionLocal() as session:
        rows = session.scalars(
            select(MaintRecord).where(MaintRecord.kind == kind)
            .order_by(MaintRecord.date, MaintRecord.id)).all()
    for r in rows:           # el orden ascendente deja ganar al último
        out[r.unit] = {"date": r.date, "mileage": r.mileage,
                       "hours": r.hours, "notes": r.notes}
    return out


def _latest_by_norm(kind: str) -> dict[str, dict]:
    """Como latest_by_unit pero por unidad NORMALIZADA (meters.norm_unit):
    'TRL 53108' y 'TRL53108' son la misma fila del board del reefer."""
    out: dict[str, dict] = {}
    with SessionLocal() as session:
        rows = session.scalars(
            select(MaintRecord).where(MaintRecord.kind == kind)
            .order_by(MaintRecord.date, MaintRecord.id)).all()
    for r in rows:
        out[meters.norm_unit(r.unit)] = {
            "unit": r.unit, "date": r.date, "mileage": r.mileage,
            "hours": r.hours, "notes": r.notes}
    return out


def _reefer_baseline() -> dict[str, dict]:
    """Último PM del reefer que NO está en maint_record (el "CSV" del
    reefer): en demo, demo_eld.reefer_pm_rows() relativo a hoy; con datos
    reales, nada. {norm: {unit, last_date, last_hours}}."""
    if not samsara._demo():
        return {}
    from . import demo_eld               # import diferido (orden de carga)
    return {meters.norm_unit(r["unit"]): r for r in demo_eld.reefer_pm_rows()}


def set_ops_status(unit: str, status: str) -> None:
    if status not in OPS_STATUSES:
        raise ValueError(f"status must be one of {OPS_STATUSES}")
    unit_settings.set_ops_status(unit, status)


def _driver_by_truck() -> dict[str, str]:
    """Asignación driver→truck de los perfiles TMS (barato, sin red)."""
    with SessionLocal() as session:
        rows = session.scalars(select(TmsDriver)).all()
    return {r.truck.strip(): r.name for r in rows if (r.truck or "").strip()}


def _mdy_to_iso(mdy: str | None) -> str | None:
    """'3/31/2026' (CSV Fullbay) -> '2026-03-31'."""
    if not mdy:
        return None
    try:
        mo, da, yr = (int(x) for x in mdy.split("/"))
        return f"{yr:04d}-{mo:02d}-{da:02d}"
    except ValueError:
        return None


# ----- Tableros -----------------------------------------------------------------

async def board(kind: str, refresh: bool = False) -> dict:
    if kind not in _BOARD_KINDS:
        raise ValueError(f"kind must be one of {_BOARD_KINDS}")
    if kind == "reefer":
        return await _reefer_board(refresh)
    cfg_pm = due_config("pm")
    interval = cfg_pm["interval_miles"]
    upcoming_mi = cfg_pm["upcoming_miles"]
    cfg_dot = due_config("dot")
    if refresh:
        samsara.clear_cache()

    csv_rows = {r["unit"]: r for r in pm.load()}
    overrides = pm.load_overrides()
    records = latest_by_unit(kind)
    drivers = _driver_by_truck()
    ops = unit_settings.ops_statuses()

    # Fallas de Samsara: el board se arma igual (con el meter del CSV) pero
    # se avisa en `errors` — service_requests no da nada por resuelto con un
    # board incompleto (sin odómetro, to_due sale None o con millas viejas).
    errors: list[str] = []
    odo: dict = {}
    if samsara.is_available():
        try:
            odo = await samsara.vehicle_odometers()
        except Exception:  # noqa: BLE001
            odo = {}
            errors.append("odometer")

    # H-fleet: traer las terminales y sus unidades (camiones) al tracker. Se
    # suman los CAMIONES del fleet de Samsara al universo, y se arma un mapa
    # year/make/model (fleet + manuales) para mostrarlo aunque no esten en el
    # CSV. Las terminales se resuelven en el front por el prefijo del numero.
    def _ymm(u: dict) -> str:
        return " ".join(str(x).strip() for x in
                        (u.get("year"), u.get("make"), u.get("model"))
                        if str(x or "").strip())

    extra_model: dict[str, str] = {}
    fleet_trucks: set[str] = set()
    if samsara.is_available():
        try:
            for fu in await samsara.list_fleet():
                if fu.get("unit_type") == "truck" and fu.get("unit"):
                    fleet_trucks.add(fu["unit"])
                    extra_model[fu["unit"]] = _ymm(fu)
        except Exception:  # noqa: BLE001
            fleet_trucks = set()
            errors.append("fleet")
    for mu in manual_units.list_units():
        if mu.get("unit"):
            extra_model.setdefault(mu["unit"], _ymm(mu))

    # Universo: camiones del CSV + cualquier unidad con registro del kind +
    # las unidades manuales + los camiones del fleet (terminales y sus
    # unidades).
    units = sorted(set(csv_rows) | set(records)
                   | manual_units.names() | fleet_trucks)
    today = org_config.org_today()
    out: list[dict] = []
    excluded: list[dict] = []

    for unit in units:
        csv_r = csv_rows.get(unit, {})
        ou = overrides.get(unit, {})
        if ou.get("exclude"):
            excluded.append({"unit": unit, "model": csv_r.get("model", "")})
            continue
        rec = records.get(unit)

        # Millaje actual: override manual > Samsara > meter del CSV.
        if ou.get("current_miles") is not None:
            current, source = int(ou["current_miles"]), "manual"
        else:
            o = odo.get(unit)
            current = o["miles"] if o else csv_r.get("report_miles")
            source = o["source"] if o else (
                "report" if csv_r.get("report_miles") else None)

        row: dict = {
            "unit": unit,
            "model": csv_r.get("model") or extra_model.get(unit, ""),
            "driver": drivers.get(unit, ""),
            "current_miles": current,
            "current_source": source,
            "current_overridden": "current_miles" in ou,
            "ops_status": ops.get(unit, ""),
            "notes": (rec or {}).get("notes", ""),
        }

        if kind == "pm":
            # Último PM: más reciente POR FECHA entre CSV y registros.
            csv_date = _mdy_to_iso(csv_r.get("last_pm_date"))
            csv_miles = csv_r.get("last_pm_miles")
            if rec and (not csv_date or rec["date"] >= csv_date):
                last_date, last_miles = rec["date"], rec["mileage"]
                last_source = "record"
            else:
                last_date, last_miles = csv_date, csv_miles
                # Fila demo relativa a hoy: ciclo fijo en Service Requests.
                last_source = "baseline" if csv_r.get("baseline") else "csv"
            if ou.get("last_pm_miles") is not None:
                last_miles = int(ou["last_pm_miles"])
                last_source = "override"
            row.update({
                "last_date": last_date,
                "last_miles": last_miles,
                "last_source": last_source,
                "last_overridden": "last_pm_miles" in ou,
                # next_due_miles, to_due (millas), status, due_by
                **eval_due("miles", last_date, last_miles, current, today,
                           cfg_pm),
            })
        else:                                  # dot
            last_date = (rec or {}).get("date")
            last_miles = (rec or {}).get("mileage")
            row.update({
                # next_due_date, to_due (días), status, due_by
                **eval_due("days", last_date, None, None, today, cfg_dot),
                "last_date": last_date, "last_miles": last_miles,
            })

        # El vencimiento automático se conserva en `due_status` (Home / SR
        # lo leen); el estado manual de operaciones pisa `status`.
        row["due_status"] = row["status"]
        if row["ops_status"]:
            row["status"] = row["ops_status"]
        out.append(row)

    # Urgencia primero (mismo criterio que el PM clásico).
    out.sort(key=lambda x: (x["to_due"] if x["to_due"] is not None
                            else 1e12, x["unit"]))
    return {
        "available": bool(out) or pm.is_available(),
        "kind": kind,
        "interval_miles": interval,
        "upcoming_miles": upcoming_mi,
        "interval_days": DOT_INTERVAL_DAYS,
        "upcoming_days": DOT_UPCOMING_DAYS,
        "units": out,
        "excluded": sorted(excluded, key=lambda e: e["unit"]),
        "errors": errors,
    }


async def _reefer_board(refresh: bool = False) -> dict:
    """Tablero "Reefer PM" (v2.22): una fila por reefer con horómetro
    actual (meter_reading), último PM (registro 'reefer' o, en demo, el
    baseline), próximo vencimiento por horas Y por fecha, y `due_by` = el
    que llega primero. Las unidades se cruzan NORMALIZADAS (registros,
    lecturas, exclusiones y estados de operación). `errors` avisa si la
    detección de reefers vino parcial (flota / feed caídos): Service
    Requests no da nada por resuelto con ese board."""
    cfg = due_config("reefer")
    pm_cfg = due_config("pm")
    if refresh:
        meters.clear_cache()
        samsara.clear_cache()
    det = await meters.reefer_units(refresh=refresh)
    names: dict[str, str] = det["units"]
    models: dict[str, str] = det["models"]
    errors: list[str] = list(det["errors"])
    records = _latest_by_norm("reefer")
    base = _reefer_baseline()
    current = meters.latest_all(meters.ENGINE_HOURS)
    overrides = pm.load_overrides()
    excl = {meters.norm_unit(u) for u, o in overrides.items()
            if isinstance(o, dict) and o.get("exclude")}
    ops = {meters.norm_unit(u): s
           for u, s in unit_settings.ops_statuses().items()}
    today = org_config.org_today()

    out: list[dict] = []
    excluded: list[dict] = []
    for n, unit in sorted(names.items(), key=lambda kv: kv[1]):
        model = models.get(n, "")
        if n in excl:
            excluded.append({"unit": unit, "model": model})
            continue
        rec = records.get(n)
        b = base.get(n)
        # Último PM: el más reciente POR FECHA entre registro y baseline.
        # `last_source` = de dónde salió ('baseline' = el "CSV" demo, que se
        # recalcula relativo a hoy: Service Requests le da un ciclo FIJO).
        if rec and (not b or rec["date"] >= b["last_date"]):
            last_date, last_hours = rec["date"], rec["hours"]
            last_source = "record"
        elif b:
            last_date, last_hours = b["last_date"], b["last_hours"]
            last_source = "baseline"
        else:
            last_date, last_hours = None, None
            last_source = None
        cur = current.get(n)
        cur_h = cur["value"] if cur else None
        row: dict = {
            "unit": unit,
            "model": model,
            "driver": "",
            "current_hours": cur_h,
            "current_hours_date": cur["date"] if cur else None,
            "current_hours_source": cur["source"] if cur else None,
            # Forma común con los boards PM/DOT (el reefer no usa millas).
            "current_miles": None,
            "current_source": None,
            "current_overridden": False,
            "ops_status": ops.get(n, ""),
            "notes": (rec or {}).get("notes", ""),
            "last_date": last_date,
            "last_hours": last_hours,
            "last_source": last_source,
            "last_miles": None,
            **eval_due("hours", last_date, last_hours, cur_h, today, cfg),
        }
        row["due_status"] = row["status"]
        if row["ops_status"]:
            row["status"] = row["ops_status"]
        out.append(row)

    out.sort(key=lambda r: (_urgency(r, cfg), r["unit"]))
    return {
        "available": True,
        "kind": "reefer",
        "interval_hours": cfg["interval_hours"],
        "upcoming_hours": cfg["upcoming_hours"],
        "interval_days": cfg["interval_days"],
        "upcoming_days": cfg["upcoming_days"],
        # Forma común con los boards PM/DOT (umbrales de millas del PM).
        "interval_miles": pm_cfg["interval_miles"],
        "upcoming_miles": pm_cfg["upcoming_miles"],
        "units": out,
        "excluded": sorted(excluded, key=lambda e: e["unit"]),
        "errors": errors,
    }


def _due_item(kind: str, row: dict, b: dict) -> dict:
    """Fila de un board -> item de GET /api/maint/due (Home)."""
    model = row.get("model") or ""
    item = {"unit": row["unit"], "campaign": kind, "model": model,
            "status": row.get("due_status") or row.get("status"),
            "ops_status": row.get("ops_status") or ""}
    if kind == "pm":
        nxt = row.get("next_due_miles")
        item.update({
            "label": pm_label(model), "due_by": "miles",
            "to_due": row.get("to_due"), "to_due_days": None,
            "unit_label": "mi",
            "next_due": f"{nxt:,} mi" if nxt is not None else "",
            "_rank": _ratio(row["to_due"], b.get("upcoming_miles") or 0),
        })
    elif kind == "dot":
        item.update({
            "label": CAMPAIGNS["dot"]["label"], "due_by": "days",
            "to_due": row.get("to_due"), "to_due_days": row.get("to_due"),
            "unit_label": "days", "next_due": row.get("next_due_date") or "",
            "next_due_date": row.get("next_due_date"),
            "_rank": _ratio(row["to_due"], b.get("upcoming_days") or 0),
        })
    else:                                      # reefer
        by = row.get("due_by") or "days"
        if by == "hours" and row.get("to_due") is not None:
            nh = row.get("next_due_hours")
            to_due = row["to_due"]
            nxt = f"{nh:,.0f} hrs" if nh is not None else ""
        else:
            by = "days"
            to_due = row.get("to_due_days")
            nxt = row.get("next_due_date") or ""
        item.update({
            "label": CAMPAIGNS["reefer"]["label"], "due_by": by,
            "to_due": to_due, "to_due_days": row.get("to_due_days"),
            "unit_label": _UNIT_LABEL[by], "next_due": nxt,
            "next_due_hours": row.get("next_due_hours"),
            "next_due_date": row.get("next_due_date"),
            "current_hours": row.get("current_hours"),
            "meter_missing": bool(row.get("meter_missing")),
            "_rank": _urgency(row, {"upcoming_hours":
                                    b.get("upcoming_hours") or 0,
                                    "upcoming_days":
                                    b.get("upcoming_days") or 0}),
        })
    return item


async def due(limit: int | None = None) -> dict:
    """PMs vencidos y por vencer de TODAS las campañas con tablero (pm, dot,
    reefer) en una sola lista, para la tarjeta "PMs Due & Overdue" del Home
    (y el reporte de PMs vencidos). Sale de los mismos board() — nunca
    contradice al PM Tracker ni al backlog de Service Requests. El estado es
    el AUTOMÁTICO (`due_status`; un in_shop no esconde un PM vencido).

    {items: [{unit, campaign, label, status: overdue|upcoming, due_by:
    miles|days|hours, to_due (en unidades de due_by; negativo = vencido),
    to_due_days, unit_label: mi|days|hrs, next_due, model, …}], counts:
    {overdue, upcoming}, total, errors}. Orden: vencidos primero y, dentro
    de cada grupo, el más urgente (en ventanas de aviso) primero."""
    items: list[dict] = []
    errors: list[str] = []
    for kind in _BOARD_KINDS:
        try:
            b = await board(kind)
        except Exception:  # noqa: BLE001 — un board caído no tumba el Home
            errors.append(kind)
            continue
        errors += [f"{kind}:{e}" for e in b.get("errors") or []]
        for row in b.get("units") or []:
            st = row.get("due_status") or row.get("status")
            if st not in ("overdue", "upcoming"):
                continue
            items.append(_due_item(kind, row, b))
    items.sort(key=lambda i: (0 if i["status"] == "overdue" else 1,
                              i["_rank"], i["unit"], i["campaign"]))
    for i in items:
        i.pop("_rank", None)
    counts = {"overdue": sum(1 for i in items if i["status"] == "overdue"),
              "upcoming": sum(1 for i in items if i["status"] == "upcoming")}
    total = len(items)
    if limit:
        items = items[:max(1, int(limit))]
    return {"items": items, "counts": counts, "total": total,
            "errors": errors}


def _pm_variant_key(label: str) -> str:
    """Clave estable de la variante de PM (para seleccion en el reporte)."""
    if "DD13" in label:
        return "pm_dd"
    if "ISX" in label:
        return "pm_isx"
    return "pm_generic"


async def pm_compliance() -> dict:
    """Reporte fleet-wide de cumplimiento de PM (v2.18, Reports & Analytics).

    "¿Cuántas unidades tienen PM y en qué estado?" — agrupado por VARIANTE
    de motor (DD13/DD15 para Freightliner, ISX para International, genérico
    para el resto) + la inspección DOT como grupo aparte. El front permite
    verlos en conjunto, por separado o selectivamente: acá se devuelve TODO
    agrupado y la selección es un filtro del cliente (una sola request).

    Reusa maint.board() — la misma fuente que el PM Tracker, así el reporte
    nunca contradice al tablero. La variante sale del year/make/model del
    board (el string completo: "2020 International LT" matchea ISX aunque
    el campo model pelado diga solo "LT")."""
    STATUSES = ("on_track", "upcoming", "overdue", "never", "no_meter")

    def new_group(key: str, label: str, kind: str) -> dict:
        g = {"key": key, "label": label, "kind": kind, "units": 0,
             "rows": [], "ops": 0}
        g.update({s: 0 for s in STATUSES})
        return g

    def add(g: dict, row: dict, to_due_unit: str) -> None:
        st = row["status"]
        g["units"] += 1
        g[st if st in STATUSES else "ops"] += 1
        g["rows"].append({
            "unit": row["unit"], "model": row.get("model", ""),
            "driver": row.get("driver", ""), "status": st,
            "last_date": row.get("last_date"),
            "next_due_miles": row.get("next_due_miles"),
            "next_due_date": row.get("next_due_date"),
            "to_due": row.get("to_due"), "to_due_unit": to_due_unit,
        })

    pm_b = await board("pm")
    dot_b = await board("dot")

    groups: dict[str, dict] = {}
    for row in pm_b["units"]:
        label = pm_label(row.get("model") or "")
        key = _pm_variant_key(label)
        g = groups.setdefault(key, new_group(key, label, "pm"))
        add(g, row, "mi")
    dot = new_group("dot", CAMPAIGNS["dot"]["label"], "dot")
    for row in dot_b["units"]:
        add(dot, row, "days")
    if dot["units"]:
        groups["dot"] = dot

    order = ("pm_dd", "pm_isx", "pm_generic", "dot")
    return {
        "available": pm_b["available"],
        "groups": [groups[k] for k in order if k in groups],
    }


async def unit_odometer(unit: str) -> dict:
    """Odómetro actual de una unidad (para el botón del modal Add)."""
    if samsara.is_available():
        try:
            odo = await samsara.vehicle_odometers()
            o = odo.get(unit)
            if o:
                return {"unit": unit, "miles": o["miles"],
                        "source": o["source"]}
        except Exception:  # noqa: BLE001
            pass
    csv_r = next((r for r in pm.load() if r["unit"] == unit), None)
    if csv_r and csv_r.get("report_miles"):
        return {"unit": unit, "miles": csv_r["report_miles"],
                "source": "report"}
    return {"unit": unit, "miles": None, "source": None}


# ----- Campañas por unidad (fase H3 — perfil estilo Fullbay) ----------------

def records_for_unit(unit: str) -> dict[str, list[dict]]:
    """Historial de records de la unidad agrupado por campaña (desc). v2.22:
    la unidad se compara NORMALIZADA ('CAN1' del CSV y 'CAN 1' de la flota
    son la misma), igual que las lecturas del horómetro."""
    norm = meters.norm_unit(unit)
    out: dict[str, list[dict]] = {}
    with SessionLocal() as session:
        spellings = [u for (u,) in session.execute(
            select(MaintRecord.unit).distinct()).all()
            if meters.norm_unit(u) == norm]
        rows = session.scalars(
            select(MaintRecord).where(MaintRecord.unit.in_(spellings))
            .order_by(MaintRecord.date.desc(), MaintRecord.id.desc())
        ).all() if spellings else []
    for r in rows:
        out.setdefault(r.kind, []).append({
            "id": r.id, "date": r.date, "mileage": r.mileage,
            "hours": r.hours, "notes": r.notes,
        })
    return out


async def unit_campaigns(unit: str, model: str = "") -> dict:
    """Pestaña Components & PMs del perfil: cada campaña habilitada con
    su último servicio, próximo vencimiento y status. v2.22: el PM del
    reefer se prende SOLO en las unidades reefer (`auto`) y suma el
    horómetro actual (current_hours*)."""
    cfg_pm = due_config("pm")
    extras = [k for k in unit_settings.campaigns(unit) if k in CAMPAIGNS]
    try:
        reefer_on = await meters.is_reefer(unit)
    except Exception:  # noqa: BLE001 — sin detección, solo el opt-in
        reefer_on = "reefer" in extras
    enabled = [k for k in CAMPAIGNS
               if CAMPAIGNS[k]["default"] or k in extras
               or (k == "reefer" and reefer_on)]
    recs = records_for_unit(unit)

    # Odómetro actual: override > Samsara > meter del CSV de Fullbay.
    csv_r = next((r for r in pm.load() if r["unit"] == unit), {})
    ou = pm.load_overrides().get(unit, {})
    current = None
    source = None
    if ou.get("current_miles") is not None:
        current, source = int(ou["current_miles"]), "manual"
    elif samsara.is_available():
        try:
            o = (await samsara.vehicle_odometers()).get(unit)
            if o:
                current, source = o["miles"], o["source"]
        except Exception:  # noqa: BLE001
            pass
    if current is None and csv_r.get("report_miles"):
        current, source = csv_r["report_miles"], "report"
    # Horómetro (v2.22): medidor propio, nunca el odómetro.
    hrs = meters.latest(unit)

    model = model or csv_r.get("model", "")
    today = org_config.org_today()
    out: list[dict] = []
    for key in enabled:
        meta = CAMPAIGNS[key]
        latest = (recs.get(key) or [{}])[0]
        last_date = latest.get("date")
        last_miles = latest.get("mileage")
        last_hours = latest.get("hours")
        # PM: el CSV de Fullbay también cuenta como último servicio.
        if key == "pm":
            csv_date = _mdy_to_iso(csv_r.get("last_pm_date"))
            if csv_date and (not last_date or csv_date > last_date):
                last_date, last_miles = csv_date, csv_r.get("last_pm_miles")
            if ou.get("last_pm_miles") is not None:
                last_miles = int(ou["last_pm_miles"])
        # Reefer: en demo, el baseline hace de "CSV" del último PM.
        if key == "reefer":
            b = _reefer_baseline().get(meters.norm_unit(unit))
            if b and (not last_date or b["last_date"] > last_date):
                last_date, last_hours = b["last_date"], b["last_hours"]
        row: dict = {
            "key": key,
            "label": pm_label(model) if key == "pm" else meta["label"],
            "due": meta["due"],
            "default": meta["default"],
            # Prendida sola (unidad reefer) y no a mano: apagarla en el
            # perfil es un opt-out explícito.
            "auto": bool(meta.get("auto")) and key not in extras,
            "last_date": last_date,
            "last_miles": last_miles,
            "last_hours": last_hours,
            "records": (recs.get(key) or [])[:5],
        }
        if meta["due"] == "miles":
            row.update(eval_due("miles", last_date, last_miles, current,
                                today, cfg_pm))
        elif meta["due"] == "days":
            row.update(eval_due("days", last_date, None, None, today,
                                due_config(key)))
        elif meta["due"] == "hours":
            row.update(eval_due("hours", last_date, last_hours,
                                hrs["value"] if hrs else None, today,
                                due_config(key)))
        else:                                  # none: solo registro
            row.update(eval_due("none", last_date, None, None, today, {}))
        out.append(row)

    return {
        "unit": unit,
        "model": model,
        "current_miles": current,
        "current_source": source,
        "current_hours": hrs["value"] if hrs else None,
        "current_hours_source": hrs["source"] if hrs else None,
        "current_hours_date": hrs["date"] if hrs else None,
        "campaigns": out,
        "available": [
            {"key": k, "label": CAMPAIGNS[k]["label"]}
            for k in CAMPAIGNS
            if not CAMPAIGNS[k]["default"] and k not in enabled
        ],
    }
