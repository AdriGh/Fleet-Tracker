# -*- coding: utf-8 -*-
"""Marketplace de partes — scaffold listo para conectar (Increment B).

El marketplace REAL (FindItParts / PartsTech) necesita una cuenta de API
que el taller todavía NO tiene. En vez de bloquear el feature, este módulo
deja toda la plomería armada con un proveedor MOCK que devuelve resultados
de muestra realistas, de modo que enchufar el proveedor real más adelante
sea trivial: escribir UNA clase adapter y registrarla.

Espeja el framework de adapters de ELD (core/providers/__init__.py):
- `PartsProvider` (ABC) define lo que la app consume de un marketplace y se
  autodescribe (id, nombre, docs, status()).
- `MockPartsProvider` devuelve muestras (NO datos en vivo); status()
  reporta configured=false porque no hay API key.
- `FindItPartsProvider` / `PartsTechProvider`: adapters reales esbozados
  (config por *.local.json gitignored, igual que el resto de proveedores).
  Quedan inactivos hasta que haya credenciales; cuando las haya, el módulo
  los usa automáticamente y deja de devolver el mock.

Cómo conectar el proveedor real (cuando llegue la cuenta de API):
  1. Crear backend/parts_marketplace.local.json con, p.ej.:
         { "provider": "finditparts", "api_key": "…", "base_url": "https://…" }
  2. Implementar `_live_search` del adapter correspondiente (un GET al
     endpoint de búsqueda del proveedor + map de su JSON a SearchResult).
  3. Listo: `search()` detecta que hay credenciales (configured=true) y
     enruta al proveedor real; el banner de "Demo data" desaparece solo.

Seguridad/forma: igual que los demás proveedores, las credenciales viven
en un archivo local gitignored y NUNCA se devuelven por la API.
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass
from pathlib import Path

from .. import config

# Credenciales del marketplace (gitignored, igual que docscan.local.json y
# compañía). No existe hasta que el usuario conecte un proveedor real.
SETTINGS_PATH = config.BACKEND_DIR / "parts_marketplace.local.json"


# ----- Forma del resultado -------------------------------------------------

@dataclass
class SearchResult:
    """Una oferta de parte de un marketplace. Misma forma para mock y real,
    así el frontend y el QuickBuy no distinguen la fuente."""
    part_number: str
    description: str
    brand: str
    price: float            # precio unitario (USD); 0.0 = sin precio público
    availability: str       # 'in_stock' | 'limited' | 'backorder' | 'special_order'
    vendor: str             # quién vende (distribuidor/tienda)

    def to_dict(self) -> dict:
        return asdict(self)


# ----- Framework de adapters ------------------------------------------------

class PartsProvider(ABC):
    """Lo que la app consume de un marketplace de partes + autodescripción."""

    id: str = ""
    name: str = ""
    docs: str = ""              # nota corta para Settings → Connectivity

    @abstractmethod
    def configured(self) -> bool:
        """¿Hay credenciales (API key) presentes?"""

    @abstractmethod
    def search(self, query: str, limit: int = 20) -> list[SearchResult]:
        """Busca partes por texto (número, descripción o marca)."""

    def status(self) -> dict:
        """Estado para el hub/banner. `configured=False` => la UI muestra el
        aviso de datos demo. Nunca devuelve credenciales."""
        ok = self.configured()
        return {
            "provider": self.id,
            "name": self.name,
            "configured": ok,
            "live": ok,
            "detail": (self.docs or f"{self.name} connected")
            if ok else
            "Demo data — no parts supplier API connected yet",
        }


# ----- Proveedor MOCK (default mientras no haya cuenta) ---------------------

# Muestras realistas de partes pesadas (frenos, filtros, eléctrico, reefer).
# Cubren las categorías típicas de una flota de camión + cold chain, para que
# la búsqueda demuestre algo útil sin importar qué teclee el usuario.
_SAMPLE: list[SearchResult] = [
    SearchResult("BPW-0980", "Air disc brake pad set, steer axle",
                 "Bendix", 184.50, "in_stock", "FleetPride"),
    SearchResult("4515", "Brake chamber, type 30/30 long stroke",
                 "Haldex", 79.95, "in_stock", "FinditParts (demo)"),
    SearchResult("LFF8000", "Lube spin-on oil filter",
                 "Fleetguard", 21.40, "in_stock", "TruckPro"),
    SearchResult("FS1280", "Fuel/water separator filter",
                 "Fleetguard", 38.75, "limited", "FinditParts (demo)"),
    SearchResult("DPF-2880", "Diesel particulate filter, Cummins ISX",
                 "Roadwarrior", 1245.00, "special_order", "PartsTech (demo)"),
    SearchResult("R955080", "Air dryer cartridge",
                 "Meritor", 64.20, "in_stock", "FleetPride"),
    SearchResult("21-2815", "LED stop/turn/tail lamp, red",
                 "Grote", 18.90, "in_stock", "TruckPro"),
    SearchResult("BXT-31", "Group 31 AGM starting battery, 925 CCA",
                 "Odyssey", 289.00, "limited", "FinditParts (demo)"),
    SearchResult("TK-417070", "Reefer belt, alternator/water pump",
                 "Thermo King", 42.30, "backorder", "Reefer Parts Co (demo)"),
    SearchResult("EA1-2090", "Cabin/HVAC air filter",
                 "Donaldson", 27.60, "in_stock", "PartsTech (demo)"),
    SearchResult("S-21228", "Wheel seal, drive axle",
                 "SKF", 16.85, "in_stock", "TruckPro"),
    SearchResult("HDX-110", "Heavy-duty serpentine belt",
                 "Gates", 54.10, "in_stock", "FleetPride"),
]


class MockPartsProvider(PartsProvider):
    """Devuelve muestras filtradas por texto. NO es data en vivo: status()
    reporta configured=false a propósito para que la UI marque 'demo'."""

    id = "mock"
    name = "Demo marketplace"
    docs = "Sample data — connect FindItParts/PartsTech for live results"

    def configured(self) -> bool:
        return False

    def search(self, query: str, limit: int = 20) -> list[SearchResult]:
        q = (query or "").strip().lower()
        if not q:
            return _SAMPLE[:limit]
        hits = [
            r for r in _SAMPLE
            if q in r.part_number.lower()
            or q in r.description.lower()
            or q in r.brand.lower()
        ]
        # Si no hay coincidencia textual, igual mostramos algo (es demo): así
        # el usuario ve cómo se verán los resultados reales.
        return (hits or _SAMPLE)[:limit]


# ----- Adapters reales (esbozados, inactivos hasta tener credenciales) -----

class _ApiKeyProvider(PartsProvider):
    """Base de un proveedor real con API key en el *.local.json. `search`
    enruta a `_live_search` cuando hay credenciales; ese método se implementa
    al conectar el proveedor (un GET al endpoint del proveedor + map a
    SearchResult)."""

    def _creds(self) -> dict:
        if SETTINGS_PATH.exists():
            try:
                return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return {}
        return {}

    def configured(self) -> bool:
        c = self._creds()
        return c.get("provider") == self.id and bool(c.get("api_key"))

    def search(self, query: str, limit: int = 20) -> list[SearchResult]:
        if not self.configured():
            return []
        return self._live_search(query, limit, self._creds())

    def _live_search(self, query: str, limit: int,
                     creds: dict) -> list[SearchResult]:
        # TODO(conectar API): GET al endpoint de búsqueda del proveedor con
        # creds["api_key"] / creds["base_url"], y mapear su JSON a
        # SearchResult(part_number, description, brand, price, availability,
        # vendor). Hasta entonces, sin datos.
        raise NotImplementedError(
            f"{self.name} live search not wired yet")


class FindItPartsProvider(_ApiKeyProvider):
    id = "finditparts"
    name = "FindItParts"
    docs = "FindItParts catalog/search API"


class PartsTechProvider(_ApiKeyProvider):
    id = "partstech"
    name = "PartsTech"
    docs = "PartsTech parts & pricing API"


# ----- Registry + selección del proveedor activo ---------------------------

def registry() -> dict[str, PartsProvider]:
    out: dict[str, PartsProvider] = {}
    for cls in (MockPartsProvider, FindItPartsProvider, PartsTechProvider):
        p = cls()
        out[p.id] = p
    return out


def active() -> PartsProvider:
    """El primer proveedor real configurado; si ninguno lo está, el mock.

    Así, en cuanto exista parts_marketplace.local.json con una api_key, la
    app deja de devolver el mock sin tocar más código."""
    reg = registry()
    for pid in ("finditparts", "partstech"):
        p = reg.get(pid)
        if p is not None and p.configured():
            return p
    return reg["mock"]


def status() -> dict:
    """Estado del marketplace activo (para Settings → Connectivity y el
    banner del panel de búsqueda). configured=false => UI en modo demo."""
    return active().status()


def search(query: str, limit: int = 20) -> dict:
    """Busca partes en el marketplace activo. Forma de respuesta estable:
    { configured: bool, provider, results: [...] }. Con el mock, configured
    es false y results son muestras."""
    prov = active()
    limit = max(1, min(int(limit or 20), 50))
    try:
        results = prov.search(query, limit)
    except NotImplementedError:
        # Un adapter real marcado como configurado pero sin _live_search:
        # caemos al mock para no romper la UI.
        prov = registry()["mock"]
        results = prov.search(query, limit)
    return {
        "configured": prov.configured(),
        "provider": prov.id,
        "results": [r.to_dict() for r in results],
    }
