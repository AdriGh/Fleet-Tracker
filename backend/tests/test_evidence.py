# -*- coding: utf-8 -*-
"""Tests de la evidencia fotográfica en defectos y WOs (v2.14, elemento 01).

`python backend/tests/test_evidence.py`. DB SQLite temporal fresca.

Lo que NO hay que perder:
  - VARIAS fotos por padre conviven (a diferencia de unit_photos, que
    reemplaza) y se listan en orden cronológico;
  - las phases report/before/after se guardan; una desconocida cae a
    'report' (no rompe la subida);
  - parent_unit hace de gate: id inexistente -> None (la ruta responde 404
    ANTES de escribir a disco);
  - counts es bulk (los ids sin fotos vuelven en 0, no desaparecen);
  - la validación rechaza extensión rara / archivo vacío / gigante;
  - db.list_defects expone el id real (la evidencia cuelga de él);
  - las rutas nuevas quedaron registradas en el router.
"""
import datetime
import os
import sys
import tempfile
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

_TMP = Path(tempfile.mkdtemp())
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP / 'evidence_test.db'}"

from app import db                                    # noqa: E402
from app.core import evidence, tenant                 # noqa: E402

tenant.set_current_org(db.default_org_id())

# Los archivos del test van a un uploads temporal, no al real del repo.
evidence.UPLOADS_DIR = _TMP / "uploads"

JPG = b"\xff\xd8\xff\xe0" + b"x" * 128     # bytes con pinta de JPEG alcanzan
PNG = b"\x89PNG\r\n\x1a\n" + b"x" * 64


def _seed_parents() -> tuple[int, int, int]:
    """Un defecto real (con su bloque DVIR), un segundo defecto sin fotos y
    una WO — los padres de los que cuelga la evidencia."""
    with db.SessionLocal() as s:
        blk = db.ReportBlock(
            company="DEMO", date_label="8.14",
            block_date=datetime.date(2026, 8, 14),
            created_at=datetime.datetime.now(), n_reports=2, n_no_dvir=0,
            n_unsafe=1, fleet_safe_pct=90.0, groups_json="[]")
        s.add(blk)
        s.flush()
        d1 = db.Defect(
            block_id=blk.id, company="DEMO",
            block_date=datetime.date(2026, 8, 14), date_label="8.14",
            driver="M. Herrera", unit="412", unit_kind="truck",
            dvir_type="Pre-trip", status="Unsafe",
            detail="Brakes - chamber leaking", mechanic="", mechanic_notes="")
        d2 = db.Defect(
            block_id=blk.id, company="DEMO",
            block_date=datetime.date(2026, 8, 14), date_label="8.14",
            driver="J. Ortiz", unit="305", unit_kind="truck",
            dvir_type="Pre-trip", status="Unsafe",
            detail="Lights - marker out", mechanic="", mechanic_notes="")
        wo = db.WorkOrder(
            created_at=datetime.datetime.now(),
            updated_at=datetime.datetime.now(),
            unit="412", company="DEMO", title="Brake chamber replacement")
        s.add_all([d1, d2, wo])
        s.commit()
        return d1.id, d2.id, wo.id


DEFECT_ID, DEFECT2_ID, WO_ID = _seed_parents()


def test_multiple_photos_coexist():
    r1 = evidence.save_photo("defect", DEFECT_ID, "leak1.jpg", JPG,
                             unit="412")
    r2 = evidence.save_photo("defect", DEFECT_ID, "leak2.jpg", JPG + b"y",
                             note="close-up", unit="412")
    r3 = evidence.save_photo("defect", DEFECT_ID, "leak3.png", PNG,
                             unit="412")
    assert r1["id"] != r2["id"] != r3["id"]
    photos = evidence.list_photos("defect", DEFECT_ID)
    assert len(photos) == 3, "subir NO reemplaza: las tres conviven"
    assert [p["filename"] for p in photos] == \
        ["leak1.jpg", "leak2.jpg", "leak3.png"], "orden cronológico"
    assert photos[1]["note"] == "close-up"
    assert all(p["unit"] == "412" for p in photos)
    files = list(evidence.UPLOADS_DIR.iterdir())
    assert len(files) == 3, "tres archivos en disco, sin pisarse"
    print("OK varias fotos por padre conviven (no reemplaza)")


def test_phases():
    b = evidence.save_photo("wo", WO_ID, "found.jpg", JPG, phase="before",
                            unit="412")
    a = evidence.save_photo("wo", WO_ID, "done.jpg", JPG, phase="after",
                            unit="412")
    weird = evidence.save_photo("wo", WO_ID, "extra.jpg", JPG,
                                phase="b0gus", unit="412")
    assert b["phase"] == "before" and a["phase"] == "after"
    assert weird["phase"] == "report", "fase desconocida cae a 'report'"
    phases = [p["phase"] for p in evidence.list_photos("wo", WO_ID)]
    assert phases == ["before", "after", "report"]
    print("OK phases before/after; desconocida -> report")


def test_parent_gate():
    assert evidence.parent_unit("defect", DEFECT_ID) == "412"
    assert evidence.parent_unit("wo", WO_ID) == "412"
    assert evidence.parent_unit("defect", 99999) is None, \
        "defecto inexistente -> None (la ruta 404ea sin tocar disco)"
    assert evidence.parent_unit("wo", 99999) is None
    try:
        evidence.save_photo("truck", 1, "x.jpg", JPG)
        raise AssertionError("parent inválido debió fallar")
    except ValueError:
        pass
    print("OK gate de padre: unit real / None si no existe / parent inválido")


def test_photo_path_mime():
    photos = evidence.list_photos("defect", DEFECT_ID)
    jpg = next(p for p in photos if p["filename"].endswith(".jpg"))
    png = next(p for p in photos if p["filename"].endswith(".png"))
    path, mime = evidence.photo_path(jpg["id"])
    assert path.is_file() and mime == "image/jpeg"
    path2, mime2 = evidence.photo_path(png["id"])
    assert path2.is_file() and mime2 == "image/png"
    assert evidence.photo_path(99999) is None
    print("OK photo_path: mime por extensión / None si no existe")


def test_counts_bulk():
    got = evidence.counts("defect", [DEFECT_ID, DEFECT2_ID, 99999])
    assert got[DEFECT_ID] == 3
    assert got[DEFECT2_ID] == 0, "sin fotos vuelve en 0, no desaparece"
    assert got[99999] == 0
    assert evidence.counts("defect", []) == {}
    # El conteo separa por parent: la WO tiene 3 fotos pero bajo 'wo'.
    assert evidence.counts("wo", [WO_ID])[WO_ID] == 3
    print(f"OK counts bulk: {got}")


def test_delete():
    photos = evidence.list_photos("defect", DEFECT_ID)
    victim = photos[0]
    path, _mime = evidence.photo_path(victim["id"])
    assert evidence.delete_photo(victim["id"]) is True
    assert not path.is_file(), "el archivo se va con la fila"
    assert len(evidence.list_photos("defect", DEFECT_ID)) == 2
    assert evidence.delete_photo(victim["id"]) is False, "segunda vez: False"
    print("OK borrar: fila + archivo; idempotente en False")


def test_validation():
    for name, data, why in [
        ("virus.exe", JPG, "extensión"),
        ("empty.jpg", b"", "vacío"),
        ("huge.jpg", b"x" * (evidence.MAX_BYTES + 1), "tamaño"),
    ]:
        try:
            evidence.save_photo("defect", DEFECT_ID, name, data)
            raise AssertionError(f"debió rechazar por {why}")
        except ValueError:
            pass
    assert len(evidence.list_photos("defect", DEFECT_ID)) == 2, \
        "los rechazos no dejan filas"
    print("OK validación: extensión / vacío / 12MB")


def test_list_defects_exposes_id():
    rows = db.list_defects(company="DEMO")
    assert rows and all(isinstance(r["id"], int) for r in rows), \
        "la evidencia cuelga del id real de la tabla defect"
    print("OK db.list_defects expone id")


def test_routes_registered():
    # Importa el router real: si un endpoint quedó sin registrar (o el import
    # de core/evidence rompe), esto lo pesca sin levantar el server.
    from app.api.routes import router
    paths = {r.path for r in router.routes}
    for p in [
        "/api/defects/{defect_id}/photos",
        "/api/workorders/{wo_id}/photos",
        "/api/evidence/{photo_id}/file",
        "/api/evidence/{photo_id}",
        "/api/evidence/counts",
    ]:
        assert p in paths, f"ruta no registrada: {p}"
    print("OK rutas de evidencia registradas en el router")


if __name__ == "__main__":
    test_multiple_photos_coexist()
    test_phases()
    test_parent_gate()
    test_photo_path_mime()
    test_counts_bulk()
    test_delete()
    test_validation()
    test_list_defects_exposes_id()
    test_routes_registered()
    print("\nALL EVIDENCE TESTS PASSED")
