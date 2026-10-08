# -*- coding: utf-8 -*-
"""Match de vendors para el escáner de facturas (v2.21, outside work).

El escáner extrae el nombre del taller tal como está impreso ("LOVES
TRAVEL STOP #418 TOTAL TRUCK CARE"); acá se busca el Vendor del catálogo
que corresponde para ligarlo a la WO outside sin crear duplicados.

Normalización (misma lista canónica de cadenas que docscan._CHAINS, pero
anclada a palabra completa — ver _VENDOR_CHAINS): si el nombre es de una
CADENA conocida (Speedco, Love's, TA, Petro…) se usa la marca canónica;
después minúsculas, sin puntuación ni espacios extra.
Similitud = difflib.SequenceMatcher.ratio() entre nombres normalizados.

Ubicación: dos Speedco en ciudades distintas son vendors DISTINTOS. Misma
marca + misma ciudad => boost; misma marca pero otra ciudad/estado explícitos
=> el puntaje se topea por debajo del umbral (queda como candidato, nunca se
liga solo); misma marca y ubicación conocida de un solo lado => tampoco se
liga solo. Sin marca: misma ciudad +0.05, estado distinto explícito -0.05.
Dos candidatos empatados arriba del umbral = ambiguo => vendor None.
Umbral de match seguro: score >= 0.86. Solo lectura.
"""

from __future__ import annotations

import re
from difflib import SequenceMatcher

from sqlalchemy import func, select

from ..db import SessionLocal, Vendor
from . import docscan

MATCH_THRESHOLD = 0.86
MAX_CANDIDATES = 5
# Candidatos por debajo de esto ni se listan (ruido).
_MIN_CANDIDATE = 0.40
_BRAND_BOOST = 0.10
_CITY_BOOST = 0.05
# Misma cadena pero OTRA ciudad/estado explícitos: no es el mismo taller.
_BRAND_MISMATCH_CAP = 0.80
# Misma cadena y ubicación conocida de un solo lado: no se liga solo.
_BRAND_UNKNOWN_CAP = MATCH_THRESHOLD - 0.01
# Dos candidatos a menos de esto entre sí = empate técnico (ambiguo).
_TIE_EPS = 0.001

_PUNCT = re.compile(r"[^a-z0-9 ]+")

# Marcas de cadena para NOMBRES DE VENDOR. docscan._CHAINS son substrings
# pensados para el ENCABEZADO de una factura ("ta truck" cae dentro de
# "DelTA TRUCK Repair", "pilot" dentro de "Autopilot Diesel", "loves" dentro
# de "Gloves & Tools"); aplicados a un catálogo colapsaban talleres ajenos a
# la marca y los auto-ligaban al 100%. Acá cada marca exige palabra completa.
# Los nombres canónicos son los MISMOS que docscan (el extract ya viene
# colapsado a esa marca por _apply_brand); el orden importa igual que allá
# (Speedco antes que Love's, TA antes que Petro).
_VENDOR_CHAINS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\bspeedco\b", re.I), "Speedco"),
    (re.compile(r"\blove'?s\b", re.I), "Love's Truck Care"),
    (re.compile(r"\btravelcenters\b|\bta\s*truck\b|\bta\s*petro\b", re.I),
     "TA Truck Service"),
    (re.compile(r"\bpetro\b", re.I), "Petro"),
    (re.compile(r"\bboss\s*(?:truck\s*)?shop\b", re.I), "Boss Shop"),
    (re.compile(r"\bpilot\b|\bflying\s*j\b", re.I), "Pilot / Flying J"),
    (re.compile(r"\bfleetpride\b", re.I), "FleetPride"),
    (re.compile(r"\bsapp\s*bros\b", re.I), "Sapp Bros"),
]
# Las marcas canónicas deben seguir siendo las de docscan.
assert {n for _, n in _VENDOR_CHAINS} == {n for _, n in docscan._CHAINS}


def brand_of(name: str) -> str:
    """Marca de cadena canónica del nombre (palabra completa) o ''."""
    for rx, canon in _VENDOR_CHAINS:
        if rx.search(name or ""):
            return canon
    return ""


def normalize(name: str) -> str:
    """Nombre comparable: marca canónica si es una cadena conocida, en
    minúsculas, sin puntuación, espacios colapsados."""
    text = brand_of(name) or (name or "")
    text = _PUNCT.sub(" ", text.lower().replace("&", " and "))
    return " ".join(text.split())


def _city_key(city: str) -> str:
    return " ".join(_PUNCT.sub(" ", (city or "").lower()).split())


def _location(city: str, state: str, vendor_city: str,
              vendor_state: str) -> str:
    """'same' | 'different' | 'unknown' entre la ubicación extraída y la del
    vendor. Un estado explícito distinto separa; si no, decide la ciudad
    cuando se conoce en ambos lados; con la ciudad faltante en un lado es
    'unknown'."""
    s, vs = (state or "").strip().lower(), (vendor_state or "").strip().lower()
    if s and vs and s != vs:
        return "different"
    c, vc = _city_key(city), _city_key(vendor_city)
    if c and vc:
        return "same" if c == vc else "different"
    return "unknown"


def score(name: str, vendor_name: str, city: str = "",
          vendor_city: str = "", state: str = "",
          vendor_state: str = "") -> float:
    """Puntaje crudo (puede superar 1.0 por los boosts; el orden es lo que
    importa). 0 si falta alguno de los nombres."""
    a, b = normalize(name), normalize(vendor_name)
    if not a or not b:
        return 0.0
    s = SequenceMatcher(None, a, b).ratio()
    loc = _location(city, state, vendor_city, vendor_state)
    ba, bb = brand_of(name), brand_of(vendor_name)
    if ba and ba == bb:
        # Misma cadena: solo es el MISMO taller si la ubicación coincide (o
        # nadie la conoce). Otra ciudad/estado => candidato, nunca auto-link.
        if loc == "same":
            return s + _BRAND_BOOST + _CITY_BOOST
        if loc == "different":
            return min(s, _BRAND_MISMATCH_CAP)
        if _city_key(city) or _city_key(vendor_city):
            return min(s + _BRAND_BOOST, _BRAND_UNKNOWN_CAP)
        return s + _BRAND_BOOST
    if loc == "same":
        s += _CITY_BOOST
    elif (state and vendor_state
          and state.strip().lower() != vendor_state.strip().lower()):
        # Estado distinto y explícito en ambos lados: no es el mismo shop.
        s -= _CITY_BOOST
    return s


def _vendor_dict(v: Vendor) -> dict:
    from . import parts                # import diferido (orden de carga)
    return parts._vendor_dict(v)


def match(name: str, city: str = "", state: str = "") -> dict:
    """{vendor: VendorDict|None, candidates: [{id,name,city,state,score}]}.
    `vendor` es el mejor candidato si supera el umbral y no empata con el
    segundo; `candidates` son los 5 mejores (score redondeado y topeado a
    1.0) para que la UI ofrezca "¿es este?". Solo lectura."""
    name = (name or "").strip()
    city = (city or "").strip()
    state = (state or "").strip()
    out: dict = {"vendor": None, "candidates": []}
    if not name:
        return out
    with SessionLocal() as session:
        rows = session.scalars(
            select(Vendor).order_by(func.lower(Vendor.name))).all()
        scored: list[tuple[float, Vendor]] = []
        for v in rows:
            s = score(name, v.name, city, v.city or "", state, v.state or "")
            if s >= _MIN_CANDIDATE:
                scored.append((s, v))
        scored.sort(key=lambda t: (-t[0], t[1].name.lower(), t[1].id))
        top = scored[:MAX_CANDIDATES]
        out["candidates"] = [{
            "id": v.id, "name": v.name, "city": v.city or "",
            "state": v.state or "", "score": round(min(1.0, s), 3),
        } for s, v in top]
        if top and top[0][0] >= MATCH_THRESHOLD:
            # Empate técnico entre los dos mejores (dos Speedco y la factura
            # sin ciudad): ambiguo, se ofrecen ambos y no se liga ninguno.
            tie = len(top) > 1 and (top[0][0] - top[1][0]) < _TIE_EPS
            if not tie:
                out["vendor"] = _vendor_dict(top[0][1])
    return out
