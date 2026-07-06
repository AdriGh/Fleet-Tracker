# -*- coding: utf-8 -*-
"""Inventario de partes (fase Inventory): movimientos auditables + stock.

Modelo de stock AUDITABLE e IDEMPOTENTE:

- La verdad histórica vive en `part_stock_movement` (db.py): cada cambio de
  existencia es una fila con su delta, motivo y referencia de origen.
- `Part.on_hand` es un cache: se actualiza JUNTO con cada movimiento, así el
  listado de partes muestra la existencia sin recorrer el libro.

Idempotencia: el triple (reason, ref_type, ref_id) identifica de forma única
un movimiento dentro de la org. Antes de aplicar un movimiento referenciado
(p.ej. la recepción de una línea de PO), `adjust` chequea si YA existe ese
triple; si existe, no hace nada. Eso permite que los hooks del ciclo de vida
(PO -> received, WO -> invoiced) corran cuantas veces se quiera —incluyendo
hacer toggle del status ida y vuelta— SIN duplicar el conteo.

Los ajustes manuales (reason='manual') NO llevan guard: cada uno es un evento
deliberado del usuario, así que siempre se aplican (ref vacío).

org-scoping: las queries pasan por los eventos de SessionLocal (db.py), que
acotan al tenant del request. `on_hand` y los movimientos quedan aislados por
organización igual que el resto de la data de negocio.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select

from ..db import Part, PartStockMovement, SessionLocal

# Motivos válidos de un movimiento de inventario.
REASONS = ("po_receive", "wo_consume", "manual")


def _movement_dict(m: PartStockMovement) -> dict:
    return {
        "id": m.id,
        "part_number": m.part_number,
        "delta": m.delta,
        "reason": m.reason,
        "ref_type": m.ref_type or "",
        "ref_id": m.ref_id or "",
        "note": m.note or "",
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


def _bump_on_hand(session, part_number: str, delta: float) -> None:
    """Suma `delta` al cache on_hand de la parte (si está en el catálogo).

    Si la parte no existe en el catálogo no se crea: el movimiento igual se
    registra (el libro es la verdad), pero no hay fila Part que cachear. Esto
    cubre el caso de una línea de WO/PO con un part_number suelto."""
    p = session.scalar(select(Part).where(Part.part_number == part_number))
    if p is not None:
        p.on_hand = (p.on_hand or 0.0) + delta
        p.updated_at = datetime.now()


def adjust(part_number: str, delta: float, reason: str,
           ref_type: str = "", ref_id: str = "", note: str = "") -> dict:
    """Aplica un movimiento de inventario y actualiza el cache on_hand.

    Devuelve {"applied": bool, "movement": dict|None, "on_hand": float|None}.
    `applied=False` significa que el guard de idempotencia ya tenía registrado
    ese (reason, ref_type, ref_id) y no se hizo nada (re-corrida de un hook).

    Para movimientos referenciados (po_receive / wo_consume) pasar ref_type +
    ref_id; para 'manual' se omiten (cada ajuste manual es único)."""
    part_number = (part_number or "").strip()[:60]
    if not part_number:
        raise ValueError("part_number is required")
    if reason not in REASONS:
        raise ValueError(f"invalid reason: {reason}")
    try:
        delta = float(delta)
    except (TypeError, ValueError):
        raise ValueError("delta must be a number")

    with SessionLocal() as session:
        # Guard de idempotencia: solo para movimientos con referencia (los
        # hooks del ciclo de vida). Si ya existe ese triple, no re-aplicar.
        if ref_type and ref_id:
            existing = session.scalar(select(PartStockMovement).where(
                PartStockMovement.reason == reason,
                PartStockMovement.ref_type == ref_type,
                PartStockMovement.ref_id == str(ref_id)))
            if existing is not None:
                return {"applied": False,
                        "movement": _movement_dict(existing),
                        "on_hand": _current_on_hand(session, part_number)}

        m = PartStockMovement(
            part_number=part_number, delta=delta, reason=reason,
            ref_type=ref_type[:20], ref_id=str(ref_id)[:40],
            note=(note or "").strip()[:200], created_at=datetime.now())
        session.add(m)
        _bump_on_hand(session, part_number, delta)
        session.commit()
        return {"applied": True, "movement": _movement_dict(m),
                "on_hand": _current_on_hand(session, part_number)}


def apply_in_session(session, part_number: str, delta: float, reason: str,
                     ref_type: str = "", ref_id: str = "",
                     note: str = "") -> bool:
    """Aplica un movimiento DENTRO de la sesión del caller (NO commitea: lo
    hace el caller). Devuelve True si se aplicó, False si el guard de
    idempotencia (reason, ref_type, ref_id) ya lo tenía registrado.

    A diferencia de `adjust` (que abre su propia sesión y commitea), esto
    permite que el movimiento + los cambios del caller (p.ej. qty_received de
    una PO) commiteen ATÓMICAMENTE en la MISMA transacción: si el caller hace
    rollback, el movimiento también se deshace (no queda stock huérfano ni
    qty_received sin su movimiento)."""
    part_number = (part_number or "").strip()[:60]
    if not part_number:
        raise ValueError("part_number is required")
    if reason not in REASONS:
        raise ValueError(f"invalid reason: {reason}")
    delta = float(delta)
    if ref_type and ref_id:
        existing = session.scalar(select(PartStockMovement.id).where(
            PartStockMovement.reason == reason,
            PartStockMovement.ref_type == ref_type,
            PartStockMovement.ref_id == str(ref_id)))
        if existing is not None:
            return False
    session.add(PartStockMovement(
        part_number=part_number, delta=delta, reason=reason,
        ref_type=ref_type[:20], ref_id=str(ref_id)[:40],
        note=(note or "").strip()[:200], created_at=datetime.now()))
    _bump_on_hand(session, part_number, delta)
    return True


def _current_on_hand(session, part_number: str) -> float | None:
    p = session.scalar(select(Part).where(Part.part_number == part_number))
    return p.on_hand if p is not None else None


def manual_adjust(part_number: str, delta: float, note: str = "") -> dict:
    """Ajuste manual de existencia (reason='manual', sin guard). `delta` puede
    ser negativo (merma/corrección) o positivo (conteo físico, hallazgo)."""
    return adjust(part_number, delta, "manual", note=note)


def low_stock_list() -> list[dict]:
    """Partes en o por debajo de su punto de re-pedido. Solo cuenta las que
    tienen reorder_point > 0 (0 = sin seguimiento de low-stock)."""
    with SessionLocal() as session:
        rows = session.scalars(
            select(Part).where(
                Part.reorder_point > 0,
                Part.on_hand <= Part.reorder_point)
            .order_by(func.lower(Part.part_number))).all()
        return [{
            "id": p.id,
            "part_number": p.part_number,
            "description": p.description,
            "category": p.category,
            "on_hand": p.on_hand,
            "reorder_point": p.reorder_point,
            "vendor_id": p.vendor_id,
        } for p in rows]


def movements(part_number: str, limit: int = 200) -> list[dict]:
    """Libro de movimientos de una parte, del más reciente al más antiguo."""
    part_number = (part_number or "").strip()
    with SessionLocal() as session:
        rows = session.scalars(
            select(PartStockMovement)
            .where(PartStockMovement.part_number == part_number)
            .order_by(PartStockMovement.id.desc())
            .limit(limit)).all()
        return [_movement_dict(m) for m in rows]
