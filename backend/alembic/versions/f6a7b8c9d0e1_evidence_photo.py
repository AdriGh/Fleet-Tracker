"""evidence photo: tabla evidence_photo (evidencia de defectos y WOs, v2.14)

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-08-14 12:00:00.000000

Elemento 01 del board de diseño: fotos de evidencia en defectos y Work
Orders. VARIAS por padre (a diferencia de unit_photo): `parent`+`parent_id`
apuntan al dueño ('defect' -> defect.id, 'wo' -> work_order.id) y `phase`
separa la foto del reporte ('report') del par de cierre ('before'/'after').
El archivo vive en backend/uploads/evidence/; acá solo la metadata.
org-scoped.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f6a7b8c9d0e1'
down_revision: Union[str, Sequence[str], None] = 'e5f6a7b8c9d0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "evidence_photo",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("org_id", sa.Integer(),
                  sa.ForeignKey("organization.id"), nullable=True),
        sa.Column("parent", sa.String(length=8), nullable=False),
        sa.Column("parent_id", sa.Integer(), nullable=False),
        sa.Column("phase", sa.String(length=8), nullable=False,
                  server_default="report"),
        sa.Column("unit", sa.String(length=64), nullable=False,
                  server_default=""),
        sa.Column("filename", sa.String(length=140), nullable=False),
        sa.Column("stored", sa.String(length=200), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("note", sa.String(length=200), nullable=False,
                  server_default=""),
        sa.Column("uploaded_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_evidence_photo_org_id", "evidence_photo", ["org_id"])
    op.create_index("ix_evidence_photo_parent", "evidence_photo", ["parent"])
    op.create_index("ix_evidence_photo_parent_id", "evidence_photo",
                    ["parent_id"])
    # El acceso típico es "todas las fotos de ESTE padre" (listar/contar):
    # índice compuesto parent+parent_id.
    op.create_index("ix_evidence_photo_parent_parent_id", "evidence_photo",
                    ["parent", "parent_id"])


def downgrade() -> None:
    op.drop_index("ix_evidence_photo_parent_parent_id",
                  table_name="evidence_photo")
    op.drop_index("ix_evidence_photo_parent_id", table_name="evidence_photo")
    op.drop_index("ix_evidence_photo_parent", table_name="evidence_photo")
    op.drop_index("ix_evidence_photo_org_id", table_name="evidence_photo")
    op.drop_table("evidence_photo")
