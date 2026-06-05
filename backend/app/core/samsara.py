# -*- coding: utf-8 -*-
"""Defectos ABIERTOS en vivo desde la API de Samsara.

Reemplaza el CSV manual (`core.open_defects`). Lee el token de
`backend/samsara.local.json` y pide los defectos no resueltos a
`GET /defects/stream?isResolved=false`. Resuelve nombre + tipo de unidad por
`/assets` (vehicle -> camión, trailer/unpowered -> tráiler) y la categoría del
defecto por `/defect-types`; si el defecto no trae tipo (común en tráileres),
la infiere del comentario. Devuelve filas con la MISMA forma que
`db.list_defects` / `open_defects.load` para que el frontend las consuma igual.

Solo lectura (scope Read Defects). Si algo falla, el endpoint cae al CSV.
"""

import datetime
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path

from .open_defects import _is_noise, company_of

CONF_PATH = Path(__file__).resolve().parents[2] / "samsara.local.json"

_LOOKBACK_DAYS = 730          # ventana del stream: 2 años atrás cubre lo abierto
_TIMEOUT = 60
_PLACEHOLDER = "PEGA_AQUI"    # token de ejemplo sin configurar

# Inferencia de categoría a partir del comentario, cuando el defecto no trae
# `defectTypeId`. (patrón regex, categoría, solo_camión). El orden importa: se
# evalúa de arriba a abajo y gana el primero. Las categorías coinciden con las
# claves de `frontend/src/truckZones.ts` para que pinten su zona en el diagrama.
_RULES: list[tuple[str, str, bool]] = [
    (r"coupl|kingpin|king pin|fifth wheel", "Coupling Devices", False),
    (r"landing (gear|foot|leg)|\bdolly|\bcrank|raise (and|&) lower|"
     r"raise.{0,6}lower", "Landing Gear", False),
    (r"reflect|conspicuity", "Reflectors", False),
    (r"\bdoor", "Doors", False),
    (r"mirror", "Mirrors", True),
    (r"wiper|windshield|windsheild", "Windshield Clean, Intact", True),
    (r"brake ?line|air ?line|air ?hose|glad ?hand", "Brake Connections", False),
    (r"brake|slack adjust", "Brakes", False),
    (r"air ?bag|suspension|\bspring|shock absorb|leaf spring", "Suspension",
     False),
    (r"\btire|tread|recap|\bpsi\b|flat spot|\bbald|wheel seal|\brim\b", "Tires",
     False),
    (r"chain", "Tire Chains", False),
    (r"light|lamp|\b4 ?way|clearance|marker|signal|headlamp|headlight|"
     r"turn sig", "Lights", False),
    (r"transmiss", "Transmission", True),
    (r"exhaust|muffler|\bdpf\b", "Exhaust", True),
    (r"engine|coolant|radiator|\boil\b", "Engine", True),
    (r"\broof", "Roof", False),
]
_COMPILED = [(re.compile(p, re.IGNORECASE), lab, truck) for p, lab, truck in _RULES]


def _infer_type(comment: str, kind: str) -> str:
    c = comment or ""
    for rx, label, truck_only in _COMPILED:
        if truck_only and kind != "truck":
            continue
        if rx.search(c):
            return label
    return "Other"


def _config() -> dict | None:
    if not CONF_PATH.exists():
        return None
    try:
        cfg = json.loads(CONF_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    token = (cfg.get("api_token") or "").strip()
    if not token or _PLACEHOLDER in token:
        return None
    cfg["base_url"] = (cfg.get("base_url") or "https://api.samsara.com").rstrip("/")
    return cfg


def is_available() -> bool:
    """True si hay un token configurado (no garantiza que la API responda)."""
    return _config() is not None


def _get(cfg: dict, path: str) -> dict:
    req = urllib.request.Request(
        cfg["base_url"] + path,
        headers={"Authorization": "Bearer " + cfg["api_token"],
                 "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


def _paged(cfg: dict, path: str) -> list[dict]:
    """Recorre la paginación por cursor de Samsara (pagination.endCursor)."""
    out: list[dict] = []
    sep = "&" if "?" in path else "?"
    cursor = None
    for _ in range(200):  # tope de seguridad
        page = path + (f"{sep}after={urllib.parse.quote(cursor)}" if cursor else "")
        d = _get(cfg, page)
        out.extend(d.get("data", []))
        pg = d.get("pagination", {}) or {}
        cursor = pg.get("endCursor")
        if not (pg.get("hasNextPage") and cursor):
            break
    return out


def _parse_day(raw: str) -> datetime.date | None:
    if not raw:
        return None
    try:
        return datetime.datetime.strptime(raw[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def load() -> list[dict]:
    """Defectos abiertos en vivo (deduplicados) con forma de `Defect`.

    Lanza excepción si la API falla; el endpoint la captura y cae al CSV.
    """
    cfg = _config()
    if not cfg:
        return []
    open_only = cfg.get("open_only", True)

    # id de asset -> {name, type}; id de tipo -> label.
    assets = {a["id"]: a for a in _paged(cfg, "/assets?limit=512")}
    types = {t["id"]: t.get("label")
             for t in _get(cfg, "/defect-types").get("data", [])}

    now = datetime.datetime.now(datetime.timezone.utc)
    start = (now - datetime.timedelta(days=_LOOKBACK_DAYS)).strftime(
        "%Y-%m-%dT%H:%M:%SZ")
    end = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    query = f"/defects/stream?startTime={start}&endTime={end}"
    if open_only:
        query += "&isResolved=false"
    defects = _paged(cfg, query)

    # clave (unidad, categoría, comentario normalizado) -> registro acumulado
    seen: dict[tuple, dict] = {}
    for r in defects:
        if open_only and r.get("isResolved"):
            continue
        ref = r.get("vehicle") or r.get("trailer") or {}
        asset = assets.get(ref.get("id"), {})
        name = (asset.get("name") or ref.get("id") or "").strip()
        if not name:
            continue
        kind = "truck" if asset.get("type") == "vehicle" else "trailer"
        comment = (r.get("comment") or "").strip()
        if _is_noise(comment):
            continue
        tid = r.get("defectTypeId")
        dtype = types.get(tid) if tid else None
        if not dtype:
            dtype = _infer_type(comment, kind)
        key = (name, dtype, comment.lower())
        day = _parse_day(r.get("updatedAtTime") or r.get("createdAtTime"))

        cur = seen.get(key)
        if cur is None:
            seen[key] = {
                "unit": name,
                "kind": kind,
                "detail": f"{dtype} - {comment}" if comment else dtype,
                "notes": (r.get("mechanicNotes") or "").strip(),
                "_day": day or datetime.date(1970, 1, 1),
                "_n": 1,
            }
        else:
            cur["_n"] += 1
            if day and day > cur["_day"]:
                cur["_day"] = day
                notes = (r.get("mechanicNotes") or "").strip()
                if notes:
                    cur["notes"] = notes

    out: list[dict] = []
    for rec in seen.values():
        day = rec["_day"]
        out.append({
            "date_label": f"{day.month}.{day.day}",
            "block_date": day.isoformat(),
            "company": company_of(rec["unit"]),
            "driver": "",
            "unit": rec["unit"],
            "unit_kind": rec["kind"],
            "dvir_type": "",
            "status": "Open",
            "detail": rec["detail"],
            "reports": rec["_n"],
            "mechanic": "",
            "mechanic_notes": rec["notes"],
        })
    out.sort(key=lambda d: d["unit"])
    return out


def load_window(days: int) -> list[dict]:
    """Defectos (ABIERTOS + RESUELTOS) creados en los últimos `days` días, para
    el dashboard. Cada defecto es un "incidente" (sin deduplicar re-reportes).
    `status` = "Unsafe" si está abierto, "Resolved" si está resuelto, para
    reusar el donut/KPIs existentes. Lanza excepción si la API falla.
    """
    cfg = _config()
    if not cfg:
        return []
    assets = {a["id"]: a for a in _paged(cfg, "/assets?limit=512")}
    types = {t["id"]: t.get("label")
             for t in _get(cfg, "/defect-types").get("data", [])}

    now = datetime.datetime.now(datetime.timezone.utc)
    cutoff = (now - datetime.timedelta(days=max(1, days))).date()
    start = cutoff.strftime("%Y-%m-%dT00:00:00Z")
    end = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    # El stream filtra por evento (creado/actualizado): un defecto viejo resuelto
    # hace poco también aparece. Nos quedamos con los CREADOS en la ventana
    # ("defectos reportados en los últimos N días").
    defects = _paged(cfg, f"/defects/stream?startTime={start}&endTime={end}")

    out: list[dict] = []
    for r in defects:
        ref = r.get("vehicle") or r.get("trailer") or {}
        asset = assets.get(ref.get("id"), {})
        name = (asset.get("name") or ref.get("id") or "").strip()
        if not name:
            continue
        kind = "truck" if asset.get("type") == "vehicle" else "trailer"
        comment = (r.get("comment") or "").strip()
        if _is_noise(comment):
            continue
        day = _parse_day(r.get("createdAtTime"))
        if not day or day < cutoff:
            continue
        tid = r.get("defectTypeId")
        dtype = types.get(tid) if tid else None
        if not dtype:
            dtype = _infer_type(comment, kind)
        detail = f"{dtype} - {comment}" if comment else dtype
        out.append({
            "date_label": f"{day.month}.{day.day}",
            "block_date": day.isoformat(),
            "company": company_of(name),
            "driver": "",
            "unit": name,
            "unit_kind": kind,
            "dvir_type": "",
            "status": "Resolved" if r.get("isResolved") else "Unsafe",
            "detail": detail,
            "mechanic": "",
            "mechanic_notes": (r.get("mechanicNotes") or "").strip(),
        })
    out.sort(key=lambda d: (d["block_date"], d["unit"]))
    return out
