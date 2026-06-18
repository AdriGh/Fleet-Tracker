# -*- coding: utf-8 -*-
"""Terminales dinámicas (Settings → Terminals).

`backend/terminals.local.json` (gitignored) guarda las terminales
{key, label, prefixes} y las asignaciones manuales unidad→terminal.
Sin archivo, los DEFAULTS son el set histórico hardcodeado
(Chaser/Memphis/Chicago/Miami/Georgia) para que la app se comporte
idéntico hasta que el admin toque algo.

Resolución de la terminal de una unidad (espejo de frontend/terminal.ts):
  1. asignación manual, si la terminal todavía existe
  2. prefijo más largo de las terminales configuradas (el carácter que
     sigue al prefijo no puede ser una letra: MEM matchea "MEM-123"
     pero no "MEMPHIS1")
  3. respaldo por empresa: MCC sin prefijo → 'MCC', si no → primera
     terminal de la lista (históricamente CHASER)
"""

from __future__ import annotations

import json
import re

from .. import config, db

# H6: persiste por-tenant en org_setting (clave 'terminals'); el JSON legacy
# se importa una sola vez a la org 'default'.
SETTING_KEY = "terminals"
PATH = config.BACKEND_DIR / "terminals.local.json"   # legacy (migracion)

# Una sola terminal generica de fabrica (sin estructura real de ninguna
# empresa). El admin crea sus terminales reales desde Settings -> Terminals.
DEFAULTS: list[dict] = [
    {"key": "MAIN", "label": "Main", "prefixes": []},
]

_MAX_TERMINALS = 30
_MAX_PREFIXES = 8


def _load() -> dict:
    data = db.get_setting(SETTING_KEY, legacy_file=PATH)
    return data if isinstance(data, dict) else {}


def _save(data: dict) -> None:
    db.save_setting(SETTING_KEY, data)


def _terminals(data: dict | None = None) -> list[dict]:
    """Lista efectiva: la guardada, o los DEFAULTS si nunca se editó."""
    data = _load() if data is None else data
    stored = data.get("terminals")
    if isinstance(stored, list):
        return [
            {"key": str(t.get("key", "")),
             "label": str(t.get("label", "")),
             "prefixes": [str(p) for p in (t.get("prefixes") or [])]}
            for t in stored if isinstance(t, dict) and t.get("key")
        ]
    return json.loads(json.dumps(DEFAULTS))


def _assignments(data: dict | None = None) -> dict[str, str]:
    data = _load() if data is None else data
    raw = data.get("assignments")
    if not isinstance(raw, dict):
        return {}
    return {str(u): str(t) for u, t in raw.items() if str(u) and str(t)}


def get_all() -> dict:
    data = _load()
    terms = _terminals(data)
    keys = {t["key"] for t in terms}
    # Asignaciones a terminales borradas no se exponen (quedan inertes).
    assigns = {u: t for u, t in _assignments(data).items() if t in keys}
    return {"terminals": terms, "assignments": assigns}


def _clean_prefixes(prefixes: list) -> list[str]:
    out: list[str] = []
    for p in prefixes or []:
        s = re.sub(r"[^A-Z0-9]", "", str(p).strip().upper())[:6]
        if len(s) >= 2 and s not in out:
            out.append(s)
    return out[:_MAX_PREFIXES]


def _slug(label: str, taken: set[str]) -> str:
    base = re.sub(r"[^A-Z0-9]+", "_", label.strip().upper()).strip("_")[:12]
    base = base or "TERMINAL"
    key, n = base, 2
    while key in taken or key == "MCC":
        key = f"{base[:10]}_{n}"
        n += 1
    return key


def save_terminal(key: str, label: str, prefixes: list) -> dict:
    """Crea (key vacío) o edita (key existente) una terminal."""
    label = str(label or "").strip()[:30]
    if not label:
        raise ValueError("Terminal name is required")
    data = _load()
    terms = _terminals(data)
    key = str(key or "").strip().upper()
    cleaned = _clean_prefixes(prefixes)

    # Un prefijo no puede estar reclamado por OTRA terminal: en empate
    # resolve() siempre da la primera de la lista, así que el duplicado
    # quedaría muerto. Mejor avisar al admin que aceptarlo en silencio.
    for t in terms:
        if key and t["key"] == key:
            continue
        clash = sorted(set(cleaned) & set(t["prefixes"]))
        if clash:
            raise ValueError(
                f"Prefix {', '.join(clash)} is already used by "
                f"terminal {t['label']}")

    if key:
        for t in terms:
            if t["key"] == key:
                t["label"] = label
                t["prefixes"] = cleaned
                break
        else:
            raise ValueError(f"Terminal {key} does not exist")
    else:
        if len(terms) >= _MAX_TERMINALS:
            raise ValueError("Too many terminals")
        key = _slug(label, {t["key"] for t in terms})
        terms.append({"key": key, "label": label, "prefixes": cleaned})

    data["terminals"] = terms
    data["assignments"] = _assignments(data)
    _save(data)
    return get_all()


def delete_terminal(key: str) -> dict:
    key = str(key or "").strip().upper()
    data = _load()
    terms = _terminals(data)
    if key not in {t["key"] for t in terms}:
        raise ValueError(f"Terminal {key} does not exist")
    # Nunca dejar la lista vacía: un set vacío NO recae en DEFAULTS
    # (se interpreta como "editado a cero"), rompiendo la resolución.
    if len(terms) <= 1:
        raise ValueError("Cannot delete the last terminal")
    data["terminals"] = [t for t in terms if t["key"] != key]
    data["assignments"] = {
        u: t for u, t in _assignments(data).items() if t != key}
    _save(data)
    return get_all()


def assign(terminal: str, units: list) -> dict:
    """Reemplaza la flota PINNEADA de una terminal por `units`.

    Las unidades que estaban asignadas a esa terminal y no vienen en la
    lista vuelven a resolución automática (prefijo/empresa).
    """
    terminal = str(terminal or "").strip().upper()
    data = _load()
    terms = _terminals(data)
    if terminal not in {t["key"] for t in terms}:
        raise ValueError(f"Terminal {terminal} does not exist")
    assigns = {u: t for u, t in _assignments(data).items() if t != terminal}
    for u in units or []:
        name = str(u).strip()
        if name:
            assigns[name] = terminal
    data["terminals"] = terms
    data["assignments"] = assigns
    _save(data)
    return get_all()


def resolve(unit: str, company: str = "") -> str:
    """Terminal de una unidad (mismas reglas que el frontend)."""
    cfg = get_all()
    name = str(unit or "").strip()
    assigned = cfg["assignments"].get(name)
    if assigned:
        return assigned
    s = name.upper()
    best = ""
    best_key = ""
    for t in cfg["terminals"]:
        for p in t["prefixes"]:
            if len(p) <= len(best):
                continue
            if s.startswith(p) and (len(s) == len(p)
                                    or not s[len(p)].isalpha()):
                best, best_key = p, t["key"]
    if best_key:
        return best_key
    if str(company or "").strip().upper() == "MCC":
        return "MCC"
    return cfg["terminals"][0]["key"] if cfg["terminals"] else "CHASER"
