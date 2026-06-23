# -*- coding: utf-8 -*-
"""Bootstrap de migraciones (OPS-2, ver docs/AUDITORIA.md).

Reemplaza el `create_all` de arranque en el CONTENEDOR por un flujo Alembic
seguro que además ADOPTA una base existente creada con create_all (la del
piloto, que nunca corrió Alembic) sin recrear nada:

- Base FRESCA (sin tablas)               -> upgrade head  (crea todo desde el baseline)
- Base EXISTENTE sin `alembic_version`   -> stamp head    (ADOPTA: marca versión, SIN DDL)
                                            + upgrade head (no-op)
- Base ya migrada (con `alembic_version`)-> upgrade head  (aplica deltas pendientes)

`stamp head` NO ejecuta DDL: solo inserta la versión en `alembic_version`. Por
eso adoptar la base de prod es SEGURO (no toca el esquema). Tras migrar siembra
la org 'default'. Se importa app.db con FLEET_SKIP_DB_INIT=1 para no disparar el
create_all/seed legacy de arranque.
"""
import os
import sys
from pathlib import Path

# backend/ al sys.path: al correr `python scripts/db_migrate.py`, sys.path[0]
# es scripts/, no backend/, así que `app` no sería importable sin esto.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["FLEET_SKIP_DB_INIT"] = "1"

from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from sqlalchemy import inspect  # noqa: E402

from app.db import _engine, ensure_default_org  # noqa: E402

_ALEMBIC_INI = Path(__file__).resolve().parents[1] / "alembic.ini"


def main() -> None:
    cfg = Config(str(_ALEMBIC_INI))
    tables = set(inspect(_engine).get_table_names())
    if "alembic_version" not in tables and "organization" in tables:
        # Base existente (create_all, nunca migrada): adoptar el baseline
        # marcando la versión SIN re-crear nada.
        print("db_migrate: base existente sin historial -> alembic stamp head")
        command.stamp(cfg, "head")
    print("db_migrate: alembic upgrade head")
    command.upgrade(cfg, "head")
    ensure_default_org()
    print("db_migrate: OK")


if __name__ == "__main__":
    main()
