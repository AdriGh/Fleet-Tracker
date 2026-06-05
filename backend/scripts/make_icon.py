# -*- coding: utf-8 -*-
"""Genera el ícono de Fleet Tracker (.ico multi-resolución + PNG de preview).

Squircle con gradiente índigo→violeta→cyan, una ruta de rastreo blanca y un
pin de ubicación con punto cyan. Estilo coherente con el logo animado de la app.

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

C0 = (0x63, 0x66, 0xF1)   # indigo
C1 = (0x8B, 0x5C, 0xF6)   # violeta
C2 = (0x22, 0xD3, 0xEE)   # cyan
WHITE = (255, 255, 255)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def bezier(p0, p1, p2, p3, n=80):
    pts = []
    for i in range(n + 1):
        t = i / n
        m = 1 - t
        x = (m**3 * p0[0] + 3 * m * m * t * p1[0]
             + 3 * m * t * t * p2[0] + t**3 * p3[0])
        y = (m**3 * p0[1] + 3 * m * m * t * p1[1]
             + 3 * m * t * t * p2[1] + t**3 * p3[1])
        pts.append((x * k, y * k))
    return pts


# --- fondo con gradiente diagonal (3 stops) ---------------------------------
g = Image.new("RGB", (BASE, BASE))
gp = g.load()
for y in range(BASE):
    for x in range(BASE):
        t = (x + y) / (2 * (BASE - 1))
        gp[x, y] = lerp(C0, C1, t / 0.5) if t < 0.5 else lerp(C1, C2, (t - 0.5) / 0.5)
g = g.resize((R, R), Image.LANCZOS).convert("RGBA")

# máscara squircle
mask = Image.new("L", (R, R), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, R - 1, R - 1], radius=58 * k, fill=255)
img = Image.new("RGBA", (R, R), (0, 0, 0, 0))
img.paste(g, (0, 0), mask)

d = ImageDraw.Draw(img)

# --- ruta de rastreo (trazo suave por estampado de círculos) ----------------
route = bezier((46, 182), (98, 104), (148, 196), (192, 108), n=240)
br = 11 * k                # radio del pincel -> ancho ~22
for x, y in route:
    d.ellipse([x - br, y - br, x + br, y + br], fill=WHITE)
# nodo de inicio (anillo blanco con centro índigo)
sx, sy = route[0]
d.ellipse([sx - 16 * k, sy - 16 * k, sx + 16 * k, sy + 16 * k], fill=WHITE)
d.ellipse([sx - 7 * k, sy - 7 * k, sx + 7 * k, sy + 7 * k], fill=C0)

# --- pin de ubicación al final ----------------------------------------------
cx, cy, r = 194 * k, 76 * k, 29 * k
tip = (194 * k, 124 * k)
# anillo de radar (sutil)
ring = r * 1.5
d.ellipse([cx - ring, cy - ring, cx + ring, cy + ring],
          outline=(255, 255, 255, 110), width=int(3 * k))
# teardrop = balón + triángulo
d.polygon([(cx - r * 0.84, cy + r * 0.52), (cx + r * 0.84, cy + r * 0.52), tip],
          fill=WHITE)
d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=WHITE)
# punto cyan (centro del pin)
d.ellipse([cx - r * 0.42, cy - r * 0.42, cx + r * 0.42, cy + r * 0.42], fill=C2)

# --- downscale + exportar ---------------------------------------------------
icon = img.resize((BASE, BASE), Image.LANCZOS)
icon.save(OUT_PNG)
OUT_ICO.parent.mkdir(parents=True, exist_ok=True)
icon.save(OUT_ICO, sizes=[(16, 16), (32, 32), (48, 48),
                          (64, 64), (128, 128), (256, 256)])
print("PNG:", OUT_PNG)
print("ICO:", OUT_ICO)
