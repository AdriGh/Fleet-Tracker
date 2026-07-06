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
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from ..db import SessionLocal, WorkOrder, WorkOrderLine
from . import pm

STATUSES = ("open", "assigned", "in_progress", "completed", "invoiced")
_ORDER = {s: i for i, s in enumerate(STATUSES)}
PRIORITIES = ("low", "normal", "high")
LINE_KINDS = ("part", "labor")


def gate_error(target: str, mechanic: str, total: float) -> str | None:
    """Por qué NO se puede avanzar a `target` (None = se puede)."""
    ti = _ORDER[target]
    if ti >= _ORDER["assigned"] and not (mechanic or "").strip():
        return "assign a mechanic before moving past Open"
    if ti >= _ORDER["invoiced"] and total <= 0:
        return "add parts or labor lines before invoicing"
    return None


def _line_dict(ln: WorkOrderLine) -> dict:
    return {
        "id": ln.id,
        "kind": ln.kind,
        "description": ln.description,
        "part_number": ln.part_number or "",
        "qty": ln.qty,
        "unit_cost": ln.unit_cost,
        "total": round(ln.qty * ln.unit_cost, 2),
    }


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


def _wo_dict(wo: WorkOrder, with_lines: bool = False,
             session=None) -> dict:
    from . import wo_invoices            # import diferido (orden de carga)
    total = round(sum(ln.qty * ln.unit_cost for ln in wo.lines), 2)
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
    }
    if with_lines:
        out["lines"] = [_line_dict(ln) for ln in wo.lines]
    return out


def list_wos(status: str = "", unit: str = "", limit: int = 200) -> list[dict]:
    with SessionLocal() as session:
        q = select(WorkOrder).order_by(WorkOrder.id.desc()).limit(limit)
        if status:
            q = q.where(WorkOrder.status == status)
        if unit:
            q = q.where(WorkOrder.unit == unit)
        return [_wo_dict(w) for w in session.scalars(q).all()]


def get_wo(wo_id: int) -> dict | None:
    with SessionLocal() as session:
        wo = session.get(WorkOrder, wo_id)
        if wo is None:
            return None
        out = _wo_dict(wo, with_lines=True)
        # Vínculos padre/hijas para el drawer (review v1.26): "#4.1 · child of
        # #4" + enlaces a las otras unidades del mismo invoice.
        out["links"] = _links_dict(wo, session)
        return out


def create_wo(unit: str, title: str, complaint: str = "",
              company: str = "", mechanic: str = "",
              priority: str = "normal", is_pm: bool = False,
              source: str = "manual", mileage: int | None = None,
              service_date: str = "", campaign: str = "",
              shop_invoice: str = "", parent_id: int | None = None) -> dict:
    """Crea una work order. Si `parent_id` viene seteado, la orden es una HIJA
    del invoice multi-unidad (review v1.26): se le asigna el siguiente
    `child_seq` libre bajo ese padre para numerarla #padre.N (#4.1, #4.2…)."""
    from . import maint                  # import diferido (orden de carga)
    unit = unit.strip()
    title = title.strip()
    if not unit or not title:
        raise ValueError("unit and title are required")
    if priority not in PRIORITIES:
        priority = "normal"
    if campaign and campaign not in maint.CAMPAIGNS:
        campaign = ""
    now = datetime.now()
    wo = WorkOrder(
        created_at=now, updated_at=now,
        unit=unit[:64], company=company.strip()[:64],
        # Crear ya asignada si vino mecánico (gate de assigned cumplido).
        status="assigned" if mechanic.strip() else "open",
        priority=priority,
        title=title[:140], complaint=complaint.strip(),
        mechanic=mechanic.strip()[:80], notes="",
        is_pm=bool(is_pm) or campaign == "pm",
        campaign=campaign,
        source=source[:20] or "manual",
        mileage=(int(mileage) if mileage not in (None, "") else None),
        service_date=(service_date.strip()[:10] or None),
        shop_invoice=shop_invoice.strip()[:60],
    )
    with SessionLocal() as session:
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
        try:
            session.commit()
        except IntegrityError:
            # DATA-4: colisión de child_seq por dos creaciones concurrentes
            # bajo el mismo padre (la UniqueConstraint(parent_id, child_seq) lo
            # impide). Antes generaba un #4.1 duplicado en silencio; ahora falla
            # claro y el usuario reintenta.
            session.rollback()
            raise ValueError(
                "work order number collision (concurrent create), retry")
        out = _wo_dict(wo, with_lines=True)
        out["links"] = _links_dict(wo, session)
        return out


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

        # Campos simples primero: permite "asignar mecánico + avanzar"
        # en el mismo request (el gate ve el mecánico nuevo).
        if "priority" in fields and fields["priority"] in PRIORITIES:
            wo.priority = fields["priority"]
        # invoice_number (el propio de Fleet Tracker) NO es editable por WO:
        # se asigna solo al facturar y su formato se configura en Settings.
        for key, cap in (("title", 140), ("mechanic", 80),
                         ("company", 64), ("po_number", 60),
                         ("authorizer", 80), ("shop_invoice", 60)):
            if key in fields:
                setattr(wo, key, str(fields[key]).strip()[:cap])
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
        if "service_date" in fields:
            wo.service_date = (str(fields["service_date"]).strip()[:10]
                               or None)

        if "status" in fields and fields["status"] in STATUSES:
            target = fields["status"]
            total = round(sum(ln.qty * ln.unit_cost for ln in wo.lines), 2)
            if _ORDER[target] > _ORDER[wo.status]:      # avance: gates
                err = gate_error(target, wo.mechanic, total)
                if err:
                    session.rollback()
                    raise ValueError(err)
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
            else:
                wo.invoiced_at = None

        wo.updated_at = datetime.now()
        # Capturar (line_id, part_number, qty) de las líneas de PARTE con
        # part_number conocido ANTES de cerrar la sesión, para alimentar el
        # hook de inventario (las líneas son lazy y el WO sale del scope).
        is_invoiced = wo.invoiced_at is not None
        consume_lines = [
            (ln.id, ln.part_number, ln.qty) for ln in wo.lines
            if ln.kind == "part" and (ln.part_number or "").strip()
        ] if is_invoiced else []
        session.commit()

        # Hook de inventario (fase Inventory): al FACTURAR (invoiced) se
        # consume el stock de cada línea de parte con part_number conocido.
        # Idempotente vía el guard (reason, ref_type, ref_id) en
        # inventory.adjust: re-facturar (o des-facturar y re-facturar) NO
        # duplica el descuento. Fuera del flush: adjust abre su sesión.
        if is_invoiced:
            from . import inventory
            for line_id, pn, qty in consume_lines:
                inventory.adjust(pn, -float(qty or 0), "wo_consume",
                                 ref_type="wo_line", ref_id=line_id,
                                 note=f"WO #{wo.id} invoiced")

        # Hook PM: WO de PM que llegó a completed (o más) con millaje ->
        # el PM tracker registra el servicio sin pasar por el CSV.
        if (_ORDER[wo.status] >= _ORDER["completed"]
                and wo.is_pm and wo.pm_miles):
            pm.set_override(wo.unit, "last_pm_miles", wo.pm_miles)

        # Hook campañas (H3b, estilo Fullbay): al FACTURAR una orden con
        # campaña, se registra el servicio en Components & PMs del
        # perfil. Idempotente: una orden solo registra UNA vez aunque se
        # des-facture y re-facture (se busca su "WO #id:" en las notas).
        if (wo.campaign and not was_invoiced
                and wo.invoiced_at is not None):
            from datetime import date as _date
            from ..db import MaintRecord
            already = session.scalar(
                select(MaintRecord).where(
                    MaintRecord.unit == wo.unit,
                    MaintRecord.kind == wo.campaign,
                    MaintRecord.notes.like(f"WO #{wo.id}:%")))
            if already is None:
                maint.add_record(
                    wo.unit, wo.campaign,
                    wo.service_date or _date.today().isoformat(),
                    wo.mileage or wo.pm_miles,
                    notes=f"WO #{wo.id}: {wo.title}"[:300])

        return _wo_dict(wo, with_lines=True)


def add_line(wo_id: int, kind: str, description: str,
             qty: float, unit_cost: float,
             part_number: str = "") -> dict | None:
    if kind not in LINE_KINDS:
        raise ValueError(f"invalid kind: {kind}")
    description = description.strip()
    if not description:
        raise ValueError("description is required")
    with SessionLocal() as session:
        wo = session.get(WorkOrder, wo_id)
        if wo is None:
            return None
        wo.lines.append(WorkOrderLine(
            kind=kind, description=description[:160],
            part_number=(part_number or "").strip()[:60],
            qty=max(0.0, float(qty or 0)),
            unit_cost=max(0.0, float(unit_cost or 0)),
        ))
        wo.updated_at = datetime.now()
        session.commit()
        return _wo_dict(wo, with_lines=True)


def delete_line(wo_id: int, line_id: int) -> dict | None:
    with SessionLocal() as session:
        wo = session.get(WorkOrder, wo_id)
        if wo is None:
            return None
        wo.lines = [ln for ln in wo.lines if ln.id != line_id]
        wo.updated_at = datetime.now()
        session.commit()
        return _wo_dict(wo, with_lines=True)


def delete_wo(wo_id: int) -> bool:
    """Elimina la work order y sus líneas (cascade). H3: pedido del
    usuario para corregir órdenes creadas por error.

    Multi-unit (v1.26): borrar el PADRE de un invoice multi-unidad borra
    también sus HIJAS (son del mismo invoice; dejarlas huérfanas rompería su
    número de display #4.N). Borrar una hija suelta no toca al padre."""
    from . import wo_invoices            # import diferido (orden de carga)
    with SessionLocal() as session:
        wo = session.get(WorkOrder, wo_id)
        if wo is None:
            return False
        # Hijas del invoice (si esta orden es el padre).
        kids = session.scalars(
            select(WorkOrder).where(WorkOrder.parent_id == wo_id)).all()
        kid_ids = [k.id for k in kids]
        for k in kids:
            session.delete(k)
        session.delete(wo)
        session.commit()
        # Limpia los archivos de factura adjuntos (fuera de la DB).
        for cid in [wo_id, *kid_ids]:
            wo_invoices.delete_file(cid)
        return True


def mechanics() -> list[str]:
    """Mecánicos usados antes (para autocompletar)."""
    with SessionLocal() as session:
        rows = session.scalars(
            select(WorkOrder.mechanic).distinct()).all()
        return sorted({m for m in rows if m})


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
        return {
            "open": by_status.get("open", 0),
            "assigned": by_status.get("assigned", 0),
            "in_progress": by_status.get("in_progress", 0),
            "completed": by_status.get("completed", 0),
            "invoiced": by_status.get("invoiced", 0),
            "waiting_parts": waiting,
            "completed_30d": len(done_30),
            "cost_30d": cost_30,
        }
