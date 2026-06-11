# -*- coding: utf-8 -*-
"""Adapter de Samsara: delega en el módulo samsara.py existente.

Cero cambio de comportamiento — esta clase solo da al módulo histórico
la forma de la interfaz TelematicsProvider para que el resto de la app
pueda volverse agnóstica del proveedor en G7.
"""

from __future__ import annotations

import time

import httpx

from .. import reefer, samsara, tracking
from . import TelematicsProvider


class SamsaraProvider(TelematicsProvider):
    id = "samsara"
    name = "Samsara"

    def configured(self) -> bool:
        return bool(samsara.org_summaries())

    async def ping(self) -> dict:
        """Un GET mínimo por org; reporta latencia y empresa."""
        orgs = samsara._orgs()
        if not orgs:
            return {"ok": False, "detail": "No orgs configured", "ms": 0}
        checks = []
        async with httpx.AsyncClient(timeout=15) as client:
            for cfg in orgs:
                label = cfg.get("company") or "org"
                t0 = time.monotonic()
                try:
                    await samsara._get(client, cfg,
                                       "/fleet/vehicles?limit=1")
                    ms = int((time.monotonic() - t0) * 1000)
                    checks.append(f"{label} OK ({ms} ms)")
                except httpx.HTTPStatusError as exc:
                    checks.append(
                        f"{label} HTTP {exc.response.status_code}")
                except httpx.HTTPError as exc:
                    checks.append(f"{label} error: {type(exc).__name__}")
        ok = all("OK" in c for c in checks)
        return {"ok": ok, "detail": " · ".join(checks), "ms": 0}

    async def list_fleet(self) -> list[dict]:
        return await samsara.list_fleet()

    async def list_drivers(self) -> list[dict]:
        return await samsara.list_drivers()

    async def open_defects(self) -> list[dict]:
        return await samsara.load()

    async def track_live(self) -> dict:
        return await tracking.load_live()

    async def reefer_live(self) -> dict:
        return await reefer.load_live()
