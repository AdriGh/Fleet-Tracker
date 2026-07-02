# -*- coding: utf-8 -*-
"""Genera el .ico multi-resolución de Rigsmith desde el favicon oficial.

Desde el rebrand (jul-2026) la marca NO se dibuja acá: la fuente de verdad es
frontend/public/favicon.png (tile Rigsmith exportado del design system, mismo
arte que favicon.svg y Logo.tsx). Este script solo lo convierte a .ico por si
algún empaquetado (instalador, acceso directo de Windows) lo pide — la web app
usa favicon.svg directamente y NO referencia el .ico.

Uso:  py backend/scripts/make_icon.py
Salida: frontend/public/favicon.ico
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SRC_PNG = ROOT / "frontend" / "public" / "favicon.png"
OUT_ICO = ROOT / "frontend" / "public" / "favicon.ico"

SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def main() -> None:
    img = Image.open(SRC_PNG).convert("RGBA")
    img.save(OUT_ICO, format="ICO", sizes=SIZES)
    print(f"OK -> {OUT_ICO} ({', '.join(f'{w}x{h}' for w, h in SIZES)})")


if __name__ == "__main__":
    main()
