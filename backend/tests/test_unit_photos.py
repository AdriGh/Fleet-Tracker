# -*- coding: utf-8 -*-
"""Tests de la foto de identidad por unidad (v2.13, elemento 05) + setup-status.

`python backend/tests/test_unit_photos.py`. DB SQLite temporal fresca.

Lo que NO hay que perder:
  - subir de nuevo REEMPLAZA (una foto por unidad, sin huérfanos en disco);
  - el fallback demo solo aplica en modo demo y una foto real siempre gana;
  - units_with_photo lista subidas + demo sin duplicar;
  - la validación rechaza extensión rara / archivo vacío / gigante;
  - setup_status marca los pasos solo cuando el dato EXISTE.
"""
import os
import sys
import tempfile
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

_TMP = Path(tempfile.mkdtemp())
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP / 'photos_test.db'}"
os.environ["FLEET_DEMO"] = "1"          # activa el fallback demo

from app import db                                    # noqa: E402
from app.core import setup_status, tenant, unit_photos  # noqa: E402

tenant.set_current_org(db.default_org_id())

# Los archivos del test van a un uploads temporal, no al real del repo.
unit_photos.UPLOADS_DIR = _TMP / "uploads"

JPG = b"\xff\xd8\xff\xe0" + b"x" * 128     # bytes con pinta de JPEG alcanzan


def test_upload_replaces():
    r1 = unit_photos.save_photo("412", "front.jpg", JPG)
    assert r1["unit"] == "412" and r1["source"] == "uploaded"
    first = list(unit_photos.UPLOADS_DIR.iterdir())
    assert len(first) == 1

    r2 = unit_photos.save_photo("412", "better.jpg", JPG + b"y")
    files = list(unit_photos.UPLOADS_DIR.iterdir())
    assert len(files) == 1, "reemplazar no debe dejar huérfanos"
    assert r2["filename"] == "better.jpg"

    path, mime = unit_photos.photo_path("412")
    assert path.is_file() and mime == "image/jpeg"
    print("OK subir reemplaza sin huérfanos")


def test_validation():
    for name, data, why in [
        ("virus.exe", JPG, "extensión"),
        ("empty.jpg", b"", "vacío"),
        ("huge.jpg", b"x" * (unit_photos.MAX_BYTES + 1), "tamaño"),
    ]:
        try:
            unit_photos.save_photo("999", name, data)
            raise AssertionError(f"debió rechazar por {why}")
        except ValueError:
            pass
    assert unit_photos.photo_path("999") is None
    print("OK validación: extensión / vacío / 12MB")


def test_demo_fallback():
    # 418 es demo-mapeada y NO tiene foto subida -> asset demo.
    found = unit_photos.photo_path("418")
    assert found is not None, "fallback demo debe responder"
    path, _mime = found
    assert "demo_unit_photos" in str(path)

    # Al subir una real, la real gana.
    unit_photos.save_photo("418", "real.jpg", JPG)
    path2, _ = unit_photos.photo_path("418")
    assert "demo_unit_photos" not in str(path2), "la foto real gana al demo"

    # Y al borrarla, reaparece el fallback (no es data del tenant).
    assert unit_photos.delete_photo("418") is True
    path3, _ = unit_photos.photo_path("418")
    assert "demo_unit_photos" in str(path3)
    print("OK fallback demo: aparece, pierde contra real, reaparece al borrar")


def test_index():
    units = unit_photos.units_with_photo()
    assert "412" in units, "subida real en el índice"
    assert "418" in units and "311" in units and "53108" in units, \
        "demo-mapeadas en el índice"
    assert len(units) == len(set(units)), "sin duplicados"
    # v2.16.1: cobertura completa — TODA unidad demo mapeada tiene su asset
    # en disco (un mapeo a archivo inexistente sería una tarjeta vacía).
    missing = [u for u in unit_photos._DEMO_PHOTOS if u not in units]
    assert not missing, f"mapeadas sin asset en disco: {missing}"
    print(f"OK índice: {len(units)} unidades con foto (cobertura completa)")


def test_setup_status():
    st = setup_status.setup_status()
    keys = [s["key"] for s in st["steps"]]
    assert keys == ["fleet", "eld", "dvir", "wo", "pm", "odometer", "drivers",
                    "workflow"]
    by = {s["key"]: s for s in st["steps"]}
    # En esta DB fresca no hay DVIRs ni WOs: esos pasos NO pueden estar hechos.
    assert by["dvir"]["done"] is False
    assert by["wo"]["done"] is False
    # Demo: flota y ELD cuentan como resueltos (la demo muestra el producto).
    assert by["fleet"]["done"] is True
    assert by["eld"]["done"] is True
    assert st["done"] == sum(1 for s in st["steps"] if s["done"])
    assert all(s["section"] for s in st["steps"]), "cada paso navega a algún lado"
    print(f"OK setup-status: {st['done']}/{st['total']} en DB fresca demo")


if __name__ == "__main__":
    test_upload_replaces()
    test_validation()
    test_demo_fallback()
    test_index()
    test_setup_status()
    print("\nALL UNIT PHOTO TESTS PASSED")
