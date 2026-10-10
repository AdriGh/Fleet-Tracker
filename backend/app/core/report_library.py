# -*- coding: utf-8 -*-
"""Biblioteca de reportes de SISTEMA (v2.22, pestaña "Rigsmith" de Reports).

Viven en código (no en la base): cada uno es una ReportSpec del motor
(core/report_engine) + metadatos para la lista estilo SquareRigger:
  {slug, name, category, description, info, origin, dashboard?, versions,
   default_version, spec}

- `versions`: variantes del mismo reporte (como "Month to Date | 3 vers"
  de SR). Cada una puede cambiar el rango de tiempo (`time`) y/o pisar
  partes de la spec (`overrides`: columns, filters, group_by, sort, chart,
  totals, limit) — p.ej. Summary vs Detail.
- `origin`: 'squarerigger' = reproduce un reporte del catálogo de SR con
  los datos que tenemos (las aproximaciones lo dicen en `info`);
  'rigsmith' = propio (gasto, CPM, PM por horas, customers, revaluaciones).
- `dashboard`: el reporte tiene además una vista rica heredada en el
  frontend (spend | cpm | pm_compliance | driver_compliance).

Gasto, CPM, PM compliance y driver compliance NO se re-implementan: sus
fuentes son providers sobre core/reports y core/maint (paridad testeada).
"""

from __future__ import annotations

import copy

from .report_engine import PRESET_LABELS

CATEGORIES = ("Work orders", "Equipment", "Parts & inventory", "Purchasing",
              "Labor", "PM & compliance", "Customers", "Financial")


def _t(field: str, preset: str) -> dict:
    return {"field": field, "preset": preset}


def _vers(field: str, *presets: str) -> list[dict]:
    return [{"key": p, "label": PRESET_LABELS[p], "time": _t(field, p)}
            for p in presets]


def _c(field: str, label: str | None = None, agg: str | None = None) -> dict:
    out: dict = {"field": field}
    if agg:
        out["agg"] = agg
    if label:
        out["label"] = label
    return out


def _f(field: str, op: str, value=None) -> dict:
    out = {"field": field, "op": op}
    if value is not None:
        out["value"] = value
    return out


def _s(field: str, dir_: str = "asc") -> dict:
    return {"field": field, "dir": dir_}


_OPEN_WO = ["open", "assigned", "in_progress"]
_CLOSED_WO = ["completed", "invoiced"]

_APPROX_WO = ("Approximation: work orders carry internal cost lines (parts "
              "and labor); there are no separate price, tax, misc-fee or "
              "adjustment lines. Billable total is the customer price "
              "(frozen at invoicing, or cost × the customer's markup).")


SYSTEM_REPORTS: list[dict] = [
    # ------------------------------------------------------------------
    # Work orders
    # ------------------------------------------------------------------
    {
        "slug": "work-order-open-summary",
        "name": "Work Order - Open Summary",
        "category": "Work orders", "origin": "squarerigger",
        "description": "Every open work order with its unit, status, "
                       "customer, age, technician, parts and labor hours.",
        "info": "Open = open, assigned or in progress (completed WOs "
                "waiting to be invoiced are in the Closed summary).",
        "versions": [
            {"key": "all", "label": "All open"},
            {"key": "waiting_parts", "label": "Waiting on parts",
             "overrides": {"filters": {"match": "all", "items": [
                 _f("status", "in", _OPEN_WO),
                 _f("waiting_parts", "eq", True)]}}},
        ],
        "default_version": "all",
        "spec": {
            "source": "work_orders",
            "columns": [_c("display_no"), _c("unit", "Unit ID"),
                        _c("terminal", "Repair location"), _c("group"),
                        _c("status", "WO status"),
                        _c("bill_to", "Customer"), _c("created_at",
                                                      "Created date"),
                        _c("days_open"), _c("mechanic", "Assigned tech"),
                        _c("part_qty", "Parts"), _c("labor_hours"),
                        _c("waiting_parts"), _c("total")],
            "filters": {"match": "all",
                        "items": [_f("status", "in", _OPEN_WO)]},
            "sort": [_s("days_open", "desc")],
            "totals": True,
            "chart": {"type": "bar", "x": "status", "y": ["total"]},
        },
    },
    {
        "slug": "work-order-closed-summary",
        "name": "Work Order - Closed Summary",
        "category": "Work orders", "origin": "squarerigger",
        "description": "Work orders completed in the period with days to "
                       "close, labor hours, parts and labor cost and the "
                       "billable total.",
        "info": _APPROX_WO,
        "versions": _vers("closed_at", "mtd", "prev_month", "last_90d",
                          "ytd"),
        "default_version": "mtd",
        "spec": {
            "source": "work_orders",
            "columns": [_c("display_no"), _c("unit", "Unit ID"),
                        _c("terminal", "Equipment fleet"), _c("group"),
                        _c("spend_type", "Classification"), _c("wo_type"),
                        _c("bill_to", "Customer"),
                        _c("created_at", "Created date"),
                        _c("closed_at", "Closed date"),
                        _c("invoiced_at", "Invoice date"),
                        _c("days_to_close"),
                        _c("mechanic", "Techs who logged time"),
                        _c("part_qty", "Parts"), _c("labor_hours"),
                        _c("labor_total", "Labor cost"),
                        _c("parts_total", "Parts cost"),
                        _c("total", "Total cost"),
                        _c("billable_total", "Grand total (billable)")],
            "filters": {"match": "all",
                        "items": [_f("status", "in", _CLOSED_WO)]},
            "time": _t("closed_at", "mtd"),
            "sort": [_s("closed_at", "desc")],
            "totals": True,
            "chart": {"type": "kpi",
                      "y": ["total", "labor_total", "parts_total",
                            "billable_total"]},
        },
    },
    {
        "slug": "work-order-activity-log",
        "name": "Work Order Activity Log",
        "category": "Work orders", "origin": "squarerigger",
        "description": "Work orders created in the period with status, "
                       "dates, unit, customer, location and total.",
        "info": "Approximation: status-change history isn't recorded yet; "
                "each WO shows its created and completed dates.",
        "versions": _vers("created_at", "last_30d", "this_week", "mtd"),
        "default_version": "last_30d",
        "spec": {
            "source": "work_orders",
            "columns": [_c("display_no"), _c("status"),
                        _c("created_at", "Created"),
                        _c("closed_at", "Closed date"),
                        _c("unit", "Unit ID"), _c("bill_to", "Customer"),
                        _c("terminal", "Location"),
                        _c("billable_total", "Total price")],
            "time": _t("created_at", "last_30d"),
            "sort": [_s("created_at", "desc")],
            "totals": True,
        },
    },
    {
        "slug": "work-order-velocity",
        "name": "Work Order Kanban Velocity",
        "category": "Work orders", "origin": "squarerigger",
        "description": "Cycle time of work orders created in the period: "
                       "days from created to completed, and age of the "
                       "ones still open.",
        "info": "Approximation: no start / queue timestamps yet, so cycle "
                "time is created → completed and queue/active days aren't "
                "split.",
        "versions": _vers("created_at", "last_90d", "last_30d", "ytd"),
        "default_version": "last_90d",
        "spec": {
            "source": "work_orders",
            "columns": [_c("display_no", "Work order"), _c("status"),
                        _c("bill_to", "Customer"), _c("unit", "Unit ID"),
                        _c("terminal", "Repair location"),
                        _c("created_at", "Created"),
                        _c("closed_at", "Closed date"),
                        _c("days_to_close", "Cycle days"),
                        _c("days_open", "Age (days)")],
            "time": _t("created_at", "last_90d"),
            "sort": [_s("created_at", "desc")],
        },
    },
    {
        "slug": "wo-parts-used-cost-by-part",
        "name": "Work Order Parts Used Cost by PartID Detail",
        "category": "Work orders", "origin": "squarerigger",
        "description": "Every part used on a work order in the period with "
                       "quantity, unit cost and total cost.",
        "info": "",
        "versions": _vers("date", "last_30d", "mtd", "ytd"),
        "default_version": "last_30d",
        "spec": {
            "source": "wo_lines",
            "columns": [_c("date"), _c("wo_no", "Work order"),
                        _c("description", "Part name"), _c("part_number"),
                        _c("part_manufacturer"), _c("part_category"),
                        _c("qty", "Quantity used"), _c("unit_cost"),
                        _c("amount", "Total cost")],
            "filters": {"match": "all", "items": [_f("kind", "eq",
                                                      "part")]},
            "time": _t("date", "last_30d"),
            "sort": [_s("date", "desc")],
            "totals": True,
        },
    },
    {
        "slug": "parts-usage-cost-by-equipment",
        "name": "Parts Usage Cost Detail by Equipment - YTD",
        "category": "Work orders", "origin": "squarerigger",
        "description": "Parts used per unit this year: work order, part, "
                       "quantity, unit cost and total parts cost.",
        "info": "",
        "versions": [
            *_vers("date", "ytd", "last_90d", "mtd"),
            {"key": "summary", "label": "Summary by unit",
             "time": _t("date", "ytd"),
             "overrides": {
                 "columns": [_c("unit", "Equipment ID"),
                             _c("wo_id", "Work orders", "count_distinct"),
                             _c("qty", "Parts qty", "sum"),
                             _c("amount", "Total parts cost", "sum")],
                 "group_by": ["unit"],
                 "sort": [_s("sum_amount", "desc")],
                 "chart": {"type": "bar", "x": "unit",
                           "y": ["sum_amount"]}}},
        ],
        "default_version": "ytd",
        "spec": {
            "source": "wo_lines",
            "columns": [_c("date"), _c("wo_no", "Work order"),
                        _c("unit", "Equipment ID"),
                        _c("part_category", "Part type"),
                        _c("description", "Part name"),
                        _c("part_number", "Part code"),
                        _c("qty", "Quantity required"), _c("unit_cost"),
                        _c("amount", "Total parts cost")],
            "filters": {"match": "all", "items": [_f("kind", "eq",
                                                      "part")]},
            "time": _t("date", "ytd"),
            "sort": [_s("unit"), _s("date")],
            "totals": True,
        },
    },
    {
        "slug": "service-requests-backlog",
        "name": "Service Requests Backlog",
        "category": "Work orders", "origin": "rigsmith",
        "description": "Open and snoozed service requests (DVIR defects, PM / "
                       "DOT / reefer PM due, manual requests) with their "
                       "age and priority.",
        "info": "",
        "versions": [
            {"key": "all", "label": "All open"},
            {"key": "by_unit", "label": "By unit",
             "overrides": {
                 "columns": [_c("unit"), _c("id", "Requests", "count"),
                             _c("age_days", "Oldest (days)", "max")],
                 "group_by": ["unit"],
                 "sort": [_s("count_id", "desc")],
                 "chart": {"type": "bar", "x": "unit", "y": ["count_id"]}}},
            {"key": "by_source", "label": "By source",
             "overrides": {
                 "columns": [_c("source"), _c("id", "Requests", "count")],
                 "group_by": ["source"],
                 "sort": [_s("count_id", "desc")],
                 "chart": {"type": "donut", "x": "source",
                           "y": ["count_id"]}}},
        ],
        "default_version": "all",
        "spec": {
            "source": "service_requests",
            "columns": [_c("unit"), _c("source"), _c("title"),
                        _c("priority"), _c("status"), _c("created_at"),
                        _c("age_days"), _c("terminal", "Location"),
                        _c("wo_id")],
            "filters": {"match": "all",
                        "items": [_f("status", "in", ["open", "snoozed"])]},
            "sort": [_s("age_days", "desc")],
        },
    },

    # ------------------------------------------------------------------
    # Equipment
    # ------------------------------------------------------------------
    {
        "slug": "cost-per-mile",
        "name": "Cost per Mile",
        "category": "Equipment", "origin": "squarerigger",
        "dashboard": "cpm",
        "description": "Maintenance cost per mile by unit for the period: "
                       "miles driven, total cost and total / labor / parts "
                       "CPM.",
        "info": "Miles come from odometer readings (positive, plausible "
                "increments). Units with spend but no miles have an empty "
                "CPM. There is no 'Other' CPM: work orders only carry parts "
                "and labor lines.",
        "versions": _vers("period", "mtd", "prev_month", "ytd", "last_12m"),
        "default_version": "mtd",
        "spec": {
            "source": "cpm",
            "columns": [_c("unit", "Unit ID"), _c("name", "Name"),
                        _c("ops_status", "Status"), _c("terminal", "Fleet"),
                        _c("group"), _c("odometer",
                                        "Latest odometer reading"),
                        _c("miles"), _c("spend", "Total cost"),
                        _c("cpm", "Total CPM"), _c("labor_cpm"),
                        _c("parts_cpm")],
            "time": _t("period", "mtd"),
            "sort": [_s("cpm", "desc")],
            "totals": True,
            "chart": {"type": "bar", "x": "unit", "y": ["cpm"]},
        },
    },
    {
        "slug": "fleet-mileage-snapshot",
        "name": "Fleet Mileage Snapshot",
        "category": "Equipment", "origin": "squarerigger",
        "description": "Current odometer of every unit with the reading at "
                       "the start of the month and of the year.",
        "info": "Start-of-period readings use the last reading on or before "
                "that date (or the first one after it when the history "
                "starts later).",
        "versions": [{"key": "all", "label": "All units"}],
        "default_version": "all",
        "spec": {
            "source": "units",
            "columns": [_c("unit", "Unit ID"), _c("name"), _c("year"),
                        _c("terminal", "Location"), _c("unit_type", "Type"),
                        _c("group"), _c("make", "Manufacturer"),
                        _c("model"), _c("odometer", "Current odometer (mi)"),
                        _c("odometer_date", "Last reading date"),
                        _c("odometer_month_start"),
                        _c("odometer_year_start")],
            "filters": {"match": "all",
                        "items": [_f("archived", "eq", False)]},
            "sort": [_s("unit")],
        },
    },
    {
        "slug": "quarterly-mileage",
        "name": "Quarterly Mileage",
        "category": "Equipment", "origin": "squarerigger",
        "description": "Miles driven per unit in the quarter (or another "
                       "period), from odometer readings.",
        "info": "",
        "versions": _vers("period", "qtd", "ytd", "last_90d", "last_12m"),
        "default_version": "qtd",
        "spec": {
            "source": "unit_miles",
            "columns": [_c("unit", "Unit ID"), _c("terminal", "Location"),
                        _c("group"), _c("first_reading"),
                        _c("last_reading"), _c("miles")],
            "time": _t("period", "qtd"),
            "sort": [_s("miles", "desc")],
            "totals": True,
            "chart": {"type": "bar", "x": "unit", "y": ["miles"]},
        },
    },
    {
        "slug": "mileage-since-last-service",
        "name": "Mileage Since Last Completed Service",
        "category": "Equipment", "origin": "squarerigger",
        "description": "Miles each unit has driven since its last completed "
                       "PM service, with the next due mileage.",
        "info": "",
        "versions": [{"key": "all", "label": "All units"}],
        "default_version": "all",
        "spec": {
            "source": "maint_board",
            "columns": [_c("unit", "Unit ID"), _c("model", "Equipment"),
                        _c("service"), _c("last_date",
                                          "Last completed service"),
                        _c("last_miles", "Mileage at service"),
                        _c("current_miles", "Current mileage"),
                        _c("since_last", "Miles since service"),
                        _c("next_due_miles", "Next PM due (mi)"),
                        _c("to_due", "Miles to due")],
            "filters": {"match": "all",
                        "items": [_f("campaign", "eq", "pm")]},
            "sort": [_s("since_last", "desc")],
        },
    },
    {
        "slug": "equipment-by-customer",
        "name": "Equipment by Customer",
        "category": "Equipment", "origin": "squarerigger",
        "description": "Units that belong to a customer (owner-operator), "
                       "with year, location, type and make/model.",
        "info": "",
        "versions": [{"key": "all", "label": "All"}],
        "default_version": "all",
        "spec": {
            "source": "units",
            "columns": [_c("unit", "Unit ID"), _c("name"), _c("year"),
                        _c("customer"), _c("terminal", "Assigned location"),
                        _c("unit_type", "Type"), _c("group"),
                        _c("make", "Manufacturer"), _c("model")],
            "filters": {"match": "all",
                        "items": [_f("customer", "not_empty")]},
            "sort": [_s("customer"), _s("unit")],
        },
    },
    {
        "slug": "equipment-by-location",
        "name": "Equipment by Location",
        "category": "Equipment", "origin": "squarerigger",
        "description": "Every unit with its plate, location (terminal), "
                       "type, group and make/model.",
        "info": "Related equipment and a separate base location aren't "
                "tracked; Location is the unit's terminal.",
        "versions": [{"key": "all", "label": "All units"}],
        "default_version": "all",
        "spec": {
            "source": "units",
            "columns": [_c("unit", "Unit ID"), _c("name"), _c("year"),
                        _c("plate", "License plate number"),
                        _c("plate_state", "State registered"),
                        _c("terminal", "Assigned location"),
                        _c("unit_type", "Type"), _c("group"),
                        _c("make", "Manufacturer"), _c("model")],
            "filters": {"match": "all",
                        "items": [_f("archived", "eq", False)]},
            "sort": [_s("terminal"), _s("unit")],
        },
    },
    {
        "slug": "equipment-out-of-service",
        "name": "Equipment Out of Service",
        "category": "Equipment", "origin": "squarerigger",
        "description": "Units currently marked Out of service or In shop.",
        "info": "Approximation: the date a unit went out of service isn't "
                "stored yet, so Days out of service isn't available.",
        "versions": [{"key": "all", "label": "All"}],
        "default_version": "all",
        "spec": {
            "source": "units",
            "columns": [_c("unit", "Equipment unit"), _c("name"),
                        _c("ops_status", "Status"), _c("terminal",
                                                       "Location"),
                        _c("group"), _c("make"), _c("model"),
                        _c("customer")],
            "filters": {"match": "all", "items": [
                _f("ops_status", "in", ["out_of_service", "in_shop"])]},
            "sort": [_s("unit")],
        },
    },
    {
        "slug": "reefer-engine-hours-log",
        "name": "Reefer Engine Hours Log",
        "category": "Equipment", "origin": "rigsmith",
        "description": "Engine-hour meter readings of reefer units (manual, "
                       "work orders, PM records and reefer telematics).",
        "info": "Engine hours are their own meter: never compared against "
                "the odometer.",
        "versions": _vers("date", "last_30d", "last_90d", "ytd"),
        "default_version": "last_30d",
        "spec": {
            "source": "meter_readings",
            "columns": [_c("date"), _c("unit"), _c("value",
                                                   "Engine hours"),
                        _c("source")],
            "time": _t("date", "last_30d"),
            "sort": [_s("date", "desc"), _s("unit")],
        },
    },

    # ------------------------------------------------------------------
    # PM & compliance
    # ------------------------------------------------------------------
    {
        "slug": "pm-due-next-20k-miles",
        "name": "PM Due Next 20K Miles",
        "category": "PM & compliance", "origin": "squarerigger",
        "description": "Units whose mileage PM comes due within the next "
                       "20,000 miles (or is already overdue).",
        "info": "",
        "versions": [{"key": "all", "label": "All"}],
        "default_version": "all",
        "spec": {
            "source": "maint_board",
            "columns": [_c("unit", "Unit #"), _c("model", "Equipment"),
                        _c("service"), _c("ops_status",
                                          "Equipment status"),
                        _c("current_miles", "Current mileage"),
                        _c("next_due_miles", "PM due"),
                        _c("to_due", "Miles to due"),
                        _c("overdue_by", "Overdue (mi)"), _c("group"),
                        _c("terminal", "Assigned location"),
                        _c("customer")],
            "filters": {"match": "all", "items": [
                _f("campaign", "eq", "pm"), _f("to_due", "lte", 20000)]},
            "sort": [_s("to_due")],
        },
    },
    {
        "slug": "pm-due-next-90-days",
        "name": "PM Due Next 90 Days",
        "category": "PM & compliance", "origin": "squarerigger",
        "description": "Date-based services due within 90 days: the annual "
                       "DOT inspection and the reefer PM's date fallback.",
        "info": "Mileage PMs are in PM Due Next 20K Miles; reefer PMs due by "
                "engine hours are in Reefer PM Due.",
        "versions": [{"key": "all", "label": "All"}],
        "default_version": "all",
        "spec": {
            "source": "maint_board",
            "columns": [_c("unit", "Unit #"), _c("model", "Equipment"),
                        _c("service"), _c("due_status", "Status"),
                        _c("last_date", "Last performed"),
                        _c("next_due_date", "PM due"),
                        _c("to_due_days", "Days to due"),
                        _c("terminal", "Assigned location"),
                        _c("customer")],
            "filters": {"match": "all", "items": [
                _f("campaign", "in", ["dot", "reefer"]),
                _f("to_due_days", "lte", 90)]},
            "sort": [_s("to_due_days")],
        },
    },
    {
        "slug": "pms-due-and-overdue",
        "name": "PMs Due & Overdue",
        "category": "PM & compliance", "origin": "rigsmith",
        "description": "Every PM, DOT and reefer PM item that is overdue or "
                       "coming due — the same list as the Home card.",
        "info": "to_due is in the item's own units: miles (PM), days (DOT) "
                "or engine hours (reefer, with a days fallback). Negative = "
                "overdue.",
        "versions": [
            {"key": "all", "label": "Due & overdue"},
            {"key": "overdue", "label": "Overdue only",
             "overrides": {"filters": {"match": "all", "items": [
                 _f("status", "eq", "overdue")]}}},
        ],
        "default_version": "all",
        "spec": {
            "source": "pm_due",
            "columns": [_c("unit"), _c("model", "Equipment"),
                        _c("label", "Service"), _c("status"), _c("due_by"),
                        _c("to_due"), _c("unit_label", "Units"),
                        _c("next_due"), _c("customer"),
                        _c("terminal", "Location")],
            "chart": {"type": "donut", "x": "status", "y": []},
        },
    },
    {
        "slug": "reefer-pm-due",
        "name": "Reefer PM Due (engine hours)",
        "category": "PM & compliance", "origin": "rigsmith",
        "description": "Reefer units with current engine hours, last PM, "
                       "next PM due by hours and by date, and which comes "
                       "first.",
        "info": "Each reefer has its own engine-hours meter; the PM comes "
                "due by hours or by date, whichever is first (SquareRigger "
                "computes the hours interval against the odometer — we "
                "don't).",
        "versions": [
            {"key": "all", "label": "All reefers"},
            {"key": "due", "label": "Due & overdue",
             "overrides": {"filters": {"match": "all", "items": [
                 _f("campaign", "eq", "reefer"),
                 _f("due_status", "in", ["overdue", "upcoming"])]}}},
        ],
        "default_version": "all",
        "spec": {
            "source": "maint_board",
            "columns": [_c("unit"), _c("model", "Equipment"),
                        _c("current_hours", "Engine hours"),
                        _c("last_date", "Last PM"),
                        _c("last_hours", "Hours at last PM"),
                        _c("next_due_hours", "Next due (hrs)"),
                        _c("to_due", "To due"), _c("unit_label", "Units"),
                        _c("next_due_date", "Next due date"),
                        _c("to_due_days", "Days to due"), _c("due_by"),
                        _c("due_status", "Status"), _c("meter_missing")],
            "filters": {"match": "all",
                        "items": [_f("campaign", "eq", "reefer")]},
            "sort": [_s("to_due")],
        },
    },
    {
        "slug": "pm-compliance",
        "name": "PM Compliance",
        "category": "PM & compliance", "origin": "rigsmith",
        "dashboard": "pm_compliance",
        "description": "Fleet PM compliance by engine variant (DD13/DD15, "
                       "ISX, generic) and the DOT inspection: units on "
                       "track, upcoming, overdue and never serviced.",
        "info": "",
        "versions": [
            {"key": "summary", "label": "Summary"},
            {"key": "detail", "label": "Detail",
             "overrides": {
                 "columns": [_c("group", "PM group"), _c("unit"),
                             _c("model", "Equipment"), _c("driver"),
                             _c("status"), _c("last_date"),
                             _c("next_due_miles"), _c("next_due_date"),
                             _c("to_due"), _c("to_due_unit", "Units")],
                 "group_by": [], "sort": [_s("group"), _s("unit")],
                 "chart": {"type": "none"}}},
        ],
        "default_version": "summary",
        "spec": {
            "source": "pm_compliance",
            "columns": [_c("group", "PM group"), _c("status"),
                        _c("unit", "Units", "count")],
            "group_by": ["group", "status"],
            "sort": [_s("group"), _s("status")],
            "totals": True,
            "chart": {"type": "bar", "x": "status", "y": ["count_unit"]},
        },
    },
    {
        "slug": "driver-compliance",
        "name": "Driver Compliance",
        "category": "PM & compliance", "origin": "rigsmith",
        "dashboard": "driver_compliance",
        "description": "Driver documents that need attention: expired, "
                       "expiring within 30 days or missing a date (CDL, "
                       "medical card, MVR, Clearinghouse).",
        "info": "",
        "versions": [
            {"key": "attention", "label": "Needs attention"},
            {"key": "all", "label": "All documents",
             "overrides": {"filters": {"match": "all", "items": []}}},
            {"key": "summary", "label": "Summary",
             "overrides": {
                 "filters": {"match": "all", "items": []},
                 "columns": [_c("doc_label", "Document"),
                             _c("state", "Status"),
                             _c("driver", "Drivers", "count")],
                 "group_by": ["doc_label", "state"],
                 "sort": [_s("doc_label"), _s("state")],
                 "chart": {"type": "bar", "x": "state",
                           "y": ["count_driver"]}}},
        ],
        "default_version": "attention",
        "spec": {
            "source": "driver_docs",
            "columns": [_c("driver"), _c("truck"), _c("doc_label",
                                                      "Document"),
                        _c("date", "Expires"), _c("state", "Status"),
                        _c("days", "Days left")],
            "filters": {"match": "all",
                        "items": [_f("needs_attention", "eq", True)]},
            "sort": [_s("days"), _s("driver")],
        },
    },
    {
        "slug": "driver-license-expirations",
        "name": "Driver License Expirations",
        "category": "PM & compliance", "origin": "squarerigger",
        "description": "CDL expiration date and days left for every "
                       "driver, soonest first.",
        "info": "Drivers without a CDL date on their profile show as "
                "Missing date.",
        "versions": [{"key": "all", "label": "All drivers"}],
        "default_version": "all",
        "spec": {
            "source": "drivers",
            "columns": [_c("name", "Driver"), _c("company"), _c("truck"),
                        _c("license_state"), _c("cdl_exp", "CDL expires"),
                        _c("cdl_state", "Status"),
                        _c("cdl_days", "Days left")],
            "sort": [_s("cdl_days"), _s("name")],
        },
    },
    {
        "slug": "maintenance-history",
        "name": "Maintenance History",
        "category": "PM & compliance", "origin": "rigsmith",
        "description": "Completed PM, DOT, reefer PM and other campaign "
                       "services per unit with the mileage or engine hours "
                       "at service.",
        "info": "",
        "versions": _vers("date", "last_90d", "ytd", "all"),
        "default_version": "last_90d",
        "spec": {
            "source": "maint_records",
            "columns": [_c("date"), _c("unit"), _c("kind", "Service"),
                        _c("mileage"), _c("hours"), _c("notes")],
            "time": _t("date", "last_90d"),
            "sort": [_s("date", "desc")],
        },
    },
    {
        "slug": "inspections-dvir-detail",
        "name": "Inspections (DVIR defects) - Detail",
        "category": "PM & compliance", "origin": "squarerigger",
        "description": "Defects reported on driver inspections (DVIR) in the "
                       "period, with unit, driver, status and mechanic.",
        "info": "Approximation: Rigsmith imports DVIR defects from the ELD, "
                "not full inspection forms, so inspections without defects "
                "aren't listed.",
        "versions": _vers("block_date", "mtd", "ytd", "last_30d"),
        "default_version": "mtd",
        "spec": {
            "source": "defects",
            "columns": [_c("block_date", "Date"), _c("unit"), _c("driver"),
                        _c("dvir_type", "Inspection"), _c("detail",
                                                          "Defect"),
                        _c("status"), _c("mechanic")],
            "time": _t("block_date", "mtd"),
            "sort": [_s("block_date", "desc")],
        },
    },

    # ------------------------------------------------------------------
    # Labor
    # ------------------------------------------------------------------
    {
        "slug": "labor-summary-by-fleet",
        "name": "Labor Summary By Fleet",
        "category": "Labor", "origin": "squarerigger",
        "description": "Labor hours and labor cost by fleet location.",
        "info": "Fleet = the unit's terminal / location.",
        "versions": _vers("date", "mtd", "last_90d", "ytd"),
        "default_version": "mtd",
        "spec": {
            "source": "wo_lines",
            "columns": [_c("terminal", "Equipment fleet"),
                        _c("labor_hours", "Labor hours", "sum"),
                        _c("labor_cost", "Labor cost", "sum")],
            "filters": {"match": "all", "items": [_f("kind", "eq",
                                                      "labor")]},
            "time": _t("date", "mtd"),
            "group_by": ["terminal"],
            "sort": [_s("sum_labor_cost", "desc")],
            "totals": True,
            "chart": {"type": "bar", "x": "terminal",
                      "y": ["sum_labor_cost"]},
        },
    },
    {
        "slug": "labor-summary-by-group",
        "name": "Labor Summary By Group (Last 90 Days)",
        "category": "Labor", "origin": "squarerigger",
        "description": "Labor hours and labor cost by unit group.",
        "info": "Group comes from each unit's settings.",
        "versions": _vers("date", "last_90d", "mtd", "ytd"),
        "default_version": "last_90d",
        "spec": {
            "source": "wo_lines",
            "columns": [_c("group", "Equipment group"),
                        _c("labor_hours", "Labor hours", "sum"),
                        _c("labor_cost", "Labor cost", "sum")],
            "filters": {"match": "all", "items": [_f("kind", "eq",
                                                      "labor")]},
            "time": _t("date", "last_90d"),
            "group_by": ["group"],
            "sort": [_s("sum_labor_cost", "desc")],
            "totals": True,
            "chart": {"type": "bar", "x": "group", "y": ["sum_labor_cost"]},
        },
    },
    {
        "slug": "mechanic-labor-cost-detail",
        "name": "Mechanic Labor Cost - Detail",
        "category": "Labor", "origin": "squarerigger",
        "description": "Every labor line in the period with the technician, "
                       "hours, rate and labor cost.",
        "info": "Approximation: one technician per work order, and labor is "
                "recorded as hours × rate lines (no clock-in time entries).",
        "versions": _vers("date", "prev_week", "mtd", "last_30d"),
        "default_version": "prev_week",
        "spec": {
            "source": "wo_lines",
            "columns": [_c("date"), _c("wo_no", "Work order"), _c("unit"),
                        _c("mechanic", "Technician"),
                        _c("description", "Labor"),
                        _c("labor_hours", "Hours"),
                        _c("unit_cost", "Rate"),
                        _c("labor_cost", "Labor cost")],
            "filters": {"match": "all", "items": [_f("kind", "eq",
                                                      "labor")]},
            "time": _t("date", "prev_week"),
            "sort": [_s("mechanic"), _s("date")],
            "totals": True,
        },
    },
    {
        "slug": "technician-leaderboard",
        "name": "Technician Leaderboard",
        "category": "Labor", "origin": "squarerigger",
        "description": "Technicians ranked by labor hours in the period, "
                       "with work orders and labor cost.",
        "info": "Approximation: estimated hours aren't tracked yet, so "
                "efficiency isn't available.",
        "versions": _vers("date", "mtd", "prev_month", "ytd"),
        "default_version": "mtd",
        "spec": {
            "source": "wo_lines",
            "columns": [_c("mechanic", "Technician"),
                        _c("wo_id", "Work orders", "count_distinct"),
                        _c("labor_hours", "Labor hours", "sum"),
                        _c("labor_cost", "Labor cost", "sum")],
            "filters": {"match": "all", "items": [
                _f("kind", "eq", "labor"), _f("mechanic", "not_empty")]},
            "time": _t("date", "mtd"),
            "group_by": ["mechanic"],
            "sort": [_s("sum_labor_hours", "desc")],
            "totals": True,
            "chart": {"type": "bar", "x": "mechanic",
                      "y": ["sum_labor_hours"]},
        },
    },
    {
        "slug": "labor-log",
        "name": "Labor Log",
        "category": "Labor", "origin": "squarerigger",
        "description": "Labor recorded on work orders, by day.",
        "info": "Approximation: labor is recorded as hours on work order "
                "lines, dated by the work order (no clock-in / clock-out "
                "entries).",
        "versions": _vers("date", "yesterday", "prev_week", "mtd"),
        "default_version": "yesterday",
        "spec": {
            "source": "wo_lines",
            "columns": [_c("date"), _c("mechanic", "Technician"),
                        _c("wo_no", "Work order"), _c("unit"),
                        _c("description", "Labor"),
                        _c("labor_hours", "Hours")],
            "filters": {"match": "all", "items": [_f("kind", "eq",
                                                      "labor")]},
            "time": _t("date", "yesterday"),
            "sort": [_s("date", "desc"), _s("mechanic")],
            "totals": True,
        },
    },

    # ------------------------------------------------------------------
    # Parts & inventory
    # ------------------------------------------------------------------
    {
        "slug": "inventory-level-and-valuation",
        "name": "Inventory Level and Valuation",
        "category": "Parts & inventory", "origin": "squarerigger",
        "description": "Every part with quantity on hand, order point, last "
                       "cost, weighted average cost and total value.",
        "info": "Purchase / issue units of measure aren't tracked. Value = "
                "on hand × average cost (standard cost if never received).",
        "versions": [
            {"key": "all", "label": "All parts"},
            {"key": "in_stock", "label": "In stock",
             "overrides": {"filters": {"match": "all", "items": [
                 _f("on_hand", "gt", 0)]}}},
        ],
        "default_version": "all",
        "spec": {
            "source": "parts",
            "columns": [_c("description", "Part name"),
                        _c("category", "Part type"),
                        _c("manufacturer"), _c("part_number",
                                               "Internal part #"),
                        _c("on_hand"), _c("reorder_point"),
                        _c("last_cost"), _c("avg_cost"),
                        _c("total_value")],
            "sort": [_s("part_number")],
            "totals": True,
        },
    },
    {
        "slug": "physical-inventory-worksheet",
        "name": "Physical Inventory Worksheet",
        "category": "Parts & inventory", "origin": "squarerigger",
        "description": "Count sheet by bin: part, quantity on hand, average "
                       "cost and value.",
        "info": "One stock location (multi-location inventory isn't "
                "tracked).",
        "versions": [{"key": "all", "label": "All parts"}],
        "default_version": "all",
        "spec": {
            "source": "parts",
            "columns": [_c("bin"), _c("part_number", "Part code"),
                        _c("description", "Part name"),
                        _c("on_hand", "Qty on hand"),
                        _c("unit_value", "Avg cost"),
                        _c("total_value")],
            "sort": [_s("bin"), _s("part_number")],
            "totals": True,
        },
    },
    {
        "slug": "parts-usage",
        "name": "Parts Usage",
        "category": "Parts & inventory", "origin": "squarerigger",
        "description": "Parts used on work orders: preferred vendor, stock "
                       "on hand, average price, extended cost and the last "
                       "date added to a work order.",
        "info": "",
        "versions": [{"key": "all", "label": "All used parts"}],
        "default_version": "all",
        "spec": {
            "source": "parts",
            "columns": [_c("description", "Part name"), _c("part_number"),
                        _c("manufacturer"), _c("vendor_name"),
                        _c("on_hand"), _c("unit_value", "Average price"),
                        _c("total_value", "Extended cost"),
                        _c("qty_used"),
                        _c("last_used", "Date last added to WO")],
            "filters": {"match": "all", "items": [_f("qty_used", "gt", 0)]},
            "sort": [_s("last_used", "desc")],
            "totals": True,
        },
    },
    {
        "slug": "parts-ledger",
        "name": "Parts Ledger (Last 30 Days) - Detail",
        "category": "Parts & inventory", "origin": "squarerigger",
        "description": "Every inventory transaction: receipts, consumption, "
                       "manual adjustments and cost corrections, with the "
                       "cost, value change and user.",
        "info": "On-hand before/after isn't stored per movement (the current "
                "on hand is in Inventory Level and Valuation).",
        "versions": _vers("created_at", "last_30d", "mtd", "last_90d"),
        "default_version": "last_30d",
        "spec": {
            "source": "stock_movements",
            "columns": [_c("created_at", "Date"), _c("part_number"),
                        _c("part_description", "Part name"),
                        _c("part_manufacturer"), _c("part_category"),
                        _c("delta", "Qty change"), _c("unit_cost",
                                                      "Avg cost"),
                        _c("value_delta", "Cost change"),
                        _c("reason", "Source"), _c("ref_id", "Reference"),
                        _c("actor", "User")],
            "time": _t("created_at", "last_30d"),
            "sort": [_s("created_at", "desc")],
            "totals": True,
        },
    },
    {
        "slug": "parts-on-order",
        "name": "Parts on Order",
        "category": "Parts & inventory", "origin": "squarerigger",
        "description": "Quantities still outstanding on ordered purchase "
                       "orders, by part.",
        "info": "",
        "versions": [{"key": "all", "label": "All"}],
        "default_version": "all",
        "spec": {
            "source": "po_lines",
            "columns": [_c("part_number", "Part ID"), _c("part_category"),
                        _c("description", "Part"),
                        _c("qty_open", "Quantity on order"),
                        _c("unit_cost", "Part cost"),
                        _c("po_id", "Purchase order"),
                        _c("po_status", "Status"), _c("po_vendor")],
            "filters": {"match": "all", "items": [
                _f("po_status", "eq", "ordered"), _f("qty_open", "gt", 0)]},
            "sort": [_s("po_id"), _s("part_number")],
            "totals": True,
        },
    },
    {
        "slug": "low-stock",
        "name": "Low Stock",
        "category": "Parts & inventory", "origin": "rigsmith",
        "description": "Parts at or below their order point, with what's "
                       "already on order.",
        "info": "",
        "versions": [{"key": "all", "label": "All"}],
        "default_version": "all",
        "spec": {
            "source": "parts",
            "columns": [_c("part_number"), _c("description"),
                        _c("on_hand"), _c("reorder_point"), _c("max_qty"),
                        _c("qty_on_order"), _c("vendor_name"),
                        _c("unit_value", "Avg cost")],
            "filters": {"match": "all",
                        "items": [_f("below_reorder", "eq", True)]},
            "sort": [_s("part_number")],
        },
    },
    {
        "slug": "parts-revaluation-log",
        "name": "Parts Revaluation Log",
        "category": "Parts & inventory", "origin": "rigsmith",
        "description": "Cost corrections made on received purchase orders "
                       "(edited unit cost or allocated discount / shipping "
                       "/ tax) and the inventory value they changed.",
        "info": "A correction changes value only (quantity stays): the part "
                "of it still on hand revalues the average cost; the part "
                "already consumed is variance.",
        "versions": _vers("created_at", "last_90d", "ytd", "all"),
        "default_version": "last_90d",
        "spec": {
            "source": "stock_movements",
            "columns": [_c("created_at", "Date"), _c("part_number"),
                        _c("part_description", "Part name"),
                        _c("unit_cost", "New unit cost"),
                        _c("value_delta", "Value change"),
                        _c("ref_id", "PO line"), _c("note"),
                        _c("actor", "User")],
            "filters": {"match": "all",
                        "items": [_f("reason", "eq", "po_cost_adj")]},
            "time": _t("created_at", "last_90d"),
            "sort": [_s("created_at", "desc")],
            "totals": True,
        },
    },
    {
        "slug": "core-returns-pending",
        "name": "Core Returns Pending",
        "category": "Parts & inventory", "origin": "rigsmith",
        "description": "Cores still owed to vendors, with the deposit at "
                       "stake and how long they've been out.",
        "info": "",
        "versions": [{"key": "all", "label": "Pending"}],
        "default_version": "all",
        "spec": {
            "source": "core_items",
            "columns": [_c("part_number"), _c("description"), _c("vendor"),
                        _c("qty"), _c("core_charge"), _c("value"),
                        _c("po_id"), _c("created_at", "Received"),
                        _c("days_out")],
            "filters": {"match": "all",
                        "items": [_f("status", "eq", "pending")]},
            "sort": [_s("days_out", "desc")],
            "totals": True,
        },
    },
    {
        "slug": "warranty-claims-open",
        "name": "Open Warranty Claims",
        "category": "Parts & inventory", "origin": "rigsmith",
        "description": "Parts that failed inside their warranty window and "
                       "haven't been recovered yet.",
        "info": "",
        "versions": [{"key": "all", "label": "Open & submitted"}],
        "default_version": "all",
        "spec": {
            "source": "warranty_claims",
            "columns": [_c("unit"), _c("part_number"), _c("description"),
                        _c("vendor"), _c("install_date"),
                        _c("failure_date"), _c("warranty_until"),
                        _c("amount"), _c("status")],
            "filters": {"match": "all", "items": [
                _f("status", "in", ["open", "submitted"])]},
            "sort": [_s("failure_date", "desc")],
            "totals": True,
        },
    },

    # ------------------------------------------------------------------
    # Purchasing
    # ------------------------------------------------------------------
    {
        "slug": "purchase-order-detail",
        "name": "Purchase Order (Last 90 Days) - Detail",
        "category": "Purchasing", "origin": "squarerigger",
        "description": "Every purchase order line in the period with vendor, "
                       "part, quantity, unit cost, extended price and "
                       "status.",
        "info": "Returns aren't tracked yet.",
        "versions": _vers("po_created_at", "last_90d", "mtd", "ytd"),
        "default_version": "last_90d",
        "spec": {
            "source": "po_lines",
            "columns": [_c("po_id", "PO number"), _c("po_created_at",
                                                     "PO date"),
                        _c("po_vendor", "Vendor"),
                        _c("part_category", "Part type"),
                        _c("description", "Part name"), _c("qty",
                                                           "Quantity"),
                        _c("unit_cost"), _c("amount", "Extended price"),
                        _c("po_status", "Status"), _c("qty_received")],
            "time": _t("po_created_at", "last_90d"),
            "sort": [_s("po_created_at", "desc")],
            "totals": True,
        },
    },
    {
        "slug": "purchase-order-summary",
        "name": "Purchase Order (Last 90 Days) - Summary",
        "category": "Purchasing", "origin": "squarerigger",
        "description": "Purchasing by vendor: purchase orders, lines, total "
                       "quantity, total spend and the last PO date.",
        "info": "Returns aren't tracked yet, so there's no return impact.",
        "versions": _vers("created_at", "last_90d", "mtd", "ytd"),
        "default_version": "last_90d",
        "spec": {
            "source": "purchase_orders",
            "columns": [_c("vendor"),
                        _c("id", "Purchase orders", "count"),
                        _c("line_count", "PO lines", "sum"),
                        _c("qty_ordered", "Total quantity", "sum"),
                        _c("total", "Total spend", "sum"),
                        _c("created_at", "Last PO date", "max")],
            "time": _t("created_at", "last_90d"),
            "group_by": ["vendor"],
            "sort": [_s("sum_total", "desc")],
            "totals": True,
            "chart": {"type": "bar", "x": "vendor", "y": ["sum_total"]},
        },
    },
    {
        "slug": "top-vendors-by-receipt-volume",
        "name": "Top Vendors by Parts Receipt Volume",
        "category": "Purchasing", "origin": "squarerigger",
        "description": "Vendors ranked by parts received: receipt lines, "
                       "purchase orders, unique parts, units received and "
                       "first / last receipt.",
        "info": "Approximation: dated by each line's latest receipt.",
        "versions": _vers("received_at", "last_30d", "last_90d", "ytd"),
        "default_version": "last_30d",
        "spec": {
            "source": "po_lines",
            "columns": [_c("po_vendor", "Vendor"),
                        _c("id", "Receipt lines", "count"),
                        _c("po_id", "Purchase orders", "count_distinct"),
                        _c("part_number", "Unique parts", "count_distinct"),
                        _c("qty_received", "Units received", "sum"),
                        _c("received_at", "First receipt", "min"),
                        _c("received_at", "Last receipt", "max")],
            "filters": {"match": "all",
                        "items": [_f("qty_received", "gt", 0)]},
            "time": _t("received_at", "last_30d"),
            "group_by": ["po_vendor"],
            "sort": [_s("sum_qty_received", "desc")],
            "totals": True,
            "chart": {"type": "bar", "x": "po_vendor",
                      "y": ["sum_qty_received"]},
        },
    },
    {
        "slug": "vendor-lead-time",
        "name": "Vendor Lead Time Performance",
        "category": "Purchasing", "origin": "squarerigger",
        "description": "Average days from purchase order to full receipt, "
                       "by vendor.",
        "info": "Approximation: lead time runs from the PO creation date "
                "(there's no separate ordered date) to full receipt.",
        "versions": _vers("received_at", "last_90d", "last_30d", "ytd"),
        "default_version": "last_90d",
        "spec": {
            "source": "purchase_orders",
            "columns": [_c("vendor"), _c("vendor_city", "Vendor location"),
                        _c("id", "POs received", "count"),
                        _c("line_count", "Receipt lines", "sum"),
                        _c("qty_received", "Units received", "sum"),
                        _c("lead_time_days", "Avg lead time days", "avg"),
                        _c("received_at", "First receipt", "min"),
                        _c("received_at", "Last receipt", "max")],
            "filters": {"match": "all",
                        "items": [_f("status", "eq", "received")]},
            "time": _t("received_at", "last_90d"),
            "group_by": ["vendor", "vendor_city"],
            "sort": [_s("avg_lead_time_days")],
            "chart": {"type": "bar", "x": "vendor",
                      "y": ["avg_lead_time_days"]},
        },
    },
    {
        "slug": "po-open-balances",
        "name": "Purchase Order Balances",
        "category": "Purchasing", "origin": "rigsmith",
        "description": "Purchase orders with an unpaid balance: total after "
                       "discounts, shipping, tax and fees, payments and "
                       "what's still owed.",
        "info": "Purchase orders stay editable after receiving and closing: "
                "costs and adjustments can be fixed at any time.",
        "versions": [{"key": "all", "label": "Unpaid"}],
        "default_version": "all",
        "spec": {
            "source": "purchase_orders",
            "columns": [_c("id"), _c("vendor"), _c("created_at"),
                        _c("status"), _c("fin_status"), _c("invoice_no"),
                        _c("total"), _c("paid"), _c("balance")],
            "filters": {"match": "all", "items": [_f("balance", "gt", 0)]},
            "sort": [_s("created_at")],
            "totals": True,
        },
    },
    {
        "slug": "outside-work-closed-summary",
        "name": "Outside Work - Closed Summary",
        "category": "Purchasing", "origin": "squarerigger",
        "description": "Completed work done by outside vendor shops, with "
                       "the vendor invoice number and total.",
        "info": "",
        "versions": _vers("effective_date", "last_90d", "mtd", "ytd"),
        "default_version": "last_90d",
        "spec": {
            "source": "work_orders",
            "columns": [_c("display_no"), _c("unit"), _c("vendor_name"),
                        _c("effective_date", "Service date"),
                        _c("shop_invoice"), _c("status"), _c("total"),
                        _c("billable_total")],
            "filters": {"match": "all", "items": [
                _f("wo_type", "eq", "outside"),
                _f("status", "in", _CLOSED_WO)]},
            "time": _t("effective_date", "last_90d"),
            "sort": [_s("effective_date", "desc")],
            "totals": True,
        },
    },
    {
        "slug": "outside-work-by-vendor",
        "name": "Outside Work by Vendor",
        "category": "Purchasing", "origin": "rigsmith",
        "description": "Outside shop spend by vendor: work orders, units "
                       "and total.",
        "info": "",
        "versions": _vers("effective_date", "ytd", "last_90d", "all"),
        "default_version": "ytd",
        "spec": {
            "source": "work_orders",
            "columns": [_c("vendor_name", "Vendor"),
                        _c("id", "Work orders", "count"),
                        _c("unit", "Units", "count_distinct"),
                        _c("total", "Total", "sum"),
                        _c("total", "Avg per WO", "avg")],
            "filters": {"match": "all",
                        "items": [_f("wo_type", "eq", "outside")]},
            "time": _t("effective_date", "ytd"),
            "group_by": ["vendor_name"],
            "sort": [_s("sum_total", "desc")],
            "totals": True,
            "chart": {"type": "bar", "x": "vendor_name",
                      "y": ["sum_total"]},
        },
    },

    # ------------------------------------------------------------------
    # Customers
    # ------------------------------------------------------------------
    {
        "slug": "customer-billing",
        "name": "Customer Billing",
        "category": "Customers", "origin": "rigsmith",
        "description": "What each customer (owner-operator) was billed for "
                       "shop parts and labor, what they paid and the open "
                       "balance.",
        "info": "Billed = invoiced work orders at the customer price "
                "(frozen at invoicing). Dated by invoice date.",
        "versions": _vers("invoiced_at", "mtd", "prev_month", "ytd", "all"),
        "default_version": "mtd",
        "spec": {
            "source": "work_orders",
            "columns": [_c("customer_name", "Customer"),
                        _c("id", "Invoiced WOs", "count"),
                        _c("billable_total", "Billed", "sum"),
                        _c("billed_paid", "Paid", "sum"),
                        _c("balance", "Open balance", "sum")],
            "filters": {"match": "all", "items": [
                _f("status", "eq", "invoiced"),
                _f("customer_id", "not_empty")]},
            "time": _t("invoiced_at", "mtd"),
            "group_by": ["customer_name"],
            "sort": [_s("sum_billable_total", "desc")],
            "totals": True,
            "chart": {"type": "bar", "x": "customer_name",
                      "y": ["sum_billable_total"]},
        },
    },
    {
        "slug": "customer-balances",
        "name": "Customer Balances",
        "category": "Customers", "origin": "rigsmith",
        "description": "Every active customer with units, work orders, "
                       "billed YTD, billed and paid all time, and open "
                       "balance.",
        "info": "",
        "versions": [{"key": "all", "label": "Active customers"}],
        "default_version": "all",
        "spec": {
            "source": "customers",
            "columns": [_c("name", "Customer"), _c("kind"),
                        _c("units_count"), _c("wo_count"), _c("open_wos"),
                        _c("billed_ytd"), _c("billed_all"), _c("paid_all"),
                        _c("open_balance")],
            "filters": {"match": "all", "items": [_f("active", "eq", True)]},
            "sort": [_s("open_balance", "desc")],
            "totals": True,
        },
    },

    # ------------------------------------------------------------------
    # Financial
    # ------------------------------------------------------------------
    {
        "slug": "spend-overview",
        "name": "Spend Overview",
        "category": "Financial", "origin": "rigsmith",
        "dashboard": "spend",
        "description": "Maintenance spend by category (tires, brakes, "
                       "engine, oil & fluids, electrical, suspension, shop "
                       "supplies, labor, other).",
        "info": "Spend = parts + labor lines of every work order, dated by "
                "service date (same numbers as the spend dashboard).",
        "versions": [
            *_vers("date", "mtd", "qtd", "ytd", "last_12m"),
            {"key": "by_unit", "label": "By unit (YTD)",
             "time": _t("date", "ytd"),
             "overrides": {
                 "columns": [_c("unit"), _c("wo_id", "Work orders",
                                            "count_distinct"),
                             _c("amount", "Spend", "sum")],
                 "group_by": ["unit"],
                 "sort": [_s("sum_amount", "desc")],
                 "chart": {"type": "bar", "x": "unit",
                           "y": ["sum_amount"]}}},
            {"key": "by_month", "label": "By month (12 months)",
             "time": _t("date", "last_12m"),
             "overrides": {
                 "columns": [_c("month"), _c("amount", "Spend", "sum")],
                 "group_by": ["month"],
                 "sort": [_s("month")],
                 "chart": {"type": "line", "x": "month",
                           "y": ["sum_amount"]}}},
            {"key": "prevention", "label": "Preventive vs reactive (YTD)",
             "time": _t("date", "ytd"),
             "overrides": {
                 "columns": [_c("spend_type", "Type"),
                             _c("wo_id", "Work orders", "count_distinct"),
                             _c("amount", "Spend", "sum")],
                 "filters": {"match": "all", "items": [
                     _f("spend_type", "not_empty")]},
                 "group_by": ["spend_type"],
                 "sort": [_s("sum_amount", "desc")],
                 "chart": {"type": "donut", "x": "spend_type",
                           "y": ["sum_amount"]}}},
            {"key": "top_parts", "label": "Top parts (YTD)",
             "time": _t("date", "ytd"),
             "overrides": {
                 "columns": [_c("part_number"),
                             _c("description", "Description", "max"),
                             _c("qty", "Qty", "sum"),
                             _c("amount", "Spend", "sum")],
                 "filters": {"match": "all", "items": [
                     _f("kind", "eq", "part"),
                     _f("part_number", "not_empty")]},
                 "group_by": ["part_number"],
                 "sort": [_s("sum_amount", "desc")],
                 "limit": 25,
                 "chart": {"type": "bar", "x": "part_number",
                           "y": ["sum_amount"]}}},
        ],
        "default_version": "mtd",
        "spec": {
            "source": "spend_lines",
            "columns": [_c("category_label", "Category"),
                        _c("amount", "Spend", "sum"),
                        _c("wo_id", "Work orders", "count_distinct")],
            "time": _t("date", "mtd"),
            "group_by": ["category_label"],
            "sort": [_s("sum_amount", "desc")],
            "totals": True,
            "chart": {"type": "donut", "x": "category_label",
                      "y": ["sum_amount"]},
        },
    },
    {
        "slug": "equipment-parts-labor-totals",
        "name": "Equipment Parts & Labor Totals",
        "category": "Financial", "origin": "squarerigger",
        "description": "Work orders, labor total, parts total and grand "
                       "total per unit.",
        "info": "There are no misc lines on work orders, so Misc total "
                "isn't shown.",
        "versions": _vers("effective_date", "ytd", "mtd", "last_12m", "all"),
        "default_version": "ytd",
        "spec": {
            "source": "work_orders",
            "columns": [_c("unit", "Unit ID"),
                        _c("terminal", "Equipment fleet"),
                        _c("group", "Equipment group"),
                        _c("id", "Work orders", "count"),
                        _c("labor_total", "Labor total", "sum"),
                        _c("parts_total", "Parts total", "sum"),
                        _c("total", "Parts + labor", "sum")],
            "time": _t("effective_date", "ytd"),
            "group_by": ["unit", "terminal", "group"],
            "sort": [_s("sum_total", "desc")],
            "totals": True,
            "chart": {"type": "bar", "x": "unit", "y": ["sum_total"]},
        },
    },
]

_BY_SLUG = {r["slug"]: r for r in SYSTEM_REPORTS}


def summary(r: dict) -> dict:
    """Fila de la lista (sin la spec)."""
    return {
        "ref": f"sys:{r['slug']}",
        "slug": r["slug"],
        "name": r["name"],
        "category": r["category"],
        "description": r["description"],
        "info": r.get("info") or "",
        "origin": r["origin"],
        "dashboard": r.get("dashboard"),
        "source": r["spec"]["source"],
        "default_version": r["default_version"],
        "default_version_label": next(
            (v["label"] for v in r["versions"]
             if v["key"] == r["default_version"]), ""),
        "versions": [{"key": v["key"], "label": v["label"]}
                     for v in r["versions"]],
    }


def list_system() -> list[dict]:
    return [summary(r) for r in SYSTEM_REPORTS]


def get_system(slug: str) -> dict | None:
    r = _BY_SLUG.get(slug or "")
    return copy.deepcopy(r) if r else None


def spec_for(slug: str, version: str | None = None) -> tuple[dict, dict]:
    """(spec, version) del reporte de sistema con la versión aplicada.
    ValueError si el slug o la versión no existen."""
    r = _BY_SLUG.get(slug or "")
    if r is None:
        raise ValueError(f"unknown system report '{slug}'")
    key = version or r["default_version"]
    v = next((v for v in r["versions"] if v["key"] == key), None)
    if v is None:
        raise ValueError(f"unknown version '{key}' for '{slug}' (valid: "
                         + ", ".join(x["key"] for x in r["versions"]) + ")")
    spec = copy.deepcopy(r["spec"])
    if v.get("time"):
        spec["time"] = copy.deepcopy(v["time"])
    for k, val in (v.get("overrides") or {}).items():
        spec[k] = copy.deepcopy(val)
    if spec.get("chart") == {"type": "none"}:
        spec.pop("chart")
    return spec, {"key": v["key"], "label": v["label"]}
