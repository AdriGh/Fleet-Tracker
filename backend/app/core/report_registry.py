# -*- coding: utf-8 -*-
"""Registro de fuentes de datos de Reports (v2.22, benchmark SquareRigger).

Cada FUENTE es "una fila por <cosa>" (como el Report Builder de SR): una
tabla del negocio (work orders, líneas, partes, POs…) o un PROVIDER en
Python sobre lógica que ya existe (flota viva de Samsara, tableros de PM,
gasto y CPM de core/reports). El motor (core/report_engine) solo puede
pedir los campos DECLARADOS acá: nada de SQL libre, ni del usuario ni del
asistente de IA.

Tipos de campo: text | number | money | date | datetime | bool.

Clases de campo:
  - SQL (`col`): una columna/expresión de SQLAlchemy sobre el modelo base o
    un JOIN declarado (`join`). Los joins son outer y llevan SIEMPRE un
    filtro explícito `alias.org_id == org` (además del filtro de tenant del
    ORM, que solo cubre SELECT): segunda barrera contra cruzar tenants.
  - Derivado (`fn(row, ctx)`): se calcula en Python DESPUÉS de la query, a
    partir de otros campos (`deps`). Así las diferencias de días, la fecha
    efectiva de la WO o los montos no dependen del dialecto (SQLite/PG).
  - Post (`post(session, rows, ctx)`): enriquecimiento en LOTE (una query
    agrupada por ids) para totales de líneas, terminal, grupo, etc.
  - Provider: la fuente entera la arma una función async (core/
    report_providers); sus campos solo declaran tipo/etiqueta.

`pii`: 'email' | 'phone' | 'text' — el motor lo enmascara ("•••") si el
usuario no tiene `pii.view` y NO deja filtrar/ordenar/agrupar por él.
`nosum`: el campo es numérico pero no se totaliza (ids, odómetros, %).
`hidden`: dependencia interna, no se ofrece en el builder ni se acepta en
una spec.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field as dc_field
from datetime import date, datetime
from typing import Any, Callable

from sqlalchemy import and_, func, select
from sqlalchemy.orm import aliased

from ..db import (
    CoreItem, Customer, CustomerUnit, Defect, MaintRecord, MeterReading,
    OdometerReading, Part, PartStockMovement, PoAdjustment, POLine,
    PurchaseOrder, ServiceRequest, Vendor, WarrantyClaim, WorkOrder,
    WorkOrderLine,
)
from . import report_providers as prov

TYPES = ("text", "number", "money", "date", "datetime", "bool")
_CHUNK = 500


# ---------------------------------------------------------------------------
# Estructuras
# ---------------------------------------------------------------------------

@dataclass
class Field:
    label: str
    type: str = "text"
    desc: str = ""
    col: Any = None
    join: str | None = None
    fn: Callable | None = None
    deps: tuple = ()
    post: Callable | None = None
    pii: str | None = None
    hidden: bool = False
    nosum: bool = False
    enum: dict | None = None
    name: str = ""

    @property
    def is_sql(self) -> bool:
        return self.col is not None


@dataclass
class Join:
    target: Any
    on: Any
    requires: tuple = ()


@dataclass
class Source:
    key: str
    label: str
    description: str
    fields: dict
    category: str = ""
    model: Any = None
    joins: dict = dc_field(default_factory=dict)
    where: tuple = ()
    provider: Callable | None = None
    default_time_field: str | None = None
    time_param: bool = False

    @property
    def is_sql(self) -> bool:
        return self.model is not None

    def field(self, name: str) -> Field | None:
        f = self.fields.get(name)
        if f is None or f.hidden:
            return None
        return f


def C(label, type_="text", col=None, desc="", **kw) -> Field:
    """Campo SQL."""
    return Field(label, type_, desc, col=col, **kw)


def D(label, type_, fn, deps=(), desc="", **kw) -> Field:
    """Campo derivado en Python."""
    return Field(label, type_, desc, fn=fn, deps=tuple(deps), **kw)


def P(label, type_, post, deps=(), desc="", **kw) -> Field:
    """Campo de enriquecimiento en lote."""
    return Field(label, type_, desc, post=post, deps=tuple(deps), **kw)


def V(label, type_="text", desc="", **kw) -> Field:
    """Campo de un provider (el valor viene en la fila)."""
    return Field(label, type_, desc, **kw)


def H(col, join=None, type_="text") -> Field:
    """Dependencia SQL interna (no se ofrece al usuario)."""
    return Field("", type_, "", col=col, join=join, hidden=True)


# ---------------------------------------------------------------------------
# Helpers de valores (los derivados reciben valores CRUDOS de la query)
# ---------------------------------------------------------------------------

def to_org_dt(v, tz) -> datetime | None:
    """datetime de la base (naive = hora local del servidor) -> naive en la
    zona de la org. Lo usan los derivados y la normalización del motor."""
    if not isinstance(v, datetime):
        return None
    aware = v.astimezone() if v.tzinfo is None else v
    return aware.astimezone(tz).replace(tzinfo=None)


def as_date(v, tz=None) -> date | None:
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        o = to_org_dt(v, tz) if tz is not None else v
        return o.date() if o else None
    if isinstance(v, date):
        return v
    try:
        return datetime.strptime(str(v)[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _days(a, b, tz) -> int | None:
    da, db_ = as_date(a, tz), as_date(b, tz)
    if da is None or db_ is None:
        return None
    return (db_ - da).days


def _wo_no(wid, parent_id, child_seq) -> str | None:
    if wid is None:
        return None
    if parent_id and child_seq:
        return f"{parent_id}.{child_seq}"
    return str(wid)


def _eff_date(r: dict, ctx, sd="service_date", closed="closed_at",
              created="created_at") -> str | None:
    """Fecha efectiva de una WO (misma prioridad que workorders.
    effective_date): service_date -> closed_at -> created_at, en la zona de
    la org."""
    d = as_date(r.get(sd))
    if d is None:
        d = as_date(r.get(closed), ctx.tz) or as_date(r.get(created), ctx.tz)
    return d.isoformat() if d else None


def _month(v) -> str | None:
    d = as_date(v)
    return d.strftime("%Y-%m") if d else None


def _num(v) -> float:
    try:
        return float(v or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _price(kind, unit_cost, unit_price, parts_pct, labor_pct) -> float:
    """Precio de venta unitario (misma regla que customers.line_price)."""
    from . import customers
    if unit_price is not None:
        return float(unit_price)
    return customers.price_for(kind or "part", unit_cost,
                               _num(parts_pct), _num(labor_pct))


def _chunks(seq, n=_CHUNK):
    seq = list(seq)
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def _ctx_cache(ctx, key, fn):
    cache = getattr(ctx, "cache", None)
    if cache is None:
        return fn()
    if key not in cache:
        cache[key] = fn()
    return cache[key]


# ----- Enriquecimientos compartidos ----------------------------------------

def _terminal_cfg(ctx):
    from . import terminals
    return _ctx_cache(ctx, "terminals", terminals.get_all)


def terminal_label(unit: str, company: str, ctx) -> str:
    from . import terminals
    cfg = _terminal_cfg(ctx)
    key = terminals.resolve(unit or "", company or "", cfg=cfg)
    labels = {t["key"]: (t.get("label") or t["key"])
              for t in cfg.get("terminals") or []}
    return labels.get(key, key)


def unit_group(unit: str, ctx) -> str:
    from . import unit_settings
    allset = _ctx_cache(ctx, "unit_settings", unit_settings.all_settings)
    return str((allset.get(unit or "") or {}).get("group") or "")


def _post_terminal(unit_key: str, company_key: str, out: str = "terminal"):
    def post(session, rows, ctx):
        memo: dict = {}
        for r in rows:
            k = (r.get(unit_key) or "", r.get(company_key) or "")
            if k not in memo:
                memo[k] = terminal_label(k[0], k[1], ctx)
            r[out] = memo[k]
    return post


def _post_group(unit_key: str, out: str = "group"):
    def post(session, rows, ctx):
        for r in rows:
            r[out] = unit_group(r.get(unit_key) or "", ctx)
    return post


# ---------------------------------------------------------------------------
# Enums (valores crudos -> etiqueta visible)
# ---------------------------------------------------------------------------

WO_STATUS = {"open": "Open", "assigned": "Assigned",
             "in_progress": "In progress", "completed": "Completed",
             "invoiced": "Invoiced"}
WO_PRIORITY = {"low": "Low", "normal": "Normal", "high": "High"}
WO_TYPE = {"inside": "Inside (own shop)", "outside": "Outside (vendor)"}
PAYMENT = {"unpaid": "Unpaid", "paid": "Paid"}
CAMPAIGN = {"": "None", "pm": "Full Wet Service (PM)",
            "dot": "Federal Annual DOT Inspection",
            "reefer": "Reefer PM (engine hours)",
            "kingpins": "Check kingpins", "dpf": "DPF replacement",
            "clutch": "Clutch replacement"}
LINE_KIND = {"part": "Part", "labor": "Labor"}
MOVE_REASON = {"po_receive": "PO receipt", "po_unreceive": "PO un-receive",
               "po_cost_adj": "PO cost correction",
               "wo_consume": "WO consumption",
               "manual": "Manual adjustment"}
PO_STATUS = {"draft": "Draft", "ordered": "Ordered",
             "received": "Received"}
PO_FIN = {"open": "Open", "closed": "Closed"}
PAY_METHOD = {"": "—", "invoice": "On invoice", "paid": "Paid",
              "card": "Card", "cash": "Cash"}
ADJ_KIND = {"discount": "Discount", "credit": "Credit",
            "shipping": "Shipping", "tax": "Tax", "fee": "Fee",
            "payment": "Payment"}
VENDOR_KIND = {"": "Unclassified", "parts": "Parts vendor",
               "shop": "Outside shop", "both": "Parts & shop"}
SR_SOURCE = {"defect": "DVIR defect", "pm": "PM due", "dot": "DOT due",
             "reefer": "Reefer PM due", "manual": "Request"}
SR_STATUS = {"open": "Open", "snoozed": "Snoozed", "on_wo": "On a WO",
             "done": "Done", "denied": "Denied"}
SR_PRIORITY = {"low": "Low", "normal": "Normal", "urgent": "Urgent",
               "emergency": "Emergency"}
ODO_SOURCE = {"samsara": "Samsara", "wo": "Work order",
              "maint": "PM record", "manual": "Manual", "demo": "Demo"}
METER_SOURCE = {"manual": "Manual", "wo": "Work order",
                "maint": "PM record", "lynx": "Lynx",
                "thermoking": "Thermo King", "traccar": "Traccar",
                "demo": "Demo"}
CUSTOMER_KIND = {"owner_operator": "Owner-operator", "carrier": "Carrier",
                 "external": "External"}
TERMS = {"": "—", "cod": "COD", "net7": "Net 7", "net15": "Net 15",
         "net30": "Net 30", "2_10_net30": "2/10 Net 30",
         "prepay": "Prepay"}
WARRANTY_STATUS = {"open": "Open", "submitted": "Submitted",
                   "recovered": "Recovered", "dismissed": "Dismissed"}
CORE_STATUS = {"pending": "Pending return", "returned": "Returned"}
DUE_STATUS = {"overdue": "Overdue", "upcoming": "Upcoming",
              "on_track": "On track", "never": "Never done",
              "no_meter": "No meter reading", "out_of_service":
              "Out of service", "in_shop": "In shop"}
DUE_BY = {"miles": "Miles", "days": "Days", "hours": "Engine hours"}
DOC_STATE = {"expired": "Expired", "soon": "Expiring ≤30 days",
             "valid": "Valid", "missing": "Missing date"}
OPS_STATUS = {"": "Active", "out_of_service": "Out of service",
              "in_shop": "In shop"}


# ---------------------------------------------------------------------------
# Posts en lote (SQL agrupado por ids)
# ---------------------------------------------------------------------------

def _post_wo_lines(session, rows, ctx):
    """Totales de líneas por WO: partes, labor, total (costo interno),
    horas de labor, cantidad de líneas y el monto FACTURABLE al customer
    (precio congelado o costo × markup)."""
    ids = [r["id"] for r in rows if r.get("id") is not None]
    agg: dict[int, dict] = {}
    for chunk in _chunks(ids):
        q = select(WorkOrderLine.wo_id, WorkOrderLine.kind,
                   WorkOrderLine.qty, WorkOrderLine.unit_cost,
                   WorkOrderLine.unit_price).where(
            WorkOrderLine.wo_id.in_(chunk),
            WorkOrderLine.org_id == ctx.org)
        for wo_id, kind, qty, cost, price in session.execute(q):
            a = agg.setdefault(wo_id, {"lines": []})
            a["lines"].append((kind or "part", _num(qty), _num(cost), price))
    for r in rows:
        lines = agg.get(r.get("id"), {}).get("lines", [])
        parts = labor = hours = pqty = billable = billable_parts = 0.0
        has_cust = bool(r.get("customer_id"))
        for kind, qty, cost, price in lines:
            amount = round(qty * cost, 2)
            if kind == "labor":
                labor += amount
                hours += qty
            else:
                parts += amount
                pqty += qty
            p = (_price(kind, cost, price, r.get("cust_parts_pct"),
                        r.get("cust_labor_pct")) if has_cust
                 else (float(price) if price is not None else cost))
            billable += round(p * qty, 2)
            if kind != "labor":
                billable_parts += p * qty
        # Impuesto del customer sobre las partes (misma regla que
        # customers.billable_tax: tasa congelada en la WO, si no la vigente).
        tax = 0.0
        if has_cust:
            pct = r.get("wo_tax_pct")
            if pct is None:
                pct = (0.0 if r.get("cust_tax_exempt")
                       else _num(r.get("cust_tax_pct")))
            pct = max(0.0, _num(pct))
            if pct:
                tax = round(round(billable_parts, 2) * pct / 100.0, 2)
        r["parts_total"] = round(parts, 2)
        r["labor_total"] = round(labor, 2)
        r["total"] = round(parts + labor, 2)
        r["labor_hours"] = round(hours, 2)
        r["part_qty"] = round(pqty, 2)
        r["line_count"] = len(lines)
        r["billable_total"] = round(billable, 2)
        r["billable_tax"] = tax
        r["amount_due"] = round(billable + tax, 2)


def _post_part_usage(session, rows, ctx):
    """Última vez usada en una WO, cantidad usada (todas las WOs) y
    cantidad en órdenes de compra abiertas, por part_number."""
    pns = sorted({r.get("part_number") for r in rows
                  if r.get("part_number")})
    last: dict[str, Any] = {}
    used: dict[str, float] = {}
    on_order: dict[str, float] = {}
    for chunk in _chunks(pns):
        q = (select(WorkOrderLine.part_number,
                    func.max(WorkOrder.created_at),
                    func.sum(WorkOrderLine.qty))
             .join(WorkOrder, and_(WorkOrderLine.wo_id == WorkOrder.id,
                                   WorkOrder.org_id == ctx.org))
             .where(WorkOrderLine.part_number.in_(chunk),
                    WorkOrderLine.kind != "labor",
                    WorkOrderLine.org_id == ctx.org)
             .group_by(WorkOrderLine.part_number))
        for pn, mx, s in session.execute(q):
            last[pn] = mx
            used[pn] = _num(s)
        q2 = (select(POLine.part_number, POLine.qty, POLine.qty_received)
              .join(PurchaseOrder, and_(POLine.po_id == PurchaseOrder.id,
                                        PurchaseOrder.org_id == ctx.org))
              .where(POLine.part_number.in_(chunk),
                     POLine.org_id == ctx.org,
                     # Solo POs en camino: una 'received' ya cerró su
                     # recepción (lo corto vive en su backorder).
                     PurchaseOrder.status == "ordered"))
        for pn, qty, rec in session.execute(q2):
            rem = _num(qty) - _num(rec)
            if rem > 1e-9:
                on_order[pn] = on_order.get(pn, 0.0) + rem
    for r in rows:
        pn = r.get("part_number")
        d = as_date(last.get(pn), ctx.tz)
        r["last_used"] = d.isoformat() if d else None
        r["qty_used"] = round(used.get(pn, 0.0), 2)
        r["qty_on_order"] = round(on_order.get(pn, 0.0), 2)


def _post_po(session, rows, ctx):
    """Agregados de líneas y ajustes (no anulados) por PO."""
    ids = [r["id"] for r in rows if r.get("id") is not None]
    lines: dict[int, dict] = {}
    adjs: dict[int, dict] = {}
    for chunk in _chunks(ids):
        q = select(POLine.po_id, POLine.qty, POLine.unit_cost,
                   POLine.qty_received, POLine.landed_unit_cost).where(
            POLine.po_id.in_(chunk), POLine.org_id == ctx.org)
        for po_id, qty, cost, rec, landed in session.execute(q):
            a = lines.setdefault(po_id, {"n": 0, "qty": 0.0, "rec": 0.0,
                                         "sub": 0.0, "rval": 0.0})
            a["n"] += 1
            a["qty"] += _num(qty)
            a["rec"] += _num(rec)
            a["sub"] += _num(qty) * _num(cost)
            eff = _num(landed) if landed is not None else _num(cost)
            a["rval"] += _num(rec) * eff
        q2 = select(PoAdjustment.po_id, PoAdjustment.kind,
                    PoAdjustment.amount).where(
            PoAdjustment.po_id.in_(chunk), PoAdjustment.org_id == ctx.org,
            PoAdjustment.voided_at.is_(None))
        for po_id, kind, amount in session.execute(q2):
            a = adjs.setdefault(po_id, {})
            a[kind] = a.get(kind, 0.0) + _num(amount)
    for r in rows:
        a = lines.get(r.get("id"), {})
        j = adjs.get(r.get("id"), {})
        r["line_count"] = a.get("n", 0)
        r["qty_ordered"] = round(a.get("qty", 0.0), 2)
        r["qty_received"] = round(a.get("rec", 0.0), 2)
        r["subtotal"] = round(a.get("sub", 0.0), 2)
        r["received_value"] = round(a.get("rval", 0.0), 2)
        r["discount"] = round(j.get("discount", 0.0), 2)
        r["credit"] = round(j.get("credit", 0.0), 2)
        r["shipping"] = round(j.get("shipping", 0.0), 2)
        r["tax"] = round(j.get("tax", 0.0), 2)
        r["fees"] = round(j.get("fee", 0.0), 2)
        r["paid"] = round(j.get("payment", 0.0), 2)


def _wo_line_totals(session, wo_ids, org) -> dict[int, float]:
    out: dict[int, float] = {}
    for chunk in _chunks(wo_ids):
        q = select(WorkOrderLine.wo_id, WorkOrderLine.qty,
                   WorkOrderLine.unit_cost).where(
            WorkOrderLine.wo_id.in_(chunk), WorkOrderLine.org_id == org)
        for wo_id, qty, cost in session.execute(q):
            out[wo_id] = out.get(wo_id, 0.0) + round(_num(qty) * _num(cost),
                                                      2)
    return out


def _post_vendor(session, rows, ctx):
    """POs (por vendor_id o por nombre), gasto en POs, WOs outside y su
    total, y partes con este vendor preferido."""
    ids = [r["id"] for r in rows if r.get("id") is not None]
    by_name = {(r.get("name") or "").strip().lower(): r.get("id")
               for r in rows}
    po: dict[int, list] = {}
    q = select(PurchaseOrder.id, PurchaseOrder.vendor_id,
               PurchaseOrder.vendor, PurchaseOrder.total).where(
        PurchaseOrder.org_id == ctx.org)
    for pid, vid, vname, total in session.execute(q):
        key = vid if vid in ids else by_name.get((vname or "").strip()
                                                 .lower())
        if key is None:
            continue
        e = po.setdefault(key, [0, 0.0])
        e[0] += 1
        e[1] += _num(total)
    wos: dict[int, list] = {}
    wo_vendor: dict[int, int] = {}
    for chunk in _chunks(ids):
        q = select(WorkOrder.id, WorkOrder.vendor_id).where(
            WorkOrder.vendor_id.in_(chunk), WorkOrder.wo_type == "outside",
            WorkOrder.org_id == ctx.org)
        for wid, vid in session.execute(q):
            wo_vendor[wid] = vid
    totals = _wo_line_totals(session, list(wo_vendor), ctx.org)
    for wid, vid in wo_vendor.items():
        e = wos.setdefault(vid, [0, 0.0])
        e[0] += 1
        e[1] += totals.get(wid, 0.0)
    parts: dict[int, int] = {}
    for chunk in _chunks(ids):
        q = (select(Part.vendor_id, func.count(Part.id))
             .where(Part.vendor_id.in_(chunk), Part.org_id == ctx.org)
             .group_by(Part.vendor_id))
        for vid, n in session.execute(q):
            parts[vid] = int(n or 0)
    for r in rows:
        vid = r.get("id")
        p = po.get(vid, [0, 0.0])
        w = wos.get(vid, [0, 0.0])
        r["po_count"] = p[0]
        r["po_spend"] = round(p[1], 2)
        r["outside_wo_count"] = w[0]
        r["outside_spend"] = round(w[1], 2)
        r["parts_count"] = parts.get(vid, 0)


def _post_customer(session, rows, ctx):
    """Unidades, WOs y montos facturados por customer (precio de venta:
    congelado o costo × markup, igual que el perfil del customer)."""
    from sqlalchemy.orm import selectinload
    from . import customers
    ids = [r["id"] for r in rows if r.get("id") is not None]
    units: dict[int, int] = {}
    stats: dict[int, dict] = {}
    year_start = date(ctx.today.year, 1, 1)
    for chunk in _chunks(ids):
        q = (select(CustomerUnit.customer_id, func.count(CustomerUnit.id))
             .where(CustomerUnit.customer_id.in_(chunk),
                    CustomerUnit.org_id == ctx.org)
             .group_by(CustomerUnit.customer_id))
        for cid, n in session.execute(q):
            units[cid] = int(n or 0)
        custs = {c.id: c for c in session.scalars(select(Customer).where(
            Customer.id.in_(chunk), Customer.org_id == ctx.org))}
        q2 = (select(WorkOrder).options(selectinload(WorkOrder.lines))
              .where(WorkOrder.customer_id.in_(chunk),
                     WorkOrder.org_id == ctx.org))
        for wo in session.scalars(q2):
            s = stats.setdefault(wo.customer_id, {
                "wo": 0, "open": 0, "billed": 0.0, "ytd": 0.0,
                "balance": 0.0, "paid": 0.0})
            s["wo"] += 1
            if wo.status not in ("completed", "invoiced"):
                s["open"] += 1
            if wo.status == "invoiced":
                # Cobrado / adeudado = con impuesto (billable_due).
                amt = customers.billable_due(wo, custs.get(wo.customer_id))
                s["billed"] += amt
                inv = as_date(wo.invoiced_at, ctx.tz)
                if inv is not None and inv >= year_start:
                    s["ytd"] += amt
                if (wo.payment_status or "unpaid") == "paid":
                    s["paid"] += amt
                else:
                    s["balance"] += amt
    for r in rows:
        s = stats.get(r.get("id"), {})
        r["units_count"] = units.get(r.get("id"), 0)
        r["wo_count"] = s.get("wo", 0)
        r["open_wos"] = s.get("open", 0)
        r["billed_all"] = round(s.get("billed", 0.0), 2)
        r["billed_ytd"] = round(s.get("ytd", 0.0), 2)
        r["paid_all"] = round(s.get("paid", 0.0), 2)
        r["open_balance"] = round(s.get("balance", 0.0), 2)


# ---------------------------------------------------------------------------
# Fuentes SQL
# ---------------------------------------------------------------------------

_WOV = aliased(Vendor, name="wo_vendor")
_WOC = aliased(Customer, name="wo_customer")
_wo_terminal = _post_terminal("unit", "company")
_wo_group = _post_group("unit")


# Dependencias del impuesto del customer (billable_tax / amount_due).
_WO_TAX_DEPS = ("id", "customer_id", "cust_parts_pct", "cust_labor_pct",
                "wo_tax_pct", "cust_tax_pct", "cust_tax_exempt")


def _wo_billed(r, ctx, paid: bool):
    if r.get("status") != "invoiced" or not r.get("customer_id"):
        return None
    is_paid = (r.get("payment_status") or "unpaid") == "paid"
    if is_paid != paid:
        return 0.0
    return r.get("amount_due", r.get("billable_total"))


WORK_ORDERS = Source(
    key="work_orders", label="Work orders", category="Work orders",
    description=("One row per work order (inside shop work or outside "
                 "vendor work). Money is internal cost (parts + labor "
                 "lines); billable_total is what the customer is charged "
                 "(frozen price or cost × the customer's markup). Join "
                 "to lines by wo_lines.wo_id = id, never by title."),
    model=WorkOrder,
    joins={"vendor": Join(_WOV, WorkOrder.vendor_id == _WOV.id),
           "customer": Join(_WOC, WorkOrder.customer_id == _WOC.id)},
    default_time_field="effective_date",
    fields={
        "id": C("WO ID", "number", WorkOrder.id, nosum=True),
        "parent_id": H(WorkOrder.parent_id, type_="number"),
        "child_seq": H(WorkOrder.child_seq, type_="number"),
        "display_no": D("WO #", "text",
                        lambda r, c: _wo_no(r.get("id"), r.get("parent_id"),
                                            r.get("child_seq")),
                        ("id", "parent_id", "child_seq"),
                        "Work order number as shown in the app (4 or 4.1)"),
        "unit": C("Unit", "text", WorkOrder.unit, "Unit / equipment number"),
        "company": C("Company", "text", WorkOrder.company,
                     "Carrier company that owns the unit"),
        "title": C("Title", "text", WorkOrder.title),
        "complaint": C("Complaint", "text", WorkOrder.complaint),
        "status": C("Status", "text", WorkOrder.status,
                    "Pipeline status", enum=WO_STATUS),
        "priority": C("Priority", "text", WorkOrder.priority,
                      enum=WO_PRIORITY),
        "wo_type": C("WO type", "text", WorkOrder.wo_type,
                     "inside = own shop, outside = third-party vendor shop",
                     enum=WO_TYPE),
        "mechanic": C("Technician", "text", WorkOrder.mechanic,
                      "Assigned mechanic (one per WO)"),
        "campaign": C("PM campaign", "text", WorkOrder.campaign,
                      "Maintenance campaign the WO services ('' = none)",
                      enum=CAMPAIGN),
        "source": C("Origin", "text", WorkOrder.source,
                    "How the WO was created (manual, scan, sr…)"),
        "is_pm": C("Is PM", "bool", WorkOrder.is_pm),
        "waiting_parts": C("Waiting on parts", "bool",
                           WorkOrder.waiting_parts),
        "mileage": C("Odometer (mi)", "number", WorkOrder.mileage,
                     "Odometer at service", nosum=True),
        "engine_hours": C("Engine hours", "number", WorkOrder.engine_hours,
                          "Reefer engine hours at service", nosum=True),
        "service_date": C("Service date", "date", WorkOrder.service_date,
                          "Date typed on the WO / vendor invoice"),
        "created_at": C("Created", "datetime", WorkOrder.created_at),
        "closed_at": C("Completed", "datetime", WorkOrder.closed_at,
                       "When the WO reached completed"),
        "invoiced_at": C("Invoiced", "datetime", WorkOrder.invoiced_at),
        "effective_date": D("Date", "date",
                            lambda r, c: _eff_date(r, c),
                            ("service_date", "closed_at", "created_at"),
                            "Effective spend date: service date, else "
                            "completed date, else created date"),
        "month": D("Month", "text",
                   lambda r, c: _month(r.get("effective_date")),
                   ("effective_date",), "YYYY-MM of the effective date"),
        "days_to_close": D("Days to close", "number",
                           lambda r, c: _days(r.get("created_at"),
                                              r.get("closed_at"), c.tz),
                           ("created_at", "closed_at"),
                           "Days from created to completed", nosum=True),
        "days_open": D("Days open", "number",
                       lambda r, c: _days(r.get("created_at"),
                                          r.get("closed_at") or c.today,
                                          c.tz),
                       ("created_at", "closed_at"),
                       "Days from created to completed (or to today if "
                       "still open)", nosum=True),
        "invoice_number": C("Invoice #", "text", WorkOrder.invoice_number),
        "po_number": C("Customer PO #", "text", WorkOrder.po_number),
        "shop_invoice": C("Vendor invoice #", "text",
                          WorkOrder.shop_invoice),
        "vendor_id": C("Vendor ID", "number", WorkOrder.vendor_id,
                       nosum=True),
        "vendor_name": C("Vendor", "text", _WOV.name, "Outside shop / vendor",
                         join="vendor"),
        "customer_id": C("Customer ID", "number", WorkOrder.customer_id,
                         nosum=True),
        "customer_name": C("Customer", "text", _WOC.name,
                           "Customer billed (empty = Self)",
                           join="customer"),
        "cust_parts_pct": H(_WOC.parts_markup_pct, "customer", "number"),
        "cust_labor_pct": H(_WOC.labor_markup_pct, "customer", "number"),
        "wo_tax_pct": H(WorkOrder.tax_pct, None, "number"),
        "cust_tax_pct": H(_WOC.tax_rate_pct, "customer", "number"),
        "cust_tax_exempt": H(_WOC.tax_exempt, "customer", "bool"),
        "bill_to": D("Bill to", "text",
                     lambda r, c: (r.get("customer_name") or "Self")
                     if r.get("customer_id") else "Self",
                     ("customer_id", "customer_name"),
                     "Customer name, or Self"),
        "payment_status": C("Payment", "text", WorkOrder.payment_status,
                            "Customer payment status", enum=PAYMENT),
        "paid_at": C("Paid", "datetime", WorkOrder.paid_at),
        "spend_type": D("Preventive / reactive", "text",
                        lambda r, c: ("Preventive" if r.get("is_pm")
                                      or (r.get("campaign") or "").strip()
                                      else "Reactive"),
                        ("is_pm", "campaign"),
                        "Preventive = PM or campaign work"),
        "parts_total": P("Parts cost", "money", _post_wo_lines,
                         ("id", "customer_id", "cust_parts_pct",
                          "cust_labor_pct")),
        "labor_total": P("Labor cost", "money", _post_wo_lines,
                         ("id", "customer_id", "cust_parts_pct",
                          "cust_labor_pct")),
        "total": P("Total cost", "money", _post_wo_lines,
                   ("id", "customer_id", "cust_parts_pct", "cust_labor_pct"),
                   "Parts + labor at internal cost"),
        "labor_hours": P("Labor hours", "number", _post_wo_lines,
                         ("id", "customer_id", "cust_parts_pct",
                          "cust_labor_pct")),
        "part_qty": P("Parts qty", "number", _post_wo_lines,
                      ("id", "customer_id", "cust_parts_pct",
                       "cust_labor_pct")),
        "line_count": P("Lines", "number", _post_wo_lines,
                        ("id", "customer_id", "cust_parts_pct",
                         "cust_labor_pct")),
        "billable_total": P("Billable total", "money", _post_wo_lines,
                            ("id", "customer_id", "cust_parts_pct",
                             "cust_labor_pct"),
                            "What the customer is charged (with markup), "
                            "before tax"),
        "billable_tax": P("Customer tax", "money", _post_wo_lines,
                          _WO_TAX_DEPS,
                          "Customer sales tax on billed parts (rate frozen "
                          "at invoicing)"),
        "amount_due": P("Amount due", "money", _post_wo_lines,
                        _WO_TAX_DEPS,
                        "Billable total + customer tax"),
        "billed_paid": D("Billed & paid", "money",
                         lambda r, c: _wo_billed(r, c, True),
                         ("amount_due", "status", "payment_status",
                          "customer_id"),
                         "Amount due (with tax) of invoiced, paid customer "
                         "WOs"),
        "balance": D("Open balance", "money",
                     lambda r, c: _wo_billed(r, c, False),
                     ("amount_due", "status", "payment_status",
                      "customer_id"),
                     "Amount due (with tax) of invoiced, unpaid customer "
                     "WOs"),
        "terminal": P("Location", "text", _wo_terminal, ("unit", "company"),
                      "Terminal / fleet location of the unit"),
        "group": P("Group", "text", _wo_group, ("unit",),
                   "Unit group (unit settings)"),
    },
)


_LWO = aliased(WorkOrder, name="wo")
_LP = aliased(Part, name="line_part")
_LPV = aliased(Vendor, name="line_part_vendor")
_LWV = aliased(Vendor, name="line_wo_vendor")
_LWC = aliased(Customer, name="line_wo_customer")
_line_terminal = _post_terminal("unit", "company")
_line_group = _post_group("unit")


def _spend_cat(r, ctx) -> str:
    from . import reports
    key = reports.classify_line(r.get("kind") or "", r.get("part_number")
                                or "", r.get("description") or "",
                                r.get("part_category") or "")
    return reports.CATEGORY_LABELS.get(key, key)


WO_LINES = Source(
    key="wo_lines", label="Work order lines", category="Work orders",
    description=("One row per work order line (a part or a labor entry; "
                 "for labor, qty = hours). Includes the parent work order "
                 "(unit, status, technician, dates) and the catalog part "
                 "(category, manufacturer). Join to the catalog by "
                 "part_number."),
    model=WorkOrderLine,
    joins={
        "wo": Join(_LWO, WorkOrderLine.wo_id == _LWO.id),
        "part": Join(_LP, and_(_LP.part_number == WorkOrderLine.part_number,
                               WorkOrderLine.part_number != "")),
        "part_vendor": Join(_LPV, _LP.vendor_id == _LPV.id, ("part",)),
        "wo_vendor": Join(_LWV, _LWO.vendor_id == _LWV.id, ("wo",)),
        "customer": Join(_LWC, _LWO.customer_id == _LWC.id, ("wo",)),
    },
    default_time_field="date",
    fields={
        "id": C("Line ID", "number", WorkOrderLine.id, nosum=True),
        "wo_id": C("WO ID", "number", WorkOrderLine.wo_id, nosum=True),
        "kind": C("Line type", "text", WorkOrderLine.kind,
                  "part or labor", enum=LINE_KIND),
        "description": C("Description", "text", WorkOrderLine.description),
        "part_number": C("Part #", "text", WorkOrderLine.part_number),
        "qty": C("Qty", "number", WorkOrderLine.qty,
                 "Quantity (hours for labor lines)"),
        "unit_cost": C("Unit cost", "money", WorkOrderLine.unit_cost,
                       "Internal cost per unit / hourly rate"),
        "unit_price": C("Frozen price", "money", WorkOrderLine.unit_price,
                        "Sale price frozen when the WO was invoiced to a "
                        "customer", nosum=True),
        "amount": D("Amount", "money",
                    lambda r, c: round(_num(r.get("qty"))
                                       * _num(r.get("unit_cost")), 2),
                    ("qty", "unit_cost"), "qty × unit cost (internal)"),
        "labor_hours": D("Labor hours", "number",
                         lambda r, c: _num(r.get("qty"))
                         if r.get("kind") == "labor" else None,
                         ("qty", "kind")),
        "labor_cost": D("Labor cost", "money",
                        lambda r, c: round(_num(r.get("qty"))
                                           * _num(r.get("unit_cost")), 2)
                        if r.get("kind") == "labor" else None,
                        ("qty", "unit_cost", "kind")),
        "parts_cost": D("Parts cost", "money",
                        lambda r, c: round(_num(r.get("qty"))
                                           * _num(r.get("unit_cost")), 2)
                        if r.get("kind") != "labor" else None,
                        ("qty", "unit_cost", "kind")),
        "wo_parent_id": H(_LWO.parent_id, "wo", "number"),
        "wo_child_seq": H(_LWO.child_seq, "wo", "number"),
        "cust_parts_pct": H(_LWC.parts_markup_pct, "customer", "number"),
        "cust_labor_pct": H(_LWC.labor_markup_pct, "customer", "number"),
        "wo_no": D("WO #", "text",
                   lambda r, c: _wo_no(r.get("wo_id"), r.get("wo_parent_id"),
                                       r.get("wo_child_seq")),
                   ("wo_id", "wo_parent_id", "wo_child_seq")),
        "unit": C("Unit", "text", _LWO.unit, join="wo"),
        "company": C("Company", "text", _LWO.company, join="wo"),
        "wo_title": C("WO title", "text", _LWO.title, join="wo"),
        "wo_status": C("WO status", "text", _LWO.status, join="wo",
                       enum=WO_STATUS),
        "wo_type": C("WO type", "text", _LWO.wo_type, join="wo",
                     enum=WO_TYPE),
        "mechanic": C("Technician", "text", _LWO.mechanic, join="wo"),
        "campaign": C("PM campaign", "text", _LWO.campaign, join="wo",
                      enum=CAMPAIGN),
        "is_pm": C("Is PM", "bool", _LWO.is_pm, join="wo"),
        "service_date": C("Service date", "date", _LWO.service_date,
                          join="wo"),
        "wo_created_at": C("WO created", "datetime", _LWO.created_at,
                           join="wo"),
        "wo_closed_at": C("WO completed", "datetime", _LWO.closed_at,
                          join="wo"),
        "wo_invoiced_at": C("WO invoiced", "datetime", _LWO.invoiced_at,
                            join="wo"),
        "date": D("Date", "date",
                  lambda r, c: _eff_date(r, c, "service_date",
                                         "wo_closed_at", "wo_created_at"),
                  ("service_date", "wo_closed_at", "wo_created_at"),
                  "Effective date of the work order"),
        "month": D("Month", "text", lambda r, c: _month(r.get("date")),
                   ("date",)),
        "customer_id": C("Customer ID", "number", _LWO.customer_id,
                         join="wo", nosum=True),
        "customer_name": C("Customer", "text", _LWC.name, join="customer"),
        "payment_status": C("Payment", "text", _LWO.payment_status,
                            join="wo", enum=PAYMENT),
        "vendor_name": C("WO vendor", "text", _LWV.name, join="wo_vendor",
                         desc="Outside shop of the work order"),
        "billable_unit_price": D(
            "Billable unit price", "money",
            lambda r, c: (_price(r.get("kind"), r.get("unit_cost"),
                                 r.get("unit_price"),
                                 r.get("cust_parts_pct"),
                                 r.get("cust_labor_pct"))
                          if r.get("customer_id") else
                          (r.get("unit_price") if r.get("unit_price")
                           is not None else _num(r.get("unit_cost")))),
            ("kind", "unit_cost", "unit_price", "cust_parts_pct",
             "cust_labor_pct", "customer_id"), nosum=True),
        "billable_amount": D(
            "Billable amount", "money",
            lambda r, c: round(_num(r.get("billable_unit_price"))
                               * _num(r.get("qty")), 2),
            ("billable_unit_price", "qty"),
            "What the customer is charged for the line"),
        "part_category": C("Part type", "text", _LP.category, join="part",
                           desc="Catalog category of the part"),
        "part_manufacturer": C("Manufacturer", "text", _LP.manufacturer,
                               join="part"),
        "part_name": C("Catalog description", "text", _LP.description,
                       join="part"),
        "part_bin": C("Bin", "text", _LP.bin, join="part"),
        "part_vendor_name": C("Preferred vendor", "text", _LPV.name,
                              join="part_vendor"),
        "spend_category": D("Spend category", "text", _spend_cat,
                            ("kind", "part_number", "description",
                             "part_category"),
                            "Tires, Brakes, Engine, Oil/Fluids, "
                            "Electrical, Suspension, Shop Supplies, Labor, "
                            "Other"),
        "terminal": P("Location", "text", _line_terminal,
                      ("unit", "company")),
        "group": P("Group", "text", _line_group, ("unit",)),
    },
)


_PV = aliased(Vendor, name="part_vendor")


def _unit_value(r, ctx) -> float:
    avg = _num(r.get("avg_cost"))
    return avg if avg > 0 else _num(r.get("cost"))


PARTS = Source(
    key="parts", label="Parts", category="Parts & inventory",
    description=("One row per catalog part (inventory item) with stock on "
                 "hand, reorder point, costs (standard, weighted average, "
                 "last) and valuation."),
    model=Part,
    joins={"vendor": Join(_PV, Part.vendor_id == _PV.id)},
    default_time_field="created_at",
    fields={
        "id": C("Part ID", "number", Part.id, nosum=True),
        "part_number": C("Part #", "text", Part.part_number),
        "description": C("Part name", "text", Part.description),
        "category": C("Part type", "text", Part.category),
        "manufacturer": C("Manufacturer", "text", Part.manufacturer),
        "bin": C("Bin", "text", Part.bin, "Shelf / bin location"),
        "upc": C("UPC", "text", Part.upc),
        "fits": C("Fits", "text", Part.fits),
        "notes": C("Notes", "text", Part.notes),
        "cost": C("Standard cost", "money", Part.cost, nosum=True),
        "avg_cost": C("Avg weighted cost", "money", Part.avg_cost,
                      nosum=True),
        "last_cost": C("Last cost", "money", Part.last_cost, nosum=True),
        "unit_value": D("Valuation cost", "money", _unit_value,
                        ("avg_cost", "cost"),
                        "Average cost, or standard cost if never received",
                        nosum=True),
        "on_hand": C("Qty on hand", "number", Part.on_hand),
        "reorder_point": C("Order point", "number", Part.reorder_point,
                           nosum=True),
        "max_qty": C("Max qty", "number", Part.max_qty, nosum=True),
        "total_value": D("Total value", "money",
                         lambda r, c: round(_num(r.get("on_hand"))
                                            * _unit_value(r, c), 2),
                         ("on_hand", "avg_cost", "cost"),
                         "On hand × valuation cost"),
        "below_reorder": D("Below order point", "bool",
                           lambda r, c: _num(r.get("reorder_point")) > 0
                           and _num(r.get("on_hand"))
                           <= _num(r.get("reorder_point")),
                           ("on_hand", "reorder_point")),
        "core_charge": C("Core charge", "money", Part.core_charge,
                         nosum=True),
        "warranty_months": C("Warranty (months)", "number",
                             Part.warranty_months, nosum=True),
        "vendor_name": C("Preferred vendor", "text", _PV.name,
                         join="vendor"),
        "created_at": C("Created", "datetime", Part.created_at),
        "updated_at": C("Updated", "datetime", Part.updated_at),
        "last_used": P("Last used on a WO", "date", _post_part_usage,
                       ("part_number",)),
        "qty_used": P("Qty used (all WOs)", "number", _post_part_usage,
                      ("part_number",)),
        "qty_on_order": P("Qty on order", "number", _post_part_usage,
                          ("part_number",),
                          "Outstanding qty on ordered POs"),
    },
)


_MP = aliased(Part, name="move_part")

STOCK_MOVEMENTS = Source(
    key="stock_movements", label="Inventory transactions",
    category="Parts & inventory",
    description=("One row per inventory movement (parts ledger): PO "
                 "receipts and un-receipts, WO consumption, manual "
                 "adjustments and post-receipt cost corrections "
                 "(po_cost_adj: qty change 0, value change only)."),
    model=PartStockMovement,
    joins={"part": Join(_MP, _MP.part_number == PartStockMovement.part_number)},
    default_time_field="created_at",
    fields={
        "id": C("Movement ID", "number", PartStockMovement.id, nosum=True),
        "created_at": C("Date", "datetime", PartStockMovement.created_at),
        "part_number": C("Part #", "text", PartStockMovement.part_number),
        "delta": C("Qty change", "number", PartStockMovement.delta),
        "reason": C("Source", "text", PartStockMovement.reason,
                    enum=MOVE_REASON),
        "ref_type": C("Reference type", "text", PartStockMovement.ref_type),
        "ref_id": C("Reference", "text", PartStockMovement.ref_id),
        "note": C("Note", "text", PartStockMovement.note),
        "unit_cost": C("Unit cost", "money", PartStockMovement.unit_cost,
                       nosum=True),
        "value_delta": C("Value change", "money",
                         PartStockMovement.value_delta),
        "actor": C("User", "text", PartStockMovement.actor),
        "direction": D("Direction", "text",
                       lambda r, c: ("In" if _num(r.get("delta")) > 0 else
                                     "Out" if _num(r.get("delta")) < 0
                                     else "Value only"),
                       ("delta",)),
        "part_description": C("Part name", "text", _MP.description,
                              join="part"),
        "part_manufacturer": C("Manufacturer", "text", _MP.manufacturer,
                               join="part"),
        "part_category": C("Part type", "text", _MP.category, join="part"),
        "part_on_hand": C("Current on hand", "number", _MP.on_hand,
                          join="part", nosum=True),
    },
)


_POV = aliased(Vendor, name="po_vendor_rec")

PURCHASE_ORDERS = Source(
    key="purchase_orders", label="Purchase orders", category="Purchasing",
    description=("One row per purchase order. status is the receiving "
                 "cycle (draft/ordered/received); fin_status is the "
                 "financial cycle (open/closed). total = lines − discounts "
                 "− credits + shipping + tax + fees; paid = payments; "
                 "balance = total − paid."),
    model=PurchaseOrder,
    joins={"vendor": Join(_POV, PurchaseOrder.vendor_id == _POV.id)},
    default_time_field="created_at",
    fields={
        "id": C("PO #", "number", PurchaseOrder.id, nosum=True),
        "vendor": C("Vendor", "text", PurchaseOrder.vendor),
        "vendor_city": C("Vendor city", "text", _POV.city, join="vendor"),
        "vendor_state": C("Vendor state", "text", _POV.state, join="vendor"),
        "status": C("Receiving status", "text", PurchaseOrder.status,
                    enum=PO_STATUS),
        "fin_status": C("Financial status", "text", PurchaseOrder.fin_status,
                        enum=PO_FIN),
        "created_at": C("PO date", "datetime", PurchaseOrder.created_at),
        "received_at": C("Received", "datetime", PurchaseOrder.received_at,
                         "When the PO was fully received"),
        "closed_at": C("Closed", "datetime", PurchaseOrder.closed_at),
        "invoice_no": C("Vendor invoice #", "text",
                        PurchaseOrder.invoice_no),
        "invoice_date": C("Invoice date", "date",
                          PurchaseOrder.invoice_date),
        "tracking_no": C("Tracking #", "text", PurchaseOrder.tracking_no),
        "payment_method": C("Payment method", "text",
                            PurchaseOrder.payment_method, enum=PAY_METHOD),
        "notes": C("Notes", "text", PurchaseOrder.notes),
        "total": C("Total", "money", PurchaseOrder.total),
        "backorder_of_po_id": C("Backorder of PO", "number",
                                PurchaseOrder.backorder_of_po_id,
                                nosum=True),
        "is_backorder": D("Is backorder", "bool",
                          lambda r, c: bool(r.get("backorder_of_po_id")),
                          ("backorder_of_po_id",)),
        "line_count": P("Lines", "number", _post_po, ("id",)),
        "qty_ordered": P("Qty ordered", "number", _post_po, ("id",)),
        "qty_received": P("Qty received", "number", _post_po, ("id",)),
        "subtotal": P("Lines subtotal", "money", _post_po, ("id",)),
        "received_value": P("Received value", "money", _post_po, ("id",)),
        "discount": P("Discounts", "money", _post_po, ("id",)),
        "credit": P("Credits", "money", _post_po, ("id",)),
        "shipping": P("Shipping", "money", _post_po, ("id",)),
        "tax": P("Tax", "money", _post_po, ("id",)),
        "fees": P("Fees", "money", _post_po, ("id",)),
        "paid": P("Paid", "money", _post_po, ("id",)),
        "balance": D("Balance", "money",
                     lambda r, c: round(_num(r.get("total"))
                                        - _num(r.get("paid")), 2),
                     ("total", "paid")),
        "lead_time_days": D("Lead time (days)", "number",
                            lambda r, c: _days(r.get("created_at"),
                                               r.get("received_at"), c.tz),
                            ("created_at", "received_at"),
                            "Days from PO created to fully received "
                            "(approximation: no separate ordered date)",
                            nosum=True),
    },
)


_LPO = aliased(PurchaseOrder, name="line_po")
_POP = aliased(Part, name="po_line_part")


def _eff_line_cost(r, ctx) -> float:
    landed = r.get("landed_unit_cost")
    return _num(landed) if landed is not None else _num(r.get("unit_cost"))


PO_LINES = Source(
    key="po_lines", label="Purchase order lines", category="Purchasing",
    description=("One row per purchase order part line with ordered and "
                 "received quantities, unit cost and landed cost (cost "
                 "including allocated discounts/shipping/tax/fees). "
                 "Includes the PO vendor, status and dates."),
    model=POLine,
    joins={"po": Join(_LPO, POLine.po_id == _LPO.id),
           "part": Join(_POP, and_(_POP.part_number == POLine.part_number,
                                   POLine.part_number != ""))},
    default_time_field="po_created_at",
    fields={
        "id": C("Line ID", "number", POLine.id, nosum=True),
        "po_id": C("PO #", "number", POLine.po_id, nosum=True),
        "part_number": C("Part #", "text", POLine.part_number),
        "description": C("Part name", "text", POLine.description),
        "qty": C("Qty ordered", "number", POLine.qty),
        "unit_cost": C("Unit cost", "money", POLine.unit_cost, nosum=True),
        "landed_unit_cost": C("Landed unit cost", "money",
                              POLine.landed_unit_cost, nosum=True),
        "effective_unit_cost": D("Effective unit cost", "money",
                                 _eff_line_cost,
                                 ("landed_unit_cost", "unit_cost"),
                                 nosum=True),
        "taxable": C("Taxable", "bool", POLine.taxable),
        "qty_received": C("Qty received", "number", POLine.qty_received),
        "received_at": C("Received", "datetime", POLine.received_at,
                         "Last receipt of the line"),
        "amount": D("Extended price", "money",
                    lambda r, c: round(_num(r.get("qty"))
                                       * _num(r.get("unit_cost")), 2),
                    ("qty", "unit_cost")),
        "qty_open": D("Qty on order", "number",
                      lambda r, c: max(round(_num(r.get("qty"))
                                             - _num(r.get("qty_received")),
                                             4), 0.0),
                      ("qty", "qty_received"),
                      "Ordered − received"),
        "received_value": D("Received value", "money",
                            lambda r, c: round(_num(r.get("qty_received"))
                                               * _eff_line_cost(r, c), 2),
                            ("qty_received", "landed_unit_cost",
                             "unit_cost")),
        "po_vendor": C("Vendor", "text", _LPO.vendor, join="po"),
        "po_status": C("PO status", "text", _LPO.status, join="po",
                       enum=PO_STATUS),
        "po_fin_status": C("PO financial status", "text", _LPO.fin_status,
                           join="po", enum=PO_FIN),
        "po_created_at": C("PO date", "datetime", _LPO.created_at,
                           join="po"),
        "po_received_at": C("PO received", "datetime", _LPO.received_at,
                            join="po"),
        "po_invoice_no": C("Vendor invoice #", "text", _LPO.invoice_no,
                           join="po"),
        "part_category": C("Part type", "text", _POP.category, join="part"),
        "part_manufacturer": C("Manufacturer", "text", _POP.manufacturer,
                               join="part"),
        "part_on_hand": C("Qty on hand", "number", _POP.on_hand,
                          join="part", nosum=True),
    },
)


_APO = aliased(PurchaseOrder, name="adj_po")

PO_ADJUSTMENTS = Source(
    key="po_adjustments", label="Purchase order adjustments",
    category="Purchasing",
    description=("One row per PO financial adjustment: discount, credit, "
                 "shipping, tax, fee or payment. amount is always "
                 "positive; signed_amount applies the sign (discount and "
                 "credit negative). Voided adjustments stay with voided = "
                 "true."),
    model=PoAdjustment,
    joins={"po": Join(_APO, PoAdjustment.po_id == _APO.id)},
    default_time_field="created_at",
    fields={
        "id": C("Adjustment ID", "number", PoAdjustment.id, nosum=True),
        "po_id": C("PO #", "number", PoAdjustment.po_id, nosum=True),
        "kind": C("Kind", "text", PoAdjustment.kind, enum=ADJ_KIND),
        "amount": C("Amount", "money", PoAdjustment.amount),
        "signed_amount": D("Signed amount", "money",
                           lambda r, c: -_num(r.get("amount"))
                           if r.get("kind") in ("discount", "credit")
                           else _num(r.get("amount")),
                           ("kind", "amount")),
        "note": C("Note", "text", PoAdjustment.note),
        "allocate": C("Allocated to cost", "bool", PoAdjustment.allocate),
        "actor": C("User", "text", PoAdjustment.actor),
        "created_at": C("Date", "datetime", PoAdjustment.created_at),
        "voided_at": C("Voided", "datetime", PoAdjustment.voided_at),
        "void_reason": C("Void reason", "text", PoAdjustment.void_reason),
        "voided": D("Is voided", "bool",
                    lambda r, c: r.get("voided_at") is not None,
                    ("voided_at",)),
        "po_vendor": C("Vendor", "text", _APO.vendor, join="po"),
        "po_status": C("PO status", "text", _APO.status, join="po",
                       enum=PO_STATUS),
    },
)


VENDORS = Source(
    key="vendors", label="Vendors", category="Purchasing",
    description=("One row per vendor (parts supplier and/or outside "
                 "shop) with PO count and spend, outside work orders and "
                 "their total, and parts that list it as preferred."),
    model=Vendor,
    default_time_field="created_at",
    fields={
        "id": C("Vendor ID", "number", Vendor.id, nosum=True),
        "name": C("Vendor", "text", Vendor.name),
        "kind": C("Vendor type", "text", Vendor.kind, enum=VENDOR_KIND),
        "contact": C("Contact", "text", Vendor.contact),
        "phone": C("Phone", "text", Vendor.phone),
        "email": C("Email", "text", Vendor.email),
        "address": C("Address", "text", Vendor.address),
        "city": C("City", "text", Vendor.city),
        "state": C("State", "text", Vendor.state),
        "account": C("Account #", "text", Vendor.account),
        "notes": C("Notes", "text", Vendor.notes),
        "created_at": C("Created", "datetime", Vendor.created_at),
        "po_count": P("Purchase orders", "number", _post_vendor,
                      ("id", "name")),
        "po_spend": P("PO spend", "money", _post_vendor, ("id", "name")),
        "outside_wo_count": P("Outside WOs", "number", _post_vendor,
                              ("id", "name")),
        "outside_spend": P("Outside work total", "money", _post_vendor,
                           ("id", "name")),
        "parts_count": P("Preferred for parts", "number", _post_vendor,
                         ("id", "name")),
    },
)


_sr_terminal = _post_terminal("unit", "company")


def _sr_age(r, ctx):
    end = r.get("resolved_at") if r.get("status") in (
        "done", "denied") else None
    return _days(r.get("created_at"), end or ctx.today, ctx.tz)


SERVICE_REQUESTS = Source(
    key="service_requests", label="Service requests",
    category="Work orders",
    description=("One row per service request in the shop backlog: DVIR "
                 "defects, PM/DOT/Reefer PM due items and manual "
                 "requests. Deleted requests are excluded."),
    model=ServiceRequest,
    where=(ServiceRequest.status != "deleted",),
    default_time_field="created_at",
    fields={
        "id": C("Request ID", "number", ServiceRequest.id, nosum=True),
        "unit": C("Unit", "text", ServiceRequest.unit),
        "company": C("Company", "text", ServiceRequest.company),
        "source": C("Source", "text", ServiceRequest.source,
                    enum=SR_SOURCE),
        "title": C("Title", "text", ServiceRequest.title),
        "detail": C("Detail", "text", ServiceRequest.detail),
        "priority": C("Priority", "text", ServiceRequest.priority,
                      enum=SR_PRIORITY),
        "status": C("Status", "text", ServiceRequest.status,
                    enum=SR_STATUS),
        "wo_id": C("WO ID", "number", ServiceRequest.wo_id, nosum=True),
        "resolution": C("Resolution", "text", ServiceRequest.resolution),
        "created_by": C("Created by", "text", ServiceRequest.created_by),
        "created_at": C("Created", "datetime", ServiceRequest.created_at),
        "updated_at": C("Updated", "datetime", ServiceRequest.updated_at),
        "resolved_at": C("Resolved", "datetime", ServiceRequest.resolved_at),
        "snooze_until": C("Snoozed until", "date",
                          ServiceRequest.snooze_until),
        "follow_up_date": C("Follow-up", "date",
                            ServiceRequest.follow_up_date),
        "deny_reason": C("Deny reason", "text", ServiceRequest.deny_reason),
        "source_active": C("Source still active", "bool",
                           ServiceRequest.source_active),
        "age_days": D("Age (days)", "number", _sr_age,
                      ("created_at", "resolved_at", "status"),
                      "Days open (to resolution if closed)", nosum=True),
        "terminal": P("Location", "text", _sr_terminal, ("unit", "company")),
    },
)


MAINT_RECORDS = Source(
    key="maint_records", label="Maintenance history",
    category="PM & compliance",
    description=("One row per completed maintenance event per unit (PM, "
                 "DOT inspection, reefer PM, kingpins, DPF, clutch) with "
                 "odometer miles or engine hours at service."),
    model=MaintRecord,
    default_time_field="date",
    fields={
        "id": C("Record ID", "number", MaintRecord.id, nosum=True),
        "unit": C("Unit", "text", MaintRecord.unit),
        "kind": C("Service", "text", MaintRecord.kind, enum=CAMPAIGN),
        "date": C("Date", "date", MaintRecord.date),
        "mileage": C("Odometer (mi)", "number", MaintRecord.mileage,
                     nosum=True),
        "hours": C("Engine hours", "number", MaintRecord.hours, nosum=True),
        "notes": C("Notes", "text", MaintRecord.notes),
        "created_at": C("Logged", "datetime", MaintRecord.created_at),
    },
)


ODOMETER_READINGS = Source(
    key="odometer_readings", label="Odometer readings",
    category="Equipment",
    description=("One row per odometer reading (unit, date, miles, "
                 "source). Never mixed with engine hours."),
    model=OdometerReading,
    default_time_field="date",
    fields={
        "id": C("Reading ID", "number", OdometerReading.id, nosum=True),
        "unit": C("Unit", "text", OdometerReading.unit),
        "date": C("Date", "date", OdometerReading.date),
        "miles": C("Odometer (mi)", "number", OdometerReading.miles,
                   nosum=True),
        "source": C("Source", "text", OdometerReading.source,
                    enum=ODO_SOURCE),
        "created_at": C("Logged", "datetime", OdometerReading.created_at),
    },
)


METER_READINGS = Source(
    key="meter_readings", label="Engine hour readings",
    category="Equipment",
    description=("One row per engine-hours meter reading (reefer units): "
                 "unit, date, hours and source. Separate from the "
                 "odometer."),
    model=MeterReading,
    default_time_field="date",
    fields={
        "id": C("Reading ID", "number", MeterReading.id, nosum=True),
        "unit": C("Unit", "text", MeterReading.unit),
        "meter": C("Meter", "text", MeterReading.meter,
                   enum={"engine_hours": "Engine hours"}),
        "date": C("Date", "date", MeterReading.date),
        "value": C("Reading (hrs)", "number", MeterReading.value,
                   nosum=True),
        "source": C("Source", "text", MeterReading.source,
                    enum=METER_SOURCE),
        "is_reset": C("Meter reset", "bool", MeterReading.is_reset,
                      desc="Forced lower reading that starts a new meter "
                           "segment (controller swap / meter reset)"),
        "created_at": C("Logged", "datetime", MeterReading.created_at),
    },
)


DEFECTS = Source(
    key="defects", label="DVIR defects", category="PM & compliance",
    description=("One row per DVIR defect reported by a driver (from the "
                 "ELD inspection feed), with its repair status and "
                 "mechanic notes."),
    model=Defect,
    default_time_field="block_date",
    fields={
        "id": C("Defect ID", "number", Defect.id, nosum=True),
        "block_date": C("Report date", "date", Defect.block_date),
        "company": C("Company", "text", Defect.company),
        "driver": C("Driver", "text", Defect.driver),
        "unit": C("Unit", "text", Defect.unit),
        "unit_kind": C("Unit kind", "text", Defect.unit_kind),
        "dvir_type": C("Inspection type", "text", Defect.dvir_type),
        "status": C("Status", "text", Defect.status),
        "detail": C("Defect", "text", Defect.detail),
        "mechanic": C("Mechanic", "text", Defect.mechanic),
        "mechanic_notes": C("Mechanic notes", "text", Defect.mechanic_notes),
        "source": C("Source", "text", Defect.source),
    },
)


CUSTOMERS = Source(
    key="customers", label="Customers", category="Customers",
    description=("One row per customer (owner-operators and carriers "
                 "billed for shop parts and labor) with terms, markups, "
                 "units owned, work orders and billed / paid / open "
                 "balance amounts. Contact fields are personal data."),
    model=Customer,
    default_time_field="created_at",
    fields={
        "id": C("Customer ID", "number", Customer.id, nosum=True),
        "name": C("Customer", "text", Customer.name),
        "kind": C("Customer type", "text", Customer.kind,
                  enum=CUSTOMER_KIND),
        "active": C("Active", "bool", Customer.active),
        "since": C("Customer since", "date", Customer.since),
        "email": C("Email", "text", Customer.email, pii="email"),
        "phone": C("Phone", "text", Customer.phone, pii="phone"),
        "address": C("Address", "text", Customer.address, pii="text"),
        "city": C("City", "text", Customer.city),
        "state": C("State", "text", Customer.state),
        "zip": C("ZIP", "text", Customer.zip),
        "terms": C("Terms", "text", Customer.terms, enum=TERMS),
        "labor_markup_pct": C("Labor markup %", "number",
                              Customer.labor_markup_pct, nosum=True),
        "parts_markup_pct": C("Parts markup %", "number",
                              Customer.parts_markup_pct, nosum=True),
        "tax_exempt": C("Tax exempt", "bool", Customer.tax_exempt),
        "tax_rate_pct": C("Tax rate %", "number", Customer.tax_rate_pct,
                          nosum=True),
        "accounting_id": C("Accounting ID", "text", Customer.accounting_id),
        "driver_name": C("Linked driver", "text", Customer.driver_name),
        "tags": C("Tags", "text", Customer.tags),
        "notes": C("Notes", "text", Customer.notes),
        "created_at": C("Created", "datetime", Customer.created_at),
        "updated_at": C("Updated", "datetime", Customer.updated_at),
        "units_count": P("Units", "number", _post_customer, ("id",)),
        "wo_count": P("Work orders", "number", _post_customer, ("id",)),
        "open_wos": P("Open WOs", "number", _post_customer, ("id",)),
        "billed_all": P("Billed (all time)", "money", _post_customer,
                        ("id",)),
        "billed_ytd": P("Billed YTD", "money", _post_customer, ("id",)),
        "paid_all": P("Paid (all time)", "money", _post_customer, ("id",)),
        "open_balance": P("Open balance", "money", _post_customer, ("id",),
                          "Invoiced and unpaid"),
    },
)


WARRANTY_CLAIMS = Source(
    key="warranty_claims", label="Warranty claims",
    category="Parts & inventory",
    description=("One row per detected warranty claim: the same part "
                 "replaced on the same unit inside its warranty window."),
    model=WarrantyClaim,
    default_time_field="failure_date",
    fields={
        "id": C("Claim ID", "number", WarrantyClaim.id, nosum=True),
        "part_number": C("Part #", "text", WarrantyClaim.part_number),
        "description": C("Part name", "text", WarrantyClaim.description),
        "unit": C("Unit", "text", WarrantyClaim.unit),
        "vendor": C("Vendor", "text", WarrantyClaim.vendor),
        "install_wo": C("Install WO", "number", WarrantyClaim.install_wo,
                        nosum=True),
        "install_date": C("Installed", "date", WarrantyClaim.install_date),
        "failure_wo": C("Failure WO", "number", WarrantyClaim.failure_wo,
                        nosum=True),
        "failure_date": C("Failed", "date", WarrantyClaim.failure_date),
        "warranty_until": C("Warranty until", "date",
                            WarrantyClaim.warranty_until),
        "amount": C("Claim amount", "money", WarrantyClaim.amount),
        "status": C("Status", "text", WarrantyClaim.status,
                    enum=WARRANTY_STATUS),
        "created_at": C("Detected", "datetime", WarrantyClaim.created_at),
        "updated_at": C("Updated", "datetime", WarrantyClaim.updated_at),
    },
)


CORE_ITEMS = Source(
    key="core_items", label="Core returns", category="Parts & inventory",
    description=("One row per core (old part) owed back to a vendor to "
                 "recover its deposit, created when a part with a core "
                 "charge is received."),
    model=CoreItem,
    default_time_field="created_at",
    fields={
        "id": C("Core ID", "number", CoreItem.id, nosum=True),
        "part_number": C("Part #", "text", CoreItem.part_number),
        "description": C("Part name", "text", CoreItem.description),
        "vendor": C("Vendor", "text", CoreItem.vendor),
        "core_charge": C("Core charge", "money", CoreItem.core_charge,
                         nosum=True),
        "qty": C("Qty", "number", CoreItem.qty),
        "value": D("Deposit value", "money",
                   lambda r, c: round(_num(r.get("core_charge"))
                                      * _num(r.get("qty")), 2),
                   ("core_charge", "qty")),
        "po_id": C("PO #", "number", CoreItem.po_id, nosum=True),
        "status": C("Status", "text", CoreItem.status, enum=CORE_STATUS),
        "created_at": C("Received", "datetime", CoreItem.created_at),
        "returned_at": C("Returned", "datetime", CoreItem.returned_at),
        "days_out": D("Days out", "number",
                      lambda r, c: _days(r.get("created_at"),
                                         r.get("returned_at") or c.today,
                                         c.tz),
                      ("created_at", "returned_at"), nosum=True),
    },
)


# ---------------------------------------------------------------------------
# Fuentes provider (Python sobre lógica existente)
# ---------------------------------------------------------------------------

UNITS = Source(
    key="units", label="Equipment", category="Equipment",
    description=("One row per fleet unit (live ELD fleet + manually added "
                 "units) with type, year/make/model, plate, location, "
                 "group, operating status, owner customer, latest "
                 "odometer and latest engine hours."),
    provider=prov.units,
    default_time_field="odometer_date",
    fields={
        "unit": V("Unit"), "name": V("Nickname"),
        "unit_type": V("Type", desc="truck, trailer or chassis"),
        "subtype": V("Subtype"), "year": V("Year"),
        "make": V("Manufacturer"), "model": V("Model"),
        "vin": V("VIN"), "plate": V("License plate"),
        "plate_state": V("Plate state"), "company": V("Company"),
        "terminal": V("Location", desc="Terminal / assigned location"),
        "group": V("Group"),
        "ops_status": V("Status", enum=OPS_STATUS,
                        desc="'' = active; out_of_service; in_shop"),
        "archived": V("Archived", "bool"),
        "customer": V("Customer", desc="Owner customer (owner-operator)"),
        "source": V("Data source", desc="samsara, demo or manual"),
        "open_defects": V("Open defects", "number"),
        "odometer": V("Current odometer (mi)", "number", nosum=True),
        "odometer_date": V("Last reading date", "date"),
        "odometer_month_start": V("Month start odometer (mi)", "number",
                                  nosum=True),
        "odometer_year_start": V("Year start odometer (mi)", "number",
                                 nosum=True),
        "engine_hours": V("Engine hours", "number", nosum=True),
        "engine_hours_date": V("Engine hours date", "date"),
    },
)

TECHNICIANS = Source(
    key="technicians", label="Employees", category="Labor",
    description=("One row per technician / employee on the shop roster "
                 "with role, hourly rate, hire date and assigned work "
                 "orders (assignment is by name)."),
    provider=prov.technicians,
    default_time_field="hire_date",
    fields={
        "id": V("Employee ID", "number", nosum=True),
        "name": V("Technician"), "active": V("Active", "bool"),
        "role": V("Role"),
        "phone": V("Phone", pii="phone"),
        "email": V("Email", pii="email"),
        "hourly_rate": V("Hourly rate", "money", nosum=True),
        "hire_date": V("Hire date", "date"),
        "open_wos": V("Open WOs", "number"),
        "wo_count": V("Work orders (all)", "number"),
    },
)

DRIVERS = Source(
    key="drivers", label="Drivers", category="PM & compliance",
    description=("One row per active driver on the ELD roster with the "
                 "TMS profile: role, assigned truck/trailer and compliance "
                 "expirations (CDL, medical card, MVR, Clearinghouse) "
                 "with their state and days left. Contact is personal "
                 "data."),
    provider=prov.drivers,
    default_time_field="cdl_exp",
    fields={
        "name": V("Driver"), "company": V("Company"),
        "role": V("Role", enum={"owner_operator": "Owner-operator",
                                "company_driver": "Company driver",
                                "lease_operator": "Lease operator"}),
        "truck": V("Truck"), "trailer": V("Trailer"),
        "hired_date": V("Hired", "date"),
        "phone": V("Phone", pii="phone"), "email": V("Email", pii="email"),
        "license_number": V("License #", pii="text"),
        "license_state": V("License state"),
        "has_profile": V("Has TMS profile", "bool"),
        "cdl_exp": V("CDL expires", "date"),
        "cdl_state": V("CDL status", enum=DOC_STATE),
        "cdl_days": V("CDL days left", "number", nosum=True),
        "med_exp": V("Medical card expires", "date"),
        "med_state": V("Medical status", enum=DOC_STATE),
        "med_days": V("Medical days left", "number", nosum=True),
        "mvr_exp": V("MVR expires", "date"),
        "mvr_state": V("MVR status", enum=DOC_STATE),
        "chouse_exp": V("Clearinghouse expires", "date"),
        "chouse_state": V("Clearinghouse status", enum=DOC_STATE),
    },
)

DRIVER_DOCS = Source(
    key="driver_docs", label="Driver compliance documents",
    category="PM & compliance",
    description=("One row per driver × compliance document (CDL, Medical "
                 "card, MVR, Clearinghouse) with expiration date, state "
                 "(expired / expiring within 30 days / valid / missing) "
                 "and days left."),
    provider=prov.driver_docs,
    default_time_field="date",
    fields={
        "driver": V("Driver"), "truck": V("Truck"), "company": V("Company"),
        "role": V("Role"),
        "doc": V("Document", enum={"cdl_exp": "CDL",
                                   "med_exp": "Medical card",
                                   "mvr_exp": "MVR",
                                   "chouse_exp": "Clearinghouse"}),
        "doc_label": V("Document name"),
        "date": V("Expires", "date"),
        "state": V("Status", enum=DOC_STATE),
        "days": V("Days left", "number", nosum=True),
        "needs_attention": V("Needs attention", "bool"),
    },
)

PM_DUE = Source(
    key="pm_due", label="PMs due & overdue", category="PM & compliance",
    description=("One row per maintenance item that is overdue or coming "
                 "due (PM by miles, DOT by days, reefer PM by engine "
                 "hours with a days fallback) — the same list as the "
                 "Home card. to_due is in due_by units; negative = "
                 "overdue."),
    provider=prov.pm_due,
    default_time_field="next_due_date",
    fields={
        "unit": V("Unit"), "model": V("Equipment"),
        "campaign": V("Campaign", enum={"pm": "PM", "dot": "DOT",
                                        "reefer": "Reefer PM"}),
        "label": V("Service"),
        "status": V("Status", enum=DUE_STATUS),
        "due_by": V("Due by", enum=DUE_BY),
        "to_due": V("To due", "number", nosum=True,
                    desc="Remaining in due_by units; negative = overdue"),
        "unit_label": V("Units", desc="mi, days or hrs"),
        "to_due_days": V("Days to due", "number", nosum=True),
        "next_due": V("Next due"),
        "next_due_date": V("Next due date", "date"),
        "current_hours": V("Current engine hours", "number", nosum=True),
        "ops_status": V("Ops status", enum=OPS_STATUS),
        "customer": V("Customer"), "terminal": V("Location"),
    },
)

MAINT_BOARD = Source(
    key="maint_board", label="PM schedule (all units)",
    category="PM & compliance",
    description=("One row per unit × tracked campaign (PM by miles, DOT "
                 "by days, Reefer PM by engine hours) for EVERY unit, "
                 "including on-track ones: current meter, last service, "
                 "next due and remaining. Use pm_due for only due items."),
    provider=prov.maint_board,
    default_time_field="last_date",
    fields={
        "campaign": V("Campaign", enum={"pm": "PM", "dot": "DOT",
                                        "reefer": "Reefer PM"}),
        "service": V("Service"),
        "unit": V("Unit"), "model": V("Equipment"), "driver": V("Driver"),
        "status": V("Status", enum=DUE_STATUS,
                    desc="Due status, or the manual ops status"),
        "due_status": V("Due status", enum=DUE_STATUS),
        "ops_status": V("Ops status", enum=OPS_STATUS),
        "current_miles": V("Current mileage", "number", nosum=True),
        "current_hours": V("Current engine hours", "number", nosum=True),
        "last_date": V("Last performed", "date"),
        "last_miles": V("Last PM mileage", "number", nosum=True),
        "last_hours": V("Last PM engine hours", "number", nosum=True),
        "next_due_miles": V("PM due (mi)", "number", nosum=True),
        "next_due_hours": V("PM due (hrs)", "number", nosum=True),
        "next_due_date": V("Next due date", "date"),
        "to_due": V("To due", "number", nosum=True,
                    desc="Remaining in due_by units; negative = overdue"),
        "to_due_days": V("Days to due", "number", nosum=True),
        "due_by": V("Due by", enum=DUE_BY),
        "unit_label": V("Units", desc="mi, days or hrs"),
        "overdue_by": V("Overdue by", "number", nosum=True,
                        desc="How far past due (0 if not overdue)"),
        "since_last": V("Since last service", "number", nosum=True,
                        desc="Miles (PM), hours (reefer) or days (DOT) "
                             "since the last service"),
        "meter_missing": V("No meter reading", "bool"),
        "customer": V("Customer"), "terminal": V("Location"),
        "group": V("Group"),
    },
)

PM_COMPLIANCE = Source(
    key="pm_compliance", label="PM compliance", category="PM & compliance",
    description=("One row per unit in the fleet PM compliance report, "
                 "grouped by engine variant (DD13/DD15, ISX, generic) "
                 "plus the DOT inspection group — the same data as the "
                 "PM compliance dashboard."),
    provider=prov.pm_compliance,
    default_time_field="last_date",
    fields={
        "group_key": V("Group key"), "group": V("PM group"),
        "kind": V("Kind", enum={"pm": "PM", "dot": "DOT"}),
        "unit": V("Unit"), "model": V("Equipment"), "driver": V("Driver"),
        "status": V("Status", enum=DUE_STATUS),
        "compliant": V("Compliant", "bool",
                       desc="On track or upcoming (not overdue/never)"),
        "last_date": V("Last performed", "date"),
        "next_due_miles": V("Next due (mi)", "number", nosum=True),
        "next_due_date": V("Next due date", "date"),
        "to_due": V("To due", "number", nosum=True),
        "to_due_unit": V("Units"),
    },
)

SPEND_LINES = Source(
    key="spend_lines", label="Maintenance spend", category="Financial",
    description=("One row per work order line with spend (amount ≠ 0), "
                 "dated by the WO effective date, with spend category, "
                 "preventive vs reactive and location — the exact data "
                 "behind the Spend overview (same numbers as the spend "
                 "dashboard)."),
    provider=prov.spend_lines,
    default_time_field="date",
    fields={
        "wo_id": V("WO ID", "number", nosum=True), "wo_no": V("WO #"),
        "unit": V("Unit"), "company": V("Company"),
        "terminal": V("Location key"),
        "date": V("Date", "date"), "month": V("Month"),
        "kind": V("Line type", enum=LINE_KIND),
        "category": V("Category key"),
        "category_label": V("Spend category"),
        "part_number": V("Part #"), "description": V("Description"),
        "qty": V("Qty", "number"),
        "unit_cost": V("Unit cost", "money", nosum=True),
        "amount": V("Spend", "money"),
        "spend_type": V("Preventive / reactive"),
        "wo_type": V("WO type", enum=WO_TYPE),
        "mechanic": V("Technician"),
        "campaign": V("PM campaign", enum=CAMPAIGN),
        "status": V("WO status", enum=WO_STATUS),
    },
)

CPM = Source(
    key="cpm", label="Cost per mile", category="Financial",
    description=("One row per unit with maintenance spend in the period, "
                 "miles driven (from odometer readings) and cost per mile "
                 "(total, labor and parts). Units without miles have an "
                 "empty CPM. Same numbers as the CPM dashboard; the time "
                 "range is the period, not a row filter."),
    provider=prov.cpm,
    default_time_field="period",
    time_param=True,
    fields={
        "period": V("Period"), "unit": V("Unit"),
        "name": V("Nickname"), "terminal": V("Location"),
        "group": V("Group"), "ops_status": V("Status", enum=OPS_STATUS),
        "odometer": V("Latest odometer (mi)", "number", nosum=True),
        "miles": V("Miles driven", "number"),
        "spend": V("Total cost", "money"),
        "labor_spend": V("Labor cost", "money"),
        "parts_spend": V("Parts cost", "money"),
        "cpm": V("Total CPM", "money", nosum=True),
        "labor_cpm": V("Labor CPM", "money", nosum=True),
        "parts_cpm": V("Parts CPM", "money", nosum=True),
    },
)

UNIT_MILES = Source(
    key="unit_miles", label="Miles driven", category="Equipment",
    description=("One row per unit with miles driven in the period, from "
                 "odometer readings (positive, plausible increments only). "
                 "The time range is the period, not a row filter."),
    provider=prov.unit_miles,
    default_time_field="period",
    time_param=True,
    fields={
        "period": V("Period"), "unit": V("Unit"),
        "terminal": V("Location"), "group": V("Group"),
        "miles": V("Miles driven", "number"),
        "first_reading": V("First reading (mi)", "number", nosum=True),
        "last_reading": V("Last reading (mi)", "number", nosum=True),
    },
)


SOURCES: dict[str, Source] = {s.key: s for s in (
    WORK_ORDERS, WO_LINES, SERVICE_REQUESTS,
    PARTS, STOCK_MOVEMENTS, WARRANTY_CLAIMS, CORE_ITEMS,
    PURCHASE_ORDERS, PO_LINES, PO_ADJUSTMENTS, VENDORS,
    MAINT_RECORDS, PM_DUE, MAINT_BOARD, PM_COMPLIANCE, DEFECTS,
    DRIVERS, DRIVER_DOCS,
    UNITS, ODOMETER_READINGS, METER_READINGS, UNIT_MILES,
    CUSTOMERS, TECHNICIANS,
    SPEND_LINES, CPM,
)}

# Campos "por unidad" (costo/precio unitario, tarifas, %, promedios): son
# numéricos pero sumarlos no tiene sentido -> nosum automático, así el Σ del
# servidor (y el de los CSV/XLSX) coincide con el del frontend
# (reports/model.ts PER_UNIT_RE).
_PER_UNIT_RE = re.compile(
    r"(^|_)(unit_cost|unit_price|landed_unit_cost|avg_cost|last_cost|rate|"
    r"pct|markup)$|^avg_")

for _s in SOURCES.values():
    for _n, _f in _s.fields.items():
        _f.name = _n
        assert _f.type in TYPES, (_s.key, _n)
        if _f.type in ("number", "money") and _PER_UNIT_RE.search(_n):
            _f.nosum = True
    assert _s.default_time_field is None or _s.default_time_field in \
        _s.fields, _s.key


def get_source(key: str) -> Source | None:
    return SOURCES.get(key or "")


def field_meta(f: Field) -> dict:
    out = {"name": f.name, "label": f.label, "type": f.type,
           "desc": f.desc}
    if f.pii:
        out["pii"] = True
    if f.enum:
        out["enum"] = [{"value": k, "label": v} for k, v in f.enum.items()]
    if f.nosum:
        out["nosum"] = True
    return out


def time_fields(src: Source) -> list[str]:
    out = [n for n, f in src.fields.items()
           if not f.hidden and f.type in ("date", "datetime")]
    if src.time_param and src.default_time_field:
        out = [src.default_time_field]
    return out


def source_meta(src: Source) -> dict:
    return {
        "key": src.key,
        "label": src.label,
        "description": src.description,
        "category": src.category,
        "kind": "table" if src.is_sql else "computed",
        "default_time_field": src.default_time_field,
        "time_fields": time_fields(src),
        "time_is_period": src.time_param,
        "fields": [field_meta(f) for f in src.fields.values()
                   if not f.hidden],
    }


def catalog() -> list[dict]:
    return [source_meta(s) for s in SOURCES.values()]
