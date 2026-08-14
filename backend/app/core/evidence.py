# -*- coding: utf-8 -*-
"""Evidencia fotográfica de defectos y Work Orders (v2.14 — elemento 01).

Hoy un defecto es una línea de texto: con foto, el mecánico sabe qué va a
encontrar antes de abrir el capó, y la WO cierra con prueba visual
(antes/después) que sirve para warranty y disputas con el shop externo.

Mismo patrón que unit_photos/unitdocs — archivo en
`backend/uploads/evidence/` (gitignored) y metadata en `evidence_photo` —
con DOS diferencias deliberadas:
  - VARIAS fotos por padre conviven (subir NO reemplaza): el driver saca
    2-3 tomas del mismo defecto y todas suman contexto;
  - el dueño es polimórfico (`parent` 'defect'|'wo' + `parent_id`), porque
    la misma galería vive en la fila de defecto y en el drawer de la WO.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime
from pathlib import Path

from sqlalchemy import func, select

from .. import config
from ..db import (
    Defect, EvidencePhoto, SessionLocal, Walkaround, WalkaroundStep,
    WorkOrder,
)

UPLOADS_DIR = config.BACKEND_DIR / "uploads" / "evidence"

# v2.16 suma 'walkstep': la foto que el driver saca DURANTE el walkaround
# cuelga del paso de la corrida; si el paso termina en defecto, el submit la
# re-parenta al defect creado (reparent), y si fue OK queda en el paso como
# prueba de que la inspección ocurrió de verdad.
PARENTS = ("defect", "wo", "walkstep")
# 'report' = la foto del driver al reportar; 'before'/'after' = el par con
# el que la WO documenta el trabajo (alimenta el comparador del drawer).
PHASES = ("report", "before", "after")

ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp"}
_MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg",
         ".png": "image/png", ".webp": "image/webp"}
MAX_BYTES = 12 * 1024 * 1024          # 12 MB: foto de teléfono moderna entra


def _safe_name(name: str) -> str:
    base = Path(name).name
    return re.sub(r"[^\w.\- ]", "_", base)[:120] or "photo.jpg"


def _photo_dict(p: EvidencePhoto) -> dict:
    return {
        "id": p.id, "parent": p.parent, "parent_id": p.parent_id,
        "phase": p.phase, "unit": p.unit, "filename": p.filename,
        "size": p.size, "note": p.note,
        "uploaded_at": p.uploaded_at.isoformat(),
    }


def parent_unit(parent: str, parent_id: int) -> str | None:
    """Unidad del padre ('defect'|'wo'), o None si no existe.

    Las rutas la usan como gate de 404 ANTES de guardar (un id inválido no
    debe dejar archivos huérfanos en disco) y para denormalizar la unidad
    en la foto (filtrar evidencia por unidad sin join)."""
    with SessionLocal() as session:
        if parent == "defect":
            row = session.get(Defect, parent_id)
            return None if row is None else row.unit
        if parent == "wo":
            wo = session.get(WorkOrder, parent_id)
            return None if wo is None else wo.unit
        if parent == "walkstep":
            st = session.get(WalkaroundStep, parent_id)
            if st is None:
                return None
            run = session.get(Walkaround, st.walkaround_id)
            return None if run is None else run.unit
    return None


def reparent(parent_from: str, id_from: int,
             parent_to: str, id_to: int, session=None) -> int:
    """Mueve TODAS las fotos de un padre a otro (solo metadata, el archivo
    no se toca). Lo usa el submit del walkaround: las fotos del paso con
    defecto pasan al defect creado — la evidencia sigue al objeto accionable
    (WO, warranty), no a la corrida. Devuelve cuántas movió.

    `session`: si el caller ya tiene una transacción abierta (el submit del
    walkaround) DEBE pasarla — abrir una segunda sesión de escritura acá
    deadlockea SQLite ("database is locked") porque la primera retiene el
    write-lock hasta su commit. Con session ajena NO se commitea: la
    transacción es del caller."""
    def _move(s) -> int:
        rows = s.scalars(
            select(EvidencePhoto)
            .where(EvidencePhoto.parent == parent_from,
                   EvidencePhoto.parent_id == id_from)).all()
        for p in rows:
            p.parent = parent_to
            p.parent_id = id_to
        return len(rows)

    if session is not None:
        return _move(session)
    with SessionLocal() as own:
        n = _move(own)
        own.commit()
        return n


def save_photo(parent: str, parent_id: int, filename: str, data: bytes,
               phase: str = "report", note: str = "",
               unit: str = "") -> dict:
    """Guarda UNA foto más del padre (las anteriores conviven, no reemplaza)."""
    if parent not in PARENTS:
        raise ValueError("parent must be one of: " + ", ".join(PARENTS))
    if phase not in PHASES:
        # Tolerante a propósito: una fase desconocida no tira la subida a la
        # basura (la foto vale más que el metadato); cae a 'report'.
        phase = "report"
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXT:
        raise ValueError("Unsupported type. Use JPG, PNG or WEBP.")
    if len(data) > MAX_BYTES:
        raise ValueError("Photo is too large (max 12 MB).")
    if not data:
        raise ValueError("Empty file.")
    safe = _safe_name(filename)
    rel = f"{uuid.uuid4().hex[:10]}_{safe}"
    target = UPLOADS_DIR / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    with SessionLocal() as session:
        photo = EvidencePhoto(
            parent=parent, parent_id=parent_id, phase=phase,
            unit=unit.strip()[:64], filename=safe, stored=rel,
            size=len(data), note=note.strip()[:200],
            uploaded_at=datetime.now())
        session.add(photo)
        session.commit()
        return _photo_dict(photo)


def list_photos(parent: str, parent_id: int) -> list[dict]:
    """Fotos del padre en orden cronológico (la historia se lee de vieja a
    nueva: reporte -> before -> after)."""
    with SessionLocal() as session:
        rows = session.scalars(
            select(EvidencePhoto)
            .where(EvidencePhoto.parent == parent,
                   EvidencePhoto.parent_id == parent_id)
            .order_by(EvidencePhoto.uploaded_at, EvidencePhoto.id)).all()
        return [_photo_dict(p) for p in rows]


def photo_path(photo_id: int) -> tuple[Path, str] | None:
    """(ruta absoluta, mime) de la foto, o None si no existe (fila o archivo)."""
    with SessionLocal() as session:
        p = session.get(EvidencePhoto, photo_id)
        if p is None:
            return None
        path = UPLOADS_DIR / p.stored
        if not path.is_file():
            return None
        return path, _MIME.get(path.suffix.lower(), "image/jpeg")


def delete_photo(photo_id: int) -> bool:
    with SessionLocal() as session:
        p = session.get(EvidencePhoto, photo_id)
        if p is None:
            return False
        path = UPLOADS_DIR / p.stored
        session.delete(p)
        session.commit()
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass                            # metadata fuera; archivo huérfano ok
    return True


def counts(parent: str, ids: list[int]) -> dict[int, int]:
    """Conteo bulk id -> nº de fotos, para los chips de la lista de defectos:
    UNA query con GROUP BY en vez de una por fila visible (N+1). Los ids sin
    fotos vuelven en 0 para que el front no distinga 'sin fotos' de
    'no consultado'."""
    out: dict[int, int] = {int(i): 0 for i in ids}
    if not out:
        return out
    with SessionLocal() as session:
        rows = session.execute(
            select(EvidencePhoto.parent_id, func.count(EvidencePhoto.id))
            .where(EvidencePhoto.parent == parent,
                   EvidencePhoto.parent_id.in_(list(out)))
            .group_by(EvidencePhoto.parent_id)).all()
    for pid, n in rows:
        out[int(pid)] = int(n)
    return out
