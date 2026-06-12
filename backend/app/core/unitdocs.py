# -*- coding: utf-8 -*-
"""Documentos por unidad (fase H3 — pestaña Attachments del perfil).

Copias del PM, del DOT inspection, CAB cards, registrations y otros.
Acepta VARIOS archivos por subida. Los archivos viven en
`backend/uploads/units/<unit>/` (gitignored: pueden contener PII) y la
metadata en la tabla `unit_doc`.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime
from pathlib import Path

from sqlalchemy import select

from .. import config
from ..db import SessionLocal, UnitDoc

UPLOADS_DIR = config.BACKEND_DIR / "uploads" / "units"

KINDS = ("pm_copy", "dot_copy", "cab_card", "registration", "other")
KIND_LABEL = {
    "pm_copy": "PM copy",
    "dot_copy": "DOT inspection",
    "cab_card": "CAB card",
    "registration": "Registration",
    "other": "Other",
}
ALLOWED_EXT = {".pdf", ".jpg", ".jpeg", ".png", ".webp", ".heic"}
MAX_BYTES = 25 * 1024 * 1024          # 25 MB por archivo


def _doc_dict(d: UnitDoc) -> dict:
    return {
        "id": d.id,
        "unit": d.unit,
        "kind": d.kind,
        "kind_label": KIND_LABEL.get(d.kind, d.kind),
        "filename": d.filename,
        "size": d.size,
        "note": d.note,
        "uploaded_at": d.uploaded_at.isoformat(),
    }


def _safe_name(name: str) -> str:
    base = Path(name).name
    return re.sub(r"[^\w.\- ]", "_", base)[:120] or "document"


def list_docs(unit: str) -> list[dict]:
    with SessionLocal() as session:
        rows = session.scalars(
            select(UnitDoc).where(UnitDoc.unit == unit)
            .order_by(UnitDoc.uploaded_at.desc())).all()
        return [_doc_dict(d) for d in rows]


def save_doc(unit: str, kind: str, filename: str, data: bytes,
             note: str = "") -> dict:
    unit = unit.strip()
    if not unit:
        raise ValueError("unit is required")
    if kind not in KINDS:
        kind = "other"
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXT:
        raise ValueError(
            f"'{Path(filename).name}': unsupported type. "
            "Use PDF, JPG, PNG, WEBP or HEIC.")
    if len(data) > MAX_BYTES:
        raise ValueError(
            f"'{Path(filename).name}' is too large (max 25 MB).")
    safe = _safe_name(filename)
    rel = f"{unit}/{uuid.uuid4().hex[:10]}_{safe}"
    target = UPLOADS_DIR / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    with SessionLocal() as session:
        doc = UnitDoc(unit=unit[:64], kind=kind, filename=safe,
                      stored=rel, size=len(data),
                      note=note.strip()[:200],
                      uploaded_at=datetime.now())
        session.add(doc)
        session.commit()
        return _doc_dict(doc)


def doc_path(doc_id: int) -> tuple[Path, str] | None:
    """(ruta absoluta, filename original) o None si no existe."""
    with SessionLocal() as session:
        d = session.get(UnitDoc, doc_id)
        if d is None:
            return None
        p = UPLOADS_DIR / d.stored
        return (p, d.filename) if p.is_file() else None


def delete_doc(doc_id: int) -> bool:
    with SessionLocal() as session:
        d = session.get(UnitDoc, doc_id)
        if d is None:
            return False
        p = UPLOADS_DIR / d.stored
        session.delete(d)
        session.commit()
    try:
        p.unlink(missing_ok=True)
    except OSError:
        pass                            # metadata fuera; archivo huérfano ok
    return True
