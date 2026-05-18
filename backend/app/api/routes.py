"""Endpoints de la API del generador de informes DVIR."""

import io
import re
import uuid
from datetime import date

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .. import __version__, config, db
from ..core import batch, engine, excel
from ..schemas import (
    BatchAnalyzeResponse,
    BatchGenerateRequest,
    BatchGenerateResponse,
    BatchSheetStat,
    HealthResponse,
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
        try:
            dvir_df = engine.load_dvir(io.BytesIO(dvir[1]))
            activity_data = engine.load_activity(io.BytesIO(activity[1]))
            groups = engine.build_report(
                dvir_df, activity_data, roster, engine.MIN_MILES,
                block.company)
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
        db.save_block(block.company, block.date_label, block_date,
                      groups, metrics)

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


@router.get("/dvir/blocks/{block_id}")
def dvir_block(block_id: int):
    """Datos de un bloque guardado, para la vista previa."""
    block = db.get_block(block_id)
    if block is None:
        raise HTTPException(404, "Bloque no encontrado.")
    block["columns"] = engine.COLUMNS
    return block
