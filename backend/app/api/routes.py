"""Endpoints de la API del generador de informes DVIR."""

import io
import re
import uuid
from datetime import date, datetime, timedelta

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .. import __version__, config, db
from pydantic import BaseModel

from fastapi import Header

from ..core import (
    alerts, app_config, auth, batch, driver_contacts, engine, excel,
    integrations_admin, local_config, mailer, media_host, notify_service,
    open_defects, org_config, pm, pois, pretrip, reefer, samsara,
    sms_service, tms, tracking, unit_settings, workorders,
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


class LoadStopIn(BaseModel):
    kind: str = "pickup"
    name: str = ""
    city: str = ""
    state: str = ""
    appt: str = ""


class LoadIn(BaseModel):
    broker: str
    ref: str = ""
    driver: str = ""
    unit: str = ""
    hauling_rate: float = 0
    accessorials: float = 0
    pay_pct: float = 0
    miles: float | None = None
    stops: list[LoadStopIn] = []


class LoadPatch(BaseModel):
    status: str | None = None
    broker: str | None = None
    ref: str | None = None
    driver: str | None = None
    unit: str | None = None
    hauling_rate: float | None = None
    accessorials: float | None = None
    pay_pct: float | None = None
    miles: float | None = None
    tags: list[str] | None = None
    docs: dict | None = None
    notes: str | None = None


@router.get("/tms/drivers")
async def tms_drivers():
    """Roster vivo + perfil TMS por conductor."""
    return {"drivers": await tms.list_drivers()}


@router.post("/tms/drivers")
def tms_driver_save(body: TmsDriverIn):
    fields = {k: v for k, v in body.model_dump().items()
              if k != "name" and v is not None}
    try:
        return tms.save_driver(body.name, fields)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/tms/loads")
def tms_loads(status: str = "", driver: str = ""):
    return {"loads": tms.list_loads(status, driver),
            "stats": tms.load_stats()}


@router.post("/tms/loads")
def tms_load_create(body: LoadIn):
    try:
        return tms.create_load(
            body.broker, body.ref, body.driver, body.unit,
            body.hauling_rate, body.accessorials, body.pay_pct,
            body.miles, [s.model_dump() for s in body.stops])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/tms/loads/{load_id}")
def tms_load_get(load_id: int):
    ld = tms.get_load(load_id)
    if ld is None:
        raise HTTPException(status_code=404, detail="Load no encontrada")
    return ld


@router.patch("/tms/loads/{load_id}")
def tms_load_patch(load_id: int, body: LoadPatch):
    ld = tms.update_load(
        load_id, {k: v for k, v in body.model_dump().items()
                  if v is not None})
    if ld is None:
        raise HTTPException(status_code=404, detail="Load no encontrada")
    return ld


@router.post("/tms/loads/{load_id}/stops")
def tms_load_add_stop(load_id: int, body: LoadStopIn):
    ld = tms.add_stop(load_id, body.kind, body.name, body.city,
                      body.state, body.appt)
    if ld is None:
        raise HTTPException(status_code=404, detail="Load no encontrada")
    return ld


@router.delete("/tms/loads/{load_id}/stops/{stop_id}")
def tms_load_del_stop(load_id: int, stop_id: int):
    ld = tms.delete_stop(load_id, stop_id)
    if ld is None:
        raise HTTPException(status_code=404, detail="Load no encontrada")
    return ld


class WorkOrderIn(BaseModel):
    unit: str
    title: str
    complaint: str = ""
    company: str = ""
    mechanic: str = ""
    priority: str = "normal"
    is_pm: bool = False
    source: str = "manual"


class WorkOrderPatch(BaseModel):
    status: str | None = None
    priority: str | None = None
    title: str | None = None
    complaint: str | None = None
    mechanic: str | None = None
    notes: str | None = None
    is_pm: bool | None = None
    pm_miles: int | None = None


class WoLineIn(BaseModel):
    kind: str          # part | labor
    description: str
    qty: float = 1
    unit_cost: float = 0


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
            body.mechanic, body.priority, body.is_pm, body.source)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/workorders/{wo_id}")
def wo_get(wo_id: int):
    wo = workorders.get_wo(wo_id)
    if wo is None:
        raise HTTPException(status_code=404, detail="WO no encontrado")
    return wo


@router.patch("/workorders/{wo_id}")
def wo_patch(wo_id: int, body: WorkOrderPatch):
    wo = workorders.update_wo(
        wo_id, {k: v for k, v in body.model_dump().items()
                if v is not None})
    if wo is None:
        raise HTTPException(status_code=404, detail="WO no encontrado")
    return wo


@router.post("/workorders/{wo_id}/lines")
def wo_add_line(wo_id: int, body: WoLineIn):
    try:
        wo = workorders.add_line(wo_id, body.kind, body.description,
                                 body.qty, body.unit_cost)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if wo is None:
        raise HTTPException(status_code=404, detail="WO no encontrado")
    return wo


@router.delete("/workorders/{wo_id}/lines/{line_id}")
def wo_del_line(wo_id: int, line_id: int):
    wo = workorders.delete_line(wo_id, line_id)
    if wo is None:
        raise HTTPException(status_code=404, detail="WO no encontrado")
    return wo


@router.get("/reefer")
async def reefer_live():
    """Snapshot del cold chain (fase G4). Si Samsara no tiene trailers
    con reefer todavía, sirve el set DEMO etiquetado (demo: true)."""
    return await reefer.load_live()


@router.get("/reefer/history")
async def reefer_history(id: str, hours: int = 24):
    """Serie de temperaturas de un reefer para el chart (24 h default)."""
    return await reefer.history(id, max(1, min(hours, 72)))


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
        raise HTTPException(status_code=404, detail="POI no encontrado")
    return {"ok": True}


@router.post("/pois/google-search")
async def poi_google_search(body: PoiSearchIn):
    """Búsqueda Google Places para mostrar EN LISTA (nunca en el mapa —
    los ToS de Google prohíben pintar Places sobre mapas no-Google)."""
    q = body.query.strip()
    if not q:
        raise HTTPException(status_code=400, detail="query vacío")
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


def _require_admin(authorization: str | None) -> dict:
    user = auth.user_from_header(authorization)
    if user is None:
        raise HTTPException(status_code=401, detail="No autenticado")
    if user["role"] != "admin":
        raise HTTPException(status_code=403,
                            detail="Requiere rol de administrador")
    return user


@router.get("/auth/status")
def auth_status(authorization: str | None = Header(default=None)):
    """Estado de autenticación. Allowlisted: nunca devuelve 401."""
    user = auth.user_from_header(authorization)
    return {
        "setup_needed": not auth.users_exist(),
        "authenticated": user is not None,
        "user": user,
        "branding": org_config.branding(),
    }


@router.post("/auth/setup")
def auth_setup(body: AuthSetupIn):
    """Crea el PRIMER usuario (admin). Solo con la tabla vacía."""
    try:
        user = auth.setup_admin(body.name, body.username, body.password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    result = auth.login(body.username, body.password)
    return {"user": user, "token": result["token"] if result else ""}


@router.post("/auth/login")
def auth_login(body: AuthLoginIn):
    result = auth.login(body.username, body.password)
    if result is None:
        raise HTTPException(status_code=401,
                            detail="Usuario o contraseña incorrectos")
    return result


@router.get("/auth/users")
def auth_users(authorization: str | None = Header(default=None)):
    _require_admin(authorization)
    return {"users": auth.list_users()}


@router.post("/auth/users")
def auth_users_create(body: UserIn,
                      authorization: str | None = Header(default=None)):
    _require_admin(authorization)
    try:
        return auth.create_user(body.name, body.username, body.password,
                                body.role)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.patch("/auth/users/{user_id}")
def auth_users_patch(user_id: int, body: UserPatch,
                     authorization: str | None = Header(default=None)):
    admin = _require_admin(authorization)
    try:
        user = auth.update_user(
            user_id,
            {k: v for k, v in body.model_dump().items() if v is not None},
            acting_admin_id=admin["id"])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if user is None:
        raise HTTPException(status_code=404, detail="Usuario no existe")
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
             authorization: str | None = Header(default=None)):
    _require_admin(authorization)
    return org_config.save(body)


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


# Qué proveedores soportan test/configure desde la UI.
_TESTABLE = {"samsara", "motive", "twilio", "cloudinary", "gmail",
             "gplaces", "gsheets", "fullbay"}
_CONFIGURABLE = {"samsara", "motive", "twilio", "cloudinary",
                 "gplaces", "gmail"}


@router.get("/integrations")
def integrations_status():
    """Hub de Conectividad (Settings): estado de cada integración externa.

    Solo estado y metadatos — NUNCA credenciales (los tokens viven en
    backend/*.local.json hasta que llegue la edición en-app, fase G6/G7).
    Estados: connected | live | dry_run | not_configured | available | planned.
    """
    orgs = samsara.org_summaries()
    email = mailer.load_settings()
    sms = sms_service.load_settings()
    media = media_host.load_settings()
    avisos = local_config.load()
    sheets_ok = bool(avisos.get("spreadsheet_id")
                     and avisos.get("service_account_file"))

    def chan(settings) -> str:
        if not settings.configured:
            return "not_configured"
        return "dry_run" if settings.dry_run else "live"

    pm_detail = "Waiting for pm.local.csv (Fullbay fleet export)"
    if pm.is_available():
        mtime = datetime.fromtimestamp(pm.CSV_PATH.stat().st_mtime)
        pm_detail = f"pm.local.csv · updated {mtime:%m/%d/%Y}"

    out = {
        "groups": [
            {
                "id": "eld",
                "label": "ELD / Telematics",
                "note": ("Read-only API tokens. Token editing moves in-app "
                         "with the multi-ELD adapter."),
                "providers": [
                    {
                        "id": "samsara", "name": "Samsara",
                        "kind": "Telematics + ELD",
                        "status": "connected" if orgs else "not_configured",
                        "detail": (f"{len(orgs)} org{'s' if len(orgs) != 1 else ''} · "
                                   + ", ".join(o["company"] for o in orgs)
                                   if orgs else "No API tokens configured"),
                        "items": [
                            {"label": o["company"],
                             "value": f"token …{o['token_tail']}"}
                            for o in orgs
                        ],
                    },
                    {
                        "id": "motive", "name": "Motive",
                        "kind": "Telematics + ELD",
                        "status": "available",
                        "detail": "Public self-serve REST API + OAuth. "
                                  "Adapter planned.",
                        "items": [],
                    },
                    {
                        "id": "geotab", "name": "Geotab",
                        "kind": "Telematics + ELD",
                        "status": "planned",
                        "detail": "JSON-RPC API with customer database "
                                  "credentials.",
                        "items": [],
                    },
                    {
                        "id": "panda", "name": "Panda ELD",
                        "kind": "ELD",
                        "status": "planned",
                        "detail": "No public API yet — partnership required.",
                        "items": [],
                    },
                ],
            },
            {
                "id": "messaging",
                "label": "Messaging",
                "note": "",
                "providers": [
                    {
                        "id": "gmail", "name": "Email · Gmail SMTP",
                        "kind": "Notices channel",
                        "status": chan(email),
                        "detail": email.sender or "No sender configured",
                        "items": [],
                    },
                    {
                        "id": "twilio", "name": "SMS · Twilio",
                        "kind": "Notices channel",
                        "status": chan(sms),
                        "detail": (sms.from_number
                                   or sms.messaging_service_sid
                                   or "No credentials configured"),
                        "items": [],
                    },
                    {
                        "id": "cloudinary", "name": "Media · Cloudinary",
                        "kind": "MMS attachments hosting",
                        "status": chan(media),
                        "detail": (media.cloud_name
                                   or "No credentials configured"),
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
                        "id": "gsheets", "name": "Google Sheets",
                        "kind": "DVIR Report workbook (live)",
                        "status": "connected" if sheets_ok
                                  else "not_configured",
                        "detail": ("Service account · read-only"
                                   if sheets_ok
                                   else "avisos.local.json incomplete"),
                        "items": [],
                    },
                    {
                        "id": "fullbay", "name": "Fullbay",
                        "kind": "PM history (CSV export)",
                        "status": "connected" if pm.is_available()
                                  else "not_configured",
                        "detail": pm_detail,
                        "items": [],
                    },
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
                ],
            },
        ],
    }
    for g in out["groups"]:
        for p in g["providers"]:
            p["testable"] = p["id"] in _TESTABLE
            p["configurable"] = p["id"] in _CONFIGURABLE
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
    → millas hasta el próximo PM. El intervalo y el umbral "Upcoming" son
    configurables por empresa (org.local.json, fase G7)."""
    interval = org_config.threshold("pm_interval_miles")
    upcoming = org_config.threshold("pm_upcoming_miles")
    if refresh:
        samsara.clear_cache()
    records = pm.load()
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
