"""walkaround: tablas walkaround + walkaround_step; defect.block_id nullable + source

Revision ID: b8c9d0e1f2a3
Revises: a7b8c9d0e1f2
Create Date: 2026-08-14 12:00:00.000000

Elemento 02 del board (v2.16): la corrida del pre-trip en el teléfono del
driver. Los pasos son snapshot del workflow activo; al submit se materializan
defectos (source 'walkaround', SIN bloque DVIR — por eso block_id pasa a
nullable), odómetro y firma. En SQLite dev el cambio de nullabilidad lo hace
el rebuild de db._migrate; acá el modo batch de env.py hace lo equivalente.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b8c9d0e1f2a3'
down_revision: Union[str, Sequence[str], None] = 'a7b8c9d0e1f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("defect") as batch:
        batch.alter_column("block_id", existing_type=sa.Integer(),
                           nullable=True)
        batch.add_column(sa.Column("source", sa.String(length=12),
                                   nullable=False, server_default="dvir"))

    op.create_table(
        "walkaround",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("org_id", sa.Integer(),
                  sa.ForeignKey("organization.id"), nullable=True),
        sa.Column("unit", sa.String(length=64), nullable=False),
        sa.Column("driver", sa.String(length=128), nullable=False),
        sa.Column("company", sa.String(length=64), nullable=False,
                  server_default=""),
        sa.Column("workflow_id", sa.Integer(), nullable=False),
        sa.Column("workflow_name", sa.String(length=80), nullable=False),
        sa.Column("status", sa.String(length=12), nullable=False,
                  server_default="in_progress"),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("submitted_at", sa.DateTime(), nullable=True),
        sa.Column("defects_created", sa.Integer(), nullable=False,
                  server_default="0"),
    )
    op.create_index("ix_walkaround_org_id", "walkaround", ["org_id"])
    op.create_index("ix_walkaround_unit", "walkaround", ["unit"])

    op.create_table(
        "walkaround_step",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("org_id", sa.Integer(),
                  sa.ForeignKey("organization.id"), nullable=True),
        sa.Column("walkaround_id", sa.Integer(), nullable=False),
        sa.Column("pos", sa.Integer(), nullable=False),
        sa.Column("type", sa.String(length=8), nullable=False),
        sa.Column("label", sa.String(length=120), nullable=False),
        sa.Column("required", sa.Boolean(), nullable=False,
                  server_default=sa.text("0")),
        sa.Column("verdict", sa.String(length=8), nullable=False,
                  server_default=""),
        sa.Column("value", sa.String(length=40), nullable=False,
                  server_default=""),
        sa.Column("note", sa.String(length=300), nullable=False,
                  server_default=""),
    )
    op.create_index("ix_walkaround_step_org_id", "walkaround_step",
                    ["org_id"])
    op.create_index("ix_walkaround_step_walkaround_id", "walkaround_step",
                    ["walkaround_id"])


def downgrade() -> None:
    op.drop_index("ix_walkaround_step_walkaround_id",
                  table_name="walkaround_step")
    op.drop_index("ix_walkaround_step_org_id", table_name="walkaround_step")
    op.drop_table("walkaround_step")
    op.drop_index("ix_walkaround_unit", table_name="walkaround")
    op.drop_index("ix_walkaround_org_id", table_name="walkaround")
    op.drop_table("walkaround")
    with op.batch_alter_table("defect") as batch:
        batch.drop_column("source")
        batch.alter_column("block_id", existing_type=sa.Integer(),
                           nullable=False)
