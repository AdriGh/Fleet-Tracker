"""parts_request backfill: tabla parts_request + ix_purchase_order_backorder_of_po_id

Revision ID: e1f2a3b4c5d6
Revises: d0e1f2a3b4c5
Create Date: 2026-10-07 12:30:00.000000

Cierra un HUECO de migraciones (riesgo de producción): la tabla
`parts_request` (fase Purchasing, cola de pedidos de partes) y el índice
`ix_purchase_order_backorder_of_po_id` (v2.3) existían solo en los modelos
(create_all las creaba en dev SQLite) pero NINGUNA revisión Alembic las
creaba. Una Postgres migrada solo con `alembic upgrade head` no las tenía.

IDEMPOTENTE a propósito: inspecciona la base y crea la tabla / el índice
SOLO si faltan. Así corre igual sobre una base que ya los tiene (porque
nació con create_all y se adoptó con `stamp head`) y sobre una que no. El
downgrade es no-op: nunca se tira data por deshacer este backfill.
"""
from typing import Sequence, Union

from alembic import context, op
import sqlalchemy as sa


revision: str = 'e1f2a3b4c5d6'
down_revision: Union[str, Sequence[str], None] = 'd0e1f2a3b4c5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Índices de parts_request (los comparten el camino online y el offline).
_PARTS_REQUEST_INDEXES = (("ix_parts_request_org_id", "org_id"),
                          ("ix_parts_request_part_number", "part_number"),
                          ("ix_parts_request_status", "status"),
                          ("ix_parts_request_vendor", "vendor"))


def _parts_request_columns() -> list:
    """Columnas/constraints de parts_request tal como las renderiza
    autogenerate del modelo PartsRequest de app/db.py."""
    return [
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("part_number", sa.String(length=60), nullable=False,
                  server_default=""),
        sa.Column("description", sa.String(length=160), nullable=False,
                  server_default=""),
        sa.Column("qty", sa.Float(), nullable=False, server_default="1"),
        sa.Column("unit_cost", sa.Float(), nullable=False,
                  server_default="0"),
        sa.Column("vendor", sa.String(length=120), nullable=False,
                  server_default=""),
        sa.Column("source", sa.String(length=20), nullable=False,
                  server_default="manual"),
        sa.Column("source_ref", sa.String(length=60), nullable=False,
                  server_default=""),
        sa.Column("requested_by", sa.String(length=60), nullable=False,
                  server_default=""),
        sa.Column("status", sa.String(length=12), nullable=False,
                  server_default="pending"),
        sa.Column("po_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("org_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["org_id"], ["organization.id"]),
        sa.ForeignKeyConstraint(["po_id"], ["purchase_order.id"]),
        sa.PrimaryKeyConstraint("id"),
    ]


def upgrade() -> None:
    if context.is_offline_mode():
        # `alembic upgrade --sql` no tiene conexión que inspeccionar: se
        # emite el DDL con IF NOT EXISTS (Postgres y SQLite lo soportan),
        # misma semántica idempotente que el camino online de abajo.
        op.create_table("parts_request", *_parts_request_columns(),
                        if_not_exists=True)
        for name, col in _PARTS_REQUEST_INDEXES:
            op.create_index(name, "parts_request", [col], unique=False,
                            if_not_exists=True)
        op.create_index("ix_purchase_order_backorder_of_po_id",
                        "purchase_order", ["backorder_of_po_id"],
                        unique=False, if_not_exists=True)
        return

    bind = op.get_bind()
    insp = sa.inspect(bind)
    tables = set(insp.get_table_names())

    if "parts_request" not in tables:
        # Espeja EXACTAMENTE el modelo PartsRequest de app/db.py (incl. org_id
        # FK + los 4 índices), tal como lo renderiza autogenerate.
        op.create_table("parts_request", *_parts_request_columns())
        for name, col in _PARTS_REQUEST_INDEXES:
            op.create_index(name, "parts_request", [col], unique=False)
    else:
        # La tabla ya existe (create_all): completar índices que falten.
        have = {i["name"] for i in insp.get_indexes("parts_request")}
        for name, col in _PARTS_REQUEST_INDEXES:
            if name not in have:
                op.create_index(name, "parts_request", [col], unique=False)

    if "purchase_order" in tables:
        po_idx = {i["name"] for i in insp.get_indexes("purchase_order")}
        if "ix_purchase_order_backorder_of_po_id" not in po_idx:
            op.create_index("ix_purchase_order_backorder_of_po_id",
                            "purchase_order", ["backorder_of_po_id"],
                            unique=False)


def downgrade() -> None:
    # No-op a propósito: este backfill solo completa lo que faltaba; deshacerlo
    # tiraría la cola de pedidos de partes de producción.
    pass
