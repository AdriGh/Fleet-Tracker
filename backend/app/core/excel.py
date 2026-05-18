"""Escritura del informe DVIR a un archivo Excel con formato."""

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from .engine import COLUMNS, NO_DVIR_TEXT

HEADER_FILL = "1F4E79"
HEADER_FONT_COLOR = "FFFFFF"
STATUS_STYLES = {
    "Safe":     ("C6EFCE", "276221"),
    "Resolved": ("C6EFCE", "006100"),
    "Unsafe":   ("FFC7CE", "9C0006"),
    "NO DVIR":  ("FFE0B2", "BF360C"),
}
# Indices 1-based de las columnas del lado del camion.
TRUCK_COLS = (3, 4, 7, 9, 11)
COL_WIDTHS = [16, 20, 12, 13, 12, 13, 14, 14, 15, 15, 12, 12]


def write_excel(groups, company, date_label, out_path):
    wb = Workbook()
    ws = wb.active
    ws.title = f"{company} {date_label}"[:31]

    thin = Side(style="thin", color="D9D9D9")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    center = Alignment(horizontal="center", vertical="center", wrap_text=True)

    # Encabezado
    header_fill = PatternFill("solid", fgColor=HEADER_FILL)
    header_font = Font(name="Calibri", size=12, bold=True,
                       color=HEADER_FONT_COLOR)
    for col, name in enumerate(COLUMNS, start=1):
        cell = ws.cell(row=1, column=col, value=name)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = center
        cell.border = border
    ws.row_dimensions[1].height = 30

    # Fila marcador del dia
    ws.cell(row=2, column=1, value=date_label)
    ws.merge_cells(start_row=2, start_column=1,
                   end_row=2, end_column=len(COLUMNS))
    marker = ws.cell(row=2, column=1)
    marker.fill = header_fill
    marker.font = header_font
    marker.alignment = Alignment(horizontal="center", vertical="center")

    row = 3
    for group in groups:
        start = row
        rows = group["rows"]
        for entry in rows:
            for col, name in enumerate(COLUMNS, start=1):
                value = entry.get(name, "")
                cell = ws.cell(row=row, column=col, value=value)
                cell.alignment = center
                cell.border = border
                cell.font = Font(name="Calibri", size=11)
                if name in ("DVIR trk", "DVIR trl"):
                    style = None
                    if value == NO_DVIR_TEXT:
                        style = STATUS_STYLES["NO DVIR"]
                    elif value in STATUS_STYLES:
                        style = STATUS_STYLES[value]
                    if style:
                        cell.fill = PatternFill("solid", fgColor=style[0])
                        cell.font = Font(name="Calibri", size=11, bold=True,
                                         color=style[1])
            row += 1
        # Fusiones verticales
        if row - start > 1:
            cols_to_merge = [2]  # Driver
            if group["truck_merge"]:
                cols_to_merge += list(TRUCK_COLS)
            for col in cols_to_merge:
                ws.merge_cells(start_row=start, start_column=col,
                               end_row=row - 1, end_column=col)
                ws.cell(row=start, column=col).alignment = center

    for i, width in enumerate(COL_WIDTHS, start=1):
        ws.column_dimensions[get_column_letter(i)].width = width
    ws.freeze_panes = "A3"
    wb.save(out_path)
