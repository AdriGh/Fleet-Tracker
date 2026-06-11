# -*- coding: utf-8 -*-
"""Work Orders (fase G5 — el reemplazo de Fullbay para flota propia).

Pipeline: defecto (o manual) -> WO -> partes/labor -> completado.
Al completar un WO marcado como PM con millaje, se actualiza el override
`last_pm_miles` del PM tracker: el ciclo de mantenimiento se cierra
dentro de la app sin re-exportar el CSV de Fullbay.

Estados válidos: open -> in_progress -> waiting_parts -> completed
(la UI permite saltar entre ellos; `completed` sella closed_at).
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import func, select

from ..db import SessionLocal, WorkOrder, WorkOrderLine
from . import pm

STATUSES = ("open", "in_progress", "waiting_parts", "completed")
PRIORITIES = ("low", "normal", "high")
LINE_KINDS = ("part", "labor")


def _line_dict(ln: WorkOrderLine) -> dict:
    return {
        "id": ln.id,
        "kind": ln.kind,
        "description": ln.description,
        "qty": ln.qty,
        "unit_cost": ln.unit_cost,
        "total": round(ln.qty * ln.unit_cost, 2),
    }


def _wo_dict(wo: WorkOrder, with_lines: bool = False) -> dict:
    total = round(sum(ln.qty * ln.unit_cost for ln in wo.lines), 2)
    out = {
        "id": wo.id,
        "created_at": wo.created_at.isoformat(),
        "updated_at": wo.updated_at.isoformat(),
        "closed_at": wo.closed_at.isoformat() if wo.closed_at else None,
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
        "source": wo.source,
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
        return _wo_dict(wo, with_lines=True) if wo else None


def create_wo(unit: str, title: str, complaint: str = "",
              company: str = "", mechanic: str = "",
              priority: str = "normal", is_pm: bool = False,
              source: str = "manual") -> dict:
    unit = unit.strip()
    title = title.strip()
    if not unit or not title:
        raise ValueError("unit y title son obligatorios")
    if priority not in PRIORITIES:
        priority = "normal"
    now = datetime.now()
    wo = WorkOrder(
        created_at=now, updated_at=now,
        unit=unit[:64], company=company.strip()[:64],
        status="open", priority=priority,
        title=title[:140], complaint=complaint.strip(),
        mechanic=mechanic.strip()[:80], notes="",
        is_pm=bool(is_pm), source=source[:20] or "manual",
    )
    with SessionLocal() as session:
        session.add(wo)
        session.commit()
        return _wo_dict(wo, with_lines=True)


def update_wo(wo_id: int, fields: dict) -> dict | None:
    """Actualiza campos editables. Completar un WO de PM con millaje
    actualiza el override last_pm_miles del PM tracker."""
    with SessionLocal() as session:
        wo = session.get(WorkOrder, wo_id)
        if wo is None:
            return None

        if "status" in fields and fields["status"] in STATUSES:
            wo.status = fields["status"]
            if wo.status == "completed":
                wo.closed_at = wo.closed_at or datetime.now()
            else:
                wo.closed_at = None
        if "priority" in fields and fields["priority"] in PRIORITIES:
            wo.priority = fields["priority"]
        for key, cap in (("title", 140), ("mechanic", 80),
                         ("company", 64)):
            if key in fields:
                setattr(wo, key, str(fields[key]).strip()[:cap])
        for key in ("complaint", "notes"):
            if key in fields:
                setattr(wo, key, str(fields[key]).strip())
        if "is_pm" in fields:
            wo.is_pm = bool(fields["is_pm"])
        if "pm_miles" in fields:
            try:
                wo.pm_miles = (int(fields["pm_miles"])
                               if fields["pm_miles"] not in ("", None)
                               else None)
            except (TypeError, ValueError):
                pass

        wo.updated_at = datetime.now()
        session.commit()

        # Hook PM: WO de PM completado con millaje -> el PM tracker
        # registra el servicio sin pasar por el CSV de Fullbay.
        if wo.status == "completed" and wo.is_pm and wo.pm_miles:
            pm.set_override(wo.unit, "last_pm_miles", wo.pm_miles)

        return _wo_dict(wo, with_lines=True)


def add_line(wo_id: int, kind: str, description: str,
             qty: float, unit_cost: float) -> dict | None:
    if kind not in LINE_KINDS:
        raise ValueError(f"kind inválido: {kind}")
    description = description.strip()
    if not description:
        raise ValueError("description es obligatoria")
    with SessionLocal() as session:
        wo = session.get(WorkOrder, wo_id)
        if wo is None:
            return None
        wo.lines.append(WorkOrderLine(
            kind=kind, description=description[:160],
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


def mechanics() -> list[str]:
    """Mecánicos usados antes (para autocompletar)."""
    with SessionLocal() as session:
        rows = session.scalars(
            select(WorkOrder.mechanic).distinct()).all()
        return sorted({m for m in rows if m})


def stats() -> dict:
    month_ago = datetime.now() - timedelta(days=30)
    with SessionLocal() as session:
        by_status = dict(session.execute(
            select(WorkOrder.status, func.count())
            .group_by(WorkOrder.status)).all())
        done_30 = session.scalars(
            select(WorkOrder).where(
                WorkOrder.status == "completed",
                WorkOrder.closed_at >= month_ago)).all()
        cost_30 = round(sum(
            ln.qty * ln.unit_cost for w in done_30 for ln in w.lines), 2)
        return {
            "open": by_status.get("open", 0),
            "in_progress": by_status.get("in_progress", 0),
            "waiting_parts": by_status.get("waiting_parts", 0),
            "completed_30d": len(done_30),
            "cost_30d": cost_30,
        }
