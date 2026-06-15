# -*- coding: utf-8 -*-
"""Tableros gemelos de mantenimiento (fase H1): PM y DOT Inspections.

Una sola fuente de lógica para ambos dashboards:
- PM: combina el CSV de Fullbay (pm.py), los overrides manuales y los
  registros nuevos de la tabla `maint_record` (kind='pm'). El último PM
  es el más reciente POR FECHA entre CSV y registros; el override de
  `last_pm_miles` sigue mandando sobre las millas (corrección puntual).
- DOT: inspección anual. Universo = camiones del CSV de PM + cualquier
  unidad con registro DOT. Próxima inspección = última + 365 días.

Estados automáticos: on_track | upcoming | overdue | never (+ no_meter
para PM sin odómetro). Estados manuales por unidad (units.local.json):
out_of_service | in_shop — pisan al automático en los dos tableros.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from sqlalchemy import select

from ..db import MaintRecord, SessionLocal, TmsDriver
from . import manual_units, org_config, pm, samsara, unit_settings

OPS_STATUSES = ("", "out_of_service", "in_shop")
DOT_INTERVAL_DAYS = 365
DOT_UPCOMING_DAYS = 30

# Catálogo de campañas de mantenimiento por unidad (fase H3, estilo
# Fullbay). pm y dot vienen habilitadas por defecto; el resto se agrega
# por unidad desde el perfil. due: miles | days | none (solo registra
# el último servicio, sin vencimiento).
CAMPAIGNS = {
    "pm": {"label": "Full Wet Service (PM)", "due": "miles",
           "default": True},
    "dot": {"label": "Federal Annual DOT Inspection", "due": "days",
            "days": DOT_INTERVAL_DAYS, "default": True},
    "kingpins": {"label": "Check kingpins", "due": "days", "days": 365,
                 "default": False},
    "dpf": {"label": "DPF replacement", "due": "none", "default": False},
    "clutch": {"label": "Clutch replacement", "due": "none",
               "default": False},
}
KINDS = tuple(CAMPAIGNS)              # kinds válidos de maint_record
_BOARD_KINDS = ("pm", "dot")          # tableros globales


def pm_label(model: str) -> str:
    """Nombre del PM según el motor del make (regla del usuario)."""
    m = (model or "").lower()
    if "freightliner" in m or "cascadia" in m:
        return "Full Wet Service (PM) DD13/DD15"
    if "international" in m or "lt625" in m:
        return "Full Wet Service (PM) ISX"
    return "Full Wet Service (PM)"


def add_record(unit: str, kind: str, date_iso: str,
               mileage: int | None = None, notes: str = "") -> dict:
    unit = (unit or "").strip()
    if not unit:
        raise ValueError("unit is required")
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {KINDS}")
    try:
        date.fromisoformat(date_iso)
    except (TypeError, ValueError):
        raise ValueError("date must be YYYY-MM-DD")
    with SessionLocal() as session:
        rec = MaintRecord(
            unit=unit[:64], kind=kind, date=date_iso,
            mileage=int(mileage) if mileage not in (None, "") else None,
            notes=(notes or "").strip()[:300],
            created_at=datetime.now(),
        )
        session.add(rec)
        session.commit()
        return {"id": rec.id, "unit": rec.unit, "kind": rec.kind,
                "date": rec.date, "mileage": rec.mileage,
                "notes": rec.notes}


def latest_by_unit(kind: str) -> dict[str, dict]:
    """Último registro por unidad (por fecha y, a igual fecha, el más
    nuevo). Devuelve {unit: {date, mileage, notes}}."""
    out: dict[str, dict] = {}
    with SessionLocal() as session:
        rows = session.scalars(
            select(MaintRecord).where(MaintRecord.kind == kind)
            .order_by(MaintRecord.date, MaintRecord.id)).all()
    for r in rows:           # el orden ascendente deja ganar al último
        out[r.unit] = {"date": r.date, "mileage": r.mileage,
                       "notes": r.notes}
    return out


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


async def board(kind: str, refresh: bool = False) -> dict:
    if kind not in _BOARD_KINDS:
        raise ValueError(f"kind must be one of {_BOARD_KINDS}")
    interval = org_config.threshold("pm_interval_miles")
    upcoming_mi = org_config.threshold("pm_upcoming_miles")
    if refresh:
        samsara.clear_cache()

    csv_rows = {r["unit"]: r for r in pm.load()}
    overrides = pm.load_overrides()
    records = latest_by_unit(kind)
    drivers = _driver_by_truck()
    ops = unit_settings.ops_statuses()

    odo: dict = {}
    if samsara.is_available():
        try:
            odo = await samsara.vehicle_odometers()
        except Exception:  # noqa: BLE001
            odo = {}

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
    for mu in manual_units.list_units():
        if mu.get("unit"):
            extra_model.setdefault(mu["unit"], _ymm(mu))

    # Universo: camiones del CSV + cualquier unidad con registro del kind +
    # las unidades manuales + los camiones del fleet (terminales y sus
    # unidades).
    units = sorted(set(csv_rows) | set(records)
                   | manual_units.names() | fleet_trucks)
    today = date.today()
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
            else:
                last_date, last_miles = csv_date, csv_miles
            if ou.get("last_pm_miles") is not None:
                last_miles = int(ou["last_pm_miles"])
            next_due = (last_miles + interval
                        if last_miles is not None else None)
            remaining = (next_due - current
                         if next_due is not None and current is not None
                         else None)
            if last_miles is None and last_date is None:
                status = "never"
            elif remaining is None:
                status = "no_meter"
            elif remaining < 0:
                status = "overdue"
            elif remaining <= upcoming_mi:
                status = "upcoming"
            else:
                status = "on_track"
            row.update({
                "last_date": last_date,
                "last_miles": last_miles,
                "last_overridden": "last_pm_miles" in ou,
                "next_due_miles": next_due,
                "to_due": remaining,          # millas
                "status": status,
            })
        else:                                  # dot
            last_date = (rec or {}).get("date")
            last_miles = (rec or {}).get("mileage")
            if last_date:
                due = date.fromisoformat(last_date) \
                    + timedelta(days=DOT_INTERVAL_DAYS)
                days = (due - today).days
                if days < 0:
                    status = "overdue"
                elif days <= DOT_UPCOMING_DAYS:
                    status = "upcoming"
                else:
                    status = "on_track"
                row.update({"next_due_date": due.isoformat(),
                            "to_due": days})  # días
            else:
                status = "never"
                row.update({"next_due_date": None, "to_due": None})
            row.update({"last_date": last_date, "last_miles": last_miles,
                        "status": status})

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
    """Historial de records de la unidad agrupado por campaña (desc)."""
    out: dict[str, list[dict]] = {}
    with SessionLocal() as session:
        rows = session.scalars(
            select(MaintRecord).where(MaintRecord.unit == unit)
            .order_by(MaintRecord.date.desc(), MaintRecord.id.desc())).all()
    for r in rows:
        out.setdefault(r.kind, []).append({
            "id": r.id, "date": r.date, "mileage": r.mileage,
            "notes": r.notes,
        })
    return out


async def unit_campaigns(unit: str, model: str = "") -> dict:
    """Pestaña Components & PMs del perfil: cada campaña habilitada con
    su último servicio, próximo vencimiento y status."""
    interval = org_config.threshold("pm_interval_miles")
    upcoming_mi = org_config.threshold("pm_upcoming_miles")
    extras = [k for k in unit_settings.campaigns(unit) if k in CAMPAIGNS]
    enabled = [k for k in CAMPAIGNS
               if CAMPAIGNS[k]["default"] or k in extras]
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

    model = model or csv_r.get("model", "")
    today = date.today()
    out: list[dict] = []
    for key in enabled:
        meta = CAMPAIGNS[key]
        latest = (recs.get(key) or [{}])[0]
        last_date = latest.get("date")
        last_miles = latest.get("mileage")
        # PM: el CSV de Fullbay también cuenta como último servicio.
        if key == "pm":
            csv_date = _mdy_to_iso(csv_r.get("last_pm_date"))
            if csv_date and (not last_date or csv_date > last_date):
                last_date, last_miles = csv_date, csv_r.get("last_pm_miles")
            if ou.get("last_pm_miles") is not None:
                last_miles = int(ou["last_pm_miles"])
        row: dict = {
            "key": key,
            "label": pm_label(model) if key == "pm" else meta["label"],
            "due": meta["due"],
            "default": meta["default"],
            "last_date": last_date,
            "last_miles": last_miles,
            "records": (recs.get(key) or [])[:5],
        }
        if meta["due"] == "miles":
            next_due = (last_miles + interval
                        if last_miles is not None else None)
            remaining = (next_due - current
                         if next_due is not None and current is not None
                         else None)
            if last_miles is None and last_date is None:
                status = "never"
            elif remaining is None:
                status = "no_meter"
            elif remaining < 0:
                status = "overdue"
            elif remaining <= upcoming_mi:
                status = "upcoming"
            else:
                status = "on_track"
            row.update({"next_due_miles": next_due, "to_due": remaining,
                        "status": status})
        elif meta["due"] == "days":
            if last_date:
                due = date.fromisoformat(last_date) \
                    + timedelta(days=meta["days"])
                days = (due - today).days
                status = ("overdue" if days < 0
                          else "upcoming" if days <= DOT_UPCOMING_DAYS
                          else "on_track")
                row.update({"next_due_date": due.isoformat(),
                            "to_due": days, "status": status})
            else:
                row.update({"next_due_date": None, "to_due": None,
                            "status": "never"})
        else:                                  # none: solo registro
            row.update({"to_due": None,
                        "status": "tracked" if last_date else "never"})
        out.append(row)

    return {
        "unit": unit,
        "model": model,
        "current_miles": current,
        "current_source": source,
        "campaigns": out,
        "available": [
            {"key": k, "label": CAMPAIGNS[k]["label"]}
            for k in CAMPAIGNS
            if not CAMPAIGNS[k]["default"] and k not in extras
        ],
    }
