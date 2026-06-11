# -*- coding: utf-8 -*-
"""POIs del Live Map (fase G2): talleres, dealers y básculas.

Fuente base: `backend/data/pois_seed.json` (versionado) — extracto de
OpenStreetMap (ODbL 1.0, atribución obligatoria en el mapa) + capas
abiertas de DOTs estatales (hoy: Illinois). Se siembra en SQLite la
primera vez y desde ahí se cura en la app (altas/bajas manuales).

Búsqueda Google Places (Text Search New): SOLO para mostrar resultados
en LISTA con atribución y deep link a Google Maps. Los ToS de Google
prohíben pintar resultados de Places sobre un mapa que no sea de Google
y cachear su contenido — por eso esta búsqueda nunca toca la tabla
`poi` ni el mapa. Config en `backend/google.local.json` (gitignored):
    { "places_api_key": "AIza..." }
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import httpx
from sqlalchemy import func, select

from .. import config
from ..db import Poi, SessionLocal

SEED_PATH = Path(__file__).resolve().parents[2] / "data" / "pois_seed.json"
GOOGLE_CONF = config.BACKEND_DIR / "google.local.json"

KINDS = ("repair", "dealer_truck", "dealer_trailer", "scale")


def _seed_if_empty() -> None:
    with SessionLocal() as session:
        n = session.scalar(select(func.count()).select_from(Poi)) or 0
        if n > 0 or not SEED_PATH.exists():
            return
        try:
            data = json.loads(SEED_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        for p in data.get("pois", []):
            if p.get("kind") not in KINDS:
                continue
            session.merge(Poi(
                id=str(p["id"])[:40],
                kind=p["kind"],
                subtype=str(p.get("subtype") or "")[:20],
                name=str(p.get("name") or "")[:140],
                lat=float(p["lat"]),
                lng=float(p["lng"]),
                address=str(p.get("address") or "")[:180],
                phone=str(p.get("phone") or "")[:40],
                brand=str(p.get("brand") or "")[:60],
                source=str(p.get("source") or "seed")[:20],
            ))
        session.commit()


def attribution() -> str:
    if SEED_PATH.exists():
        try:
            data = json.loads(SEED_PATH.read_text(encoding="utf-8"))
            return data.get("attribution", "")
        except (OSError, ValueError):
            pass
    return "POI data (c) OpenStreetMap contributors"


def list_pois() -> list[dict]:
    _seed_if_empty()
    with SessionLocal() as session:
        rows = session.scalars(select(Poi)).all()
        return [{
            "id": r.id, "kind": r.kind, "subtype": r.subtype,
            "name": r.name, "lat": r.lat, "lng": r.lng,
            "address": r.address, "phone": r.phone, "brand": r.brand,
            "source": r.source,
        } for r in rows]


def add_poi(kind: str, name: str, lat: float, lng: float,
            address: str = "", phone: str = "",
            subtype: str = "") -> dict:
    if kind not in KINDS:
        raise ValueError(f"kind inválido: {kind}")
    poi = Poi(
        id=f"man-{uuid.uuid4().hex[:12]}",
        kind=kind, subtype=subtype[:20],
        name=name.strip()[:140] or "POI",
        lat=float(lat), lng=float(lng),
        address=address.strip()[:180], phone=phone.strip()[:40],
        brand="", source="manual",
    )
    with SessionLocal() as session:
        session.add(poi)
        session.commit()
        return {"id": poi.id}


def delete_poi(poi_id: str) -> bool:
    with SessionLocal() as session:
        poi = session.get(Poi, poi_id)
        if poi is None:
            return False
        session.delete(poi)
        session.commit()
        return True


# ----- Búsqueda Google Places (lista, nunca mapa) ----------------------

def _google_key() -> str:
    if not GOOGLE_CONF.exists():
        return ""
    try:
        data = json.loads(GOOGLE_CONF.read_text(encoding="utf-8"))
        return str(data.get("places_api_key") or "").strip()
    except (OSError, ValueError):
        return ""


def google_configured() -> bool:
    return bool(_google_key())


async def google_search(query: str, lat: float | None = None,
                        lng: float | None = None) -> dict:
    """Text Search (New) con field mask mínimo. Devuelve lista plana.

    Sin key → {configured: False} para que la UI muestre el setup.
    """
    key = _google_key()
    if not key:
        return {"configured": False, "results": []}

    body: dict = {"textQuery": query, "pageSize": 12}
    if lat is not None and lng is not None:
        body["locationBias"] = {
            "circle": {
                "center": {"latitude": lat, "longitude": lng},
                "radius": 50000.0,
            },
        }
    fields = ",".join((
        "places.id", "places.displayName", "places.formattedAddress",
        "places.location", "places.googleMapsUri",
        "places.nationalPhoneNumber", "places.currentOpeningHours.openNow",
    ))
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(
            "https://places.googleapis.com/v1/places:searchText",
            headers={
                "X-Goog-Api-Key": key,
                "X-Goog-FieldMask": fields,
                "Content-Type": "application/json",
            },
            json=body,
        )
    if r.status_code != 200:
        detail = ""
        try:
            detail = (r.json().get("error") or {}).get("message", "")
        except ValueError:
            pass
        return {"configured": True, "error": detail or f"HTTP {r.status_code}",
                "results": []}

    out = []
    for p in r.json().get("places", []):
        loc = p.get("location") or {}
        out.append({
            "name": (p.get("displayName") or {}).get("text", ""),
            "address": p.get("formattedAddress", ""),
            "lat": loc.get("latitude"),
            "lng": loc.get("longitude"),
            "phone": p.get("nationalPhoneNumber", ""),
            "open_now": ((p.get("currentOpeningHours") or {})
                         .get("openNow")),
            "maps_url": p.get("googleMapsUri", ""),
        })
    return {"configured": True, "error": "", "results": out}
