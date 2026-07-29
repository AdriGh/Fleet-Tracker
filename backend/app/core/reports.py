# -*- coding: utf-8 -*-
"""Reports & Analytics (Increment A): agregacion del GASTO de mantenimiento.

Suma las lineas de las work orders (parts + labor) para que el dueno del
taller responda "cuanto gaste en llantas / frenos / labor este mes/trimestre".

Alcance de los datos:
- Cuenta el GASTO COMPROMETIDO de cualquier orden NO-borrador que tenga
  lineas facturables (open/assigned/in_progress/completed/invoiced). En la
  practica el jefe carga el invoice del taller apenas llega y la orden queda
  "open"; si solo contaramos completed/invoiced ese gasto ya real no
  aparecia en Reports hasta cerrar la orden a mano. Una orden sin lineas con
  monto > 0 NO cuenta (no infla el conteo de WOs ni el promedio).
- La fecha del gasto es el "service date" efectivo de la orden:
  service_date (lo que cargo el jefe) -> closed_at (sello de completed) ->
  created_at. Asi el gasto cae en el periodo en que se hizo el servicio.
- El monto de una linea es qty * unit_cost (costo interno, sin markup; misma
  convencion que workorders._line_dict).

Aislamiento por tenant: las queries van por SessionLocal, asi que el filtro
por org_id lo aplica solo la capa ORM (db.py, with_loader_criteria) desde el
ContextVar del request. No hace falta pasar org_id a mano.

Salida pensada para charts: arrays de {label, value, ...} listos para el
frontend (sin formateo, montos redondeados a 2 decimales).
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import select

from ..db import Part, SessionLocal, WorkOrder
from . import odometer, terminals

# Estados que NO cuentan como gasto: el unico "borrador" del pipeline seria
# una orden vacia. No hay status "draft" real (el pipeline arranca en "open"),
# asi que el corte efectivo es "tener al menos una linea facturable": cualquier
# orden no-borrador con lineas suma gasto comprometido, este o no facturada.
_EXCLUDED_STATUSES: tuple[str, ...] = ()


# ---------------------------------------------------------------------------
# Clasificador de categorias
# ---------------------------------------------------------------------------
# Deriva una categoria de cada linea a partir de palabras clave en el
# part_number/description. Reglas en ORDEN: la primera categoria cuya lista de
# keywords matchee gana, asi que las mas especificas (frenos, motor) van antes
# que las genericas. `kind == "labor"` corta antes que cualquier regla de
# parte: toda linea de labor es "Labor", sin importar su texto.
#
# Cada entrada: (clave_categoria, etiqueta_visible, [keywords...]). Las
# keywords se matchean en minusculas como substring sobre
# "<part_number> <description>". Son intencionalmente amplias (el catalogo del
# jefe es texto libre); ajustar la lista es la forma de afinar el reporte.
CATEGORY_RULES: list[tuple[str, str, list[str]]] = [
    ("tires", "Tires", [
        "tire", "tyre", "tread", "retread", "recap", "wheel", "rim",
        "valve stem", "tpms", "11r", "295/", "lt2",
    ]),
    ("brakes", "Brakes", [
        "brake", "brk", "pad", "rotor", "drum", "caliper", "slack adjust",
        "air chamber", "abs", "shoe", "s-cam", "scam",
    ]),
    ("engine", "Engine", [
        "engine", "egr", "dpf", "doc ", "scr", "turbo", "injector",
        "piston", "cylinder", "head gasket", "timing", "egr cooler",
        "water pump", "thermostat", "radiator", "fan clutch", "coolant hose",
        "def ", "aftertreatment", "emission",
    ]),
    ("oil_fluids", "Oil/Fluids", [
        "oil", "lube", "grease", "filter", "fluid", "coolant", "antifreeze",
        "def", "diesel exhaust fluid", "atf", "transmission fluid",
        "gear oil", "hydraulic", "lubricant",
    ]),
    ("electrical", "Electrical", [
        "battery", "batt", "alternator", "starter", "wire", "wiring",
        "harness", "fuse", "relay", "sensor", "light", "lamp", "led",
        "headlight", "marker", "solenoid", "ecm", "connector", "bulb",
    ]),
    ("suspension", "Suspension", [
        "suspension", "shock", "strut", "spring", "leaf", "air bag",
        "airbag", "bushing", "u-bolt", "ubolt", "kingpin", "king pin",
        "tie rod", "ball joint", "steering", "alignment", "axle", "hub",
        "bearing", "seal",
    ]),
    ("shop_supplies", "Shop Supplies", [
        "shop supply", "shop supplies", "supplies", "rag", "cleaner",
        "solvent", "sealant", "rtv", "zip tie", "tie wrap", "shop fee",
        "disposal", "hazmat", "freight", "shipping", "core charge",
    ]),
]

# Etiquetas visibles por clave (incluye Labor y Other, que no salen de las
# reglas de keywords).
CATEGORY_LABELS: dict[str, str] = {key: label for key, label, _ in
                                   CATEGORY_RULES}
CATEGORY_LABELS["labor"] = "Labor"
CATEGORY_LABELS["other"] = "Other"


def classify_line(kind: str, part_number: str, description: str,
                  catalog_category: str = "") -> str:
    """Devuelve la clave de categoria de una linea de WO.

    Prioridad:
      1. labor -> siempre "labor".
      2. categoria del catalogo (Part.category) si la linea referencia una
         parte conocida y su categoria mapea a una de las nuestras.
      3. reglas de keywords sobre part_number + description.
      4. "other" si nada matchea.
    """
    if (kind or "").strip().lower() == "labor":
        return "labor"

    # 2) Si la linea vino del catalogo y la parte tiene categoria, intentar
    #    usarla (mapeada a nuestras claves). El usuario rotula libre, asi que
    #    se compara de forma laxa contra claves y etiquetas conocidas.
    cat = (catalog_category or "").strip().lower()
    if cat:
        for key, label in CATEGORY_LABELS.items():
            if key in ("labor", "other"):
                continue
            if cat == key or cat == label.lower() or cat in key:
                return key

    # 3) Reglas de keywords sobre el texto libre de la linea.
    haystack = f"{part_number or ''} {description or ''}".lower()
    for key, _label, keywords in CATEGORY_RULES:
        for kw in keywords:
            if kw in haystack:
                return key

    # 4) Sin match.
    return "other"


# ---------------------------------------------------------------------------
# Helpers de fecha
# ---------------------------------------------------------------------------

def _parse_date(value: str | None) -> date | None:
    """Parsea 'YYYY-MM-DD' a date, o None si vacio/invalido."""
    s = (value or "").strip()
    if not s:
        return None
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _effective_date(wo: WorkOrder) -> date | None:
    """Fecha del gasto de una orden: service_date -> closed_at -> created_at.

    service_date es lo que el jefe declara como fecha de servicio; si falta,
    se usa el sello de completed (closed_at) y por ultimo created_at."""
    sd = _parse_date(wo.service_date)
    if sd is not None:
        return sd
    if wo.closed_at is not None:
        return wo.closed_at.date()
    if wo.created_at is not None:
        return wo.created_at.date()
    return None


def _is_planned(wo: WorkOrder) -> bool:
    """¿Es trabajo PLANIFICADO (preventivo) o REACTIVO (falla/reparación)?

    Planificado = la orden es un PM explícito (`is_pm`) o pertenece a una
    campaña programada (pm/dot/kingpins/dpf/clutch): todas son trabajo de
    calendario/programa, no una falla. Todo lo demás es reactivo. Es la base
    del ratio preventivo-vs-reactivo (la métrica más honesta de "prevengo o
    apago incendios", sin necesidad de millas)."""
    if bool(wo.is_pm):
        return True
    return bool((wo.campaign or "").strip())


def _median(vals: list[float]) -> float:
    """Mediana de una lista de montos (0.0 si vacía). Se usa junto al promedio
    por WO: dos overhauls caros distorsionan el avg pero no la mediana."""
    if not vals:
        return 0.0
    s = sorted(vals)
    n = len(s)
    mid = n // 2
    if n % 2:
        return round(s[mid], 2)
    return round((s[mid - 1] + s[mid]) / 2, 2)


# ---------------------------------------------------------------------------
# Agregacion principal
# ---------------------------------------------------------------------------

def spend_report(date_from: str = "", date_to: str = "",
                 terminal: str = "", top_units: int = 10,
                 top_parts: int = 10) -> dict:
    """Reporte de gasto en un rango de fechas (inclusive en ambos extremos).

    Args:
        date_from / date_to: 'YYYY-MM-DD'. Vacios = sin limite por ese lado.
        terminal: clave de terminal (de core/terminals); vacio = todas.
        top_units / top_parts: cuantos elementos devolver en esos rankings.

    Devuelve un dict con totales + arrays listos para charts. Un rango sin
    datos devuelve ceros y arrays vacios (nunca rompe)."""
    d_from = _parse_date(date_from)
    d_to = _parse_date(date_to)
    term = (terminal or "").strip().upper()
    top_units = max(1, min(int(top_units or 10), 100))
    top_parts = max(1, min(int(top_parts or 10), 100))

    # Mapa part_number -> categoria del catalogo (para clasificar mejor las
    # lineas que referencian una parte conocida). Una sola query.
    with SessionLocal() as session:
        catalog: dict[str, str] = {
            (pn or "").strip().lower(): (cat or "")
            for pn, cat in session.execute(
                select(Part.part_number, Part.category)).all()
            if (pn or "").strip()
        }

        # Todas las ordenes (gasto comprometido): el filtro por estado ya no
        # recorta a completed/invoiced — basta con que la orden tenga lineas
        # con monto > 0 (se valida en el loop). El filtro por rango y terminal
        # se hace en Python: la fecha efectiva combina varias columnas y la
        # terminal se resuelve con terminals.resolve (misma logica que el resto
        # de la app). _EXCLUDED_STATUSES queda como hook por si en el futuro
        # hay un estado "borrador" que deba excluirse.
        q = select(WorkOrder)
        if _EXCLUDED_STATUSES:
            q = q.where(WorkOrder.status.notin_(_EXCLUDED_STATUSES))
        wos = session.scalars(q).all()

        # Acumuladores.
        total_spend = 0.0
        parts_spend = 0.0
        labor_spend = 0.0
        pm_spend = 0.0                       # gasto en trabajo planificado (PM)
        reactive_spend = 0.0                 # gasto en fallas/reparaciones
        wo_count = 0
        wo_totals: list[float] = []          # total por WO facturada (mediana)
        by_category: dict[str, float] = {}
        by_unit: dict[str, float] = {}
        by_month: dict[str, float] = {}      # 'YYYY-MM' -> gasto
        by_part: dict[str, dict] = {}        # part_number -> {spend, qty, desc}

        for wo in wos:
            eff = _effective_date(wo)
            if eff is None:
                continue
            if d_from is not None and eff < d_from:
                continue
            if d_to is not None and eff > d_to:
                continue
            if term and terminals.resolve(wo.unit, wo.company) != term:
                continue

            month_key = eff.strftime("%Y-%m")
            unit_key = (wo.unit or "").strip() or "—"
            wo_total = 0.0      # gasto de ESTA orden (para PM/reactivo + mediana)

            for ln in wo.lines:
                amount = round((ln.qty or 0) * (ln.unit_cost or 0), 2)
                if amount == 0:
                    continue
                wo_total += amount
                total_spend += amount
                if (ln.kind or "").strip().lower() == "labor":
                    labor_spend += amount
                else:
                    parts_spend += amount

                cat_key = classify_line(
                    ln.kind, ln.part_number, ln.description,
                    catalog.get((ln.part_number or "").strip().lower(), ""))
                by_category[cat_key] = by_category.get(cat_key, 0.0) + amount
                by_unit[unit_key] = by_unit.get(unit_key, 0.0) + amount
                by_month[month_key] = by_month.get(month_key, 0.0) + amount

                # Top de partes: solo lineas de parte con numero (las de
                # labor o sin numero no son "una parte" identificable).
                pn = (ln.part_number or "").strip()
                if pn and (ln.kind or "").strip().lower() != "labor":
                    entry = by_part.setdefault(
                        pn, {"spend": 0.0, "qty": 0.0, "description": ""})
                    entry["spend"] += amount
                    entry["qty"] += (ln.qty or 0)
                    if not entry["description"]:
                        entry["description"] = ln.description or ""

            # Solo cuenta como WO del reporte si aporto gasto real (>0). Asi
            # las ordenes vacias/abiertas sin lineas no inflan el conteo ni
            # bajan el promedio por WO. El total de la orden alimenta el split
            # planificado-vs-reactivo (por WO, no por linea) y la mediana.
            if wo_total > 0:
                wo_count += 1
                wo_totals.append(round(wo_total, 2))
                if _is_planned(wo):
                    pm_spend += wo_total
                else:
                    reactive_spend += wo_total

    total_spend = round(total_spend, 2)
    parts_spend = round(parts_spend, 2)
    labor_spend = round(labor_spend, 2)
    pm_spend = round(pm_spend, 2)
    reactive_spend = round(reactive_spend, 2)
    avg_per_wo = round(total_spend / wo_count, 2) if wo_count else 0.0
    median_per_wo = _median(wo_totals)
    # % del gasto en prevención (planificado). El resto es reactivo.
    pm_pct = round(pm_spend / total_spend * 100, 1) if total_spend else 0.0

    # ----- Armado de los arrays para charts -----
    # Categorias: en el orden canonico (reglas + labor + other), solo las que
    # tengan gasto. Asi el frontend recibe un orden estable.
    cat_order = [k for k, _l, _kw in CATEGORY_RULES] + ["labor", "other"]
    category_series = [
        {"key": k, "label": CATEGORY_LABELS[k],
         "value": round(by_category[k], 2)}
        for k in cat_order if by_category.get(k)
    ]

    # Unidades: top N por gasto, desc.
    unit_series = [
        {"label": u, "value": round(v, 2)}
        for u, v in sorted(by_unit.items(), key=lambda kv: kv[1],
                           reverse=True)[:top_units]
    ]

    # Meses: serie temporal ordenada ascendente (para el trend).
    month_series = [
        {"label": m, "value": round(by_month[m], 2)}
        for m in sorted(by_month.keys())
    ]

    # Top de partes por gasto, desc.
    parts_series = [
        {"part_number": pn, "description": e["description"],
         "qty": round(e["qty"], 2), "value": round(e["spend"], 2)}
        for pn, e in sorted(by_part.items(), key=lambda kv: kv[1]["spend"],
                            reverse=True)[:top_parts]
    ]

    return {
        "range": {
            "from": d_from.isoformat() if d_from else None,
            "to": d_to.isoformat() if d_to else None,
            "terminal": term or None,
        },
        "totals": {
            "total_spend": total_spend,
            "parts_spend": parts_spend,
            "labor_spend": labor_spend,
            "pm_spend": pm_spend,
            "reactive_spend": reactive_spend,
            "pm_pct": pm_pct,
            "wo_count": wo_count,
            "avg_per_wo": avg_per_wo,
            "median_per_wo": median_per_wo,
        },
        "by_category": category_series,
        "by_unit": unit_series,
        "by_month": month_series,
        "top_parts": parts_series,
    }


# ---------------------------------------------------------------------------
# Compliance de conductores (vino de la página "Driver Compliance", v2.11)
# ---------------------------------------------------------------------------
# Los vencimientos por conductor son detalle (viven en el drawer del buscador);
# lo AGREGADO —cuántos CDL vencidos, cuántas fechas faltan, quién hay que
# perseguir— es reportable y vive acá. El estado de vencimiento se calcula en el
# backend (antes solo existía en el frontend, en la página que se eliminó).

DRIVER_DOCS: list[tuple[str, str]] = [
    ("cdl_exp", "CDL"),
    ("med_exp", "Medical card"),
    ("mvr_exp", "MVR"),
    ("chouse_exp", "Clearinghouse"),
]

DRIVER_ROLES: dict[str, str] = {
    "owner_operator": "Owner operator",
    "company_driver": "Company driver",
    "lease_operator": "Lease operator",
}


def doc_state(value: str | None, today: date | None = None) -> tuple[str, int | None]:
    """Estado de un vencimiento: ('missing'|'expired'|'soon'|'valid', días).

    `soon` = vence dentro de 30 días. `missing` (sin fecha) se distingue a
    propósito de `valid`: una fecha en blanco es PEOR que una por vencer — no
    sabés si el conductor está habilitado — y antes se veía igual que un dato
    cargado y vigente."""
    d = _parse_date(value)
    if d is None:
        return ("missing", None)
    days = (d - (today or date.today())).days
    if days < 0:
        return ("expired", days)
    if days <= 30:
        return ("soon", days)
    return ("valid", days)


def driver_compliance_report(drivers: list[dict],
                             today: date | None = None) -> dict:
    """Agregados de compliance sobre el roster ya resuelto (función PURA: el
    fetch async lo hace la ruta, así esto se puede testear sin red ni DB)."""
    ref = today or date.today()
    total = len(drivers)
    with_profile = sum(1 for d in drivers if d.get("has_profile"))

    by_doc: list[dict] = []
    attention: list[dict] = []
    flagged: set[str] = set()      # conductores con al menos un problema
    for key, label in DRIVER_DOCS:
        counts = {"expired": 0, "soon": 0, "valid": 0, "missing": 0}
        for d in drivers:
            state, days = doc_state(str(d.get(key) or ""), ref)
            counts[state] += 1
            if state in ("expired", "soon", "missing"):
                flagged.add(d.get("name") or "")
                attention.append({
                    "name": d.get("name") or "",
                    "doc": key, "label": label,
                    "date": str(d.get(key) or ""),
                    "state": state, "days": days,
                    "truck": d.get("truck") or "",
                })
        by_doc.append({"key": key, "label": label, **counts})

    # Los vencidos primero, después por días restantes; los que no tienen fecha
    # al final del grupo (no hay urgencia calculable, pero hay que cargarla).
    _order = {"expired": 0, "soon": 1, "missing": 2}
    attention.sort(key=lambda a: (_order.get(a["state"], 3),
                                  a["days"] if a["days"] is not None else 9999,
                                  a["name"]))

    # Mix de roles: SOLO con perfil. El default del modelo es 'owner_operator',
    # así que contar los sin-perfil reportaría 100% owner-operators (falso).
    role_counts: dict[str, int] = {}
    for d in drivers:
        if not d.get("has_profile"):
            continue
        r = str(d.get("role") or "")
        role_counts[r] = role_counts.get(r, 0) + 1
    role_mix = [{"key": k, "label": DRIVER_ROLES.get(k, k or "—"),
                 "count": v}
                for k, v in sorted(role_counts.items(), key=lambda kv: -kv[1])]

    # Cobertura de equipo: explica los huecos en la columna Driver del board
    # de PM/DOT (que se llena con el truck del perfil).
    with_truck = sum(1 for d in drivers if str(d.get("truck") or "").strip())

    return {
        "totals": {
            "drivers": total,
            "with_profile": with_profile,
            "without_profile": total - with_profile,
            "needs_attention": len([n for n in flagged if n]),
            "expired": sum(r["expired"] for r in by_doc),
            "expiring_soon": sum(r["soon"] for r in by_doc),
            "missing_dates": sum(r["missing"] for r in by_doc),
            "with_truck": with_truck,
            "without_truck": total - with_truck,
        },
        "by_doc": by_doc,
        "role_mix": role_mix,
        "attention": attention[:40],
    }


# ---------------------------------------------------------------------------
# Cost per mile (CPM) — el número ancla de Dario
# ---------------------------------------------------------------------------

def _unit_spend(d_from: date | None, d_to: date | None,
                term: str) -> tuple[dict[str, float], float]:
    """Gasto comprometido por unidad en el rango (mismos filtros que
    spend_report). Devuelve ({unit -> $}, total). A diferencia de by_unit,
    no recorta a top-N: el CPM necesita TODAS las unidades para el join."""
    by_unit: dict[str, float] = {}
    total = 0.0
    with SessionLocal() as session:
        for wo in session.scalars(select(WorkOrder)).all():
            eff = _effective_date(wo)
            if eff is None:
                continue
            if d_from is not None and eff < d_from:
                continue
            if d_to is not None and eff > d_to:
                continue
            if term and terminals.resolve(wo.unit, wo.company) != term:
                continue
            unit = (wo.unit or "").strip() or "—"
            wo_total = 0.0
            for ln in wo.lines:
                amount = round((ln.qty or 0) * (ln.unit_cost or 0), 2)
                if amount:
                    wo_total += amount
            if wo_total > 0:
                by_unit[unit] = by_unit.get(unit, 0.0) + wo_total
                total += wo_total
    return by_unit, round(total, 2)


def cpm_report(date_from: str = "", date_to: str = "",
               terminal: str = "") -> dict:
    """Cost-per-mile de mantenimiento: gasto de WOs / millas manejadas (del
    odómetro persistido). Solo agrega al Fleet CPM las unidades que TIENEN
    millas en el rango; las que tienen gasto pero no odómetro se cuentan aparte
    (sin ellas el número mentiría). Muestra las millas junto al CPM para que el
    dueño juzgue. Trailers y unidades nuevas sin lecturas no aplican."""
    d_from = _parse_date(date_from)
    d_to = _parse_date(date_to)
    term = (terminal or "").strip().upper()

    spend_by_unit, total_spend = _unit_spend(d_from, d_to, term)
    miles = odometer.miles_by_unit(d_from, d_to)   # {unit -> millas}
    cov = odometer.coverage()

    rows: list[dict] = []
    fleet_spend = 0.0        # gasto de unidades CON millas (numerador honesto)
    fleet_miles = 0          # millas de esas unidades (denominador)
    without_miles = 0
    spend_without_miles = 0.0
    for unit, spend in spend_by_unit.items():
        mi = miles.get(unit, 0)
        if mi > 0:
            rows.append({"unit": unit, "spend": round(spend, 2), "miles": mi,
                         "cpm": round(spend / mi, 3)})
            fleet_spend += spend
            fleet_miles += mi
        else:
            without_miles += 1
            spend_without_miles += spend
            rows.append({"unit": unit, "spend": round(spend, 2), "miles": 0,
                         "cpm": None})

    # Peores primero (mayor $/milla); las sin millas al final.
    rows.sort(key=lambda r: (r["cpm"] is None, -(r["cpm"] or 0)))
    fleet_cpm = round(fleet_spend / fleet_miles, 3) if fleet_miles else None

    return {
        "range": {
            "from": d_from.isoformat() if d_from else None,
            "to": d_to.isoformat() if d_to else None,
            "terminal": term or None,
        },
        "fleet_cpm": fleet_cpm,
        "fleet_miles": fleet_miles,
        "fleet_spend": round(fleet_spend, 2),
        "total_spend": total_spend,
        "units_with_miles": len(rows) - without_miles,
        "units_without_miles": without_miles,
        "spend_without_miles": round(spend_without_miles, 2),
        "coverage": cov,       # {readings, since, latest}
        "by_unit": rows,
    }
