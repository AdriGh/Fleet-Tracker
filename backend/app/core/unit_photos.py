# -*- coding: utf-8 -*-
"""Foto de identidad por unidad (v2.13 — elemento 05 del board de diseño).

UNA foto por unidad: el hero del perfil y la tarjeta del Fleet. "Un dueño no
piensa 'unit 412', piensa 'la Cascadia blanca'". El archivo vive en
`backend/uploads/unit_photos/` (gitignored, mismo patrón que unitdocs) y la
metadata en la tabla `unit_photo`. Subir de nuevo REEMPLAZA la anterior.

Modo demo (flota sintética): las unidades sin foto subida caen a un asset de
muestra (`app/assets/demo_unit_photos/`, ver ATTRIBUTION.md) para que la demo
muestre el feature sin configurar nada. Una foto real siempre gana al asset.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime
from pathlib import Path

from sqlalchemy import select

from .. import config
from ..db import SessionLocal, UnitPhoto
from . import samsara

UPLOADS_DIR = config.BACKEND_DIR / "uploads" / "unit_photos"
ASSETS_DIR = Path(__file__).resolve().parents[1] / "assets" / "demo_unit_photos"

# Unidad demo -> asset. Solo unidades cuya foto de muestra coincide de verdad
# con el make/model de la flota demo (418 Cascadia, 311 Kenworth, 53108 reefer);
# el resto queda sin foto a propósito: el estado mixto invita a subir la real.
_DEMO_PHOTOS = {"418": "cascadia.jpg", "311": "kenworth.jpg",
                "53108": "reefer.jpg"}

ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp"}
_MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg",
         ".png": "image/png", ".webp": "image/webp"}
MAX_BYTES = 12 * 1024 * 1024          # 12 MB: foto de teléfono moderna entra


def _safe_name(name: str) -> str:
    base = Path(name).name
    return re.sub(r"[^\w.\- ]", "_", base)[:120] or "photo.jpg"


def _photo_dict(p: UnitPhoto, source: str = "uploaded") -> dict:
    return {
        "unit": p.unit, "filename": p.filename, "size": p.size,
        "uploaded_at": p.uploaded_at.isoformat(), "source": source,
    }


def save_photo(unit: str, filename: str, data: bytes) -> dict:
    """Guarda (o reemplaza) LA foto de la unidad."""
    unit = unit.strip()
    if not unit:
        raise ValueError("unit is required")
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
    old_file: Path | None = None
    with SessionLocal() as session:
        prev = session.scalars(
            select(UnitPhoto).where(UnitPhoto.unit == unit)).first()
        if prev is not None:
            old_file = UPLOADS_DIR / prev.stored
            session.delete(prev)
            session.flush()
        photo = UnitPhoto(unit=unit[:64], filename=safe, stored=rel,
                          size=len(data), uploaded_at=datetime.now())
        session.add(photo)
        session.commit()
        result = _photo_dict(photo)
    if old_file is not None:
        try:
            old_file.unlink(missing_ok=True)
        except OSError:
            pass                        # metadata fuera; archivo huérfano ok
    return result


def photo_path(unit: str) -> tuple[Path, str] | None:
    """(ruta absoluta, mime) de la foto de la unidad, o None.

    Prioridad: foto subida > asset demo (solo si la flota es demo)."""
    with SessionLocal() as session:
        p = session.scalars(
            select(UnitPhoto).where(UnitPhoto.unit == unit)).first()
        if p is not None:
            path = UPLOADS_DIR / p.stored
            if path.is_file():
                mime = _MIME.get(path.suffix.lower(), "image/jpeg")
                return path, mime
    if samsara._demo():
        name = _DEMO_PHOTOS.get(unit)
        if name:
            path = ASSETS_DIR / name
            if path.is_file():
                return path, _MIME.get(path.suffix.lower(), "image/jpeg")
    return None


def delete_photo(unit: str) -> bool:
    """Borra la foto SUBIDA (el fallback demo no se puede borrar: no es data
    del tenant, reaparece porque la unidad vuelve a no tener foto)."""
    with SessionLocal() as session:
        p = session.scalars(
            select(UnitPhoto).where(UnitPhoto.unit == unit)).first()
        if p is None:
            return False
        path = UPLOADS_DIR / p.stored
        session.delete(p)
        session.commit()
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass
    return True


def units_with_photo() -> list[str]:
    """Unidades que tienen foto para mostrar (subida o fallback demo).

    El Fleet la usa para pedir SOLO las fotos que existen — sin esto, cada
    tarjeta sin foto sería un GET 404 de ida y vuelta."""
    with SessionLocal() as session:
        units = {p.unit for p in session.scalars(select(UnitPhoto)).all()
                 if (UPLOADS_DIR / p.stored).is_file()}
    if samsara._demo():
        for unit, name in _DEMO_PHOTOS.items():
            if unit not in units and (ASSETS_DIR / name).is_file():
                units.add(unit)
    return sorted(units)
