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
    # CC routing de Avisos: lista por terminal + lista que SIEMPRE va.
    # Vacío = usar el REGION_CC hardcodeado histórico de cc_routing.py.
    "cc": {},
    "always_cc": [],
}


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
    CONFIG_PATH.write_text(
        json.dumps(cur, ensure_ascii=False, indent=1), encoding="utf-8")
    return cur


# ----- Accesores cómodos para los consumidores ---------------------------

def branding() -> dict:
    return get()["branding"]


def threshold(key: str) -> int:
    return int(get()["thresholds"].get(
        key, DEFAULTS["thresholds"].get(key, 0)))


def cc_override() -> tuple[dict[str, list[str]], list[str]]:
    """(cc_por_terminal, always_cc). Vacíos = usar los hardcodeados."""
    data = get()
    return data["cc"], data["always_cc"]
