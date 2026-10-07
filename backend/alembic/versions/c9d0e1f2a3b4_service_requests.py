"""service requests: tabla service_request (v2.20)

Revision ID: c9d0e1f2a3b4
Revises: b8c9d0e1f2a3
Create Date: 2026-10-06 12:00:00.000000

Benchmark SquareRigger: el BACKLOG por unidad desde el que se despacha el
taller. Unifica defectos DVIR abiertos + PM/DOT vencidos + pedidos manuales
en una sola cola con Deny / Snooze / Add to WO / Create WO. `source_key` es
la clave estable de dedupe del sync (única por organización); `wo_id` sin FK
(como las demás tablas hijas). Tabla nueva (en dev SQLite la crea create_all).
org-scoped.

Walkaround / Driver Workflows se retiraron del producto en esta versión, pero
sus tablas NO se tocan acá: se conservan con su data de producción.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c9d0e1f2a3b4'
down_revision: Union[str, Sequence[str], None] = 'b8c9d0e1f2a3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "service_request",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("org_id", sa.Integer(),
                  sa.ForeignKey("organization.id"), nullable=True),
        sa.Column("unit", sa.String(length=64), nullable=False),
        sa.Column("company", sa.String(length=64), nullable=False,
                  server_default=""),
        sa.Column("source", sa.String(length=12), nullable=False),
        sa.Column("source_key", sa.String(length=120), nullable=False),
        sa.Column("title", sa.String(length=160), nullable=False),
        sa.Column("detail", sa.Text(), nullable=False, server_default=""),
        sa.Column("priority", sa.String(length=12), nullable=False,
                  server_default="normal"),
        sa.Column("status", sa.String(length=12), nullable=False,
                  server_default="open"),
        sa.Column("wo_id", sa.Integer(), nullable=True),
        sa.Column("resolution", sa.String(length=20), nullable=False,
                  server_default=""),
        sa.Column("meta", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("source_active", sa.Boolean(), nullable=False,
                  server_default=sa.true()),
        sa.Column("snooze_until", sa.String(length=10), nullable=True),
        sa.Column("follow_up_date", sa.String(length=10), nullable=True),
        sa.Column("deny_reason", sa.String(length=200), nullable=False,
                  server_default=""),
        sa.Column("created_by", sa.String(length=80), nullable=False,
                  server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("resolved_at", sa.DateTime(), nullable=True),
        sa.Column("source_seen_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("org_id", "source_key",
                            name="uq_service_request_org_key"),
    )
    op.create_index("ix_service_request_org_id", "service_request",
                    ["org_id"])
    op.create_index("ix_service_request_unit", "service_request", ["unit"])
    op.create_index("ix_service_request_source", "service_request",
                    ["source"])
    op.create_index("ix_service_request_source_key", "service_request",
                    ["source_key"])
    op.create_index("ix_service_request_status", "service_request",
                    ["status"])
    op.create_index("ix_service_request_wo_id", "service_request", ["wo_id"])


def downgrade() -> None:
    op.drop_index("ix_service_request_wo_id", table_name="service_request")
    op.drop_index("ix_service_request_status", table_name="service_request")
    op.drop_index("ix_service_request_source_key",
                  table_name="service_request")
    op.drop_index("ix_service_request_source", table_name="service_request")
    op.drop_index("ix_service_request_unit", table_name="service_request")
    op.drop_index("ix_service_request_org_id", table_name="service_request")
    op.drop_table("service_request")
