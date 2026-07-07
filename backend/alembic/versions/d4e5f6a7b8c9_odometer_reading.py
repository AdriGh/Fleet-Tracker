"""odometer reading: odometer_reading table (CPM enabler)

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-07-07 12:00:00.000000

Habilitador del cost-per-mile (v2.8): serie temporal del odómetro por unidad
para computar millas manejadas en un período (odo_fin − odo_inicio). Se llena
por backfill de WorkOrder/MaintRecord.mileage + snapshot diario de Samsara.
Tabla nueva (segura por Alembic; en dev create_all la crea). Idempotente por
(org, unit, date, source). org-scoped.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd4e5f6a7b8c9'
down_revision: Union[str, Sequence[str], None] = 'c3d4e5f6a7b8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "odometer_reading",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("org_id", sa.Integer(),
                  sa.ForeignKey("organization.id"), nullable=True),
        sa.Column("unit", sa.String(length=64), nullable=False),
        sa.Column("date", sa.String(length=10), nullable=False),
        sa.Column("miles", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False,
                  server_default="samsara"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("org_id", "unit", "date", "source",
                            name="uq_odo_org_unit_date_source"),
    )
    op.create_index("ix_odometer_reading_org_id", "odometer_reading", ["org_id"])
    op.create_index("ix_odometer_reading_unit", "odometer_reading", ["unit"])
    op.create_index("ix_odometer_reading_date", "odometer_reading", ["date"])


def downgrade() -> None:
    op.drop_index("ix_odometer_reading_date", table_name="odometer_reading")
    op.drop_index("ix_odometer_reading_unit", table_name="odometer_reading")
    op.drop_index("ix_odometer_reading_org_id", table_name="odometer_reading")
    op.drop_table("odometer_reading")
