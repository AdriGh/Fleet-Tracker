"""ELD sintetico para modo demo (sin Samsara real).

Genera flota + DVIRs + distancia + pre-trip de forma DETERMINISTICA por dia,
con la MISMA forma que devuelve core.samsara, para que Fleet, el import del ELD,
los reportes y los trackers anden sin credenciales. Ideal para portfolio/demo.

Se activa con FLEET_DEMO=1 o, automaticamente, cuando no hay Samsara
configurada (asi, al borrar samsara.local.json, la app cae sola en demo).
Misma fecha -> misma data (seed por dia), asi el demo es repetible.
"""

from __future__ import annotations

import datetime
import random

from .contacts import name_key

# Semilla de flota para el demo. (unidad, empresa, marca, modelo, anio).
#
# INTENCIONALMENTE VACIA: la app NO trae ninguna flota cargada de fabrica.
# Fleet, PM, DOT y los reportes arrancan en cero, y vos armas tu propia flota
# de demo (datos genericos/inventados) desde el boton "Add New Unit".
#
# Si en algun momento queres poblar el demo automaticamente, agregá unidades
# GENERICAS aca (nada de numeros/nombres reales de ninguna empresa), p.ej.:
#   ("TRK-001", "DEMO CO", "Freightliner", "Cascadia", "2022"),
# y empresas tipo "DEMO CO" / "DEMO LOGISTICS" para que el filtro por empresa
# siga funcionando.
_TRUCKS: list[tuple[str, str, str, str, str]] = []
_TRAILERS: list[str] = []
_DRIVERS: list[str] = []


def _rng(day: datetime.date, salt: str = "") -> random.Random:
    return random.Random(f"fleet-demo-{salt}-{day.isoformat()}")


def _trucks_for(company: str | None):
    cu = (company or "").strip().upper()
    return [t for t in _TRUCKS if not cu or t[1] == cu]


def fleet() -> list[dict]:
    """Flota sintetica con la forma de samsara.list_fleet()."""
    out: list[dict] = []
    for i, (unit, company, make, model, year) in enumerate(_TRUCKS):
        out.append({
            "id": f"demo-{unit}", "unit": unit, "kind": "truck",
            "unit_type": "truck", "asset_type": "vehicle", "company": company,
            "make": make, "model": model, "year": year,
            "vin": f"1DEMO{i:05d}{unit}", "plate": f"DMO{1000 + i}",
            "open_defects": 0, "last_dvir": None, "dvir_known": True,
            "auto_eligible": True,
        })
    for i, trl in enumerate(_TRAILERS):
        out.append({
            "id": f"demo-trl-{trl}", "unit": trl, "kind": "trailer",
            "unit_type": "trailer", "asset_type": "trailer",
            "company": "CHASER", "make": "Wabash", "model": "DuraPlate",
            "year": "2019", "vin": f"1WABDEMO{i:06d}", "plate": "",
            "open_defects": 0, "last_dvir": None, "dvir_known": False,
            "auto_eligible": False,
        })
    return out


def dvir_rows(company: str | None, day: datetime.date) -> list[dict]:
    """Filas de DVIR del dia (forma del dvir_df del engine)."""
    rng = _rng(day, "dvir")
    drivers = list(_DRIVERS)
    rng.shuffle(drivers)
    rows: list[dict] = []
    for idx, (unit, _c, _mk, _md, _y) in enumerate(_trucks_for(company)):
        if rng.random() < 0.15:        # 15% sin DVIR -> apareceran como NO DVIR
            continue
        driver = drivers[idx % len(drivers)]
        status = "Unsafe" if rng.random() < 0.12 else "Safe"
        typ = "preTrip" if rng.random() < 0.7 else "postTrip"
        rows.append({
            "Vehicle Name": unit, "Trailer": "", "Author": driver,
            "Signed At": f"{day.isoformat()}T12:00:00Z", "Status": status,
            "Type": typ, "Mechanic Notes": "",
            "Vehicle Defect Details": "" if status == "Safe" else "brake light out",
            "Trailer Defect Details": "",
        })
        if rng.random() < 0.4:         # a veces tambien inspecciona un trailer
            rows.append({
                "Vehicle Name": "", "Trailer": rng.choice(_TRAILERS),
                "Author": driver,
                "Signed At": f"{day.isoformat()}T12:05:00Z",
                "Status": "Safe", "Type": typ, "Mechanic Notes": "",
                "Vehicle Defect Details": "", "Trailer Defect Details": "",
            })
    return rows


def day_distance(company: str | None, day: datetime.date) -> dict[str, float]:
    rng = _rng(day, "dist")
    return {unit: round(rng.uniform(20, 540), 1)
            for unit, *_ in _trucks_for(company)}


def pretrip(company: str | None, day: datetime.date) -> dict[str, dict]:
    rng = _rng(day, "pre")
    out: dict[str, dict] = {}
    for d in _DRIVERS:
        if rng.random() < 0.55:        # ~mitad registro el pre-trip
            out[name_key(d)] = {"pre": rng.randint(8, 30) * 60, "post": None}
    return out
