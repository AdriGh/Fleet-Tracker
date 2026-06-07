"""Endpoints de la API del generador de informes DVIR."""

import io
import re
import uuid
from datetime import date, timedelta

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .. import __version__, config, db
from pydantic import BaseModel

from ..core import (
    app_config, batch, driver_contacts, engine, excel, notify_service,
    open_defects, pm, pretrip, samsara,
)
from ..core.contacts import name_key
from ..schemas import (
    BatchAnalyzeResponse,
    BatchGenerateRequest,
    BatchGenerateResponse,
    BatchSheetStat,
    HealthResponse,
    NotifySendRequest,
    RosterEntry,
)

router = APIRouter(prefix="/api")

# Almacen en memoria de Excel generados: id -> {path, filename}.
_jobs: dict[str, dict] = {}
# Sesiones de lote: batch_id -> {file_id: (name, bytes)}.
_batches: dict[str, dict[str, tuple[str, bytes]]] = {}


@router.get("/health", response_model=HealthResponse)
def health():
    return HealthResponse(status="ok", version=__version__)


@router.get("/roster", response_model=list[RosterEntry])
def get_roster():
    """Devuelve el roster camion->conductor por defecto."""
    roster = engine.load_roster(
        config.DEFAULT_ROSTER if config.DEFAULT_ROSTER.exists() else None)
    return [RosterEntry(truck=t, driver=d) for t, d in sorted(roster.items())]


def _safe_label(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "-", text.strip()) or "informe"


@router.get("/reports/{report_id}/download")
def download_report(report_id: str):
    """Descarga el Excel generado."""
    job = _jobs.get(report_id)
    if not job or not job["path"].exists():
        raise HTTPException(404, "Informe no encontrado o expirado.")
    return FileResponse(
        job["path"],
        filename=job["filename"],
        media_type=("application/vnd.openxmlformats-officedocument"
                    ".spreadsheetml.sheet"),
    )


# ---------------------------------------------------------------------------
# Lote: analisis y generacion
# ---------------------------------------------------------------------------
def _date_key(date_label: str) -> tuple[int, int]:
    parts = re.findall(r"\d+", date_label)
    month = int(parts[0]) if parts else 0
    day = int(parts[1]) if len(parts) > 1 else 0
    return (month, day)


@router.post("/batch/analyze", response_model=BatchAnalyzeResponse)
async def batch_analyze(files: list[UploadFile] = File(...)):
    """Recibe varios CSV, los clasifica y propone el emparejado."""
    if not files:
        raise HTTPException(422, "No se subio ningun archivo.")

    batch_id = uuid.uuid4().hex
    store: dict[str, tuple[str, bytes]] = {}
    analyzed = []
    for upload in files:
        file_id = uuid.uuid4().hex
        raw = await upload.read()
        name = upload.filename or file_id
        store[file_id] = (name, raw)
        analyzed.append(batch.AnalyzedFile(file_id, name, raw))

    _batches[batch_id] = store
    result = batch.pair_blocks(analyzed)
    return BatchAnalyzeResponse(batch_id=batch_id, **result)


@router.post("/batch/generate", response_model=BatchGenerateResponse)
def batch_generate(req: BatchGenerateRequest):
    """Genera el workbook, lo guarda y persiste cada bloque en la BD."""
    store = _batches.get(req.batch_id)
    if store is None:
        raise HTTPException(404, "Lote no encontrado o expirado.")
    if not req.blocks:
        raise HTTPException(422, "No hay bloques que generar.")

    roster = engine.load_roster(
        config.DEFAULT_ROSTER if config.DEFAULT_ROSTER.exists() else None)

    by_company: dict[str, list] = {}
    warnings: list[str] = []
    for block in req.blocks:
        dvir = store.get(block.dvir_file_id)
        activity = store.get(block.activity_file_id)
        if dvir is None or activity is None:
            raise HTTPException(
                422, f"Bloque {block.company} {block.date_label}: "
                     "falta el CSV de DVIR o de actividad.")
        # El report de Pre/Post-trip es opcional: si falta, las filas quedan
        # como NO PRE-TRIP.
        pt_file = store.get(block.pretrip_file_id) if block.pretrip_file_id \
            else None
        try:
            dvir_df = engine.load_dvir(io.BytesIO(dvir[1]))
            activity_data = engine.load_activity(io.BytesIO(activity[1]))
            pretrip_data = pretrip.load_pretrip_bytes(pt_file[1]) \
                if pt_file else {}
            groups = engine.build_report(
                dvir_df, activity_data, roster, engine.MIN_MILES,
                block.company, pretrip_data)
        except engine.ReportError as exc:
            raise HTTPException(
                422, f"Bloque {block.company} {block.date_label}: "
                     f"{exc}") from exc

        by_company.setdefault(block.company, []).append(
            (block.date_label, groups))

        metrics = engine.block_metrics(dvir_df, groups)
        if engine.dvir_looks_incomplete(groups):
            warnings.append(
                f"Bloque {block.company} {block.date_label}: "
                f"{metrics['n_no_dvir']} filas NO DVIR frente a "
                f"{len(groups) - metrics['n_no_dvir']} con DVIR "
                "— revisa que el CSV de DVIR este completo.")

        month, day = _date_key(block.date_label)
        try:
            block_date = date(engine.data_year(dvir_df), month or 1,
                              day or 1)
        except ValueError:
            block_date = date(engine.data_year(dvir_df), 1, 1)
        defects = engine.extract_defects(dvir_df)
        db.save_block(block.company, block.date_label, block_date,
                      groups, metrics, defects)

    sheets = []
    stats = []
    for company in sorted(by_company):
        blocks = sorted(by_company[company], key=lambda b: _date_key(b[0]))
        month = _date_key(blocks[0][0])[0] if blocks else None
        name = batch.sheet_name(company, month)
        sheets.append({
            "name": name,
            "blocks": [{"date_label": dl, "groups": g}
                       for dl, g in blocks],
        })
        stats.append(BatchSheetStat(
            company=company,
            sheet_name=name,
            blocks=len(blocks),
            drivers=sum(len(g) for _, g in blocks),
            no_dvir=sum(1 for _, g in blocks for grp in g
                        for r in grp["rows"] if r["is_nodvir"]),
        ))

    report_id = uuid.uuid4().hex
    months = {s["name"].split()[-1] for s in sheets}
    suffix = months.pop() if len(months) == 1 else "lote"
    filename = f"DVIR Report {suffix}.xlsx"
    out_path = config.JOBS_DIR / f"{report_id}.xlsx"
    excel.write_workbook(sheets, out_path)
    _jobs[report_id] = {"path": out_path, "filename": filename}

    return BatchGenerateResponse(id=report_id, filename=filename,
                                 sheets=stats, warnings=warnings)


# ---------------------------------------------------------------------------
# Panel DVIR
# ---------------------------------------------------------------------------
@router.get("/dvir/recent")
def dvir_recent(limit: int = 5, sort: str = "created_at"):
    """Ultimos bloques generados, ordenables por las metricas."""
    return db.recent_blocks(limit=limit, sort=sort)


@router.get("/dvir/missing")
def dvir_missing(limit: int = 10):
    """Top de conductores sin DVIR en el mes del bloque mas reciente."""
    return db.missing_drivers(limit=limit)


@router.get("/dvir/summary")
def dvir_summary():
    """Resumen del mes: % de flota SAFE promedio."""
    return db.month_summary()


@router.get("/dvir/defects")
def dvir_defects(company: str | None = None, status: str | None = None,
                 unit: str | None = None):
    """Defectos reportados en los DVIR, con filtros."""
    return db.list_defects(company=company or None, status=status or None,
                           unit=unit or None)


@router.get("/dvir/open-defects")
async def dvir_open_defects(refresh: bool = False):
    """Defectos ABIERTOS. Prefiere la API de Samsara en vivo; si no hay token
    o la API falla, cae al export CSV local. Devuelve filas con la misma forma
    que /dvir/defects (status = "Open")."""
    if refresh:
        samsara.clear_cache()
    csv_rows = open_defects.load()
    if samsara.is_available():
        try:
            live = await samsara.load()
            # Samsara cubre algunos orgs (p.ej. Chaser); las empresas que NO
            # estén en el org de Samsara (p.ej. MCC) siguen viniendo del CSV.
            covered = {d["company"] for d in live}
            merged = live + [d for d in csv_rows if d["company"] not in covered]
            merged.sort(key=lambda d: d["unit"])
            return {
                "available": True,
                "source": "samsara",
                "live_companies": sorted(covered),
                "defects": merged,
            }
        except Exception as exc:  # noqa: BLE001 — fallback ante cualquier fallo
            return {
                "available": open_defects.is_available(),
                "source": "csv",
                "error": f"Samsara no respondió ({exc}); usando CSV local.",
                "defects": csv_rows,
            }
    return {
        "available": open_defects.is_available(),
        "source": "csv",
        "defects": csv_rows,
    }


@router.get("/dvir/defect-stats")
async def dvir_defect_stats(days: int = 7, refresh: bool = False):
    """Defectos (abiertos + resueltos) creados en los últimos `days` días, para
    el dashboard. status = "Unsafe" (abierto) / "Resolved" (resuelto). Empresas
    fuera del org de Samsara (p.ej. MCC) se completan con el CSV (como abiertas).
    """
    days = max(1, min(int(days), 365))
    if refresh:
        samsara.clear_cache()
    if samsara.is_available():
        try:
            rows = await samsara.load_window(days)
            live_co = {d["company"] for d in rows}
            cutoff = (date.today() - timedelta(days=days)).isoformat()
            for d in open_defects.load():
                if d["company"] not in live_co and d["block_date"] >= cutoff:
                    rows.append({**d, "status": "Unsafe"})
            return {
                "available": True,
                "source": "samsara",
                "days": days,
                "live_companies": sorted(live_co),
                "defects": rows,
            }
        except Exception as exc:  # noqa: BLE001 — fallback ante cualquier fallo
            return {
                "available": open_defects.is_available(),
                "source": "csv",
                "days": days,
                "error": f"Samsara no respondió ({exc}); usando CSV local.",
                "defects": [{**d, "status": "Unsafe"} for d in open_defects.load()],
            }
    return {
        "available": open_defects.is_available(),
        "source": "csv",
        "days": days,
        "defects": [{**d, "status": "Unsafe"} for d in open_defects.load()],
    }


class SettingsIn(BaseModel):
    auto_archive_enabled: bool = False
    auto_archive_days: int = 30


class ArchiveIn(BaseModel):
    id: str
    action: str  # archive | unarchive | keep_active | auto


@router.get("/settings")
def get_settings():
    """Configuración de la app (por ahora: archivo de unidades)."""
    return app_config.get_settings()


@router.post("/settings")
def update_settings(body: SettingsIn):
    return app_config.set_settings(body.auto_archive_enabled,
                                   body.auto_archive_days)


@router.post("/fleet/archive")
def fleet_archive(body: ArchiveIn):
    try:
        app_config.apply_action(body.id, body.action)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True}


@router.get("/fleet")
async def fleet(refresh: bool = False):
    """Inventario de la flota (todas las unidades de Samsara) con datos del
    asset, defectos abiertos y estado de archivo (manual o auto por inactividad
    de DVIR). Solo Samsara (sin fallback CSV).
    """
    if refresh:
        samsara.clear_cache()
    if not samsara.is_available():
        return {"available": False, "source": "none", "units": [], "settings": app_config.get_settings()}
    st = app_config.get_settings()
    arch = app_config.archived_ids()
    keep = app_config.kept_active_ids()
    auto_days = st["auto_archive_days"] if st["auto_archive_enabled"] else None
    try:
        units = await samsara.list_fleet(auto_days)
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "source": "error",
                "error": str(exc), "units": [], "settings": st}

    for u in units:
        uid = str(u.get("id"))
        if uid in arch:
            u["archived"], u["archive_reason"] = True, "manual"
        elif (auto_days and u.get("dvir_known") and u.get("auto_eligible")
              and not u.get("last_dvir") and uid not in keep):
            u["archived"], u["archive_reason"] = True, "auto"
        else:
            u["archived"], u["archive_reason"] = False, None

    return {
        "available": True,
        "source": "samsara",
        "settings": st,
        "archived_count": sum(1 for u in units if u["archived"]),
        "units": units,
    }


@router.get("/drivers")
async def drivers_endpoint(refresh: bool = False):
    """Conductores activos (Samsara) + email del snapshot local de Driver info.
    El email NO se lee en vivo; viene del snapshot (ver /drivers/sync-contacts).
    """
    if refresh:
        samsara.clear_cache()
    if not samsara.is_available():
        return {"available": False, "source": "none", "drivers": [],
                "contacts": driver_contacts.info()}
    try:
        drivers = await samsara.list_drivers()
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "source": "error",
                "error": str(exc), "drivers": [],
                "contacts": driver_contacts.info()}
    book = driver_contacts.load()
    overrides = driver_contacts.manual()
    for d in drivers:
        k = name_key(d["name"])
        d["email"] = overrides.get(k) or (book.get(k) or {}).get("email", "")
    return {"available": True, "source": "samsara",
            "contacts": driver_contacts.info(), "drivers": drivers}


@router.post("/drivers/sync-contacts")
def drivers_sync_contacts():
    """Sincroniza el snapshot local de emails desde la hoja `Driver info`."""
    try:
        return driver_contacts.sync_from_sheet()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


class DriverEmailIn(BaseModel):
    name: str
    email: str


@router.post("/drivers/email")
def set_driver_email(body: DriverEmailIn):
    """Override manual del email de un conductor (sobrevive a la sync)."""
    driver_contacts.set_email(body.name, body.email)
    return {"ok": True}


@router.get("/pm")
async def pm_tracker(refresh: bool = False):
    """Tracker de PM: último PM (del CSV de Fullbay) + odómetro actual de Samsara
    → millas hasta el próximo PM (cada 20.000 millas)."""
    if refresh:
        samsara.clear_cache()
    records = pm.load()
    if not records:
        return {"available": False, "interval": pm.INTERVAL_MILES,
                "units": [], "excluded": []}
    ov = pm.load_overrides()
    odo: dict = {}
    if samsara.is_available():
        try:
            odo = await samsara.vehicle_odometers()
        except Exception:  # noqa: BLE001
            odo = {}

    out: list[dict] = []
    excluded: list[dict] = []
    for r in records:
        ou = ov.get(r["unit"], {})
        if ou.get("exclude"):
            excluded.append({"unit": r["unit"], "model": r["model"]})
            continue
        # Millaje actual: override manual > Samsara (obd/gps) > meter del reporte.
        if ou.get("current_miles") is not None:
            current, source = int(ou["current_miles"]), "manual"
        else:
            o = odo.get(r["unit"])
            current = o["miles"] if o else r.get("report_miles")
            source = o["source"] if o else (
                "report" if r.get("report_miles") else None)
        last = ou.get("last_pm_miles", r["last_pm_miles"])
        next_due = last + pm.INTERVAL_MILES if last is not None else None
        remaining = (next_due - current
                     if next_due is not None and current is not None else None)
        out.append({
            **r,
            "last_pm_miles": last,
            "last_pm_overridden": "last_pm_miles" in ou,
            "current_miles": current,
            "current_source": source,
            "current_overridden": "current_miles" in ou,
            "next_due_miles": next_due,
            "remaining": remaining,
        })
    out.sort(key=lambda x: x["remaining"] if x["remaining"] is not None else 1e12)
    return {"available": True, "interval": pm.INTERVAL_MILES,
            "units": out, "excluded": sorted(excluded, key=lambda e: e["unit"])}


class PMOverrideIn(BaseModel):
    unit: str
    field: str           # current_miles | last_pm_miles
    value: int | None = None


@router.post("/pm/override")
def pm_set_override(body: PMOverrideIn):
    try:
        pm.set_override(body.unit, body.field, body.value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True}


class PMExcludeIn(BaseModel):
    unit: str
    excluded: bool


@router.post("/pm/exclude")
def pm_set_excluded(body: PMExcludeIn):
    pm.set_excluded(body.unit, body.excluded)
    return {"ok": True}


@router.get("/dvir/trends")
def dvir_trends():
    """Serie diaria del mes (% SAFE, NO DVIR, Unsafe)."""
    return db.trends()


@router.get("/dvir/drivers/{name}")
def dvir_driver(name: str):
    """Historial de cumplimiento y defectos de un conductor."""
    return db.driver_history(name)


@router.get("/dvir/blocks/{block_id}")
def dvir_block(block_id: int):
    """Datos de un bloque guardado, para la vista previa."""
    block = db.get_block(block_id)
    if block is None:
        raise HTTPException(404, "Bloque no encontrado.")
    block["columns"] = engine.COLUMNS
    return block


@router.get("/dvir/blocks/{block_id}/download")
def dvir_block_download(block_id: int):
    """Genera y descarga el Excel de un bloque guardado."""
    block = db.get_block(block_id)
    if block is None:
        raise HTTPException(404, "Bloque no encontrado.")
    report_id = uuid.uuid4().hex
    filename = (f"DVIR {block['company']} "
                f"{_safe_label(block['date_label'])}.xlsx")
    out_path = config.JOBS_DIR / f"{report_id}.xlsx"
    excel.write_excel(block["groups"], block["company"],
                      block["date_label"], out_path)
    return FileResponse(
        out_path,
        filename=filename,
        media_type=("application/vnd.openxmlformats-officedocument"
                    ".spreadsheetml.sheet"),
    )


# ---------------------------------------------------------------------------
# Avisos de NO DVIR
# ---------------------------------------------------------------------------
@router.get("/notify/blocks")
def notify_blocks():
    """Bloques disponibles + estado (modo offline/live, Gmail configurado)."""
    return notify_service.list_blocks()


@router.get("/notify/scan")
def notify_scan(sheet: str, date: str):
    """Escanea un bloque: avisos a enviar y a revisar."""
    try:
        return notify_service.scan(sheet, date)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post("/notify/send")
def notify_send(req: NotifySendRequest):
    """Envia (o simula) los avisos de los conductores seleccionados."""
    if not req.drivers:
        raise HTTPException(422, "No se seleccionó ningún conductor.")
    try:
        return notify_service.send(req.sheet, req.date_label, req.drivers)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
