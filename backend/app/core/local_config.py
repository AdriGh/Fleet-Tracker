# -*- coding: utf-8 -*-
"""Configuracion local de Avisos (no versionada).

Lee `backend/avisos.local.json`, que contiene tanto los datos de Drive
(planilla + cuenta de servicio) como los de Gmail (remitente + App Password).
Si el archivo no existe, devuelve {} y la herramienta queda en modo offline +
simulado. Hay un ejemplo versionado en `backend/avisos.example.json`.
"""

import json
from pathlib import Path

from .. import config

CONFIG_PATH = config.BACKEND_DIR / "avisos.local.json"


def load() -> dict:
    path = Path(CONFIG_PATH)
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return {}
    return {}
