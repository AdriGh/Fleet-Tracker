"""SEC-4 user token_version

Revision ID: df63703c9a5b
Revises: 1048cd72c14a
Create Date: 2026-06-23 01:03:15.312718

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'df63703c9a5b'
down_revision: Union[str, Sequence[str], None] = '1048cd72c14a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """SEC-4: agrega user.token_version (revocación de tokens).

    server_default='0' rellena las filas existentes; nullable=False. batch para
    portabilidad: en SQLite recrea la tabla, en Postgres hace ADD COLUMN directo
    (rápido, sin reescribir la tabla en PG 11+). Agregar columna no choca con
    datos existentes, así que no hace falta chequear duplicados antes."""
    with op.batch_alter_table("user") as batch:
        batch.add_column(sa.Column(
            "token_version", sa.Integer(), nullable=False,
            server_default="0"))


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("user") as batch:
        batch.drop_column("token_version")
