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

# Region -> lista de correos en copia (CC).
#
# INTENCIONALMENTE VACIO: no se versiona ningun correo real en el repo. El CC
# se configura por org desde Settings (org_config `cc` / `always_cc`), que
# REEMPLAZA este default. Sin esa config, no se agrega ningun CC.
REGION_CC: dict[str, list[str]] = {}

# Correos que van SIEMPRE en copia. Vacio por defecto (se define por org).
_ALWAYS_CC: list[str] = []

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
    """Lista de CC para una region (vacia si la region es None/desconocida).

    Fusiona el CC propio de la region con la lista "always", sin duplicar
    y conservando el orden. Para region desconocida devuelve vacio (el
    conductor cae en "revisar", no se envia).

    Fase G7: si org.local.json define `cc`/`always_cc`, esos mapas
    REEMPLAZAN a los hardcodeados (que quedan como default de fábrica).
    """
    from . import org_config
    cc_map, always = org_config.cc_override()
    region_cc = cc_map if cc_map else REGION_CC
    always_cc = always if always else _ALWAYS_CC
    if not region or region not in region_cc:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for email in list(region_cc[region]) + list(always_cc):
        key = email.lower()
        if key not in seen:
            seen.add(key)
            out.append(email)
    return out
