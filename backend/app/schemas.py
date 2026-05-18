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
