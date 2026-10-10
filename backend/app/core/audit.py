# -*- coding: utf-8 -*-
"""Rastro de auditoría genérico (v2.22).

Una fila de `audit_event` por cambio: entidad + id + acción + campo +
valor viejo/nuevo + actor. Nació para las POs editables post-recepción
(costeo), pero es genérico: cualquier módulo puede registrar eventos con
`record()` DENTRO de su sesión (atómico con el cambio que audita) y leerlos
con `list_events()`.

Convención de `entity_id`: texto. Para hijas de un documento se usa el
compuesto '<padre>:<hija>' (p.ej. una línea de la PO 12 → '12:345'), así la
historia completa de la PO se lee con un solo prefijo sobre el índice
(entity, entity_id). org-scoping: lo completan/filtran los eventos de
SessionLocal (db.py), igual que el resto de la data de negocio.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import or_, select

from ..db import AuditEvent, SessionLocal
from . import org_config


def fmt(v) -> str:
    """Valor → texto corto y estable para old/new (None → '')."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        return f"{round(v, 4):g}"
    return str(v)


def record(session, entity: str, entity_id, action: str, field: str = "",
           old=None, new=None, actor: str = "") -> AuditEvent:
    """Agrega un evento a la sesión del caller (NO commitea: lo hace el
    caller, atómico con el cambio auditado)."""
    ev = AuditEvent(
        entity=str(entity)[:20], entity_id=str(entity_id)[:40],
        action=str(action)[:30], field=str(field or "")[:40],
        old=fmt(old)[:200], new=fmt(new)[:200],
        actor=str(actor or "")[:80], created_at=datetime.now())
    session.add(ev)
    return ev


def event_dict(e: AuditEvent) -> dict:
    return {
        "id": e.id,
        "entity": e.entity,
        "entity_id": e.entity_id,
        "action": e.action,
        "field": e.field or "",
        "old": e.old or "",
        "new": e.new or "",
        "actor": e.actor or "",
        "created_at": org_config.org_iso(e.created_at),
    }


def query_events(session, filters: list[tuple[str, str, bool]],
                 limit: int = 100) -> list[dict]:
    """Eventos (recientes primero) que matcheen ALGUNO de los filtros
    (entity, entity_id, es_prefijo). es_prefijo=True matchea los entity_id
    que EMPIEZAN con ese texto (LIKE escapado)."""
    conds = []
    for entity, eid, prefix in filters:
        if prefix:
            conds.append((AuditEvent.entity == entity)
                         & AuditEvent.entity_id.startswith(
                             str(eid), autoescape=True))
        else:
            conds.append((AuditEvent.entity == entity)
                         & (AuditEvent.entity_id == str(eid)))
    if not conds:
        return []
    rows = session.scalars(
        select(AuditEvent).where(or_(*conds))
        .order_by(AuditEvent.id.desc()).limit(max(1, int(limit)))).all()
    return [event_dict(e) for e in rows]


def list_events(entity: str, entity_id, limit: int = 100) -> list[dict]:
    """Historia de UNA entidad (recientes primero)."""
    with SessionLocal() as session:
        return query_events(session, [(entity, str(entity_id), False)],
                            limit)
