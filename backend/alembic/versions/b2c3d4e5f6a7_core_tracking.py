"""core tracking: part.core_charge + core_item table

Revision ID: b2c3d4e5f6a7
Revises: f1a2b3c4d5e6
Create Date: 2026-07-06 21:00:00.000000

El moat de core tracking (v2.5): las partes con `core_charge > 0` llevan un
depósito reembolsable; al recibir una PO de esas partes se crea un CoreItem
(core pendiente de devolver). `part.core_charge` es aditivo (batch +
server_default). `core_item` es una tabla nueva (segura por Alembic; en dev
create_all la crea). org-scoped.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b2c3d4e5f6a7'
down_revision: Union[str, Sequence[str], None] = 'f1a2b3c4d5e6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("part") as batch:
        batch.add_column(sa.Column(
            "core_charge", sa.Float(), nullable=False, server_default="0"))
    op.create_table(
        "core_item",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("org_id", sa.Integer(),
                  sa.ForeignKey("organization.id"), nullable=True),
        sa.Column("part_number", sa.String(length=60), nullable=False),
        sa.Column("description", sa.String(length=160), nullable=False,
                  server_default=""),
        sa.Column("vendor", sa.String(length=120), nullable=False,
                  server_default=""),
        sa.Column("core_charge", sa.Float(), nullable=False, server_default="0"),
        sa.Column("qty", sa.Float(), nullable=False, server_default="1"),
        sa.Column("po_id", sa.Integer(), nullable=True),
        sa.Column("ref", sa.String(length=60), nullable=False,
                  server_default=""),
        sa.Column("status", sa.String(length=12), nullable=False,
                  server_default="pending"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("returned_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_core_item_org_id", "core_item", ["org_id"])
    op.create_index("ix_core_item_part_number", "core_item", ["part_number"])
    op.create_index("ix_core_item_ref", "core_item", ["ref"])
    op.create_index("ix_core_item_status", "core_item", ["status"])


def downgrade() -> None:
    op.drop_index("ix_core_item_status", table_name="core_item")
    op.drop_index("ix_core_item_ref", table_name="core_item")
    op.drop_index("ix_core_item_part_number", table_name="core_item")
    op.drop_index("ix_core_item_org_id", table_name="core_item")
    op.drop_table("core_item")
    with op.batch_alter_table("part") as batch:
        batch.drop_column("core_charge")
