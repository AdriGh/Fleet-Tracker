"""Endpoints de la API del generador de informes DVIR."""

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
    excel, integrations_admin, inventory, local_config, lynx, mailer, maint,
    manual_units, media_host, notify_service, odometer, open_defects,
    org_config,
    parts, parts_marketplace, permissions, pm, pois, pretrip, providers,
    purchasing, ratelimit, reefer,
    reports,
    samsara,
    sms_service,
    teams,
    telegram_notify, terminals, thermoking, tms, traccar, tracking,
    setup_status as setup_status_core,
    unit_photos, unit_settings, unitdocs, vin_decode, warranty, wo_invoice,
    wo_invoices, workflows, workorders,
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
    e = (e or "").strip()
    if "@" not in e:
        return "•••" if e else ""
    name, dom = e.split("@", 1)
    return (name[:1] + "•••") + "@" + dom


def _mask_phone(p: str) -> str:
    digits = re.sub(r"\D", "", p or "")
    return ("•••-" + digits[-4:]) if len(digits) >= 4 else ("•••" if p else "")


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
                "available": open_defects.is_available(),
                "source": "csv",
                "error": f"Samsara did not respond ({exc}); using local CSV.",
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


class WoLineIn(BaseModel):
    kind: str          # part | labor
    description: str
    qty: float = 1
    unit_cost: float = 0
    part_number: str = ""


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


class PurchaseOrderIn(BaseModel):
    vendor: str = ""
    notes: str = ""
    lines: list[POLineIn] = []          # QuickBuy: crea la PO con líneas


class PurchaseOrderPatch(BaseModel):
    vendor: str | None = None
    notes: str | None = None
    status: str | None = None           # draft | ordered | received


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
def wo_list(status: str = "", unit: str = ""):
    return {"workorders": workorders.list_wos(status, unit),
            "stats": workorders.stats(),
            "mechanics": workorders.mechanics()}


@router.post("/workorders")
def wo_create(body: WorkOrderIn):
    try:
        return workorders.create_wo(
            body.unit, body.title, body.complaint, body.company,
            body.mechanic, body.priority, body.is_pm, body.source,
            body.mileage, body.service_date, body.campaign,
            body.shop_invoice, body.parent_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/workorders/scan")
async def wo_scan(request: Request, file: UploadFile = File(...)):
    """Escanea un invoice/estimate (PDF o foto) y devuelve los campos
    extraídos para autollenar la work order (fase H2.5)."""
    # SEC-3 (extensión): el escaneo consume la API de Groq con un key COMPARTIDO
    # (free tier ~125/día). Sin límite, un usuario podría agotar la cuota → 429
    # para TODOS los clientes (o inflar el costo). Se limita POR USUARIO: 15/min
    # y 150/día (config por env SEC3_SCAN_*). El middleware ya dejó el usuario
    # autenticado en request.state.user; si faltara, cae a la IP.
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
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(raw) > docscan.MAX_BYTES:
        raise HTTPException(status_code=400,
                            detail="File too large (max 20 MB)")
    try:
        return await docscan.scan(raw, file.content_type or "")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


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
    if body.status == "invoiced":
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


# ----- Factura original adjunta por WO (review v1.17, estilo SquareRigger) ---
# Almacenamiento por archivo (core/wo_invoices), SIN columna en la DB. El
# middleware ya exige maint.edit para POST/DELETE bajo /api/workorders; el GET
# es lectura (auth basta). Espeja las rutas de unitdocs (FileResponse, scope).

@router.post("/workorders/{wo_id}/invoice-file")
async def wo_invoice_file_upload(wo_id: int,
                                 file: UploadFile = File(...)):
    """Sube (o reemplaza) la factura original del taller de la WO."""
    if workorders.get_wo(wo_id) is None:
        raise HTTPException(status_code=404, detail="WO not found")
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
    if not parts.delete_vendor(vendor_id):
        raise HTTPException(status_code=404, detail="Vendor not found")
    return {"ok": True}


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
def parts_adjust(body: StockAdjustIn):
    """Ajuste manual de existencia (reason='manual'). `delta` puede ser
    negativo (merma/corrección) o positivo (conteo físico, hallazgo)."""
    try:
        return inventory.manual_adjust(body.part_number, body.delta, body.note)
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

@router.get("/purchase-orders")
def po_list(status: str = ""):
    return {"purchase_orders": purchasing.list_pos(status),
            "stats": purchasing.stats()}


@router.post("/purchase-orders")
def po_create(body: PurchaseOrderIn):
    try:
        return purchasing.create_po(
            body.vendor, body.notes,
            [ln.model_dump() for ln in body.lines])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/purchase-orders/{po_id}")
def po_get(po_id: int):
    po = purchasing.get_po(po_id)
    if po is None:
        raise HTTPException(status_code=404, detail="PO not found")
    return po


@router.patch("/purchase-orders/{po_id}")
def po_patch(po_id: int, body: PurchaseOrderPatch):
    try:
        po = purchasing.update_po(
            po_id, {k: v for k, v in body.model_dump().items()
                    if v is not None})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if po is None:
        raise HTTPException(status_code=404, detail="PO not found")
    return po


@router.delete("/purchase-orders/{po_id}")
def po_delete(po_id: int):
    if not purchasing.delete_po(po_id):
        raise HTTPException(status_code=404, detail="PO not found")
    return {"ok": True}


@router.post("/purchase-orders/{po_id}/receive")
def po_receive(po_id: int, body: ReceivePoIn):
    """Recepción por línea (parcial o total). Repone stock idempotentemente y,
    si se pide y quedan faltantes, auto-genera una PO de backorder. Bajo el
    prefijo /api/purchase-orders => scope maint.edit (igual que el resto)."""
    try:
        res = purchasing.receive_po(
            po_id, [r.model_dump() for r in body.receipts],
            token=body.token, create_backorder=body.create_backorder)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if res is None:
        raise HTTPException(status_code=404, detail="PO not found")
    return res


@router.post("/purchase-orders/{po_id}/lines")
def po_add_line(po_id: int, body: POLineIn):
    try:
        po = purchasing.add_line(po_id, body.part_number, body.description,
                                 body.qty, body.unit_cost)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if po is None:
        raise HTTPException(status_code=404, detail="PO not found")
    return po


@router.delete("/purchase-orders/{po_id}/lines/{line_id}")
def po_del_line(po_id: int, line_id: int):
    po = purchasing.delete_line(po_id, line_id)
    if po is None:
        raise HTTPException(status_code=404, detail="PO not found")
    return po


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
def parts_requests_bundle(body: BundleRequestsIn):
    try:
        return purchasing.bundle_requests(body.request_ids)
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
    wo = workorders.delete_line(wo_id, line_id)
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
    return org_config.save(body)


# ----- Terminales dinámicas (Settings → Terminals) -------------------------

class TerminalIn(BaseModel):
    key: str = ""            # vacío = crear; existente = editar
    label: str
    prefixes: list[str] = []


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
    try:
        return terminals.save_terminal(body.key, body.label, body.prefixes)
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
    de DVIR). Solo Samsara (sin fallback CSV).
    """
    if refresh:
        samsara.clear_cache()
    st = app_config.get_settings()
    # Unidades agregadas a mano (Fleet -> Add New Unit): se muestran SIEMPRE,
    # esten o no disponibles los datos de Samsara.
    if not samsara.is_available():
        units = manual_units.merge_into_fleet([])
        for u in units:
            u["archived"], u["archive_reason"] = False, None
        return {"available": bool(units),
                "source": "manual" if units else "none",
                "units": units, "settings": st, "archived_count": 0}
    arch = app_config.archived_ids()
    keep = app_config.kept_active_ids()
    auto_days = st["auto_archive_days"] if st["auto_archive_enabled"] else None
    try:
        units = await samsara.list_fleet(auto_days)
    except Exception as exc:  # noqa: BLE001
        units = manual_units.merge_into_fleet([])
        for u in units:
            u["archived"], u["archive_reason"] = False, None
        return {"available": bool(units),
                "source": "error" if not units else "manual",
                "error": str(exc), "units": units, "settings": st}

    for u in units:
        uid = str(u.get("id"))
        if uid in arch:
            u["archived"], u["archive_reason"] = True, "manual"
        elif (auto_days and u.get("dvir_known") and u.get("auto_eligible")
              and not u.get("last_dvir") and uid not in keep):
            u["archived"], u["archive_reason"] = True, "auto"
        else:
            u["archived"], u["archive_reason"] = False, None

    # Mergear las unidades manuales (Samsara gana por numero de unidad).
    units = manual_units.merge_into_fleet(units)
    for u in units:
        u.setdefault("archived", False)
        u.setdefault("archive_reason", None)

    return {
        "available": True,
        "source": "samsara",
        "settings": st,
        "archived_count": sum(1 for u in units if u["archived"]),
        "units": units,
    }


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

@router.get("/maint/{kind}")
async def maint_board(kind: str, refresh: bool = False):
    """Tablero editable de PM o DOT Inspections (misma forma para ambos)."""
    try:
        return await maint.board(kind, refresh=refresh)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


class MaintRecordIn(BaseModel):
    kind: str            # pm | dot
    unit: str
    date: str            # YYYY-MM-DD
    mileage: int | None = None
    notes: str = ""


@router.post("/maint/record")
def maint_add_record(body: MaintRecordIn):
    try:
        rec = maint.add_record(body.unit, body.kind, body.date,
                               body.mileage, body.notes)
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
        unit_settings.set_campaign(unit, body.key, body.enabled)
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
        raise HTTPException(404, "Defect not found" if parent == "defect"
                            else "Work order not found")
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

# ----- Workflows del driver (v2.15, elemento 03) -----

class WorkflowStepIn(BaseModel):
    type: str            # check | photo | read | sign (valida core/workflows)
    label: str
    required: bool = False


class WorkflowIn(BaseModel):
    name: str
    steps: list[WorkflowStepIn] = []


# ⚠ Orden de registro: /workflows/active va ANTES de /workflows/{wid}.
# FastAPI matchea en orden; si no, "active" caería como wid y daría 422.
@router.get("/workflows/active")
def workflows_active():
    """El workflow ACTIVO con sus pasos ordenados (consumidor: el walkaround
    PWA del driver, v2.16)."""
    wf = workflows.active_workflow()
    if wf is None:
        raise HTTPException(404, "No active workflow yet.")
    return wf


@router.get("/workflows")
def workflows_list():
    """Resúmenes de los workflows del tenant. Siembra el "Pre-trip" genérico
    la primera vez (el editor nunca abre vacío)."""
    workflows.ensure_default()
    return {"workflows": workflows.list_workflows()}


@router.get("/workflows/{wid}")
def workflows_get(wid: int):
    """Un workflow con sus pasos ordenados por pos."""
    wf = workflows.get_workflow(wid)
    if wf is None:
        raise HTTPException(404, "Workflow not found.")
    return wf


@router.post("/workflows")
def workflows_create(body: WorkflowIn):
    """Crea un workflow nuevo (inactivo hasta que el manager lo active)."""
    try:
        return workflows.save_workflow(None, body.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put("/workflows/{wid}")
def workflows_update(wid: int, body: WorkflowIn):
    """Reemplaza nombre+pasos (replace-all transaccional)."""
    try:
        return workflows.save_workflow(wid, body.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/workflows/{wid}")
def workflows_delete(wid: int):
    """Borra un workflow (prohibido borrar el único)."""
    try:
        workflows.delete_workflow(wid)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True}


@router.post("/workflows/{wid}/activate")
def workflows_activate(wid: int):
    """Activa `wid` y desactiva el resto (UN activo por org)."""
    try:
        workflows.set_active(wid)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True}
