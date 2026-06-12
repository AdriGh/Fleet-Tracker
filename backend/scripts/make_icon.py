# -*- coding: utf-8 -*-
"""Genera el ícono de Fleet Tracker (.ico multi-resolución + PNG de preview).

Badge squircle con gradiente rojo (la marca actual de Logo.tsx): flecha de
navegación blanca (heading) + nodo de ruta. Mantener en sync con
frontend/src/components/Logo.tsx y frontend/public/favicon.svg.

Uso:  py backend/scripts/make_icon.py
Salida: frontend/public/fleet-tracker.ico  y  un PNG de preview en %TEMP%.
"""
import os
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
OUT_ICO = ROOT / "frontend" / "public" / "fleet-tracker.ico"
OUT_PNG = Path(os.environ.get("TEMP", ".")) / "fleet-tracker-preview.png"

BASE = 256
S = 4                      # supersampling
R = BASE * S              # render size
k = S                     # 256-space -> render-space factor

C0 = (0xFF, 0x4D, 0x3D)   # rojo claro
C1 = (0xE1, 0x19, 0x00)   # rojo marca
C2 = (0xB7, 0x14, 0x00)   # rojo oscuro
WHITE = (255, 255, 255)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


# --- fondo con gradiente diagonal (3 stops, 0 / 0.55 / 1) -------------------
g = Image.new("RGB", (BASE, BASE))
gp = g.load()
for y in range(BASE):
    for x in range(BASE):
        t = (x + y) / (2 * (BASE - 1))
        gp[x, y] = (lerp(C0, C1, t / 0.55) if t < 0.55
                    else lerp(C1, C2, (t - 0.55) / 0.45))
g = g.resize((R, R), Image.LANCZOS).convert("RGBA")

# máscara squircle (12..244 en espacio 256, rx 72 — igual que favicon.svg)
mask = Image.new("L", (R, R), 0)
ImageDraw.Draw(mask).rounded_rectangle(
    [12 * k, 12 * k, 244 * k - 1, 244 * k - 1], radius=72 * k, fill=255)
img = Image.new("RGBA", (R, R), (0, 0, 0, 0))
img.paste(g, (0, 0), mask)

d = ImageDraw.Draw(img)

# --- flecha de navegación (heading), misma geometría que Logo.tsx ×4 --------
arrow = [(128, 60), (180, 184), (172, 190.8), (128, 164),
         (84, 190.8), (76, 184)]
d.polygon([(x * k, y * k) for x, y in arrow], fill=WHITE)

# --- nodo de ruta ------------------------------------------------------------
nx, ny, nr = 128 * k, 202 * k, 9.6 * k
d.ellipse([nx - nr, ny - nr, nx + nr, ny + nr],
          fill=(255, 255, 255, 140))

# --- downscale + exportar ----------------------------------------------------
icon = img.resize((BASE, BASE), Image.LANCZOS)
icon.save(OUT_PNG)
OUT_ICO.parent.mkdir(parents=True, exist_ok=True)
icon.save(OUT_ICO, sizes=[(16, 16), (32, 32), (48, 48),
                          (64, 64), (128, 128), (256, 256)])
print("PNG:", OUT_PNG)
print("ICO:", OUT_ICO)
