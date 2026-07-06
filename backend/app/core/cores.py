# -*- coding: utf-8 -*-
"""Core tracking (v2.5) — el moat: banco de cores pendientes de devolver.

Un `core` es la unidad vieja/reconstruible (alternador, arranque, turbo, caja…)
que el proveedor pide de vuelta para reembolsar el depósito (`core_charge`). Al
recibir una PO de una parte con core, se crea un CoreItem PENDIENTE; cuando el
taller devuelve la unidad vieja al proveedor, se marca RETURNED y se recupera
el crédito. Ningún competidor del segmento (Fullbay/SquareRigger/Fleetio) lo
cubre bien — es dolor real y diario de un taller diésel.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import select

from ..db import CoreItem, SessionLocal


def _core_dict(c: CoreItem) -> dict:
    return {
        "id": c.id,
        "part_number": c.part_number or "",
        "description": c.description or "",
        "vendor": c.vendor or "",
        "core_charge": c.core_charge,
        "qty": c.qty,
        "deposit": round((c.core_charge or 0.0) * (c.qty or 0.0), 2),
        "po_id": c.po_id,
        "status": c.status,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "returned_at": c.returned_at.isoformat() if c.returned_at else None,
    }


def add_core_in_session(session, part_number: str, description: str,
                        vendor: str, core_charge: float, qty: float,
                        po_id: int | None, ref: str) -> bool:
    """Crea un CoreItem PENDIENTE DENTRO de la sesión del caller (no commitea:
    lo hace el caller, atómico con el movimiento de stock que lo originó).

    Idempotente por `ref` (= el ref_id del movimiento de stock del evento de
    recepción): re-recibir la misma PO no duplica el core. Devuelve True si se
    creó, False si no correspondía (sin core / qty<=0) o ya existía."""
    if (core_charge or 0.0) <= 0 or (qty or 0.0) <= 0:
        return False
    if ref and session.scalar(select(CoreItem.id).where(CoreItem.ref == ref)):
        return False
    session.add(CoreItem(
        part_number=(part_number or "")[:60],
        description=(description or part_number or "")[:160],
        vendor=(vendor or "")[:120],
        core_charge=float(core_charge), qty=float(qty),
        po_id=po_id, ref=(ref or "")[:60],
        status="pending", created_at=datetime.now()))
    return True


def list_cores(status: str = "pending", limit: int = 300) -> list[dict]:
    with SessionLocal() as session:
        q = (select(CoreItem)
             .order_by(CoreItem.created_at.desc(), CoreItem.id.desc())
             .limit(limit))
        if status:
            q = q.where(CoreItem.status == status)
        return [_core_dict(c) for c in session.scalars(q).all()]


def core_stats() -> dict:
    """KPIs del banco de cores: depósitos afuera (plata inmovilizada), cores
    pendientes de devolver, y créditos recuperados en los últimos 30 días."""
    cutoff = datetime.now() - timedelta(days=30)
    with SessionLocal() as session:
        pend = session.scalars(select(CoreItem).where(
            CoreItem.status == "pending")).all()
        ret_30 = session.scalars(select(CoreItem).where(
            CoreItem.status == "returned",
            CoreItem.returned_at >= cutoff)).all()
        return {
            "pending": len(pend),
            "pending_deposit": round(
                sum((c.core_charge or 0) * (c.qty or 0) for c in pend), 2),
            "vendors": len({(c.vendor or "").strip().lower()
                            for c in pend if (c.vendor or "").strip()}),
            "returned_30d": len(ret_30),
            "credited_30d": round(
                sum((c.core_charge or 0) * (c.qty or 0) for c in ret_30), 2),
        }


def return_core(core_id: int) -> dict | None:
    """Marca un core como DEVUELTO (crédito recuperado). Idempotente."""
    with SessionLocal() as session:
        c = session.get(CoreItem, core_id)
        if c is None:
            return None
        if c.status != "returned":
            c.status = "returned"
            c.returned_at = datetime.now()
            session.commit()
        return _core_dict(c)


def unreturn_core(core_id: int) -> dict | None:
    """Revierte un core devuelto por error a PENDIENTE."""
    with SessionLocal() as session:
        c = session.get(CoreItem, core_id)
        if c is None:
            return None
        if c.status != "pending":
            c.status = "pending"
            c.returned_at = None
            session.commit()
        return _core_dict(c)
