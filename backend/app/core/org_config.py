# -*- coding: utf-8 -*-
"""Configuración de empresa (fase G7): lo que antes vivía hardcodeado.

`backend/org.local.json` (gitignored) guarda branding, umbrales de
negocio y CC routing. Los DEFAULTS son exactamente los valores que el
código traía en duro (Chaser/MCCI), así que sin archivo la app se
comporta idéntico — y otra empresa solo necesita su propio org.local.

Consumidores cableados (con fallback a default):
- cc_routing.cc_for_region   -> cc por terminal + always_cc
- pm (intervalo y upcoming)  -> thresholds.pm_*
- samsara (lookback defectos)-> thresholds.defect_lookback_days
- engine (umbral DVIR rojo)  -> thresholds.dvir_min_minutes
"""

from __future__ import annotations

import json

from .. import config

CONFIG_PATH = config.BACKEND_DIR / "org.local.json"

DEFAULTS: dict = {
    "branding": {
        "app_name": "Fleet Tracker",
        "tagline": "Fleet compliance",
        "accent": "",                # vacío = rojo de fábrica (#e11900)
    },
    "thresholds": {
        "dvir_min_minutes": 15,      # pre-trip más corto = rojo
        "pm_interval_miles": 20000,
        "pm_upcoming_miles": 5500,
        "defect_lookback_days": 270,
    },
    # H3: tarifa de labor del taller ($/hora). 0 = sin tarifa por defecto
    # (las líneas de labor no se autollenan). Decisión del usuario: una
    # tarifa única de taller (no por mecánico).
    "labor_rate": 0.0,
    # CC routing de Avisos: lista por terminal + lista que SIEMPRE va.
    # Vacío = usar el REGION_CC hardcodeado histórico de cc_routing.py.
    "cc": {},
    "always_cc": [],
    # H3-C: identidad del taller (el "From" del estimate/invoice). Un solo
    # taller (decisión del usuario). `name` vacío = usar branding.app_name.
    "shop": {
        "name": "", "address": "", "city": "", "state": "", "zip": "",
        "phone": "", "email": "",
    },
    # Bill-To por empresa dueña de la unidad (CHASER/MCC). Vacío = solo el
    # nombre de la empresa, sin dirección. No es una entidad Customer: es
    # un mapa empresa -> dirección de facturación.
    "billing": {},   # { "CHASER": {name,address,city,state,zip,phone,email}, ... }
    # Numeración y textos por defecto del invoice. `next_number` lo gestiona
    # next_invoice_number() (se autoincrementa al facturar); save() NO lo
    # toca para no pisarlo con un valor viejo del formulario.
    "invoice": {
        "next_number": 1001, "prefix": "", "terms": "", "footer": "",
    },
}

# Campos de texto de una dirección de Bill-To (se sanean al guardar).
_ADDR_FIELDS = ("name", "address", "city", "state", "zip", "phone", "email")


def _read() -> dict:
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
    return {}


def get() -> dict:
    data = _read()
    out = json.loads(json.dumps(DEFAULTS))
    for section in ("branding", "thresholds"):
        for k, v in (data.get(section) or {}).items():
            if k in out[section]:
                out[section][k] = v
    if isinstance(data.get("cc"), dict):
        out["cc"] = {
            str(t): [str(e).strip() for e in v if str(e).strip()]
            for t, v in data["cc"].items() if isinstance(v, list)
        }
    if isinstance(data.get("always_cc"), list):
        out["always_cc"] = [str(e).strip() for e in data["always_cc"]
                            if str(e).strip()]
    try:
        out["labor_rate"] = max(0.0, float(data.get("labor_rate", 0)))
    except (TypeError, ValueError):
        out["labor_rate"] = 0.0
    # H3-C: taller (strings), invoice (contador + textos), Bill-To por empresa.
    for k, v in (data.get("shop") or {}).items():
        if k in out["shop"]:
            out["shop"][k] = str(v)
    inv = data.get("invoice") or {}
    try:
        out["invoice"]["next_number"] = max(1, int(inv.get("next_number", 1001)))
    except (TypeError, ValueError):
        pass
    for k in ("prefix", "terms", "footer"):
        if k in inv:
            out["invoice"][k] = str(inv[k])
    if isinstance(data.get("billing"), dict):
        out["billing"] = {
            str(co): {f: str(addr.get(f, "")) for f in _ADDR_FIELDS}
            for co, addr in data["billing"].items() if isinstance(addr, dict)
        }
    return out


def save(new: dict) -> dict:
    cur = get()
    for section in ("branding", "thresholds"):
        for k, v in (new.get(section) or {}).items():
            if k not in cur[section]:
                continue
            if section == "thresholds":
                try:
                    cur[section][k] = max(1, int(v))
                except (TypeError, ValueError):
                    continue
            else:
                cur[section][k] = str(v).strip()[:80]
    if isinstance(new.get("cc"), dict):
        cur["cc"] = {
            str(t)[:12]: [str(e).strip()[:80] for e in v
                          if str(e).strip()][:10]
            for t, v in new["cc"].items() if isinstance(v, list)
        }
    if isinstance(new.get("always_cc"), list):
        cur["always_cc"] = [str(e).strip()[:80] for e in new["always_cc"]
                            if str(e).strip()][:10]
    if "labor_rate" in new:
        try:
            cur["labor_rate"] = max(0.0, float(new["labor_rate"] or 0))
        except (TypeError, ValueError):
            pass
    # H3-C: taller + textos del invoice + Bill-To. OJO: NO se persiste
    # `invoice.next_number` desde el formulario (lo gestiona en exclusiva
    # next_invoice_number); así un form viejo no retrocede el contador.
    if isinstance(new.get("shop"), dict):
        for k, v in new["shop"].items():
            if k in cur["shop"]:
                cur["shop"][k] = str(v).strip()[:120]
    if isinstance(new.get("invoice"), dict):
        for k in ("prefix", "terms", "footer"):
            if k in new["invoice"]:
                cap = 12 if k == "prefix" else 400
                cur["invoice"][k] = str(new["invoice"][k]).strip()[:cap]
    if isinstance(new.get("billing"), dict):
        cur["billing"] = {
            str(co)[:64]: {f: str(addr.get(f, "")).strip()[:120]
                           for f in _ADDR_FIELDS}
            for co, addr in new["billing"].items() if isinstance(addr, dict)
        }
    CONFIG_PATH.write_text(
        json.dumps(cur, ensure_ascii=False, indent=1), encoding="utf-8")
    return cur


# ----- Accesores cómodos para los consumidores ---------------------------

def branding() -> dict:
    return get()["branding"]


def threshold(key: str) -> int:
    return int(get()["thresholds"].get(
        key, DEFAULTS["thresholds"].get(key, 0)))


def labor_rate() -> float:
    """Tarifa de labor del taller ($/hora). 0 = sin default."""
    return float(get().get("labor_rate", 0.0))


def shop() -> dict:
    """Identidad del taller (el "From" del estimate/invoice)."""
    return get()["shop"]


def billing() -> dict:
    """Mapa empresa -> dirección de Bill-To."""
    return get()["billing"]


def invoice_cfg() -> dict:
    """Config del invoice (next_number, prefix, terms, footer)."""
    return get()["invoice"]


def next_invoice_number() -> str:
    """Toma el próximo número de invoice y AVANZA el contador (persistido).
    Devuelve el número con prefijo (p.ej. 'INV-1042'). App local mono-
    usuario: lectura-incremento-escritura simple sobre el JSON."""
    cur = get()
    n = int(cur["invoice"].get("next_number", 1001) or 1001)
    prefix = str(cur["invoice"].get("prefix", "") or "")
    cur["invoice"]["next_number"] = n + 1
    CONFIG_PATH.write_text(
        json.dumps(cur, ensure_ascii=False, indent=1), encoding="utf-8")
    return f"{prefix}{n}"


def cc_override() -> tuple[dict[str, list[str]], list[str]]:
    """(cc_por_terminal, always_cc). Vacíos = usar los hardcodeados."""
    data = get()
    return data["cc"], data["always_cc"]
