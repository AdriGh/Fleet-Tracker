"""Parseo de las hojas de bloques del DVIR Report (`CHASER 6`, `MCC 6`...).

Cada hoja tiene las columnas:
    Company, Driver, Trk#, DVIR, Trl#, DVIR Trl, Duration trk, Duration trl,
    Distance (mi)

y se divide en bloques diarios marcados por una fila con la etiqueta de fecha
en la columna A (p. ej. "6.1", "6.2"). Dentro de cada bloque, un conductor
puede ocupar varias filas (tractores/trailers extra como filas de
continuacion con el nombre vacio).

Reglas de deteccion de infractor (protocolo vigente):
    - NO DVIR  -> la unidad no tiene DVIR de camion ese dia.
    - DVIR corto -> duracion de camion o de trailer < 15 min (900 s).
"""

from dataclasses import dataclass, field

from .duration import parse_duration
from .engine import MIN_DURATION_SECONDS

COMPANIES = {"CHASER", "MCC"}


def _cell(row, i) -> str:
    if row is None or i >= len(row) or row[i] is None:
        return ""
    return str(row[i]).strip()


@dataclass
class Group:
    """Un conductor (o unidad sin conductor) dentro de un bloque diario."""
    company: str
    driver: str  # "" si la fila no trae nombre (unidad sin conductor)
    rows: list[dict] = field(default_factory=list)

    def primary_unit(self) -> str:
        for r in self.rows:
            if r["trk"]:
                return r["trk"]
        for r in self.rows:
            if r["trl"]:
                return r["trl"]
        return ""


def parse_blocks(values: list[list]) -> dict[str, list[Group]]:
    """Devuelve {etiqueta_fecha: [Group, ...]} para una hoja de empresa."""
    blocks: dict[str, list[Group]] = {}
    groups: list[Group] | None = None
    current_company = ""
    cur: Group | None = None

    for row in values:
        c0 = _cell(row, 0)
        if c0 == "Company":
            continue  # encabezado
        if c0 and c0 not in COMPANIES:
            # Fila marcador de fecha (6.1, 6.2, ...).
            groups = blocks.setdefault(c0, [])
            cur = None
            continue
        if groups is None:
            continue  # datos antes del primer marcador: se ignoran

        driver = _cell(row, 1)
        trk = _cell(row, 2)
        company = c0 if c0 in COMPANIES else current_company

        if driver:
            current_company = company
            cur = Group(company=company, driver=driver)
            groups.append(cur)
        elif trk:
            # Unidad con su propio Trk# pero sin nombre: conductor desconocido.
            current_company = company
            cur = Group(company=company, driver="")
            groups.append(cur)
        else:
            # Fila de continuacion (trailer extra del conductor actual).
            if cur is None:
                continue

        cur.rows.append({
            "trk": trk,
            "dvir_trk": _cell(row, 3),
            "trl": _cell(row, 4),
            "dvir_trl": _cell(row, 5),
            "dur_trk": _cell(row, 6),
            "dur_trl": _cell(row, 7),
            "distance": _cell(row, 8),
        })

    return blocks


def _short_seconds(text, threshold) -> int | None:
    """Segundos si `text` es una duracion real por debajo del umbral, si no None."""
    t = str(text or "").strip()
    if not t or t == "-":
        return None
    secs = parse_duration(t)
    return secs if secs < threshold else None


def offender_reasons(group: Group,
                     threshold: int = MIN_DURATION_SECONDS) -> list[dict]:
    """Lista de motivos por los que un conductor debe recibir aviso.

    Cada motivo: {unit, kind, type, detail}
      type: "NO_DVIR" | "SHORT"
      kind: "truck" | "trailer"
    """
    reasons: list[dict] = []
    for r in group.rows:
        # NO DVIR (lado camion).
        if "NO DVIR" in r["dvir_trk"].upper():
            reasons.append({
                "unit": r["trk"] or "—",
                "kind": "truck",
                "type": "NO_DVIR",
                "detail": "NO DVIR",
            })
            continue
        # Duracion corta de camion.
        secs = _short_seconds(r["dur_trk"], threshold)
        if secs is not None:
            reasons.append({
                "unit": r["trk"] or "—",
                "kind": "truck",
                "type": "SHORT",
                "detail": r["dur_trk"],
            })
        # Duracion corta de trailer.
        secs = _short_seconds(r["dur_trl"], threshold)
        if secs is not None:
            reasons.append({
                "unit": r["trl"] or "—",
                "kind": "trailer",
                "type": "SHORT",
                "detail": r["dur_trl"],
            })
    return reasons
