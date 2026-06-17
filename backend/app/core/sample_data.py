# -*- coding: utf-8 -*-
"""Snapshot offline del DVIR Report (respaldo de la pantalla de Avisos).

Se usa cuando todavia no hay credenciales de Google configuradas. Cuando se
configure el Service Account, `datasource` lee la planilla en vivo y este
snapshot deja de usarse.

Data DEMO generica (empresa "SUMMIT FREIGHT", conductores/unidades ficticios):
arma un par de bloques diarios con algunos infractores (NO DVIR, pre-trip corto
y NO PRE-TRIP) para que Avisos se vea poblado en modo demo. NO hay datos reales.

Estructura de cada hoja de empresa (filas):
    Company, Driver, Trk#, DVIR, Trl#, DVIR Trl, Pre-trip, Distance (mi)
La columna Company va VACIA en las filas de datos (el parser reserva esa
columna para los codigos CHASER/MCC; vacia = fila de datos normal). El nombre
de la hoja ("SUMMIT 6") es el que se muestra como empresa en la UI.
"""

from . import demo_eld

M = ""  # celda vacia

HEADER = ["Company", "Driver", "Trk#", "DVIR", "Trl#", "DVIR Trl",
          "Pre-trip", "Distance (mi)"]

# Una hoja de empresa demo con dos bloques diarios (6.16 y 6.15).
SHEETS: dict[str, list[list]] = {
    "SUMMIT 6": [
        HEADER,
        ["6.16", M, M, M, M, M, M, M],
        [M, "James Carter", "412", "Safe", "53108", "Safe", "22m 10s", "318"],
        [M, "Miguel Santos", "418", "Safe", "53112", "Safe", "11m 05s", "274"],
        [M, "Robert Lee", "305", "⚠ NO DVIR", M, M, M, "41"],
        [M, "David Nguyen", "311", "Safe", "7841", "Safe", "18m 40s", "402"],
        [M, "Carlos Mendez", "207", "Safe", M, M, "NO PRE-TRIP", "356"],
        [M, "Daniel Reyes", "421", "Safe", "7846", "Safe", "26m 00s", "289"],
        ["6.15", M, M, M, M, M, M, M],
        [M, "Kevin Walsh", "308", "Safe", M, M, "9m 30s", "210"],
        [M, "Anthony Brooks", "214", "⚠ NO DVIR", M, M, M, "33"],
        [M, "Victor Ramos", "503", "Safe", "4402", "Safe", "21m 15s", "377"],
    ],
}

# Truck# con prefijo de terminal GENERICO (ciudad) por conductor: hace que la
# region del aviso salga como Atlanta/Chicago/Miami (no "CHASER") y que el
# CC demo aplique -> los infractores salen como avisos listos, no a "revisar".
_TRUCK_BY_DRIVER = {
    "James Carter": "ATL-412", "Miguel Santos": "ATL-418",
    "Daniel Reyes": "ATL-421", "Victor Ramos": "ATL-503",
    "Robert Lee": "MDW-305", "David Nguyen": "MDW-311",
    "Kevin Walsh": "MDW-308", "Carlos Mendez": "MIA-207",
    "Anthony Brooks": "MIA-214", "Marcus Hill": "ATL-233",
}

# Hoja `Driver info`: contactos demo (mismos nombres que los bloques de arriba).
DRIVER_INFO = [["#", "DRIVER NAME", "PHONE", "EMAIL", "COMPANY", "Truck#"]] + [
    [str(i + 1), name, phone, email, "SUMMIT FREIGHT",
     _TRUCK_BY_DRIVER.get(name, "")]
    for i, (name, phone, email, _lic, _st) in enumerate(
        demo_eld.driver_contacts())
]
