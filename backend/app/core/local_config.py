# -*- coding: utf-8 -*-
"""Configuracion local de Avisos (no versionada).

Lee `backend/avisos.local.json`, que contiene tanto los datos de Drive
(planilla + cuenta de servicio) como los de Gmail (remitente + App Password).
Si el archivo no existe, devuelve {} y la herramienta queda en modo offline +
simulado. Hay un ejemplo versionado en `backend/avisos.example.json`.
"""

from .. import config
from . import secretstore

CONFIG_PATH = config.BACKEND_DIR / "avisos.local.json"


def load() -> dict:
    # H6 fase 3d-2: credenciales de Drive/Gmail via SecretStore
    # (avisos.local.json). {} = modo offline + simulado.
    return secretstore.store().get_blob("avisos")
