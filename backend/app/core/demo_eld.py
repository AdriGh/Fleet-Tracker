"""ELD sintetico para modo demo (sin Samsara real).

Genera flota + DVIRs + distancia + pre-trip + defectos + PM + odometros +
conductores + posiciones de mapa, con la MISMA forma que devuelve core.samsara
y core.tracking, para que Fleet, Defects, PM, Roster, el Live Map, los reportes
y los trackers anden SIN credenciales. Ideal para portfolio/demo.

Se activa con FLEET_DEMO=1 o, automaticamente, cuando no hay Samsara
configurada (asi, al borrar samsara.local.json, la app cae sola en demo).

Toda la data de aca es GENERICA E INVENTADA (empresa "SUMMIT FREIGHT",
unidades/numeros y conductores ficticios). NO hay ningun dato real de ninguna
empresa. Si editas, manten esa regla.
"""

from __future__ import annotations

import datetime
import random

from .contacts import name_key

# Empresa unica del demo (generica). Se usa en flota, defectos, roster, mapa.
_COMPANY = "SUMMIT FREIGHT"

# Flota demo. (unidad, empresa, marca, modelo, anio).
_TRUCKS: list[tuple[str, str, str, str, str]] = [
    ("412", _COMPANY, "Peterbilt", "579", "2021"),
    ("418", _COMPANY, "Freightliner", "Cascadia", "2022"),
    ("421", _COMPANY, "Freightliner", "Cascadia", "2021"),
    ("305", _COMPANY, "Freightliner", "Cascadia", "2022"),
    ("308", _COMPANY, "International", "LT", "2020"),
    ("311", _COMPANY, "Kenworth", "T680", "2021"),
    ("207", _COMPANY, "Freightliner", "Cascadia", "2021"),
    ("214", _COMPANY, "International", "LT", "2020"),
    ("503", _COMPANY, "Volvo", "VNL 760", "2022"),
    ("517", _COMPANY, "Freightliner", "Cascadia", "2023"),
]
_TRAILERS: list[str] = ["53108", "53112", "7841", "7846", "4402", "4410"]
_DRIVERS: list[str] = [
    "James Carter", "Miguel Santos", "Daniel Reyes", "Robert Lee",
    "David Nguyen", "Kevin Walsh", "Carlos Mendez", "Anthony Brooks",
    "Marcus Hill", "Victor Ramos",
]

# Contactos del roster demo: (nombre, telefono, email, lic#, estado).
_CONTACTS: list[tuple[str, str, str, str, str]] = [
    ("James Carter", "(214) 555-0142", "jcarter@summitfreight.com", "TX1840221", "TX"),
    ("Miguel Santos", "(214) 555-0188", "msantos@summitfreight.com", "TX1922488", "TX"),
    ("Daniel Reyes", "(214) 555-0211", "dreyes@summitfreight.com", "TX2014507", "TX"),
    ("Robert Lee", "(312) 555-0305", "rlee@summitfreight.com", "IL9330512", "IL"),
    ("David Nguyen", "(312) 555-0311", "dnguyen@summitfreight.com", "IL9418803", "IL"),
    ("Kevin Walsh", "(312) 555-0308", "kwalsh@summitfreight.com", "IL9551240", "IL"),
    ("Carlos Mendez", "(404) 555-0207", "cmendez@summitfreight.com", "GA5501277", "GA"),
    ("Anthony Brooks", "(404) 555-0214", "abrooks@summitfreight.com", "GA5612048", "GA"),
    ("Marcus Hill", "(404) 555-0233", "mhill@summitfreight.com", "GA5709331", "GA"),
    ("Victor Ramos", "(214) 555-0260", "vramos@summitfreight.com", "TX2199014", "TX"),
]

# Odometro actual por camion (millas). Coherente con _PM para dar una buena
# distribucion de estados PM (on_track / upcoming / overdue / never).
_ODO: dict[str, int] = {
    "412": 431050, "418": 388900, "421": 502100, "305": 521900,
    "308": 612300, "311": 298400, "207": 412500, "214": 305800,
    "503": 188300, "517": 96400,
}

# Ultimo PM por camion: (fecha M/D/YYYY, millas). None = nunca (Never Performed).
_PM: dict[str, tuple[str, int] | None] = {
    "412": ("3/2/2026", 418200),    # on_track  (faltan ~7,150 mi)
    "418": ("4/10/2026", 376000),   # on_track
    "421": ("3/20/2026", 489000),   # on_track
    "305": ("4/18/2026", 502400),   # upcoming  (faltan ~500 mi)
    "308": ("4/1/2026", 595000),    # upcoming
    "311": ("5/5/2026", 280000),    # upcoming
    "207": ("1/10/2026", 388000),   # overdue
    "214": ("12/15/2025", 280200),  # overdue
    "503": None,                    # never
    "517": None,                    # never
}

# Defectos demo: (dias_atras, estado, unidad, kind, categoria, comentario, reportes).
# estado: "open" (abierto) | "resolved" (resuelto). El detalle se arma como
# "Categoria - comentario" (el front parsea la categoria del prefijo).
_DEFECTS: list[tuple[int, str, str, str, str, str, int]] = [
    (1, "open", "207", "truck", "Engine", "Coolant leak at water pump", 2),
    (2, "open", "305", "truck", "Brakes", "Right rear brake chamber leaking air", 3),
    (3, "open", "305", "truck", "Lights", "Marker light out, driver side", 1),
    (4, "open", "412", "truck", "Tires", "LFO low tread 4/32", 1),
    (5, "open", "418", "truck", "Suspension", "Air leak at front airbag", 1),
    (2, "open", "53108", "trailer", "Tires", "LRO low tread 3/32", 1),
    (6, "open", "53112", "trailer", "Coupling", "Kingpin play excessive", 1),
    (8, "open", "7841", "trailer", "Doors", "Rear door seal torn", 1),
    (9, "open", "311", "truck", "Electrical", "Trailer plug corroded", 1),
    (10, "open", "308", "truck", "Engine", "DEF system fault code SPN 3216", 2),
    (12, "open", "214", "truck", "Brakes", "Slack adjuster out of range", 1),
    (3, "open", "421", "truck", "Lights", "Headlight low beam out", 1),
    (7, "resolved", "412", "truck", "Lights", "Marker light out, driver side", 1),
    (14, "resolved", "503", "truck", "Wipers", "Wiper blade torn", 1),
    (18, "resolved", "207", "truck", "Tires", "RFI slow leak", 1),
    (22, "resolved", "305", "truck", "Brakes", "Air dryer purge valve worn", 1),
    (28, "resolved", "7846", "trailer", "Lights", "Tail light out", 1),
    (35, "resolved", "517", "truck", "Engine", "Oil leak at filter housing", 1),
    (44, "resolved", "418", "truck", "Suspension", "Shock absorber worn", 1),
    (60, "resolved", "308", "truck", "Brakes", "Brake light switch faulty", 1),
    (75, "resolved", "53112", "trailer", "Tires", "LLO low tread", 1),
]

# Posiciones del Live Map: (unidad, lat, lng, mph, duty, motor, lugar, fuel, def).
_MAP: list[tuple[str, float, float, float, str, str, str, int, int]] = [
    ("412", 32.7767, -96.7970, 0.0, "offDuty", "Off", "Dallas, TX", 78, 64),
    ("418", 38.6270, -90.1994, 63.0, "driving", "On", "St. Louis, MO", 54, 71),
    ("421", 36.1627, -86.7816, 58.0, "driving", "On", "Nashville, TN", 61, 49),
    ("305", 33.7490, -84.3880, 0.0, "sleeperBed", "Off", "Atlanta, GA", 88, 80),
    ("308", 41.8781, -87.6298, 0.0, "onDuty", "Idle", "Chicago, IL", 42, 33),
    ("311", 39.0997, -94.5786, 67.0, "driving", "On", "Kansas City, MO", 70, 58),
    ("207", 29.7604, -95.3698, 0.0, "offDuty", "Off", "Houston, TX", 35, 90),
    ("214", 34.7465, -92.2896, 55.0, "driving", "On", "Little Rock, AR", 49, 22),
    ("503", 39.7684, -86.1581, 0.0, "yardMove", "On", "Indianapolis, IN", 81, 67),
    ("517", 35.4676, -97.5164, 0.0, "onDuty", "Idle", "Oklahoma City, OK", 66, 75),
]

_DUTY_KEYS = ("driving", "onDuty", "sleeperBed", "offDuty",
              "yardMove", "personalConveyance")


def _rng(day: datetime.date, salt: str = "") -> random.Random:
    return random.Random(f"fleet-demo-{salt}-{day.isoformat()}")


def _trucks_for(company: str | None):
    cu = (company or "").strip().upper()
    return [t for t in _TRUCKS if not cu or t[1] == cu]


def _model_of(unit: str) -> str:
    for u, _c, mk, md, yr in _TRUCKS:
        if u == unit:
            return " ".join(x for x in (yr, mk, md) if x)
    return ""


def _open_counts() -> dict[str, int]:
    out: dict[str, int] = {}
    for _d, st, unit, *_ in _DEFECTS:
        if st == "open":
            out[unit] = out.get(unit, 0) + 1
    return out


def fleet() -> list[dict]:
    """Flota sintetica con la forma de samsara.list_fleet()."""
    oc = _open_counts()
    today = datetime.date.today().isoformat()
    out: list[dict] = []
    for i, (unit, company, make, model, year) in enumerate(_TRUCKS):
        out.append({
            "id": f"demo-{unit}", "unit": unit, "kind": "truck",
            "unit_type": "truck", "asset_type": "vehicle", "company": company,
            "make": make, "model": model, "year": year,
            "vin": f"1DEMO{i:05d}{unit}", "plate": f"DMO{1000 + i}",
            "open_defects": oc.get(unit, 0), "last_dvir": today,
            "dvir_known": True, "auto_eligible": True,
        })
    for i, trl in enumerate(_TRAILERS):
        out.append({
            "id": f"demo-trl-{trl}", "unit": trl, "kind": "trailer",
            "unit_type": "trailer", "asset_type": "trailer",
            "company": _COMPANY, "make": "Wabash", "model": "DuraPlate",
            "year": "2019", "vin": f"1WABDEMO{i:06d}", "plate": "",
            "open_defects": oc.get(trl, 0), "last_dvir": None,
            "dvir_known": False, "auto_eligible": False,
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


# ----- Defectos (Defects board + dashboard) --------------------------------

def _defect_row(days_ago: int, status: str, unit: str, kind: str,
                category: str, comment: str, reports: int) -> dict:
    day = datetime.date.today() - datetime.timedelta(days=days_ago)
    if status == "open":
        api_status = "Open"
    else:
        api_status = "Resolved"
    return {
        "date_label": f"{day.month}.{day.day}",
        "block_date": day.isoformat(),
        "company": _COMPANY,
        "driver": "",
        "unit": unit,
        "unit_kind": kind,
        "asset_id": f"demo-{unit}",
        "dvir_type": "",
        "status": api_status,
        "detail": f"{category} - {comment}",
        "reports": reports,
        "mechanic": "",
        "mechanic_notes": "",
    }


def open_defects() -> list[dict]:
    """Defectos ABIERTOS (forma de samsara.load()), status 'Open'."""
    out = [_defect_row(*d) for d in _DEFECTS if d[1] == "open"]
    out.sort(key=lambda d: d["unit"])
    return out


def defect_window(days: int) -> list[dict]:
    """Defectos abiertos + resueltos creados en la ventana (samsara.load_window).
    Abierto -> 'Unsafe', resuelto -> 'Resolved' (lo que espera el dashboard)."""
    cutoff = max(1, days)
    out: list[dict] = []
    for d in _DEFECTS:
        if d[0] > cutoff:
            continue
        row = _defect_row(*d)
        row["status"] = "Unsafe" if d[1] == "open" else "Resolved"
        out.append(row)
    out.sort(key=lambda r: (r["block_date"], r["unit"]))
    return out


# ----- PM / odometros (PM board) -------------------------------------------

def odometers() -> dict[str, dict]:
    """{unidad -> {miles, source}} con el odometro actual (forma de
    samsara.vehicle_odometers())."""
    return {unit: {"miles": mi, "source": "obd"} for unit, mi in _ODO.items()}


def pm_rows() -> list[dict]:
    """Filas con la forma de pm.load() (ultimo PM por unidad) para el PM board."""
    out: list[dict] = []
    for unit, _c, mk, md, _y in _TRUCKS:
        pm = _PM.get(unit)
        last_date, last_miles = (pm if pm else (None, None))
        pm_type = "ISX" if "international" in mk.lower() else "DD"
        out.append({
            "unit": unit,
            "model": f"{mk} {md}",
            "pm_type": pm_type,
            "last_pm_date": last_date,
            "last_pm_miles": last_miles,
            "report_miles": _ODO.get(unit),
        })
    out.sort(key=lambda r: r["unit"])
    return out


# ----- Live Map (tracking.load_live) ---------------------------------------

def map_payload() -> dict:
    """Snapshot del mapa con la forma de tracking.load_live()."""
    now = datetime.datetime.now(datetime.timezone.utc)
    gps_time = now.isoformat()
    driver_by_unit = {u: _DRIVERS[i % len(_DRIVERS)]
                      for i, (u, *_rest) in enumerate(_TRUCKS)}
    vehicles: list[dict] = []
    counts = dict.fromkeys(_DUTY_KEYS, 0)
    moving = 0
    for unit, lat, lng, mph, duty, engine, loc, fuel, deff in _MAP:
        if duty in counts:
            counts[duty] += 1
        is_moving = mph > 1.0
        if is_moving:
            moving += 1
        vehicles.append({
            "id": f"demo-{unit}",
            "unit": unit,
            "company": _COMPANY,
            "lat": lat,
            "lng": lng,
            "heading": 90,
            "speed_mph": round(mph, 1),
            "stale": False,
            "location": loc,
            "gps_time": gps_time,
            "engine": engine,
            "fuel_pct": fuel,
            "def_pct": float(deff),
            "odometer_mi": _ODO.get(unit),
            "driver": driver_by_unit.get(unit, ""),
            "duty": duty,
            "moving_for_s": (1800 if is_moving else None),
            "idle_for_s": (600 if engine == "Idle" else None),
        })
    vehicles.sort(key=lambda x: (-(x["speed_mph"] or 0), x["unit"]))
    return {
        "available": True,
        "missing_scopes": [],
        "error": "",
        "hos_available": True,
        "generated_at": gps_time,
        "vehicles": vehicles,
        "summary": {
            "drivers": len(_MAP),
            "vehicles": len(vehicles),
            "moving": moving,
            "unknown": 0,
            **counts,
        },
    }


# ----- Roster (samsara.list_drivers) ---------------------------------------

def drivers() -> list[dict]:
    """Conductores demo con la forma de samsara.list_drivers()."""
    out: list[dict] = []
    for i, (name, phone, _email, lic, st) in enumerate(_CONTACTS):
        out.append({
            "id": f"demo-drv-{i}",
            "name": name,
            "company": _COMPANY,
            "phone": phone,
            "username": name.lower().replace(" ", "."),
            "license_number": lic,
            "license_state": st,
        })
    out.sort(key=lambda d: (d["company"], d["name"]))
    return out


def driver_contacts() -> list[tuple[str, str, str, str, str]]:
    """Tuplas (nombre, telefono, email, lic#, estado) — para el snapshot de
    Avisos / sample_data."""
    return list(_CONTACTS)
