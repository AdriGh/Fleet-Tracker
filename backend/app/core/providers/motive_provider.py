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

import time

import httpx

from ... import config
from . import FileCredsMixin, TelematicsProvider

SETTINGS_PATH = config.BACKEND_DIR / "motive.local.json"
BASE_URL = "https://api.gomotive.com"


def _vehicle_to_fleet_row(v: dict) -> dict:
    """Un /v1/vehicles de Motive con la forma canónica de fila de flota."""
    vid = v.get("id")
    unit = str(v.get("number") or v.get("name") or vid or "").strip()
    return {
        "id": f"motive-{vid}",
        "unit": unit,
        "kind": "truck",
        "unit_type": "truck",
        "asset_type": "vehicle",
        "company": "",
        "make": str(v.get("make") or ""),
        "model": str(v.get("model") or ""),
        "year": str(v.get("year") or ""),
        "vin": str(v.get("vin") or "").upper(),
        "plate": str(v.get("license_plate_number") or "").upper(),
        "open_defects": 0,
        "last_dvir": None,
        "dvir_known": False,
        "auto_eligible": False,
        "source": "motive",
        "terminal": "",
    }


class MotiveProvider(FileCredsMixin, TelematicsProvider):
    id = "motive"
    name = "Motive"
    docs = "Public self-serve REST API + OAuth (developer.gomotive.com)."

    SETTINGS_PATH = SETTINGS_PATH
    CRED_FIELDS = ("api_key",)
    SECRET_FIELDS = ("api_key",)

    def _api_key(self) -> str:
        return str(self.creds().get("api_key") or "").strip()

    def configured(self) -> bool:
        return bool(self._api_key())

    def config_fields(self) -> list[dict]:
        return [{"key": "api_key", "label": "API key", "kind": "password"}]

    def status_detail(self) -> tuple[str, str]:
        if self.configured():
            return "connected", "API key configured"
        return "available", self.docs

    async def list_fleet(self) -> list[dict]:
        """Vehículos de Motive (GET /v1/vehicles) como filas de flota.

        Solo vehículos (trucks); los trailers viven en otro endpoint
        (assets) y quedan fuera de este adapter por ahora."""
        key = self._api_key()
        if not key:
            return []
        headers = {"X-Api-Key": key, "Accept": "application/json"}
        out: list[dict] = []
        async with httpx.AsyncClient(timeout=30) as client:
            page = 1
            while page <= 20:          # tope de seguridad (~2000 unidades)
                r = await client.get(
                    f"{BASE_URL}/v1/vehicles",
                    params={"per_page": 100, "page_no": page},
                    headers=headers)
                r.raise_for_status()
                body = r.json()
                rows = body.get("vehicles") or []
                for w in rows:
                    out.append(_vehicle_to_fleet_row(w.get("vehicle") or w))
                total = int((body.get("pagination") or {}).get("total") or 0)
                if len(rows) < 100 or len(out) >= total:
                    break
                page += 1
        return out

    async def ping(self) -> dict:
        key = self._api_key()
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
