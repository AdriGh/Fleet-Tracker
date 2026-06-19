# -*- coding: utf-8 -*-
"""Factura original (shop invoice) adjunta por work order (review v1.17).

El usuario quiere adjuntar al perfil de la WO el documento ORIGINAL de la
factura del taller (p.ej. la invoice de Speedco en PDF que dio origen a la
orden) y poder VERLO y DESCARGARLO desde el drawer, como SquareRigger.

Almacenamiento basado en archivos, indexado por id de work order — SIN
columna nueva en la base de datos. Espeja las convenciones de
`core/unitdocs.py` (carpeta hermana `backend/uploads/wo_invoices/`,
gitignored: puede contener PII; límite de tamaño y extensiones permitidas).

UN solo archivo por WO; re-subir reemplaza. El nombre original se preserva
en un sidecar JSON junto al binario para que la descarga conserve el nombre
real (no hay columna en la DB donde guardarlo).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from .. import config

# Carpeta hermana de uploads/units/ (mismo patrón que unitdocs).
UPLOADS_DIR = config.BACKEND_DIR / "uploads" / "wo_invoices"

ALLOWED_EXT = {".pdf", ".jpg", ".jpeg", ".png", ".webp", ".heic"}
MAX_BYTES = 25 * 1024 * 1024          # 25 MB (igual que unitdocs)


def _safe_name(name: str) -> str:
    base = Path(name).name
    return re.sub(r"[^\w.\- ]", "_", base)[:120] or "invoice"


def _bin_path(wo_id: int) -> Path:
    """Ruta del binario de la factura de la WO (un solo archivo por WO)."""
    return UPLOADS_DIR / f"{wo_id}.bin"


def _meta_path(wo_id: int) -> Path:
    """Sidecar JSON con el nombre original y el content-type."""
    return UPLOADS_DIR / f"{wo_id}.json"


def has_file(wo_id: int) -> bool:
    return _bin_path(wo_id).is_file()


def file_name(wo_id: int) -> str | None:
    """Nombre original del archivo, o None si no hay factura adjunta."""
    if not has_file(wo_id):
        return None
    try:
        meta = json.loads(_meta_path(wo_id).read_text(encoding="utf-8"))
        return meta.get("filename") or None
    except (OSError, ValueError):
        return None


def save_file(wo_id: int, filename: str, data: bytes) -> dict:
    """Guarda (o reemplaza) la factura original de la WO. Lanza ValueError
    si el tipo no es soportado o el archivo es demasiado grande."""
    ext = Path(filename or "").suffix.lower()
    if ext not in ALLOWED_EXT:
        raise ValueError(
            f"'{Path(filename or 'file').name}': unsupported type. "
            "Use a PDF or image (JPG, PNG, WEBP, HEIC).")
    if len(data) > MAX_BYTES:
        raise ValueError(
            f"'{Path(filename or 'file').name}' is too large (max 25 MB).")
    safe = _safe_name(filename)
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    _bin_path(wo_id).write_bytes(data)
    _meta_path(wo_id).write_text(
        json.dumps({"filename": safe, "ext": ext}), encoding="utf-8")
    return {"has_invoice_file": True, "invoice_file_name": safe}


def file_path(wo_id: int) -> tuple[Path, str] | None:
    """(ruta absoluta, nombre original) o None si no hay factura."""
    p = _bin_path(wo_id)
    if not p.is_file():
        return None
    return p, (file_name(wo_id) or f"invoice-{wo_id}")


def delete_file(wo_id: int) -> bool:
    """Elimina el binario y su sidecar. True si había algo que borrar."""
    p = _bin_path(wo_id)
    existed = p.is_file()
    for f in (p, _meta_path(wo_id)):
        try:
            f.unlink(missing_ok=True)
        except OSError:
            pass
    return existed
