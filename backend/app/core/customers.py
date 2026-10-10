# -*- coding: utf-8 -*-
"""Customers (v2.22, Resources → Customers; benchmark SquareRigger).

El caso real del dueño: los owner-operators son CUSTOMERS del taller — sus
unidades reciben partes y labor que después se les cobran. SR tiene un
perfil de customer flaco (sin unidades, sin historial de WOs, sin saldo):
acá el perfil junta todo eso.

Modelo (db.Customer / CustomerContact / CustomerUnit):
- Nombre único por org (case-insensitive, espacios colapsados) a nivel app
  -> ValueError "customer already exists" (400).
- UN dueño por unidad (comparación normalizada: mayúsculas sin espacios, la
  regla de Service Requests). `set_unit` MUEVE la propiedad.
- Backfill: la primera vez que una org toca Customers, el texto libre
  `Unit.customer` de las unidades manuales (Fleet → Add New Unit, "Who is
  the customer?") se convierte en customers (kind owner_operator) y en sus
  unidades. Una sola vez por org (org_setting 'customers_backfill').

Pricing (Bill to: Customer en la WO):
- precio de una línea = costo × (1 + markup%) — `parts_markup_pct` para
  líneas de parte, `labor_markup_pct` para labor. Con markup 0 el precio es
  el costo tal cual (una WO de Self factura exactamente su total).
- Al FACTURAR una WO con customer se congela el precio en
  WorkOrderLine.unit_price (snapshot_prices); después nunca se recalcula:
  cambiar el markup no reescribe invoices viejos.
- billable_total = Σ (unit_price ?? costo×(1+markup)) × qty.
- Impuesto: la tasa del customer (`tax_rate_pct`; 0 si `tax_exempt`) se
  aplica a las PARTES facturadas (billable de las líneas de parte). Se
  congela en WorkOrder.tax_pct al facturar (como los precios); antes de
  facturar se muestra con la tasa vigente. billable_due = billable_total +
  billable_tax = lo que se le cobra (saldos, cobrado YTD, invoice).

PII: email/phone/address del customer y de sus contactos salen
enmascarados sin `pii.view` (lo decide la ruta con mask_*; acá los datos
van crudos). Los PATCH ignoran valores enmascarados que el cliente devuelve
tal cual (pii.is_masked).

Las escrituras masivas NO pasan por el filtro OrgScoped (solo SELECT): todo
se hace fila por fila sobre SELECTs ya acotados al tenant.
"""

from __future__ import annotations

import re
import threading
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from .. import db
from ..db import (Customer, CustomerContact, CustomerUnit, SessionLocal,
                  Unit, WorkOrder)
from . import org_config, pii, tenant

KINDS = ("owner_operator", "carrier", "external")
KIND_LABELS = {"owner_operator": "Owner-operator", "carrier": "Carrier",
               "external": "External"}
TERMS = ("", "cod", "net7", "net15", "net30", "2_10_net30", "prepay")
TERMS_LABELS = {"": "", "cod": "COD", "net7": "Net 7", "net15": "Net 15",
                "net30": "Net 30", "2_10_net30": "2% 10, Net 30",
                "prepay": "Prepay"}

EXISTS_MSG = "customer already exists"
NOT_FOUND_MSG = "customer not found"
NAME_MSG = "customer name is required"
_KIND_MSG = "kind must be owner_operator, carrier or external"
_TERMS_MSG = ("terms must be one of: cod, net7, net15, net30, 2_10_net30, "
              "prepay (or empty)")
_UNIT_MSG = "unit is required"

_CAPS = {"email": 120, "phone": 40, "address": 200, "city": 80,
         "state": 20, "zip": 12, "accounting_id": 60, "driver_name": 120,
         "tags": 200, "notes": 5000}
_PII_FIELDS = ("email", "phone", "address")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_WO_LIMIT = 500


# ----- Normalización ---------------------------------------------------------

def norm_unit(unit: str) -> str:
    """Unidad comparable: mayúsculas y sin espacios ('trl 53108' ==
    'TRL53108'). MISMA regla que service_requests._norm_unit."""
    return "".join((unit or "").split()).upper()


def _clean_unit(unit) -> str:
    return " ".join(str(unit or "").split())[:64]


def _clean_name(raw) -> str:
    return " ".join(str(raw or "").split())[:160]


def _name_key(name: str) -> str:
    return _clean_name(name).lower()


def _now() -> datetime:
    return datetime.now()


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def clean_customer_id(raw) -> int | None:
    """customer_id de un body: None/''/0 => sin customer (Self)."""
    if raw in (None, "", 0, "0"):
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise ValueError(NOT_FOUND_MSG)


# ----- Validación de campos ----------------------------------------------------

def _pct(raw, field: str, hi: float) -> float:
    try:
        v = float(raw if raw not in (None, "") else 0)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be a number")
    if v != v or v < 0 or v > hi:              # NaN o fuera de rango
        raise ValueError(f"{field} must be between 0 and {hi:g}")
    return round(v, 4)


def _since(raw) -> str | None:
    s = str(raw or "").strip()
    if not s:
        return None
    if not _DATE_RE.match(s):
        raise ValueError("since must be a date (YYYY-MM-DD)")
    try:
        datetime.strptime(s, "%Y-%m-%d")
    except ValueError:
        raise ValueError("since must be a date (YYYY-MM-DD)")
    return s


def _tags(raw) -> str:
    """Lista o texto separado por comas -> 'a, b' (sin duplicados)."""
    items = raw if isinstance(raw, (list, tuple)) else str(raw or "").split(",")
    out: list[str] = []
    seen: set[str] = set()
    for t in items:
        t = " ".join(str(t or "").split())[:40]
        if t and t.lower() not in seen:
            seen.add(t.lower())
            out.append(t)
    return ", ".join(out)[:_CAPS["tags"]]


def _apply(c: Customer, data: dict) -> None:
    """Aplica los campos presentes en `data` sobre `c` (create y PATCH).
    El nombre lo valida el caller (unicidad con sesión)."""
    if "kind" in data and data["kind"] is not None:
        kind = str(data["kind"] or "").strip().lower()
        if kind not in KINDS:
            raise ValueError(_KIND_MSG)
        c.kind = kind
    if "active" in data and data["active"] is not None:
        c.active = bool(data["active"])
    if "since" in data:
        c.since = _since(data["since"])
    for f in ("email", "phone", "address", "city", "state", "zip",
              "accounting_id", "driver_name", "notes"):
        if f not in data or data[f] is None:
            continue
        val = data[f]
        if f in _PII_FIELDS and pii.is_masked(val):
            continue                   # vino enmascarado: no se pisa el real
        val = str(val).strip()
        if f != "notes":
            val = " ".join(val.split())
        val = val[:_CAPS[f]]
        if f == "state":
            val = val.upper()
        if f == "email" and val and "@" not in val:
            raise ValueError("invalid email")
        setattr(c, f, val)
    if "tags" in data and data["tags"] is not None:
        c.tags = _tags(data["tags"])
    if "terms" in data and data["terms"] is not None:
        terms = str(data["terms"] or "").strip().lower()
        if terms not in TERMS:
            raise ValueError(_TERMS_MSG)
        c.terms = terms
    for f, hi in (("labor_markup_pct", 1000.0), ("parts_markup_pct", 1000.0),
                  ("tax_rate_pct", 100.0)):
        if f in data and data[f] is not None:
            setattr(c, f, _pct(data[f], f, hi))
    if "tax_exempt" in data and data["tax_exempt"] is not None:
        c.tax_exempt = bool(data["tax_exempt"])


def _name_taken(session, name: str, exclude_id: int | None = None) -> bool:
    q = select(Customer.id).where(func.lower(Customer.name) == name.lower())
    if exclude_id is not None:
        q = q.where(Customer.id != exclude_id)
    if session.scalar(q.limit(1)) is not None:
        return True
    # func.lower de SQLite solo baja ASCII: confirmación en Python.
    key = _name_key(name)
    rows = session.scalars(select(Customer)).all()
    return any(_name_key(c.name) == key and c.id != exclude_id for c in rows)


# ----- Serializers ---------------------------------------------------------------

def customer_dict(c: Customer) -> dict:
    """Dict COMPLETO (crudo, sin enmascarar: la ruta decide)."""
    return {
        "id": c.id,
        "name": c.name,
        "kind": c.kind or "owner_operator",
        "kind_label": KIND_LABELS.get(c.kind or "", c.kind or ""),
        "active": bool(c.active),
        "since": c.since or None,
        "email": c.email or "",
        "phone": c.phone or "",
        "address": c.address or "",
        "city": c.city or "",
        "state": c.state or "",
        "zip": c.zip or "",
        "terms": c.terms or "",
        "terms_label": TERMS_LABELS.get(c.terms or "", c.terms or ""),
        "labor_markup_pct": float(c.labor_markup_pct or 0.0),
        "parts_markup_pct": float(c.parts_markup_pct or 0.0),
        "tax_exempt": bool(c.tax_exempt),
        "tax_rate_pct": float(c.tax_rate_pct or 0.0),
        "accounting_id": c.accounting_id or "",
        "driver_name": c.driver_name or "",
        "notes": c.notes or "",
        "tags": c.tags or "",
        "created_at": _iso(c.created_at),
        "updated_at": _iso(c.updated_at),
    }


def contact_dict(ct: CustomerContact) -> dict:
    return {
        "id": ct.id,
        "customer_id": ct.customer_id,
        "name": ct.name or "",
        "role": ct.role or "",
        "email": ct.email or "",
        "phone": ct.phone or "",
        "is_billing": bool(ct.is_billing),
    }


def _bill_to(c: Customer) -> dict:
    """Bill-To del invoice: datos del customer; email/teléfono/atención del
    contacto de facturación si hay uno."""
    billing = next((ct for ct in c.contacts if ct.is_billing), None)
    return {
        "customer_id": c.id,
        "name": c.name,
        "contact": (billing.name or "") if billing else "",
        "address": c.address or "",
        "city": c.city or "",
        "state": c.state or "",
        "zip": c.zip or "",
        "phone": ((billing.phone if billing and billing.phone else c.phone)
                  or ""),
        "email": ((billing.email if billing and billing.email else c.email)
                  or ""),
        "terms": c.terms or "",
        "terms_label": TERMS_LABELS.get(c.terms or "", c.terms or ""),
    }


def mask_customer(d: dict) -> dict:
    out = dict(d)
    if "email" in out:
        out["email"] = pii.mask_email(out["email"])
    if "phone" in out:
        out["phone"] = pii.mask_phone(out["phone"])
    if "address" in out:
        out["address"] = pii.mask_text(out["address"])
    return out


def mask_contact(d: dict) -> dict:
    out = dict(d)
    out["email"] = pii.mask_email(out.get("email", ""))
    out["phone"] = pii.mask_phone(out.get("phone", ""))
    return out


def mask_profile(p: dict) -> dict:
    """Profile/GET con la PII enmascarada (sin pii.view)."""
    out = dict(p)
    out["customer"] = mask_customer(p["customer"])
    out["contacts"] = [mask_contact(ct) for ct in p.get("contacts") or []]
    if p.get("bill_to"):
        out["bill_to"] = mask_customer(p["bill_to"])
    out["pii_masked"] = True
    return out


# ----- Pricing (markup + snapshot al facturar) ------------------------------

def markups(c: Customer | None) -> tuple[float, float]:
    """(parts_pct, labor_pct) del customer; (0, 0) para Self."""
    if c is None:
        return 0.0, 0.0
    return float(c.parts_markup_pct or 0.0), float(c.labor_markup_pct or 0.0)


def price_for(kind: str, unit_cost, parts_pct: float,
              labor_pct: float) -> float:
    """Precio unitario de venta. Sin markup = el costo tal cual (sin
    redondear: una WO de Self factura exactamente su total); con markup se
    redondea al centavo."""
    pct = parts_pct if kind == "part" else labor_pct
    cost = float(unit_cost or 0.0)
    if not pct:
        return cost
    return round(cost * (1.0 + pct / 100.0), 2)


def line_price(ln, parts_pct: float, labor_pct: float) -> float:
    """Precio efectivo de una línea: el congelado si hay snapshot, si no el
    calculado en vivo con el markup vigente."""
    if ln.unit_price is not None:
        return float(ln.unit_price)
    return price_for(ln.kind, ln.unit_cost, parts_pct, labor_pct)


def billable_total(wo: WorkOrder, c: Customer | None) -> float:
    p, l = markups(c)
    return round(sum(line_price(ln, p, l) * float(ln.qty or 0.0)
                     for ln in wo.lines), 2)


def tax_rate(c: Customer | None) -> float:
    """Tasa de impuesto vigente del customer (%); 0 para Self o exento."""
    if c is None or c.tax_exempt:
        return 0.0
    return max(0.0, float(c.tax_rate_pct or 0.0))


def wo_tax_pct(wo: WorkOrder, c: Customer | None) -> float:
    """Tasa de la WO: la congelada al facturar, si no la vigente."""
    if not wo.customer_id or c is None:
        return 0.0
    if wo.tax_pct is not None:
        return max(0.0, float(wo.tax_pct))
    return tax_rate(c)


def billable_tax(wo: WorkOrder, c: Customer | None) -> float:
    """Impuesto sobre las partes facturadas (precio de venta × qty)."""
    pct = wo_tax_pct(wo, c)
    if not pct:
        return 0.0
    p, l = markups(c)
    parts = round(sum(line_price(ln, p, l) * float(ln.qty or 0.0)
                      for ln in wo.lines if ln.kind == "part"), 2)
    return round(parts * pct / 100.0, 2)


def billable_due(wo: WorkOrder, c: Customer | None) -> float:
    """Lo que se le cobra al customer: billable_total + impuesto."""
    return round(billable_total(wo, c) + billable_tax(wo, c), 2)


def snapshot_prices(session, wo: WorkOrder) -> int:
    """Congela unit_price en las líneas SIN snapshot de una WO con customer
    (se llama al pasar a invoiced) y, la primera vez, la tasa de impuesto
    del customer (WorkOrder.tax_pct). Lo ya congelado no se toca
    (des-facturar y re-facturar no re-precia). Devuelve cuántas líneas
    congeló."""
    if not wo.customer_id:
        return 0
    c = session.get(Customer, wo.customer_id)
    if c is None:
        return 0
    if wo.tax_pct is None:
        wo.tax_pct = tax_rate(c)
    p, l = markups(c)
    n = 0
    for ln in wo.lines:
        if ln.unit_price is None:
            ln.unit_price = price_for(ln.kind, ln.unit_cost, p, l)
            n += 1
    return n


# ----- Dueño de una unidad ---------------------------------------------------------

def _owner_rows(session, unit: str) -> list[CustomerUnit]:
    key = norm_unit(unit)
    if not key:
        return []
    rows = session.scalars(select(CustomerUnit).where(
        func.upper(func.replace(CustomerUnit.unit, " ", "")) == key)).all()
    return [r for r in rows if norm_unit(r.unit) == key]


def owner_customer_id(session, unit: str, active_only: bool = True) -> int | None:
    """Customer dueño de `unit` (o None). Solo lectura: usable dentro de la
    transacción de otra escritura (create_wo_in). Sin tenant en contexto
    (scripts / trabajos de fondo) no se resuelve: el SELECT no estaría
    acotado a una org y podría devolver el dueño de OTRA organización."""
    if tenant.get_current_org() is None:
        return None
    for r in _owner_rows(session, unit):
        if not active_only:
            return r.customer_id
        c = session.get(Customer, r.customer_id)
        if c is not None and c.active:
            return r.customer_id
    return None


def owner_of(unit: str) -> dict | None:
    """{id, name} del dueño activo de la unidad, o None."""
    with SessionLocal() as session:
        cid = owner_customer_id(session, unit)
        if cid is None:
            return None
        c = session.get(Customer, cid)
        return {"id": c.id, "name": c.name} if c is not None else None


def resolve_for_wo(session, unit: str, raw) -> int | None:
    """customer_id de una WO NUEVA: `raw` None (no vino) => el dueño de la
    unidad; 0/'' => Self explícito; un id => debe existir en la org."""
    if raw is None:
        return owner_customer_id(session, unit)
    cid = clean_customer_id(raw)
    if cid is None:
        return None
    if session.get(Customer, cid) is None:
        raise ValueError(NOT_FOUND_MSG)
    return cid


# ----- Backfill desde Unit.customer (una vez por org) ------------------------

_BACKFILL_KEY = "customers_backfill"
_backfilled: set[int] = set()
_backfill_guard = threading.Lock()


def _run_backfill() -> int:
    """Texto libre Unit.customer -> customers + unidades. Devuelve cuántas
    unidades ligó. Match de nombre case-insensitive; si falta el customer se
    crea (owner_operator). Una unidad que ya tiene dueño no se toca."""
    linked = 0
    now = _now()
    with SessionLocal() as session:
        units = session.scalars(select(Unit).where(Unit.customer != "")
                                .order_by(Unit.id)).all()
        if not units:
            return 0
        by_name = {_name_key(c.name): c
                   for c in session.scalars(select(Customer)).all()}
        owned = {norm_unit(r.unit)
                 for r in session.scalars(select(CustomerUnit)).all()}
        for u in units:
            name = _clean_name(u.customer)
            key = norm_unit(u.unit)
            if not name or not key:
                continue
            c = by_name.get(name.lower())
            if c is None:
                c = Customer(name=name, kind="owner_operator", active=True,
                             created_at=now, updated_at=now)
                session.add(c)
                session.flush()
                by_name[name.lower()] = c
            if key in owned:
                continue
            session.add(CustomerUnit(customer_id=c.id,
                                     unit=_clean_unit(u.unit),
                                     created_at=now))
            owned.add(key)
            linked += 1
        session.commit()
    return linked


def ensure_backfill() -> None:
    """Corre el backfill la PRIMERA vez que la org toca Customers. Marca en
    org_setting (db.update_setting serializa: dos requests simultáneos no
    duplican customers). NO llamar con una transacción de escritura abierta
    (escribe en su propia sesión)."""
    token = None
    org = tenant.get_current_org()
    if org is None:                     # trabajo de fondo / script: 'default'
        org = db.default_org_id()
        token = tenant.set_current_org(org)
    try:
        if org in _backfilled:
            return
        with _backfill_guard:
            if org in _backfilled:
                return
            data = db.get_setting(_BACKFILL_KEY)
            if not (isinstance(data, dict) and data.get("done")):
                def _fn(cur):
                    if isinstance(cur, dict) and cur.get("done"):
                        return cur
                    n = _run_backfill()
                    return {"done": True, "linked": n,
                            "at": _now().isoformat()}
                db.update_setting(_BACKFILL_KEY, _fn)
            _backfilled.add(org)
    finally:
        if token is not None:
            tenant.reset_current_org(token)


def reset_backfill_cache() -> None:
    """Tests: olvida qué orgs ya se backfillearon en este proceso."""
    _backfilled.clear()


def link_unit_text(unit: str, customer_name: str) -> int | None:
    """Hook de Fleet → Add New Unit (texto "Who is the customer?"): si la
    unidad todavía no tiene dueño, la liga al customer de ese nombre (lo
    crea si falta). Una unidad con dueño NO se mueve (el dueño se cambia
    desde Customers). Devuelve el customer_id ligado o None."""
    name = _clean_name(customer_name)
    unit_c = _clean_unit(unit)
    if not name or not unit_c or tenant.get_current_org() is None:
        return None                    # sin tenant: lo hará el backfill
    now = _now()
    with SessionLocal() as session:
        if _owner_rows(session, unit_c):
            return None
        c = next((x for x in session.scalars(select(Customer)).all()
                  if _name_key(x.name) == name.lower()), None)
        if c is None:
            c = Customer(name=name, kind="owner_operator", active=True,
                         created_at=now, updated_at=now)
            session.add(c)
            session.flush()
        session.add(CustomerUnit(customer_id=c.id, unit=unit_c,
                                 created_at=now))
        session.commit()
        return c.id


# ----- CRUD ------------------------------------------------------------------------

def _new_customer(session, data: dict, default_kind: str = "owner_operator"
                  ) -> Customer:
    name = _clean_name(data.get("name"))
    if not name:
        raise ValueError(NAME_MSG)
    if _name_taken(session, name):
        raise ValueError(EXISTS_MSG)
    now = _now()
    c = Customer(name=name, kind=default_kind, active=True,
                 created_at=now, updated_at=now)
    _apply(c, {k: v for k, v in data.items() if k != "name"})
    session.add(c)
    session.flush()
    return c


def create_customer(data: dict) -> dict:
    with SessionLocal() as session:
        c = _new_customer(session, data or {})
        session.commit()
        return customer_dict(c)


def quick_create(data: dict) -> dict:
    """Alta rápida desde el picker de la WO ("+ Quick add customer"): solo
    nombre (+ kind/phone/email opcionales). Si ya existe uno con ese nombre
    (case-insensitive) se devuelve ESE (con `existing: true`) en vez de
    fallar: el usuario quería elegirlo."""
    data = data or {}
    name = _clean_name(data.get("name"))
    if not name:
        raise ValueError(NAME_MSG)
    fields = {k: data.get(k) for k in ("name", "kind", "phone", "email")
              if data.get(k) not in (None, "")}
    with SessionLocal() as session:
        hit = next((c for c in session.scalars(select(Customer)).all()
                    if _name_key(c.name) == name.lower()), None)
        if hit is not None:
            return {**customer_dict(hit), "existing": True}
        c = _new_customer(session, fields)
        session.commit()
        return {**customer_dict(c), "existing": False}


def update_customer(customer_id: int, data: dict) -> dict | None:
    data = data or {}
    with SessionLocal() as session:
        c = session.get(Customer, customer_id)
        if c is None:
            return None
        if "name" in data and data["name"] is not None:
            name = _clean_name(data["name"])
            if not name:
                raise ValueError(NAME_MSG)
            if _name_key(name) != _name_key(c.name) or name != c.name:
                if _name_taken(session, name, exclude_id=c.id):
                    raise ValueError(EXISTS_MSG)
            c.name = name
        _apply(c, {k: v for k, v in data.items() if k != "name"})
        c.updated_at = _now()
        session.commit()
        return customer_dict(c)


def delete_customer(customer_id: int) -> dict | None:
    """Borrado SUAVE si tiene work orders (active=False: el historial y los
    saldos siguen); si no tiene ninguna, se borra del todo (contactos y
    unidades en cascada). None = no existe."""
    with SessionLocal() as session:
        c = session.get(Customer, customer_id)
        if c is None:
            return None
        n = session.scalar(select(func.count()).select_from(WorkOrder).where(
            WorkOrder.customer_id == c.id)) or 0
        if n:
            c.active = False
            c.updated_at = _now()
            session.commit()
            return {"ok": True, "deleted": False, "deactivated": True,
                    "customer": customer_dict(c)}
        session.delete(c)
        session.commit()
        return {"ok": True, "deleted": True, "deactivated": False,
                "customer": None}


# ----- Contactos -------------------------------------------------------------------

def _apply_contact(ct: CustomerContact, data: dict) -> None:
    for f, cap in (("name", 120), ("role", 60), ("email", 120),
                   ("phone", 40)):
        if f not in data or data[f] is None:
            continue
        val = data[f]
        if f in ("email", "phone") and pii.is_masked(val):
            continue
        val = " ".join(str(val).split())[:cap]
        if f == "email" and val and "@" not in val:
            raise ValueError("invalid email")
        setattr(ct, f, val)
    if "is_billing" in data and data["is_billing"] is not None:
        ct.is_billing = bool(data["is_billing"])


def _only_one_billing(c: Customer, keep: CustomerContact) -> None:
    if keep.is_billing:
        for other in c.contacts:
            if other is not keep and other.is_billing:
                other.is_billing = False


def add_contact(customer_id: int, data: dict) -> dict | None:
    data = data or {}
    with SessionLocal() as session:
        c = session.get(Customer, customer_id)
        if c is None:
            return None
        ct = CustomerContact(customer_id=c.id)
        _apply_contact(ct, data)
        if not (ct.name or ct.email or ct.phone):
            raise ValueError("contact needs a name, email or phone")
        c.contacts.append(ct)
        _only_one_billing(c, ct)
        c.updated_at = _now()
        session.commit()
        return contact_dict(ct)


def update_contact(customer_id: int, contact_id: int,
                   data: dict) -> dict | None:
    with SessionLocal() as session:
        c = session.get(Customer, customer_id)
        if c is None:
            return None
        ct = next((x for x in c.contacts if x.id == contact_id), None)
        if ct is None:
            return None
        _apply_contact(ct, data or {})
        if not (ct.name or ct.email or ct.phone):
            raise ValueError("contact needs a name, email or phone")
        _only_one_billing(c, ct)
        c.updated_at = _now()
        session.commit()
        return contact_dict(ct)


def delete_contact(customer_id: int, contact_id: int) -> bool:
    with SessionLocal() as session:
        c = session.get(Customer, customer_id)
        if c is None:
            return False
        ct = next((x for x in c.contacts if x.id == contact_id), None)
        if ct is None:
            return False
        c.contacts.remove(ct)
        c.updated_at = _now()
        session.commit()
        return True


# ----- Unidades del customer --------------------------------------------------------

def set_unit(customer_id: int, unit: str,
             known_units: list[str] | None = None) -> dict | None:
    """Liga `unit` al customer. Si la unidad tenía OTRO dueño, la propiedad
    se MUEVE (un dueño por unidad). `known_units` (nombres de la flota) da
    la grafía canónica ('mem77' -> 'MEM 77'). None = customer inexistente."""
    unit_c = _clean_unit(unit)
    if not unit_c:
        raise ValueError(_UNIT_MSG)
    key = norm_unit(unit_c)
    for k in known_units or []:
        if norm_unit(k) == key:
            unit_c = _clean_unit(k)
            break
    with SessionLocal() as session:
        c = session.get(Customer, customer_id)
        if c is None:
            return None
        moved_from: list[int] = []
        mine = None
        for r in _owner_rows(session, unit_c):
            if r.customer_id == c.id and mine is None:
                mine = r
                continue
            if r.customer_id != c.id:
                moved_from.append(r.customer_id)
            session.delete(r)
        if mine is None:
            session.add(CustomerUnit(customer_id=c.id, unit=unit_c,
                                     created_at=_now()))
        else:
            mine.unit = unit_c
        c.updated_at = _now()
        session.commit()
        units = [r.unit for r in session.scalars(
            select(CustomerUnit).where(CustomerUnit.customer_id == c.id)
            .order_by(CustomerUnit.id)).all()]
        return {"customer_id": c.id, "unit": unit_c,
                "moved_from": sorted(set(moved_from)), "units": units}


def remove_unit(customer_id: int, unit: str) -> bool | None:
    """Quita la unidad del customer. None = customer inexistente; False =
    la unidad no era suya."""
    with SessionLocal() as session:
        c = session.get(Customer, customer_id)
        if c is None:
            return None
        rows = [r for r in _owner_rows(session, unit)
                if r.customer_id == c.id]
        if not rows:
            return False
        for r in rows:
            session.delete(r)
        c.updated_at = _now()
        session.commit()
        return True


# ----- Lecturas ---------------------------------------------------------------------

def _invoiced(wo: WorkOrder) -> bool:
    return wo.status == "invoiced" or wo.invoiced_at is not None


def list_customers(q: str = "", active: bool | None = None) -> list[dict]:
    """Listado con KPIs por customer: units_count, open_wos (no
    facturadas) y balance (facturado & unpaid, precio de venta). `q` busca
    en nombre, ciudad/estado, tags, accounting id y driver (NUNCA en PII:
    el match revelaría datos enmascarados)."""
    ensure_backfill()
    qn = " ".join((q or "").split()).lower()
    with SessionLocal() as session:
        query = select(Customer).order_by(func.lower(Customer.name),
                                          Customer.id)
        if active is not None:
            query = query.where(Customer.active.is_(bool(active)))
        rows = session.scalars(query).all()
        if qn:
            rows = [c for c in rows if qn in " ".join([
                c.name or "", c.city or "", c.state or "", c.tags or "",
                c.accounting_id or "", c.driver_name or ""]).lower()]
        ids = [c.id for c in rows]
        if not ids:
            return []
        units: dict[int, list[str]] = {}
        for r in session.scalars(select(CustomerUnit).where(
                CustomerUnit.customer_id.in_(ids))
                .order_by(CustomerUnit.id)).all():
            units.setdefault(r.customer_id, []).append(r.unit)
        open_wos = dict(session.execute(
            select(WorkOrder.customer_id, func.count())
            .where(WorkOrder.customer_id.in_(ids),
                   WorkOrder.status != "invoiced")
            .group_by(WorkOrder.customer_id)).all())
        unpaid = session.scalars(
            select(WorkOrder).options(selectinload(WorkOrder.lines))
            .where(WorkOrder.customer_id.in_(ids),
                   WorkOrder.status == "invoiced",
                   WorkOrder.payment_status != "paid")).all()
        by_id = {c.id: c for c in rows}
        balance: dict[int, float] = {}
        for wo in unpaid:
            balance[wo.customer_id] = balance.get(wo.customer_id, 0.0) + \
                billable_due(wo, by_id.get(wo.customer_id))
        return [{
            "id": c.id,
            "name": c.name,
            "kind": c.kind or "owner_operator",
            "kind_label": KIND_LABELS.get(c.kind or "", c.kind or ""),
            "active": bool(c.active),
            "city": c.city or "",
            "state": c.state or "",
            "since": c.since or None,
            "terms": c.terms or "",
            "tags": c.tags or "",
            "driver_name": c.driver_name or "",
            "units_count": len(units.get(c.id, [])),
            "units": units.get(c.id, []),
            "open_wos": int(open_wos.get(c.id, 0)),
            "balance": round(balance.get(c.id, 0.0), 2),
        } for c in rows]


def get_customer(customer_id: int) -> dict | None:
    """Dict simple del customer (sin profile)."""
    with SessionLocal() as session:
        c = session.get(Customer, customer_id)
        return customer_dict(c) if c is not None else None


def bill_to(customer_id: int | None) -> dict | None:
    """Bill-To crudo (server-side: invoice por email) o None."""
    if not customer_id:
        return None
    with SessionLocal() as session:
        c = session.get(Customer, customer_id)
        return _bill_to(c) if c is not None else None


def _manual_models(session) -> dict[str, dict]:
    return {norm_unit(u.unit): {"model": u.model or "", "make": u.make or "",
                                "year": u.year or "",
                                "unit_type": u.unit_type or ""}
            for u in session.scalars(select(Unit)).all()}


def profile(customer_id: int,
            fleet_models: dict[str, dict] | None = None) -> dict | None:
    """Perfil completo (lo que SR no tiene): contactos, unidades, historial
    de WOs, partes facturadas y totales. `fleet_models` = {unidad
    normalizada: {model, make, year}} de la flota viva (lo arma la ruta;
    las unidades manuales se completan acá)."""
    from .workorders import _display_no   # import diferido (ciclo)
    with SessionLocal() as session:
        c = session.get(Customer, customer_id)
        if c is None:
            return None
        models = _manual_models(session)
        models.update(fleet_models or {})
        units = []
        for r in c.units:
            m = models.get(norm_unit(r.unit)) or {}
            units.append({"unit": r.unit, "model": m.get("model", ""),
                          "make": m.get("make", ""),
                          "year": m.get("year", ""),
                          "since": _iso(r.created_at)})
        wos = session.scalars(
            select(WorkOrder).options(selectinload(WorkOrder.lines))
            .where(WorkOrder.customer_id == c.id)
            .order_by(WorkOrder.id.desc())).all()
        p_pct, l_pct = markups(c)
        year = org_config.org_today().year
        billed_ytd = billed_all = open_balance = paid_all = 0.0
        open_wos = 0
        parts: dict[str, dict] = {}
        wo_rows: list[dict] = []
        for wo in wos:
            bt = billable_total(wo, c)
            # Lo cobrado / adeudado incluye el impuesto (sobre partes).
            due = billable_due(wo, c)
            inv = _invoiced(wo)
            if inv:
                billed_all += due
                inv_date = org_config.to_org_date(wo.invoiced_at)
                if inv_date is not None and inv_date.year == year:
                    billed_ytd += due
                if (wo.payment_status or "unpaid") == "paid":
                    paid_all += due
                else:
                    open_balance += due
                for ln in wo.lines:
                    if ln.kind != "part":
                        continue
                    pn = (ln.part_number or "").strip()
                    k = pn.upper() or f"~{(ln.description or '').lower()}"
                    e = parts.setdefault(k, {
                        "part_number": pn,
                        "description": ln.description or "",
                        "qty": 0.0, "amount": 0.0, "wo_count": 0,
                        "_wos": set()})
                    e["qty"] += float(ln.qty or 0.0)
                    e["amount"] += line_price(ln, p_pct, l_pct) * \
                        float(ln.qty or 0.0)
                    e["_wos"].add(wo.id)
            else:
                open_wos += 1
            if len(wo_rows) < _WO_LIMIT:
                wo_rows.append({
                    "id": wo.id,
                    "display_no": _display_no(wo),
                    "unit": wo.unit,
                    "title": wo.title,
                    "status": wo.status,
                    "wo_type": wo.wo_type or "inside",
                    "created_at": _iso(wo.created_at),
                    "invoiced_at": _iso(wo.invoiced_at),
                    "invoice_number": wo.invoice_number or "",
                    "total": round(sum(float(ln.qty or 0) *
                                       float(ln.unit_cost or 0)
                                       for ln in wo.lines), 2),
                    "billable_total": bt,
                    "billable_tax": round(due - bt, 2),
                    "billable_due": due,
                    "payment_status": wo.payment_status or "unpaid",
                    "paid_at": _iso(wo.paid_at),
                })
        parts_billed = []
        for e in parts.values():
            e["wo_count"] = len(e.pop("_wos"))
            e["qty"] = round(e["qty"], 2)
            e["amount"] = round(e["amount"], 2)
            parts_billed.append(e)
        parts_billed.sort(key=lambda e: (-e["amount"], e["part_number"],
                                         e["description"]))
        return {
            "customer": customer_dict(c),
            "contacts": [contact_dict(ct) for ct in c.contacts],
            "units": units,
            "work_orders": wo_rows,
            "parts_billed": parts_billed,
            "totals": {
                "billed_ytd": round(billed_ytd, 2),
                "billed_all": round(billed_all, 2),
                "open_balance": round(open_balance, 2),
                "paid_all": round(paid_all, 2),
                "wo_count": len(wos),
                "open_wos": open_wos,
            },
            "bill_to": _bill_to(c),
            "pii_masked": False,
        }
