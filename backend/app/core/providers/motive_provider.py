# -*- coding: utf-8 -*-
"""Adapter de Motive (ex KeepTruckin) — fase G6.

API REST pública self-serve (developer.gomotive.com). Auth por API key
(header `X-Api-Key`) u OAuth 2.0; para una app local single-tenant la
API key es suficiente. Config en `backend/motive.local.json`:
    { "api_key": "..." }

Mapa de endpoints para el adapter completo (referencia para cuando
haya credenciales de un cliente Motive — esfuerzo estimado: BAJO):
- Vehículos:        GET /v1/vehicles
- Conductores:      GET /v1/users?role=driver
- Ubicaciones:      GET /v1/vehicle_locations  (lat/lng/speed por unidad)
- HoS / duty:       GET /v1/hours_of_service  + /v1/available_time
- Inspecciones/DVIR:GET /v1/inspection_reports (defectos por reporte)
- Fault codes:      GET /v1/fault_codes
- IFTA:             GET /v1/ifta/summaries

Hasta tener una cuenta real contra la cual probar, solo `ping()` está
implementado; el resto lanza NotImplementedError con mensaje claro.
"""

from __future__ import annotations

import json
import time

import httpx

from ... import config
from . import TelematicsProvider

SETTINGS_PATH = config.BACKEND_DIR / "motive.local.json"
BASE_URL = "https://api.gomotive.com"


def _api_key() -> str:
    if not SETTINGS_PATH.exists():
        return ""
    try:
        data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        return str(data.get("api_key") or "").strip()
    except (OSError, ValueError):
        return ""


class MotiveProvider(TelematicsProvider):
    id = "motive"
    name = "Motive"

    def configured(self) -> bool:
        return bool(_api_key())

    async def ping(self) -> dict:
        key = _api_key()
        if not key:
            return {"ok": False,
                    "detail": "No API key (motive.local.json)", "ms": 0}
        t0 = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                r = await client.get(
                    f"{BASE_URL}/v1/users",
                    params={"per_page": 1},
                    headers={"X-Api-Key": key,
                             "Accept": "application/json"})
            ms = int((time.monotonic() - t0) * 1000)
            if r.status_code == 200:
                return {"ok": True, "detail": f"API OK ({ms} ms)",
                        "ms": ms}
            return {"ok": False,
                    "detail": f"HTTP {r.status_code}: "
                              f"{r.text[:80]}", "ms": ms}
        except httpx.HTTPError as exc:
            return {"ok": False,
                    "detail": f"error: {type(exc).__name__}", "ms": 0}
