"""DATA-4 unique constraints part_org_pn + wo parent_child

Revision ID: 1048cd72c14a
Revises: edc57a9c8b8e
Create Date: 2026-06-23 00:23:27.403280

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '1048cd72c14a'
down_revision: Union[str, Sequence[str], None] = 'edc57a9c8b8e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """DATA-4: unicidad por (org_id, part_number) en `part` y por
    (parent_id, child_seq) en `work_order`.

    `batch_alter_table` es portable: en Postgres (prod) emite ALTER TABLE ADD
    CONSTRAINT directo (sin recrear, sin tocar datos); en SQLite (dev) recrea la
    tabla porque no soporta ADD CONSTRAINT. Las raíces de work_order tienen
    parent_id NULL → los NULL no colisionan, así que solo se restringen las
    hijas."""
    with op.batch_alter_table("part") as batch:
        batch.create_unique_constraint(
            "uq_part_org_pn", ["org_id", "part_number"])
    with op.batch_alter_table("work_order") as batch:
        batch.create_unique_constraint(
            "uq_wo_parent_child", ["parent_id", "child_seq"])


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("work_order") as batch:
        batch.drop_constraint("uq_wo_parent_child", type_="unique")
    with op.batch_alter_table("part") as batch:
        batch.drop_constraint("uq_part_org_pn", type_="unique")
