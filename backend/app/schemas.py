"""Modelos de respuesta de la API."""

from typing import Any

from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    version: str


class RosterEntry(BaseModel):
    truck: str
    driver: str


class ReportStats(BaseModel):
    drivers: int
    rows: int
    no_dvir: int


class ReportGroup(BaseModel):
    truck_merge: bool
    rows: list[dict[str, Any]]


class ReportResponse(BaseModel):
    id: str
    company: str
    date_label: str
    columns: list[str]
    stats: ReportStats
    groups: list[ReportGroup]
    filename: str
    warnings: list[str] = []


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
