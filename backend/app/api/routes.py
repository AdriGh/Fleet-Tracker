"""Endpoints de la API del generador de informes DVIR."""

import io
import re
import uuid

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .. import __version__, config
from ..core import engine, excel
from ..schemas import HealthResponse, ReportResponse, RosterEntry

router = APIRouter(prefix="/api")

# Almacen en memoria de informes generados: id -> {path, filename}.
_jobs: dict[str, dict] = {}


@router.get("/health", response_model=HealthResponse)
def health():
    return HealthResponse(status="ok", version=__version__)


@router.get("/roster", response_model=list[RosterEntry])
def get_roster():
    """Devuelve el roster camion->conductor por defecto."""
    roster = engine.load_roster(
        config.DEFAULT_ROSTER if config.DEFAULT_ROSTER.exists() else None)
    return [RosterEntry(truck=t, driver=d) for t, d in sorted(roster.items())]


def _safe_label(label: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "-", label.strip()) or "informe"


@router.post("/reports", response_model=ReportResponse)
async def create_report(
    dvir_file: UploadFile = File(...),
    activity_file: UploadFile = File(...),
    roster_file: UploadFile | None = File(None),
    company: str = Form("CHASER"),
    date_label: str = Form(...),
    min_miles: float = Form(25.0),
):
    """Cruza los CSV, genera el Excel y devuelve la vista previa."""
    company = company.strip() or "CHASER"
    date_label = date_label.strip()
    if not date_label:
        raise HTTPException(422, "Falta la etiqueta del dia.")

    try:
        dvir_bytes = await dvir_file.read()
        activity_bytes = await activity_file.read()
        dvir_df = engine.load_dvir(io.BytesIO(dvir_bytes))
        activity = engine.load_activity(io.BytesIO(activity_bytes))
        if roster_file is not None:
            roster = engine.load_roster(io.BytesIO(await roster_file.read()))
        else:
            roster = engine.load_roster(
                config.DEFAULT_ROSTER
                if config.DEFAULT_ROSTER.exists() else None)
        groups = engine.build_report(
            dvir_df, activity, roster, min_miles, company)
    except engine.ReportError as exc:
        raise HTTPException(422, str(exc)) from exc

    report_id = uuid.uuid4().hex
    filename = f"DVIR {company} {_safe_label(date_label)}.xlsx"
    out_path = config.JOBS_DIR / f"{report_id}.xlsx"
    excel.write_excel(groups, company, date_label, out_path)
    _jobs[report_id] = {"path": out_path, "filename": filename}

    return ReportResponse(
        id=report_id,
        company=company,
        date_label=date_label,
        columns=engine.COLUMNS,
        stats=engine.report_stats(groups),
        groups=groups,
        filename=filename,
    )


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
