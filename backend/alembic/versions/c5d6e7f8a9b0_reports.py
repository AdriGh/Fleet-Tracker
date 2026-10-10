"""reports: reportes guardados, favoritos y envíos programados (v2.22)

Revision ID: c5d6e7f8a9b0
Revises: b4c5d6e7f8a9
Create Date: 2026-10-09 18:00:00.000000

Benchmark SquareRigger (Insights → Reports). Los reportes de SISTEMA viven
en código (core/report_library); acá solo lo que crean los usuarios:
  - saved_report: spec JSON (core/report_engine.ReportSpec) + visibilidad
    mine|org + based_on (slug del reporte de sistema clonado).
  - report_favorite: ★ por usuario ('sys:<slug>' | 'saved:<id>'), único por
    (org, usuario, ref).
  - report_schedule: envío por email (cadencia, hora en la zona de la org,
    destinatarios, CSV/XLSX) con next_run_at reclamable (sin doble envío) y
    el estado del último envío (sent | dry_run | error).

Solo tablas nuevas (aditivo). Paridad dev: create_all las crea en SQLite;
db._migrate() no necesita columnas nuevas en tablas existentes.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c5d6e7f8a9b0'
down_revision: Union[str, Sequence[str], None] = 'b4c5d6e7f8a9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "saved_report",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("owner_user_id", sa.Integer(), nullable=True),
        sa.Column("visibility", sa.String(length=8), nullable=False),
        sa.Column("spec_json", sa.Text(), nullable=False),
        sa.Column("based_on", sa.String(length=80), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("org_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["org_id"], ["organization.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_saved_report_org_id", "saved_report", ["org_id"],
                    unique=False)
    op.create_index("ix_saved_report_owner_user_id", "saved_report",
                    ["owner_user_id"], unique=False)

    op.create_table(
        "report_favorite",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("report_ref", sa.String(length=100), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("org_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["org_id"], ["organization.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("org_id", "user_id", "report_ref",
                            name="uq_report_favorite_org_user_ref"),
    )
    op.create_index("ix_report_favorite_org_id", "report_favorite",
                    ["org_id"], unique=False)
    op.create_index("ix_report_favorite_user_id", "report_favorite",
                    ["user_id"], unique=False)

    op.create_table(
        "report_schedule",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("report_ref", sa.String(length=100), nullable=False),
        sa.Column("version", sa.String(length=40), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("cadence", sa.String(length=10), nullable=False),
        sa.Column("weekday", sa.Integer(), nullable=True),
        sa.Column("day_of_month", sa.Integer(), nullable=True),
        sa.Column("hour", sa.Integer(), nullable=False),
        sa.Column("recipients", sa.Text(), nullable=False),
        sa.Column("format", sa.String(length=8), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False,
                  server_default=sa.true()),
        sa.Column("last_run_at", sa.DateTime(), nullable=True),
        sa.Column("next_run_at", sa.DateTime(), nullable=True),
        sa.Column("last_status", sa.String(length=20), nullable=False,
                  server_default=""),
        sa.Column("last_error", sa.String(length=300), nullable=False,
                  server_default=""),
        sa.Column("created_by", sa.String(length=80), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("org_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["org_id"], ["organization.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_report_schedule_org_id", "report_schedule",
                    ["org_id"], unique=False)
    op.create_index("ix_report_schedule_next_run_at", "report_schedule",
                    ["next_run_at"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_report_schedule_next_run_at",
                  table_name="report_schedule")
    op.drop_index("ix_report_schedule_org_id", table_name="report_schedule")
    op.drop_table("report_schedule")
    op.drop_index("ix_report_favorite_user_id", table_name="report_favorite")
    op.drop_index("ix_report_favorite_org_id", table_name="report_favorite")
    op.drop_table("report_favorite")
    op.drop_index("ix_saved_report_owner_user_id", table_name="saved_report")
    op.drop_index("ix_saved_report_org_id", table_name="saved_report")
    op.drop_table("saved_report")
