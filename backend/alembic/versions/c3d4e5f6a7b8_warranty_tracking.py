"""warranty tracking: part.warranty_months + warranty_claim table

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-07-06 22:00:00.000000

El moat de warranty tracking (v2.6): las partes con `warranty_months > 0` se
siguen; si la misma parte se reusa en la misma unidad dentro de la ventana de
garantía, se crea un WarrantyClaim. `part.warranty_months` es aditivo (batch +
server_default). `warranty_claim` es una tabla nueva (segura por Alembic; en
dev create_all la crea). org-scoped.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c3d4e5f6a7b8'
down_revision: Union[str, Sequence[str], None] = 'b2c3d4e5f6a7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("part") as batch:
        batch.add_column(sa.Column(
            "warranty_months", sa.Integer(), nullable=False, server_default="0"))
    op.create_table(
        "warranty_claim",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("org_id", sa.Integer(),
                  sa.ForeignKey("organization.id"), nullable=True),
        sa.Column("part_number", sa.String(length=60), nullable=False),
        sa.Column("description", sa.String(length=160), nullable=False,
                  server_default=""),
        sa.Column("unit", sa.String(length=64), nullable=False),
        sa.Column("vendor", sa.String(length=120), nullable=False,
                  server_default=""),
        sa.Column("install_wo", sa.Integer(), nullable=True),
        sa.Column("install_date", sa.String(length=10), nullable=False,
                  server_default=""),
        sa.Column("failure_wo", sa.Integer(), nullable=True),
        sa.Column("failure_date", sa.String(length=10), nullable=False,
                  server_default=""),
        sa.Column("warranty_until", sa.String(length=10), nullable=False,
                  server_default=""),
        sa.Column("amount", sa.Float(), nullable=False, server_default="0"),
        sa.Column("ref", sa.String(length=80), nullable=False,
                  server_default=""),
        sa.Column("status", sa.String(length=12), nullable=False,
                  server_default="open"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_warranty_claim_org_id", "warranty_claim", ["org_id"])
    op.create_index("ix_warranty_claim_part_number", "warranty_claim",
                    ["part_number"])
    op.create_index("ix_warranty_claim_unit", "warranty_claim", ["unit"])
    op.create_index("ix_warranty_claim_ref", "warranty_claim", ["ref"])
    op.create_index("ix_warranty_claim_status", "warranty_claim", ["status"])


def downgrade() -> None:
    op.drop_index("ix_warranty_claim_status", table_name="warranty_claim")
    op.drop_index("ix_warranty_claim_ref", table_name="warranty_claim")
    op.drop_index("ix_warranty_claim_unit", table_name="warranty_claim")
    op.drop_index("ix_warranty_claim_part_number", table_name="warranty_claim")
    op.drop_index("ix_warranty_claim_org_id", table_name="warranty_claim")
    op.drop_table("warranty_claim")
    with op.batch_alter_table("part") as batch:
        batch.drop_column("warranty_months")
