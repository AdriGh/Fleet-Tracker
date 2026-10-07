# -*- coding: utf-8 -*-
"""Defectos ABIERTOS desde los exports de Samsara (CSV).

Carga temporal mientras se conecta la API de Samsara. Lee TODOS los archivos
`backend/open_defects*.local.csv` (uno por empresa, p.ej.
`open_defects.chaser.local.csv` y `open_defects.mcc.local.csv`; export "Driver
Vehicle Inspection Reports - defects": columnas Asset Name, Asset ID, Defect
Created At, Defect Type, Comment, DVIR ID) y devuelve, por defecto distinto, una
fila con la misma forma que `db.list_defects` para que el frontend lo consuma
igual. La empresa se deduce por el prefijo de la unidad (no por el archivo).

Cada fila del CSV es un defecto abierto (el export no trae estado), así que
todas salen con `status = "Open"`. Se deduplican los re-reportes diarios del
mismo defecto (misma unidad + tipo + comentario), quedándose con la fecha más
reciente.
"""

import csv
import datetime
import re
from pathlib import Path

CSV_DIR = Path(__file__).resolve().parents[2]
CSV_GLOB = "open_defects*.local.csv"


def _csv_files() -> list[Path]:
    return sorted(CSV_DIR.glob(CSV_GLOB))

# Prefijo de terminal → empresa MCC (Memphis City Cartage). Sin prefijo → CHASER.
_TERMINAL = re.compile(r"^(MEM|MDW|ATL|SAV|MIA)[-\s]", re.IGNORECASE)
_DATE = re.compile(r"([A-Za-z]{3})\s+(\d+),\s+(\d{4})")

# Re-inspecciones sin novedad: no son defectos reales, se descartan del conteo.
_NOISE = re.compile(
    r"^(previous inspection|nothing\s*(has\s*)?chang|same(\s|$|,|\.)|"
    r"no\s*chang|still the same|everything still|all (still )?the same|"
    r"same as before|same issues|same status)", re.IGNORECASE)


def _is_noise(comment: str) -> bool:
    return bool(_NOISE.match((comment or "").strip()))


def company_of(unit: str) -> str:
    return "MCC" if _TERMINAL.match(unit or "") else "CHASER"


# Tipos de defecto que solo existen en un tráiler → señal fuerte de tráiler.
_TRAILER_TYPES = {"landing gear", "coupling devices", "kingpin"}


def infer_kind(unit: str, dtypes: set[str]) -> str:
    """Deduce camión vs tráiler (el export de Samsara no trae el tipo).

    1) Si la unidad tiene un defecto exclusivo de tráiler (landing gear,
       coupling devices, kingpin) → tráiler.
    2) Si no, por el nombre: los tractores llevan prefijo de letras
       (CI/CF/CK/RMF…), los tráileres son numéricos. Se ignora el prefijo de
       terminal (MEM-/MDW-/…) antes de mirar el primer carácter.
    """
    if any((t or "").strip().lower() in _TRAILER_TYPES for t in dtypes):
        return "trailer"
    core = _TERMINAL.sub("", (unit or "").strip())
    return "trailer" if core[:1].isdigit() else "truck"


def _parse_date(raw: str) -> datetime.date | None:
    m = _DATE.search(raw or "")
    if not m:
        return None
    try:
        return datetime.datetime.strptime(
            f"{m.group(1)} {m.group(2)} {m.group(3)}", "%b %d %Y").date()
    except ValueError:
        return None


def is_available() -> bool:
    return bool(_csv_files())


def load() -> list[dict]:
    """Lista de defectos abiertos (deduplicados) con forma de `Defect`.

    Combina todos los `open_defects*.local.csv`; la deduplicación es global
    (misma unidad + tipo + comentario), así que si una unidad apareciera en dos
    archivos no se cuenta doble.
    """
    files = _csv_files()
    if not files:
        return []

    # clave (unidad, tipo, comentario normalizado) -> registro acumulado
    seen: dict[tuple, dict] = {}
    for path in files:
        with path.open(encoding="utf-8-sig", newline="") as fh:
            for row in csv.DictReader(fh):
                unit = (row.get("Asset Name") or "").strip()
                if not unit:
                    continue
                dtype = (row.get("Defect Type") or "").strip()
                comment = (row.get("Comment") or "").strip()
                if _is_noise(comment):
                    continue
                key = (unit, dtype, comment.lower())
                day = _parse_date(row.get("Defect Created At", ""))

                cur = seen.get(key)
                if cur is None:
                    seen[key] = {
                        "unit": unit,
                        "dtype": dtype,
                        "detail": f"{dtype} - {comment}" if comment else dtype,
                        "_day": day or datetime.date(1970, 1, 1),
                        "_n": 1,
                    }
                else:
                    cur["_n"] += 1
                    if day and day > cur["_day"]:
                        cur["_day"] = day

    # Tipo (camión/tráiler) por unidad, a partir de todos sus defectos.
    unit_types: dict[str, set[str]] = {}
    for rec in seen.values():
        unit_types.setdefault(rec["unit"], set()).add(rec["dtype"])
    unit_kind = {u: infer_kind(u, ts) for u, ts in unit_types.items()}

    out: list[dict] = []
    for rec in seen.values():
        day = rec["_day"]
        out.append({
            "date_label": f"{day.month}.{day.day}",
            "block_date": day.isoformat(),
            "company": company_of(rec["unit"]),
            "driver": "",
            "unit": rec["unit"],
            "unit_kind": unit_kind[rec["unit"]],
            "dvir_type": "",
            "status": "Open",
            "detail": rec["detail"],
            "reports": rec["_n"],
            "mechanic": "",
            "mechanic_notes": "",
        })
    # orden estable por unidad
    out.sort(key=lambda d: d["unit"])
    return out


async def current_feed(refresh: bool = False) -> dict:
    """Feed ACTUAL de defectos abiertos (fuente única de GET /dvir/open-defects
    y del sync de Service Requests, v2.20).

    Prefiere la API de Samsara en vivo (o el ELD demo); si no hay token o la
    API falla, cae al export CSV local. Las empresas que Samsara no cubre
    (p.ej. MCC) siguen viniendo del CSV, y se excluyen los assets archivados.
    Devuelve {available, source, defects[, live_companies][, error]}: la
    presencia de `error` indica que fue un FALLBACK por falla (el sync de
    Service Requests no debe dar por resuelto nada con ese feed)."""
    # import diferido (ciclo: samsara importa este módulo a nivel módulo)
    from . import app_config, samsara
    if refresh:
        samsara.clear_cache()
    csv_rows = load()
    if samsara.is_available():
        try:
            live = await samsara.load()
            # Samsara cubre algunos orgs (p.ej. Chaser); las empresas que NO
            # estén en el org de Samsara (p.ej. MCC) siguen viniendo del CSV.
            covered = {d["company"] for d in live}
            merged = live + [d for d in csv_rows if d["company"] not in covered]
            # Excluir assets archivados (p.ej. duplicados/mal etiquetados en
            # Samsara): no deben contar en el backlog de defectos.
            archived = set(app_config.archived_ids())
            merged = [d for d in merged if d.get("asset_id") not in archived]
            merged.sort(key=lambda d: d["unit"])
            return {
                "available": True,
                "source": "samsara",
                "live_companies": sorted(covered),
                "defects": merged,
            }
        except Exception as exc:  # noqa: BLE001 — fallback ante cualquier fallo
            return {
                "available": is_available(),
                "source": "csv",
                "error": f"Samsara did not respond ({exc}); using local CSV.",
                "defects": csv_rows,
            }
    return {
        "available": is_available(),
        "source": "csv",
        "defects": csv_rows,
    }
