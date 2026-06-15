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
from . import secretstore

CONF_PATH = Path(__file__).resolve().parents[2] / "samsara.local.json"

# Ventana del stream de defectos abiertos. 270 días (~9 meses) captura todo lo
# abierto vigente y descarta "fantasmas": defectos viejos colgados de assets
# renombrados/duplicados en Samsara (p. ej. "867667 wrong trailer on tracker",
# cuyos defectos son de 2025). Un defecto realmente abierto se re-reporta en
# cada DVIR, así que se mantiene reciente y dentro de esta ventana.
_LOOKBACK_DAYS = 270


def _lookback_days() -> int:
    """Ventana de defectos, configurable por empresa (G7) con fallback
    a los 270 días que filtran los assets fantasma renombrados."""
    from . import org_config
    return org_config.threshold("defect_lookback_days")


_TIMEOUT = 60
_PLACEHOLDER = "PEGA_AQUI"    # token de ejemplo sin configurar

# Caché de "reference data" por org (assets + defect-types): cambia rara vez, así
# que se cachea con TTL largo y se comparte entre load() y load_window(), que
# antes lo pedían por separado. Clave = token del org.
_REF_TTL = 900  # 15 min
_ref_cache: dict[str, tuple[float, dict]] = {}
_ref_locks: dict[str, asyncio.Lock] = {}

# Caché de "última fecha de DVIR por unidad" (para auto-archivo por inactividad).
_DVIR_TTL = 600  # 10 min
_dvir_cache: dict[tuple, tuple[float, dict]] = {}
_dvir_locks: dict[tuple, asyncio.Lock] = {}

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


def _read_config() -> dict:
    # H6 fase 3d-2: las credenciales viven detras de SecretStore (backend de
    # archivos por defecto: backend/samsara.local.json). {} = sin configurar.
    return secretstore.store().get_blob("samsara")


def org_summaries() -> list[dict]:
    """Resumen de los orgs configurados SIN exponer tokens.

    Para el hub de Conectividad de Settings: empresa, host y la cola del
    token (4 chars) como identificador visual.
    """
    out: list[dict] = []
    for o in _orgs():
        out.append({
            "company": o["company"] or "(auto)",
            "base_url": o["base_url"],
            "token_tail": o["api_token"][-4:],
            "trailer_dvirs": o["trailer_dvirs"],
        })
    return out


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
            # ¿A los TRAILERS de este org se les hace DVIR? (Chaser sí, MCC no).
            # Si no, los trailers no se auto-archivan por inactividad de DVIR.
            "trailer_dvirs": bool(o.get("trailer_dvirs", True)),
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
    """Vacía las cachés (reference-data + DVIRs) para forzar datos frescos."""
    _ref_cache.clear()
    _dvir_cache.clear()


# Samsara limita /fleet/dvirs/history a ~31 días por consulta → troceamos.
_DVIR_CHUNK_DAYS = 30
_DVIR_MAX_CHUNKS = 13  # tope de seguridad (~390 días)


async def _last_dvir_by_unit(
    client: httpx.AsyncClient, cfg: dict, days: int,
) -> dict[str, datetime.date]:
    """{id de vehículo -> fecha del DVIR más reciente} en los últimos `days`
    días, leído de `/fleet/dvirs/history`. Se empareja por **id de asset** (no
    por nombre) para no confundir unidades con nombre repetido. La ventana se
    trocea en chunks de ≤30 días (límite de Samsara), pedidos en paralelo.
    Cacheado. Los DVIRs son por vehículo (camión); los tráileres no hacen DVIR.
    """
    key = (cfg["api_token"], days)
    now = time.monotonic()
    hit = _dvir_cache.get(key)
    if hit and hit[0] > now:
        return hit[1]
    lock = _dvir_locks.setdefault(key, asyncio.Lock())
    async with lock:
        hit = _dvir_cache.get(key)
        if hit and hit[0] > now:
            return hit[1]

        # Ventanas consecutivas de ≤30 días que cubren [now - days, now].
        nowdt = datetime.datetime.now(datetime.timezone.utc)
        windows: list[tuple[str, str]] = []
        remaining, end_dt = days, nowdt
        while remaining > 0 and len(windows) < _DVIR_MAX_CHUNKS:
            span = min(_DVIR_CHUNK_DAYS, remaining)
            start_dt = end_dt - datetime.timedelta(days=span)
            windows.append((start_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
                            end_dt.strftime("%Y-%m-%dT%H:%M:%SZ")))
            end_dt = start_dt
            remaining -= span

        chunks = await asyncio.gather(*(
            _paged(client, cfg,
                   f"/fleet/dvirs/history?startTime={s}&endTime={e}")
            for s, e in windows))

        last: dict[str, datetime.date] = {}
        for dvirs in chunks:
            for d in dvirs:
                day = _parse_day(d.get("endTime") or d.get("startTime"))
                if not day:
                    continue
                # Un DVIR cubre el camión y (si está enganchado) el trailer.
                for ref in (d.get("vehicle"), d.get("trailer")):
                    aid = (ref or {}).get("id")
                    if aid and (aid not in last or day > last[aid]):
                        last[aid] = day
        _dvir_cache[key] = (time.monotonic() + _DVIR_TTL, last)
        return last


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
                "asset_id": aref.get("id"),
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
            "asset_id": rec["asset_id"],
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
    start = (now - datetime.timedelta(days=_lookback_days())).strftime(
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
            "asset_id": aref.get("id"),
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


def _classify_unit(name: str, atype: str) -> str | None:
    """Tipo de unidad para el Fleet: 'truck' | 'trailer' | 'chassis'.

    - vehicle  -> truck
    - trailer  -> trailer
    - unpowered: si el nombre es código alfabético (CELL, CELF, G3HX,
      G7VK-4DA-E89…) es un **chassis**; si es numérico (277187, 390002…) es un
      trailer. Si está vacío o dice "deactivated" es **chatarra** -> None
      (gateway suelto / asset dado de baja) y se omite del inventario.
    """
    n = (name or "").strip()
    if atype == "vehicle":
        return "truck"
    if atype == "trailer":
        return "trailer"
    # unpowered
    if not n or "deactivat" in n.lower():
        return None
    return "chassis" if n[0].isalpha() else "trailer"


async def _org_fleet(
    client: httpx.AsyncClient, cfg: dict, start: str, end: str,
    auto_days: int | None,
) -> list[dict]:
    """Inventario de unidades de un org + defectos abiertos + último DVIR."""
    ref, opens = await asyncio.gather(
        _reference(client, cfg),
        _org_open(client, cfg, start, end),
    )
    # Auto-archivo: traer último DVIR por unidad. Es best-effort — si falla, la
    # flota igual carga y NO se auto-archiva nada (evita archivar todo por error).
    last_dvir: dict = {}
    dvir_known = False
    if auto_days:
        try:
            last_dvir = await _last_dvir_by_unit(client, cfg, auto_days)
            dvir_known = True
        except Exception:  # noqa: BLE001
            dvir_known = False

    open_count: dict[str, int] = {}
    for d in opens:
        open_count[d["unit"]] = open_count.get(d["unit"], 0) + 1

    out: list[dict] = []
    for a in ref["assets"].values():
        name = (a.get("name") or "").strip()
        if not name:
            continue
        atype = a.get("type")
        unit_type = _classify_unit(name, atype)
        if unit_type is None:
            continue  # chatarra: gateway suelto / asset dado de baja
        kind = "truck" if atype == "vehicle" else "trailer"
        ld = last_dvir.get(a.get("id"))
        out.append({
            "id": a.get("id"),
            "unit": name,
            "kind": kind,
            "unit_type": unit_type,                    # truck/trailer/chassis
            "asset_type": atype,                       # vehicle/trailer/unpowered
            "company": cfg["company"] or company_of(name),
            "make": (a.get("make") or "").strip(),
            "model": (a.get("model") or "").strip(),
            "year": a.get("year") or "",
            "vin": (a.get("vin") or "").strip(),
            "plate": (a.get("licensePlate") or "").strip(),
            "open_defects": open_count.get(name, 0),
            "last_dvir": ld.isoformat() if ld else None,
            "dvir_known": dvir_known,
            # Elegible para auto-archivo por DVIR: camiones siempre; trailers
            # solo si en ese org se les hace DVIR.
            "auto_eligible": kind == "truck" or cfg.get("trailer_dvirs", True),
        })
    return out


async def list_fleet(auto_days: int | None = None) -> list[dict]:
    """Flota completa (todos los orgs) con datos del asset, defectos abiertos y,
    si `auto_days` viene dado, el último DVIR de cada unidad (para auto-archivo).
    Lanza excepción si la API falla.
    """
    orgs = _orgs()
    if not orgs:
        return []
    now = datetime.datetime.now(datetime.timezone.utc)
    start = (now - datetime.timedelta(days=_lookback_days())).strftime(
        "%Y-%m-%dT%H:%M:%SZ")
    end = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        per_org = await asyncio.gather(
            *(_org_fleet(client, cfg, start, end, auto_days) for cfg in orgs))

    out = [u for sub in per_org for u in sub]
    out.sort(key=lambda u: (u["company"], u["unit"]))
    return out


async def _org_drivers(client: httpx.AsyncClient, cfg: dict) -> list[dict]:
    drivers = await _paged(client, cfg, "/fleet/drivers?limit=512")
    out: list[dict] = []
    for d in drivers:
        if (d.get("driverActivationStatus") or "active") != "active":
            continue
        name = (d.get("name") or "").strip()
        if not name:
            continue
        out.append({
            "id": d.get("id"),
            "name": name,
            "company": cfg["company"] or "—",
            "phone": (d.get("phone") or "").strip(),
            "username": (d.get("username") or "").strip(),
            "license_number": (d.get("licenseNumber") or "").strip(),
            "license_state": (d.get("licenseState") or "").strip(),
        })
    return out


async def _org_odometers(client: httpx.AsyncClient, cfg: dict) -> dict[str, dict]:
    rows = await _paged(
        client, cfg,
        "/fleet/vehicles/stats?types=obdOdometerMeters,gpsOdometerMeters")
    out: dict[str, dict] = {}
    for x in rows:
        name = (x.get("name") or "").strip()
        if not name:
            continue
        obd = (x.get("obdOdometerMeters") or {}).get("value")
        gps = (x.get("gpsOdometerMeters") or {}).get("value")
        if obd:
            out[name] = {"miles": round(obd / 1609.344), "source": "obd"}
        elif gps:
            out[name] = {"miles": round(gps / 1609.344), "source": "gps"}
    return out


async def vehicle_odometers() -> dict[str, dict]:
    """{nombre de unidad -> {miles, source}} con el odómetro actual (obd>gps)."""
    orgs = _orgs()
    if not orgs:
        return {}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        per_org = await asyncio.gather(
            *(_org_odometers(client, cfg) for cfg in orgs))
    out: dict[str, dict] = {}
    for d in per_org:
        out.update(d)
    return out


async def list_drivers() -> list[dict]:
    """Conductores ACTIVOS de todos los orgs (Samsara `/fleet/drivers`)."""
    orgs = _orgs()
    if not orgs:
        return []
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        per_org = await asyncio.gather(
            *(_org_drivers(client, cfg) for cfg in orgs))
    out = [d for sub in per_org for d in sub]
    out.sort(key=lambda d: (d["company"], d["name"]))
    return out


# ---------------------------------------------------------------------------
# Import de reportes desde el ELD (Reporting / fase 2)
# ---------------------------------------------------------------------------
# Produce las MISMAS estructuras que el flujo manual de CSVs (filas de dvir_df
# + activity {unidad: millas}) pero leidas de la API de Samsara, para que
# engine.build_report las consuma igual. Defensivo con los nombres de campo:
# el endpoint diagnostico devuelve una muestra CRUDA para validarlos/ajustarlos
# contra una cuenta real.

_STATUS_MAP = {
    "safe": "Safe", "unsafe": "Unsafe", "resolved": "Resolved",
    "needsresolution": "Unsafe", "safewithdefects": "Unsafe",
}


def _day_window(day: datetime.date) -> tuple[str, str]:
    """Ventana ISO (UTC) que cubre un dia: [00:00, +1d 00:00).
    TODO(tz): el dia operativo es local; por ahora UTC (refinable con la tz
    de la flota)."""
    start = datetime.datetime(day.year, day.month, day.day,
                              tzinfo=datetime.timezone.utc)
    end = start + datetime.timedelta(days=1)
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    return start.strftime(fmt), end.strftime(fmt)


def _orgs_for(company: str | None) -> list[dict]:
    """Orgs aplicables a `company`. None -> todos. Si ninguno matchea
    explicitamente, usa los de company auto y, si tampoco hay, todos."""
    orgs = _orgs()
    if not company:
        return orgs
    cu = company.strip().upper()
    exact = [o for o in orgs if (o.get("company") or "").upper() == cu]
    if exact:
        return exact
    auto = [o for o in orgs if not o.get("company")]
    return auto or orgs


def _name_of(ref: dict | None, assets: dict) -> str:
    ref = ref or {}
    name = (ref.get("name") or "").strip()
    if name:
        return name
    aid = ref.get("id")
    return (assets.get(aid, {}).get("name") or "").strip() if aid else ""


def _author_of(d: dict) -> str:
    for k in ("driver", "author", "createdBy", "signedBy"):
        v = d.get(k)
        if isinstance(v, dict) and (v.get("name") or "").strip():
            return v["name"].strip()
    for k in ("driverName", "authorName"):
        if str(d.get(k) or "").strip():
            return str(d[k]).strip()
    return ""


def _status_of(d: dict) -> str:
    raw = str(d.get("safetyStatus") or d.get("status") or "").strip().lower()
    return _STATUS_MAP.get(raw.replace("_", ""), raw.title() or "Safe")


def _defect_details(d: dict) -> str:
    items = d.get("vehicleDefects") or d.get("defects") or []
    out = []
    for it in items:
        if isinstance(it, dict):
            c = (it.get("comment") or it.get("description")
                 or it.get("defectType") or "").strip()
            if c:
                out.append(c)
    return "; ".join(out)


def _dvir_to_row(d: dict, assets: dict) -> dict:
    """Un DVIR de Samsara -> fila con las columnas del dvir_df del engine."""
    veh = _name_of(d.get("vehicle"), assets)
    trl = _name_of(d.get("trailer"), assets)
    signed = (d.get("time") or d.get("endTime") or d.get("startTime")
              or (d.get("signature") or {}).get("signedAtTime") or "")
    details = _defect_details(d)
    return {
        "Vehicle Name": veh,
        "Trailer": trl,
        "Author": _author_of(d),
        "Signed At": str(signed),
        "Status": _status_of(d),
        "Type": str(d.get("inspectionType") or "").strip(),
        "Vehicle Defect Details": details if veh else "",
        "Trailer Defect Details": details if (trl and not veh) else "",
        "Mechanic Notes": "",
    }


async def _org_dvir_rows(
    client: httpx.AsyncClient, cfg: dict, day: datetime.date,
) -> tuple[list[dict], list[dict]]:
    s, e = _day_window(day)
    ref, dvirs = await asyncio.gather(
        _reference(client, cfg),
        _paged(client, cfg,
               f"/fleet/dvirs/history?startTime={s}&endTime={e}"),
    )
    assets = ref["assets"]
    rows = [_dvir_to_row(d, assets) for d in dvirs]
    return rows, dvirs[:3]          # filas parseadas + muestra cruda


async def _org_day_distance(
    client: httpx.AsyncClient, cfg: dict, day: datetime.date,
) -> tuple[dict[str, float], list[dict]]:
    s, e = _day_window(day)
    rows = await _paged(
        client, cfg,
        "/fleet/vehicles/stats/history"
        f"?types=gpsDistanceMeters&startTime={s}&endTime={e}")
    out: dict[str, float] = {}
    for x in rows:
        name = (x.get("name") or "").strip()
        if not name:
            continue
        series = x.get("gpsDistanceMeters") or []
        vals = [p.get("value") for p in series
                if isinstance(p, dict) and p.get("value") is not None]
        if len(vals) >= 2:                      # delta = distancia del dia
            out[name] = round((max(vals) - min(vals)) / 1609.344, 1)
    return out, rows[:3]


async def report_dvir_rows(
    company: str | None, day: datetime.date,
) -> list[dict]:
    orgs = _orgs_for(company)
    if not orgs:
        return []
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        per = await asyncio.gather(
            *(_org_dvir_rows(client, cfg, day) for cfg in orgs))
    return [r for rows, _ in per for r in rows]


async def report_day_distance(
    company: str | None, day: datetime.date,
) -> dict[str, float]:
    orgs = _orgs_for(company)
    if not orgs:
        return {}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        per = await asyncio.gather(
            *(_org_day_distance(client, cfg, day) for cfg in orgs))
    out: dict[str, float] = {}
    for d, _ in per:
        out.update(d)
    return out


async def report_eld_diagnostic(
    company: str | None, day: datetime.date,
) -> dict:
    """Trae DVIR + distancia del dia y devuelve lo PARSEADO + una muestra
    CRUDA de Samsara y los errores, para validar/ajustar los nombres de
    campo antes de armar el reporte encima."""
    orgs = _orgs_for(company)
    if not orgs:
        return {"available": False, "detail": "Samsara not configured",
                "dvir_rows": [], "distance": {}, "raw": {}, "errors": []}
    errors: list[str] = []
    dvir_rows: list[dict] = []
    distance: dict[str, float] = {}
    raw_dvir: list[dict] = []
    raw_stats: list[dict] = []
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for cfg in orgs:
            tag = cfg.get("company") or "auto"
            try:
                rows, sample = await _org_dvir_rows(client, cfg, day)
                dvir_rows += rows
                raw_dvir += sample
            except Exception as exc:  # noqa: BLE001
                errors.append(f"DVIR ({tag}): {exc}")
            try:
                dist, dsample = await _org_day_distance(client, cfg, day)
                distance.update(dist)
                raw_stats += dsample
            except Exception as exc:  # noqa: BLE001
                errors.append(f"distance ({tag}): {exc}")
    return {
        "available": True,
        "day": day.isoformat(),
        "company": company,
        "dvir_count": len(dvir_rows),
        "dvir_rows": dvir_rows[:200],
        "distance_count": len(distance),
        "distance": dict(list(distance.items())[:200]),
        "raw": {"dvir_sample": raw_dvir, "stats_sample": raw_stats},
        "errors": errors,
    }

