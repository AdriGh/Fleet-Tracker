# -*- coding: utf-8 -*-
"""Lectura en vivo del DVIR Report desde Google Sheets (Service Account).

Solo lectura. Requiere en `avisos.local.json`:
    {
      "spreadsheet_id": "1PEwPUie...",
      "service_account_file": "service_account.json"
    }
y que la planilla este compartida (Lector) con el email de la cuenta de
servicio. Auto-detecta las hojas de empresa del mes mas reciente
(`CHASER N`, `MCC N`) y la hoja `Driver info`; ambos se pueden fijar a mano
con `company_sheets` y `driver_info_sheet`.
"""

import re
from pathlib import Path

from .. import config

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
_COMPANY_RE = re.compile(r"^(CHASER|MCC)\s+(\d+)$", re.IGNORECASE)


def _sa_path(name: str) -> Path:
    p = Path(name)
    return p if p.is_absolute() else config.BACKEND_DIR / name


def is_configured(cfg: dict) -> bool:
    sid = cfg.get("spreadsheet_id")
    sa = cfg.get("service_account_file")
    return bool(sid and sa and _sa_path(sa).exists())


def _service(cfg: dict):
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    creds = service_account.Credentials.from_service_account_file(
        str(_sa_path(cfg["service_account_file"])), scopes=SCOPES)
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


def _pick_company_sheets(titles: list[str], cfg: dict) -> list[str]:
    explicit = cfg.get("company_sheets")
    if explicit:
        return [t for t in explicit if t in titles]
    # Auto: la hoja con el numero mas alto por empresa (mes mas reciente).
    best: dict[str, tuple[int, str]] = {}
    for t in titles:
        m = _COMPANY_RE.match(t.strip())
        if m:
            comp, num = m.group(1).upper(), int(m.group(2))
            if comp not in best or num > best[comp][0]:
                best[comp] = (num, t)
    return [best[c][1] for c in sorted(best)]


def _pick_driver_info(titles: list[str], cfg: dict) -> str | None:
    explicit = cfg.get("driver_info_sheet")
    if explicit and explicit in titles:
        return explicit
    for t in titles:
        low = t.strip().lower()
        if "driver info" in low or low == "drivers":
            return t
    return None


def _read(svc, sid: str, title: str) -> list[list]:
    resp = (svc.spreadsheets().values()
            .get(spreadsheetId=sid, range=title,
                 valueRenderOption="FORMATTED_VALUE")
            .execute())
    return resp.get("values", [])


def load_live(cfg: dict):
    """Lee la planilla en vivo. Lanza excepcion si algo falla."""
    from .datasource import ReportData

    svc = _service(cfg)
    sid = cfg["spreadsheet_id"]
    meta = (svc.spreadsheets()
            .get(spreadsheetId=sid,
                 fields="properties.title,sheets.properties.title")
            .execute())
    titles = [s["properties"]["title"] for s in meta.get("sheets", [])]

    company_sheets = _pick_company_sheets(titles, cfg)
    if not company_sheets:
        raise RuntimeError(
            "No se encontraron hojas de empresa tipo 'CHASER N' / 'MCC N' "
            f"en la planilla. Hojas disponibles: {titles}")

    di_title = _pick_driver_info(titles, cfg)
    if di_title is None:
        raise RuntimeError(
            "No se encontro la hoja 'Driver info' en la planilla. "
            f"Hojas disponibles: {titles}")

    sheets = {t: _read(svc, sid, t) for t in company_sheets}
    driver_info = _read(svc, sid, di_title)
    return ReportData(
        mode="live",
        sheets=sheets,
        driver_info=driver_info,
        spreadsheet=meta.get("properties", {}).get("title", sid),
    )
