"""Decodificador de VIN via NHTSA vPIC (gratis, sin API key).

Llena Year/Make/Model a partir del VIN en el alta de unidades. Requiere que el
server pueda salir a `vpic.nhtsa.dot.gov` (allowlistear el host en la politica
de red del entorno). Si falla la red, devuelve {ok: False, error}.
"""

from __future__ import annotations

import httpx

_URL = ("https://vpic.nhtsa.dot.gov/api/vehicles/"
        "DecodeVinValues/{vin}?format=json")
_TIMEOUT = 12


async def decode(vin: str) -> dict:
    vin = (vin or "").strip().upper()
    if len(vin) < 11:
        return {"ok": False, "error": "VIN incompleto"}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.get(_URL.format(vin=vin))
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"no se pudo consultar NHTSA: {exc}"}
    res = (data.get("Results") or [{}])[0]
    year = str(res.get("ModelYear") or "").strip()
    make = str(res.get("Make") or "").strip()
    model = str(res.get("Model") or "").strip()
    if not (year or make or model):
        msg = str(res.get("ErrorText") or "").strip() or "VIN no reconocido"
        return {"ok": False, "error": msg}
    return {"ok": True, "vin": vin, "year": year, "make": make,
            "model": model, "body": _body(res), "engine": _engine(res)}


def _body(res: dict) -> str:
    """Tipo de carroceria (p.ej. 'Truck-Tractor'), solo para mostrar."""
    return str(res.get("BodyClass") or "").strip()


def _engine(res: dict) -> str:
    """Resumen legible del motor: '12.8L · 6 cyl · Diesel' (solo display)."""
    disp = str(res.get("DisplacementL") or "").strip()
    cyl = str(res.get("EngineCylinders") or "").strip()
    fuel = str(res.get("FuelTypePrimary") or "").strip()
    parts: list[str] = []
    if disp:
        # Redondea a 1 decimal y agrega la "L" (vPIC da "12.8000000000").
        try:
            parts.append(f"{float(disp):.1f}L")
        except ValueError:
            parts.append(disp)
    if cyl:
        parts.append(f"{cyl} cyl")
    if fuel:
        parts.append(fuel)
    return " · ".join(parts)
