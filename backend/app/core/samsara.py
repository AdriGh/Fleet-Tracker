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
import asyncio
import json
import re
import time
import urllib.parse
from pathlib import Path

import httpx

from .open_defects import _is_noise, company_of

CONF_PATH = Path(__file__).resolve().parents[2] / "samsara.local.json"

_LOOKBACK_DAYS = 730          # ventana del stream: 2 años atrás cubre lo abierto
_TIMEOUT = 60
_PLACEHOLDER = "PEGA_AQUI"    # token de ejemplo sin configurar

# Caché de "reference data" por org (assets + defect-types): cambia rara vez, así
# que se cachea con TTL largo y se comparte entre load() y load_window(), que
# antes lo pedían por separado. Clave = token del org.
_REF_TTL = 900  # 15 min
_ref_cache: dict[str, tuple[float, dict]] = {}
_ref_locks: dict[str, asyncio.Lock] = {}

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


def _read_config() -> dict | None:
    if not CONF_PATH.exists():
        return None
    try:
        return json.loads(CONF_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _orgs() -> list[dict]:
    """Lista de orgs de Samsara configurados.

    Soporta multi-org: `{"orgs": [{api_token, base_url, company?}, ...]}` para
    conectar varias empresas (p.ej. Chaser y MCC, que son orgs separados en
    Samsara). Mantiene compatibilidad con el formato viejo de un solo token en
    la raíz. `company` (opcional) fuerza la empresa de TODAS las unidades de ese
    org; si no se da, se deduce por el prefijo del nombre (company_of).
    """
    raw = _read_config()
    if not raw:
        return []
    default_open = raw.get("open_only", True)
    entries = raw.get("orgs")
    if not entries and raw.get("api_token"):
        entries = [raw]  # formato viejo: un único org en la raíz
    out: list[dict] = []
    for o in entries or []:
        token = (o.get("api_token") or "").strip()
        if not token or _PLACEHOLDER in token:
            continue
        out.append({
            "api_token": token,
            "base_url": (o.get("base_url")
                         or "https://api.samsara.com").rstrip("/"),
            "company": (o.get("company") or "").strip() or None,
            "open_only": o.get("open_only", default_open),
        })
    return out


def is_available() -> bool:
    """True si hay al menos un org/token configurado."""
    return bool(_orgs())


async def _get(client: httpx.AsyncClient, cfg: dict, path: str) -> dict:
    r = await client.get(
        cfg["base_url"] + path,
        headers={"Authorization": "Bearer " + cfg["api_token"],
                 "Accept": "application/json"})
    r.raise_for_status()
    return r.json()


async def _paged(client: httpx.AsyncClient, cfg: dict, path: str) -> list[dict]:
    """Recorre la paginación por cursor de Samsara (pagination.endCursor).

    Es secuencial por diseño: cada página necesita el `endCursor` de la anterior.
    """
    out: list[dict] = []
    sep = "&" if "?" in path else "?"
    cursor = None
    for _ in range(200):  # tope de seguridad
        page = path + (f"{sep}after={urllib.parse.quote(cursor)}" if cursor else "")
        d = await _get(client, cfg, page)
        out.extend(d.get("data", []))
        pg = d.get("pagination", {}) or {}
        cursor = pg.get("endCursor")
        if not (pg.get("hasNextPage") and cursor):
            break
    return out


async def _reference(client: httpx.AsyncClient, cfg: dict) -> dict:
    """{assets: id->asset, types: id->label} del org, cacheado con TTL.

    assets y defect-types se piden en paralelo y se cachean (cambian poco). Un
    lock por org evita el "thundering herd" cuando dos requests llegan juntos.
    """
    key = cfg["api_token"]
    now = time.monotonic()
    hit = _ref_cache.get(key)
    if hit and hit[0] > now:
        return hit[1]
    lock = _ref_locks.setdefault(key, asyncio.Lock())
    async with lock:
        hit = _ref_cache.get(key)  # re-chequeo: otro request pudo cargarlo
        if hit and hit[0] > now:
            return hit[1]
        assets_list, types_resp = await asyncio.gather(
            _paged(client, cfg, "/assets?limit=512"),
            _get(client, cfg, "/defect-types"),
        )
        ref = {
            "assets": {a["id"]: a for a in assets_list},
            "types": {t["id"]: t.get("label") for t in types_resp.get("data", [])},
        }
        _ref_cache[key] = (time.monotonic() + _REF_TTL, ref)
        return ref


def clear_cache() -> None:
    """Vacía la caché de reference-data (para forzar datos frescos)."""
    _ref_cache.clear()


def _parse_day(raw: str) -> datetime.date | None:
    if not raw:
        return None
    try:
        return datetime.datetime.strptime(raw[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


async def _org_open(
    client: httpx.AsyncClient, cfg: dict, start: str, end: str,
) -> list[dict]:
    """Defectos ABIERTOS de un org (deduplicados, con conteo de repeticiones)."""
    open_only = cfg.get("open_only", True)
    query = f"/defects/stream?startTime={start}&endTime={end}"
    if open_only:
        query += "&isResolved=false"
    # reference-data (cacheada) y defectos, en paralelo.
    ref, defects = await asyncio.gather(
        _reference(client, cfg),
        _paged(client, cfg, query),
    )
    assets, types = ref["assets"], ref["types"]

    seen: dict[tuple, dict] = {}
    for r in defects:
        if open_only and r.get("isResolved"):
            continue
        aref = r.get("vehicle") or r.get("trailer") or {}
        asset = assets.get(aref.get("id"), {})
        name = (asset.get("name") or aref.get("id") or "").strip()
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
                "unit": name, "kind": kind,
                "company": cfg["company"] or company_of(name),
                "detail": f"{dtype} - {comment}" if comment else dtype,
                "notes": (r.get("mechanicNotes") or "").strip(),
                "_day": day or datetime.date(1970, 1, 1), "_n": 1,
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
            "company": rec["company"],
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
    return out


async def load() -> list[dict]:
    """Defectos abiertos en vivo (todos los orgs en paralelo), forma `Defect`.

    Lanza excepción si la API falla; el endpoint la captura y cae al CSV.
    """
    orgs = _orgs()
    if not orgs:
        return []
    now = datetime.datetime.now(datetime.timezone.utc)
    start = (now - datetime.timedelta(days=_LOOKBACK_DAYS)).strftime(
        "%Y-%m-%dT%H:%M:%SZ")
    end = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        per_org = await asyncio.gather(
            *(_org_open(client, cfg, start, end) for cfg in orgs))

    out = [row for sub in per_org for row in sub]
    out.sort(key=lambda d: d["unit"])
    return out


async def _org_window(
    client: httpx.AsyncClient, cfg: dict, start: str, end: str,
    cutoff: datetime.date,
) -> list[dict]:
    """Defectos (abiertos + resueltos) CREADOS en la ventana, para un org."""
    ref, defects = await asyncio.gather(
        _reference(client, cfg),
        _paged(client, cfg, f"/defects/stream?startTime={start}&endTime={end}"),
    )
    assets, types = ref["assets"], ref["types"]

    out: list[dict] = []
    for r in defects:
        aref = r.get("vehicle") or r.get("trailer") or {}
        asset = assets.get(aref.get("id"), {})
        name = (asset.get("name") or aref.get("id") or "").strip()
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
            "company": cfg["company"] or company_of(name),
            "driver": "",
            "unit": name,
            "unit_kind": kind,
            "dvir_type": "",
            "status": "Resolved" if r.get("isResolved") else "Unsafe",
            "detail": detail,
            "mechanic": "",
            "mechanic_notes": (r.get("mechanicNotes") or "").strip(),
        })
    return out


async def load_window(days: int) -> list[dict]:
    """Defectos (ABIERTOS + RESUELTOS) creados en los últimos `days` días, para
    el dashboard (todos los orgs en paralelo). `status` = "Unsafe" (abierto) /
    "Resolved". Lanza excepción si la API falla.
    """
    orgs = _orgs()
    if not orgs:
        return []
    now = datetime.datetime.now(datetime.timezone.utc)
    cutoff = (now - datetime.timedelta(days=max(1, days))).date()
    start = cutoff.strftime("%Y-%m-%dT00:00:00Z")
    end = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        per_org = await asyncio.gather(
            *(_org_window(client, cfg, start, end, cutoff) for cfg in orgs))

    out = [row for sub in per_org for row in sub]
    out.sort(key=lambda d: (d["block_date"], d["unit"]))
    return out
