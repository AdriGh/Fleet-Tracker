"""Plantillas de mensajes para Notices (per-tenant).

Mensajes reutilizables (nombre + asunto + cuerpo) que se pueden crear, editar,
borrar y mandar como broadcast a los conductores. Persisten por organizacion
en org_setting (clave 'notice_templates', via la capa de config de H6 fase 3d).

Soportan variables que se sustituyen por destinatario al enviar:
  {first_name} -> primer nombre del conductor
  {name}       -> nombre completo
"""

from __future__ import annotations

import uuid

from .. import db

KEY = "notice_templates"

# Plantilla sembrada la primera vez: los 2 videos (DVIR + Pre-trip). El usuario
# pega sus links de Vimeo editandola.
_SEED: list[dict] = [{
    "id": "tutorials-dvir-pretrip",
    "name": "Tutoriales: DVIR y Pre-trip",
    "subject": "How to do your DVIR & Pre-trip inspection",
    "body": (
        "Hi {first_name},\n\n"
        "Two short videos on how to complete your daily inspections:\n\n"
        "DVIR: [PEGAR LINK DE VIMEO]\n"
        "Pre-trip: [PEGAR LINK DE VIMEO]\n\n"
        "Please watch both before your next shift. Thanks!\n\n"
        "- Rigsmith"
    ),
}]


def list_templates() -> list[dict]:
    data = db.get_setting(KEY)
    if data is None:                  # primera vez: sembrar
        db.save_setting(KEY, _SEED)
        return [dict(t) for t in _SEED]
    return data if isinstance(data, list) else []


def upsert(tpl: dict) -> dict:
    items = list_templates()
    tid = str(tpl.get("id") or "").strip() or uuid.uuid4().hex[:12]
    clean = {
        "id": tid,
        "name": str(tpl.get("name") or "").strip()[:80] or "Untitled",
        "subject": str(tpl.get("subject") or "").strip()[:140],
        "body": str(tpl.get("body") or "").strip()[:4000],
    }
    for i, it in enumerate(items):
        if it.get("id") == tid:
            items[i] = clean
            break
    else:
        items.append(clean)
    db.save_setting(KEY, items)
    return clean


def delete(tid: str) -> bool:
    items = list_templates()
    rest = [it for it in items if it.get("id") != tid]
    if len(rest) == len(items):
        return False
    db.save_setting(KEY, rest)
    return True


def render(text: str, name: str) -> str:
    """Sustituye las variables de un texto para un destinatario."""
    full = (name or "").strip()
    first = full.split()[0] if full else ""
    return (text or "").replace("{first_name}", first).replace("{name}", full)
