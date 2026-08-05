"""ELD sintetico para modo demo (sin Samsara real).

Genera flota + DVIRs + distancia + pre-trip + defectos + PM + odometros +
conductores + posiciones de mapa, con la MISMA forma que devuelve core.samsara
y core.tracking, para que Fleet, Defects, PM, Roster, el Live Map, los reportes
y los trackers anden SIN credenciales. Ideal para portfolio/demo.

Se activa con FLEET_DEMO=1 o, automaticamente, cuando no hay Samsara
configurada (asi, al borrar samsara.local.json, la app cae sola en demo).

DISENO: es un SIMULADOR, no una foto. Todo lo que en la realidad cambia con el
tiempo aca es funcion del RELOJ, de forma DETERMINISTICA (misma fecha/hora =>
mismo valor, reproducible entre procesos y en los tests):

  - El odometro ACUMULA: odometer_at(unidad, dia) = base_en_epoch + suma de las
    millas de cada dia. La MISMA funcion `_day_miles` alimenta el odometro y
    `day_distance()`, asi el "millaje del dia" y el odometro nunca se
    contradicen. Esto es lo que hace que el cost-per-mile (que necesita
    odo_fin - odo_inicio) funcione en demo: antes el odometro era una constante
    y todos los deltas daban 0.
  - El PM es RELATIVO a hoy (dias_atras, millas_atras), no fechas absolutas.
    Asi la distribucion de estados (on_track / upcoming / overdue / never) se
    mantiene correcta para siempre, en vez de podrirse conforme pasa el tiempo
    real y el odometro crece. Calibrado contra el intervalo por defecto de
    20,000 mi (org_config "pm_interval_miles").
  - El mapa SE MUEVE: cada camion en ruta interpola su posicion a lo largo de
    un tramo (ida y vuelta), con rumbo, velocidad y combustible variables, y
    con `moving_for_s` / `idle_for_s` que de verdad crecen — asi las reglas de
    alerta por duracion se pueden ver cruzando su umbral. Una unidad queda
    deliberadamente STALE (GPS viejo) para ejercitar ese camino.

Toda la data de aca es GENERICA E INVENTADA (empresa "SUMMIT FREIGHT",
unidades/numeros y conductores ficticios). NO hay ningun dato real de ninguna
empresa. Si editas, manten esa regla.
"""

from __future__ import annotations

import datetime
import math
import random

from .contacts import name_key

# Empresa unica del demo (generica). Se usa en flota, defectos, roster, mapa.
_COMPANY = "SUMMIT FREIGHT"

# Dia 0 del simulador: desde aca se acumulan las millas sobre `_ODO_BASE`.
# Mover esta fecha hacia atras da mas historial de odometro (y mas curva de
# CPM); hacia adelante, menos.
_EPOCH = datetime.date(2026, 1, 1)

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
# Trailers: (unidad, subtipo). El subtipo 'reefer' marca los de cadena de frio
# y es la FUENTE UNICA de que unidades tiene el Cold Chain (ver reefer_units).
_TRAILERS: list[tuple[str, str]] = [
    ("53108", "reefer"), ("53112", "reefer"), ("7841", "reefer"),
    ("7846", "reefer"), ("4402", "flatbed"), ("4410", "dry_van"),
]
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

# Odometro EN EL EPOCH (millas). El odometro de hoy se calcula acumulando las
# millas diarias sobre estas bases (ver odometer_at).
_ODO_BASE: dict[str, int] = {
    "412": 431050, "418": 388900, "421": 502100, "305": 521900,
    "308": 612300, "311": 298400, "207": 412500, "214": 305800,
    "503": 188300, "517": 96400,
}

# Perfil de uso por camion: (millas promedio en dia laboral, variacion +/-).
# Da una flota MIXTA: long-haul, regional y local. Es lo que hace interesante al
# CPM por unidad y a la matriz costo-vs-uso (una unidad caraa que ademas rueda
# poco es candidata a retiro).
_MILES_PROFILE: dict[str, tuple[int, int]] = {
    "412": (470, 80),   # long-haul
    "418": (505, 70),   # long-haul
    "421": (455, 85),   # long-haul
    "305": (330, 70),   # regional
    "308": (300, 65),   # regional
    "311": (345, 75),   # regional
    "207": (150, 50),   # local / city
    "214": (135, 45),   # local / city (poca milla, buen caso de retiro)
    "503": (420, 90),   # long-haul
    "517": (390, 80),   # regional-plus
}

# Ultimo PM por camion, RELATIVO a hoy: (dias_atras, millas_atras).
# None = nunca (Never Performed). Calibrado contra el intervalo de 20,000 mi:
# restante = 20000 - millas_atras  =>  >5500 on_track, 0..5500 upcoming, <0 overdue.
_PM_REL: dict[str, tuple[int, int] | None] = {
    "412": (128, 12850),   # on_track  (faltan ~7,150 mi)
    "418": (89, 12900),    # on_track
    "421": (110, 13100),   # on_track
    "305": (81, 19500),    # upcoming  (faltan ~500 mi)
    "308": (98, 17300),    # upcoming
    "311": (64, 18400),    # upcoming
    "207": (179, 24500),   # overdue
    "214": (205, 25600),   # overdue
    "503": None,           # never
    "517": None,           # never
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

# Rutas del Live Map. Los que estan "driving" van interpolando entre `a` y `b`
# (ida y vuelta); los parados se quedan en `a`. `mph` es la velocidad de
# crucero base. `cycle_h` = horas de una pierna (ida). `stale=True` simula GPS
# perdido (el front lo marca como dato dudoso).
_ROUTES: list[dict] = [
    {"unit": "412", "a": (32.7767, -96.7970), "b": (32.7767, -96.7970),
     "place": "Dallas, TX", "mph": 0.0, "duty": "offDuty", "engine": "Off",
     "fuel": 78, "def": 64, "cycle_h": 6},
    {"unit": "418", "a": (38.6270, -90.1994), "b": (39.7684, -86.1581),
     "place": "St. Louis, MO", "place_b": "Indianapolis, IN", "mph": 63.0,
     "duty": "driving", "engine": "On", "fuel": 54, "def": 71, "cycle_h": 4},
    {"unit": "421", "a": (36.1627, -86.7816), "b": (33.7490, -84.3880),
     "place": "Nashville, TN", "place_b": "Atlanta, GA", "mph": 58.0,
     "duty": "driving", "engine": "On", "fuel": 61, "def": 49, "cycle_h": 4},
    {"unit": "305", "a": (33.7490, -84.3880), "b": (33.7490, -84.3880),
     "place": "Atlanta, GA", "mph": 0.0, "duty": "sleeperBed", "engine": "Off",
     "fuel": 88, "def": 80, "cycle_h": 6},
    {"unit": "308", "a": (41.8781, -87.6298), "b": (41.8781, -87.6298),
     "place": "Chicago, IL", "mph": 0.0, "duty": "onDuty", "engine": "Idle",
     "fuel": 42, "def": 33, "cycle_h": 6},
    {"unit": "311", "a": (39.0997, -94.5786), "b": (41.2565, -95.9345),
     "place": "Kansas City, MO", "place_b": "Omaha, NE", "mph": 67.0,
     "duty": "driving", "engine": "On", "fuel": 70, "def": 58, "cycle_h": 3},
    {"unit": "207", "a": (29.7604, -95.3698), "b": (29.7604, -95.3698),
     "place": "Houston, TX", "mph": 0.0, "duty": "offDuty", "engine": "Off",
     "fuel": 35, "def": 90, "cycle_h": 6},
    {"unit": "214", "a": (34.7465, -92.2896), "b": (35.1495, -90.0490),
     "place": "Little Rock, AR", "place_b": "Memphis, TN", "mph": 55.0,
     "duty": "driving", "engine": "On", "fuel": 49, "def": 22, "cycle_h": 3},
    {"unit": "503", "a": (39.7684, -86.1581), "b": (39.7684, -86.1581),
     "place": "Indianapolis, IN", "mph": 0.0, "duty": "yardMove",
     "engine": "On", "fuel": 81, "def": 67, "cycle_h": 6},
    # GPS perdido: ejercita el camino "stale" del front y de las alertas.
    {"unit": "517", "a": (35.4676, -97.5164), "b": (35.4676, -97.5164),
     "place": "Oklahoma City, OK", "mph": 0.0, "duty": "onDuty",
     "engine": "Idle", "fuel": 66, "def": 75, "cycle_h": 6, "stale": True},
]

_DUTY_KEYS = ("driving", "onDuty", "sleeperBed", "offDuty",
              "yardMove", "personalConveyance")


def _rng(day: datetime.date, salt: str = "") -> random.Random:
    return random.Random(f"fleet-demo-{salt}-{day.isoformat()}")


def _trucks_for(company: str | None):
    """Camiones del demo, filtrados por empresa.

    En el demo hay UNA sola flota sintetica, asi que si se filtra por una
    empresa que no es la suya se devuelve igual la flota completa en vez de
    una lista vacia. Antes, filtrar por cualquier otro nombre daba CERO
    camiones y el import de ELD mostraba "0 DVIR / 0 distancia / 0 pre-trip"
    sin explicar por que — que es exactamente lo que pasaba con las empresas
    de ejemplo del selector."""
    cu = (company or "").strip().upper()
    if not cu:
        return list(_TRUCKS)
    exact = [t for t in _TRUCKS if t[1] == cu]
    return exact or list(_TRUCKS)


def _open_counts() -> dict[str, int]:
    out: dict[str, int] = {}
    for _d, st, unit, *_ in _DEFECTS:
        if st == "open":
            out[unit] = out.get(unit, 0) + 1
    return out


# ----- Millas y odometro (el corazon del simulador) ------------------------

def _day_miles(unit: str, day: datetime.date) -> float:
    """Millas que ESA unidad rodo ESE dia. Deterministico por (unidad, dia) y
    consciente del dia de semana (domingo casi parado, sabado media jornada).

    Es la UNICA fuente de millaje: alimenta tanto `day_distance()` como la
    acumulacion del odometro, asi los dos nunca se contradicen."""
    avg, spread = _MILES_PROFILE.get(unit, (300, 70))
    r = random.Random(f"fleet-demo-miles-{unit}-{day.isoformat()}")
    wd = day.weekday()                       # 0=lunes ... 6=domingo
    if wd == 6:
        factor = r.uniform(0.0, 0.25)        # domingo: casi sin rodar
    elif wd == 5:
        factor = r.uniform(0.30, 0.80)       # sabado: media jornada
    else:
        factor = r.uniform(0.75, 1.20)
    return round(max(0.0, avg * factor + r.uniform(-spread, spread)), 1)


# Cache del odometro acumulado: (unidad, dia ISO) -> millas. El acumulado es un
# prefix-sum sobre `_day_miles`, asi que se calcula una vez por dia y se reusa
# (el mapa puede pedirlo muchas veces por minuto).
_odo_cache: dict[tuple[str, str], int] = {}


def odometer_at(unit: str, day: datetime.date) -> int:
    """Odometro de la unidad al FINAL de `day` (base del epoch + acumulado).
    Devuelve 0 si la unidad no es del demo. Antes del epoch = la base."""
    base = _ODO_BASE.get(unit)
    if base is None:
        return 0
    if day < _EPOCH:
        return base
    key = (unit, day.isoformat())
    hit = _odo_cache.get(key)
    if hit is not None:
        return hit
    # Un solo recorrido cachea TODOS los dias del camino, no solo el pedido:
    # asi sembrar 90 dias de historial es lineal y no cuadratico.
    total = float(base)
    d = _EPOCH
    step = datetime.timedelta(days=1)
    while d <= day:
        total += _day_miles(unit, d)
        _odo_cache[(unit, d.isoformat())] = int(round(total))
        d += step
    return _odo_cache[key]


def odometers() -> dict[str, dict]:
    """{unidad -> {miles, source}} con el odometro de HOY (forma de
    samsara.vehicle_odometers()). Crece dia a dia."""
    today = datetime.date.today()
    return {unit: {"miles": odometer_at(unit, today), "source": "obd"}
            for unit in _ODO_BASE}


def units() -> list[str]:
    """Unidades (camiones) del demo — para sembradores/tests."""
    return [u for u, *_r in _TRUCKS]


def company() -> str:
    """Empresa (carrier) a la que pertenece la flota demo.

    La expone `GET /api/companies` cuando el tenant no tiene ninguna cargada:
    sin eso el selector solo ofrece "(todas)" y el boton de importar —que EXIGE
    una empresa— queda inhabilitado para siempre."""
    return _COMPANY


def reefer_units() -> list[str]:
    """Trailers CON equipo de frio (subtipo 'reefer').

    Es la fuente UNICA de que unidades tiene el Cold Chain: `core/reefer.py`
    lee de aca en vez de tener su propia lista. Antes cada uno tenia numeros
    distintos (el Cold Chain hablaba de 53218/R1904, que no existian en la
    flota), asi que la tarjeta de reefer del perfil de unidad no aparecia nunca
    y el feature quedaba como una isla."""
    return [u for u, sub in _TRAILERS if sub == "reefer"]


def day_distance(company: str | None, day: datetime.date) -> dict[str, float]:
    """Millas por unidad en `day`. MISMA fuente que el odometro."""
    return {unit: _day_miles(unit, day) for unit, *_r in _trucks_for(company)}


# ----- Flota ---------------------------------------------------------------

def fleet() -> list[dict]:
    """Flota sintetica con la forma de samsara.list_fleet()."""
    oc = _open_counts()
    today = datetime.date.today()
    rng = _rng(today, "fleet")
    out: list[dict] = []
    for i, (unit, company, make, model, year) in enumerate(_TRUCKS):
        # El ultimo DVIR varia (hoy .. 6 dias) en vez de ser siempre hoy.
        last = today - datetime.timedelta(days=rng.choice([0, 0, 0, 1, 1, 2, 4, 6]))
        out.append({
            "id": f"demo-{unit}", "unit": unit, "kind": "truck",
            "unit_type": "truck", "asset_type": "vehicle", "company": company,
            "make": make, "model": model, "year": year, "subtype": "",
            "vin": f"1DEMO{i:05d}{unit}", "plate": f"DMO{1000 + i}",
            "plate_state": "TX", "source": "demo",
            "open_defects": oc.get(unit, 0), "last_dvir": last.isoformat(),
            "dvir_known": True, "auto_eligible": True,
        })
    for i, (trl, subtype) in enumerate(_TRAILERS):
        out.append({
            "id": f"demo-trl-{trl}", "unit": trl, "kind": "trailer",
            "unit_type": "trailer", "asset_type": "trailer",
            "company": _COMPANY, "make": "Wabash", "model": "DuraPlate",
            "year": "2019", "subtype": subtype,
            "vin": f"1WABDEMO{i:06d}", "plate": "", "plate_state": "TX",
            "source": "demo",
            "open_defects": oc.get(trl, 0), "last_dvir": None,
            "dvir_known": False, "auto_eligible": False,
        })
    return out


# ----- DVIR / pre-trip -----------------------------------------------------

def _driver_assignment(company: str | None,
                       day: datetime.date) -> dict[str, str]:
    """{unidad -> conductor} de ese dia. La usan `dvir_rows` Y `pretrip`, asi
    el conductor que firmo el DVIR es el mismo que registro el pre-trip (antes
    cada uno sorteaba por su lado y solo coincidian por casualidad)."""
    rng = _rng(day, "assign")
    drivers = list(_DRIVERS)
    rng.shuffle(drivers)
    return {unit: drivers[i % len(drivers)]
            for i, (unit, *_r) in enumerate(_trucks_for(company))}


def dvir_rows(company: str | None, day: datetime.date) -> list[dict]:
    """Filas de DVIR del dia (forma del dvir_df del engine)."""
    rng = _rng(day, "dvir")
    assign = _driver_assignment(company, day)
    trailer_ids = [t for t, _sub in _TRAILERS]
    rows: list[dict] = []
    for unit, _c, _mk, _md, _y in _trucks_for(company):
        if rng.random() < 0.15:        # 15% sin DVIR -> apareceran como NO DVIR
            continue
        driver = assign.get(unit, _DRIVERS[0])
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
                "Vehicle Name": "", "Trailer": rng.choice(trailer_ids),
                "Author": driver,
                "Signed At": f"{day.isoformat()}T12:05:00Z",
                "Status": "Safe", "Type": typ, "Mechanic Notes": "",
                "Vehicle Defect Details": "", "Trailer Defect Details": "",
            })
    return rows


def pretrip(company: str | None, day: datetime.date) -> dict[str, dict]:
    """{name_key(conductor) -> {pre, post}} en segundos (None = no registrado).

    Respeta `company` (antes lo ignoraba) y emite POST-trip real, ademas de
    algunos pre-trips deliberadamente CORTOS: asi se pueden ver los estados
    'NO PRE-TRIP', 'NO POST-TRIP' y pre-trip demasiado breve."""
    assign = _driver_assignment(company, day)
    rng = _rng(day, "pre")
    out: dict[str, dict] = {}
    for unit in sorted(assign):
        driver = assign[unit]
        if rng.random() < 0.12:               # no registro pre-trip
            continue
        if rng.random() < 0.18:               # pre-trip demasiado corto
            pre = rng.randint(2, 4) * 60
        else:
            pre = rng.randint(9, 26) * 60
        post = None if rng.random() < 0.25 else rng.randint(6, 18) * 60
        out[name_key(driver)] = {"pre": pre, "post": post}
    return out


# ----- Defectos (Defects board + dashboard) --------------------------------

def _defect_row(days_ago: int, status: str, unit: str, kind: str,
                category: str, comment: str, reports: int) -> dict:
    day = datetime.date.today() - datetime.timedelta(days=days_ago)
    if status == "open":
        api_status = "Open"
    else:
        api_status = "Resolved"
    # El asset_id tiene que coincidir con el de fleet() (los trailers llevan
    # prefijo 'demo-trl-'), si no el filtro de archivados no los reconoce.
    asset_id = f"demo-trl-{unit}" if kind == "trailer" else f"demo-{unit}"
    return {
        "date_label": f"{day.month}.{day.day}",
        "block_date": day.isoformat(),
        "company": _COMPANY,
        "driver": "",
        "unit": unit,
        "unit_kind": kind,
        "asset_id": asset_id,
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


# ----- PM (PM board) -------------------------------------------------------

def pm_rows() -> list[dict]:
    """Filas con la forma de pm.load() (ultimo PM por unidad) para el PM board.

    El ultimo PM se deriva de `_PM_REL` RELATIVO a hoy y al odometro actual, no
    de fechas/millas absolutas: asi los estados no se podren con el tiempo."""
    today = datetime.date.today()
    out: list[dict] = []
    for unit, _c, mk, md, _y in _TRUCKS:
        rel = _PM_REL.get(unit)
        if rel:
            days_ago, miles_ago = rel
            d = today - datetime.timedelta(days=days_ago)
            last_date = f"{d.month}/{d.day}/{d.year}"
            last_miles = max(0, odometer_at(unit, today) - miles_ago)
        else:
            last_date, last_miles = None, None
        pm_type = "ISX" if "international" in mk.lower() else "DD"
        out.append({
            "unit": unit,
            "model": f"{mk} {md}",
            "pm_type": pm_type,
            "last_pm_date": last_date,
            "last_pm_miles": last_miles,
            "report_miles": odometer_at(unit, today),
        })
    out.sort(key=lambda r: r["unit"])
    return out


# ----- Live Map (tracking.load_live) ---------------------------------------

def _bearing(a: tuple[float, float], b: tuple[float, float]) -> int:
    """Rumbo aproximado a->b en grados (0=N, 90=E)."""
    dlat = b[0] - a[0]
    dlng = b[1] - a[1]
    if abs(dlat) < 1e-9 and abs(dlng) < 1e-9:
        return 0
    deg = math.degrees(math.atan2(dlng, dlat))
    return int(round(deg % 360))


def _unit_offset(unit: str) -> float:
    """Desfase estable por unidad, para que no se muevan todos sincronizados."""
    return (sum(ord(c) for c in unit) % 97) / 97.0


def map_payload() -> dict:
    """Snapshot del mapa con la forma de tracking.load_live().

    Las posiciones INTERPOLAN a lo largo de su tramo (ida y vuelta), asi que el
    mapa se mueve entre refrescos; `moving_for_s` / `idle_for_s` crecen de
    verdad y una unidad va con GPS viejo (stale)."""
    now = datetime.datetime.now(datetime.timezone.utc)
    gps_time = now.isoformat()
    ts = now.timestamp()
    driver_by_unit = {u: _DRIVERS[i % len(_DRIVERS)]
                      for i, (u, *_rest) in enumerate(_TRUCKS)}
    today = datetime.date.today()
    vehicles: list[dict] = []
    counts = dict.fromkeys(_DUTY_KEYS, 0)
    moving = 0
    for r in _ROUTES:
        unit = r["unit"]
        a, b = r["a"], r["b"]
        duty, engine = r["duty"], r["engine"]
        base_mph = float(r["mph"])
        off = _unit_offset(unit)
        leg_s = float(r.get("cycle_h", 4)) * 3600.0
        cycle_s = leg_s * 2.0                      # ida + vuelta
        # Fase 0..1 dentro del ciclo, desfasada por unidad.
        x = ((ts + off * cycle_s) % cycle_s) / cycle_s
        outbound = x < 0.5
        leg_pos = (x * 2.0) if outbound else ((1.0 - x) * 2.0)   # 0..1
        lat = a[0] + (b[0] - a[0]) * leg_pos
        lng = a[1] + (b[1] - a[1]) * leg_pos
        # Velocidad: crucero con variacion suave (nunca congelada).
        if base_mph > 1.0:
            mph = max(0.0, base_mph * (0.88 + 0.18 * math.sin(ts / 540.0 + off * 6.3)))
        else:
            mph = 0.0
        is_moving = mph > 1.0
        if is_moving:
            moving += 1
        heading = _bearing(a, b) if outbound else _bearing(b, a)
        # Duraciones REALES: crecen y se reinician con el ciclo/umbral.
        moving_for_s = int((x % 0.5) * cycle_s) if is_moving else None
        idle_for_s = (int((ts + off * 5400.0) % 5400.0)
                      if engine == "Idle" else None)
        # Combustible/DEF bajan con el avance del tramo (y se "recargan" al
        # volver), asi los umbrales de low_fuel/low_def se ven moverse.
        fuel = int(max(4, min(100, r["fuel"] - leg_pos * (22 if is_moving else 3))))
        deff = float(max(2, min(100, r["def"] - leg_pos * (9 if is_moving else 1))))
        stale = bool(r.get("stale"))
        if stale:
            # GPS viejo: no se reportan duraciones (igual que el camino real).
            moving_for_s = None
            idle_for_s = None
            v_gps = (now - datetime.timedelta(minutes=41)).isoformat()
        else:
            v_gps = gps_time
        if duty in counts:
            counts[duty] += 1
        vehicles.append({
            "id": f"demo-{unit}",
            "unit": unit,
            "company": _COMPANY,
            "lat": round(lat, 5),
            "lng": round(lng, 5),
            "heading": heading,
            "speed_mph": round(mph, 1),
            "stale": stale,
            "location": (r.get("place_b") if (is_moving and leg_pos > 0.55)
                         else r["place"]),
            "gps_time": v_gps,
            "engine": engine,
            "fuel_pct": fuel,
            "def_pct": round(deff, 1),
            "odometer_mi": odometer_at(unit, today),
            "driver": driver_by_unit.get(unit, ""),
            "duty": duty,
            "moving_for_s": moving_for_s,
            "idle_for_s": idle_for_s,
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
            "drivers": len(_ROUTES),
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
    for i, (name, phone, email, lic, st) in enumerate(_CONTACTS):
        out.append({
            "id": f"demo-drv-{i}",
            "name": name,
            "company": _COMPANY,
            "phone": phone,
            "email": email,
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
