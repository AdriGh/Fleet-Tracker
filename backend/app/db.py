"""Capa de persistencia: SQLite + SQLAlchemy.

Guarda cada bloque diario generado para alimentar el panel DVIR
(ultimos informes, top de conductores sin DVIR).
"""

import json
from datetime import date, datetime

from sqlalchemy import (
    Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text,
    create_engine, func, select,
)
from sqlalchemy.orm import (
    DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker,
)

from .config import BACKEND_DIR

DB_PATH = BACKEND_DIR / "dvir.db"
_engine = create_engine(f"sqlite:///{DB_PATH}")
SessionLocal = sessionmaker(bind=_engine)


class Base(DeclarativeBase):
    pass


class ReportBlock(Base):
    __tablename__ = "report_block"

    id: Mapped[int] = mapped_column(primary_key=True)
    company: Mapped[str] = mapped_column(String(64))
    date_label: Mapped[str] = mapped_column(String(16))
    block_date: Mapped[date] = mapped_column(Date)
    created_at: Mapped[datetime] = mapped_column(DateTime)
    n_reports: Mapped[int] = mapped_column(Integer)
    n_no_dvir: Mapped[int] = mapped_column(Integer)
    n_unsafe: Mapped[int] = mapped_column(Integer)
    fleet_safe_pct: Mapped[float] = mapped_column(Float)
    groups_json: Mapped[str] = mapped_column(Text)

    drivers: Mapped[list["BlockDriver"]] = relationship(
        back_populates="block", cascade="all, delete-orphan")


class BlockDriver(Base):
    __tablename__ = "block_driver"

    id: Mapped[int] = mapped_column(primary_key=True)
    block_id: Mapped[int] = mapped_column(ForeignKey("report_block.id"))
    driver: Mapped[str] = mapped_column(String(128))
    is_no_dvir: Mapped[bool] = mapped_column(Boolean)

    block: Mapped[ReportBlock] = relationship(back_populates="drivers")


Base.metadata.create_all(_engine)


# ---------------------------------------------------------------------------
# Operaciones
# ---------------------------------------------------------------------------
def save_block(company, date_label, block_date, groups, metrics):
    """Inserta (o reemplaza) el bloque de una empresa+fecha."""
    with SessionLocal() as session:
        existing = session.scalars(
            select(ReportBlock).where(
                ReportBlock.company == company,
                ReportBlock.block_date == block_date,
            )
        ).all()
        for old in existing:
            session.delete(old)

        block = ReportBlock(
            company=company,
            date_label=date_label,
            block_date=block_date,
            created_at=datetime.now(),
            n_reports=metrics["n_reports"],
            n_no_dvir=metrics["n_no_dvir"],
            n_unsafe=metrics["n_unsafe"],
            fleet_safe_pct=metrics["fleet_safe_pct"],
            groups_json=json.dumps(groups),
        )
        seen = set()
        for group in groups:
            first = group["rows"][0]
            driver = str(first.get("Driver", "")).strip()
            key = (driver, bool(first.get("is_nodvir")))
            if not driver or key in seen:
                continue
            seen.add(key)
            block.drivers.append(
                BlockDriver(driver=driver,
                            is_no_dvir=bool(first.get("is_nodvir"))))
        session.add(block)
        session.commit()
        return block.id


_SORT_FIELDS = {
    "created_at": ReportBlock.created_at,
    "n_reports": ReportBlock.n_reports,
    "n_no_dvir": ReportBlock.n_no_dvir,
    "n_unsafe": ReportBlock.n_unsafe,
    "fleet_safe_pct": ReportBlock.fleet_safe_pct,
}


def recent_blocks(limit=5, sort="created_at"):
    """Ultimos bloques, ordenados de forma descendente por `sort`."""
    column = _SORT_FIELDS.get(sort, ReportBlock.created_at)
    with SessionLocal() as session:
        rows = session.scalars(
            select(ReportBlock).order_by(column.desc(),
                                         ReportBlock.created_at.desc())
            .limit(limit)
        ).all()
        return [{
            "id": r.id,
            "company": r.company,
            "date_label": r.date_label,
            "block_date": r.block_date.isoformat(),
            "created_at": r.created_at.isoformat(),
            "n_reports": r.n_reports,
            "n_no_dvir": r.n_no_dvir,
            "n_unsafe": r.n_unsafe,
            "fleet_safe_pct": r.fleet_safe_pct,
        } for r in rows]


def missing_drivers(limit=10):
    """Top de conductores con mas dias 'NO DVIR' en el mes del bloque
    mas reciente."""
    with SessionLocal() as session:
        latest = session.scalars(
            select(ReportBlock.block_date)
            .order_by(ReportBlock.block_date.desc()).limit(1)
        ).first()
        if latest is None:
            return {"month": None, "drivers": []}

        rows = session.execute(
            select(BlockDriver.driver, func.count().label("misses"))
            .join(ReportBlock, BlockDriver.block_id == ReportBlock.id)
            .where(
                BlockDriver.is_no_dvir.is_(True),
                func.strftime("%Y-%m", ReportBlock.block_date)
                == latest.strftime("%Y-%m"),
            )
            .group_by(BlockDriver.driver)
            .order_by(func.count().desc())
            .limit(limit)
        ).all()
        return {
            "month": latest.strftime("%Y-%m"),
            "drivers": [{"driver": d, "misses": m} for d, m in rows],
        }


def get_block(block_id):
    """Devuelve los grupos guardados de un bloque, o None."""
    with SessionLocal() as session:
        block = session.get(ReportBlock, block_id)
        if block is None:
            return None
        return {
            "id": block.id,
            "company": block.company,
            "date_label": block.date_label,
            "groups": json.loads(block.groups_json),
        }
