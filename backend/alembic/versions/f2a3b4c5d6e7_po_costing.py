"""po costing: POs editables post-recepción + ajustes + auditoría (v2.22)

Revision ID: f2a3b4c5d6e7
Revises: e1f2a3b4c5d6
Create Date: 2026-10-09 10:00:00.000000

Benchmark SquareRigger: SR obliga a reabrir una PO recibida para corregir un
costo. Acá la PO sigue editable (costo unitario, qty, ajustes) a cualquier
status sin corromper el inventario:
  - purchase_order: fin_status (open|closed, ciclo financiero aparte del de
    recepción), closed_at, invoice_no/date, tracking_no, payment_method,
    vendor_id (FK nullable a vendor; se resuelve por nombre al crear).
  - po_line: taxable, landed_unit_cost (unit_cost + ajustes prorrateados).
  - part: last_cost (avg_cost pasa a ser promedio ponderado móvil real).
  - part_stock_movement: unit_cost, value_delta, actor (valor del libro).
  - tablas nuevas po_adjustment (descuento/crédito/flete/tax/fee/pago,
    anulables) y audit_event (rastro genérico entity/entity_id).

Aditivo: columnas con server_default para rellenar filas existentes; batch
para portabilidad (SQLite recrea la tabla). Paridad dev: db._migrate()
agrega las mismas columnas en SQLite y create_all crea las tablas nuevas.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f2a3b4c5d6e7'
down_revision: Union[str, Sequence[str], None] = 'e1f2a3b4c5d6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("purchase_order") as batch:
        batch.add_column(sa.Column(
            "fin_status", sa.String(length=16), nullable=False,
            server_default="open"))
        batch.add_column(sa.Column(
            "closed_at", sa.DateTime(), nullable=True))
        batch.add_column(sa.Column(
            "invoice_no", sa.String(length=40), nullable=False,
            server_default=""))
        batch.add_column(sa.Column(
            "invoice_date", sa.String(length=10), nullable=False,
            server_default=""))
        batch.add_column(sa.Column(
            "tracking_no", sa.String(length=60), nullable=False,
            server_default=""))
        batch.add_column(sa.Column(
            "payment_method", sa.String(length=20), nullable=False,
            server_default=""))
        batch.add_column(sa.Column(
            "vendor_id", sa.Integer(), nullable=True))
        batch.create_index("ix_purchase_order_vendor_id", ["vendor_id"])
        batch.create_foreign_key(
            "fk_purchase_order_vendor", "vendor", ["vendor_id"], ["id"])

    with op.batch_alter_table("po_line") as batch:
        batch.add_column(sa.Column(
            "taxable", sa.Boolean(), nullable=False,
            server_default=sa.false()))
        batch.add_column(sa.Column(
            "landed_unit_cost", sa.Float(), nullable=True))

    with op.batch_alter_table("part") as batch:
        batch.add_column(sa.Column("last_cost", sa.Float(), nullable=True))

    with op.batch_alter_table("part_stock_movement") as batch:
        batch.add_column(sa.Column("unit_cost", sa.Float(), nullable=True))
        batch.add_column(sa.Column("value_delta", sa.Float(), nullable=True))
        batch.add_column(sa.Column(
            "actor", sa.String(length=80), nullable=False,
            server_default=""))

    op.create_table(
        "po_adjustment",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("po_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=12), nullable=False),
        sa.Column("amount", sa.Float(), nullable=False),
        sa.Column("note", sa.String(length=200), nullable=False),
        sa.Column("allocate", sa.Boolean(), nullable=False,
                  server_default=sa.false()),
        sa.Column("actor", sa.String(length=80), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("voided_at", sa.DateTime(), nullable=True),
        sa.Column("void_reason", sa.String(length=200), nullable=False),
        sa.Column("org_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["org_id"], ["organization.id"]),
        sa.ForeignKeyConstraint(["po_id"], ["purchase_order.id"],
                                ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_po_adjustment_org_id", "po_adjustment", ["org_id"],
                    unique=False)
    op.create_index("ix_po_adjustment_po_id", "po_adjustment", ["po_id"],
                    unique=False)

    op.create_table(
        "audit_event",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("entity", sa.String(length=20), nullable=False),
        sa.Column("entity_id", sa.String(length=40), nullable=False),
        sa.Column("action", sa.String(length=30), nullable=False),
        sa.Column("field", sa.String(length=40), nullable=False),
        sa.Column("old", sa.String(length=200), nullable=False),
        sa.Column("new", sa.String(length=200), nullable=False),
        sa.Column("actor", sa.String(length=80), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("org_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["org_id"], ["organization.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_audit_event_org_id", "audit_event", ["org_id"],
                    unique=False)
    op.create_index("ix_audit_event_entity", "audit_event",
                    ["entity", "entity_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_audit_event_entity", table_name="audit_event")
    op.drop_index("ix_audit_event_org_id", table_name="audit_event")
    op.drop_table("audit_event")
    op.drop_index("ix_po_adjustment_po_id", table_name="po_adjustment")
    op.drop_index("ix_po_adjustment_org_id", table_name="po_adjustment")
    op.drop_table("po_adjustment")
    with op.batch_alter_table("part_stock_movement") as batch:
        batch.drop_column("actor")
        batch.drop_column("value_delta")
        batch.drop_column("unit_cost")
    with op.batch_alter_table("part") as batch:
        batch.drop_column("last_cost")
    with op.batch_alter_table("po_line") as batch:
        batch.drop_column("landed_unit_cost")
        batch.drop_column("taxable")
    with op.batch_alter_table("purchase_order") as batch:
        batch.drop_constraint("fk_purchase_order_vendor", type_="foreignkey")
        batch.drop_index("ix_purchase_order_vendor_id")
        batch.drop_column("vendor_id")
        batch.drop_column("payment_method")
        batch.drop_column("tracking_no")
        batch.drop_column("invoice_date")
        batch.drop_column("invoice_no")
        batch.drop_column("closed_at")
        batch.drop_column("fin_status")
