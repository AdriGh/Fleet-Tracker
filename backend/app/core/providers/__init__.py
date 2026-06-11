# -*- coding: utf-8 -*-
"""Capa de proveedores de telemática/ELD (fase G6).

`TelematicsProvider` define las operaciones que Fleet Tracker consume de
una plataforma ELD. Hoy Samsara es el proveedor canónico (delegando al
módulo existente, cero cambio de comportamiento); Motive queda cableado
para enchufarse cuando haya credenciales. La migración completa de las
rutas a esta capa llega con la multi-empresa (G7) — por ahora el
registry alimenta el hub de Conectividad y el test de conexión.

Dificultad de adapters (investigación verificada jun-2026):
- Motive: REST público self-serve + OAuth -> BAJA.
- Geotab:  JSON-RPC con credenciales de la base del cliente -> MEDIA.
- Panda ELD: sin API pública -> partnership.
"""

from __future__ import annotations

from abc import ABC, abstractmethod


class TelematicsProvider(ABC):
    """Operaciones que la app consume de una plataforma ELD."""

    id: str = ""
    name: str = ""

    @abstractmethod
    def configured(self) -> bool:
        """¿Hay credenciales presentes?"""

    @abstractmethod
    async def ping(self) -> dict:
        """Chequeo barato de conectividad: {ok, detail, ms}."""

    # Operaciones de datos (las firmas canónicas del dominio).
    # SamsaraProvider las implementa delegando; MotiveProvider las irá
    # cubriendo cuando existan credenciales para probar contra su API.
    async def list_fleet(self) -> list[dict]:
        raise NotImplementedError

    async def list_drivers(self) -> list[dict]:
        raise NotImplementedError

    async def open_defects(self) -> list[dict]:
        raise NotImplementedError

    async def track_live(self) -> dict:
        raise NotImplementedError

    async def reefer_live(self) -> dict:
        raise NotImplementedError


def registry() -> dict[str, TelematicsProvider]:
    """Proveedores conocidos, configurados o no (para el hub)."""
    from .motive_provider import MotiveProvider
    from .samsara_provider import SamsaraProvider
    out: dict[str, TelematicsProvider] = {}
    for cls in (SamsaraProvider, MotiveProvider):
        p = cls()
        out[p.id] = p
    return out
