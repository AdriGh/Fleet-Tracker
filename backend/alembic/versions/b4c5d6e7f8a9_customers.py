"""customers: Resources -> Customers + Bill-To de la WO (v2.22)

Revision ID: b4c5d6e7f8a9
Revises: a3b4c5d6e7f8
Create Date: 2026-10-09 14:00:00.000000

Benchmark SquareRigger (Resources → Customers). El caso del dueño: los
owner-operators reciben partes/labor del taller que después se les cobran.
  - tabla customer (perfil + términos + markups de partes/labor + tax),
    customer_contact (contactos; is_billing = el de facturación) y
    customer_unit (unidades del customer; UN dueño por unidad, a nivel app).
  - work_order: customer_id (FK nullable; NULL = Self), payment_status
    (unpaid|paid), paid_at y tax_pct (tasa de impuesto del customer
    congelada al facturar; se aplica a las partes facturadas).
  - work_order_line: unit_price (precio congelado al facturar con markup).

Aditivo (tablas nuevas + columnas nullable / con server_default); batch para
portabilidad (SQLite recrea la tabla). Paridad dev: db._migrate() agrega las
columnas en SQLite y create_all crea las tablas nuevas.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b4c5d6e7f8a9'
down_revision: Union[str, Sequence[str], None] = 'a3b4c5d6e7f8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "customer",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False,
                  server_default=sa.true()),
        sa.Column("since", sa.String(length=10), nullable=True),
        sa.Column("email", sa.String(length=120), nullable=False),
        sa.Column("phone", sa.String(length=40), nullable=False),
        sa.Column("address", sa.String(length=200), nullable=False),
        sa.Column("city", sa.String(length=80), nullable=False),
        sa.Column("state", sa.String(length=20), nullable=False),
        sa.Column("zip", sa.String(length=12), nullable=False),
        sa.Column("terms", sa.String(length=20), nullable=False),
        sa.Column("labor_markup_pct", sa.Float(), nullable=False),
        sa.Column("parts_markup_pct", sa.Float(), nullable=False),
        sa.Column("tax_exempt", sa.Boolean(), nullable=False,
                  server_default=sa.false()),
        sa.Column("tax_rate_pct", sa.Float(), nullable=False),
        sa.Column("accounting_id", sa.String(length=60), nullable=False),
        sa.Column("driver_name", sa.String(length=120), nullable=False),
        sa.Column("notes", sa.Text(), nullable=False),
        sa.Column("tags", sa.String(length=200), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("org_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["org_id"], ["organization.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_customer_org_id", "customer", ["org_id"],
                    unique=False)
    op.create_index("ix_customer_name", "customer", ["name"], unique=False)

    op.create_table(
        "customer_contact",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("customer_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("role", sa.String(length=60), nullable=False),
        sa.Column("email", sa.String(length=120), nullable=False),
        sa.Column("phone", sa.String(length=40), nullable=False),
        sa.Column("is_billing", sa.Boolean(), nullable=False,
                  server_default=sa.false()),
        sa.Column("org_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["customer_id"], ["customer.id"],
                                ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["org_id"], ["organization.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_customer_contact_org_id", "customer_contact",
                    ["org_id"], unique=False)
    op.create_index("ix_customer_contact_customer_id", "customer_contact",
                    ["customer_id"], unique=False)

    op.create_table(
        "customer_unit",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("customer_id", sa.Integer(), nullable=False),
        sa.Column("unit", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("org_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["customer_id"], ["customer.id"],
                                ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["org_id"], ["organization.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_customer_unit_org_id", "customer_unit", ["org_id"],
                    unique=False)
    op.create_index("ix_customer_unit_customer_id", "customer_unit",
                    ["customer_id"], unique=False)
    op.create_index("ix_customer_unit_unit", "customer_unit", ["unit"],
                    unique=False)

    with op.batch_alter_table("work_order") as batch:
        batch.add_column(sa.Column("customer_id", sa.Integer(),
                                   nullable=True))
        batch.add_column(sa.Column(
            "payment_status", sa.String(length=12), nullable=False,
            server_default="unpaid"))
        batch.add_column(sa.Column("paid_at", sa.DateTime(), nullable=True))
        batch.add_column(sa.Column("tax_pct", sa.Float(), nullable=True))
        batch.create_index("ix_work_order_customer_id", ["customer_id"])
        batch.create_foreign_key(
            "fk_work_order_customer", "customer", ["customer_id"], ["id"])

    with op.batch_alter_table("work_order_line") as batch:
        batch.add_column(sa.Column("unit_price", sa.Float(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("work_order_line") as batch:
        batch.drop_column("unit_price")
    with op.batch_alter_table("work_order") as batch:
        batch.drop_constraint("fk_work_order_customer", type_="foreignkey")
        batch.drop_index("ix_work_order_customer_id")
        batch.drop_column("tax_pct")
        batch.drop_column("paid_at")
        batch.drop_column("payment_status")
        batch.drop_column("customer_id")
    op.drop_index("ix_customer_unit_unit", table_name="customer_unit")
    op.drop_index("ix_customer_unit_customer_id", table_name="customer_unit")
    op.drop_index("ix_customer_unit_org_id", table_name="customer_unit")
    op.drop_table("customer_unit")
    op.drop_index("ix_customer_contact_customer_id",
                  table_name="customer_contact")
    op.drop_index("ix_customer_contact_org_id", table_name="customer_contact")
    op.drop_table("customer_contact")
    op.drop_index("ix_customer_name", table_name="customer")
    op.drop_index("ix_customer_org_id", table_name="customer")
    op.drop_table("customer")
