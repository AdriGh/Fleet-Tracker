"""Ruteo de copiados (CC) por region/terminal.

La region de cada conductor se deduce del prefijo de su numero de camion
(`Truck#`) en la hoja `Driver info`:

    MDW-CF1849 -> MDW    (Chicago)
    MEM-RMF1826 -> MEM   (Memphis)
    ATL-CI2034 -> ATL    (Atlanta)
    SAV-CI1924 -> SAV    (Savannah)
    MIA-OOF07001 -> MIA  (Miami)
    CF2248 / CI2037 -> CHASER  (sin prefijo)

Cada region define a quien se copia (CC) en el aviso de NO DVIR.
"""

import re

# Region -> lista de correos en copia (CC). Definido por el usuario.
REGION_CC: dict[str, list[str]] = {
    "CHASER": [
        "neskar@chaserllc.com",
        "Jfarach@chaserllc.com",
        "chasersales@chaserllc.com",
    ],
    "MDW": [  # Chicago
        "neskar@chaserllc.com",
        "randrews@memphiscitycartage.com",
        "Jfarach@chaserllc.com",
    ],
    "MEM": [  # Memphis
        "neskar@chaserllc.com",
        "Jfarach@chaserllc.com",
        "mccidispatch@memphiscitycartage.com",
        "amccammon@memphiscitycartage.com",
    ],
    "ATL": [  # Atlanta
        "neskar@chaserllc.com",
        "Jfarach@chaserllc.com",
        "vross@memphiscitycartage.com",
    ],
    "SAV": [  # Savannah
        "neskar@chaserllc.com",
        "Jfarach@chaserllc.com",
        "vross@memphiscitycartage.com",
    ],
    "MIA": [  # Miami
        "neskar@chaserllc.com",
        "Jfarach@chaserllc.com",
        "vross@memphiscitycartage.com",
    ],
}

# Prefijos de region reconocidos (los de MCC). CHASER no lleva prefijo.
_MCC_REGIONS = {"MDW", "MEM", "ATL", "SAV", "MIA"}


def region_from_truck(truck) -> str | None:
    """Deduce la region a partir del `Truck#`.

    Devuelve la clave de region (MDW/MEM/ATL/SAV/MIA/CHASER) o None si el
    prefijo no se reconoce (para que el conductor caiga en "revisar").
    """
    s = str(truck or "").strip().upper()
    if not s:
        return None
    # Prefijo de 2-4 letras seguido de '-' o espacio: "MDW-CF1849", "ATL- CI2034".
    m = re.match(r"^([A-Z]{2,4})[\s-]", s)
    if m:
        prefix = m.group(1)
        if prefix in _MCC_REGIONS:
            return prefix
        if prefix == "CHASER":
            return "CHASER"
        return None  # prefijo desconocido -> revisar
    # Sin separador (CF2248, CI2037): unidad de CHASER.
    return "CHASER"


def cc_for_region(region) -> list[str]:
    """Lista de CC para una region (vacia si la region es None/desconocida)."""
    return list(REGION_CC.get(region or "", []))
