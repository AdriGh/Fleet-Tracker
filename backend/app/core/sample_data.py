# -*- coding: utf-8 -*-
"""Snapshot offline del DVIR Report (respaldo de la pantalla de Avisos).

Se usa cuando todavia no hay credenciales de Google configuradas. Cuando se
configure el Service Account, `datasource` lee la planilla en vivo y este
snapshot deja de usarse.

INTENCIONALMENTE VACIO: no se versiona ninguna flota/roster real en el repo.
La pantalla de Avisos arranca sin filas; los datos llegan de la planilla en
vivo (modo "live") o de lo que cargues vos. Si queres un snapshot de demo,
agregá filas GENERICAS aca (empresas tipo "DEMO CO", unidades "TRK-001",
nombres inventados) respetando la estructura de abajo.

Estructura de cada hoja de empresa (filas):
    Company, Driver, Trk#, DVIR, Trl#, DVIR Trl, Pre-trip, Distance (mi)
"""

M = ""  # celda vacia

HEADER = ["Company", "Driver", "Trk#", "DVIR", "Trl#", "DVIR Trl",
          "Pre-trip", "Distance (mi)"]

# Sin hojas de empresa cargadas de fabrica.
SHEETS: dict[str, list[list]] = {}

# Hoja `Driver info`: solo encabezados (sin roster real en el repo).
DRIVER_INFO = [["#", "DRIVER NAME", "PHONE", "EMAIL", "COMPANY"]]
