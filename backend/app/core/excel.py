"""Escritura del informe DVIR a Excel con formato.

- write_excel:    un solo bloque diario en una hoja.
- write_workbook: workbook mensual con una hoja por empresa y los
                  bloques diarios apilados.
"""

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from .duration import parse_duration
from .engine import (
    COLUMNS, NO_DVIR_TEXT, NO_PRETRIP_TEXT, min_duration_seconds)

# Colores en ARGB de 8 digitos (alfa FF = opaco), exactos del DVIR Report.
HEADER_FILL = "FF1F4E79"
HEADER_FONT_COLOR = "FFFFFFFF"
STATUS_STYLES = {
    "Safe":     ("FFC6EFCE", "FF276221"),
    "Resolved": ("FFC6EFCE", "FF006100"),
    "Unsafe":   ("FFFFC7CE", "FF9C0006"),
    "NO DVIR":  ("FFFFE0B2", "FFBF360C"),
}
DASH_FILL, DASH_FONT = "FFD6E8F7", "FF1A1A1A"  # celda sin info
DUR_LOW = ("FFFFC7CE", "FF9C0006")             # duracion < 15 min / mal
DUR_HIGH = ("FFC6EFCE", "FF276221")            # duracion >= 15 min / ok
# DUR_THRESHOLD ahora es dinámico: ver min_duration_seconds() (fase G7).
DUR_COLS = ("Pre-trip",)
# Columnas que llevan el mismo formato que las celdas vacias (relleno azul).
BLUE_COLS = ("Trl#", "Distance (mi)")
# Indices 1-based de las columnas del lado del camion que se fusionan cuando
# hay un unico camion (Trk#, DVIR trk, Distance (mi)).
TRUCK_COLS = (3, 4, 8)
# Indice 1-based de la columna por conductor (Pre-trip): se fusiona siempre
# con el nombre a lo largo de las filas del conductor.
DRIVER_COLS = (7,)
COL_WIDTHS = [16, 20, 12, 13, 12, 13, 13, 13]

_THIN = Side(style="thin", color="D9D9D9")
_BORDER = Border(left=_THIN, right=_THIN, top=_THIN, bottom=_THIN)
_CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)
_HEADER_FILL = PatternFill("solid", fgColor=HEADER_FILL)
_HEADER_FONT = Font(name="Calibri", size=15, bold=True,
                    color=HEADER_FONT_COLOR)


def _write_header(ws):
    for col, name in enumerate(COLUMNS, start=1):
        cell = ws.cell(row=1, column=col, value=name)
        cell.fill = _HEADER_FILL
        cell.font = _HEADER_FONT
        cell.alignment = _CENTER
        cell.border = _BORDER
    ws.row_dimensions[1].height = 30
    for i, width in enumerate(COL_WIDTHS, start=1):
        ws.column_dimensions[get_column_letter(i)].width = width
    ws.freeze_panes = "A2"


def _write_block(ws, start_row, date_label, groups):
    """Escribe una fila marcador + las filas del bloque. Devuelve la
    siguiente fila libre."""
    # Fila marcador del dia (celda fusionada A:L).
    ws.cell(row=start_row, column=1, value=date_label)
    ws.merge_cells(start_row=start_row, start_column=1,
                   end_row=start_row, end_column=len(COLUMNS))
    marker = ws.cell(row=start_row, column=1)
    marker.fill = _HEADER_FILL
    marker.font = _HEADER_FONT
    marker.alignment = Alignment(horizontal="center", vertical="center")

    row = start_row + 1
    for group in groups:
        group_start = row
        for entry in group["rows"]:
            for col, name in enumerate(COLUMNS, start=1):
                value = entry.get(name, "")
                cell = ws.cell(row=row, column=col, value=value)
                cell.alignment = _CENTER
                cell.border = _BORDER
                cell.font = Font(name="Calibri", size=15)
                if name in BLUE_COLS:
                    # Trl# y Distance: mismo formato que las celdas vacias.
                    cell.fill = PatternFill("solid", fgColor=DASH_FILL)
                    cell.font = Font(name="Calibri", size=15,
                                     color=DASH_FONT)
                elif value == "-":
                    # Celda sin info: guion sobre relleno azul.
                    cell.fill = PatternFill("solid", fgColor=DASH_FILL)
                    cell.font = Font(name="Calibri", size=15,
                                     color=DASH_FONT)
                elif name in DUR_COLS and value:
                    # Pre-trip: '⚠ NO PRE-TRIP' en naranja (como NO DVIR);
                    # si no, rojo < 15 min, verde >= 15 min.
                    if value == NO_PRETRIP_TEXT:
                        fill, font_color = STATUS_STYLES["NO DVIR"]
                    else:
                        fill, font_color = (
                            DUR_LOW
                            if parse_duration(value) < min_duration_seconds()
                            else DUR_HIGH)
                    cell.fill = PatternFill("solid", fgColor=fill)
                    cell.font = Font(name="Calibri", size=15, bold=True,
                                     color=font_color)
                elif name in ("DVIR trk", "DVIR trl"):
                    style = None
                    if value == NO_DVIR_TEXT:
                        style = STATUS_STYLES["NO DVIR"]
                    elif value in STATUS_STYLES:
                        style = STATUS_STYLES[value]
                    if style:
                        cell.fill = PatternFill("solid", fgColor=style[0])
                        cell.font = Font(name="Calibri", size=15, bold=True,
                                         color=style[1])
            # NO DVIR: fusionar la celda "⚠ NO DVIR" de la D a la F (4-6).
            # Pre-trip (G) queda aparte con su propio estado.
            if entry.get("DVIR trk") == NO_DVIR_TEXT:
                ws.merge_cells(start_row=row, start_column=4,
                               end_row=row, end_column=6)
                ws.cell(row=row, column=4).alignment = _CENTER
            row += 1
        if row - group_start > 1:
            # Nombre (2) y Pre-trip (7) son por conductor: se fusionan
            # siempre. El lado del camion solo cuando hay un unico camion.
            cols_to_merge = [2, *DRIVER_COLS]
            if group["truck_merge"]:
                cols_to_merge += list(TRUCK_COLS)
            for col in cols_to_merge:
                ws.merge_cells(start_row=group_start, start_column=col,
                               end_row=row - 1, end_column=col)
                ws.cell(row=group_start, column=col).alignment = _CENTER
    return row


def write_excel(groups, company, date_label, out_path):
    """Un solo bloque diario en una hoja."""
    wb = Workbook()
    ws = wb.active
    ws.title = f"{company} {date_label}"[:31]
    _write_header(ws)
    _write_block(ws, 2, date_label, groups)
    wb.save(out_path)


def write_workbook(sheets, out_path):
    """Workbook mensual. sheets: lista de dicts:
        {"name": str, "blocks": [{"date_label": str, "groups": [...]}]}
    """
    wb = Workbook()
    wb.remove(wb.active)
    for sheet in sheets:
        ws = wb.create_sheet(title=sheet["name"][:31])
        _write_header(ws)
        row = 2
        for block in sheet["blocks"]:
            row = _write_block(ws, row, block["date_label"],
                               block["groups"])
            row += 1  # fila en blanco entre bloques
    if not wb.sheetnames:
        wb.create_sheet(title="Empty")
    wb.save(out_path)
