"""Entorno de Alembic para Fleet Tracker (H6 fase 2).

Usa la MISMA selección de motor que la app: la URL sale de `app.config`
(env `DATABASE_URL` → Postgres en producción; SQLite local en dev). La
metadata objetivo es `app.db.Base.metadata`, así `--autogenerate` detecta
los cambios de los modelos. Se importa la app con `FLEET_SKIP_DB_INIT=1`
para que importar `app.db` NO dispare el create_all/seed de arranque (acá
solo queremos la metadata, no tocar la base).
"""

import os
import sys
from logging.config import fileConfig
from pathlib import Path

from sqlalchemy import create_engine, pool

from alembic import context

# backend/ al path para poder importar el paquete `app`.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
# Importar los modelos solo por su metadata, sin inicializar el esquema.
os.environ.setdefault("FLEET_SKIP_DB_INIT", "1")

from app.config import DATABASE_URL  # noqa: E402
from app.db import Base  # noqa: E402

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# La URL la maneja env.py DIRECTO (no via config.set_main_option/.ini): el
# ConfigParser de Alembic interpola '%' y la password viene URL-encoded (p.ej.
# '%40' por '@', del fix v1.28.2) -> rompía con "invalid interpolation syntax".
# Se pasa DATABASE_URL crudo a create_engine (online) y a context.configure
# (offline); SQLAlchemy decodifica el %40 correctamente.
target_metadata = Base.metadata

# SQLite no soporta la mayoría de los ALTER: el modo batch recrea la tabla.
_IS_SQLITE = DATABASE_URL.startswith("sqlite")


def run_migrations_offline() -> None:
    context.configure(
        url=DATABASE_URL,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=_IS_SQLITE,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = create_engine(DATABASE_URL, poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=_IS_SQLITE,
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
