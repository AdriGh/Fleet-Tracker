"""engine hours: medidor de horas de motor + PM del reefer por horas (v2.22)

Revision ID: a3b4c5d6e7f8
Revises: f2a3b4c5d6e7
Create Date: 2026-10-09 12:00:00.000000

Benchmark SquareRigger: SR vence los PM "por horas" contra el ODÓMETRO. Acá
las horas de motor son un medidor propio, por unidad:
  - tabla nueva meter_reading (unit, meter='engine_hours', date, value,
    source manual|wo|maint|lynx|thermoking|traccar|demo, is_reset), única
    por (org, unit, meter, date, source). Separada de odometer_reading para
    que el cost-per-mile nunca lea horas como millas. `is_reset` marca una
    lectura forzada más baja (horómetro reseteado / controlador nuevo) como
    inicio de un tramo nuevo del medidor.
  - maint_record: `hours` (horas del servicio) y `kind` pasa a VARCHAR(16)
    (campañas nuevas como 'reefer').
  - work_order: `engine_hours` (lectura capturada en la WO; alimenta el
    registro del PM del reefer al facturar).

Aditivo (columnas nullable); batch para portabilidad (SQLite recrea la
tabla). Paridad dev: db._migrate() agrega las columnas en SQLite y
create_all crea la tabla nueva.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a3b4c5d6e7f8'
down_revision: Union[str, Sequence[str], None] = 'f2a3b4c5d6e7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "meter_reading",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("unit", sa.String(length=64), nullable=False),
        sa.Column("meter", sa.String(length=16), nullable=False),
        sa.Column("date", sa.String(length=10), nullable=False),
        sa.Column("value", sa.Float(), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("is_reset", sa.Boolean(), nullable=False,
                  server_default=sa.false()),
        sa.Column("org_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["org_id"], ["organization.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("org_id", "unit", "meter", "date", "source",
                            name="uq_meter_org_unit_meter_date_source"),
    )
    op.create_index("ix_meter_reading_org_id", "meter_reading", ["org_id"],
                    unique=False)
    op.create_index("ix_meter_reading_unit", "meter_reading", ["unit"],
                    unique=False)
    op.create_index("ix_meter_reading_date", "meter_reading", ["date"],
                    unique=False)

    with op.batch_alter_table("maint_record") as batch:
        batch.alter_column("kind", existing_type=sa.String(length=8),
                           type_=sa.String(length=16),
                           existing_nullable=False)
        batch.add_column(sa.Column("hours", sa.Float(), nullable=True))

    with op.batch_alter_table("work_order") as batch:
        batch.add_column(sa.Column("engine_hours", sa.Float(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("work_order") as batch:
        batch.drop_column("engine_hours")
    with op.batch_alter_table("maint_record") as batch:
        batch.drop_column("hours")
        batch.alter_column("kind", existing_type=sa.String(length=16),
                           type_=sa.String(length=8),
                           existing_nullable=False)
    op.drop_index("ix_meter_reading_date", table_name="meter_reading")
    op.drop_index("ix_meter_reading_unit", table_name="meter_reading")
    op.drop_index("ix_meter_reading_org_id", table_name="meter_reading")
    op.drop_table("meter_reading")
