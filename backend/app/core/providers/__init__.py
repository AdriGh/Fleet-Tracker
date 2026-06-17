# -*- coding: utf-8 -*-
"""Capa de proveedores de telemática/ELD — el *framework* de adapters.

`TelematicsProvider` define todo lo que Fleet Tracker necesita de una
plataforma ELD y, además, se autodescribe: declara sus campos de
configuración, qué credenciales guarda y qué capacidades implementa. Con
eso, el hub de Conectividad, el editor de credenciales y el test de
conexión se generan SOLOS desde el `registry()` — agregar un ELD nuevo es
escribir una sola clase y registrarla.

Capacidades = qué operaciones de datos implementa el adapter. Se detectan
por introspección (si el método está overrideado respecto del base).

Dificultad de adapters (investigación verificada jun-2026):
- Motive: REST público self-serve + OAuth -> BAJA (ping + fleet ya hechos).
- Geotab:  JSON-RPC con credenciales de la base del cliente -> MEDIA.
- Panda ELD: sin API pública -> partnership.
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from pathlib import Path

# capacidad -> método de datos que la implementa.
_CAP_METHODS = {
    "fleet": "list_fleet",
    "drivers": "list_drivers",
    "defects": "open_defects",
    "track": "track_live",
    "reefer": "reefer_live",
}


def _read_json(path: Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
    return {}


def _write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1),
                    encoding="utf-8")


class TelematicsProvider(ABC):
    """Operaciones que la app consume de una plataforma ELD + autodescripción."""

    id: str = ""
    name: str = ""
    kind: str = "Telematics + ELD"
    planned: bool = False          # en el roadmap, todavía sin adapter
    docs: str = ""                 # nota corta para el hub

    @abstractmethod
    def configured(self) -> bool:
        """¿Hay credenciales presentes?"""

    @abstractmethod
    async def ping(self) -> dict:
        """Chequeo barato de conectividad: {ok, detail, ms}."""

    # ----- Operaciones de datos (override = capability disponible) ----------
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

    # ----- Autodescripción (alimenta hub/UI; rara vez hay que override) -----
    def capabilities(self) -> dict:
        """Qué operaciones de datos implementa este adapter (por override)."""
        cls = type(self)
        return {cap: getattr(cls, m) is not getattr(TelematicsProvider, m)
                for cap, m in _CAP_METHODS.items()}

    def config_fields(self) -> list[dict]:
        """Campos editables en Settings → Configure. [] = no editable así."""
        return []

    def configurable(self) -> bool:
        return bool(self.config_fields())

    def creds(self) -> dict:
        """Credenciales actuales (para enmascarar colas en la UI)."""
        return {}

    def save_creds(self, values: dict) -> None:
        raise NotImplementedError(f"{self.id} is not configurable in-app")

    def status_detail(self) -> tuple[str, str]:
        """(status, detail) para la tarjeta del hub."""
        if self.planned:
            return "planned", self.docs or "Planned"
        if self.configured():
            return "connected", self.docs or "Configured"
        return "not_configured", self.docs or "Not configured"

    def hub_items(self) -> list[dict]:
        """Chips extra (p.ej. una línea por org)."""
        return []

    def hub_card(self) -> dict:
        status, detail = self.status_detail()
        caps = self.capabilities()
        return {
            "id": self.id, "name": self.name, "kind": self.kind,
            "status": status, "detail": detail,
            "items": self.hub_items(),
            "capabilities": caps,
            "configurable": self.configurable(),
            "testable": not self.planned,
            "previewable": caps["fleet"] and not self.planned
            and self.configured(),
        }


class FileCredsMixin:
    """Credenciales en un único *.local.json. El provider declara
    `SETTINGS_PATH`, `CRED_FIELDS` (todos) y `SECRET_FIELDS` (no se pisan
    con un valor vacío: vacío = conservar el existente)."""

    SETTINGS_PATH: Path
    CRED_FIELDS: tuple[str, ...] = ()
    SECRET_FIELDS: tuple[str, ...] = ()

    def creds(self) -> dict:
        return _read_json(self.SETTINGS_PATH)

    def save_creds(self, values: dict) -> None:
        data = self.creds()
        for k in self.CRED_FIELDS:
            if k not in values:
                continue
            v = values[k]
            if isinstance(v, str):
                v = v.strip()
                if v == "" and k in self.SECRET_FIELDS:
                    continue            # secreto vacío -> conservar
            data[k] = v
        _write_json(self.SETTINGS_PATH, data)


class PlannedProvider(TelematicsProvider):
    """Entrada de roadmap: conocida pero sin adapter aún. Una clase mínima
    por proveedor planificado mantiene TODO el hub guiado por el registry."""

    planned = True

    def configured(self) -> bool:
        return False

    async def ping(self) -> dict:
        return {"ok": False,
                "detail": self.docs or "Planned — no adapter yet", "ms": 0}


def registry() -> dict[str, TelematicsProvider]:
    """Proveedores conocidos (implementados o planificados), para el hub."""
    from .motive_provider import MotiveProvider
    from .samsara_provider import SamsaraProvider

    class GeotabProvider(PlannedProvider):
        id = "geotab"
        name = "Geotab"
        docs = "JSON-RPC API with customer database credentials."

    class PandaProvider(PlannedProvider):
        id = "panda"
        name = "Panda ELD"
        kind = "ELD"
        docs = "No public API yet — partnership required."

    out: dict[str, TelematicsProvider] = {}
    for cls in (SamsaraProvider, MotiveProvider, GeotabProvider,
                PandaProvider):
        p = cls()
        out[p.id] = p
    return out


# ----- Proveedor ELD activo (selección persistida por tenant) --------------

ACTIVE_KEY = "eld_active"
DEFAULT_ACTIVE = "samsara"      # histórico: la app nació sobre Samsara


def active_id() -> str:
    from ... import db
    blob = db.get_setting(ACTIVE_KEY)
    if isinstance(blob, dict) and blob.get("id"):
        return str(blob["id"])
    return DEFAULT_ACTIVE


def set_active(provider_id: str) -> str:
    from ... import db
    reg = registry()
    p = reg.get(provider_id)
    if p is None or p.planned:
        raise ValueError(f"unknown or unavailable provider: {provider_id}")
    db.save_setting(ACTIVE_KEY, {"id": provider_id})
    return provider_id


def active() -> TelematicsProvider:
    reg = registry()
    return reg.get(active_id()) or reg[DEFAULT_ACTIVE]


def hub_group() -> dict:
    """Grupo 'ELD / Telematics' del hub, generado desde el registry."""
    reg = registry()
    act = active_id()
    order = {"connected": 0, "live": 0, "available": 1,
             "not_configured": 2, "planned": 3}
    cards = []
    for p in reg.values():
        card = p.hub_card()
        card["active"] = (p.id == act) and not p.planned
        cards.append(card)
    cards.sort(key=lambda c: (order.get(c["status"], 2), c["name"]))
    return {
        "id": "eld",
        "label": "ELD / Telematics",
        "note": ("Add any ELD by dropping in a provider adapter — the hub, "
                 "credential editor and connection test generate from it. "
                 "Configure credentials, test, and preview the fleet it "
                 "returns. The active provider is the default ELD data "
                 "source as routes migrate to the adapter layer."),
        "providers": cards,
    }
