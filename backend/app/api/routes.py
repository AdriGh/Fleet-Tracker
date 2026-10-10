"""Endpoints de la API del generador de informes DVIR."""

import asyncio
import base64
import io
import re
import uuid
from datetime import date, datetime, timedelta

import httpx

from fastapi import (
    APIRouter, File, Form, HTTPException, Query, Request, UploadFile,
)
from fastapi.responses import FileResponse, Response

from .. import __version__, config, db
from pydantic import BaseModel

from fastapi import Header

from ..core import (
    alerts, app_config, auth, batch, companies, cores, docscan,
    demo_eld, driver_contacts, engine, evidence,
    excel, fleet_inventory, integrations_admin, inventory, local_config,
    lynx, mailer, maint,
    manual_units, media_host, meters, notify_service, odometer,
    open_defects,
    org_config,
    parts, parts_marketplace, permissions, pm, pois, pretrip, providers,
    purchasing, ratelimit, reefer,
    reports, report_assistant, report_engine, report_export,
    report_library, report_registry, report_saved, report_schedules,
    samsara,
    sms_service,
    teams,
    telegram_notify, terminals, thermoking, tms, traccar, tracking,
    setup_status as setup_status_core,
    service_requests, smart_fill, technicians,
    customers as customers_core, home as home_core, pii,
    search as search_core,
    unit_photos, unit_settings, unitdocs, vendors as vendors_core,
    vin_decode, warranty,
    wo_invoice, wo_invoices, workorders,
)
from ..core import notice_templates
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


def _mask_email(e: str) -> str:
    # v2.22: una sola implementación del enmascarado (core/pii), compartida
    # con customers, empleados y la búsqueda global.
    return pii.mask_email(e)


def _mask_phone(p: str) -> str:
    return pii.mask_phone(p)


# ---------------------------------------------------------------------------
# Reports & Analytics (Increment A): gasto de mantenimiento agregado
# ---------------------------------------------------------------------------
# Lectura (GET): el middleware exige solo estar autenticado (sin scope extra),
# igual que el resto de los GET. El filtro por terminal espeja a las otras
# rutas (terminals.resolve). Rango vacio o sin datos => ceros y arrays vacios.
@router.get("/reports/spend")
def reports_spend(from_: str = Query("", alias="from"), to: str = "",
                  terminal: str = "", top_units: int = 10,
                  top_parts: int = 10):
    """Gasto de mantenimiento agregado para charts.

    Query params:
      - from / to: 'YYYY-MM-DD' (inclusive; vacios = sin limite).
      - terminal: clave de terminal (Settings -> Terminals); vacio = todas.
      - top_units / top_parts: tamano de esos rankings (default 10).

    `from` es palabra reservada en Python, asi que el parametro se declara
    `from_` con alias de query 'from'. Devuelve totals + arrays {label,value}
    listos para graficar."""
    return reports.spend_report(
        date_from=from_, date_to=to, terminal=terminal,
        top_units=top_units, top_parts=top_parts)


# Cost per mile (v2.8): gasto de WOs / millas del odómetro persistido. GET es
# lectura (basta autenticado). El POST /refresh materializa lecturas (backfill
# de WO/PM + snapshot Samsara) => maint.edit vía _scope_for (/api/reports).
@router.get("/reports/cpm")
def reports_cpm(from_: str = Query("", alias="from"), to: str = "",
                terminal: str = ""):
    """Cost-per-mile de mantenimiento por flota y por unidad.

    Solo agrega al Fleet CPM las unidades CON millas en el rango; el resto se
    reporta aparte (units_without_miles). `coverage.since` dice desde cuándo hay
    datos (no hay backfill previo al primer registro de odómetro)."""
    return reports.cpm_report(date_from=from_, date_to=to, terminal=terminal)


@router.get("/reports/pm-compliance")
async def reports_pm_compliance():
    """Cumplimiento de PM fleet-wide agrupado por variante de motor (DD13/
    DD15, ISX, genérico) + DOT (v2.18). La selección conjunto/separado/
    selectivo la hace el cliente sobre esta única respuesta."""
    return await maint.pm_compliance()


@router.get("/reports/driver-compliance")
async def reports_driver_compliance():
    """Compliance de conductores AGREGADO (vino de la página Driver Compliance,
    que se eliminó a favor del buscador + drawer). Vencimientos por documento,
    fechas faltantes, mix de roles, cobertura de equipo y la cola de quiénes hay
    que perseguir. Sin PII de contacto: es un reporte compartible."""
    return reports.driver_compliance_report(await tms.list_drivers())


@router.post("/reports/cpm/refresh")
async def reports_cpm_refresh():
    """Recalcula la base de millas: backfilllea odómetro de los mileage ya
    cargados en WOs/PM y toma un snapshot del odómetro de Samsara. Idempotente.
    Útil tras cargar millaje a mano. Devuelve cuántas lecturas agregó."""
    backfilled = odometer.backfill_from_history()
    seeded = odometer.seed_demo_history()      # no-op salvo en modo demo
    snapped = await odometer.snapshot_now()
    return {"backfilled": backfilled + seeded, "snapshot": snapped,
            "coverage": odometer.coverage()}


# ---------------------------------------------------------------------------
# Reports v2.22: biblioteca de sistema, builder, guardados, favoritos,
# envíos programados, export y asistente de IA ("Ask Rigsmith").
# ---------------------------------------------------------------------------
# RBAC (main._scope_for): run / export / assistant / saved / favorites =
# basta estar autenticado (la ruta exige maint.edit para compartir con la
# org o tocar reportes 'org' ajenos); schedules = maint.edit. Van ANTES de
# /reports/{report_id}/download (jobs de DVIR) para no chocar de forma.

class ReportRunIn(BaseModel):
    spec: dict | None = None
    ref: str | None = None
    version: str | None = None
    overrides: dict | None = None


class ReportExportIn(ReportRunIn):
    format: str = "csv"


class SavedReportIn(BaseModel):
    name: str
    description: str = ""
    visibility: str = "mine"
    spec: dict
    based_on: str = ""


class SavedReportPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    visibility: str | None = None
    spec: dict | None = None


class ReportFavoriteIn(BaseModel):
    ref: str


class ReportScheduleIn(BaseModel):
    report_ref: str
    version: str = ""
    name: str = ""
    cadence: str = "weekly"
    weekday: int | None = None
    day_of_month: int | None = None
    hour: int = 7
    recipients: list[str] | str = []
    format: str = "csv"
    active: bool = True


class ReportSchedulePatch(BaseModel):
    report_ref: str | None = None
    version: str | None = None
    name: str | None = None
    cadence: str | None = None
    weekday: int | None = None
    day_of_month: int | None = None
    hour: int | None = None
    recipients: list[str] | str | None = None
    format: str | None = None
    active: bool | None = None


class ReportAssistantIn(BaseModel):
    prompt: str
    spec: dict | None = None


def _report_user(request: Request) -> tuple[int | None, bool]:
    """(user_id, puede_gestionar_reportes_de_la_org = maint.edit)."""
    user = _user_from(request) if request is not None else None
    if user is None:
        return None, not auth.users_exist()
    return user.get("id"), permissions.has_scope(
        user.get("org_id"), user["role"], "maint.edit")


def _report_spec(body: ReportRunIn, request: Request) -> tuple[dict, dict]:
    """Spec efectiva de un pedido {spec} o {ref, version, overrides}."""
    if body.spec is not None:
        if body.overrides:
            raise ValueError("overrides only apply to a ref")
        return body.spec, {}
    if body.ref:
        uid, _can = _report_user(request)
        return report_saved.resolve(body.ref, body.version, body.overrides,
                                    user_id=uid)
    raise ValueError("send a report spec or a report ref")


@router.get("/reports/library")
def reports_library(request: Request):
    """Lista estilo SquareRigger: reportes de sistema (pestaña Rigsmith),
    guardados visibles (Mine / Org) y favoritos del usuario."""
    uid, can = _report_user(request)
    return {"system": report_library.list_system(),
            "saved": report_saved.list_saved(uid, can),
            "favorites": report_saved.list_favorites(uid),
            "categories": list(report_library.CATEGORIES)}


@router.get("/reports/sources")
def reports_sources():
    """Registro para el builder: fuentes ("One row per …"), campos con
    tipo/etiqueta/descripción, operadores, agregaciones y presets."""
    return {
        "sources": report_registry.catalog(),
        "ops": [{"key": k, "label": report_engine.OP_LABELS[k]}
                for k in report_engine.OPS],
        "aggs": [{"key": k, "label": report_engine.AGG_LABELS[k]}
                 for k in report_engine.AGGS],
        "presets": [{"key": k, "label": report_engine.PRESET_LABELS[k]}
                    for k in report_engine.PRESETS],
        "chart_types": list(report_engine.CHART_TYPES),
        "limits": {"max_rows": report_engine.MAX_LIMIT,
                   "default_rows": report_engine.DEFAULT_LIMIT,
                   "max_columns": report_engine.MAX_COLUMNS},
    }


@router.get("/reports/system/{slug}")
def reports_system(slug: str):
    r = report_library.get_system(slug)
    if r is None:
        raise HTTPException(status_code=404, detail="Report not found")
    return {**report_library.summary(r), "spec": r["spec"],
            "versions": r["versions"]}


@router.post("/reports/run")
async def reports_run(body: ReportRunIn, request: Request):
    """Ejecuta una spec o un ref (sys:<slug> | saved:<id>) con versión y
    overrides. Lectura: basta estar autenticado. PII enmascarada sin
    pii.view."""
    try:
        spec, meta = _report_spec(body, request)
        result = await report_engine.run(spec,
                                         mask_pii=_pii_masked(request))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if meta:
        result["report"] = meta
    return result


@router.post("/reports/export")
async def reports_export(body: ReportExportIn, request: Request):
    """Descarga CSV / XLSX del resultado (mismo pedido que /reports/run)."""
    try:
        spec, meta = _report_spec(body, request)
        result = await report_engine.run(spec,
                                         mask_pii=_pii_masked(request))
        title = meta.get("name") or "Report"
        sub = " · ".join(x for x in (
            meta.get("version_label"),
            (result.get("time") or {}).get("label")) if x)
        data, mime, fname = report_export.render(result, body.format, title,
                                                 sub)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return Response(content=data, media_type=mime, headers={
        "Content-Disposition": f'attachment; filename="{fname}"',
        "Cache-Control": "no-store"})


# ----- Guardados (Mine / Org) ---------------------------------------------

@router.post("/reports/saved")
def reports_saved_create(body: SavedReportIn, request: Request):
    uid, can = _report_user(request)
    try:
        return report_saved.create_saved(body.model_dump(), uid, can)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/reports/saved/{report_id}")
def reports_saved_get(report_id: int, request: Request):
    uid, can = _report_user(request)
    r = report_saved.get_saved(report_id, uid, can)
    if r is None:
        raise HTTPException(status_code=404, detail="Report not found")
    return r


@router.patch("/reports/saved/{report_id}")
def reports_saved_patch(report_id: int, body: SavedReportPatch,
                        request: Request):
    uid, can = _report_user(request)
    try:
        r = report_saved.update_saved(
            report_id, body.model_dump(exclude_unset=True), uid, can)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if r is None:
        raise HTTPException(status_code=404, detail="Report not found")
    return r


@router.delete("/reports/saved/{report_id}")
def reports_saved_delete(report_id: int, request: Request):
    uid, can = _report_user(request)
    try:
        ok = report_saved.delete_saved(report_id, uid, can)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    if ok is None:
        raise HTTPException(status_code=404, detail="Report not found")
    return {"deleted": True}


# ----- Favoritos -----------------------------------------------------------

@router.post("/reports/favorites")
def reports_favorite_add(body: ReportFavoriteIn, request: Request):
    uid, _can = _report_user(request)
    try:
        return {"favorites": report_saved.add_favorite(body.ref, uid)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/reports/favorites")
def reports_favorite_remove(request: Request, ref: str = "",
                            body: ReportFavoriteIn | None = None):
    """Quita una ★. El ref llega en el body o como ?ref= (fetch DELETE)."""
    uid, _can = _report_user(request)
    target = (body.ref if body is not None else "") or ref
    if not target:
        raise HTTPException(status_code=400, detail="ref is required")
    return {"favorites": report_saved.remove_favorite(target, uid)}


# ----- Envíos programados (maint.edit para escribir) ---------------------

@router.get("/reports/schedules")
def reports_schedules_list(report_ref: str = ""):
    return {"schedules": report_schedules.list_schedules(report_ref)}


@router.post("/reports/schedules")
def reports_schedules_create(body: ReportScheduleIn, request: Request):
    uid, _can = _report_user(request)
    try:
        return report_schedules.create_schedule(
            body.model_dump(), actor=_actor_name(request), user_id=uid)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.patch("/reports/schedules/{schedule_id}")
def reports_schedules_patch(schedule_id: int, body: ReportSchedulePatch,
                            request: Request):
    uid, _can = _report_user(request)
    try:
        r = report_schedules.update_schedule(
            schedule_id, body.model_dump(exclude_unset=True), user_id=uid)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if r is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    return r


@router.delete("/reports/schedules/{schedule_id}")
def reports_schedules_delete(schedule_id: int):
    if not report_schedules.delete_schedule(schedule_id):
        raise HTTPException(status_code=404, detail="Schedule not found")
    return {"deleted": True}


@router.post("/reports/schedules/{schedule_id}/send-now")
async def reports_schedules_send_now(schedule_id: int):
    """Envía YA (no mueve el próximo envío). last_status dice si salió de
    verdad ('sent'), si el mailer está en modo prueba ('dry_run') o el
    error."""
    r = await report_schedules.send_now(schedule_id)
    if r is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    return r


# ----- Asistente de IA ------------------------------------------------------

@router.get("/reports/assistant/status")
def reports_assistant_status():
    """¿Está disponible "Ask Rigsmith"? (clave configurada + interruptor de
    la org) y los modelos que ofrece Settings."""
    return report_assistant.status()


def _assistant_rate_limit(request: Request) -> None:
    """Mismo límite por usuario que el escaneo con IA (SEC-3): la clave es
    compartida y cada pedido cuesta."""
    uid = (getattr(request.state, "user", None) or {}).get("id") \
        or ratelimit.client_ip(request)
    if not ratelimit.hit(f"assist:min:{uid}", ratelimit.SCAN_RATE,
                         ratelimit.SCAN_RATE_WINDOW_S):
        raise _too_many(ratelimit.SCAN_RATE_WINDOW_S)
    if not ratelimit.hit(f"assist:day:{uid}", ratelimit.SCAN_DAILY,
                         ratelimit.SCAN_DAILY_WINDOW_S):
        raise HTTPException(
            status_code=429,
            detail=f"Daily AI assistant limit reached "
                   f"({ratelimit.SCAN_DAILY}/day). Try again tomorrow.",
            headers={"Retry-After": str(ratelimit.SCAN_DAILY_WINDOW_S)})


@router.post("/reports/assistant")
async def reports_assistant(body: ReportAssistantIn, request: Request):
    """Pedido en lenguaje natural -> {spec, explanation, warnings[]}. La
    spec ya viene validada por el motor (el frontend la previsualiza con
    /reports/run). 503 si no hay clave o la org lo apagó."""
    st = report_assistant.status()
    if not st["available"]:
        raise HTTPException(status_code=503, detail=st["message"])
    _assistant_rate_limit(request)
    try:
        return await report_assistant.ask(body.prompt, body.spec,
                                          mask_pii=_pii_masked(request))
    except report_assistant.AssistantUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except report_assistant.AssistantError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/reports/{report_id}/download")
def download_report(report_id: str):
    """Descarga el Excel generado."""
    job = _jobs.get(report_id)
    if not job or not job["path"].exists():
        raise HTTPException(404, "Report not found or expired.")
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
        raise HTTPException(422, "No file was uploaded.")

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
        raise HTTPException(404, "Batch not found or expired.")
    if not req.blocks:
        raise HTTPException(422, "No blocks to generate.")

    roster = engine.load_roster(
        config.DEFAULT_ROSTER if config.DEFAULT_ROSTER.exists() else None)
    incl_pretrip = engine.template_pretrip(req.template)

    by_company: dict[str, list] = {}
    warnings: list[str] = []
    for block in req.blocks:
        dvir = store.get(block.dvir_file_id)
        activity = store.get(block.activity_file_id)
        if dvir is None or activity is None:
            raise HTTPException(
                422, f"Block {block.company} {block.date_label}: "
                     "missing the DVIR or activity CSV.")
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
                block.company, pretrip_data, include_pretrip=incl_pretrip)
        except engine.ReportError as exc:
            raise HTTPException(
                422, f"Block {block.company} {block.date_label}: "
                     f"{exc}") from exc

        by_company.setdefault(block.company, []).append(
            (block.date_label, groups))

        metrics = engine.block_metrics(dvir_df, groups)
        if engine.dvir_looks_incomplete(groups):
            warnings.append(
                f"Block {block.company} {block.date_label}: "
                f"{metrics['n_no_dvir']} NO DVIR rows vs "
                f"{len(groups) - metrics['n_no_dvir']} with DVIR; "
                "check that the DVIR CSV is complete.")

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
# Reporting · Import desde el ELD (fase 2a: diagnostico de fetchers)
# ---------------------------------------------------------------------------
@router.get("/reporting/eld/preview")
async def reporting_eld_preview(date: str, company: str | None = None):
    """Trae DVIR + distancia del dia desde Samsara y devuelve lo PARSEADO +
    una muestra CRUDA, para validar los mapeos de campos contra la cuenta
    real antes de armar el reporte. `date` = YYYY-MM-DD."""
    try:
        day = datetime.strptime(date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(
            status_code=422, detail="date debe ser YYYY-MM-DD")
    return await samsara.report_eld_diagnostic(company, day)


@router.get("/reporting/templates")
def reporting_templates():
    """Plantillas de reporte (Standard con Pre-trip / Legacy sin)."""
    return {"templates": engine.REPORT_TEMPLATES}


class EldImportIn(BaseModel):
    date: str            # YYYY-MM-DD
    company: str
    template: str = "standard"


@router.post("/reporting/eld/import")
async def reporting_eld_import(body: EldImportIn):
    """Arma y GUARDA el reporte de un dia leyendo DVIR + distancia del ELD
    (mismas estructuras que el flujo manual -> reusa engine.build_report).
    Aparece en Recent DVIRs. Pre-trip pendiente (fase 2c)."""
    try:
        day = datetime.strptime(body.date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=422, detail="date debe ser YYYY-MM-DD")
    company = (body.company or "").strip().upper()
    if not company:
        raise HTTPException(status_code=422, detail="Falta la empresa")

    incl_pretrip = engine.template_pretrip(body.template)
    rows = await samsara.report_dvir_rows(company, day)
    activity = await samsara.report_day_distance(company, day)
    # Legacy no usa pre-trip: ni se pide a Samsara.
    pretrip_data = (await samsara.report_pretrip(company, day)
                    if incl_pretrip else {})
    if not rows and not activity:
        raise HTTPException(
            status_code=422,
            detail=(f"Samsara no devolvio datos de {company} para {body.date}. "
                    "Si esa empresa no esta en Samsara (p.ej. MCC), usa "
                    "'Create DVIR Report' con los archivos."))

    roster = engine.load_roster(
        config.DEFAULT_ROSTER if config.DEFAULT_ROSTER.exists() else None)
    dvir_df = engine.dvir_df_from_rows(rows)
    groups = engine.build_report(
        dvir_df, activity, roster, engine.MIN_MILES, company, pretrip_data,
        include_pretrip=incl_pretrip)
    metrics = engine.block_metrics(dvir_df, groups)
    defects = engine.extract_defects(dvir_df)
    date_label = f"{day.month}.{day.day}"
    db.save_block(company, date_label, day, groups, metrics, defects)
    return {
        "ok": True, "company": company, "date_label": date_label,
        "block_date": day.isoformat(),
        "n_reports": metrics["n_reports"],
        "n_no_dvir": metrics["n_no_dvir"],
        "n_unsafe": metrics["n_unsafe"],
        "pretrip": bool(pretrip_data),
    }


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
    que /dvir/defects (status = "Open"). La lógica vive en
    open_defects.current_feed (la comparte el sync de Service Requests)."""
    return await open_defects.current_feed(refresh=refresh)


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
            archived = set(app_config.archived_ids())
            rows = [d for d in rows if d.get("asset_id") not in archived]
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
                "error": f"Samsara did not respond ({exc}); using local CSV.",
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


class TmsDriverIn(BaseModel):
    name: str
    company: str | None = None
    driver_company: str | None = None
    role: str | None = None
    pay_type: str | None = None
    pay_pct: float | None = None
    truck: str | None = None
    trailer: str | None = None
    hired_date: str | None = None
    emergency_name: str | None = None
    emergency_phone: str | None = None
    cdl_exp: str | None = None
    med_exp: str | None = None
    mvr_exp: str | None = None
    chouse_exp: str | None = None
    notes: str | None = None


@router.get("/tms/drivers")
async def tms_drivers(request: Request):
    """Roster vivo + perfil TMS por conductor.

    Igual que /api/drivers: si el rol no tiene `pii.view`, el teléfono, el email
    y la licencia salen ENMASCARADOS. Antes esta ruta los devolvía en claro a
    cualquier autenticado (un mechanic o un viewer veía toda la PII del roster)."""
    drivers = await tms.list_drivers()
    user = _user_from(request)
    masked = user is not None and not permissions.has_scope(
        user.get("org_id"), user["role"], "pii.view")
    if masked:
        for d in drivers:
            d["email"] = _mask_email(d.get("email", ""))
            d["phone"] = _mask_phone(d.get("phone", ""))
            lic = str(d.get("license_number") or "")
            d["license_number"] = f"···{lic[-4:]}" if len(lic) > 4 else ""
    return {"drivers": drivers, "pii_masked": masked}


@router.post("/tms/drivers")
def tms_driver_save(body: TmsDriverIn):
    fields = {k: v for k, v in body.model_dump().items()
              if k != "name" and v is not None}
    try:
        return tms.save_driver(body.name, fields)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class WorkOrderIn(BaseModel):
    unit: str
    title: str
    complaint: str = ""
    company: str = ""
    mechanic: str = ""
    priority: str = "normal"
    is_pm: bool = False
    source: str = "manual"
    mileage: int | None = None
    service_date: str = ""
    campaign: str = ""
    shop_invoice: str = ""
    # Multi-unit (v1.26): si viene seteado, la orden se crea como HIJA del
    # invoice multi-unidad (numerada #padre.N).
    parent_id: int | None = None
    # Outside work (v2.21): inside (taller propio) | outside (taller externo
    # = vendor_id, obligatorio para outside).
    wo_type: str = "inside"
    vendor_id: int | None = None
    # v2.22: horómetro de la unidad (reefer) al crear la WO.
    engine_hours: float | None = None
    # v2.22 Customers (Bill to): None = el dueño de la unidad (si tiene);
    # 0 = Self explícito; un id = ese customer.
    customer_id: int | None = None
    payment_status: str = "unpaid"      # unpaid | paid


class WorkOrderPatch(BaseModel):
    status: str | None = None
    priority: str | None = None
    title: str | None = None
    complaint: str | None = None
    mechanic: str | None = None
    notes: str | None = None
    is_pm: bool | None = None
    pm_miles: int | None = None
    mileage: int | None = None
    service_date: str | None = None
    waiting_parts: bool | None = None
    campaign: str | None = None
    # invoice_number (el propio) NO es editable por WO (#4): se omite aquí.
    po_number: str | None = None
    authorizer: str | None = None
    shop_invoice: str | None = None
    # Outside work (v2.21). vendor_id 0 = quitar el vendor (solo si la WO
    # queda inside; el PATCH filtra los None, por eso el 0 como centinela).
    wo_type: str | None = None
    vendor_id: int | None = None
    # v2.22: horómetro (reefer). 0 = borrar (el PATCH filtra los None).
    engine_hours: float | None = None
    # v2.22 Customers: 0 = Self (quitar el customer; el PATCH filtra los
    # None). Bloqueado en una WO facturada. payment_status exige wo.invoice.
    customer_id: int | None = None
    payment_status: str | None = None   # unpaid | paid


class WoLineIn(BaseModel):
    kind: str          # part | labor
    description: str
    qty: float = 1
    unit_cost: float = 0
    part_number: str = ""


class WoLinesBulkIn(BaseModel):
    lines: list[WoLineIn] = []
    replace: bool = False


class SmartFillVendorCreate(BaseModel):
    name: str
    city: str = ""
    state: str = ""


class SmartFillApplyIn(BaseModel):
    """Propuesta de Smart Fill confirmada por el usuario (v2.21). `fields`
    solo admite service_date/shop_invoice/mileage/wo_type/vendor_id/title/
    complaint (core/smart_fill filtra el resto)."""
    fields: dict = {}
    vendor_create: SmartFillVendorCreate | None = None
    lines: list[WoLineIn] = []
    lines_mode: str = "append"          # append | replace


class VendorMatchIn(BaseModel):
    name: str
    city: str = ""
    state: str = ""


class TechnicianIn(BaseModel):
    name: str
    user_id: int | None = None
    # v2.22 (Resources → Employees): ficha opcional del empleado.
    role: str | None = None
    phone: str | None = None
    email: str | None = None
    hourly_rate: float | None = None
    hire_date: str | None = None
    notes: str | None = None


class TechnicianPatch(BaseModel):
    name: str | None = None
    active: bool | None = None
    user_id: int | None = None
    role: str | None = None
    phone: str | None = None
    email: str | None = None
    hourly_rate: float | None = None
    hire_date: str | None = None
    notes: str | None = None


class WorkOrderSendIn(BaseModel):
    channels: list[str] = ["email"]      # email | sms
    email: str = ""
    phone: str = ""
    # Datos de la unidad (VIN/año/marca/modelo) desde la caché de /fleet del
    # frontend; evita un fetch lento a Samsara al enviar.
    unit_info: dict = {}


# ----- Purchase Orders / QuickBuy (Increment B) ----------------------------

class POLineIn(BaseModel):
    part_number: str = ""
    description: str = ""
    qty: float = 1
    unit_cost: float = 0
    taxable: bool = False               # v2.22: línea gravada
    dry_run: bool = False               # v2.22: preview del re-prorrateo


class PurchaseOrderIn(BaseModel):
    vendor: str = ""
    notes: str = ""
    lines: list[POLineIn] = []          # QuickBuy: crea la PO con líneas
    vendor_id: int | None = None        # v2.22: si no viene, se resuelve por nombre


class PurchaseOrderPatch(BaseModel):
    vendor: str | None = None
    notes: str | None = None
    status: str | None = None           # draft | ordered | received
    # v2.22: datos de la factura del proveedor (editables a cualquier status).
    invoice_no: str | None = None
    invoice_date: str | None = None     # YYYY-MM-DD ('' = sin fecha)
    tracking_no: str | None = None
    payment_method: str | None = None   # '' | invoice | paid | card | cash
    vendor_id: int | None = None


class POLinePatch(BaseModel):
    """v2.22: edición de una línea a CUALQUIER status / fin_status. Con
    dry_run=true devuelve el preview (revaluations) sin guardar."""
    unit_cost: float | None = None
    qty: float | None = None
    taxable: bool | None = None
    description: str | None = None
    dry_run: bool = False


class PoAdjustmentIn(BaseModel):
    kind: str                           # discount|credit|shipping|tax|fee|payment
    amount: float                       # > 0 (el signo lo da kind)
    note: str = ""
    allocate: bool = False              # repartir en landed cost (no payment)
    dry_run: bool = False


class PoVoidIn(BaseModel):
    reason: str = ""


class ReceiptLineIn(BaseModel):
    line_id: int
    qty_now: float = 0                   # cantidad que llegó AHORA en esta línea


class ReceivePoIn(BaseModel):
    receipts: list[ReceiptLineIn] = []
    # Token del evento (uno por click de "Receive"): hace la recepción
    # idempotente (reenviar el mismo payload es no-op).
    token: str = ""
    # ¿Auto-crear una PO de backorder con lo que falta y cerrar esta PO?
    create_backorder: bool = True


class PartsRequestIn(BaseModel):
    part_number: str = ""
    description: str = ""
    qty: float = 1
    unit_cost: float = 0
    vendor: str = ""
    source: str = "manual"              # low_stock | wo | manual
    source_ref: str = ""


class BundleRequestsIn(BaseModel):
    request_ids: list[int] = []


class PermMatrixIn(BaseModel):
    # { rol: [scopes concedidos] }. 'admin' se ignora (siempre full).
    grants: dict[str, list[str]] = {}


@router.get("/workorders")
def wo_list(status: str = "", unit: str = "", wo_type: str = "",
            vendor_id: int | None = None):
    # `mechanics` se conserva por compatibilidad: ahora son los técnicos
    # ACTIVOS del roster (v2.21, core/technicians).
    return {"workorders": workorders.list_wos(status, unit, wo_type,
                                              vendor_id),
            "stats": workorders.stats(),
            "mechanics": workorders.mechanics()}


@router.post("/workorders")
def wo_create(body: WorkOrderIn, request: Request):
    # v2.22: crear una WO ya cobrada es una acción de facturación (igual que
    # el PATCH de payment_status): sin esto un rol con solo maint.edit
    # (mechanic) creaba WOs 'paid' que nunca entraban al saldo del cliente.
    if (body.payment_status or "unpaid").strip().lower() != "unpaid":
        require_scope("wo.invoice", request)
    try:
        return workorders.create_wo(
            body.unit, body.title, body.complaint, body.company,
            body.mechanic, body.priority, body.is_pm, body.source,
            body.mileage, body.service_date, body.campaign,
            body.shop_invoice, body.parent_id, body.wo_type, body.vendor_id,
            engine_hours=body.engine_hours, customer_id=body.customer_id,
            payment_status=body.payment_status)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


def _scan_rate_limit(request: Request) -> None:
    """SEC-3 (extensión): el escaneo consume la API de Groq con un key
    COMPARTIDO (free tier ~125/día). Sin límite, un usuario podría agotar la
    cuota → 429 para TODOS los clientes (o inflar el costo). Se limita POR
    USUARIO: 15/min y 150/día (config por env SEC3_SCAN_*). El middleware ya
    dejó el usuario autenticado en request.state.user; si faltara, cae a la
    IP. Lo comparten /workorders/scan y /workorders/{id}/smart-fill."""
    uid = (getattr(request.state, "user", None) or {}).get("id") \
        or ratelimit.client_ip(request)
    if not ratelimit.hit(f"scan:min:{uid}", ratelimit.SCAN_RATE,
                         ratelimit.SCAN_RATE_WINDOW_S):
        raise _too_many(ratelimit.SCAN_RATE_WINDOW_S)
    if not ratelimit.hit(f"scan:day:{uid}", ratelimit.SCAN_DAILY,
                         ratelimit.SCAN_DAILY_WINDOW_S):
        raise HTTPException(
            status_code=429,
            detail=f"Daily scan limit reached ({ratelimit.SCAN_DAILY}/day). "
                   "Try again tomorrow.",
            headers={"Retry-After": str(ratelimit.SCAN_DAILY_WINDOW_S)})


def _check_scan_bytes(raw: bytes) -> None:
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(raw) > docscan.MAX_BYTES:
        raise HTTPException(status_code=400,
                            detail="File too large (max 20 MB)")


def _vendor_match_for(extract: dict) -> dict:
    """Match del taller extraído contra el catálogo de vendors (v2.21)."""
    return vendors_core.match(extract.get("vendor") or "",
                              extract.get("vendor_city") or "",
                              extract.get("vendor_state") or "")


@router.post("/workorders/scan")
async def wo_scan(request: Request, file: UploadFile = File(...)):
    """Escanea un invoice/estimate (PDF o foto) y devuelve los campos
    extraídos para autollenar la work order (fase H2.5). v2.21: además
    `vendor_match` y `proposed` (el mismo mapeo que Smart Fill sobre una WO
    existente), para que el modal de creación no duplique la lógica."""
    _scan_rate_limit(request)
    raw = await file.read()
    _check_scan_bytes(raw)
    try:
        out = await docscan.scan(raw, file.content_type or "")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    extract = out.get("extract") or {}
    out["vendor_match"] = _vendor_match_for(extract)
    out["proposed"] = smart_fill.propose(extract, None, out["vendor_match"])
    return out


@router.get("/workorders/{wo_id}")
def wo_get(wo_id: int):
    wo = workorders.get_wo(wo_id)
    if wo is None:
        raise HTTPException(status_code=404, detail="WO not found")
    return wo


@router.delete("/workorders/{wo_id}")
def wo_delete(wo_id: int):
    """Elimina del todo una work order (fase H3, pedido del usuario)."""
    if not workorders.delete_wo(wo_id):
        raise HTTPException(status_code=404, detail="WO not found")
    return {"ok": True}


@router.patch("/workorders/{wo_id}")
async def wo_patch(wo_id: int, body: WorkOrderPatch,
                   request: Request):
    # El middleware ya exigió maint.edit; FACTURAR exige además wo.invoice.
    # v2.22: marcar el cobro (payment_status) también es de facturación.
    if body.status == "invoiced" or body.payment_status is not None:
        require_scope("wo.invoice", request)
    before = workorders.get_wo(wo_id)
    if before is None:
        raise HTTPException(status_code=404, detail="WO not found")
    try:
        wo = workorders.update_wo(
            wo_id, {k: v for k, v in body.model_dump().items()
                    if v is not None})
    except ValueError as exc:
        # Gate del pipeline: el mensaje se muestra tal cual en la UI.
        raise HTTPException(status_code=400, detail=str(exc))
    if wo is None:
        raise HTTPException(status_code=404, detail="WO not found")
    # Telegram al group chat del taller en los estados configurados
    # (default: assigned). dry_run simula; nunca rompe el PATCH.
    tg = await telegram_notify.notify_wo(wo, before["status"])
    if tg is not None:
        wo["telegram"] = tg
    return wo


@router.post("/workorders/{wo_id}/lines")
def wo_add_line(wo_id: int, body: WoLineIn):
    try:
        wo = workorders.add_line(wo_id, body.kind, body.description,
                                 body.qty, body.unit_cost, body.part_number)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if wo is None:
        raise HTTPException(status_code=404, detail="WO not found")
    return wo


@router.post("/workorders/{wo_id}/lines/bulk")
def wo_add_lines_bulk(wo_id: int, body: WoLinesBulkIn):
    """N líneas en UNA transacción (v2.21): lo usa Smart Fill y el modal de
    creación (antes hacía N POSTs). `replace` reemplaza las existentes."""
    try:
        wo = workorders.add_lines_bulk(
            wo_id, [ln.model_dump() for ln in body.lines], body.replace)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if wo is None:
        raise HTTPException(status_code=404, detail="WO not found")
    return wo


# ----- Smart Fill sobre una WO existente (v2.21) -----------------------------
# El escáner de facturas también sirve para una WO que YA existe (inside u
# outside; SquareRigger solo lo tiene para outside). Dos pasos: /smart-fill
# escanea (archivo nuevo, que queda adjunto, o el ya adjunto) y devuelve una
# PROPUESTA; /smart-fill/apply la aplica en una transacción cuando el usuario
# la confirma. Ambos bloqueados si la WO ya está facturada. El middleware ya
# exige maint.edit (POST bajo /api/workorders).

@router.post("/workorders/{wo_id}/smart-fill")
async def wo_smart_fill(wo_id: int, request: Request):
    """Multipart `file` (pdf/imagen; se guarda como factura adjunta de la
    WO) o JSON {"use_attached": true} (re-escanea la factura ya adjunta).
    Mismos límites de tamaño y rate limit que /workorders/scan."""
    wo = workorders.get_wo(wo_id)
    if wo is None:
        raise HTTPException(status_code=404, detail="WO not found")
    if wo["status"] == "invoiced" or wo.get("invoiced_at"):
        raise HTTPException(status_code=400, detail=smart_fill.INVOICED_MSG)
    _scan_rate_limit(request)
    ctype = (request.headers.get("content-type") or "").lower()
    new_file: tuple[str, bytes] | None = None
    if ctype.startswith("multipart/form-data"):
        form = await request.form()
        up = form.get("file")
        if up is None or not hasattr(up, "read"):
            raise HTTPException(status_code=400, detail="file is required")
        raw = await up.read()
        _check_scan_bytes(raw)
        filename = up.filename or "invoice"
        try:
            ext = wo_invoices.validate(filename, raw)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        # El tipo lo decide la EXTENSIÓN (lo que el sidecar guarda y con lo
        # que después se sirve el adjunto), no el Content-Type del cliente
        # (octet-stream en Windows, image/png para un .pdf). Lo que el
        # escáner no lee (HEIC) se rechaza ANTES de tocar el adjunto.
        media_type = wo_invoices.media_type_for(ext)
        if media_type not in docscan.MEDIA_TYPES:
            raise HTTPException(
                status_code=400,
                detail="Unsupported file type for Smart Fill. "
                       "Use PDF, JPG, PNG or WEBP.")
        new_file = (filename, raw)
    else:
        try:
            body = await request.json()
        except ValueError:
            body = {}
        if not (isinstance(body, dict) and body.get("use_attached")):
            raise HTTPException(
                status_code=400,
                detail="send a file or {\"use_attached\": true}")
        found = wo_invoices.read_file(wo_id)
        if found is None:
            raise HTTPException(status_code=400,
                                detail="no invoice file attached")
        raw, media_type = found
        _check_scan_bytes(raw)
    try:
        scanned = await docscan.scan(raw, media_type)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    # Recién con el escaneo OK el archivo nuevo reemplaza al adjunto: un
    # escaneo fallido (proveedor caído, foto sin texto) NO destruye la
    # factura original que ya estaba adjunta a la WO.
    if new_file is not None:
        wo_invoices.save_file(wo_id, *new_file)
    extract = scanned.get("extract") or {}
    vendor_match = _vendor_match_for(extract)
    return {
        "extract": extract,
        "vendor_match": vendor_match,
        "proposed": smart_fill.propose(extract, wo, vendor_match),
        "model": scanned.get("model") or "",
    }


@router.post("/workorders/{wo_id}/smart-fill/apply")
def wo_smart_fill_apply(wo_id: int, body: SmartFillApplyIn):
    """Aplica la propuesta confirmada: campos + alta opcional del vendor
    (kind 'shop') + líneas (append|replace), TODO en una transacción.
    Devuelve el detalle de la WO (igual que GET /workorders/{id})."""
    try:
        wo = smart_fill.apply(
            wo_id, body.fields,
            body.vendor_create.model_dump() if body.vendor_create else None,
            [ln.model_dump() for ln in body.lines], body.lines_mode)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if wo is None:
        raise HTTPException(status_code=404, detail="WO not found")
    return wo


# ----- Factura original adjunta por WO (review v1.17, estilo SquareRigger) ---
# Almacenamiento por archivo (core/wo_invoices), SIN columna en la DB. El
# middleware ya exige maint.edit para POST/DELETE bajo /api/workorders; el GET
# es lectura (auth basta). Espeja las rutas de unitdocs (FileResponse, scope).
# Tenant: wo_invoices indexa por id GLOBAL de WO fuera del ORM, así que el
# filtro OrgScoped no lo cubre; _require_wo (session.get acotado a la org) es
# la única guarda y la aplican las CINCO rutas (subir, ver, miniatura, borrar
# y Smart Fill). Sin ella, otra org podía leer/borrar el adjunto por id.

def _require_wo(wo_id: int) -> None:
    """404 si la WO no existe EN LA ORG ACTUAL."""
    if not workorders.wo_exists(wo_id):
        raise HTTPException(status_code=404, detail="WO not found")


@router.post("/workorders/{wo_id}/invoice-file")
async def wo_invoice_file_upload(wo_id: int,
                                 file: UploadFile = File(...)):
    """Sube (o reemplaza) la factura original del taller de la WO."""
    _require_wo(wo_id)
    raw = await file.read()
    try:
        result = wo_invoices.save_file(
            wo_id, file.filename or "invoice", raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return result


@router.get("/workorders/{wo_id}/invoice-file")
def wo_invoice_file_download(wo_id: int):
    """Devuelve la factura original. Inline-viewable (el PDF abre en el
    navegador); el nombre original se preserva para la descarga."""
    _require_wo(wo_id)
    found = wo_invoices.file_path(wo_id)
    if found is None:
        raise HTTPException(status_code=404, detail="Invoice file not found")
    path, filename = found
    # content_disposition_type="inline" => el navegador muestra el PDF/imagen
    # en vez de forzar la descarga (el frontend decide ver vs descargar).
    return FileResponse(path, filename=filename,
                        content_disposition_type="inline")


@router.get("/workorders/{wo_id}/invoice-file/thumb")
def wo_invoice_file_thumb(wo_id: int):
    """Miniatura PNG de la factura para el drawer (PDF -> 1a pagina).
    404 si no hay factura o si no se puede rasterizar."""
    _require_wo(wo_id)
    try:
        t = wo_invoices.thumb(wo_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Thumbnail unavailable")
    if t is None:
        raise HTTPException(status_code=404, detail="Invoice file not found")
    data, mime = t
    return Response(content=data, media_type=mime,
                    headers={"Cache-Control": "no-store"})


@router.delete("/workorders/{wo_id}/invoice-file")
def wo_invoice_file_delete(wo_id: int):
    _require_wo(wo_id)
    if not wo_invoices.delete_file(wo_id):
        raise HTTPException(status_code=404, detail="Invoice file not found")
    return {"ok": True}


@router.post("/workorders/{wo_id}/send")
def wo_send(wo_id: int, body: WorkOrderSendIn):
    """Envía el estimate/invoice de la orden por email (real) y/o SMS
    (fase H3-C). El email lleva el documento HTML; el SMS un resumen."""
    wo = workorders.get_wo(wo_id)
    if wo is None:
        raise HTTPException(status_code=404, detail="WO not found")
    return wo_invoice.send(wo, body.channels, body.email, body.phone,
                           body.unit_info)


# ----- Service Requests (v2.20) ---------------------------------------------
# Backlog por unidad (defectos DVIR + PM/DOT + pedidos manuales) desde el que
# se despacha: Deny / Snooze / Add to WO / Create WO. Toda la lógica vive en
# core/service_requests. GET = lectura; las escrituras exigen maint.edit
# (prefijo /api/service-requests en _scope_for). Las rutas literales (sync,
# create-wo, defect-to-wo, delete, restore, delete-duplicates) van ANTES de
# las dinámicas /{req_id}.

class ServiceRequestIn(BaseModel):
    unit: str
    title: str
    detail: str = ""
    priority: str = "normal"
    follow_up_date: str | None = None
    company: str = ""


class ServiceRequestPatch(BaseModel):
    title: str | None = None
    detail: str | None = None
    priority: str | None = None
    follow_up_date: str | None = None     # "" o null explícito limpia la fecha


class SrCreateWoIn(BaseModel):
    ids: list[int]
    title: str = ""
    mechanic: str = ""
    priority: str = ""


class SrDefectToWoIn(BaseModel):
    unit: str
    detail: str
    dvir_type: str = ""
    company: str = ""
    mechanic: str = ""


class SrDenyIn(BaseModel):
    reason: str = ""


class SrSnoozeIn(BaseModel):
    until: str                            # YYYY-MM-DD (futura)


class SrAddToWoIn(BaseModel):
    wo_id: int


class SrIdsIn(BaseModel):
    ids: list[int]


class SrDeleteDupsIn(BaseModel):
    unit: str = ""                        # "" = toda la flota


def _actor_name(request: Request) -> str:
    """Nombre del usuario del request (lo dejó el middleware de auth)."""
    u = getattr(request.state, "user", None) or {}
    return u.get("name") or u.get("username") or ""


@router.get("/service-requests")
async def sr_list(status: str = "open", unit: str = "", source: str = ""):
    # Sync con TTL antes de listar; si falla se loguea y se sirve lo que hay.
    await service_requests.sync_quietly()
    try:
        return service_requests.list_requests(status, unit, source)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/service-requests/sync")
async def sr_sync():
    """'Check for Due': sync forzado (ignora el TTL)."""
    return await service_requests.sync(force=True)


@router.post("/service-requests")
async def sr_create(body: ServiceRequestIn, request: Request):
    # La unidad sale del universo de GET /fleet (dropdown del front) + las
    # que el backlog / las fuentes del sync ya muestran: se canoniza y una
    # desconocida da 400. El índice es async (Samsara); la escritura corre
    # en un thread como las rutas sync.
    units = await service_requests.unit_index(body.unit)
    try:
        return await asyncio.to_thread(
            service_requests.create_manual,
            body.unit, body.title, body.detail, body.priority,
            body.follow_up_date, body.company, _actor_name(request),
            units=units)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/service-requests/create-wo")
def sr_create_wo(body: SrCreateWoIn, request: Request):
    try:
        return service_requests.create_wo(
            body.ids, body.title, body.mechanic, body.priority,
            _actor_name(request))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/service-requests/defect-to-wo")
async def sr_defect_to_wo(body: SrDefectToWoIn):
    units = await service_requests.defect_unit_index(body.unit)
    try:
        return await asyncio.to_thread(
            service_requests.defect_to_wo,
            body.unit, body.detail, body.dvir_type, body.company,
            body.mechanic, units=units)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/service-requests/delete")
def sr_delete(body: SrIdsIn):
    """Borrado suave (cualquier estado menos on_wo). {deleted, skipped}."""
    return service_requests.delete_requests(body.ids)


@router.post("/service-requests/restore")
def sr_restore(body: SrIdsIn):
    """Undo del borrado: vuelve al estado previo al borrado. {restored}."""
    return service_requests.restore_requests(body.ids)


@router.post("/service-requests/delete-duplicates")
def sr_delete_duplicates(body: SrDeleteDupsIn | None = None):
    """Borra los duplicados (duplicate_of) de una unidad o de la flota."""
    return service_requests.delete_duplicates(body.unit if body else "")


@router.patch("/service-requests/{req_id}")
def sr_patch(req_id: int, body: ServiceRequestPatch):
    try:
        # Solo los campos presentes; follow_up_date admite null para limpiar.
        r = service_requests.update_request(
            req_id, {k: v for k, v in body.model_dump(exclude_unset=True)
                     .items() if v is not None or k == "follow_up_date"})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if r is None:
        raise HTTPException(status_code=404, detail="Request not found")
    return r


@router.post("/service-requests/{req_id}/deny")
def sr_deny(req_id: int, body: SrDenyIn | None = None):
    try:
        r = service_requests.deny(req_id, body.reason if body else "")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if r is None:
        raise HTTPException(status_code=404, detail="Request not found")
    return r


@router.post("/service-requests/{req_id}/snooze")
def sr_snooze(req_id: int, body: SrSnoozeIn):
    try:
        r = service_requests.snooze(req_id, body.until)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if r is None:
        raise HTTPException(status_code=404, detail="Request not found")
    return r


@router.post("/service-requests/{req_id}/reopen")
def sr_reopen(req_id: int):
    try:
        r = service_requests.reopen(req_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if r is None:
        raise HTTPException(status_code=404, detail="Request not found")
    return r


@router.post("/service-requests/{req_id}/add-to-wo")
def sr_add_to_wo(req_id: int, body: SrAddToWoIn):
    try:
        r = service_requests.add_to_wo(req_id, body.wo_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if r is None:
        raise HTTPException(status_code=404, detail="Request not found")
    return r


@router.post("/service-requests/{req_id}/unlink")
def sr_unlink(req_id: int):
    try:
        r = service_requests.unlink(req_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if r is None:
        raise HTTPException(status_code=404, detail="Request not found")
    return r


# ----- Catálogo de Partes + Vendors (fase H3, estilo Fullbay) --------------

@router.get("/vendors")
def vendors_list():
    return {"vendors": parts.list_vendors()}


@router.post("/vendors")
def vendors_create(body: dict):
    try:
        return parts.create_vendor(body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/vendors/match")
def vendors_match(body: VendorMatchIn):
    """Match (solo lectura) del nombre de taller que extrajo el escáner
    contra el catálogo (v2.21): {vendor|null, candidates[≤5]}. Literal ANTES
    de /vendors/{vendor_id}."""
    return vendors_core.match(body.name, body.city, body.state)


@router.get("/vendors/{vendor_id}/profile")
def vendors_profile(vendor_id: int):
    """v2.22 (Resources → Vendors): WOs del vendor (outside work), sus POs
    (por vendor_id o nombre), sus partes y totales (spend YTD, valor de POs
    abiertas, total de outside work)."""
    p = parts.vendor_profile(vendor_id)
    if p is None:
        raise HTTPException(status_code=404, detail="Vendor not found")
    return p


@router.patch("/vendors/{vendor_id}")
def vendors_update(vendor_id: int, body: dict):
    try:
        v = parts.update_vendor(vendor_id, body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if v is None:
        raise HTTPException(status_code=404, detail="Vendor not found")
    return v


@router.delete("/vendors/{vendor_id}")
def vendors_delete(vendor_id: int):
    try:
        ok = parts.delete_vendor(vendor_id)
    except ValueError as exc:
        # v2.21: tiene work orders ligadas -> reasignar primero.
        raise HTTPException(status_code=400, detail=str(exc))
    if not ok:
        raise HTTPException(status_code=404, detail="Vendor not found")
    return {"ok": True}


# ----- Roster de técnicos (v2.21) ---------------------------------------------
# org_setting 'technicians' (core/technicians): sin tabla nueva. Escrituras =
# maint.edit (dispatcher Y mechanic; el dueño no quiere bloqueos acá).

def _pii_masked(request: Request) -> bool:
    """¿Hay que enmascarar PII para este usuario? (sin `pii.view`). user
    None = bootstrap (sin usuarios): se muestra, como en /drivers."""
    if request is None:                  # llamada directa (tests/scripts)
        return False
    user = _user_from(request)
    return user is not None and not permissions.has_scope(
        user.get("org_id"), user["role"], "pii.view")


def _tech_out(t: dict, request: Request) -> dict:
    """Técnico con phone/email enmascarados sin pii.view (v2.22)."""
    return technicians.mask(t) if _pii_masked(request) else t


@router.get("/technicians")
def technicians_list(all: int = 0, request: Request = None):
    """Activos por defecto; ?all=1 incluye los dados de baja."""
    masked = _pii_masked(request)
    rows = technicians.list_technicians(active_only=not all)
    return {"technicians": [technicians.mask(t) if masked else t
                            for t in rows],
            "pii_masked": masked}


@router.post("/technicians")
def technicians_create(body: TechnicianIn, request: Request = None):
    profile = body.model_dump(
        exclude_unset=True, include=set(technicians.PROFILE_FIELDS))
    try:
        t = technicians.add(body.name, body.user_id, profile)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return _tech_out(t, request)


@router.get("/technicians/{tech_id}")
def technicians_profile(tech_id: int, request: Request = None):
    """v2.22 (Resources → Employees): ficha + WOs asignadas (por nombre,
    las 50 más nuevas) + horas/costo de labor de los últimos 30 días."""
    p = technicians.profile(tech_id)
    if p is None:
        raise HTTPException(status_code=404, detail="Technician not found")
    p["technician"] = _tech_out(p["technician"], request)
    p["pii_masked"] = _pii_masked(request)
    return p


@router.patch("/technicians/{tech_id}")
def technicians_update(tech_id: int, body: TechnicianPatch,
                       request: Request = None):
    # Solo los campos presentes (user_id null explícito la desliga).
    fields = {k: v for k, v in body.model_dump(exclude_unset=True).items()}
    try:
        t = technicians.update(tech_id, fields)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if t is None:
        raise HTTPException(status_code=404, detail="Technician not found")
    return _tech_out(t, request)


@router.delete("/technicians/{tech_id}")
def technicians_deactivate(tech_id: int, request: Request = None):
    """Baja SUAVE (active=False): el historial de WOs lo sigue nombrando."""
    t = technicians.deactivate(tech_id)
    if t is None:
        raise HTTPException(status_code=404, detail="Technician not found")
    return _tech_out(t, request)


# ----- Customers (v2.22, Resources → Customers) -------------------------------
# core/customers. GET = lectura (PII enmascarada sin pii.view); escrituras =
# maint.edit (prefijo /api/customers en _scope_for). Literales (/quick,
# /owner) ANTES de /{customer_id}.

class CustomerIn(BaseModel):
    name: str
    kind: str | None = None             # owner_operator | carrier | external
    active: bool | None = None
    since: str | None = None            # YYYY-MM-DD
    email: str | None = None
    phone: str | None = None
    address: str | None = None
    city: str | None = None
    state: str | None = None
    zip: str | None = None
    terms: str | None = None            # '' cod net7 net15 net30 2_10_net30 prepay
    labor_markup_pct: float | None = None
    parts_markup_pct: float | None = None
    tax_exempt: bool | None = None
    tax_rate_pct: float | None = None
    accounting_id: str | None = None
    driver_name: str | None = None
    notes: str | None = None
    tags: str | list[str] | None = None


class CustomerPatch(CustomerIn):
    name: str | None = None


class CustomerQuickIn(BaseModel):
    name: str
    kind: str | None = None
    phone: str | None = None
    email: str | None = None


class CustomerContactIn(BaseModel):
    name: str = ""
    role: str = ""
    email: str = ""
    phone: str = ""
    is_billing: bool = False


class CustomerContactPatch(BaseModel):
    name: str | None = None
    role: str | None = None
    email: str | None = None
    phone: str | None = None
    is_billing: bool | None = None


class CustomerUnitIn(BaseModel):
    unit: str


def _cust_out(d: dict, request: Request) -> dict:
    return customers_core.mask_customer(d) if _pii_masked(request) else d


def _contact_out(d: dict, request: Request) -> dict:
    return customers_core.mask_contact(d) if _pii_masked(request) else d


async def _fleet_units() -> list[dict]:
    """Unidades de la flota (Samsara + manuales) para el perfil del
    customer; best-effort (Samsara caído => el core completa con las
    manuales)."""
    try:
        fleet = await asyncio.wait_for(fleet_inventory.load(), 6.0)
        return [u for u in fleet.get("units") or [] if u.get("unit")]
    except Exception:  # noqa: BLE001
        return []


async def _customer_profile(customer_id: int, request: Request) -> dict:
    units = await _fleet_units()
    models = {customers_core.norm_unit(u["unit"]): {
        "model": u.get("model") or "", "make": u.get("make") or "",
        "year": str(u.get("year") or "")} for u in units}
    p = customers_core.profile(customer_id, models)
    if p is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    return customers_core.mask_profile(p) if _pii_masked(request) else p


def _active_param(active: str) -> bool | None:
    a = (active or "").strip().lower()
    if a in ("1", "true", "yes", "active"):
        return True
    if a in ("0", "false", "no", "inactive"):
        return False
    return None                          # '' | all


@router.get("/customers")
def customers_list(q: str = "", active: str = "", request: Request = None):
    """{customers:[{id, name, kind, active, city, state, since, units_count,
    units, open_wos, balance, …}]}. `active` = ''/all | true | false."""
    return {"customers": customers_core.list_customers(
        q, _active_param(active)), "pii_masked": _pii_masked(request)}


@router.post("/customers")
def customers_create(body: CustomerIn, request: Request = None):
    try:
        c = customers_core.create_customer(body.model_dump(exclude_unset=True))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return _cust_out(c, request)


@router.post("/customers/quick")
def customers_quick(body: CustomerQuickIn, request: Request = None):
    """Alta rápida desde el picker de la WO. Si ya existe uno con ese nombre
    lo devuelve (existing: true) en vez de fallar."""
    try:
        c = customers_core.quick_create(body.model_dump(exclude_unset=True))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return _cust_out(c, request)


@router.get("/customers/owner")
def customers_owner(unit: str = ""):
    """Dueño (customer activo) de una unidad: {customer: {id, name} | null}.
    Lo usa el alta de WO para precargar "Bill to: Customer"."""
    customers_core.ensure_backfill()
    return {"unit": unit, "customer": customers_core.owner_of(unit)}


@router.get("/customers/{customer_id}")
async def customers_get(customer_id: int, request: Request = None):
    """Perfil: customer, contacts, units (con modelo), work_orders,
    parts_billed, totals {billed_ytd, billed_all, open_balance, wo_count…},
    bill_to."""
    customers_core.ensure_backfill()
    return await _customer_profile(customer_id, request)


@router.patch("/customers/{customer_id}")
def customers_patch(customer_id: int, body: CustomerPatch,
                    request: Request = None):
    try:
        c = customers_core.update_customer(
            customer_id, body.model_dump(exclude_unset=True))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if c is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    return _cust_out(c, request)


@router.delete("/customers/{customer_id}")
def customers_delete(customer_id: int, request: Request = None):
    """Suave (active=false) si tiene WOs; si no, se borra del todo."""
    r = customers_core.delete_customer(customer_id)
    if r is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    if r.get("customer"):
        r["customer"] = _cust_out(r["customer"], request)
    return r


@router.post("/customers/{customer_id}/contacts")
def customers_add_contact(customer_id: int, body: CustomerContactIn,
                          request: Request = None):
    try:
        ct = customers_core.add_contact(customer_id, body.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if ct is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    return _contact_out(ct, request)


@router.patch("/customers/{customer_id}/contacts/{contact_id}")
def customers_patch_contact(customer_id: int, contact_id: int,
                            body: CustomerContactPatch,
                            request: Request = None):
    try:
        ct = customers_core.update_contact(
            customer_id, contact_id, body.model_dump(exclude_unset=True))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if ct is None:
        raise HTTPException(status_code=404, detail="Contact not found")
    return _contact_out(ct, request)


@router.delete("/customers/{customer_id}/contacts/{contact_id}")
def customers_delete_contact(customer_id: int, contact_id: int):
    if not customers_core.delete_contact(customer_id, contact_id):
        raise HTTPException(status_code=404, detail="Contact not found")
    return {"ok": True}


@router.post("/customers/{customer_id}/units")
async def customers_set_unit(customer_id: int, body: CustomerUnitIn):
    """Liga la unidad al customer; si tenía otro dueño la propiedad se MUEVE
    (un dueño por unidad). Toma la grafía de la flota si la reconoce."""
    known = [u["unit"] for u in await _fleet_units()]
    try:
        r = customers_core.set_unit(customer_id, body.unit, known)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if r is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    return r


@router.delete("/customers/{customer_id}/units/{unit}")
def customers_remove_unit(customer_id: int, unit: str):
    r = customers_core.remove_unit(customer_id, unit)
    if r is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    if not r:
        raise HTTPException(status_code=404,
                            detail="Unit not owned by this customer")
    return {"ok": True}


# ----- Búsqueda global + Home (v2.22, shell) --------------------------------
# Ambas son GET: el middleware solo exige estar autenticado.

@router.get("/search")
async def global_search(q: str = "", limit: int = 8,
                        request: Request = None):
    """Command palette: {groups:[{key, label, items:[{id, title, subtitle,
    section, intent}]}]}. q mínimo 2 caracteres; PII enmascarada sin
    pii.view."""
    return await search_core.search(q, limit, mask_pii=_pii_masked(request))


@router.get("/home/summary")
async def home_summary(request: Request = None):
    """KPIs del Home + semana actual vs anterior (TZ de la org) + PMs
    vencidos/por vencer (maint.due)."""
    user = _user_from(request) if request is not None else None
    return await home_core.summary(user)


@router.get("/parts")
def parts_list():
    return {"parts": parts.list_parts(),
            "categories": parts.categories(),
            "usage": parts.part_usage()}


@router.post("/parts")
def parts_create(body: dict):
    try:
        return parts.create_part(body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.patch("/parts/{part_id}")
def parts_update(part_id: int, body: dict):
    try:
        p = parts.update_part(part_id, body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if p is None:
        raise HTTPException(status_code=404, detail="Part not found")
    return p


@router.delete("/parts/{part_id}")
def parts_delete(part_id: int):
    if not parts.delete_part(part_id):
        raise HTTPException(status_code=404, detail="Part not found")
    return {"ok": True}


# ----- Inventario de partes (fase Inventory) -------------------------------
# Stock auditable: el cache on_hand vive en Part (sale en /parts); el libro de
# movimientos en part_stock_movement. Las WO al facturar consumen y las PO al
# recibir reponen (hooks en core/workorders + core/purchasing). Aquí: ajuste
# manual + listas de lectura. Scopes: el ajuste (POST bajo /api/parts) ya exige
# maint.edit vía _scope_for; los GET son lectura (basta estar autenticado).

class StockAdjustIn(BaseModel):
    part_number: str
    delta: float                  # +suma / -resta sobre la existencia
    note: str = ""


@router.get("/parts/low-stock")
def parts_low_stock():
    """Partes en o por debajo de su reorder_point (con reorder_point > 0)."""
    return {"parts": inventory.low_stock_list()}


@router.get("/parts/{part_number}/movements")
def parts_movements(part_number: str):
    """Libro de movimientos de inventario de una parte (recientes primero)."""
    return {"part_number": part_number,
            "movements": inventory.movements(part_number)}


@router.post("/parts/adjust")
def parts_adjust(body: StockAdjustIn, request: Request):
    """Ajuste manual de existencia (reason='manual'). `delta` puede ser
    negativo (merma/corrección) o positivo (conteo físico, hallazgo)."""
    try:
        return inventory.manual_adjust(body.part_number, body.delta, body.note,
                                       actor=_actor_name(request))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ----- Marketplace de partes (scaffold, Increment B) -----------------------
# Búsqueda en un marketplace externo (FindItParts/PartsTech). Es GET => el
# middleware solo exige estar autenticado (sin scope extra). Mientras no haya
# cuenta de API, el proveedor MOCK devuelve muestras y configured=false; la UI
# muestra el banner de datos demo. Conectar el real es escribir un adapter
# (ver core/parts_marketplace.py) — no toca esta ruta.

@router.get("/parts/marketplace/status")
def parts_marketplace_status():
    """Estado del marketplace activo (configured=false con el mock)."""
    return parts_marketplace.status()


@router.get("/parts/marketplace/search")
def parts_marketplace_search(q: str = "", limit: int = 20):
    """Busca partes en el marketplace activo.

    Devuelve { configured, provider, results: [...] }. Con el mock,
    configured=false y results son muestras realistas."""
    return parts_marketplace.search(q, limit)


# ----- Purchase Orders / QuickBuy (Increment B) ----------------------------
# Espeja /workorders: el middleware exige maint.edit para POST/PATCH/DELETE
# bajo /api/purchase-orders (cubierto por el prefijo /api/parts? NO — se
# agrega abajo en _scope_for). GET es lectura (basta estar autenticado).

def _po_call(fn, *args, not_found: str = "PO not found", **kw):
    """Ejecuta una operación de core/purchasing con el mapeo estándar:
    ValueError (regla de negocio, mensaje en inglés) -> 400; None -> 404."""
    try:
        res = fn(*args, **kw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if res is None:
        raise HTTPException(status_code=404, detail=not_found)
    return res


@router.get("/purchase-orders")
def po_list(status: str = "", fin_status: str = ""):
    return {"purchase_orders": purchasing.list_pos(status,
                                                   fin_status=fin_status),
            "stats": purchasing.stats()}


@router.post("/purchase-orders")
def po_create(body: PurchaseOrderIn, request: Request):
    return _po_call(
        purchasing.create_po, body.vendor, body.notes,
        [ln.model_dump() for ln in body.lines],
        actor=_actor_name(request), vendor_id=body.vendor_id)


@router.get("/purchase-orders/{po_id}")
def po_get(po_id: int):
    po = purchasing.get_po(po_id)
    if po is None:
        raise HTTPException(status_code=404, detail="PO not found")
    return po


@router.get("/purchase-orders/{po_id}/audit")
def po_audit(po_id: int, limit: int = 500):
    """v2.22: historia completa de la PO (cabecera + líneas + ajustes)."""
    return _po_call(purchasing.get_po_audit, po_id,
                    limit=max(1, min(int(limit), 2000)))


@router.patch("/purchase-orders/{po_id}")
def po_patch(po_id: int, body: PurchaseOrderPatch, request: Request):
    return _po_call(
        purchasing.update_po, po_id,
        {k: v for k, v in body.model_dump().items() if v is not None},
        actor=_actor_name(request))


@router.delete("/purchase-orders/{po_id}")
def po_delete(po_id: int, request: Request):
    """Borra una PO SIN nada recibido (con recibido -> 400: unreceive
    primero). Desliga los parts requests que la originaron."""
    _po_call(lambda: purchasing.delete_po(po_id, actor=_actor_name(request))
             or None)
    return {"ok": True}


@router.post("/purchase-orders/{po_id}/receive")
def po_receive(po_id: int, body: ReceivePoIn, request: Request):
    """Recepción por línea (parcial o total). Repone stock idempotentemente y,
    si se pide y quedan faltantes, auto-genera una PO de backorder. Bajo el
    prefijo /api/purchase-orders => scope maint.edit (igual que el resto)."""
    return _po_call(
        purchasing.receive_po, po_id,
        [r.model_dump() for r in body.receipts],
        token=body.token, create_backorder=body.create_backorder,
        actor=_actor_name(request))


@router.post("/purchase-orders/{po_id}/close")
def po_close(po_id: int, request: Request):
    """v2.22: cierre FINANCIERO (fin_status closed). No toca stock ni
    congela costos: líneas y ajustes siguen editables."""
    return _po_call(purchasing.close_po, po_id, actor=_actor_name(request))


@router.post("/purchase-orders/{po_id}/reopen")
def po_reopen(po_id: int, request: Request):
    """v2.22: reabre el ciclo financiero (solo fin_status)."""
    return _po_call(purchasing.reopen_po, po_id, actor=_actor_name(request))


@router.post("/purchase-orders/{po_id}/adjustments")
def po_add_adjustment(po_id: int, body: PoAdjustmentIn, request: Request):
    """v2.22: descuento/crédito/flete/tax/fee/pago a cualquier status."""
    return _po_call(
        purchasing.add_adjustment, po_id, body.kind, body.amount,
        note=body.note, allocate=body.allocate, actor=_actor_name(request),
        dry_run=body.dry_run)


@router.post("/purchase-orders/{po_id}/adjustments/{adj_id}/void")
def po_void_adjustment(po_id: int, adj_id: int, request: Request,
                       body: PoVoidIn | None = None):
    """v2.22: anula un ajuste (nunca se borra). Body opcional {reason}."""
    return _po_call(
        purchasing.void_adjustment, po_id, adj_id,
        reason=body.reason if body else "",
        actor=_actor_name(request), not_found="PO or adjustment not found")


@router.post("/purchase-orders/{po_id}/lines")
def po_add_line(po_id: int, body: POLineIn, request: Request):
    return _po_call(
        purchasing.add_line, po_id, body.part_number, body.description,
        body.qty, body.unit_cost, actor=_actor_name(request),
        taxable=body.taxable, dry_run=body.dry_run)


@router.patch("/purchase-orders/{po_id}/lines/{line_id}")
def po_patch_line(po_id: int, line_id: int, body: POLinePatch,
                  request: Request):
    """v2.22: edita costo/qty/taxable/descripción a CUALQUIER status. En una
    línea con unidades recibidas, un cambio de costo revalúa el inventario
    (movimiento po_cost_adj + avg_cost por la porción en stock)."""
    fields = {k: v for k, v in body.model_dump().items()
              if v is not None and k != "dry_run"}
    return _po_call(
        purchasing.update_line, po_id, line_id, fields,
        actor=_actor_name(request), dry_run=body.dry_run,
        not_found="PO or line not found")


@router.post("/purchase-orders/{po_id}/lines/{line_id}/unreceive")
def po_unreceive_line(po_id: int, line_id: int, request: Request):
    """v2.22: único camino de regresión desde 'received' — revierte el stock
    de la línea (po_unreceive) y anula sus cores pendientes."""
    return _po_call(
        purchasing.unreceive_line, po_id, line_id,
        actor=_actor_name(request), not_found="PO or line not found")


@router.delete("/purchase-orders/{po_id}/lines/{line_id}")
def po_del_line(po_id: int, line_id: int, request: Request,
                dry_run: bool = False):
    """?dry_run=true: preview del re-prorrateo (revaluations) sin borrar."""
    return _po_call(purchasing.delete_line, po_id, line_id,
                    actor=_actor_name(request), dry_run=dry_run)


# ----- Core tracking (banco de cores, v2.5) ---------------------------------
# El moat: cores pendientes de devolver al proveedor para recuperar el
# depósito. GET = lectura; return/unreturn caen bajo /api/cores => maint.edit.

@router.get("/cores")
def cores_list(status: str = "pending"):
    return {"cores": cores.list_cores(status), "stats": cores.core_stats()}


@router.post("/cores/{core_id}/return")
def core_return(core_id: int):
    c = cores.return_core(core_id)
    if c is None:
        raise HTTPException(status_code=404, detail="Core not found")
    return c


@router.post("/cores/{core_id}/unreturn")
def core_unreturn(core_id: int):
    c = cores.unreturn_core(core_id)
    if c is None:
        raise HTTPException(status_code=404, detail="Core not found")
    return c


# ----- Warranty tracking (reclamos de garantía, v2.6) -----------------------
# El moat: parte reusada dentro de garantía en la misma unidad => claim. El GET
# es solo lectura; el escaneo (que escribe claims) vive en un POST aparte para
# no mutar en cada lectura ni correr dos escaneos concurrentes en paralelo. El
# front dispara /scan al abrir Purchasing. Todo /api/warranty => maint.edit.

@router.get("/warranty")
def warranty_list(status: str = "open"):
    return {"claims": warranty.list_claims(status),
            "stats": warranty.claim_stats()}


@router.post("/warranty/scan")
def warranty_scan():
    return {"created": warranty.scan()}


class WarrantyStatusIn(BaseModel):
    status: str          # open | submitted | recovered | dismissed


@router.post("/warranty/{claim_id}/status")
def warranty_status(claim_id: int, body: WarrantyStatusIn):
    try:
        c = warranty.set_status(claim_id, body.status)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if c is None:
        raise HTTPException(status_code=404, detail="Claim not found")
    return c


# ----- Parts Requests (cola de faltantes -> bundle por vendor -> PO) --------
# Increment 4. GET = lectura; POST/DELETE exigen maint.edit (el prefijo
# /api/parts-requests cae bajo /api/parts en _scope_for). Las rutas estáticas
# (generate-low-stock, bundle) van ANTES de la dinámica /{req_id}.

@router.get("/parts-requests")
def parts_requests_list(status: str = "pending"):
    return {"requests": purchasing.list_requests(status),
            "stats": purchasing.request_stats()}


@router.post("/parts-requests")
def parts_requests_create(body: PartsRequestIn, request: Request):
    u = getattr(request.state, "user", None) or {}
    by = u.get("name") or u.get("username") or ""
    try:
        return purchasing.create_request(
            part_number=body.part_number, description=body.description,
            qty=body.qty, unit_cost=body.unit_cost, vendor=body.vendor,
            source=body.source, source_ref=body.source_ref, requested_by=by)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/parts-requests/generate-low-stock")
def parts_requests_generate():
    return purchasing.generate_low_stock_requests()


@router.post("/parts-requests/bundle")
def parts_requests_bundle(body: BundleRequestsIn, request: Request):
    try:
        return purchasing.bundle_requests(body.request_ids,
                                          actor=_actor_name(request))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/parts-requests/{req_id}")
def parts_requests_cancel(req_id: int):
    if not purchasing.cancel_request(req_id):
        raise HTTPException(status_code=404, detail="Request not found")
    return {"ok": True}


# ----- Permisos (matriz rol → capacidad, READ-ONLY) ------------------------
# Increment 5 del handoff: expone en la UI (Settings) exactamente los scopes
# RBAC que el middleware enforce. GET => solo requiere estar autenticado.

@router.get("/permissions/matrix")
def permissions_matrix(request: Request):
    return permissions.matrix(getattr(request.state, "org_id", None))


@router.post("/permissions/matrix")
def permissions_matrix_save(body: PermMatrixIn, request: Request):
    """Guarda la matriz de permisos de la org (admin-only por el fail-closed
    de _scope_for → settings.manage). `admin` se ignora (siempre full)."""
    try:
        return permissions.save_matrix(
            getattr(request.state, "org_id", None), body.grants)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/workorders/{wo_id}/lines/{line_id}")
def wo_del_line(wo_id: int, line_id: int):
    try:
        wo = workorders.delete_line(wo_id, line_id)
    except ValueError as exc:
        # Líneas congeladas en una WO facturada (v2.21).
        raise HTTPException(status_code=400, detail=str(exc))
    if wo is None:
        raise HTTPException(status_code=404, detail="WO not found")
    return wo


@router.get("/reefer")
async def reefer_live():
    """Snapshot del cold chain. Fuente directa por prioridad Lynx (OEM) ->
    Traccar (aftermarket) -> demo etiquetado (demo: true)."""
    return await reefer.load_live()


@router.get("/reefer/history")
async def reefer_history(id: str, hours: int = 24):
    """Serie de temperaturas de un reefer para el chart (24 h default)."""
    return await reefer.history(id, max(1, min(hours, 72)))


class ReeferSetpointIn(BaseModel):
    setpoint_f: float


class ReeferCommandIn(BaseModel):
    command: str                 # mode | defrost | power
    mode: str | None = None
    on: bool | None = None


@router.post("/reefer/{unit_id}/setpoint")
async def reefer_setpoint(unit_id: str, body: ReeferSetpointIn):
    """Cambia el setpoint REAL del reefer vía su API OEM (two-way).

    Se despacha por prefijo al módulo OEM (Carrier Lynx 'lynx-' / Thermo
    King 'tk-'). El módulo devuelve {ok: false, detail} si falta config o
    el tier no habilita control (-> 400)."""
    r = await reefer.set_setpoint(unit_id, body.setpoint_f)
    if not r.get("ok"):
        raise HTTPException(status_code=400, detail=r.get("detail", "Failed"))
    return r


@router.post("/reefer/{unit_id}/command")
async def reefer_command(unit_id: str, body: ReeferCommandIn):
    """Comandos OEM extra (two-way): mode / defrost / power."""
    r = await reefer.command(unit_id, body.command, body.mode, body.on)
    if not r.get("ok"):
        raise HTTPException(status_code=400, detail=r.get("detail", "Failed"))
    return r


@router.get("/track")
async def track_live():
    """Snapshot del Live Map: unidades con GPS + duty status (fase G1).

    Si el token aún no tiene los scopes nuevos, devuelve available=False
    con missing_scopes para que la UI muestre el setup guiado.
    """
    return await tracking.load_live()


class AlertsSettingsIn(BaseModel):
    rules: dict = {}
    channels: dict = {}
    recipients: dict = {}


class AckIn(BaseModel):
    ids: list[int] | None = None


class UnitSettingsIn(BaseModel):
    unit: str
    nickname: str = ""
    group: str = ""
    muted: bool = False
    notes: str = ""


@router.get("/alerts/settings")
def alerts_settings():
    return alerts.get_settings()


@router.post("/alerts/settings")
def alerts_settings_save(body: AlertsSettingsIn):
    return alerts.save_settings(body.model_dump())


@router.get("/alerts/events")
def alerts_events(limit: int = 50, unacked: int = 0):
    return {"events": alerts.list_events(limit=min(limit, 200),
                                         unacked_only=bool(unacked))}


@router.post("/alerts/ack")
def alerts_ack(body: AckIn):
    return {"acked": alerts.ack_events(body.ids)}


@router.get("/units/settings")
def units_settings(unit: str = ""):
    """Perfil de una unidad (o todos si no se pasa `unit`)."""
    if unit:
        return unit_settings.get_unit(unit)
    return unit_settings.all_settings()


@router.post("/units/settings")
def units_settings_save(body: UnitSettingsIn):
    try:
        return unit_settings.set_unit(body.unit, body.nickname,
                                      body.group, body.muted, body.notes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class PoiIn(BaseModel):
    kind: str
    name: str
    lat: float
    lng: float
    address: str = ""
    phone: str = ""
    subtype: str = ""


class PoiSearchIn(BaseModel):
    query: str
    lat: float | None = None
    lng: float | None = None


@router.get("/pois")
def list_pois():
    """POIs del mapa (talleres/dealers/básculas) + atribución ODbL."""
    return {"attribution": pois.attribution(), "pois": pois.list_pois()}


@router.post("/pois")
def add_poi(body: PoiIn):
    try:
        return pois.add_poi(body.kind, body.name, body.lat, body.lng,
                            body.address, body.phone, body.subtype)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/pois/{poi_id}")
def delete_poi(poi_id: str):
    if not pois.delete_poi(poi_id):
        raise HTTPException(status_code=404, detail="POI not found")
    return {"ok": True}


@router.post("/pois/google-search")
async def poi_google_search(body: PoiSearchIn):
    """Búsqueda Google Places para mostrar EN LISTA (nunca en el mapa —
    los ToS de Google prohíben pintar Places sobre mapas no-Google)."""
    q = body.query.strip()
    if not q:
        raise HTTPException(status_code=400, detail="query is empty")
    return await pois.google_search(q, body.lat, body.lng)


# ----- Auth (fase G7) ----------------------------------------------------

class AuthSetupIn(BaseModel):
    name: str
    username: str
    password: str


class AuthLoginIn(BaseModel):
    username: str
    password: str


class UserIn(BaseModel):
    name: str
    username: str
    password: str
    role: str = "viewer"


class UserPatch(BaseModel):
    role: str | None = None
    active: bool | None = None
    password: str | None = None
    name: str | None = None


def _user_from(request: Request) -> dict | None:
    """SEC-4 fix: el usuario lo resuelve el middleware (cookie-aware) y lo deja
    en request.state.user. En rutas del allowlist (sin middleware) cae a
    auth.user_from_request (lee la cookie HttpOnly y, como fallback, el Bearer).
    NUNCA leer solo el header Authorization: la sesión vive en la cookie, así
    que el header viene vacío y el chequeo fallaría — esto causaba que facturar
    una WO y refrescar el navegador (auth/status) sacaran al usuario al login."""
    u = getattr(request.state, "user", None)
    if u is not None:
        return u
    return auth.user_from_request(request)


def _require_admin(request: Request) -> dict:
    user = _user_from(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if user["role"] != "admin":
        raise HTTPException(status_code=403,
                            detail="Admin role required")
    return user


def require_scope(scope: str, request: Request) -> dict:
    """Exige que el usuario tenga `scope` (H4). Bootstrap (sin usuarios aún)
    queda abierto. Para refinamientos dependientes del body que el middleware
    no puede ver (p.ej. facturar una WO)."""
    user = _user_from(request)
    if user is None:
        if not auth.users_exist():
            return {"id": 0, "role": "admin", "username": "", "name": ""}
        raise HTTPException(status_code=401, detail="Not authenticated")
    if not permissions.has_scope(user.get("org_id"), user["role"], scope):
        raise HTTPException(
            status_code=403,
            detail=f"Your role ({user['role']}) can't do this")
    return user


@router.get("/auth/status")
def auth_status(request: Request):
    """Estado de autenticación. Allowlisted: nunca devuelve 401."""
    user = _user_from(request)
    return {
        "setup_needed": not auth.users_exist(),
        "authenticated": user is not None,
        "user": user,
        "scopes": (permissions.scopes_for(user.get("org_id"), user["role"])
                   if user else []),
        "branding": org_config.branding(),
    }


def _too_many(retry_after_s: int) -> HTTPException:
    """SEC-3: 429 con header Retry-After y mensaje claro. El cliente sabe
    cuanto esperar; el front ya parsea `detail` via readError."""
    return HTTPException(
        status_code=429,
        detail=f"Too many attempts, try again in {retry_after_s} s",
        headers={"Retry-After": str(retry_after_s)})


@router.post("/auth/setup")
def auth_setup(body: AuthSetupIn, request: Request, response: Response):
    """Crea el PRIMER usuario (admin). Solo con la tabla vacía."""
    # SEC-3: rate limit por IP como defensa (este endpoint solo funciona con
    # la tabla vacia, pero no debe poder martillarse).
    ip = ratelimit.client_ip(request)
    if not ratelimit.hit(f"setup:{ip}", ratelimit.SETUP_RATE,
                         ratelimit.SETUP_RATE_WINDOW_S):
        raise _too_many(ratelimit.SETUP_RATE_WINDOW_S)
    try:
        user = auth.setup_admin(body.name, body.username, body.password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    result = auth.login(body.username, body.password)
    token = result["token"] if result else ""
    if token:
        # SEC-4: tras el onboarding deja la sesión iniciada por cookie HttpOnly
        # (igual que el login), para no forzar un login extra al recién creado.
        response.set_cookie(
            auth.COOKIE_NAME, token, httponly=True,
            secure=(not config.IS_SQLITE), samesite="strict",
            max_age=auth.TOKEN_TTL_S, path="/")
    return {"user": user, "token": token}


@router.post("/auth/login")
def auth_login(body: AuthLoginIn, request: Request, response: Response):
    # SEC-3: defensa anti fuerza bruta. Orden: ban de IP -> rate limit por IP
    # -> bloqueo de cuenta -> credenciales. La IP real sale del XFF (Traefik).
    ip = ratelimit.client_ip(request)
    banned, ban_left = ratelimit.is_banned(ip)
    if banned:
        raise _too_many(ban_left)
    if not ratelimit.hit(f"login:{ip}", ratelimit.LOGIN_RATE,
                         ratelimit.LOGIN_RATE_WINDOW_S):
        raise _too_many(ratelimit.LOGIN_RATE_WINDOW_S)
    locked, lock_left = ratelimit.is_locked(body.username)
    if locked:
        raise _too_many(lock_left)

    result = auth.login(body.username, body.password)
    if result is None:
        # Fallo: cuenta hacia ban de IP y hacia bloqueo de cuenta.
        ratelimit.record_failure(ip)
        ratelimit.record_account_failure(body.username)
        # Mensaje generico (no filtra si el usuario existe).
        raise HTTPException(status_code=401,
                            detail="Incorrect username or password")
    # Exito: limpia ambos contadores.
    ratelimit.record_success(ip)
    ratelimit.record_account_success(body.username)
    # SEC-4: la sesión viaja en una cookie HttpOnly (el JS no la lee → a prueba
    # de robo por XSS). `secure` solo en prod (HTTPS); en dev (SQLite/http) no,
    # o el navegador no la setearía. SameSite=Strict → protección CSRF fuerte.
    response.set_cookie(
        auth.COOKIE_NAME, result["token"], httponly=True,
        secure=(not config.IS_SQLITE), samesite="strict",
        max_age=auth.TOKEN_TTL_S, path="/")
    return result


@router.post("/auth/logout")
def auth_logout(response: Response):
    """SEC-4: cierra sesión limpiando la cookie. Está en el allowlist (limpiar
    la propia cookie no requiere estar autenticado)."""
    response.delete_cookie(auth.COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/auth/users")
def auth_users(request: Request):
    _require_admin(request)
    return {"users": auth.list_users()}


@router.post("/auth/users")
def auth_users_create(body: UserIn,
                      request: Request):
    _require_admin(request)
    try:
        return auth.create_user(body.name, body.username, body.password,
                                body.role)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.patch("/auth/users/{user_id}")
def auth_users_patch(user_id: int, body: UserPatch,
                     request: Request):
    admin = _require_admin(request)
    try:
        user = auth.update_user(
            user_id,
            {k: v for k, v in body.model_dump().items() if v is not None},
            acting_admin_id=admin["id"])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if user is None:
        raise HTTPException(status_code=404, detail="User does not exist")
    return user


# ----- Configuración de empresa (fase G7) ---------------------------------

@router.get("/org/branding")
def org_branding():
    """Branding para el login/wizard. Allowlisted (sin token)."""
    return org_config.branding()


@router.get("/org")
def org_get():
    return org_config.get()


@router.post("/org")
def org_save(body: dict,
             request: Request):
    _require_admin(request)
    try:
        return org_config.save(body)
    except ValueError as exc:             # v2.22: p.ej. timezone inválida
        raise HTTPException(status_code=400, detail=str(exc))


# ----- Terminales dinámicas (Settings → Terminals) -------------------------

class TerminalIn(BaseModel):
    key: str = ""            # vacío = crear; existente = editar
    label: str
    prefixes: list[str] = []
    # v2.22 (Resources → Locations): ficha opcional de la location. Al
    # editar, los campos que no vienen se conservan.
    type: str | None = None             # '' | shop | yard | terminal
    code: str | None = None
    address: str | None = None
    city: str | None = None
    state: str | None = None
    zip: str | None = None
    phone: str | None = None


class TerminalAssignIn(BaseModel):
    terminal: str
    units: list[str] = []


@router.get("/terminals")
def terminals_get():
    """Terminales configuradas + asignaciones manuales unidad→terminal."""
    return terminals.get_all()


@router.post("/terminals")
def terminals_save(body: TerminalIn,
                   request: Request):
    _require_admin(request)
    location = body.model_dump(exclude_unset=True,
                               include=set(terminals.LOCATION_FIELDS))
    try:
        return terminals.save_terminal(body.key, body.label, body.prefixes,
                                       location)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/terminals/{key}")
def terminals_delete(key: str,
                     request: Request):
    _require_admin(request)
    try:
        return terminals.delete_terminal(key)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/terminals/assign")
def terminals_assign(body: TerminalAssignIn,
                     request: Request):
    """Reemplaza la flota pinneada de la terminal por la lista enviada."""
    _require_admin(request)
    try:
        return terminals.assign(body.terminal, body.units)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ----- Equipos (Settings → Teams) ------------------------------------------

class DriverIn(BaseModel):
    name: str = ""
    email: str = ""


class TeamIn(BaseModel):
    key: str = ""            # vacío = crear; existente = editar
    label: str
    drivers: list[DriverIn] = []


class TeamAssignIn(BaseModel):
    team: str
    units: list[str] = []


@router.get("/teams")
def teams_get():
    """Equipos configurados + membresías unidad→equipo."""
    return teams.get_all()


@router.post("/teams")
def teams_save(body: TeamIn,
               request: Request):
    _require_admin(request)
    try:
        return teams.save_team(
            body.key, body.label, [d.model_dump() for d in body.drivers])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/teams/{key}")
def teams_delete(key: str,
                 request: Request):
    _require_admin(request)
    try:
        return teams.delete_team(key)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/teams/assign")
def teams_assign(body: TeamAssignIn,
                 request: Request):
    """Reemplaza la flota del equipo por la lista enviada."""
    _require_admin(request)
    try:
        return teams.assign(body.team, body.units)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ----- Unidades manuales (Fleet → Add New Unit) ----------------------------

class UnitIn(BaseModel):
    unit: str
    unit_type: str = "truck"
    subtype: str = ""
    terminal: str = ""
    customer: str = ""
    company: str = ""
    vin: str = ""
    year: str = ""
    make: str = ""
    model: str = ""
    fleet_no: str = ""
    plate: str = ""
    plate_state: str = ""


@router.get("/units/manual")
def units_manual_list():
    """Unidades agregadas a mano (las del tenant actual)."""
    return {"units": manual_units.list_units()}


@router.post("/units/manual")
def units_manual_add(body: UnitIn):
    try:
        return manual_units.add(body.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/units/manual/{unit_id}")
def units_manual_delete(unit_id: int):
    return {"deleted": manual_units.delete(unit_id)}


class UnitsCsvIn(BaseModel):
    csv: str = ""


@router.get("/units/manual/template")
def units_manual_template():
    """CSV de ejemplo para el import masivo de unidades (Settings)."""
    return {"csv": manual_units.csv_template(),
            "columns": manual_units.CSV_COLUMNS}


@router.post("/units/manual/import")
def units_manual_import(body: UnitsCsvIn,
                        request: Request):
    """Import masivo de unidades desde un CSV (upsert por numero de unidad)."""
    _require_admin(request)
    return manual_units.import_csv(body.csv)


# ----- Empresas (Settings -> Companies) ------------------------------------

class CompanyIn(BaseModel):
    label: str
    key: str = ""


class CompanyRenameIn(BaseModel):
    key: str
    label: str


@router.get("/companies")
def companies_list():
    """Empresas (carriers) del tenant actual.

    Si el tenant no tiene ninguna cargada y estamos en modo demo, se expone la
    empresa de la flota sintetica: el import de ELD EXIGE una empresa, asi que
    sin esto el selector solo ofrecia "(todas)" y no se podia importar nunca."""
    items = companies.list_companies()
    if not items and samsara._demo():
        label = demo_eld.company()
        items = [{"key": label.upper(), "label": label.title()}]
    return {"companies": items}


@router.post("/companies")
def companies_add(body: CompanyIn,
                  request: Request):
    _require_admin(request)
    try:
        return {"companies": companies.add(body.label, body.key)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/companies/rename")
def companies_rename(body: CompanyRenameIn,
                     request: Request):
    _require_admin(request)
    try:
        return {"companies": companies.rename(body.key, body.label)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/companies/{key}")
def companies_delete(key: str,
                     request: Request):
    _require_admin(request)
    return {"companies": companies.delete(key)}


@router.get("/vin/{vin}")
async def vin_decode_endpoint(vin: str):
    """Decodifica un VIN (Year/Make/Model) via NHTSA vPIC."""
    return await vin_decode.decode(vin)


class IntegrationTestIn(BaseModel):
    provider: str


class IntegrationConfigIn(BaseModel):
    provider: str
    values: dict


@router.post("/integrations/test")
async def integrations_test(body: IntegrationTestIn):
    """Chequeo vivo de un proveedor (lecturas mínimas; nunca envía)."""
    return await integrations_admin.test(body.provider)


@router.get("/integrations/specs")
def integrations_specs():
    """Campos editables por proveedor, con secretos enmascarados."""
    return integrations_admin.config_specs()


@router.post("/integrations/config")
def integrations_config(body: IntegrationConfigIn):
    """Escribe credenciales al *.local.json del proveedor (merge)."""
    try:
        return integrations_admin.save_config(body.provider, body.values)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ----- Framework ELD: proveedor activo + preview de adapter -----------------

class EldActiveIn(BaseModel):
    provider: str


@router.post("/integrations/eld/active")
def eld_set_active(body: EldActiveIn,
                   request: Request):
    """Marca cuál proveedor ELD es el activo (fuente de datos por defecto)."""
    _require_admin(request)
    try:
        return {"active": providers.set_active(body.provider)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/integrations/eld/{provider}/fleet-preview")
async def eld_fleet_preview(provider: str,
                            request: Request):
    """Corre el adapter list_fleet del proveedor y devuelve conteo + muestra.

    Verifica de punta a punta que un adapter trae datos reales, sin tocar el
    inventario de la app."""
    _require_admin(request)
    reg = providers.registry()
    prov = reg.get(provider)
    if prov is None:
        raise HTTPException(status_code=404, detail="unknown provider")
    if not prov.capabilities().get("fleet"):
        return {"ok": False, "count": 0, "sample": [],
                "detail": f"{prov.name} has no fleet adapter yet"}
    try:
        units = await prov.list_fleet()
    except (httpx.HTTPError, ValueError, NotImplementedError) as exc:
        return {"ok": False, "count": 0, "sample": [],
                "detail": f"{type(exc).__name__}: {exc}"[:160]}
    sample = [{"unit": u.get("unit"), "year": u.get("year"),
               "make": u.get("make"), "model": u.get("model"),
               "vin": u.get("vin")} for u in units[:25]]
    return {"ok": True, "count": len(units), "sample": sample,
            "detail": f"{len(units)} unit{'s' if len(units) != 1 else ''}"}


# Qué proveedores soportan test/configure desde la UI.
_TESTABLE = {"samsara", "motive",
             "gplaces", "telegram", "docscan",
             "traccar", "lynx", "thermoking"}
_CONFIGURABLE = {"samsara", "motive",
                 "gplaces", "telegram", "docscan", "traccar",
                 "lynx", "thermoking"}


@router.get("/integrations")
def integrations_status():
    """Hub de Conectividad (Settings): estado de cada integración externa.

    Solo estado y metadatos — NUNCA credenciales (los tokens viven en
    backend/*.local.json hasta que llegue la edición en-app, fase G6/G7).
    Estados: connected | live | dry_run | not_configured | available | planned.
    """
    out = {
        "groups": [
            providers.hub_group(),
            {
                "id": "notifications",
                "label": "Shop notifications",
                "note": "Ping the shop group when a work order is assigned.",
                "providers": [
                    {
                        "id": "telegram", "name": "Telegram · shop bot",
                        "kind": "Work order notifications",
                        "status": ("not_configured"
                                   if not telegram_notify.configured()
                                   else "dry_run"
                                   if telegram_notify.load_settings()[
                                       "dry_run"]
                                   else "live"),
                        "detail": ("Notifies the shop group on Assigned"
                                   if telegram_notify.configured()
                                   else "Configure bot token + chat id"),
                        "items": [],
                    },
                ],
            },
            {
                "id": "data",
                "label": "Data sources",
                "note": "",
                "providers": [
                    {
                        "id": "gplaces", "name": "Google Places",
                        "kind": "Map services search (list only)",
                        "status": "connected" if pois.google_configured()
                                  else "not_configured",
                        "detail": ("Text Search API"
                                   if pois.google_configured()
                                   else "Configure a Places API key"),
                        "items": [],
                    },
                    {
                        "id": "docscan", "name": "AI document scan",
                        "kind": "Invoice and estimate autofill",
                        "status": docscan.status()[0],
                        "detail": docscan.status()[1],
                        "items": [],
                    },
                    {
                        "id": "parts_marketplace",
                        "name": "Parts marketplace",
                        "kind": "Live parts pricing & availability",
                        "status": ("connected"
                                   if parts_marketplace.status()["configured"]
                                   else "not_configured"),
                        "detail": parts_marketplace.status()["detail"],
                        "items": [],
                    },
                ],
            },
            {
                "id": "coldchain",
                "label": "Cold chain",
                "note": "Reefer data from your OWN integration — direct, "
                        "independent of the ELD. OEM (Carrier Lynx) for real "
                        "remote control, or aftermarket hardware via Traccar. "
                        "See backend/LYNX_SETUP.md / REEFER_SETUP.md.",
                "providers": [
                    {
                        "id": "lynx", "name": "Carrier Lynx · OEM reefer",
                        "kind": "Reefer monitor + remote control (OEM)",
                        "status": ("connected" if lynx.is_configured()
                                   else "not_configured"),
                        "detail": (
                            (f"{lynx.load_settings()['base_url']} · "
                             f"tier {lynx.load_settings()['tier']}"
                             + ("" if lynx.can_control()
                                else " (read-only — needs Monitor+Control)"))
                            if lynx.is_configured()
                            else "Configure base URL + dealer credentials"),
                        "items": [],
                    },
                    {
                        "id": "thermoking",
                        "name": "Thermo King · OEM reefer",
                        "kind": "Reefer monitor + remote control (OEM)",
                        "status": ("connected" if thermoking.is_configured()
                                   else "not_configured"),
                        "detail": (
                            (f"{thermoking.load_settings()['base_url']} · "
                             f"tier {thermoking.load_settings()['tier']}"
                             + ("" if thermoking.can_control()
                                else " (read-only — needs two-way tier)"))
                            if thermoking.is_configured()
                            else "Configure base URL + TracKing credentials"),
                        "items": [],
                    },
                    {
                        "id": "traccar", "name": "Traccar · reefer trackers",
                        "kind": "Reefer temperature (aftermarket hardware)",
                        "status": ("connected" if traccar.is_configured()
                                   else "not_configured"),
                        "detail": (traccar.load_settings()["url"]
                                   if traccar.is_configured()
                                   else "Configure server URL + token"),
                        "items": [],
                    },
                ],
            },
        ],
    }
    # Los proveedores ELD ya traen testable/configurable desde su hub_card
    # (autodescripción); el resto los deriva de los sets estáticos.
    for g in out["groups"]:
        for p in g["providers"]:
            p.setdefault("testable", p["id"] in _TESTABLE)
            p.setdefault("configurable", p["id"] in _CONFIGURABLE)
    return out


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
    de DVIR). Solo Samsara (sin fallback CSV). La lógica vive en
    core/fleet_inventory: Service Requests (v2.20) canoniza y valida la unidad
    contra este mismo universo.
    """
    return await fleet_inventory.load(refresh)


@router.get("/drivers")
async def drivers_endpoint(request: Request, refresh: bool = False):
    """Conductores activos (Samsara) + email del snapshot local de Driver info.
    El email NO se lee en vivo; viene del snapshot (ver /drivers/sync-contacts).
    H4: si el rol no tiene pii.view, email/teléfono salen enmascarados."""
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
    # H4: enmascarar PII server-side si el rol no la puede ver. user None =
    # bootstrap (sin usuarios) -> se muestra (el middleware ya filtró el resto).
    user = _user_from(request)
    masked = user is not None and not permissions.has_scope(
        user.get("org_id"), user["role"], "pii.view")
    if masked:
        for d in drivers:
            d["email"] = _mask_email(d.get("email", ""))
            d["phone"] = _mask_phone(d.get("phone", ""))
    return {"available": True, "source": "samsara", "pii_masked": masked,
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
    → millas hasta el próximo PM. El intervalo y el umbral "Upcoming" son
    configurables por empresa (org.local.json, fase G7)."""
    interval = org_config.threshold("pm_interval_miles")
    upcoming = org_config.threshold("pm_upcoming_miles")
    if refresh:
        samsara.clear_cache()
    records = pm.load()
    # Unidades manuales (Fleet -> Add New Unit) que no esten en el CSV: fila PM
    # base (sin historial) para que aparezcan y se les pueda cargar PM history.
    csv_names = {r["unit"] for r in records}
    for name in manual_units.names():
        if name not in csv_names:
            records.append({"unit": name, "model": "", "pm_type": None,
                            "last_pm_date": None, "last_pm_miles": None,
                            "report_miles": None})
    if not records:
        return {"available": False, "interval": interval,
                "upcoming_miles": upcoming, "units": [], "excluded": []}
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
        next_due = last + interval if last is not None else None
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
    return {"available": True, "interval": interval,
            "upcoming_miles": upcoming, "units": out,
            "excluded": sorted(excluded, key=lambda e: e["unit"])}


# ----- Tableros gemelos PM / DOT (fase H1) -------------------------------

@router.get("/maint/due")
async def maint_due(limit: int = 100):
    """PMs vencidos y por vencer de pm + dot + reefer en UNA lista (tarjeta
    "PMs Due & Overdue" del Home). Literal: va ANTES de /maint/{kind}."""
    return await maint.due(max(1, min(int(limit or 100), 1000)))


@router.get("/maint/{kind}")
async def maint_board(kind: str, refresh: bool = False):
    """Tablero editable de PM, DOT Inspections o Reefer PM (v2.22, por
    horas de motor): misma forma de fila para los tres."""
    try:
        return await maint.board(kind, refresh=refresh)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


class MaintRecordIn(BaseModel):
    kind: str            # pm | dot | reefer | … (maint.CAMPAIGNS)
    unit: str
    date: str            # YYYY-MM-DD
    mileage: int | None = None
    notes: str = ""
    hours: float | None = None   # v2.22: horas de motor del servicio


@router.post("/maint/record")
def maint_add_record(body: MaintRecordIn):
    try:
        rec = maint.add_record(body.unit, body.kind, body.date,
                               body.mileage, body.notes, hours=body.hours)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True, "record": rec}


class OpsStatusIn(BaseModel):
    unit: str
    status: str          # '' | out_of_service | in_shop


@router.post("/maint/ops-status")
def maint_ops_status(body: OpsStatusIn):
    try:
        maint.set_ops_status(body.unit, body.status)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True}


@router.get("/maint/odometer/{unit}")
async def maint_odometer(unit: str):
    """Odómetro actual de una unidad (botón del modal Add PM/DOT)."""
    return await maint.unit_odometer(unit)


# ----- Perfil de unidad (fase H3, estilo Fullbay) -------------------------

@router.get("/units/{unit}/campaigns")
async def unit_campaigns(unit: str, model: str = ""):
    """Pestaña Components & PMs: campañas con último servicio y due."""
    return await maint.unit_campaigns(unit, model)


class CampaignIn(BaseModel):
    key: str
    enabled: bool


@router.post("/units/{unit}/campaigns")
def unit_campaign_toggle(unit: str, body: CampaignIn):
    if body.key not in maint.CAMPAIGNS or maint.CAMPAIGNS[body.key]["default"]:
        raise HTTPException(status_code=400, detail="invalid campaign")
    try:
        # v2.22: una campaña AUTOMÁTICA (PM del reefer) apagada a mano queda
        # apagada aunque la unidad se siga detectando como reefer (opt-out).
        unit_settings.set_campaign(
            unit, body.key, body.enabled,
            opt_out=bool(maint.CAMPAIGNS[body.key].get("auto")))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True}


@router.get("/units/{unit}/parts-used")
def unit_parts_used(unit: str):
    """Pestaña Parts used: partes usadas en las WOs de esta unidad + resumen."""
    return workorders.parts_used_by_unit(unit)


class OdometerIn(BaseModel):
    date: str = ""      # YYYY-MM-DD; vacío = hoy
    miles: int


@router.get("/units/{unit}/odometer")
def unit_odometer(unit: str):
    """Lecturas de odómetro de la unidad (para el CPM sin integración ELD)."""
    return odometer.unit_readings(unit)


@router.post("/units/{unit}/odometer")
def unit_odometer_log(unit: str, body: OdometerIn):
    """Registra (o corrige) una lectura MANUAL de odómetro. Alimenta el mismo
    `odometer_reading` que el backfill/Samsara => el CPM funciona con lo que el
    taller cargue a mano. Bajo maint.edit (prefijo /api/units en _scope_for)."""
    r = odometer.log_reading(unit, body.date, body.miles)
    if r is None:
        raise HTTPException(
            400, "Enter a positive mileage and a valid date (YYYY-MM-DD).")
    return r


class MeterReadingIn(BaseModel):
    value: float
    date: str = ""      # YYYY-MM-DD; vacío = hoy (zona de la org)
    # Guardar aunque no sea creíble (más baja que la anterior o más de 24 h
    # por día): horómetro reseteado o controlador cambiado.
    force: bool = False


def _check_meter(meter: str) -> None:
    if meter not in meters.METERS:
        raise HTTPException(status_code=404, detail="unknown meter")


@router.get("/units/{unit}/meters/{meter}")
def unit_meter_readings(unit: str, meter: str):
    """Lecturas del medidor de la unidad (v2.22: engine_hours, el horómetro
    del reefer — tabla propia, nunca el odómetro). {latest, count,
    readings}."""
    _check_meter(meter)
    return meters.unit_readings(unit, meter)


@router.post("/units/{unit}/meters/{meter}")
def unit_meter_log(unit: str, meter: str, body: MeterReadingIn):
    """Registra (o corrige: mismo día) una lectura MANUAL del medidor y
    devuelve la lectura vigente {value, date, source}. 400 si no es creíble
    (reintentar con force=true). Bajo maint.edit (prefijo /api/units)."""
    _check_meter(meter)
    try:
        meters.log_reading(unit, body.value, body.date, source="manual",
                           meter=meter, force=body.force)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    service_requests.mark_stale()   # cambió lo que vence (PM del reefer)
    return {"unit": unit.strip(), **(meters.latest(unit, meter) or {})}


@router.get("/units/{unit}/docs")
def unit_docs_list(unit: str):
    return {"docs": unitdocs.list_docs(unit),
            "kinds": [{"key": k, "label": unitdocs.KIND_LABEL[k]}
                      for k in unitdocs.KINDS]}


@router.post("/units/{unit}/docs")
async def unit_docs_upload(unit: str, kind: str = "",
                           files: list[UploadFile] = File(...)):
    """Sube UNO O VARIOS documentos de la unidad de un solo saque."""
    saved, errors = [], []
    for f in files:
        raw = await f.read()
        try:
            saved.append(unitdocs.save_doc(
                unit, kind, f.filename or "document", raw))
        except ValueError as exc:
            errors.append(str(exc))
    if not saved and errors:
        raise HTTPException(status_code=400, detail="; ".join(errors[:3]))
    return {"saved": saved, "errors": errors}


@router.get("/units/docs/{doc_id}/download")
def unit_doc_download(doc_id: int):
    found = unitdocs.doc_path(doc_id)
    if found is None:
        raise HTTPException(status_code=404, detail="Document not found")
    path, filename = found
    return FileResponse(path, filename=filename)


@router.delete("/units/docs/{doc_id}")
def unit_doc_delete(doc_id: int):
    if not unitdocs.delete_doc(doc_id):
        raise HTTPException(status_code=404, detail="Document not found")
    return {"ok": True}


# ----- Foto de identidad por unidad (v2.13, elemento 05) --------------------

@router.get("/units/photos")
def unit_photos_index():
    """Unidades con foto disponible (subida o fallback demo). El Fleet pide
    solo estas — evita un 404 por cada tarjeta sin foto."""
    return {"units": unit_photos.units_with_photo()}


@router.get("/units/{unit}/photo")
def unit_photo_get(unit: str):
    found = unit_photos.photo_path(unit)
    if found is None:
        raise HTTPException(status_code=404, detail="No photo for this unit")
    path, mime = found
    return FileResponse(path, media_type=mime)


@router.post("/units/{unit}/photo")
async def unit_photo_upload(unit: str, file: UploadFile = File(...)):
    """Sube (o REEMPLAZA) la foto de la unidad."""
    raw = await file.read()
    try:
        return unit_photos.save_photo(unit, file.filename or "photo.jpg", raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/units/{unit}/photo")
def unit_photo_delete(unit: str):
    if not unit_photos.delete_photo(unit):
        raise HTTPException(status_code=404, detail="No photo for this unit")
    return {"ok": True}


# ----- Get set up (v2.13, centro de guías del Dashboard) --------------------

@router.get("/help/setup-status")
def help_setup_status():
    """Checklist de onboarding con estado REAL (cada paso se marca solo cuando
    el dato existe en el tenant)."""
    return setup_status_core.setup_status()


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
        raise HTTPException(404, "Block not found.")
    # Columnas segun la plantilla del bloque (Legacy = sin Pre-trip), derivadas
    # de los datos guardados.
    block["columns"] = engine.columns_for_groups(block["groups"])
    return block


@router.delete("/dvir/blocks/{block_id}")
def dvir_block_delete(block_id: int):
    """Borra un bloque DVIR generado del board."""
    if not db.delete_block(block_id):
        raise HTTPException(404, "Block not found.")
    return {"ok": True}


@router.get("/dvir/blocks/{block_id}/download")
def dvir_block_download(block_id: int):
    """Genera y descarga el Excel de un bloque guardado."""
    block = db.get_block(block_id)
    if block is None:
        raise HTTPException(404, "Block not found.")
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
        raise HTTPException(422, "No driver selected.")
    media = None
    if req.media_type and req.media_url:
        media = {"type": req.media_type, "url": req.media_url}
    try:
        return notify_service.send(
            req.sheet, req.date_label, req.drivers, req.channels, media)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post("/notify/media")
async def notify_media(file: UploadFile = File(...)):
    """Sube una imagen/video a Cloudinary (URL pública para SMS/MMS) para
    adjuntarlo al aviso. En dry_run devuelve una URL ficticia."""
    content = await file.read()
    mime = file.content_type or "application/octet-stream"
    kind = "video" if mime.startswith("video/") else (
        "image" if mime.startswith("image/") else "document")
    host = media_host.upload(content, mime, file.filename or "media")
    return {
        "ok": host["ok"],
        "media_type": kind,
        "media_url": host.get("url", ""),
        "url_simulated": host.get("simulated", True),
        "error": host.get("error", ""),
        "filename": file.filename, "size": len(content),
    }


# ----- Plantillas de mensajes + broadcast (Notices) ------------------------

class TemplateIn(BaseModel):
    id: str = ""
    name: str
    subject: str = ""
    body: str = ""


class BroadcastIn(BaseModel):
    drivers: list[str]
    channels: list[str] = ["email"]
    subject: str = ""
    body: str


@router.get("/notify/templates")
def notify_templates_list():
    """Plantillas de mensajes (del tenant actual)."""
    return {"templates": notice_templates.list_templates()}


@router.post("/notify/templates")
def notify_templates_save(body: TemplateIn):
    return notice_templates.upsert(body.model_dump())


@router.delete("/notify/templates/{tid}")
def notify_templates_delete(tid: str):
    return {"deleted": notice_templates.delete(tid)}


@router.get("/notify/recipients")
def notify_recipients():
    """Conductores con contacto cargado (para el broadcast)."""
    return {"recipients": notify_service.recipients()}


@router.post("/notify/broadcast")
def notify_broadcast(req: BroadcastIn):
    """Envia (o simula) un mensaje de plantilla a los conductores elegidos."""
    if not req.drivers:
        raise HTTPException(422, "No driver selected.")
    if not req.body.strip():
        raise HTTPException(422, "The message body is empty.")
    return notify_service.broadcast(
        req.drivers, req.channels, req.subject, req.body)


# ----- Evidencia fotográfica (v2.14, elemento 01) -----

async def _evidence_upload(parent: str, parent_id: int,
                           files: list[UploadFile], phase: str,
                           note: str) -> dict:
    """Guardado compartido defect/WO. El gate de existencia corre ANTES de
    tocar disco (un id inválido no debe dejar archivos huérfanos) y acepta
    VARIOS archivos por request: el flujo real es el teléfono mandando 2-3
    tomas de una vez."""
    unit = evidence.parent_unit(parent, parent_id)
    if unit is None:
        raise HTTPException(404, {
            "defect": "Defect not found",
            "wo": "Work order not found",
        }.get(parent, "Parent not found"))
    saved = []
    try:
        for f in files:
            raw = await f.read()
            saved.append(evidence.save_photo(
                parent, parent_id, f.filename or "photo.jpg", raw,
                phase=phase, note=note, unit=unit))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"photos": saved}


@router.get("/defects/{defect_id}/photos")
def defect_photos_list(defect_id: int):
    """Fotos de un defecto (tabla `defect`: los DVIR importados). Un id
    inexistente devuelve lista vacía, igual que uno sin fotos."""
    return {"photos": evidence.list_photos("defect", defect_id)}


@router.post("/defects/{defect_id}/photos")
async def defect_photos_upload(defect_id: int,
                               files: list[UploadFile] = File(...),
                               phase: str = Form("report"),
                               note: str = Form("")):
    return await _evidence_upload("defect", defect_id, files, phase, note)


@router.get("/workorders/{wo_id}/photos")
def wo_photos_list(wo_id: int):
    return {"photos": evidence.list_photos("wo", wo_id)}


@router.post("/workorders/{wo_id}/photos")
async def wo_photos_upload(wo_id: int,
                           files: list[UploadFile] = File(...),
                           phase: str = Form("report"),
                           note: str = Form("")):
    return await _evidence_upload("wo", wo_id, files, phase, note)


@router.get("/evidence/{photo_id}/file")
def evidence_file(photo_id: int):
    found = evidence.photo_path(photo_id)
    if found is None:
        raise HTTPException(status_code=404, detail="Photo not found")
    path, mime = found
    return FileResponse(path, media_type=mime)


@router.delete("/evidence/{photo_id}")
def evidence_delete(photo_id: int):
    if not evidence.delete_photo(photo_id):
        raise HTTPException(status_code=404, detail="Photo not found")
    return {"ok": True}


class EvidenceCountsIn(BaseModel):
    parent: str
    ids: list[int] = []


@router.post("/evidence/counts")
def evidence_counts(body: EvidenceCountsIn):
    """Conteo bulk id -> nº de fotos para los chips de la lista de defectos:
    UNA llamada por página en vez de un GET por fila (N+1)."""
    if body.parent not in evidence.PARENTS:
        raise HTTPException(status_code=400,
                            detail="parent must be 'defect' or 'wo'")
    # Techo de sanidad: la página real manda <=400 ids (limit de list_defects).
    return {"counts": evidence.counts(body.parent, body.ids[:500])}
