# -*- coding: utf-8 -*-
"""Enmascarado de PII (v2.22): un solo lugar para el formato "•••".

Mismo formato que ya usaban las rutas de conductores (routes._mask_email /
_mask_phone, que ahora delegan acá): customers, contactos, empleados, la
búsqueda global y cualquier salida que muestre contacto de una persona sin
el scope `pii.view`.

`is_masked(v)` detecta un valor que el cliente devolvió TAL CUAL lo recibió
enmascarado: los PATCH lo ignoran (no se pisa el dato real con "j•••@x.com"
cuando un usuario sin pii.view guarda un formulario completo).
"""

from __future__ import annotations

import re

MASK = "•••"


def mask_email(e: str) -> str:
    e = (e or "").strip()
    if "@" not in e:
        return MASK if e else ""
    name, dom = e.split("@", 1)
    return (name[:1] + MASK) + "@" + dom


def mask_phone(p: str) -> str:
    digits = re.sub(r"\D", "", p or "")
    return (MASK + "-" + digits[-4:]) if len(digits) >= 4 else (
        MASK if p else "")


def mask_text(s: str) -> str:
    """Texto libre sensible (dirección): todo oculto si hay algo."""
    return MASK if (s or "").strip() else ""


def is_masked(v) -> bool:
    return isinstance(v, str) and MASK in v
