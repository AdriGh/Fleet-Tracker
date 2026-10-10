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

Costeo (v2.22): cada movimiento guarda `unit_cost` y `value_delta` ($), y
`Part.avg_cost` es un PROMEDIO PONDERADO MÓVIL real:
  - po_receive (+q a costo c): avg = (oh*avg + q*c)/(oh+q); si oh <= 0 (o no
    había costo de referencia) avg = c. last_cost = c.
  - po_unreceive (-q de una línea a costo c, `unreceive_in_session`): las
    L unidades de ESA recepción que siguen en stock (ver abajo) salen a c y
    el resto (q-L) sale al promedio de las demás unidades, que queda como el
    nuevo avg: avg = (oh*avg - L*c)/(oh-L). Sin consumo intermedio (L = q)
    es la reversión exacta (oh*avg - q*c)/(oh-q). Si no queda stock, se
    restaura el costo previo (avg de las otras unidades, o el de la última
    recepción vigente de otra línea, o 0 → cae al costo estándar) y
    last_cost vuelve a la última recepción no revertida.
  - po_cost_adj (delta 0): corrección de costo de algo YA recibido; revalúa
    solo las unidades de esa recepción que siguen en stock:
    avg += Δc*L/oh. Lo consumido queda registrado solo en value_delta
    (varianza); las WO facturadas NO se tocan.
"Unidades de la recepción que siguen en stock" (L, `line_units_on_hand`):
con promedio móvil cada consumo saca de TODO el stock en proporción, así
que se reproduce el libro desde la recepción: cada salida multiplica L por
(1 - salida/oh). Con stock previo en la parte, eso reparte el consumo entre
lo viejo y lo nuevo (no asume que lo recibido fue lo último en usarse).
  - wo_consume / manual: salen/entran al avg vigente (no lo mueven).
El "avg vigente" de una parte sin avg calculado (0) cae a su `cost` estándar
— el mismo fallback que muestra el catálogo (parts._part_dict).

org-scoping: las queries pasan por los eventos de SessionLocal (db.py), que
acotan al tenant del request. `on_hand` y los movimientos quedan aislados por
organización igual que el resto de la data de negocio.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select

from ..db import Part, PartStockMovement, SessionLocal

# Motivos válidos de un movimiento de inventario.
REASONS = ("po_receive", "wo_consume", "manual", "po_cost_adj",
           "po_unreceive")

_EPS = 1e-9


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
        "unit_cost": m.unit_cost,
        "value_delta": m.value_delta,
        "actor": m.actor or "",
    }


def _part(session, part_number: str) -> Part | None:
    return session.scalar(select(Part).where(Part.part_number == part_number))


def effective_avg(p: Part | None) -> float:
    """Costo promedio vigente: avg_cost si ya se calculó (> 0), si no el
    costo estándar de la parte."""
    if p is None:
        return 0.0
    avg = float(p.avg_cost or 0.0)
    return avg if avg > 0 else float(p.cost or 0.0)


def _apply(session, part_number: str, delta: float, reason: str,
           ref_type: str, ref_id: str, note: str,
           unit_cost: float | None, actor: str) -> PartStockMovement:
    """Núcleo común: costea, registra el movimiento y mueve el cache on_hand
    (si la parte está en el catálogo). No commitea.

    Si la parte no existe en el catálogo no se crea: el movimiento igual se
    registra (el libro es la verdad), pero no hay fila Part que cachear ni
    promedio que mantener. Cubre una línea de WO/PO con un part_number
    suelto."""
    p = _part(session, part_number)
    now = datetime.now()
    cost = None if unit_cost is None else max(0.0, float(unit_cost))
    if p is not None:
        oh = float(p.on_hand or 0.0)
        base = effective_avg(p)
        if reason == "po_receive" and delta > 0 and cost is not None:
            # Promedio ponderado móvil (ver docstring del módulo).
            if oh <= _EPS or base <= 0:
                p.avg_cost = round(cost, 6)
            else:
                p.avg_cost = round((oh * base + delta * cost) / (oh + delta), 6)
            p.last_cost = round(cost, 6)
        elif cost is None:
            # Consumo / ajuste manual: sale/entra al promedio vigente.
            cost = base
        p.on_hand = oh + delta
        p.updated_at = now
    m = PartStockMovement(
        part_number=part_number, delta=delta, reason=reason,
        ref_type=(ref_type or "")[:20], ref_id=str(ref_id or "")[:40],
        note=(note or "").strip()[:200], created_at=now,
        unit_cost=None if cost is None else round(cost, 6),
        value_delta=None if cost is None else round(delta * cost, 4),
        actor=(actor or "")[:80])
    session.add(m)
    return m


def _check(part_number: str, reason: str, delta) -> tuple[str, float]:
    part_number = (part_number or "").strip()[:60]
    if not part_number:
        raise ValueError("part_number is required")
    if reason not in REASONS:
        raise ValueError(f"invalid reason: {reason}")
    try:
        delta = float(delta)
    except (TypeError, ValueError):
        raise ValueError("delta must be a number")
    return part_number, delta


def _already(session, reason: str, ref_type: str, ref_id: str):
    return session.scalar(select(PartStockMovement).where(
        PartStockMovement.reason == reason,
        PartStockMovement.ref_type == ref_type,
        PartStockMovement.ref_id == str(ref_id)))


def already_applied(session, reason: str, ref_type: str,
                    ref_id: str) -> bool:
    """¿Ese (reason, ref_type, ref_id) ya está en el libro? (el guard de
    idempotencia, para planificar antes de aplicar)."""
    return _already(session, reason, ref_type, ref_id) is not None


def adjust(part_number: str, delta: float, reason: str,
           ref_type: str = "", ref_id: str = "", note: str = "",
           unit_cost: float | None = None, actor: str = "") -> dict:
    """Aplica un movimiento de inventario y actualiza el cache on_hand.

    Devuelve {"applied": bool, "movement": dict|None, "on_hand": float|None}.
    `applied=False` significa que el guard de idempotencia ya tenía registrado
    ese (reason, ref_type, ref_id) y no se hizo nada (re-corrida de un hook).

    Para movimientos referenciados (po_receive / wo_consume) pasar ref_type +
    ref_id; para 'manual' se omiten (cada ajuste manual es único)."""
    part_number, delta = _check(part_number, reason, delta)
    with SessionLocal() as session:
        # Guard de idempotencia: solo para movimientos con referencia (los
        # hooks del ciclo de vida). Si ya existe ese triple, no re-aplicar.
        if ref_type and ref_id:
            existing = _already(session, reason, ref_type, ref_id)
            if existing is not None:
                return {"applied": False,
                        "movement": _movement_dict(existing),
                        "on_hand": _current_on_hand(session, part_number)}
        m = _apply(session, part_number, delta, reason, ref_type, ref_id,
                   note, unit_cost, actor)
        session.commit()
        return {"applied": True, "movement": _movement_dict(m),
                "on_hand": _current_on_hand(session, part_number)}


def apply_in_session(session, part_number: str, delta: float, reason: str,
                     ref_type: str = "", ref_id: str = "",
                     note: str = "", unit_cost: float | None = None,
                     actor: str = "") -> bool:
    """Aplica un movimiento DENTRO de la sesión del caller (NO commitea: lo
    hace el caller). Devuelve True si se aplicó, False si el guard de
    idempotencia (reason, ref_type, ref_id) ya lo tenía registrado.

    A diferencia de `adjust` (que abre su propia sesión y commitea), esto
    permite que el movimiento + los cambios del caller (p.ej. qty_received de
    una PO) commiteen ATÓMICAMENTE en la MISMA transacción: si el caller hace
    rollback, el movimiento también se deshace (no queda stock huérfano ni
    qty_received sin su movimiento). `unit_cost` (recepciones) alimenta el
    promedio ponderado; sin él, el movimiento se valúa al avg vigente."""
    part_number, delta = _check(part_number, reason, delta)
    if ref_type and ref_id:
        if _already(session, reason, ref_type, ref_id) is not None:
            return False
    _apply(session, part_number, delta, reason, ref_type, ref_id, note,
           unit_cost, actor)
    return True


def line_units_on_hand(session, part_number: str,
                       receipt_ids: list[int]) -> float | None:
    """Unidades de una recepción (los movimientos po_receive `receipt_ids`
    de una línea de PO) que SIGUEN en stock bajo el promedio móvil.

    Reproduce el libro de la parte desde la primera de esas recepciones: el
    on_hand de partida se reconstruye hacia atrás desde el cache (on_hand
    actual − Σ deltas posteriores), las recepciones de la línea suman a L y
    cada salida (consumo, ajuste negativo, unreceive de otra línea) saca de
    TODO el stock en proporción: L *= (1 - salida/oh). None si la parte no
    está en el catálogo o no hay recepciones."""
    ids = {int(i) for i in (receipt_ids or []) if i is not None}
    p = _part(session, part_number)
    if not ids or p is None:
        return None
    rows = session.execute(
        select(PartStockMovement.id, PartStockMovement.delta).where(
            PartStockMovement.part_number == part_number,
            PartStockMovement.id >= min(ids))
        .order_by(PartStockMovement.id)).all()
    oh_now = float(p.on_hand or 0.0)
    oh = oh_now - sum(float(d or 0.0) for _, d in rows)
    units = 0.0
    for mid, d in rows:
        d = float(d or 0.0)
        if mid in ids:
            if d > 0:
                units += d
        elif d < 0 and units > 0:
            units = units * max(0.0, 1.0 + d / oh) if oh > _EPS else 0.0
        oh += d
    return max(0.0, min(units, max(0.0, oh_now)))


def unreceive_in_session(session, part_number: str, qty: float,
                         line_cost: float, line_units: float | None,
                         ref_type: str, ref_id: str, note: str = "",
                         actor: str = "",
                         restore_cost: float | None = None,
                         restore_last_cost: float | None = None,
                         set_last_cost: bool = False) -> bool:
    """Des-recibe `qty` unidades de una línea de PO (po_unreceive, v2.22).
    No commitea; idempotente por (reason, ref_type, ref_id).

    `line_units` = unidades de esa recepción que siguen en stock
    (line_units_on_hand; None -> se asume todo). Esas L salen al costo de la
    línea y el resto (q-L) al promedio de las DEMÁS unidades, que queda como
    nuevo avg (ver docstring del módulo). Si ese promedio no es sensato
    (<= 0: libro inconsistente, p.ej. on_hand editado a mano) las unidades
    salen al avg vigente (sin moverlo) y la diferencia queda como varianza.

    Si no queda stock: avg vuelve al de las otras unidades, o a
    `restore_cost` (la última recepción vigente de otra línea; 0 -> el costo
    estándar). Con `set_last_cost`, last_cost = `restore_last_cost` (la
    última recepción no revertida, o NULL)."""
    part_number, delta = _check(part_number, "po_unreceive", -abs(qty))
    if ref_type and ref_id and _already(session, "po_unreceive", ref_type,
                                        ref_id) is not None:
        return False
    q = -delta
    c = max(0.0, float(line_cost or 0.0))
    p = _part(session, part_number)
    now = datetime.now()
    removed = q * c
    if p is not None:
        oh = float(p.on_hand or 0.0)
        base = effective_avg(p)
        units = q if line_units is None else float(line_units)
        units = max(0.0, min(units, q, max(0.0, oh)))
        others = oh - units
        rest = oh - q
        a_other = None
        sane = True
        if others > _EPS:
            v = (oh * base - units * c) / others
            # Tolerancia relativa: un residuo ~0 es un libro roto, no un costo.
            sane = v == v and v > 1e-4 * max(1.0, base, c)
            if sane:
                a_other = v
        if not sane:
            # Promedio de las otras unidades no sensato: todo sale al avg
            # vigente (avg sin cambio); la diferencia queda como varianza.
            removed = q * base
            note = (note + " (valued at avg)").strip()
        else:
            removed = units * c + (q - units) * (
                a_other if a_other is not None else c)
            if a_other is not None:
                p.avg_cost = round(a_other, 6)
            else:
                # No quedan unidades ajenas a esta recepción: costo previo
                # (0 -> effective_avg cae al costo estándar).
                p.avg_cost = round(max(0.0, float(restore_cost or 0.0)), 6)
        if set_last_cost:
            p.last_cost = (None if restore_last_cost is None
                           else round(max(0.0, float(restore_last_cost)), 6))
        p.on_hand = rest
        p.updated_at = now
    session.add(PartStockMovement(
        part_number=part_number, delta=delta, reason="po_unreceive",
        ref_type=(ref_type or "")[:20], ref_id=str(ref_id or "")[:40],
        note=(note or "").strip()[:200], created_at=now,
        unit_cost=round(removed / q, 6) if q > _EPS else round(c, 6),
        value_delta=round(-removed, 4), actor=(actor or "")[:80]))
    return True


def revalue_in_session(session, part_number: str, qty_received: float,
                       old_cost: float, new_cost: float, ref_type: str,
                       ref_id: str, note: str = "", actor: str = "",
                       set_last_cost: bool = False,
                       units_on_hand: float | None = None) -> dict:
    """Corrección de costo de unidades YA recibidas (po_cost_adj, v2.22).

    Escribe UN movimiento delta 0 con unit_cost = costo nuevo y
    value_delta = Δc × qty_received, y revalúa Part.avg_cost SOLO por las
    unidades de esa recepción que siguen en stock (`units_on_hand`, de
    line_units_on_hand; sin él, min(qty_received, on_hand)):
        avg += Δc * L / on_hand   (on_hand > 0)
    Lo ya consumido (WO facturadas) no se toca: queda como varianza en
    value_delta. No commitea (atómico con el cambio de la PO del caller).
    Devuelve el detalle de la revaluación (para el preview/confirm de la UI).
    """
    part_number = (part_number or "").strip()[:60]
    if not part_number:
        raise ValueError("part_number is required")
    qr = max(0.0, float(qty_received or 0.0))
    dc = float(new_cost) - float(old_cost)
    p = _part(session, part_number)
    oh = float(p.on_hand or 0.0) if p is not None else 0.0
    avg_old = effective_avg(p) if p is not None else None
    avg_new = avg_old
    revalued = 0.0
    if p is not None and oh > _EPS:
        share = qr if units_on_hand is None else max(0.0, units_on_hand)
        revalued = min(qr, share, oh)
        avg_new = max(0.0, avg_old + dc * revalued / oh)
        p.avg_cost = round(avg_new, 6)
        p.updated_at = datetime.now()
    if p is not None and set_last_cost:
        p.last_cost = round(max(0.0, float(new_cost)), 6)
    value_delta = round(dc * qr, 4)
    session.add(PartStockMovement(
        part_number=part_number, delta=0.0, reason="po_cost_adj",
        ref_type=(ref_type or "")[:20], ref_id=str(ref_id or "")[:40],
        note=(note or "").strip()[:200], created_at=datetime.now(),
        unit_cost=round(max(0.0, float(new_cost)), 6),
        value_delta=value_delta, actor=(actor or "")[:80]))
    return {
        "part_number": part_number,
        "in_catalog": p is not None,
        "qty_received": round(qr, 4),
        "on_hand": round(oh, 4),
        "revalued_qty": round(revalued, 4),
        "consumed_qty": round(max(0.0, qr - revalued), 4),
        "old_cost": round(float(old_cost), 4),
        "new_cost": round(float(new_cost), 4),
        "avg_old": None if avg_old is None else round(avg_old, 4),
        "avg_new": None if avg_new is None else round(avg_new, 4),
        "value_delta": value_delta,
    }


def _current_on_hand(session, part_number: str) -> float | None:
    p = _part(session, part_number)
    return p.on_hand if p is not None else None


def manual_adjust(part_number: str, delta: float, note: str = "",
                  actor: str = "") -> dict:
    """Ajuste manual de existencia (reason='manual', sin guard). `delta` puede
    ser negativo (merma/corrección) o positivo (conteo físico, hallazgo)."""
    return adjust(part_number, delta, "manual", note=note, actor=actor)


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
