# -*- coding: utf-8 -*-
"""Work Orders (G5; pipeline H2 — el reemplazo de Fullbay).

Pipeline secuencial estilo TMS (H3: "closed" se eliminó; invoiced es
el estado terminal):
    open -> assigned -> in_progress -> completed -> invoiced

Gates de avance (estilo QuickManage; la barra estilo UNIQ del frontend
permite saltar varias etapas de un clic, validando TODOS los gates del
camino):
- assigned o más: requiere mecánico asignado.
- invoiced: requiere total > 0 (líneas de partes/labor).
Retroceder está permitido (deshace sellos de invoiced/completed).

`waiting_parts` es un FLAG (la espera de partes no rompe la secuencia).
Al llegar a completed un WO de PM con millaje, se actualiza el override
`last_pm_miles` del PM tracker sin re-exportar el CSV de Fullbay.

Outside work (v2.21, benchmark SquareRigger): `wo_type` distingue el
trabajo INSIDE (taller propio, mecánico asignado) del OUTSIDE (taller de
terceros = `vendor_id`, obligatorio). Una WO outside no exige mecánico
para avanzar y NO consume stock al facturar (las partes las puso el
tercero). El resto del pipeline y los hooks PM/campaña son iguales.

v2.23: el tipo es FIJO desde la creación. Un PATCH (o Smart Fill) que
intenta cambiarlo => 400 TYPE_LOCKED_MSG (mismo tipo = no-op). En una WO
outside el taller se puede REASIGNAR (borrar un vendor exige reasignar sus
WOs) pero nunca quitar; una WO inside no liga taller (INSIDE_VENDOR_MSG).
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from ..db import SessionLocal, Vendor, WorkOrder, WorkOrderLine
from . import pm

STATUSES = ("open", "assigned", "in_progress", "completed", "invoiced")
_ORDER = {s: i for i, s in enumerate(STATUSES)}
PRIORITIES = ("low", "normal", "high")
LINE_KINDS = ("part", "labor")
WO_TYPES = ("inside", "outside")
_TYPE_MSG = "wo_type must be inside or outside"
_VENDOR_MISSING_MSG = "vendor not found"
_OUTSIDE_NEEDS_VENDOR_MSG = "outside work needs a vendor (the third-party shop)"
# v2.23: inside/outside se elige al crear y no cambia después.
TYPE_LOCKED_MSG = ("Work type can't be changed after the work order is "
                   "created. Delete it and create a new one.")
INSIDE_VENDOR_MSG = ("Inside work orders don't link a vendor. For "
                     "third-party work, create an Outside work order.")


def _total(wo: WorkOrder) -> float:
    return round(sum(ln.qty * ln.unit_cost for ln in wo.lines), 2)


def gate_error(target: str, wo: WorkOrder,
               total: float | None = None) -> str | None:
    """Por qué NO se puede avanzar a `target` (None = se puede).

    Outside work: el gate de "asignar mecánico" NO aplica (el trabajo lo
    hace un taller externo, no hay mecánico propio); el de "líneas antes
    de facturar" sí aplica a ambos tipos."""
    ti = _ORDER[target]
    if total is None:
        total = _total(wo)
    if (ti >= _ORDER["assigned"] and wo.wo_type != "outside"
            and not (wo.mechanic or "").strip()):
        return "assign a mechanic before moving past Open"
    if ti >= _ORDER["invoiced"] and total <= 0:
        return "add parts or labor lines before invoicing"
    return None


def _clean_vendor_id(raw) -> int | None:
    """vendor_id del body: None/''/0 => sin vendor."""
    if raw in (None, "", 0, "0"):
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise ValueError(_VENDOR_MISSING_MSG)


_HOURS_MSG = "engine hours must be a positive number"


def _clean_engine_hours(raw) -> float | None:
    """engine_hours del body (v2.22): None/''/0 => sin dato (el 0 es el
    centinela de "borrar" en el PATCH, que filtra los None)."""
    if raw in (None, "", 0, "0"):
        return None
    try:
        v = float(raw)
    except (TypeError, ValueError):
        raise ValueError(_HOURS_MSG)
    if not (0 < v < 200_000):
        raise ValueError(_HOURS_MSG)
    return round(v, 1)


PAYMENT_STATUSES = ("unpaid", "paid")
_PAYMENT_MSG = "payment_status must be unpaid or paid"
CUSTOMER_LOCKED_MSG = "un-invoice the work order before changing the customer"


def _clean_payment_status(raw) -> str:
    """payment_status del body (v2.22): unpaid | paid; otra cosa => 400."""
    v = str(raw or "").strip().lower()
    if v not in PAYMENT_STATUSES:
        raise ValueError(_PAYMENT_MSG)
    return v


def _resolve_type_vendor(session, wo_type: str,
                         vendor_id) -> tuple[str, int | None]:
    """Valida la pareja (wo_type, vendor_id): tipo válido, vendor existente
    en la org y vendor obligatorio para outside. Devuelve la pareja limpia."""
    wo_type = (wo_type or "inside").strip().lower()
    if wo_type not in WO_TYPES:
        raise ValueError(_TYPE_MSG)
    vid = _clean_vendor_id(vendor_id)
    if vid is not None and session.get(Vendor, vid) is None:
        raise ValueError(_VENDOR_MISSING_MSG)
    if wo_type == "outside" and vid is None:
        raise ValueError(_OUTSIDE_NEEDS_VENDOR_MSG)
    return wo_type, vid


def check_type_locked(wo: WorkOrder, raw_type) -> str:
    """v2.23: el tipo de una WO EXISTENTE no cambia. Valida el `wo_type`
    pedido contra el de la WO: inválido => _TYPE_MSG; distinto =>
    TYPE_LOCKED_MSG; igual (o vacío) => no-op. Devuelve el tipo actual
    (null legacy = inside). Lo comparten apply_fields_in y smart_fill.apply."""
    cur = (wo.wo_type or "inside").strip().lower()
    want = str(raw_type or "").strip().lower() or cur
    if want not in WO_TYPES:
        raise ValueError(_TYPE_MSG)
    if want != cur:
        raise ValueError(TYPE_LOCKED_MSG)
    return cur


def check_inside_vendor(wo: WorkOrder, raw_vendor_id) -> None:
    """v2.23: una WO inside no liga un taller externo. Ligarle un vendor
    (distinto del que ya tuviera por data legacy) => INSIDE_VENDOR_MSG;
    0/''/None (quitar) se permite. No-op en una WO outside."""
    if (wo.wo_type or "inside") != "inside":
        return
    vid = _clean_vendor_id(raw_vendor_id)
    if vid is not None and vid != wo.vendor_id:
        raise ValueError(INSIDE_VENDOR_MSG)


def _line_dict(ln: WorkOrderLine, parts_pct: float = 0.0,
               labor_pct: float = 0.0) -> dict:
    """Línea serializada. v2.22 (Customers): `unit_price` = precio
    CONGELADO al facturar (None = sin snapshot); `billable_unit_price` /
    `billable_amount` = lo que se le cobra al customer (snapshot o costo ×
    markup en vivo; para Self = el costo)."""
    from . import customers               # import diferido (orden de carga)
    price = customers.line_price(ln, parts_pct, labor_pct)
    return {
        "id": ln.id,
        "kind": ln.kind,
        "description": ln.description,
        "part_number": ln.part_number or "",
        "qty": ln.qty,
        "unit_cost": ln.unit_cost,
        "total": round(ln.qty * ln.unit_cost, 2),
        "unit_price": ln.unit_price,
        "billable_unit_price": price,
        "billable_amount": round(price * float(ln.qty or 0.0), 2),
    }


def effective_date(wo: WorkOrder):
    """Fecha efectiva de una WO (v2.22, en la TZ de la org): service_date ->
    closed_at -> created_at. Misma prioridad que reports._effective_date
    (gasto por fecha de servicio), pero los sellos se pasan a la fecha de la
    org. None si no hay ninguna."""
    from . import org_config             # import diferido (orden de carga)
    sd = (wo.service_date or "").strip()[:10]
    if sd:
        try:
            return datetime.strptime(sd, "%Y-%m-%d").date()
        except ValueError:
            pass
    for ts in (wo.closed_at, wo.created_at):
        if ts is not None:
            return org_config.to_org_date(ts)
    return None


def _display_no(wo: WorkOrder) -> str:
    """Número de display: "4" para una orden raíz, "4.1"/"4.2"… para una
    hija (parent_id + child_seq). El padre del invoice multi-unidad conserva
    su id entero; las hijas heredan el id del padre como prefijo."""
    if wo.parent_id and wo.child_seq:
        return f"{wo.parent_id}.{wo.child_seq}"
    return str(wo.id)


def _links_dict(wo: WorkOrder, session) -> dict:
    """Vínculos padre/hijas/hermanas del invoice multi-unidad (review v1.26).
    Devuelve el id+display del padre (si es hija) y la lista de hijas (si es
    padre o si comparten padre), para que el drawer muestre "#4.1 · child of
    #4" + enlaces a las otras unidades del mismo invoice."""
    out: dict = {
        "display_no": _display_no(wo),
        "parent_id": wo.parent_id,
        "child_seq": wo.child_seq or 0,
        "parent": None,
        "children": [],
    }
    # Si es hija: datos del padre para el enlace "child of #4".
    if wo.parent_id:
        parent = session.get(WorkOrder, wo.parent_id)
        if parent is not None:
            out["parent"] = {"id": parent.id, "unit": parent.unit,
                             "display_no": _display_no(parent)}
    # id raíz del invoice: el padre si es hija, o sí mismo si es padre.
    root_id = wo.parent_id or wo.id
    kids = session.scalars(
        select(WorkOrder).where(WorkOrder.parent_id == root_id)
        .order_by(WorkOrder.child_seq)).all()
    out["children"] = [
        {"id": k.id, "unit": k.unit, "display_no": _display_no(k)}
        for k in kids]
    return out


def _vendor_info(wo: WorkOrder, session=None,
                 vendors: dict[int, Vendor] | None = None) -> dict:
    """Campos del vendor (taller externo) de la WO para el serializer.
    `vendors` es un prefetch {id: Vendor} para los listados (evita N+1);
    si no viene, se resuelve con session.get (identity map)."""
    v = None
    if wo.vendor_id is not None:
        if vendors is not None:
            v = vendors.get(wo.vendor_id)
        elif session is not None:
            v = session.get(Vendor, wo.vendor_id)
        else:
            with SessionLocal() as s:
                v = s.get(Vendor, wo.vendor_id)
    return {
        "wo_type": wo.wo_type or "inside",
        "vendor_id": wo.vendor_id,
        "vendor_name": v.name if v is not None else "",
        "vendor_city": (v.city or "") if v is not None else "",
        "vendor_state": (v.state or "") if v is not None else "",
    }


def _customer_of(wo: WorkOrder, session=None,
                 customers_map: dict | None = None):
    """Customer (Bill to) de la WO, o None (Self). `customers_map` es un
    prefetch {id: Customer} para los listados (evita N+1)."""
    if wo.customer_id is None:
        return None
    from ..db import Customer
    if customers_map is not None:
        return customers_map.get(wo.customer_id)
    if session is not None:
        return session.get(Customer, wo.customer_id)
    with SessionLocal() as s:
        c = s.get(Customer, wo.customer_id)
        if c is not None:
            s.expunge(c)
        return c


def _customer_info(wo: WorkOrder, cust) -> dict:
    """Campos de Bill-To / cobro de la WO (v2.22, Customers)."""
    from . import customers               # import diferido (orden de carga)
    return {
        "customer_id": wo.customer_id,
        "customer_name": cust.name if cust is not None else "",
        "customer_markup": ({"parts_pct": float(cust.parts_markup_pct or 0),
                             "labor_pct": float(cust.labor_markup_pct or 0)}
                            if cust is not None else None),
        "payment_status": wo.payment_status or "unpaid",
        "paid_at": wo.paid_at.isoformat() if wo.paid_at else None,
        "billable_total": customers.billable_total(wo, cust),
        # Impuesto del customer sobre las partes (tasa congelada al facturar;
        # antes, la vigente) y el total a cobrar.
        "tax_pct": customers.wo_tax_pct(wo, cust),
        "billable_tax": customers.billable_tax(wo, cust),
        "billable_due": customers.billable_due(wo, cust),
    }


def _org_day(ts) -> str | None:
    """Fecha (YYYY-MM-DD) de un sello en la TZ de la org."""
    if ts is None:
        return None
    from . import org_config             # import diferido (orden de carga)
    d = org_config.to_org_date(ts)
    return d.isoformat() if d else None


def _iso_or_none(d) -> str | None:
    return d.isoformat() if d else None


def _wo_dict(wo: WorkOrder, with_lines: bool = False,
             session=None, vendors: dict[int, Vendor] | None = None,
             customers_map: dict | None = None) -> dict:
    from . import customers, wo_invoices  # import diferido (orden de carga)
    total = _total(wo)
    cust = _customer_of(wo, session, customers_map)
    # Factura original adjunta: campos calculados desde el archivo en disco
    # (NO hay columna en la DB; el almacenamiento es por archivo).
    inv_name = wo_invoices.file_name(wo.id)
    out = {
        "id": wo.id,
        "display_no": _display_no(wo),
        "parent_id": wo.parent_id,
        "child_seq": wo.child_seq or 0,
        "created_at": wo.created_at.isoformat(),
        "updated_at": wo.updated_at.isoformat(),
        "closed_at": wo.closed_at.isoformat() if wo.closed_at else None,
        # v2.22: fechas en la TZ de la org (los sellos son UTC/naive del
        # server): las usan los drill-downs de Home ("completed today",
        # "labor hours this week") para filtrar igual que el KPI.
        "closed_date": _org_day(wo.closed_at),
        "effective_date": _iso_or_none(effective_date(wo)),
        "invoiced_at": (wo.invoiced_at.isoformat()
                        if wo.invoiced_at else None),
        "unit": wo.unit,
        "company": wo.company,
        "status": wo.status,
        "priority": wo.priority,
        "title": wo.title,
        "complaint": wo.complaint,
        "mechanic": wo.mechanic,
        "notes": wo.notes,
        "is_pm": wo.is_pm,
        "pm_miles": wo.pm_miles,
        "campaign": wo.campaign or "",
        "mileage": wo.mileage,
        # v2.22: horómetro de la unidad (reefer) capturado en la WO.
        "engine_hours": wo.engine_hours,
        "service_date": wo.service_date,
        "waiting_parts": wo.waiting_parts,
        "source": wo.source,
        "invoice_number": wo.invoice_number or "",
        "po_number": wo.po_number or "",
        "authorizer": wo.authorizer or "",
        "shop_invoice": wo.shop_invoice or "",
        "has_invoice_file": inv_name is not None,
        "invoice_file_name": inv_name,
        "total": total,
        "n_lines": len(wo.lines),
        # Outside work (v2.21): tipo + taller externo.
        **_vendor_info(wo, session, vendors),
        # v2.22 Customers: Bill to + cobro + total a cobrar (con markup).
        **_customer_info(wo, cust),
    }
    if with_lines:
        p_pct, l_pct = customers.markups(cust)
        out["lines"] = [_line_dict(ln, p_pct, l_pct) for ln in wo.lines]
    return out


def _detail_dict(wo: WorkOrder, session) -> dict:
    """Dict COMPLETO del drawer: líneas + vínculos padre/hijas (#4.1, "child
    of #4") + service requests ligados (v2.20). Lo devuelven get_wo, create_wo
    y TODAS las mutaciones (update_wo, add_line, delete_line): antes las
    mutaciones devolvían el dict sin `links` y el drawer perdía la numeración
    #4.1 y los chips padre/hija después de cualquier cambio."""
    from . import service_requests       # import diferido (ciclo de imports)
    out = _wo_dict(wo, with_lines=True, session=session)
    out["links"] = _links_dict(wo, session)
    out["service_requests"] = service_requests.for_wo(session, wo.id)
    return out


def list_wos(status: str = "", unit: str = "", wo_type: str = "",
             vendor_id: int | None = None, limit: int = 200) -> list[dict]:
    """Órdenes por id desc. Con `status`: las `limit` más nuevas de ese
    estado. Sin `status`: TODAS las activas (no facturadas) + las `limit`
    facturadas más nuevas. Antes eran las `limit` más nuevas a secas: con
    historial largo una WO abierta vieja desaparecía del Board y del "Add
    to…" de Service Requests (y se terminaba creando una duplicada).

    Filtros v2.21: `wo_type` (inside|outside) y `vendor_id` (taller
    externo)."""
    with SessionLocal() as session:
        q = select(WorkOrder).order_by(WorkOrder.id.desc())
        if unit:
            q = q.where(WorkOrder.unit == unit)
        if wo_type in WO_TYPES:
            q = q.where(WorkOrder.wo_type == wo_type)
        if vendor_id not in (None, "", 0):
            q = q.where(WorkOrder.vendor_id == int(vendor_id))
        if status:
            rows = session.scalars(
                q.where(WorkOrder.status == status).limit(limit)).all()
        else:
            active = session.scalars(
                q.where(WorkOrder.status != "invoiced")).all()
            history = session.scalars(
                q.where(WorkOrder.status == "invoiced").limit(limit)).all()
            rows = sorted([*active, *history], key=lambda w: w.id,
                          reverse=True)
        # Prefetch de vendors (un SELECT) para no hacer N+1 en el listado.
        vendors = {v.id: v for v in session.scalars(select(Vendor)).all()}
        # v2.22: idem customers (Bill to + markup del billable_total).
        from ..db import Customer
        cids = {w.customer_id for w in rows if w.customer_id is not None}
        cmap = ({c.id: c for c in session.scalars(
            select(Customer).where(Customer.id.in_(cids))).all()}
            if cids else {})
        return [_wo_dict(w, vendors=vendors, customers_map=cmap)
                for w in rows]


def get_wo(wo_id: int) -> dict | None:
    with SessionLocal() as session:
        wo = session.get(WorkOrder, wo_id)
        if wo is None:
            return None
        # Vínculos padre/hijas para el drawer (review v1.26): "#4.1 · child of
        # #4" + enlaces a las otras unidades del mismo invoice.
        return _detail_dict(wo, session)


def create_wo_in(session, unit: str, title: str, complaint: str = "",
                 company: str = "", mechanic: str = "",
                 priority: str = "normal", is_pm: bool = False,
                 source: str = "manual", mileage: int | None = None,
                 service_date: str = "", campaign: str = "",
                 shop_invoice: str = "",
                 parent_id: int | None = None,
                 wo_type: str = "inside",
                 vendor_id: int | None = None,
                 engine_hours: float | None = None,
                 customer_id: int | None = None,
                 payment_status: str = "unpaid") -> WorkOrder:
    """Arma la work order DENTRO de una sesión ajena: add + flush (asigna el
    id) pero NO commitea — la transacción es del caller. La usa create_wo y
    también Service Requests (v2.20), que necesita insertar la WO y ligar los
    requests en UN solo commit (todo o nada).

    Si `parent_id` viene seteado, la orden es una HIJA del invoice
    multi-unidad (review v1.26): se le asigna el siguiente `child_seq` libre
    bajo ese padre para numerarla #padre.N (#4.1, #4.2…). Puede lanzar
    IntegrityError en el flush (colisión de child_seq): decide el caller.

    Outside work (v2.21): `wo_type` inside|outside; outside exige
    `vendor_id` (el taller externo); inside puede llevarlo o no. Un
    mecánico en una WO outside se acepta (nace 'assigned') pero no se
    exige.

    Customers (v2.22): `customer_id` None (no vino) => el DUEÑO de la
    unidad (customer_unit) si tiene uno activo; 0 => Self explícito; un id
    => debe existir. Solo lectura sobre customers (esta sesión puede tener
    escrituras a medias)."""
    from . import customers, maint, technicians  # import diferido
    unit = (unit or "").strip()
    title = (title or "").strip()
    if not unit or not title:
        raise ValueError("unit and title are required")
    if priority not in PRIORITIES:
        priority = "normal"
    if campaign and campaign not in maint.CAMPAIGNS:
        campaign = ""
    # Roster de técnicos (v2.21): la WO lleva la grafía del roster (lectura
    # pura). El alta de un mecánico NUEVO la hace el dueño de la transacción
    # DESPUÉS del commit (ensure_technician): technicians escribe org_setting
    # en su propia transacción y en SQLite no puede hacerlo si la sesión del
    # caller ya tiene una escritura a medias (service_requests flushea antes
    # de llamar acá) -> "database is locked".
    mechanic = technicians.canonical_name(mechanic)
    wo_type, vendor_id = _resolve_type_vendor(session, wo_type, vendor_id)
    engine_hours = _clean_engine_hours(engine_hours)
    customer_id = customers.resolve_for_wo(session, unit, customer_id)
    payment_status = _clean_payment_status(payment_status or "unpaid")
    now = datetime.now()
    wo = WorkOrder(
        created_at=now, updated_at=now,
        unit=unit[:64], company=(company or "").strip()[:64],
        # Crear ya asignada si vino mecánico (gate de assigned cumplido).
        status="assigned" if mechanic else "open",
        priority=priority,
        title=title[:140], complaint=(complaint or "").strip(),
        mechanic=mechanic[:80], notes="",
        is_pm=bool(is_pm) or campaign == "pm",
        campaign=campaign,
        source=(source or "")[:20] or "manual",
        mileage=(int(mileage) if mileage not in (None, "") else None),
        service_date=((service_date or "").strip()[:10] or None),
        shop_invoice=(shop_invoice or "").strip()[:60],
        wo_type=wo_type, vendor_id=vendor_id,
        engine_hours=engine_hours,
        customer_id=customer_id, payment_status=payment_status,
        paid_at=now if payment_status == "paid" else None,
    )
    if parent_id is not None:
        parent = session.get(WorkOrder, parent_id)
        if parent is None:
            raise ValueError("parent work order not found")
        wo.parent_id = parent_id
        # Siguiente ordinal libre bajo el padre (1, 2, 3…).
        last = session.scalar(
            select(func.max(WorkOrder.child_seq)).where(
                WorkOrder.parent_id == parent_id)) or 0
        wo.child_seq = int(last) + 1
    session.add(wo)
    session.flush()
    return wo


def create_wo(unit: str, title: str, complaint: str = "",
              company: str = "", mechanic: str = "",
              priority: str = "normal", is_pm: bool = False,
              source: str = "manual", mileage: int | None = None,
              service_date: str = "", campaign: str = "",
              shop_invoice: str = "", parent_id: int | None = None,
              wo_type: str = "inside", vendor_id: int | None = None,
              engine_hours: float | None = None,
              customer_id: int | None = None,
              payment_status: str = "unpaid") -> dict:
    """Crea una work order (sesión propia + commit). La lógica vive en
    create_wo_in; acá solo se maneja la transacción."""
    # v2.22: el backfill de customers (Unit.customer -> dueños) escribe en
    # su propia sesión: ANTES de abrir la de la WO (el dueño por defecto de
    # la unidad sale de ahí).
    from . import customers               # import diferido (orden de carga)
    customers.ensure_backfill()
    with SessionLocal() as session:
        try:
            wo = create_wo_in(
                session, unit, title, complaint, company, mechanic,
                priority, is_pm, source, mileage, service_date, campaign,
                shop_invoice, parent_id, wo_type, vendor_id,
                engine_hours=engine_hours, customer_id=customer_id,
                payment_status=payment_status)
            session.commit()
        except IntegrityError:
            # DATA-4: colisión de child_seq por dos creaciones concurrentes
            # bajo el mismo padre (la UniqueConstraint(parent_id, child_seq) lo
            # impide). Antes generaba un #4.1 duplicado en silencio; ahora falla
            # claro y el usuario reintenta.
            session.rollback()
            raise ValueError(
                "work order number collision (concurrent create), retry")
        out = _detail_dict(wo, session)
    # Roster de técnicos (v2.21): un mecánico nuevo se agrega solo, DESPUÉS
    # del commit (ver create_wo_in). Si la creación falló, no queda nadie
    # fantasma en el roster.
    ensure_technician(out.get("mechanic") or "")
    # v2.22: el horómetro cargado en la WO es también una lectura del
    # medidor (fuente 'wo'; best-effort, fuera de la transacción).
    _log_wo_hours(out["unit"], out.get("engine_hours"),
                  out.get("service_date"))
    return out


def _log_wo_hours(unit: str, hours, service_date: str | None) -> None:
    """Registra las horas de motor de una WO como lectura del horómetro
    (core/meters, fuente 'wo', fecha = service_date o hoy). Best-effort: una
    lectura no creíble (o con fecha futura) se saltea; la WO no falla."""
    if not hours:
        return
    from . import meters                 # import diferido (orden de carga)
    try:
        meters.log_reading(unit, hours, service_date or None, source="wo")
    except ValueError:
        pass


def ensure_technician(mechanic: str) -> None:
    """Agrega `mechanic` al roster si falta (technicians.ensure). Llamar
    FUERA de la transacción de la WO (después del commit): escribe
    org_setting en su propia transacción."""
    if (mechanic or "").strip():
        from . import technicians        # import diferido (orden de carga)
        technicians.ensure(mechanic)


def wo_exists(wo_id: int) -> bool:
    """¿Existe la WO en la org actual? (session.get pasa por el filtro
    OrgScoped). Es la guarda de tenant de las rutas de archivos adjuntos,
    que indexan por id global fuera del ORM."""
    with SessionLocal() as session:
        return session.get(WorkOrder, wo_id) is not None


def apply_fields_in(session, wo: WorkOrder, fields: dict) -> None:
    """Aplica los campos EDITABLES simples (no el status) sobre `wo` dentro
    de la sesión del caller. Lo comparten update_wo y smart_fill.apply.
    Lanza ValueError si wo_type/vendor_id no validan (el caller decide el
    rollback). v2.23: `wo_type` solo se acepta si es el MISMO tipo (cambiarlo
    => TYPE_LOCKED_MSG)."""
    from . import maint                  # import diferido (orden de carga)
    if "priority" in fields and fields["priority"] in PRIORITIES:
        wo.priority = fields["priority"]
    # invoice_number (el propio de Fleet Tracker) NO es editable por WO:
    # se asigna solo al facturar y su formato se configura en Settings.
    for key, cap in (("title", 140), ("mechanic", 80),
                     ("company", 64), ("po_number", 60),
                     ("authorizer", 80), ("shop_invoice", 60)):
        if key in fields:
            setattr(wo, key, str(fields[key]).strip()[:cap])
    if "mechanic" in fields and wo.mechanic:
        # Grafía del roster (v2.21, lectura pura): 'luis' -> 'Luis'. El alta
        # de un nombre nuevo la hace el caller tras el commit.
        from . import technicians        # import diferido (orden de carga)
        wo.mechanic = technicians.canonical_name(wo.mechanic)
    for key in ("complaint", "notes"):
        if key in fields:
            setattr(wo, key, str(fields[key]).strip())
    if "is_pm" in fields:
        wo.is_pm = bool(fields["is_pm"])
    if "campaign" in fields:
        c = str(fields["campaign"]).strip()
        wo.campaign = c if c in maint.CAMPAIGNS else ""
        if wo.campaign == "pm":
            wo.is_pm = True
    if "waiting_parts" in fields:
        wo.waiting_parts = bool(fields["waiting_parts"])
    for key in ("pm_miles", "mileage"):
        if key in fields:
            try:
                setattr(wo, key, (int(fields[key])
                                  if fields[key] not in ("", None)
                                  else None))
            except (TypeError, ValueError):
                pass
    # v2.22: horómetro (reefer). 0 / '' = borrar; inválido => ValueError.
    if "engine_hours" in fields:
        wo.engine_hours = _clean_engine_hours(fields["engine_hours"])
    if "service_date" in fields:
        wo.service_date = (str(fields["service_date"]).strip()[:10]
                           or None)
    # Outside work. v2.23: el tipo es FIJO desde la creación (antes, v2.21,
    # el PATCH podía pasar inside<->outside). `wo_type` se sigue aceptando
    # para que un cliente viejo reciba el 400 explícito: mismo tipo = no-op,
    # otro tipo = TYPE_LOCKED_MSG. En una WO outside el vendor se puede
    # REASIGNAR pero no quitar (vendor_id 0/''/null => "needs a vendor"); en
    # una inside no se liga taller (INSIDE_VENDOR_MSG; quitar sí se puede).
    if "wo_type" in fields or "vendor_id" in fields:
        cur = check_type_locked(wo, fields.get("wo_type"))
        if "vendor_id" in fields:
            check_inside_vendor(wo, fields["vendor_id"])
            vendor_id = fields["vendor_id"]
        else:
            vendor_id = wo.vendor_id
        wo.wo_type, wo.vendor_id = _resolve_type_vendor(
            session, cur, vendor_id)
    # v2.22 Customers: Bill to (0/'' = Self). Una WO FACTURADA no cambia de
    # customer (el invoice y sus precios congelados ya salieron): hay que
    # des-facturar primero. Cambiar de customer borra los precios
    # congelados (eran del markup del anterior; se re-congelan al facturar).
    if "customer_id" in fields:
        from . import customers            # import diferido (orden de carga)
        from ..db import Customer
        cid = customers.clean_customer_id(fields["customer_id"])
        if cid is not None and session.get(Customer, cid) is None:
            raise ValueError(customers.NOT_FOUND_MSG)
        if cid != wo.customer_id:
            if wo.invoiced_at is not None or wo.status == "invoiced":
                raise ValueError(CUSTOMER_LOCKED_MSG)
            wo.customer_id = cid
            wo.tax_pct = None
            for ln in wo.lines:
                ln.unit_price = None
    if "payment_status" in fields:
        ps = _clean_payment_status(fields["payment_status"])
        if ps != (wo.payment_status or "unpaid"):
            wo.payment_status = ps
            wo.paid_at = datetime.now() if ps == "paid" else None


def update_wo(wo_id: int, fields: dict) -> dict | None:
    """Actualiza campos editables, con gates de pipeline en los cambios
    de estado. Al cruzar completed, un WO de PM con millaje actualiza el
    override last_pm_miles del PM tracker. Lanza ValueError si un gate
    bloquea el avance (el mensaje se muestra tal cual en la UI)."""
    from . import maint                  # import diferido (orden de carga)
    with SessionLocal() as session:
        wo = session.get(WorkOrder, wo_id)
        if wo is None:
            return None
        was_invoiced = wo.invoiced_at is not None
        # Cargar las líneas ANTES de tocar nada y aplicar los campos SIN
        # autoflush: la sesión no escribe hasta el commit. Si no, "cambiar un
        # campo + facturar" en el mismo PATCH flusheaba el UPDATE de la WO
        # (lock de escritura) antes de que bump_invoice_number abriera SU
        # sesión para avanzar el contador -> "database is locked" en la
        # SQLite de dev (en Postgres no bloqueaba, pero el orden es el mismo).
        _ = len(wo.lines)

        # Campos simples primero: permite "asignar mecánico + avanzar"
        # en el mismo request (el gate ve el mecánico nuevo).
        try:
            with session.no_autoflush:
                apply_fields_in(session, wo, fields)
        except ValueError:
            session.rollback()
            raise

        if "status" in fields and fields["status"] in STATUSES:
            target = fields["status"]
            total = _total(wo)
            if _ORDER[target] > _ORDER[wo.status]:      # avance: gates
                err = gate_error(target, wo, total)
                if err:
                    session.rollback()
                    raise ValueError(err)
            prev_status = wo.status
            wo.status = target
            now = datetime.now()
            # Sellos según hasta dónde llegó el pipeline (retroceder
            # los deshace).
            if _ORDER[target] >= _ORDER["completed"]:
                wo.closed_at = wo.closed_at or now
            else:
                wo.closed_at = None
            if _ORDER[target] >= _ORDER["invoiced"]:
                if wo.invoiced_at is None:           # primera vez que factura
                    wo.invoiced_at = now
                    # H3-C: número de invoice del contador de org_config
                    # (a menos que ya se haya fijado uno a mano).
                    if not (wo.invoice_number or "").strip():
                        from . import org_config
                        wo.invoice_number = org_config.next_invoice_number()
                    # v2.22: precio de venta CONGELADO por línea (costo ×
                    # markup del customer). Después del contador (que abre
                    # su propia sesión) y sin autoflush, por el mismo lock
                    # de SQLite de arriba.
                    from . import customers    # import diferido
                    with session.no_autoflush:
                        customers.snapshot_prices(session, wo)
            else:
                wo.invoiced_at = None
            # Hook Service Requests (v2.20): completar/facturar cierra los
            # requests ligados (done, resolution 'wo'); retroceder debajo de
            # completed los devuelve a on_wo. Misma transacción que la WO.
            if target != prev_status:
                from . import service_requests   # import diferido (ciclo)
                service_requests.on_wo_status(session, wo.id, target)

        wo.updated_at = datetime.now()
        # Capturar (line_id, part_number, qty) de las líneas de PARTE con
        # part_number conocido ANTES de cerrar la sesión, para alimentar el
        # hook de inventario (las líneas son lazy y el WO sale del scope).
        # Outside work (v2.21): una WO de taller externo NO consume stock —
        # las partes las puso el tercero, nunca tocaron nuestro inventario.
        is_invoiced = wo.invoiced_at is not None
        consume_lines = [
            (ln.id, ln.part_number, ln.qty) for ln in wo.lines
            if ln.kind == "part" and (ln.part_number or "").strip()
        ] if is_invoiced and wo.wo_type != "outside" else []
        new_mechanic = wo.mechanic if "mechanic" in fields else ""
        session.commit()

        # Roster de técnicos (v2.21): un mecánico nuevo se agrega solo
        # (después del commit: technicians escribe org_setting en su sesión).
        ensure_technician(new_mechanic)

        # v2.22: horas de motor cargadas en la WO -> lectura del horómetro.
        if fields.get("engine_hours") not in (None, "", 0, "0"):
            _log_wo_hours(wo.unit, wo.engine_hours, wo.service_date)

        # Hook de inventario (fase Inventory): al FACTURAR (invoiced) se
        # consume el stock de cada línea de parte con part_number conocido.
        # Idempotente vía el guard (reason, ref_type, ref_id) en
        # inventory.adjust: re-facturar (o des-facturar y re-facturar) NO
        # duplica el descuento. Fuera del flush: adjust abre su sesión.
        if consume_lines:
            from . import inventory
            for line_id, pn, qty in consume_lines:
                inventory.adjust(pn, -float(qty or 0), "wo_consume",
                                 ref_type="wo_line", ref_id=line_id,
                                 note=f"WO #{wo.id} invoiced")

        # Nombre con el que el tracker de PM/DOT conoce a la unidad: la WO
        # nacida de un service request lleva el nombre de la flota ('CAN 1')
        # pero la fila del board puede escribirse distinto ('CAN1'); el
        # registro va a la fila del BOARD (v2.20, maint_unit_for_wo).
        from . import service_requests   # import diferido (ciclo)

        # Hook PM: WO de PM que llegó a completed (o más) con millaje ->
        # el PM tracker registra el servicio sin pasar por el CSV.
        if (_ORDER[wo.status] >= _ORDER["completed"]
                and wo.is_pm and wo.pm_miles):
            pm.set_override(
                service_requests.maint_unit_for_wo(session, wo, "pm"),
                "last_pm_miles", wo.pm_miles)

        # Hook campañas (H3b, estilo Fullbay): al FACTURAR una orden con
        # campaña, se registra el servicio en Components & PMs del
        # perfil. Idempotente: una orden solo registra UNA vez aunque se
        # des-facture y re-facture (se busca su "WO #id:" en las notas).
        # v2.22: también se registran las OTRAS campañas de vencimiento de
        # los service requests ligados (p.ej. DOT + Reefer PM del mismo
        # trailer en una WO: antes solo la primera quedaba registrada y la
        # otra seguía vencida en su tablero). Las campañas por horas (PM
        # del reefer) llevan el horómetro de la WO (engine_hours).
        if not was_invoiced and wo.invoiced_at is not None:
            from ..db import MaintRecord, ServiceRequest
            from . import meters, org_config
            linked = session.scalars(
                select(ServiceRequest.source).where(
                    ServiceRequest.wo_id == wo.id,
                    ServiceRequest.source.in_(
                        service_requests.DUE_SOURCES))).all()
            kinds = list(dict.fromkeys(
                k for k in [wo.campaign or "", *linked]
                if k and k in maint.CAMPAIGNS))
            for kind in kinds:
                rec_unit = service_requests.maint_unit_for_wo(
                    session, wo, kind)
                already = session.scalar(
                    select(MaintRecord).where(
                        MaintRecord.unit.in_(sorted({wo.unit, rec_unit})),
                        MaintRecord.kind == kind,
                        MaintRecord.notes.like(f"WO #{wo.id}:%")))
                if already is not None:
                    continue
                by_hours = maint.CAMPAIGNS[kind]["due"] == "hours"
                # Fecha del registro: la de servicio o HOY en la TZ de la
                # org (no la del server, que en el contenedor es UTC: de
                # noche fechaba el PM "mañana" y la lectura se rechazaba
                # por futura).
                rec_date = (wo.service_date
                            or org_config.org_today().isoformat())
                hrs = None
                if by_hours:
                    # Horas de la WO (capturadas al crearla desde el request
                    # o tipeadas); si el horómetro ya registró más a la fecha
                    # del servicio, esa lectura es la buena (las horas solo
                    # suben): una copia vieja adelantaría el próximo PM.
                    hrs = wo.engine_hours
                    seen = meters.value_at(rec_unit, rec_date)
                    if seen is not None and (hrs is None or seen > hrs):
                        hrs = seen
                maint.add_record(
                    rec_unit, kind, rec_date,
                    None if by_hours else (wo.mileage or wo.pm_miles),
                    notes=f"WO #{wo.id}: {wo.title}"[:300],
                    hours=hrs)

        return _detail_dict(wo, session)


def build_line(d: dict) -> WorkOrderLine:
    """Arma (sin persistir) una línea desde un dict {kind, description, qty,
    unit_cost, part_number}. Misma validación que add_line; la comparten
    add_line, add_lines_bulk y smart_fill.apply."""
    kind = str(d.get("kind") or "").strip()
    if kind not in LINE_KINDS:
        raise ValueError(f"invalid kind: {kind}")
    description = str(d.get("description") or "").strip()
    if not description:
        raise ValueError("description is required")
    try:
        qty = max(0.0, float(d.get("qty") or 0))
        unit_cost = max(0.0, float(d.get("unit_cost") or 0))
    except (TypeError, ValueError):
        raise ValueError("qty and unit_cost must be numbers")
    return WorkOrderLine(
        kind=kind, description=description[:160],
        part_number=str(d.get("part_number") or "").strip()[:60],
        qty=qty, unit_cost=unit_cost,
    )


LINES_LOCKED_MSG = "un-invoice the work order before changing lines"


def _check_lines_editable(wo: WorkOrder) -> None:
    """Las líneas de una WO FACTURADA están congeladas (v2.21): el consumo
    de stock ya se registró por id de línea (inventory 'wo_consume'), así
    que borrar/reemplazar una línea dejaría el movimiento huérfano y
    re-facturar la consumiría de nuevo. Mismo bloqueo que Smart Fill
    (smart_fill.INVOICED_MSG) y que el drawer (`locked`). ValueError."""
    if wo.invoiced_at is not None or wo.status == "invoiced":
        raise ValueError(LINES_LOCKED_MSG)


def add_line(wo_id: int, kind: str, description: str,
             qty: float, unit_cost: float,
             part_number: str = "") -> dict | None:
    line = build_line({"kind": kind, "description": description,
                       "qty": qty, "unit_cost": unit_cost,
                       "part_number": part_number})
    with SessionLocal() as session:
        wo = session.get(WorkOrder, wo_id)
        if wo is None:
            return None
        _check_lines_editable(wo)
        wo.lines.append(line)
        wo.updated_at = datetime.now()
        session.commit()
        return _detail_dict(wo, session)


def add_lines_bulk(wo_id: int, lines: list[dict],
                   replace: bool = False) -> dict | None:
    """Agrega N líneas en UNA transacción (v2.21; antes el modal hacía N
    POSTs). Con `replace`, las líneas existentes se reemplazan por estas.
    Si una línea no valida, no se guarda ninguna. Bloqueado si la WO está
    facturada."""
    new_lines = [build_line(ln) for ln in (lines or [])]
    with SessionLocal() as session:
        wo = session.get(WorkOrder, wo_id)
        if wo is None:
            return None
        _check_lines_editable(wo)
        if replace:
            wo.lines = []
        for ln in new_lines:
            wo.lines.append(ln)
        wo.updated_at = datetime.now()
        session.commit()
        return _detail_dict(wo, session)


def delete_line(wo_id: int, line_id: int) -> dict | None:
    with SessionLocal() as session:
        wo = session.get(WorkOrder, wo_id)
        if wo is None:
            return None
        _check_lines_editable(wo)
        wo.lines = [ln for ln in wo.lines if ln.id != line_id]
        wo.updated_at = datetime.now()
        session.commit()
        return _detail_dict(wo, session)


def delete_wo(wo_id: int) -> bool:
    """Elimina la work order y sus líneas (cascade). H3: pedido del
    usuario para corregir órdenes creadas por error.

    Multi-unit (v1.26): borrar el PADRE de un invoice multi-unidad borra
    también sus HIJAS (son del mismo invoice; dejarlas huérfanas rompería su
    número de display #4.N). Borrar una hija suelta no toca al padre.

    v2.23: borrar una WO viva del puente reefer -> WO deja su fault
    descartado (reefer_wo.on_wos_deleted) para que el puente no la recree
    mientras el código siga activo: el tipo es fijo y "borrar y crear otra"
    es el camino para pasarla a outside."""
    from . import wo_invoices            # import diferido (orden de carga)
    with SessionLocal() as session:
        wo = session.get(WorkOrder, wo_id)
        if wo is None:
            return False
        # Hijas del invoice (si esta orden es el padre).
        kids = session.scalars(
            select(WorkOrder).where(WorkOrder.parent_id == wo_id)).all()
        kid_ids = [k.id for k in kids]
        gone = [{"unit": w.unit, "status": w.status, "source": w.source,
                 "complaint": w.complaint} for w in (wo, *kids)]
        for k in kids:
            session.delete(k)
        session.delete(wo)
        # Hook Service Requests (v2.20): los requests ligados a estas órdenes
        # vuelven al backlog (open). Misma transacción que el borrado.
        from . import service_requests       # import diferido (ciclo)
        service_requests.on_wo_deleted(session, [wo_id, *kid_ids])
        session.commit()
        # Limpia los archivos de factura adjuntos (fuera de la DB).
        for cid in [wo_id, *kid_ids]:
            wo_invoices.delete_file(cid)
    # Fuera de la transacción del borrado (org_setting escribe en la suya;
    # en SQLite no puede con otra escritura a medias) y best-effort: el
    # borrado ya se commiteó.
    try:
        from . import reefer_wo              # import diferido (ciclo)
        reefer_wo.on_wos_deleted(gone)
    except Exception:
        pass
    return True


def mechanics() -> list[str]:
    """Nombres de los técnicos ACTIVOS del roster, ordenados (v2.21). El
    campo `mechanics` del GET /workorders se conserva por compatibilidad;
    antes eran los nombres distintos ya usados en WOs, que ahora siembran
    el roster la primera vez (core/technicians)."""
    from . import technicians            # import diferido (orden de carga)
    return technicians.active_names()


def parts_used_by_unit(unit: str) -> dict:
    """Partes usadas en las WOs de una unidad (líneas kind='part'): el registro
    por línea con contexto de su WO + un resumen. Para la pestaña 'Parts used'
    del perfil de unidad."""
    unit = (unit or "").strip()
    with SessionLocal() as session:
        rows = session.execute(
            select(WorkOrderLine, WorkOrder)
            .join(WorkOrder, WorkOrderLine.wo_id == WorkOrder.id)
            .where(WorkOrder.unit == unit, WorkOrderLine.kind == "part")
            .order_by(WorkOrder.id.desc(), WorkOrderLine.id.asc())).all()
        items: list[dict] = []
        total_spend = 0.0
        total_qty = 0.0
        for ln, wo in rows:
            line_total = round(ln.qty * ln.unit_cost, 2)
            total_spend += line_total
            total_qty += ln.qty
            items.append({
                "part_number": ln.part_number or "",
                "description": ln.description or "",
                "qty": ln.qty,
                "unit_cost": ln.unit_cost,
                "total": line_total,
                "wo_id": wo.id,
                "wo_no": _display_no(wo),
                "wo_status": wo.status,
                "date": (wo.service_date
                         or (wo.created_at.date().isoformat()
                             if wo.created_at else "")),
            })
        return {
            "items": items,
            "total_lines": len(items),
            "distinct_parts": len({i["part_number"] for i in items
                                   if i["part_number"]}),
            "total_qty": round(total_qty, 2),
            "total_spend": round(total_spend, 2),
        }


def stats() -> dict:
    month_ago = datetime.now() - timedelta(days=30)
    with SessionLocal() as session:
        by_status = dict(session.execute(
            select(WorkOrder.status, func.count())
            .group_by(WorkOrder.status)).all())
        waiting = session.scalar(
            select(func.count()).select_from(WorkOrder).where(
                WorkOrder.waiting_parts.is_(True),
                WorkOrder.status != "invoiced")) or 0
        done_30 = session.scalars(
            select(WorkOrder).where(
                WorkOrder.status.in_(("completed", "invoiced")),
                WorkOrder.closed_at >= month_ago)).all()
        cost_30 = round(sum(
            ln.qty * ln.unit_cost for w in done_30 for ln in w.lines), 2)
        # Outside work (v2.21): WOs en talleres externos todavía abiertas
        # (no facturadas) — lo que hay afuera pendiente de pagar/cerrar.
        outside_open = session.scalar(
            select(func.count()).select_from(WorkOrder).where(
                WorkOrder.wo_type == "outside",
                WorkOrder.status != "invoiced")) or 0
        return {
            "open": by_status.get("open", 0),
            "assigned": by_status.get("assigned", 0),
            "in_progress": by_status.get("in_progress", 0),
            "completed": by_status.get("completed", 0),
            "invoiced": by_status.get("invoiced", 0),
            "waiting_parts": waiting,
            "completed_30d": len(done_30),
            "cost_30d": cost_30,
            "outside_open": outside_open,
        }
