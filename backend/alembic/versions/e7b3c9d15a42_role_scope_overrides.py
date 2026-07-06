"""role_scope: override por-org de la matriz RBAC (Increment 5b)

Revision ID: e7b3c9d15a42
Revises: c4f7a9e12b8d
Create Date: 2026-07-06 13:00:00.000000

Tabla NUEVA para permitir que cada organización edite su matriz de permisos
(rol → scopes) sin tocar los defaults hardcodeados. org-scoped. Crear una
tabla nueva es seguro por Alembic (el deploy corre `alembic upgrade head`;
en dev, create_all también la crea porque es una tabla faltante).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e7b3c9d15a42'
down_revision: Union[str, Sequence[str], None] = 'c4f7a9e12b8d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "role_scope",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("org_id", sa.Integer(),
                  sa.ForeignKey("organization.id"), nullable=True),
        sa.Column("role", sa.String(length=30), nullable=False),
        sa.Column("scope", sa.String(length=30), nullable=False),
    )
    op.create_index("ix_role_scope_org_id", "role_scope", ["org_id"])
    op.create_index("ix_role_scope_role", "role_scope", ["role"])


def downgrade() -> None:
    op.drop_index("ix_role_scope_role", table_name="role_scope")
    op.drop_index("ix_role_scope_org_id", table_name="role_scope")
    op.drop_table("role_scope")
