"""Empresas (companies) gestionadas desde Settings.

Persisten en OrgSetting key 'companies' (por tenant) con la forma
{"items": [{key, label}]}. Si el store nunca se escribio, se siembra una sola
vez desde la env var FLEET_COMPANIES (util para deploys en la nube); si no hay
env, queda vacio y las empresas se crean desde Settings.

`key` es el id (MAYUSCULAS, unico) que se guarda en unidades/reportes; `label`
es el nombre visible.
"""

from __future__ import annotations

import json

from .. import config, db

SETTING_KEY = "companies"


def _norm(key: str, label: str) -> dict:
    k = str(key or "").strip().upper()[:64]
    lbl = (str(label or "").strip() or k)[:80]
    return {"key": k, "label": lbl}


def _dedup(items: list[dict]) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for it in items:
        if it["key"] and it["key"] not in seen:
            seen.add(it["key"])
            out.append(it)
    return out


def _seed_from_env() -> list[dict]:
    raw = (config.SEED_COMPANIES_RAW or "").strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        data = list(raw.split(","))
    items: list[dict] = []
    if isinstance(data, list):
        for it in data:
            if isinstance(it, dict):
                items.append(_norm(
                    it.get("key") or it.get("label") or it.get("name") or "",
                    it.get("label") or it.get("name") or it.get("key") or ""))
            elif str(it).strip():
                items.append(_norm(it, it))
    return _dedup([it for it in items if it["key"]])


def _read() -> list[dict] | None:
    blob = db.get_setting(SETTING_KEY)
    if isinstance(blob, dict) and isinstance(blob.get("items"), list):
        return _dedup([
            _norm(c.get("key", ""), c.get("label", ""))
            for c in blob["items"]
            if isinstance(c, dict) and str(c.get("key", "")).strip()
        ])
    return None


def _write(items: list[dict]) -> None:
    db.save_setting(SETTING_KEY, {"items": _dedup(items)})


def list_companies() -> list[dict]:
    """Empresas del tenant actual. Siembra desde env la primera vez."""
    cur = _read()
    if cur is not None:
        return cur
    seed = _seed_from_env()
    if seed:
        _write(seed)        # persistir la semilla una sola vez
    return seed


def keys() -> list[str]:
    return [c["key"] for c in list_companies()]


def add(label: str, key: str = "") -> list[dict]:
    item = _norm(key or label, label)
    if not item["key"]:
        raise ValueError("company name is required")
    items = list_companies()
    if any(c["key"] == item["key"] for c in items):
        raise ValueError(f"company '{item['key']}' already exists")
    items.append(item)
    _write(items)
    return list_companies()


def rename(key: str, label: str) -> list[dict]:
    key = str(key or "").strip().upper()
    label = str(label or "").strip()[:80]
    if not label:
        raise ValueError("label is required")
    items = list_companies()
    if not any(c["key"] == key for c in items):
        raise ValueError("company not found")
    for c in items:
        if c["key"] == key:
            c["label"] = label
    _write(items)
    return list_companies()


def delete(key: str) -> list[dict]:
    key = str(key or "").strip().upper()
    _write([c for c in list_companies() if c["key"] != key])
    return list_companies()
