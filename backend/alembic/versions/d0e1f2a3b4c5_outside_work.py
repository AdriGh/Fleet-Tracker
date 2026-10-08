"""outside work: work_order.wo_type/vendor_id + vendor.kind/city/state (v2.21)

Revision ID: d0e1f2a3b4c5
Revises: c9d0e1f2a3b4
Create Date: 2026-10-07 12:00:00.000000

Benchmark SquareRigger: las work orders distinguen trabajo INSIDE (taller
propio, mecánico asignado) de trabajo OUTSIDE (taller de terceros = Vendor).
`wo_type` nace 'inside' para todo el historial; `vendor_id` es FK nullable a
vendor (obligatorio solo para outside, lo valida core/workorders). El vendor
gana `kind` (''|parts|shop|both) y city/state para el match del escáner.

Aditivo con server_default para rellenar filas existentes; batch para
portabilidad (SQLite recrea la tabla, Postgres hace ADD COLUMN/CONSTRAINT
directo). Paridad dev: db._migrate() agrega las mismas 5 columnas en SQLite.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd0e1f2a3b4c5'
down_revision: Union[str, Sequence[str], None] = 'c9d0e1f2a3b4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("work_order") as batch:
        batch.add_column(sa.Column(
            "wo_type", sa.String(length=10), nullable=False,
            server_default="inside"))
        batch.add_column(sa.Column(
            "vendor_id", sa.Integer(), nullable=True))
        batch.create_index("ix_work_order_vendor_id", ["vendor_id"])
        batch.create_foreign_key(
            "fk_work_order_vendor", "vendor", ["vendor_id"], ["id"])
    with op.batch_alter_table("vendor") as batch:
        batch.add_column(sa.Column(
            "kind", sa.String(length=12), nullable=False, server_default=""))
        batch.add_column(sa.Column(
            "city", sa.String(length=80), nullable=False, server_default=""))
        batch.add_column(sa.Column(
            "state", sa.String(length=20), nullable=False, server_default=""))


def downgrade() -> None:
    with op.batch_alter_table("vendor") as batch:
        batch.drop_column("state")
        batch.drop_column("city")
        batch.drop_column("kind")
    with op.batch_alter_table("work_order") as batch:
        batch.drop_constraint("fk_work_order_vendor", type_="foreignkey")
        batch.drop_index("ix_work_order_vendor_id")
        batch.drop_column("vendor_id")
        batch.drop_column("wo_type")
