"""Capa de persistencia: SQLAlchemy sobre Postgres (produccion) o SQLite (dev).

El motor se elige por la variable de entorno DATABASE_URL (ver config.py);
si no esta seteada, se usa una SQLite local para desarrollo/tests.

Guarda cada bloque diario generado para alimentar el panel DVIR
(ultimos informes, top de conductores sin DVIR).
"""

import json
from datetime import date, datetime
from pathlib import Path

from sqlalchemy import (
    Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text,
    create_engine, event, func, select,
)
from sqlalchemy.orm import (
    DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker,
    with_loader_criteria,
)

from . import config
from .core import tenant

# SQLite necesita check_same_thread=False para usarse desde el threadpool de
# FastAPI; Postgres no acepta ese argumento.
_connect_args = {"check_same_thread": False} if config.IS_SQLITE else {}
_engine = create_engine(config.DATABASE_URL, connect_args=_connect_args)
SessionLocal = sessionmaker(bind=_engine)


class Base(DeclarativeBase):
    pass


class OrgScoped:
    """Mixin H6 fase 3: agrega org_id (tenant) a las tablas de datos. Toda la
    data de negocio se aisla por organizacion.

    Nullable por ahora: la fase 3b agrega la columna y backfillea a la org
    'default'; la fase 3c la hace obligatoria + activa Row-Level Security en
    Postgres, una vez que toda escritura garantiza completar el org_id."""

    org_id: Mapped[int | None] = mapped_column(
        ForeignKey("organization.id"), index=True, nullable=True)


class ReportBlock(OrgScoped, Base):
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


class BlockDriver(OrgScoped, Base):
    __tablename__ = "block_driver"

    id: Mapped[int] = mapped_column(primary_key=True)
    block_id: Mapped[int] = mapped_column(ForeignKey("report_block.id"))
    driver: Mapped[str] = mapped_column(String(128))
    is_no_dvir: Mapped[bool] = mapped_column(Boolean)

    block: Mapped[ReportBlock] = relationship(back_populates="drivers")


class Defect(OrgScoped, Base):
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


class Poi(Base):
    """Punto de interés del Live Map (talleres, dealers, básculas).

    Datos públicos compartidos (OSM/DOT), NO se aislan por tenant: su PK es
    el id global de OSM, asi que una copia por organizacion colisionaria. Si
    a futuro se quieren POIs privados por cliente, hace falta rediseñar la PK
    (compuesta org_id+id) — fuera del alcance de H6 fase 3.

    Se siembra desde `backend/data/pois_seed.json` (OSM + DOTs estatales,
    con atribución ODbL) y se cura a mano desde la app. `kind`:
    repair | dealer_truck | dealer_trailer | scale. `subtype`:
    'enforcement' para básculas DOT, '' para el resto.
    """
    __tablename__ = "poi"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    kind: Mapped[str] = mapped_column(String(20), index=True)
    subtype: Mapped[str] = mapped_column(String(20), default="")
    name: Mapped[str] = mapped_column(String(140))
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    address: Mapped[str] = mapped_column(String(180), default="")
    phone: Mapped[str] = mapped_column(String(40), default="")
    brand: Mapped[str] = mapped_column(String(60), default="")
    source: Mapped[str] = mapped_column(String(20), default="manual")


class WorkOrder(OrgScoped, Base):
    """Orden de trabajo (G5, pipeline H2 — reemplazo de Fullbay).

    Pipeline: open -> assigned -> in_progress -> completed -> invoiced
    -> closed (pagada; cierre manual). `waiting_parts` es un flag, no un
    estado (la espera de partes no rompe la secuencia). Gates de avance
    en core/workorders.py: assigned exige mecánico, invoiced exige
    total > 0. Si `is_pm` y llega a completed con `pm_miles`, el PM
    tracker se actualiza vía override.
    """
    __tablename__ = "work_order"

    id: Mapped[int] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime)
    closed_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True)        # sello de COMPLETED (histórico)
    invoiced_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True)
    unit: Mapped[str] = mapped_column(String(64), index=True)
    company: Mapped[str] = mapped_column(String(64), default="")
    status: Mapped[str] = mapped_column(String(20), default="open",
                                        index=True)
    priority: Mapped[str] = mapped_column(String(10), default="normal")
    title: Mapped[str] = mapped_column(String(140))
    complaint: Mapped[str] = mapped_column(Text, default="")
    mechanic: Mapped[str] = mapped_column(String(80), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    is_pm: Mapped[bool] = mapped_column(Boolean, default=False)
    pm_miles: Mapped[int | None] = mapped_column(Integer, nullable=True)
    mileage: Mapped[int | None] = mapped_column(Integer, nullable=True)
    service_date: Mapped[str | None] = mapped_column(
        String(10), nullable=True)      # YYYY-MM-DD (form del jefe)
    waiting_parts: Mapped[bool] = mapped_column(Boolean, default=False)
    # H3b: campaña de mantenimiento asociada (pm|dot|kingpins|dpf|clutch
    # o ''). Al FACTURAR la orden se registra el servicio en la campaña
    # (maint_record) y el perfil de la unidad se actualiza solo.
    campaign: Mapped[str] = mapped_column(String(12), default="")
    source: Mapped[str] = mapped_column(String(20), default="manual")
    # H3-C: datos del invoice imprimible (estimate -> invoice). El número
    # se asigna del contador de org_config al facturar por primera vez.
    invoice_number: Mapped[str] = mapped_column(String(40), default="")
    po_number: Mapped[str] = mapped_column(String(60), default="")   # PO del cliente
    authorizer: Mapped[str] = mapped_column(String(80), default="")
    # Nº de invoice del TALLER externo (Love's, etc.), del escaneo del doc.
    # Distinto del invoice_number propio de Fleet Tracker (auto, formateable).
    shop_invoice: Mapped[str] = mapped_column(String(60), default="")

    lines: Mapped[list["WorkOrderLine"]] = relationship(
        back_populates="wo", cascade="all, delete-orphan")


class WorkOrderLine(OrgScoped, Base):
    """Línea de un WO: parte (qty × costo) o labor (horas × tarifa)."""
    __tablename__ = "work_order_line"

    id: Mapped[int] = mapped_column(primary_key=True)
    wo_id: Mapped[int] = mapped_column(ForeignKey("work_order.id"))
    kind: Mapped[str] = mapped_column(String(10), default="part")
    description: Mapped[str] = mapped_column(String(160))
    qty: Mapped[float] = mapped_column(Float, default=1.0)
    unit_cost: Mapped[float] = mapped_column(Float, default=0.0)
    # H3: referencia opcional al catálogo (Part.part_number) cuando la
    # línea se cargó eligiendo una parte; vacío para líneas a mano.
    part_number: Mapped[str] = mapped_column(String(60), default="")

    wo: Mapped[WorkOrder] = relationship(back_populates="lines")


class Organization(Base):
    """Tenant del SaaS (H6 fase 3): el cliente-cuenta que paga por usar la
    herramienta. Por encima de `company` (los carriers tipo CHASER/MCC viven
    DENTRO de una organizacion). Toda la data se aisla por org_id.

    Hay una org 'default' sembrada al iniciar; el modo single-tenant actual
    equivale a una sola organizacion."""
    __tablename__ = "organization"

    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120), default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime)


class OrgSetting(Base):
    """Config NO secreta por-tenant (H6 fase 3d): un blob JSON por
    (organizacion, clave). Reemplaza los *.local.json single-tenant de
    org_config/app_config/alerts. Los secretos NO viven aca (ver core/
    secrets.py). Se accede via get_setting()/save_setting()."""
    __tablename__ = "org_setting"

    org_id: Mapped[int] = mapped_column(
        ForeignKey("organization.id"), primary_key=True)
    key: Mapped[str] = mapped_column(String(40), primary_key=True)
    value_json: Mapped[str] = mapped_column(Text)


class User(Base):
    """Usuario de la app (fase G7): auth real con roles.

    Roles: admin (todo) · dispatcher · mechanic · viewer. El hash es
    pbkdf2-sha256 con salt propio ("salt_hex$hash_hex", core/auth.py).
    """
    __tablename__ = "user"

    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(
        ForeignKey("organization.id"), index=True)
    username: Mapped[str] = mapped_column(String(40), unique=True,
                                          index=True)
    name: Mapped[str] = mapped_column(String(120), default="")
    role: Mapped[str] = mapped_column(String(16), default="viewer")
    pw_hash: Mapped[str] = mapped_column(String(200))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime)


class TmsDriver(OrgScoped, Base):
    """Perfil TMS de un conductor (fase G-TMS).

    Extiende el roster vivo de Samsara con datos de despacho: contrato
    (rol, tipo de pago, %), equipo asignado, vencimientos de compliance
    y contacto de emergencia. Clave = nombre normalizado del roster.
    Vive solo en SQLite local (PII, gitignored).
    """
    __tablename__ = "tms_driver"

    name: Mapped[str] = mapped_column(String(128), primary_key=True)
    company: Mapped[str] = mapped_column(String(64), default="")
    driver_company: Mapped[str] = mapped_column(String(120), default="")
    role: Mapped[str] = mapped_column(String(24), default="owner_operator")
    pay_type: Mapped[str] = mapped_column(String(16), default="percentage")
    pay_pct: Mapped[float] = mapped_column(Float, default=0.0)
    truck: Mapped[str] = mapped_column(String(32), default="")
    trailer: Mapped[str] = mapped_column(String(32), default="")
    hired_date: Mapped[str] = mapped_column(String(12), default="")
    emergency_name: Mapped[str] = mapped_column(String(120), default="")
    emergency_phone: Mapped[str] = mapped_column(String(40), default="")
    cdl_exp: Mapped[str] = mapped_column(String(12), default="")
    med_exp: Mapped[str] = mapped_column(String(12), default="")
    mvr_exp: Mapped[str] = mapped_column(String(12), default="")
    chouse_exp: Mapped[str] = mapped_column(String(12), default="")
    notes: Mapped[str] = mapped_column(Text, default="")


class AlertEvent(OrgScoped, Base):
    """Evento de alerta de flota (fase G3): velocidad, idle, fuel/DEF
    bajos, GPS sin señal. Los genera el evaluador de core/alerts.py."""
    __tablename__ = "alert_event"

    id: Mapped[int] = mapped_column(primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime, index=True)
    vehicle_id: Mapped[str] = mapped_column(String(40))
    unit: Mapped[str] = mapped_column(String(64))
    company: Mapped[str] = mapped_column(String(64), default="")
    rule: Mapped[str] = mapped_column(String(24), index=True)
    value: Mapped[str] = mapped_column(String(64), default="")
    message: Mapped[str] = mapped_column(String(240))
    acked: Mapped[bool] = mapped_column(Boolean, default=False)


class UnitDoc(OrgScoped, Base):
    """Documento adjunto de una unidad (fase H3, pestaña Attachments del
    perfil): copia del PM, copia del DOT, CAB card, registration, etc.
    El archivo vive en backend/uploads/units/<unit>/ (gitignored)."""
    __tablename__ = "unit_doc"

    id: Mapped[int] = mapped_column(primary_key=True)
    unit: Mapped[str] = mapped_column(String(64), index=True)
    kind: Mapped[str] = mapped_column(String(20), default="other")
    filename: Mapped[str] = mapped_column(String(140))
    stored: Mapped[str] = mapped_column(String(200))   # ruta relativa
    size: Mapped[int] = mapped_column(Integer, default=0)
    note: Mapped[str] = mapped_column(String(200), default="")
    uploaded_at: Mapped[datetime] = mapped_column(DateTime)


class MaintRecord(OrgScoped, Base):
    """Evento de mantenimiento por unidad (fase H1): kind 'pm' (servicio
    preventivo) o 'dot' (inspección anual DOT). Historial editable desde
    los dashboards gemelos PM/DOT; el más reciente por fecha manda."""
    __tablename__ = "maint_record"

    id: Mapped[int] = mapped_column(primary_key=True)
    unit: Mapped[str] = mapped_column(String(64), index=True)
    kind: Mapped[str] = mapped_column(String(8), index=True)   # pm | dot
    date: Mapped[str] = mapped_column(String(10))              # YYYY-MM-DD
    mileage: Mapped[int | None] = mapped_column(Integer, nullable=True)
    notes: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime)


class Vendor(OrgScoped, Base):
    """Proveedor de partes/servicios (fase H3, pestaña Vendors estilo
    Fullbay). El taller le compra partes; se referencia desde Part y, a
    futuro, desde las órdenes de compra."""
    __tablename__ = "vendor"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), index=True)
    contact: Mapped[str] = mapped_column(String(120), default="")
    phone: Mapped[str] = mapped_column(String(40), default="")
    email: Mapped[str] = mapped_column(String(120), default="")
    address: Mapped[str] = mapped_column(String(200), default="")
    account: Mapped[str] = mapped_column(String(60), default="")  # nº cuenta
    notes: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime)


class Part(OrgScoped, Base):
    """Parte del catálogo (fase H3, pestaña Parts estilo Fullbay). Costo
    INTERNO (lo que paga el taller; sin markup — decisión del usuario).
    `on_hand` es un conteo manual de inventario (sin auto-decremento aún).
    Se reusa al cargar líneas de una work order."""
    __tablename__ = "part"

    id: Mapped[int] = mapped_column(primary_key=True)
    part_number: Mapped[str] = mapped_column(String(60), index=True)
    description: Mapped[str] = mapped_column(String(160), default="")
    category: Mapped[str] = mapped_column(String(40), default="")
    cost: Mapped[float] = mapped_column(Float, default=0.0)
    vendor_id: Mapped[int | None] = mapped_column(
        ForeignKey("vendor.id"), nullable=True)
    on_hand: Mapped[float] = mapped_column(Float, default=0.0)
    notes: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime)


# ---------------------------------------------------------------------------
# Aislamiento por tenant (H6 fase 3c): enforcement a nivel ORM
# ---------------------------------------------------------------------------
# Estos dos eventos hacen que toda la data de negocio (tablas OrgScoped) se
# escriba y se lea acotada al tenant del request (tenant.get_current_org()).
# Cuando NO hay tenant en contexto (trabajos de fondo, scripts, seeding,
# arranque) no se completa ni se filtra: esos paths son server-side de
# confianza y deben fijar el contexto explicitamente si quieren acotar (p.ej.
# el loop de alertas). La red de seguridad a nivel base (RLS de Postgres)
# llega en la fase 3c-2, que necesita un Postgres vivo para validarse.

@event.listens_for(SessionLocal, "before_flush")
def _assign_org_on_insert(session, flush_context, instances):
    """Completa org_id en las filas nuevas OrgScoped desde el tenant del
    contexto (si hay). No pisa un org_id ya seteado a mano."""
    org = tenant.get_current_org()
    if org is None:
        return
    for obj in session.new:
        if isinstance(obj, OrgScoped) and obj.org_id is None:
            obj.org_id = org


@event.listens_for(SessionLocal, "do_orm_execute")
def _scope_select_to_org(execute_state):
    """Acota los SELECT de entidades OrgScoped al tenant del contexto. Sigue
    la receta de SQLAlchemy (with_loader_criteria), excluyendo cargas de
    columna/relacion para no sorprender en lazy-loads."""
    org = tenant.get_current_org()
    if org is None:
        return
    if (execute_state.is_select
            and not execute_state.is_column_load
            and not execute_state.is_relationship_load):
        execute_state.statement = execute_state.statement.options(
            with_loader_criteria(
                OrgScoped, lambda cls: cls.org_id == org,
                include_aliases=True))


Base.metadata.create_all(_engine)


DEFAULT_ORG_SLUG = "default"


def ensure_default_org() -> int:
    """Garantiza que exista la organizacion 'default' (modo single-tenant) y
    devuelve su id. Idempotente; corre en ambos motores al iniciar."""
    with SessionLocal() as session:
        org = session.scalar(select(Organization).where(
            Organization.slug == DEFAULT_ORG_SLUG))
        if org is None:
            org = Organization(slug=DEFAULT_ORG_SLUG, name="Default",
                               active=True, created_at=datetime.now())
            session.add(org)
            session.commit()
        return org.id


def default_org_id() -> int:
    """Id de la organizacion 'default'."""
    with SessionLocal() as session:
        return session.scalar(select(Organization.id).where(
            Organization.slug == DEFAULT_ORG_SLUG))


def _setting_org() -> int:
    """org del request actual, o la 'default' para paths sin contexto."""
    return tenant.get_current_org() or default_org_id()


def get_setting(key: str, legacy_file: Path | None = None) -> dict | None:
    """Config (dict) de `key` para el tenant actual, o None si no existe.

    Migracion transparente (H6 fase 3d): si no hay fila y se pasa el archivo
    *.local.json legacy, se importa UNA vez a la org 'default' (los datos
    single-tenant existentes le pertenecen) y se devuelve. Para otras orgs
    sin fila devuelve None (caen a los DEFAULTS del modulo consumidor)."""
    org = _setting_org()
    with SessionLocal() as session:
        row = session.get(OrgSetting, (org, key))
        blob = row.value_json if row is not None else None
    if blob is not None:
        try:
            return json.loads(blob)
        except ValueError:
            return None
    if (legacy_file is not None and org == default_org_id()
            and legacy_file.exists()):
        try:
            data = json.loads(legacy_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if isinstance(data, dict):
            save_setting(key, data)
            return data
    return None


def save_setting(key: str, value: dict) -> None:
    """Persiste el blob de config de `key` para el tenant actual."""
    org = _setting_org()
    blob = json.dumps(value, ensure_ascii=False)
    with SessionLocal() as session:
        row = session.get(OrgSetting, (org, key))
        if row is None:
            session.add(OrgSetting(org_id=org, key=key, value_json=blob))
        else:
            row.value_json = blob
        session.commit()


def _migrate() -> None:
    """Migraciones aditivas para SQLite (create_all no agrega columnas a
    tablas existentes). Idempotente: solo agrega lo que falte.

    Usa PRAGMA/ALTER especificos de SQLite y solo aplica a bases de
    desarrollo viejas. En Postgres el esquema lo maneja create_all (esquema
    nuevo) y, mas adelante, Alembic (H6 fase 2)."""
    with _engine.connect() as conn:
        cols = {r[1] for r in conn.exec_driver_sql(
            "PRAGMA table_info(work_order)").fetchall()}
        adds = {
            "invoiced_at": "DATETIME",
            "mileage": "INTEGER",
            "service_date": "VARCHAR(10)",
            "waiting_parts": "BOOLEAN DEFAULT 0",
            "campaign": "VARCHAR(12) DEFAULT ''",
            "invoice_number": "VARCHAR(40) DEFAULT ''",
            "po_number": "VARCHAR(60) DEFAULT ''",
            "authorizer": "VARCHAR(80) DEFAULT ''",
            "shop_invoice": "VARCHAR(60) DEFAULT ''",
        }
        for col, ddl in adds.items():
            if col not in cols:
                conn.exec_driver_sql(
                    f"ALTER TABLE work_order ADD COLUMN {col} {ddl}")
        # H2: waiting_parts deja de ser estado del pipeline; los WOs
        # viejos pasan a in_progress con el flag prendido.
        conn.exec_driver_sql(
            "UPDATE work_order SET status='in_progress', waiting_parts=1 "
            "WHERE status='waiting_parts'")
        # H3: el estado 'closed' se eliminó; invoiced es terminal.
        conn.exec_driver_sql(
            "UPDATE work_order SET status='invoiced' "
            "WHERE status='closed'")
        # H3b: el flag is_pm viejo pasa a la campaña 'pm'.
        conn.exec_driver_sql(
            "UPDATE work_order SET campaign='pm' "
            "WHERE is_pm=1 AND (campaign IS NULL OR campaign='')")
        # H3 (catálogo): la línea de WO puede referenciar una parte del
        # catálogo por su número (para reportes de gasto por parte/vendor).
        line_cols = {r[1] for r in conn.exec_driver_sql(
            "PRAGMA table_info(work_order_line)").fetchall()}
        if "part_number" not in line_cols:
            conn.exec_driver_sql(
                "ALTER TABLE work_order_line "
                "ADD COLUMN part_number VARCHAR(60) DEFAULT ''")
        # H6 fase 3: cada fila pertenece a una organizacion (tenant). El
        # usuario y las 11 tablas de datos llevan org_id; las DBs viejas no
        # tienen la columna, asi que se agrega y se backfillea a 'default'.
        # (poi queda global: datos publicos compartidos, ver modelo Poi.)
        oid = default_org_id()
        for table in ("user", "report_block", "block_driver", "defect",
                      "work_order", "work_order_line", "tms_driver",
                      "alert_event", "unit_doc", "maint_record", "vendor",
                      "part"):
            cols = {r[1] for r in conn.exec_driver_sql(
                f'PRAGMA table_info("{table}")').fetchall()}
            if "org_id" not in cols:
                conn.exec_driver_sql(
                    f'ALTER TABLE "{table}" ADD COLUMN org_id INTEGER '
                    'REFERENCES organization(id)')
            conn.exec_driver_sql(
                f'UPDATE "{table}" SET org_id = {oid} WHERE org_id IS NULL')
        conn.commit()


ensure_default_org()
if config.IS_SQLITE:
    _migrate()


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
