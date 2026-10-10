# -*- coding: utf-8 -*-
"""Exportación de reportes (v2.22): resultado del motor -> CSV / XLSX.

Lo usan POST /api/reports/export (descarga) y los envíos programados
(adjunto del email). CSV con BOM (Excel lo abre con acentos bien); XLSX con
openpyxl (ya en requirements): encabezado con estilo, formatos por tipo
(moneda, número, fecha), fila de totales, filtros y panel congelado.

Seguridad: un texto que empieza con = + - @ se neutraliza (CSV: prefijo
"'"; XLSX: celda de tipo string) para que una planilla no ejecute
fórmulas inyectadas desde datos del usuario (CSV/formula injection). Vale
para TODO texto que escribe el exportador: celdas de datos, encabezados
(las etiquetas de columna son libres en un reporte guardado) y el título /
subtítulo (el nombre del reporte). Ninguna celda del XLSX sale como fórmula.
"""

from __future__ import annotations

import csv
import io
import re
from datetime import date, datetime

FORMATS = ("csv", "xlsx")
_MIME = {
    "csv": "text/csv; charset=utf-8",
    "xlsx": ("application/vnd.openxmlformats-officedocument."
             "spreadsheetml.sheet"),
}
_FORMULA_START = ("=", "+", "-", "@", "\t", "\r")


def slugify(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", name or "").strip("-").lower()
    return (s or "report")[:60]


def _enum_labels(col: dict) -> dict:
    return {e["value"]: e["label"] for e in col.get("enum") or []}


def _safe(s) -> str:
    """Texto libre (etiqueta, título) neutralizado para CSV."""
    s = "" if s is None else str(s)
    return "'" + s if s.startswith(_FORMULA_START) else s


def _text(v, col: dict) -> str:
    """Valor como texto para CSV."""
    if v is None:
        return ""
    t = col.get("type")
    if t == "bool":
        return "Yes" if v else "No"
    if t == "money":
        return f"{float(v):.2f}"
    if t == "datetime" and isinstance(v, str):
        return v.replace("T", " ")[:16]
    labels = _enum_labels(col)
    if labels and v in labels:
        return labels[v]
    s = str(v)
    if t == "text" and s.startswith(_FORMULA_START):
        return "'" + s
    return s


def to_csv(result: dict) -> bytes:
    cols = result["columns"]
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow([_safe(c["label"]) for c in cols])
    for r in result["rows"]:
        w.writerow([_text(r.get(c["key"]), c) for c in cols])
    totals = result.get("totals")
    if totals:
        w.writerow([("Total" if i == 0 and c["key"] not in totals else
                     _text(totals.get(c["key"]), c))
                    for i, c in enumerate(cols)])
    return ("﻿" + out.getvalue()).encode("utf-8")


def to_xlsx(result: dict, title: str = "Report",
            subtitle: str = "") -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    cols = result["columns"]
    wb = Workbook()
    ws = wb.active
    ws.title = (re.sub(r"[\[\]\*\?/\\:]", " ", title) or "Report")[:31]
    def text_cell(row_i: int, j: int, v):
        """Celda de texto libre: SIEMPRE string (openpyxl toma "=…" como
        fórmula si no se fuerza el tipo)."""
        cell = ws.cell(row=row_i, column=j, value=str(v or ""))
        cell.data_type = "s"
        return cell

    head_row = 1
    if subtitle:
        text_cell(1, 1, title).font = Font(bold=True, size=13)
        text_cell(2, 1, subtitle).font = Font(italic=True, color="FF666666")
        head_row = 4
    fill = PatternFill("solid", fgColor="FF1F2937")
    for j, c in enumerate(cols, start=1):
        cell = text_cell(head_row, j, c["label"])
        cell.font = Font(bold=True, color="FFFFFFFF")
        cell.fill = fill
        cell.alignment = Alignment(vertical="center")
    widths = [max(10, min(40, len(c["label"]) + 2)) for c in cols]

    def put(row_i: int, j: int, v, c: dict, bold: bool = False):
        t = c.get("type")
        cell = ws.cell(row=row_i, column=j)
        if v is None:
            return
        if t in ("money", "number"):
            cell.value = float(v) if not isinstance(v, int) else v
            cell.number_format = ('"$"#,##0.00' if t == "money"
                                  else "#,##0.##")
        elif t == "date" and isinstance(v, str):
            try:
                cell.value = date.fromisoformat(v[:10])
                cell.number_format = "yyyy-mm-dd"
            except ValueError:
                cell.value = v
        elif t == "datetime" and isinstance(v, str):
            try:
                cell.value = datetime.fromisoformat(v)
                cell.number_format = "yyyy-mm-dd hh:mm"
            except ValueError:
                cell.value = v
        elif t == "bool":
            cell.value = "Yes" if v else "No"
        else:
            labels = _enum_labels(c)
            s = labels.get(v, v) if labels else v
            s = str(s)
            cell.value = s
            # Nunca una fórmula: openpyxl trata "=…" como fórmula.
            cell.data_type = "s"
            widths[j - 1] = max(widths[j - 1], min(60, len(s) + 2))
        if bold:
            cell.font = Font(bold=True)

    r_i = head_row
    for r in result["rows"]:
        r_i += 1
        for j, c in enumerate(cols, start=1):
            put(r_i, j, r.get(c["key"]), c)
    totals = result.get("totals")
    if totals:
        r_i += 1
        for j, c in enumerate(cols, start=1):
            if c["key"] in totals:
                put(r_i, j, totals[c["key"]], c, bold=True)
            elif j == 1:
                ws.cell(row=r_i, column=1, value="Total").font = Font(
                    bold=True)
    for j, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(j)].width = w
    ws.freeze_panes = ws.cell(row=head_row + 1, column=1)
    if result["rows"] and cols:
        ws.auto_filter.ref = (f"A{head_row}:{get_column_letter(len(cols))}"
                              f"{head_row + len(result['rows'])}")
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def render(result: dict, fmt: str, title: str,
           subtitle: str = "") -> tuple[bytes, str, str]:
    """(bytes, mimetype, filename)."""
    fmt = (fmt or "csv").lower()
    if fmt not in FORMATS:
        raise ValueError("format must be csv or xlsx")
    try:
        from . import org_config
        stamp = org_config.org_today().isoformat()
    except Exception:  # noqa: BLE001 — sin tenant/base: fecha del server
        stamp = date.today().isoformat()
    name = f"{slugify(title)}-{stamp}.{fmt}"
    data = (to_csv(result) if fmt == "csv"
            else to_xlsx(result, title, subtitle))
    return data, _MIME[fmt], name
