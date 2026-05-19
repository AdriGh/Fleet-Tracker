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
    defect_items: Mapped[list["Defect"]] = relationship(
        back_populates="block", cascade="all, delete-orphan")


class BlockDriver(Base):
    __tablename__ = "block_driver"

    id: Mapped[int] = mapped_column(primary_key=True)
    block_id: Mapped[int] = mapped_column(ForeignKey("report_block.id"))
    driver: Mapped[str] = mapped_column(String(128))
    is_no_dvir: Mapped[bool] = mapped_column(Boolean)

    block: Mapped[ReportBlock] = relationship(back_populates="drivers")


class Defect(Base):
    __tablename__ = "defect"

    id: Mapped[int] = mapped_column(primary_key=True)
    block_id: Mapped[int] = mapped_column(ForeignKey("report_block.id"))
    company: Mapped[str] = mapped_column(String(64))
    block_date: Mapped[date] = mapped_column(Date)
    date_label: Mapped[str] = mapped_column(String(16))
    driver: Mapped[str] = mapped_column(String(128))
    unit: Mapped[str] = mapped_column(String(64))
    unit_kind: Mapped[str] = mapped_column(String(16))
    dvir_type: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(32))
    detail: Mapped[str] = mapped_column(Text)
    mechanic: Mapped[str] = mapped_column(String(128))
    mechanic_notes: Mapped[str] = mapped_column(Text)

    block: Mapped[ReportBlock] = relationship(
        back_populates="defect_items")


Base.metadata.create_all(_engine)


# ---------------------------------------------------------------------------
# Operaciones
# ---------------------------------------------------------------------------
def save_block(company, date_label, block_date, groups, metrics,
               defects=None):
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
        for d in defects or []:
            block.defect_items.append(Defect(
                company=company,
                block_date=block_date,
                date_label=date_label,
                driver=d["driver"],
                unit=d["unit"],
                unit_kind=d["unit_kind"],
                dvir_type=d["dvir_type"],
                status=d["status"],
                detail=d["detail"],
                mechanic=d["mechanic"],
                mechanic_notes=d["mechanic_notes"],
            ))
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


def month_summary():
    """Resumen del mes del bloque mas reciente: % de flota SAFE promedio."""
    with SessionLocal() as session:
        latest = session.scalars(
            select(ReportBlock.block_date)
            .order_by(ReportBlock.block_date.desc()).limit(1)
        ).first()
        if latest is None:
            return {"month": None, "fleet_safe_pct": None, "n_blocks": 0}
        ym = latest.strftime("%Y-%m")
        rows = session.scalars(
            select(ReportBlock).where(
                func.strftime("%Y-%m", ReportBlock.block_date) == ym)
        ).all()
        if not rows:
            return {"month": ym, "fleet_safe_pct": None, "n_blocks": 0}
        avg = sum(r.fleet_safe_pct for r in rows) / len(rows)
        return {
            "month": ym,
            "fleet_safe_pct": round(avg, 1),
            "n_blocks": len(rows),
        }


def list_defects(company=None, status=None, unit=None, limit=400):
    """Defectos reportados, con filtros opcionales."""
    with SessionLocal() as session:
        query = select(Defect).order_by(
            Defect.block_date.desc(), Defect.id.desc())
        if company:
            query = query.where(Defect.company == company)
        if status:
            query = query.where(Defect.status == status)
        if unit:
            query = query.where(Defect.unit == unit)
        rows = session.scalars(query.limit(limit)).all()
        return [{
            "date_label": r.date_label,
            "block_date": r.block_date.isoformat(),
            "company": r.company,
            "driver": r.driver,
            "unit": r.unit,
            "unit_kind": r.unit_kind,
            "dvir_type": r.dvir_type,
            "status": r.status,
            "detail": r.detail,
            "mechanic": r.mechanic,
            "mechanic_notes": r.mechanic_notes,
        } for r in rows]


def trends():
    """Serie diaria del mes del bloque mas reciente."""
    with SessionLocal() as session:
        latest = session.scalars(
            select(ReportBlock.block_date)
            .order_by(ReportBlock.block_date.desc()).limit(1)
        ).first()
        if latest is None:
            return {"month": None, "points": []}
        ym = latest.strftime("%Y-%m")
        rows = session.scalars(
            select(ReportBlock)
            .where(func.strftime("%Y-%m", ReportBlock.block_date) == ym)
            .order_by(ReportBlock.block_date, ReportBlock.company)
        ).all()
        return {
            "month": ym,
            "points": [{
                "date_label": r.date_label,
                "company": r.company,
                "fleet_safe_pct": r.fleet_safe_pct,
                "n_no_dvir": r.n_no_dvir,
                "n_unsafe": r.n_unsafe,
                "n_reports": r.n_reports,
            } for r in rows],
        }


def driver_history(name):
    """Historial de un conductor: dias, cumplimiento y sus defectos."""
    with SessionLocal() as session:
        rows = session.execute(
            select(BlockDriver, ReportBlock)
            .join(ReportBlock, BlockDriver.block_id == ReportBlock.id)
            .where(BlockDriver.driver == name)
            .order_by(ReportBlock.block_date)
        ).all()
        by_block: dict = {}
        for bd, block in rows:
            entry = by_block.setdefault(block.id, {
                "date_label": block.date_label,
                "block_date": block.block_date.isoformat(),
                "company": block.company,
                "missed": False,
            })
            if bd.is_no_dvir:
                entry["missed"] = True
        days = sorted(by_block.values(), key=lambda d: d["block_date"])
        total = len(days)
        ok = sum(1 for d in days if not d["missed"])
        defects = session.scalars(
            select(Defect).where(Defect.driver == name)
            .order_by(Defect.block_date.desc(), Defect.id.desc())
        ).all()
        return {
            "driver": name,
            "total_days": total,
            "ok_days": ok,
            "missed_days": total - ok,
            "compliance_pct": round(ok / total * 100, 1) if total else 0.0,
            "days": days,
            "defects": [{
                "date_label": d.date_label,
                "unit": d.unit,
                "unit_kind": d.unit_kind,
                "status": d.status,
                "detail": d.detail,
            } for d in defects],
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
            "fleet_safe_pct": block.fleet_safe_pct,
            "groups": json.loads(block.groups_json),
        }
