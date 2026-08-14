"""driver workflows: tablas workflow + workflow_step (v2.15)

Revision ID: a7b8c9d0e1f2
Revises: e5f6a7b8c9d0
Create Date: 2026-08-14 12:00:00.000000

Elemento 03 del board de diseño (el moat): el manager arma el pre-trip de
SU flota con pasos tipados (check|photo|read|sign), obligatoriedad y orden.
UN workflow activo por org; el walkaround móvil (v2.16) consume el activo.
Padre+hijas sin FK entre sí: los pasos se reemplazan en bloque por
workflow_id. org-scoped.
"""
# NOTA integración: re-apuntar down_revision a f6a7b8c9d0e1 (v2.14 evidence) al mergear — dos features paralelas revisan el mismo head.
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a7b8c9d0e1f2'
# Integrado tras v2.14 (evidence): la cadena queda e5..(unit_photo) ->
# f6..(evidence) -> a7..(workflows), lineal como siempre.
down_revision: Union[str, Sequence[str], None] = 'f6a7b8c9d0e1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "workflow",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("org_id", sa.Integer(),
                  sa.ForeignKey("organization.id"), nullable=True),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False,
                  server_default=sa.false()),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_workflow_org_id", "workflow", ["org_id"])
    op.create_table(
        "workflow_step",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("org_id", sa.Integer(),
                  sa.ForeignKey("organization.id"), nullable=True),
        sa.Column("workflow_id", sa.Integer(), nullable=False),
        sa.Column("pos", sa.Integer(), nullable=False),
        sa.Column("type", sa.String(length=8), nullable=False),
        sa.Column("label", sa.String(length=120), nullable=False),
        sa.Column("required", sa.Boolean(), nullable=False,
                  server_default=sa.false()),
    )
    op.create_index("ix_workflow_step_org_id", "workflow_step", ["org_id"])
    op.create_index("ix_workflow_step_workflow_id", "workflow_step",
                    ["workflow_id"])


def downgrade() -> None:
    op.drop_index("ix_workflow_step_workflow_id", table_name="workflow_step")
    op.drop_index("ix_workflow_step_org_id", table_name="workflow_step")
    op.drop_table("workflow_step")
    op.drop_index("ix_workflow_org_id", table_name="workflow")
    op.drop_table("workflow")
