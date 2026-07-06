# -*- coding: utf-8 -*-
"""Warranty tracking (v2.6) — el moat: reclamos de garantía a nivel parte.

Detecta cuando la MISMA parte (con `warranty_months > 0`) se reusa en la MISMA
unidad dentro de la ventana de garantía de su instalación previa: la parte
falló prematuramente y el proveedor debería cubrir el reemplazo. SquareRigger
lo pitchea como "$1-2K por vehículo recuperados en 30 días"; replicable con
nuestro historial de work orders.
"""
from __future__ import annotations

import calendar
from collections import defaultdict
from datetime import date, datetime

from sqlalchemy import select

from ..db import (
    Part, SessionLocal, Vendor, WarrantyClaim, WorkOrder, WorkOrderLine,
)

_STATUSES = ("open", "submitted", "recovered", "dismissed")


def _wo_date(wo: WorkOrder) -> date | None:
    """Fecha de servicio de la WO: `service_date` ('YYYY-MM-DD') o created_at."""
    sd = (wo.service_date or "").strip()
    if sd:
        try:
            return date.fromisoformat(sd[:10])
        except ValueError:
            pass
    return wo.created_at.date() if wo.created_at else None


def _add_months(d: date, months: int) -> date:
    """Suma `months` meses a una fecha (clampeando el día al fin de mes)."""
    m = d.month - 1 + months
    y = d.year + m // 12
    m = m % 12 + 1
    day = min(d.day, calendar.monthrange(y, m)[1])
    return date(y, m, day)


def _claim_dict(c: WarrantyClaim) -> dict:
    return {
        "id": c.id,
        "part_number": c.part_number or "",
        "description": c.description or "",
        "unit": c.unit or "",
        "vendor": c.vendor or "",
        "install_wo": c.install_wo,
        "install_date": c.install_date or "",
        "failure_wo": c.failure_wo,
        "failure_date": c.failure_date or "",
        "warranty_until": c.warranty_until or "",
        "amount": c.amount,
        "status": c.status,
    }


def scan() -> int:
    """Escanea el historial de WOs y crea WarrantyClaims OPEN para cada caso de
    parte-reusada-dentro-de-garantía que aún no tenga claim. Idempotente por
    `ref` = '{failure_wo}:{part_number}'. Devuelve cuántos claims creó."""
    with SessionLocal() as session:
        warr = {p.part_number: p for p in session.scalars(
            select(Part).where(Part.warranty_months > 0)).all()}
        if not warr:
            return 0
        vmap = {v.id: v.name for v in session.scalars(select(Vendor)).all()}
        rows = session.execute(
            select(WorkOrderLine, WorkOrder)
            .join(WorkOrder, WorkOrderLine.wo_id == WorkOrder.id)
            .where(WorkOrderLine.kind == "part",
                   WorkOrderLine.part_number.in_(list(warr.keys())))).all()
        # Colapsar a UNA instalación por (unidad, parte, WO): varias líneas de
        # la misma parte en una WO son un solo evento; el monto es la SUMA de
        # esas líneas (así no se subestima el reclamo). Se ignoran líneas con
        # qty <= 0 (reversas/créditos).
        agg: dict[tuple[str, str, int], dict] = {}
        for ln, wo in rows:
            d = _wo_date(wo)
            if d is None or (ln.qty or 0) <= 0:
                continue
            key = (wo.unit, ln.part_number, wo.id)
            e = agg.get(key)
            if e is None:
                e = {"date": d, "wo": wo,
                     "desc": ln.description or ln.part_number, "amount": 0.0}
                agg[key] = e
            e["amount"] += (ln.qty or 0) * (ln.unit_cost or 0)
        groups: dict[tuple[str, str], list] = defaultdict(list)
        for (unit, pn, _woid), e in agg.items():
            groups[(unit, pn)].append(e)
        existing = {c.ref for c in session.scalars(select(WarrantyClaim)).all()}
        created = 0
        now = datetime.now()
        for (unit, pn), items in groups.items():
            if len(items) < 2:
                continue
            items.sort(key=lambda e: (e["date"], e["wo"].id))
            wmonths = warr[pn].warranty_months
            vendor = (vmap.get(warr[pn].vendor_id, "") or "")
            for i in range(1, len(items)):
                prev, fail = items[i - 1], items[i]
                warranty_until = _add_months(prev["date"], wmonths)
                if fail["date"] <= warranty_until:
                    amount = round(fail["amount"], 2)
                    if amount <= 0:
                        continue
                    ref = f"{fail['wo'].id}:{pn}"
                    if ref in existing:
                        continue
                    existing.add(ref)
                    session.add(WarrantyClaim(
                        part_number=pn, description=(fail["desc"] or pn)[:160],
                        unit=unit, vendor=vendor[:120],
                        install_wo=prev["wo"].id,
                        install_date=prev["date"].isoformat(),
                        failure_wo=fail["wo"].id,
                        failure_date=fail["date"].isoformat(),
                        warranty_until=warranty_until.isoformat(),
                        amount=amount, ref=ref, status="open",
                        created_at=now, updated_at=now))
                    created += 1
        if created:
            session.commit()
        return created


def list_claims(status: str = "open", limit: int = 300) -> list[dict]:
    with SessionLocal() as session:
        q = (select(WarrantyClaim)
             .order_by(WarrantyClaim.failure_date.desc(),
                       WarrantyClaim.id.desc()).limit(limit))
        if status:
            q = q.where(WarrantyClaim.status == status)
        return [_claim_dict(c) for c in session.scalars(q).all()]


def claim_stats() -> dict:
    """KPIs: claims abiertos + su monto recuperable, y créditos recuperados."""
    with SessionLocal() as session:
        rows = session.scalars(select(WarrantyClaim)).all()
        open_c = [c for c in rows if c.status == "open"]
        submitted = [c for c in rows if c.status == "submitted"]
        recovered = [c for c in rows if c.status == "recovered"]
        return {
            "open": len(open_c),
            "open_amount": round(sum(c.amount for c in open_c), 2),
            "submitted": len(submitted),
            "recovered": len(recovered),
            "recovered_amount": round(sum(c.amount for c in recovered), 2),
        }


def set_status(claim_id: int, status: str) -> dict | None:
    if status not in _STATUSES:
        raise ValueError(f"invalid status: {status}")
    with SessionLocal() as session:
        c = session.get(WarrantyClaim, claim_id)
        if c is None:
            return None
        c.status = status
        c.updated_at = datetime.now()
        session.commit()
        return _claim_dict(c)
