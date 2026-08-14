"""unit photo: tabla unit_photo (identidad visual de unidades, v2.13)

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-08-14 12:00:00.000000

Elemento 05 del board de diseño: UNA foto por unidad (hero del perfil +
tarjeta del Fleet). El archivo vive en backend/uploads/unit_photos/; acá
solo la metadata. org-scoped. En demo, las unidades sin foto caen a assets
de muestra (no pasan por esta tabla).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e5f6a7b8c9d0'
down_revision: Union[str, Sequence[str], None] = 'd4e5f6a7b8c9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "unit_photo",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("org_id", sa.Integer(),
                  sa.ForeignKey("organization.id"), nullable=True),
        sa.Column("unit", sa.String(length=64), nullable=False),
        sa.Column("filename", sa.String(length=140), nullable=False),
        sa.Column("stored", sa.String(length=200), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("uploaded_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_unit_photo_org_id", "unit_photo", ["org_id"])
    op.create_index("ix_unit_photo_unit", "unit_photo", ["unit"])


def downgrade() -> None:
    op.drop_index("ix_unit_photo_unit", table_name="unit_photo")
    op.drop_index("ix_unit_photo_org_id", table_name="unit_photo")
    op.drop_table("unit_photo")
