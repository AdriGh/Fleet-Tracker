"""parts rich fields: manufacturer, bin, max_qty, avg_cost, upc, fits, source

Revision ID: c4f7a9e12b8d
Revises: df63703c9a5b
Create Date: 2026-07-06 12:00:00.000000

Campos ricos del catálogo de partes (fase Parts). Todos ADITIVOS con
server_default para rellenar las filas existentes; nullable=False. batch para
portabilidad: en SQLite recrea la tabla, en Postgres hace ADD COLUMN directo
(rápido, sin reescribir en PG 11+). No choca con datos existentes.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c4f7a9e12b8d'
down_revision: Union[str, Sequence[str], None] = 'df63703c9a5b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (nombre, tipo, server_default)
_COLS: list[tuple[str, sa.types.TypeEngine, str]] = [
    ("manufacturer", sa.String(80), ""),
    ("bin", sa.String(40), ""),
    ("max_qty", sa.Float(), "0"),
    ("avg_cost", sa.Float(), "0"),
    ("upc", sa.String(40), ""),
    ("fits", sa.String(200), ""),
    ("source", sa.String(30), "manual"),
]


def upgrade() -> None:
    with op.batch_alter_table("part") as batch:
        for name, type_, default in _COLS:
            batch.add_column(sa.Column(
                name, type_, nullable=False, server_default=default))


def downgrade() -> None:
    with op.batch_alter_table("part") as batch:
        for name, _type, _default in reversed(_COLS):
            batch.drop_column(name)
