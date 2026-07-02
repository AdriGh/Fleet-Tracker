# -*- coding: utf-8 -*-
"""Genera el formulario imprimible de Work Order para la yarda MDW.

Pensado para llenarse A MANO (mecanico sin tecnologia): letra grande y
cajas altas. Los labels (UNIT #, DATE, MILEAGE, SHOP INVOICE #) coinciden
con lo que el escaner de invoices de la app sabe extraer, asi que una foto
del formulario llenado se puede soltar en Work Orders -> New work order
y se autollena.

Uso:  py backend/scripts/make_wo_form.py [salida.pdf]
Dependencia dev-only: PyMuPDF (fitz) — no esta en requirements.txt.
"""
import sys
from pathlib import Path

import fitz

PAGE_W, PAGE_H = 612, 792          # Letter en puntos
MARGIN = 40
LEFT, RIGHT = MARGIN, PAGE_W - MARGIN
WIDTH = RIGHT - LEFT

INK = (0, 0, 0)
GRAY = (0.45, 0.45, 0.45)
BAR = (0.90, 0.90, 0.90)
LINE = (0.55, 0.55, 0.55)

BOLD, REG = "hebo", "helv"


def text(page, x, y, s, size=10, font=REG, color=INK, align_right=None):
    if align_right is not None:
        w = fitz.get_text_length(s, fontname=font, fontsize=size)
        x = align_right - w
    page.insert_text((x, y), s, fontname=font, fontsize=size, color=color)


def section_bar(page, y, label):
    page.draw_rect(fitz.Rect(LEFT, y, RIGHT, y + 19), color=INK, fill=BAR, width=0.8)
    text(page, LEFT + 7, y + 13.5, label, size=10.5, font=BOLD)
    return y + 19


def dollar_hint(page, cell):
    text(page, cell.x0 + 4, cell.y1 - 6, "$", size=9, color=GRAY)


def ruled_table(page, y, cols, headers, rows, row_h, money_cols):
    """cols = anchos; dibuja header de columnas + grilla. Devuelve y final."""
    xs = [LEFT]
    for w in cols:
        xs.append(xs[-1] + w)
    hh = 16
    page.draw_rect(fitz.Rect(LEFT, y, RIGHT, y + hh), color=INK, fill=(0.97, 0.97, 0.97), width=0.8)
    for i, h in enumerate(headers):
        text(page, xs[i] + 5, y + 11, h, size=8, font=BOLD)
    y += hh
    for r in range(rows):
        cell_y = y + r * row_h
        for i in range(len(cols)):
            cell = fitz.Rect(xs[i], cell_y, xs[i + 1], cell_y + row_h)
            page.draw_rect(cell, color=LINE, width=0.7)
            if i in money_cols:
                dollar_hint(page, cell)
    return y + rows * row_h


def build(out_path: Path) -> None:
    doc = fitz.open()
    page = doc.new_page(width=PAGE_W, height=PAGE_H)

    # ---- Encabezado ----
    y = 52
    text(page, LEFT, y, "MEMPHIS CITY CARTAGE", size=15, font=BOLD)
    text(page, LEFT, y + 14, "MDW Yard — Chicago, IL", size=9, color=GRAY)
    text(page, 0, y, "WORK ORDER", size=21, font=BOLD, align_right=RIGHT)

    # Caja de Shop Invoice # (arriba a la derecha)
    inv_label_y = y + 30
    text(page, 372, inv_label_y, "SHOP INVOICE #", size=8, font=BOLD)
    page.draw_rect(fitz.Rect(372, inv_label_y + 4, RIGHT, inv_label_y + 34), color=INK, width=1.1)

    y = inv_label_y + 44
    page.draw_line((LEFT, y), (RIGHT, y), color=INK, width=1.2)

    # ---- Fila de datos: Unit / Date / Mileage / Mechanic ----
    y += 13
    fields = ["UNIT #", "DATE", "MILEAGE", "MECHANIC"]
    gap, bw = 10, (WIDTH - 3 * 10) / 4
    for i, label in enumerate(fields):
        x = LEFT + i * (bw + gap)
        text(page, x + 1, y, label, size=8, font=BOLD)
        page.draw_rect(fitz.Rect(x, y + 4, x + bw, y + 40), color=INK, width=1.1)
    y += 54

    # ---- Issue ----
    y = section_bar(page, y, "ISSUE")
    for i in range(3):
        ly = y + 24 + i * 25
        page.draw_line((LEFT, ly), (RIGHT, ly), color=LINE, width=0.7)
    y += 24 + 2 * 25 + 12

    # ---- Service done ----
    y = section_bar(page, y, "SERVICE DONE")
    for i in range(3):
        ly = y + 24 + i * 25
        page.draw_line((LEFT, ly), (RIGHT, ly), color=LINE, width=0.7)
    y += 24 + 2 * 25 + 12

    # ---- Parts ----
    y = section_bar(page, y, "PARTS")
    y = ruled_table(page, y,
                    cols=[52, 280, 100, 100],
                    headers=["QTY", "PART", "PRICE EACH", "TOTAL"],
                    rows=6, row_h=24, money_cols={2, 3})
    y += 10

    # ---- Labor ----
    y = section_bar(page, y, "LABOR")
    y = ruled_table(page, y,
                    cols=[52, 280, 100, 100],
                    headers=["HOURS", "WORK DONE", "RATE", "TOTAL"],
                    rows=3, row_h=24, money_cols={2, 3})
    y += 14

    # ---- Totales (derecha) + firma (izquierda) ----
    tx, lw = 372, 95
    rows = [("PARTS TOTAL", False), ("LABOR TOTAL", False), ("TOTAL", True)]
    ty = y
    for label, is_grand in rows:
        h = 26 if is_grand else 20
        box = fitz.Rect(tx + lw, ty, RIGHT, ty + h)
        page.draw_rect(box, color=INK, width=1.6 if is_grand else 0.9)
        dollar_hint(page, box)
        text(page, tx, ty + (h / 2) + 3.5, label, size=10 if is_grand else 8.5, font=BOLD)
        ty += h

    sig_y = ty - 12
    page.draw_line((LEFT, sig_y), (LEFT + 270, sig_y), color=INK, width=0.9)
    text(page, LEFT, sig_y + 11, "MECHANIC SIGNATURE", size=8, font=BOLD)

    # Nota para la oficina (chiquita, no estorba)
    text(page, LEFT, y + 8,
         "Office: take a photo and drop it into Rigsmith > Work Orders > New (auto-scan).",
         size=7, color=GRAY)

    doc.set_metadata({"title": "Work Order — MDW Yard", "author": "Rigsmith"})
    doc.save(out_path)
    doc.close()
    print(f"OK -> {out_path}")


def desktop_dir() -> Path:
    """Escritorio real del usuario (respeta la redireccion a OneDrive)."""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders") as k:
            raw = winreg.QueryValueEx(k, "Desktop")[0]
        import os
        return Path(os.path.expandvars(raw))
    except OSError:
        return Path.home() / "Desktop"


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else desktop_dir() / "MDW Work Order Form.pdf"
    build(out)
