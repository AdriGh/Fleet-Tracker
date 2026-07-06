"""partial receiving + backorders: po_line.qty_received/received_at,
purchase_order.received_at/backorder_of_po_id

Revision ID: f1a2b3c4d5e6
Revises: e7b3c9d15a42
Create Date: 2026-07-06 20:00:00.000000

Recepción parcial de POs con backorder auto-generado (fase Purchasing v2.3).
Aditivo con server_default para rellenar filas existentes; batch para
portabilidad (SQLite recrea la tabla, Postgres hace ADD COLUMN directo). El
backfill marca completas las POs ya 'received' para que no se re-reciban.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f1a2b3c4d5e6'
down_revision: Union[str, Sequence[str], None] = 'e7b3c9d15a42'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("po_line") as batch:
        batch.add_column(sa.Column(
            "qty_received", sa.Float(), nullable=False, server_default="0"))
        batch.add_column(sa.Column(
            "received_at", sa.DateTime(), nullable=True))
    with op.batch_alter_table("purchase_order") as batch:
        batch.add_column(sa.Column(
            "received_at", sa.DateTime(), nullable=True))
        # Self-FK como Integer plano (igual que work_order.parent_id): la
        # relación ORM alcanza; evita el lío de FK con nombre en batch/SQLite.
        batch.add_column(sa.Column(
            "backorder_of_po_id", sa.Integer(), nullable=True))
    # Backfill: las POs ya recibidas pasan a completas (qty_received = qty)
    # así la lógica nueva de remaining las ve como cerradas (no re-recibe).
    op.execute(
        "UPDATE po_line SET qty_received = qty WHERE qty_received = 0 "
        "AND po_id IN (SELECT id FROM purchase_order WHERE status = 'received')")


def downgrade() -> None:
    with op.batch_alter_table("purchase_order") as batch:
        batch.drop_column("backorder_of_po_id")
        batch.drop_column("received_at")
    with op.batch_alter_table("po_line") as batch:
        batch.drop_column("received_at")
        batch.drop_column("qty_received")
