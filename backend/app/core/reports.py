# -*- coding: utf-8 -*-
"""Reports & Analytics (Increment A): agregacion del GASTO de mantenimiento.

Suma las lineas de las work orders (parts + labor) para que el dueno del
taller responda "cuanto gaste en llantas / frenos / labor este mes/trimestre".

Alcance de los datos:
- Solo cuentan las ordenes COMPLETED o INVOICED (trabajo realmente hecho;
  open/assigned/in_progress son estimaciones en curso, no gasto real).
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
from . import terminals

# Estados que SI cuentan como gasto real (trabajo hecho/facturado). Los
# estados previos (open/assigned/in_progress) son estimaciones en curso.
_SPEND_STATUSES = ("completed", "invoiced")


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

        # Ordenes que cuentan como gasto (completed/invoiced). El filtro por
        # rango y terminal se hace en Python: la fecha efectiva combina
        # varias columnas y la terminal se resuelve con terminals.resolve
        # (misma logica que el resto de la app).
        wos = session.scalars(
            select(WorkOrder).where(
                WorkOrder.status.in_(_SPEND_STATUSES))
        ).all()

        # Acumuladores.
        total_spend = 0.0
        parts_spend = 0.0
        labor_spend = 0.0
        wo_count = 0
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

            # La orden entra al reporte: cuenta para el total de ordenes
            # aunque alguna linea sea 0.
            wo_count += 1
            month_key = eff.strftime("%Y-%m")
            unit_key = (wo.unit or "").strip() or "—"

            for ln in wo.lines:
                amount = round((ln.qty or 0) * (ln.unit_cost or 0), 2)
                if amount == 0:
                    continue
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

    total_spend = round(total_spend, 2)
    parts_spend = round(parts_spend, 2)
    labor_spend = round(labor_spend, 2)
    avg_per_wo = round(total_spend / wo_count, 2) if wo_count else 0.0

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
            "wo_count": wo_count,
            "avg_per_wo": avg_per_wo,
        },
        "by_category": category_series,
        "by_unit": unit_series,
        "by_month": month_series,
        "top_parts": parts_series,
    }
