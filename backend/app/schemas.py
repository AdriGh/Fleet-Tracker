"""Modelos de respuesta de la API."""

from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    version: str


class RosterEntry(BaseModel):
    truck: str
    driver: str


# --- Lote --------------------------------------------------------------
class BatchFile(BaseModel):
    file_id: str
    name: str
    kind: str
    company: str
    error: str | None = None


class BatchBlock(BaseModel):
    company: str
    date_label: str
    month: int | None = None
    dvir_file_id: str
    dvir_name: str
    activity_file_id: str
    activity_name: str
    status: str


class BatchAnalyzeResponse(BaseModel):
    batch_id: str
    blocks: list[BatchBlock]
    files: list[BatchFile]
    warnings: list[str]


class BatchBlockInput(BaseModel):
    company: str
    date_label: str
    dvir_file_id: str
    activity_file_id: str


class BatchGenerateRequest(BaseModel):
    batch_id: str
    blocks: list[BatchBlockInput]


class BatchSheetStat(BaseModel):
    company: str
    sheet_name: str
    blocks: int
    drivers: int
    no_dvir: int


class BatchGenerateResponse(BaseModel):
    id: str
    filename: str
    sheets: list[BatchSheetStat]
    warnings: list[str] = []
