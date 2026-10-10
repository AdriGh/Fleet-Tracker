"""Capa de persistencia: SQLAlchemy sobre Postgres (produccion) o SQLite (dev).

El motor se elige por la variable de entorno DATABASE_URL (ver config.py);
si no esta seteada, se usa una SQLite local para desarrollo/tests.

Guarda cada bloque diario generado para alimentar el panel DVIR
(ultimos informes, top de conductores sin DVIR).
"""

import json
import os
import threading
from datetime import date, datetime
from pathlib import Path

from sqlalchemy import (
    Boolean, Date, DateTime, Float, ForeignKey, Index, Integer, String, Text,
    UniqueConstraint, create_engine, event, false, func, select, true,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import (
    DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker,
    with_loader_criteria,
)

from . import config
from .core import tenant

# SQLite necesita check_same_thread=False para usarse desde el threadpool de
# FastAPI; Postgres no acepta ese argumento.
_connect_args = {"check_same_thread": False} if config.IS_SQLITE else {}
_engine = create_engine(
    config.DATABASE_URL,
    connect_args=_connect_args,
    pool_pre_ping=True,    # DATA-7: descarta conexiones muertas (evita 5xx por
    pool_recycle=1800,     # 'SSL connection has been closed' tras idle en PG)
)
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
    # v2.16: nullable — un defecto puede nacer de un walkaround (source
    # 'walkaround'), sin bloque DVIR importado. Todo lo que la UI necesita
    # (company/fecha/driver/unit/detalle) vive denormalizado en esta fila,
    # así que un defecto sin bloque fluye igual por WO → warranty (la página
    # Defects se retiró en v2.23).
    # (v2.20: el walkaround se retiró; source + nullable se conservan por la
    # data de producción ya creada.)
    block_id: Mapped[int | None] = mapped_column(
        ForeignKey("report_block.id"), nullable=True)
    source: Mapped[str] = mapped_column(String(12), default="dvir")
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
    __table_args__ = (
        # DATA-4: un padre no puede tener dos hijas con el mismo ordinal
        # (#4.1 duplicado por carrera en child_seq). Las raíces (parent_id
        # NULL) quedan exentas: en SQL los NULL no colisionan entre sí.
        UniqueConstraint("parent_id", "child_seq", name="uq_wo_parent_child"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime)
    closed_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True)        # sello de COMPLETED (histórico)
    invoiced_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True)
    # Multi-unit (review v1.26): un invoice que cubre varias unidades se modela
    # como una orden PADRE (la unidad primaria) y N HIJAS (las otras unidades),
    # numeradas #4, #4.1, #4.2… `parent_id` apunta al padre (NULL si es la
    # raíz/orden normal); `child_seq` es el ordinal de la hija (1, 2, …) para
    # el número de display. Cada orden lleva SUS propias líneas (sin duplicar
    # el costo: la suma de padre+hijas = total del invoice).
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("work_order.id"), nullable=True, index=True)
    child_seq: Mapped[int] = mapped_column(Integer, default=0)
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
    # Outside work (v2.21, benchmark SquareRigger): 'inside' = trabajo del
    # taller propio (mecánico asignado); 'outside' = taller de terceros
    # (`vendor_id` = el shop; obligatorio para outside, opcional para inside).
    # Una WO outside NO exige mecánico y NO consume stock al facturar.
    wo_type: Mapped[str] = mapped_column(String(10), default="inside")
    vendor_id: Mapped[int | None] = mapped_column(
        ForeignKey("vendor.id", name="fk_work_order_vendor"),
        nullable=True, index=True)
    # v2.22: horas de motor de la unidad (reefer) al momento del servicio.
    # Las copia el Service Request de 'Reefer PM due' y, al FACTURAR una WO
    # de campaña 'reefer', alimentan el registro del PM (maint_record.hours).
    # Medidor propio: JAMÁS se compara contra el odómetro (mileage).
    engine_hours: Mapped[float | None] = mapped_column(Float, nullable=True)
    # v2.22 (Customers, benchmark SquareRigger "Bill to: Self | Customer"):
    # a quién se le cobra la WO. NULL = Self (gasto propio de la flota). Al
    # crear sin customer_id se toma el DUEÑO de la unidad (customer_unit).
    # Al FACTURAR por primera vez se congela el precio de cada línea
    # (WorkOrderLine.unit_price = costo × (1 + markup del customer)) y la
    # tasa de impuesto del customer (`tax_pct`: 0 si es exento; se aplica a
    # las partes facturadas). `payment_status` (unpaid|paid) + `paid_at` =
    # cobro al customer; el saldo abierto es facturado & unpaid.
    customer_id: Mapped[int | None] = mapped_column(
        ForeignKey("customer.id", name="fk_work_order_customer"),
        nullable=True, index=True)
    payment_status: Mapped[str] = mapped_column(
        String(12), default="unpaid", server_default="unpaid")
    paid_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    tax_pct: Mapped[float | None] = mapped_column(Float, nullable=True)

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
    # v2.22: precio de venta CONGELADO al facturar una WO con customer
    # (unit_cost × (1 + markup de partes/labor del customer)). NULL = sin
    # snapshot (WO de Self o todavía no facturada): el precio se calcula en
    # vivo. Nunca se recalcula después (cambiar el markup no reescribe
    # invoices viejos).
    unit_price: Mapped[float | None] = mapped_column(Float, nullable=True)

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
    # SEC-4: versión de credencial. El token de sesión la incluye; cambiar la
    # contraseña la incrementa → invalida los tokens emitidos antes (revocación).
    token_version: Mapped[int] = mapped_column(Integer, default=0)
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


class UnitPhoto(OrgScoped, Base):
    """Foto de identidad de una unidad (v2.13, elemento 05 del board de
    diseño): UNA por unidad — el hero del perfil y la tarjeta del Fleet.
    El archivo vive en backend/uploads/unit_photos/ (gitignored). En demo,
    las unidades sin foto caen a un asset de muestra (assets/demo_unit_photos)."""
    __tablename__ = "unit_photo"

    id: Mapped[int] = mapped_column(primary_key=True)
    unit: Mapped[str] = mapped_column(String(64), index=True)
    filename: Mapped[str] = mapped_column(String(140))
    stored: Mapped[str] = mapped_column(String(200))   # ruta relativa
    size: Mapped[int] = mapped_column(Integer, default=0)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime)


class EvidencePhoto(OrgScoped, Base):
    """Foto de evidencia de un defecto o Work Order (v2.14, elemento 01 del
    board de diseño). A diferencia de unit_photo (UNA por unidad), acá
    conviven VARIAS por padre: el driver documenta el defecto con 2-3 tomas
    y la WO cierra con el par antes/después. `parent`+`parent_id` apuntan al
    dueño ('defect' -> defect.id, 'wo' -> work_order.id); `phase` separa la
    foto del reporte ('report') del par de cierre ('before'/'after'). `unit`
    se denormaliza del padre para poder filtrar por unidad sin join. El
    archivo vive en backend/uploads/evidence/ (gitignored)."""
    __tablename__ = "evidence_photo"
    __table_args__ = (
        # El acceso típico es "todas las fotos de ESTE padre": índice
        # compuesto para que listar/contar no recorra los parciales.
        Index("ix_evidence_photo_parent_parent_id", "parent", "parent_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    parent: Mapped[str] = mapped_column(String(8), index=True)  # defect | wo
    parent_id: Mapped[int] = mapped_column(Integer, index=True)
    phase: Mapped[str] = mapped_column(
        String(8), default="report")       # report | before | after
    unit: Mapped[str] = mapped_column(String(64), default="")
    filename: Mapped[str] = mapped_column(String(140))
    stored: Mapped[str] = mapped_column(String(200))   # ruta relativa
    size: Mapped[int] = mapped_column(Integer, default=0)
    note: Mapped[str] = mapped_column(String(200), default="")
    uploaded_at: Mapped[datetime] = mapped_column(DateTime)


class MaintRecord(OrgScoped, Base):
    """Evento de mantenimiento por unidad (fase H1): kind 'pm' (servicio
    preventivo) o 'dot' (inspección anual DOT). Historial editable desde
    los dashboards gemelos PM/DOT; el más reciente por fecha manda.
    v2.22: `kind` acepta cualquier campaña de maint.CAMPAIGNS (incl.
    'reefer', String(16)) y `hours` guarda las horas de motor del servicio
    (campañas por horas: el PM del reefer). NUNCA se mezcla con `mileage`."""
    __tablename__ = "maint_record"

    id: Mapped[int] = mapped_column(primary_key=True)
    unit: Mapped[str] = mapped_column(String(64), index=True)
    kind: Mapped[str] = mapped_column(String(16), index=True)  # pm | dot | reefer…
    date: Mapped[str] = mapped_column(String(10))              # YYYY-MM-DD
    mileage: Mapped[int | None] = mapped_column(Integer, nullable=True)
    hours: Mapped[float | None] = mapped_column(Float, nullable=True)
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
    # Outside work (v2.21): qué es el vendor para el taller — '' (sin
    # clasificar) | 'parts' (vende partes) | 'shop' (taller externo que hace
    # trabajo outside) | 'both'. city/state ayudan al match del escáner
    # (dos Speedco en ciudades distintas son vendors distintos).
    kind: Mapped[str] = mapped_column(String(12), default="")
    city: Mapped[str] = mapped_column(String(80), default="")
    state: Mapped[str] = mapped_column(String(20), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime)


class Part(OrgScoped, Base):
    """Parte del catálogo (fase H3, pestaña Parts estilo Fullbay). Costo
    INTERNO (lo que paga el taller; sin markup — decisión del usuario).
    Inventario (fase Inventory): `on_hand` es la existencia cacheada, que
    se actualiza junto con cada movimiento (part_stock_movement); ya no es
    un conteo solo manual: las WO al facturar la consumen y las PO al
    recibir la reponen. `reorder_point` es el umbral de re-pedido: si
    on_hand <= reorder_point (con reorder_point > 0), la parte sale en la
    lista de low-stock. Se reusa al cargar líneas de una work order."""
    __tablename__ = "part"
    __table_args__ = (
        # DATA-4: una parte única por (organización, part_number). Backstop a
        # nivel BD de la dedup que ya hace create_part — evita filas duplicadas
        # por una carrera de creación concurrente.
        UniqueConstraint("org_id", "part_number", name="uq_part_org_pn"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    part_number: Mapped[str] = mapped_column(String(60), index=True)
    description: Mapped[str] = mapped_column(String(160), default="")
    category: Mapped[str] = mapped_column(String(40), default="")
    cost: Mapped[float] = mapped_column(Float, default=0.0)
    vendor_id: Mapped[int | None] = mapped_column(
        ForeignKey("vendor.id"), nullable=True)
    on_hand: Mapped[float] = mapped_column(Float, default=0.0)
    # Inventory: umbral de re-pedido = mínimo (0 = sin seguimiento de low-stock).
    reorder_point: Mapped[float] = mapped_column(Float, default=0.0)
    notes: Mapped[str] = mapped_column(String(300), default="")
    # Campos ricos del catálogo (fase Parts, v1.48). Aditivos: se agregan por
    # migración Alembic (batch_alter_table + server_default) — el deploy corre
    # `alembic upgrade head`, así que aparecen en la Postgres viva sin romper.
    manufacturer: Mapped[str] = mapped_column(String(80), default="")
    bin: Mapped[str] = mapped_column(String(40), default="")  # ubicación física
    max_qty: Mapped[float] = mapped_column(Float, default=0.0)  # stock objetivo
    # v2.22: avg_cost es un PROMEDIO PONDERADO MÓVIL real, mantenido en cada
    # recepción de PO (core/inventory): avg = (oh*avg + q*c)/(oh+q). Las
    # correcciones de costo post-recepción lo revalúan solo por la porción
    # todavía en stock. `last_cost` = costo (landed si lo hay) de la última
    # recepción; NULL = nunca se recibió por PO.
    avg_cost: Mapped[float] = mapped_column(Float, default=0.0)  # costo promedio
    last_cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    upc: Mapped[str] = mapped_column(String(40), default="")
    fits: Mapped[str] = mapped_column(String(200), default="")  # compatibilidad
    source: Mapped[str] = mapped_column(String(30), default="manual")  # origen
    # Core tracking (v2.5): depósito reembolsable del core por unidad. > 0 =
    # la parte lleva core (se debe devolver la unidad vieja al proveedor para
    # recuperar el depósito). 0 = sin core.
    core_charge: Mapped[float] = mapped_column(Float, default=0.0)
    # Warranty tracking (v2.6): ventana de garantía en meses. > 0 = si la misma
    # parte se reusa en la misma unidad dentro de esta ventana, se marca un
    # reclamo de garantía. 0 = sin seguimiento de garantía.
    warranty_months: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime)


class PartStockMovement(OrgScoped, Base):
    """Movimiento de inventario de una parte (fase Inventory): el LIBRO
    auditable de cada cambio de existencia. `on_hand` en Part es el cache;
    esta tabla es la fuente de verdad de POR QUÉ cambió.

    `delta` suma (recepción de PO) o resta (consumo de WO / ajuste). `reason`:
        po_receive   -> +stock al recibir una línea de PO
        po_unreceive -> -stock al des-recibir una línea (v2.22, delta negativo)
        po_cost_adj  -> delta 0: corrección de costo post-recepción (v2.22);
                        solo cambia VALOR (value_delta), nunca cantidad
        wo_consume   -> -stock al FACTURAR una WO (línea kind=part)
        manual       -> ajuste manual del usuario
    `ref_type`/`ref_id` identifican el origen exacto (p.ej. ref_type='po_line',
    ref_id='42:full'). El triple (reason, ref_type, ref_id) es ÚNICO por org
    (a nivel app, sin constraint de BD): así re-correr una transición NO
    duplica el movimiento (guard de idempotencia en core/inventory).
    v2.22 (costeo): `unit_cost` = costo unitario del evento (landed en las
    recepciones; avg vigente en consumos/ajustes), `value_delta` = impacto en
    $ del inventario, `actor` = quién lo hizo. NULL en filas pre-v2.22.
    org-scoped."""
    __tablename__ = "part_stock_movement"

    id: Mapped[int] = mapped_column(primary_key=True)
    part_number: Mapped[str] = mapped_column(String(60), index=True)
    delta: Mapped[float] = mapped_column(Float, default=0.0)
    reason: Mapped[str] = mapped_column(String(16), index=True)
    ref_type: Mapped[str] = mapped_column(String(20), default="")
    ref_id: Mapped[str] = mapped_column(String(40), default="")
    note: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime)
    unit_cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    value_delta: Mapped[float | None] = mapped_column(Float, nullable=True)
    actor: Mapped[str] = mapped_column(String(80), default="",
                                       server_default="")


class PurchaseOrder(OrgScoped, Base):
    """Orden de compra de partes a un vendor (QuickBuy, fase Increment B).

    Espeja el patrón de WorkOrder (org-scoped, líneas en cascada). Pipeline
    simple: draft -> ordered -> received. `total` se recalcula desde las
    líneas en el serializer (no se confía en el valor crudo). `vendor` es
    el NOMBRE del proveedor como texto libre (igual que el shop externo de
    una WO): basta para una primera versión, sin FK dura a Vendor."""
    __tablename__ = "purchase_order"

    id: Mapped[int] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime)
    vendor: Mapped[str] = mapped_column(String(120), default="", index=True)
    status: Mapped[str] = mapped_column(String(12), default="draft",
                                        index=True)   # draft|ordered|received
    notes: Mapped[str] = mapped_column(Text, default="")
    # Total cacheado (lo que muestra el listado); el serializer recalcula
    # desde las líneas para que sea siempre consistente.
    total: Mapped[float] = mapped_column(Float, default=0.0)
    # Recepción con backorders (v2.3): cuándo llegó completa (NULL = pendiente)
    # y, si es una PO de backorder auto-generada, a qué PO padre pertenece.
    # `backorder_of_po_id` es un Integer PLANO (no FK) a propósito: la app
    # siempre lo setea a un padre válido y así create_all y la migración
    # Alembic producen exactamente la misma columna (sin discrepancia de FK;
    # además una self-FK con nombre no es portable a SQLite en batch mode).
    received_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    backorder_of_po_id: Mapped[int | None] = mapped_column(
        Integer, nullable=True, index=True)
    # v2.22 (costeo post-recepción, benchmark SquareRigger): `status` sigue
    # siendo el ciclo de RECEPCIÓN (draft|ordered|received); `fin_status` es
    # el ciclo FINANCIERO aparte (open|closed). Cerrar NO bloquea nada: las
    # líneas y los ajustes siguen editables (nuestra ventaja sobre SR, que
    # obliga a reabrir). `vendor_id` liga al Vendor por nombre al crear; el
    # texto `vendor` se conserva (POs viejas / vendors sin ficha).
    fin_status: Mapped[str] = mapped_column(String(16), default="open",
                                            server_default="open")
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    invoice_no: Mapped[str] = mapped_column(String(40), default="",
                                            server_default="")
    invoice_date: Mapped[str] = mapped_column(String(10), default="",
                                              server_default="")  # YYYY-MM-DD
    tracking_no: Mapped[str] = mapped_column(String(60), default="",
                                             server_default="")
    # '' | invoice | paid | card | cash
    payment_method: Mapped[str] = mapped_column(String(20), default="",
                                                server_default="")
    vendor_id: Mapped[int | None] = mapped_column(
        ForeignKey("vendor.id"), nullable=True, index=True)

    lines: Mapped[list["POLine"]] = relationship(
        back_populates="po", cascade="all, delete-orphan")
    adjustments: Mapped[list["PoAdjustment"]] = relationship(
        back_populates="po", cascade="all, delete-orphan",
        order_by="PoAdjustment.id")


class POLine(OrgScoped, Base):
    """Línea de una orden de compra: una parte (qty × costo unitario).
    Espeja WorkOrderLine; `part_number` referencia el catálogo Part.

    v2.22: `taxable` marca la línea como gravada (el ajuste de tax con
    allocate se reparte solo entre las gravadas, si hay alguna);
    `landed_unit_cost` = unit_cost + su parte prorrateada de los ajustes que
    se asignan al costo (descuento/crédito/flete/tax/fee). NULL = sin
    prorrateo (el costo efectivo es unit_cost)."""
    __tablename__ = "po_line"

    id: Mapped[int] = mapped_column(primary_key=True)
    po_id: Mapped[int] = mapped_column(ForeignKey("purchase_order.id"))
    part_number: Mapped[str] = mapped_column(String(60), default="")
    description: Mapped[str] = mapped_column(String(160), default="")
    qty: Mapped[float] = mapped_column(Float, default=1.0)
    unit_cost: Mapped[float] = mapped_column(Float, default=0.0)
    # Recepción parcial (v2.3): qty acumulada recibida (0 = nada; == qty =
    # completa; entre medio = parcial → el faltante va a una PO de backorder).
    qty_received: Mapped[float] = mapped_column(Float, default=0.0)
    received_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    taxable: Mapped[bool] = mapped_column(Boolean, default=False,
                                          server_default=false())
    landed_unit_cost: Mapped[float | None] = mapped_column(Float,
                                                           nullable=True)

    po: Mapped[PurchaseOrder] = relationship(back_populates="lines")


class PoAdjustment(OrgScoped, Base):
    """Ajuste financiero de una PO (v2.22): descuento, crédito, flete, tax,
    fee o pago. `amount` siempre > 0; el signo lo da `kind` (discount/credit
    restan, shipping/tax/fee suman, payment reduce el saldo). `allocate`
    (no aplica a payment) lo reparte en el landed cost de las líneas y
    revalúa lo ya recibido. Nunca se borra: se ANULA (voided_at +
    void_reason) para conservar el rastro. Se permite en cualquier status /
    fin_status. org-scoped."""
    __tablename__ = "po_adjustment"

    id: Mapped[int] = mapped_column(primary_key=True)
    po_id: Mapped[int] = mapped_column(
        ForeignKey("purchase_order.id", ondelete="CASCADE"), index=True)
    # discount | credit | shipping | tax | fee | payment
    kind: Mapped[str] = mapped_column(String(12))
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    note: Mapped[str] = mapped_column(String(200), default="")
    allocate: Mapped[bool] = mapped_column(Boolean, default=False,
                                           server_default=false())
    actor: Mapped[str] = mapped_column(String(80), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime)
    voided_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    void_reason: Mapped[str] = mapped_column(String(200), default="")

    po: Mapped[PurchaseOrder] = relationship(back_populates="adjustments")


class AuditEvent(OrgScoped, Base):
    """Rastro de auditoría GENÉRICO (v2.22): quién cambió qué, cuándo, y de
    qué valor a cuál. `entity` = 'po' | 'po_line' | 'part' | … (reusable por
    otros módulos); `entity_id` es texto (ids numéricos, part_numbers o
    compuestos como '<po_id>:<line_id>' para que la historia de una PO se lea
    con un solo prefijo). Solo se inserta; nunca se edita. org-scoped."""
    __tablename__ = "audit_event"
    __table_args__ = (
        Index("ix_audit_event_entity", "entity", "entity_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    entity: Mapped[str] = mapped_column(String(20))
    entity_id: Mapped[str] = mapped_column(String(40))
    action: Mapped[str] = mapped_column(String(30))
    field: Mapped[str] = mapped_column(String(40), default="")
    old: Mapped[str] = mapped_column(String(200), default="")
    new: Mapped[str] = mapped_column(String(200), default="")
    actor: Mapped[str] = mapped_column(String(80), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime)


class CoreItem(OrgScoped, Base):
    """Core pendiente de devolver (v2.5, el moat de core tracking).

    Al recibir una PO de una parte con `core_charge > 0`, se crea un CoreItem
    por evento de recepción: representa las unidades viejas ("cores") que hay
    que **devolver al proveedor** para recuperar el depósito. `status`:
        pending   -> el core sigue en el taller (depósito afuera)
        returned  -> se devolvió al proveedor y se recuperó el crédito
    Idempotente por `ref` (= el ref_id del movimiento de stock que lo originó):
    re-recibir la misma PO NO duplica el core. org-scoped."""
    __tablename__ = "core_item"

    id: Mapped[int] = mapped_column(primary_key=True)
    part_number: Mapped[str] = mapped_column(String(60), index=True)
    description: Mapped[str] = mapped_column(String(160), default="")
    vendor: Mapped[str] = mapped_column(String(120), default="")
    # Depósito por unidad (snapshot del core_charge de la parte al recibir) y
    # cantidad de cores (unidades) de este evento.
    core_charge: Mapped[float] = mapped_column(Float, default=0.0)
    qty: Mapped[float] = mapped_column(Float, default=1.0)
    po_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ref: Mapped[str] = mapped_column(String(60), default="", index=True)
    status: Mapped[str] = mapped_column(String(12), default="pending",
                                        index=True)  # pending | returned
    created_at: Mapped[datetime] = mapped_column(DateTime)
    returned_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True)


class WarrantyClaim(OrgScoped, Base):
    """Reclamo de garantía (v2.6, moat de warranty tracking).

    Se detecta cuando la MISMA parte (con `warranty_months > 0`) se reusa en la
    MISMA unidad dentro de la ventana de garantía de su instalación previa: la
    parte falló prematuramente y el proveedor debería cubrir el reemplazo.
    Idempotente por `ref` (= '{failure_wo}:{part_number}'): re-escanear no
    duplica. `status`: open -> submitted -> recovered | dismissed. org-scoped."""
    __tablename__ = "warranty_claim"

    id: Mapped[int] = mapped_column(primary_key=True)
    part_number: Mapped[str] = mapped_column(String(60), index=True)
    description: Mapped[str] = mapped_column(String(160), default="")
    unit: Mapped[str] = mapped_column(String(64), index=True)
    vendor: Mapped[str] = mapped_column(String(120), default="")
    install_wo: Mapped[int | None] = mapped_column(Integer, nullable=True)
    install_date: Mapped[str] = mapped_column(String(10), default="")
    failure_wo: Mapped[int | None] = mapped_column(Integer, nullable=True)
    failure_date: Mapped[str] = mapped_column(String(10), default="")
    warranty_until: Mapped[str] = mapped_column(String(10), default="")
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    ref: Mapped[str] = mapped_column(String(80), default="", index=True)
    # open | submitted | recovered | dismissed
    status: Mapped[str] = mapped_column(String(12), default="open", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime)


class OdometerReading(OrgScoped, Base):
    """Lectura de odómetro por unidad y fecha (v2.8, habilitador del CPM).

    Serie temporal del odómetro para poder computar "millas manejadas en un
    período" = odo_fin − odo_inicio (el denominador del cost-per-mile). Se
    llena por dos vías:
      - BACKFILL de los `mileage` ya capturados en WorkOrder y MaintRecord
        (source 'wo' / 'maint'): historial real que ya existe, da CPM desde ya.
      - SNAPSHOT diario del odómetro de Samsara (source 'samsara') en el loop
        de alertas. No hay backfill posible antes del primer snapshot.
    Idempotente: UNA lectura por (org, unit, date, source) — re-snapshotear o
    re-backfillear el mismo día no duplica. org-scoped (multi-tenant).
    NOTA: los trailers no tienen odómetro (no aplican al CPM/milla)."""
    __tablename__ = "odometer_reading"

    id: Mapped[int] = mapped_column(primary_key=True)
    unit: Mapped[str] = mapped_column(String(64), index=True)
    date: Mapped[str] = mapped_column(String(10), index=True)    # YYYY-MM-DD
    miles: Mapped[int] = mapped_column(Integer)                  # odómetro (mi)
    # samsara | wo | maint  (de dónde vino la lectura)
    source: Mapped[str] = mapped_column(String(16), default="samsara")
    created_at: Mapped[datetime] = mapped_column(DateTime)

    __table_args__ = (
        UniqueConstraint("org_id", "unit", "date", "source",
                         name="uq_odo_org_unit_date_source"),
    )


class MeterReading(OrgScoped, Base):
    """Lectura de un medidor NO-odómetro por unidad y fecha (v2.22): hoy solo
    'engine_hours' (horas de motor del reefer). Tabla APARTE de
    `odometer_reading` a propósito: el CPM lee el odómetro sin filtro de
    tipo, y mezclar horas con millas es justo el error de SquareRigger (que
    vence el PM de horas contra el odómetro).

    `source`: manual | wo | maint | lynx | thermoking | traccar | demo.
    UNA lectura por (org, unit, meter, date, source): re-registrar el mismo
    día y fuente es una CORRECCIÓN (core/meters.log_reading), no un
    duplicado. Las unidades se comparan normalizadas (core/meters.norm_unit,
    misma regla que Service Requests). org-scoped.

    `is_reset`: lectura forzada MÁS BAJA que la vigente (cambio de
    controlador / horómetro reseteado) = inicio de un tramo nuevo del
    medidor; las lecturas del tramo anterior dejan de contar como vigentes
    (core/meters._segment)."""
    __tablename__ = "meter_reading"

    id: Mapped[int] = mapped_column(primary_key=True)
    unit: Mapped[str] = mapped_column(String(64), index=True)
    meter: Mapped[str] = mapped_column(String(16), default="engine_hours")
    date: Mapped[str] = mapped_column(String(10), index=True)    # YYYY-MM-DD
    value: Mapped[float] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String(16), default="manual")
    created_at: Mapped[datetime] = mapped_column(DateTime)
    is_reset: Mapped[bool] = mapped_column(Boolean, default=False,
                                           server_default=false())

    __table_args__ = (
        UniqueConstraint("org_id", "unit", "meter", "date", "source",
                         name="uq_meter_org_unit_meter_date_source"),
    )


class PartsRequest(OrgScoped, Base):
    """Pedido de parte pendiente de compra (fase Purchasing / Increment 4).

    Un faltante —de bajo stock (auto), de una work order, o manual— que espera
    ser AGRUPADO por vendor en una orden de compra. El parts manager selecciona
    varios del mismo vendor y los funde en una sola PO. `status`:
        pending   -> aún sin comprar (aparece en la cola de Requests)
        ordered   -> ya entró en una PO (po_id la liga)
        cancelled -> descartado
    `source`: low_stock | wo | manual. `source_ref` da el origen legible
    (p.ej. 'WO #3'). org-scoped (multi-tenant)."""
    __tablename__ = "parts_request"

    id: Mapped[int] = mapped_column(primary_key=True)
    part_number: Mapped[str] = mapped_column(String(60), default="", index=True)
    description: Mapped[str] = mapped_column(String(160), default="")
    qty: Mapped[float] = mapped_column(Float, default=1.0)
    unit_cost: Mapped[float] = mapped_column(Float, default=0.0)
    vendor: Mapped[str] = mapped_column(String(120), default="", index=True)
    source: Mapped[str] = mapped_column(String(20), default="manual")
    source_ref: Mapped[str] = mapped_column(String(60), default="")
    requested_by: Mapped[str] = mapped_column(String(60), default="")
    status: Mapped[str] = mapped_column(String(12), default="pending",
                                        index=True)
    po_id: Mapped[int | None] = mapped_column(
        ForeignKey("purchase_order.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime)


class RoleScope(OrgScoped, Base):
    """Override por-org de la matriz RBAC (Increment 5b, RBAC editable).

    Cada fila = un `scope` concedido a un `role` EN ESTA ORG. Si la org tiene
    AL MENOS una fila (incluida la fila marcador `__custom__`/`__custom__`),
    su matriz es AUTORITATIVA: los roles sin filas quedan sin scopes. Si la
    org no tiene ninguna fila, se usan los defaults hardcodeados de
    `core/permissions.ROLE_SCOPES`. `admin` NUNCA se guarda (siempre tiene
    todo, no editable). org-scoped (multi-tenant)."""
    __tablename__ = "role_scope"

    id: Mapped[int] = mapped_column(primary_key=True)
    role: Mapped[str] = mapped_column(String(30), index=True)
    scope: Mapped[str] = mapped_column(String(30))


class Unit(OrgScoped, Base):
    """Unidad agregada a mano (Fleet -> Add New Unit). Complementa el fleet
    vivo de Samsara para terminales/clientes que no estan en Samsara, y
    alimenta los trackers PM/DOT. Clave de negocio: `unit` (numero de unidad)
    unico por organizacion. org-scoped (multi-tenant, H6 fase 3)."""
    __tablename__ = "unit"

    id: Mapped[int] = mapped_column(primary_key=True)
    unit: Mapped[str] = mapped_column(String(64), index=True)   # numero de unidad
    unit_type: Mapped[str] = mapped_column(String(16), default="truck")  # truck|trailer|chassis
    subtype: Mapped[str] = mapped_column(String(40), default="")
    terminal: Mapped[str] = mapped_column(String(40), default="")  # key de terminal (ex-nickname)
    customer: Mapped[str] = mapped_column(String(120), default="")
    company: Mapped[str] = mapped_column(String(64), default="")
    vin: Mapped[str] = mapped_column(String(20), default="")
    year: Mapped[str] = mapped_column(String(8), default="")
    make: Mapped[str] = mapped_column(String(60), default="")
    model: Mapped[str] = mapped_column(String(60), default="")
    fleet_no: Mapped[str] = mapped_column(String(40), default="")
    plate: Mapped[str] = mapped_column(String(20), default="")
    plate_state: Mapped[str] = mapped_column(String(8), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime)


class Customer(OrgScoped, Base):
    """Customer del taller (v2.22, Resources → Customers; benchmark
    SquareRigger). El caso real del dueño: owner-operators cuyos camiones
    reciben partes/labor del taller que después se les COBRAN. `kind`:
    owner_operator | carrier | external.

    Pricing: `parts_markup_pct` / `labor_markup_pct` se aplican sobre el
    costo de las líneas al facturar (snapshot en WorkOrderLine.unit_price).
    `terms`: '' | cod | net7 | net15 | net30 | 2_10_net30 | prepay.
    `driver_name` es un vínculo BLANDO a TmsDriver.name (sin FK: el roster
    vive en Samsara). email/phone/address son PII: salen enmascarados sin
    `pii.view`. Nombre único por org (case-insensitive) a nivel app
    (core/customers). Borrado: suave (active=False) si tiene WOs.
    org-scoped."""
    __tablename__ = "customer"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(160), index=True)
    kind: Mapped[str] = mapped_column(String(20), default="owner_operator")
    active: Mapped[bool] = mapped_column(Boolean, default=True,
                                         server_default=true())
    since: Mapped[str | None] = mapped_column(String(10), nullable=True)
    email: Mapped[str] = mapped_column(String(120), default="")
    phone: Mapped[str] = mapped_column(String(40), default="")
    address: Mapped[str] = mapped_column(String(200), default="")
    city: Mapped[str] = mapped_column(String(80), default="")
    state: Mapped[str] = mapped_column(String(20), default="")
    zip: Mapped[str] = mapped_column(String(12), default="")
    terms: Mapped[str] = mapped_column(String(20), default="")
    labor_markup_pct: Mapped[float] = mapped_column(Float, default=0.0)
    parts_markup_pct: Mapped[float] = mapped_column(Float, default=0.0)
    tax_exempt: Mapped[bool] = mapped_column(Boolean, default=False,
                                             server_default=false())
    tax_rate_pct: Mapped[float] = mapped_column(Float, default=0.0)
    accounting_id: Mapped[str] = mapped_column(String(60), default="")
    driver_name: Mapped[str] = mapped_column(String(120), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    tags: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime)

    contacts: Mapped[list["CustomerContact"]] = relationship(
        back_populates="customer", cascade="all, delete-orphan",
        order_by="CustomerContact.id")
    units: Mapped[list["CustomerUnit"]] = relationship(
        back_populates="customer", cascade="all, delete-orphan",
        order_by="CustomerUnit.id")


class CustomerContact(OrgScoped, Base):
    """Contacto de un customer (v2.22). `is_billing` marca el contacto de
    facturación (a lo sumo uno por customer; el Bill-To del invoice lo usa
    para el email/teléfono). email/phone = PII. org-scoped."""
    __tablename__ = "customer_contact"

    id: Mapped[int] = mapped_column(primary_key=True)
    customer_id: Mapped[int] = mapped_column(
        ForeignKey("customer.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120), default="")
    role: Mapped[str] = mapped_column(String(60), default="")
    email: Mapped[str] = mapped_column(String(120), default="")
    phone: Mapped[str] = mapped_column(String(40), default="")
    is_billing: Mapped[bool] = mapped_column(Boolean, default=False,
                                             server_default=false())

    customer: Mapped[Customer] = relationship(back_populates="contacts")


class CustomerUnit(OrgScoped, Base):
    """Unidad que pertenece a un customer (v2.22): el owner-operator dueño
    del camión/trailer. UN dueño por unidad (comparación normalizada:
    mayúsculas sin espacios, la regla de Service Requests), garantizado a
    nivel app (core/customers.set_unit MUEVE la propiedad). `unit` guarda la
    grafía de la flota; puede ser una unidad que no está en Samsara. La WO
    nueva de una unidad con dueño nace con ese customer. org-scoped."""
    __tablename__ = "customer_unit"

    id: Mapped[int] = mapped_column(primary_key=True)
    customer_id: Mapped[int] = mapped_column(
        ForeignKey("customer.id", ondelete="CASCADE"), index=True)
    unit: Mapped[str] = mapped_column(String(64), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime)

    customer: Mapped[Customer] = relationship(back_populates="units")


class SavedReport(OrgScoped, Base):
    """Reporte guardado por un usuario (v2.22, Reports estilo SquareRigger).

    `spec_json` es un ReportSpec (core/report_engine) serializado: fuente,
    columnas, filtros, rango de tiempo, agrupado, orden, límite, totales y
    gráfico. `visibility`: 'mine' (solo el dueño lo ve) | 'org' (toda la
    organización; crearlo/editarlo exige maint.edit). `based_on` = slug del
    reporte de sistema del que se clonó ("Save as mine"), o ''. Los reportes
    de SISTEMA no viven acá: están en código (core/report_library).
    org-scoped."""
    __tablename__ = "saved_report"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(160))
    description: Mapped[str] = mapped_column(Text, default="")
    owner_user_id: Mapped[int | None] = mapped_column(Integer, nullable=True,
                                                      index=True)
    visibility: Mapped[str] = mapped_column(String(8), default="mine")
    spec_json: Mapped[str] = mapped_column(Text)
    based_on: Mapped[str] = mapped_column(String(80), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime)


class ReportFavorite(OrgScoped, Base):
    """Reporte marcado con ★ por un usuario (v2.22). `report_ref` =
    'sys:<slug>' (reporte de sistema) o 'saved:<id>' (guardado). Único por
    (org, usuario, ref). org-scoped."""
    __tablename__ = "report_favorite"
    __table_args__ = (
        UniqueConstraint("org_id", "user_id", "report_ref",
                         name="uq_report_favorite_org_user_ref"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    report_ref: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime)


class ReportSchedule(OrgScoped, Base):
    """Envío programado de un reporte por email (v2.22). `report_ref` como en
    ReportFavorite; `version` = versión del reporte de sistema ('' = la por
    defecto). `cadence` daily|weekly|monthly a la hora `hour` (0-23, zona de
    la org); `weekday` 0=lunes (weekly) / `day_of_month` 1-31 (monthly, se
    recorta al último día del mes). `next_run_at` es NAIVE en hora del
    servidor (como el resto de los DateTime): el scheduler (core/
    report_schedules.maybe_run) la RECLAMA con un UPDATE condicional antes de
    enviar, así dos workers nunca mandan el mismo envío. `last_status`:
    sent | dry_run (mailer en modo simulado / sin configurar) | error | ''.
    org-scoped."""
    __tablename__ = "report_schedule"

    id: Mapped[int] = mapped_column(primary_key=True)
    report_ref: Mapped[str] = mapped_column(String(100))
    version: Mapped[str] = mapped_column(String(40), default="")
    name: Mapped[str] = mapped_column(String(160), default="")
    cadence: Mapped[str] = mapped_column(String(10), default="weekly")
    weekday: Mapped[int | None] = mapped_column(Integer, nullable=True)
    day_of_month: Mapped[int | None] = mapped_column(Integer, nullable=True)
    hour: Mapped[int] = mapped_column(Integer, default=7)
    recipients: Mapped[str] = mapped_column(Text, default="")
    format: Mapped[str] = mapped_column(String(8), default="csv")
    active: Mapped[bool] = mapped_column(Boolean, default=True,
                                         server_default=true())
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime,
                                                         nullable=True)
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime,
                                                         nullable=True,
                                                         index=True)
    last_status: Mapped[str] = mapped_column(String(20), default="",
                                             server_default="")
    last_error: Mapped[str] = mapped_column(String(300), default="",
                                            server_default="")
    created_by: Mapped[str] = mapped_column(String(80), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime)


class ServiceRequest(OrgScoped, Base):
    """Service Request (v2.20, benchmark SquareRigger): el BACKLOG por unidad
    desde el que se despacha el taller. Unifica en una sola cola:
      - defectos DVIR abiertos (source 'defect', materializados del feed de
        Samsara/CSV por core/service_requests.sync),
      - PM y DOT vencidos o por vencer (source 'pm' | 'dot', de maint.board),
      - pedidos manuales (source 'manual').
    Cada item se Deniega, se Pospone (snooze), se suma a una WO existente o
    se agrupa con otros de la misma unidad en una WO nueva. `source_key` es la
    clave estable de dedupe (idempotencia del sync), única por organización.

    status: open | snoozed | on_wo | done | denied | deleted (borrado suave,
    v2.20 addendum: no se lista ni se cuenta; restore lo devuelve a open).
    resolution: '' | wo (la WO se completó) | cleared (la fuente desapareció)
    | denied | deleted. `wo_id` sin FK (como las demás tablas hijas): borrar la WO no
    debe romper el historial; el hook de delete_wo re-abre el request.
    `meta` es JSON (vencimiento, reports, dvir_type, model…). org-scoped."""
    __tablename__ = "service_request"
    __table_args__ = (
        UniqueConstraint("org_id", "source_key",
                         name="uq_service_request_org_key"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    unit: Mapped[str] = mapped_column(String(64), index=True)
    company: Mapped[str] = mapped_column(String(64), default="")
    # defect | pm | dot | manual
    source: Mapped[str] = mapped_column(String(12), index=True)
    source_key: Mapped[str] = mapped_column(String(120), index=True)
    title: Mapped[str] = mapped_column(String(160))
    detail: Mapped[str] = mapped_column(Text, default="")
    # low | normal | urgent | emergency
    priority: Mapped[str] = mapped_column(String(12), default="normal")
    status: Mapped[str] = mapped_column(String(12), default="open",
                                        index=True)
    wo_id: Mapped[int | None] = mapped_column(Integer, nullable=True,
                                              index=True)
    resolution: Mapped[str] = mapped_column(String(20), default="")
    meta: Mapped[str] = mapped_column(Text, default="{}")
    # False cuando la fuente (defecto/PM/DOT) dejó de aparecer en el sync.
    source_active: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default=true())
    snooze_until: Mapped[str | None] = mapped_column(
        String(10), nullable=True)                  # YYYY-MM-DD
    follow_up_date: Mapped[str | None] = mapped_column(
        String(10), nullable=True)                  # YYYY-MM-DD
    deny_reason: Mapped[str] = mapped_column(String(200), default="")
    created_by: Mapped[str] = mapped_column(String(80), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime)
    resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True)
    source_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True)


# ---------------------------------------------------------------------------
# LEGACY (v2.20): Driver Workflows (v2.15) y Walkaround (v2.16) se retiraron
# del producto (UI, rutas y core). Los modelos y sus tablas se CONSERVAN a
# propósito: así no se destruye data de producción y el autogenerate de
# Alembic sigue consistente con el esquema real (sin un DROP accidental).
# No agregar lógica nueva sobre estas tablas.
# ---------------------------------------------------------------------------
class Workflow(OrgScoped, Base):
    """Workflow de inspección del driver (v2.15, elemento 03 del board):
    el pre-trip que el manager arma para SU flota (reefer, flatbed, tanker
    inspeccionan distinto). UN workflow activo por organización — el driver
    no elige, recibe EL pre-trip de su flota; el walkaround móvil (v2.16)
    consumirá el activo vía /api/workflows/active. Pasos en workflow_step
    (padre+hijas, como WorkOrder+WorkOrderLine)."""
    __tablename__ = "workflow"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    active: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime)


class WorkflowStep(OrgScoped, Base):
    """Paso tipado de un workflow: `type` check|photo|read|sign (validado en
    core/workflows.py). `pos` es el orden que el driver recorre; el guardado
    replace-all lo reescribe secuencial. `required` bloquea el submit del
    walkaround. Sin FK a workflow: las hijas se reemplazan en bloque por
    workflow_id, no se navegan por relación."""
    __tablename__ = "workflow_step"

    id: Mapped[int] = mapped_column(primary_key=True)
    workflow_id: Mapped[int] = mapped_column(Integer, index=True)
    pos: Mapped[int] = mapped_column(Integer)
    type: Mapped[str] = mapped_column(String(8))
    label: Mapped[str] = mapped_column(String(120))
    required: Mapped[bool] = mapped_column(Boolean, default=False)


class Walkaround(OrgScoped, Base):
    """Corrida de walkaround (v2.16, elemento 02 del board): un driver
    recorriendo el pre-trip de su flota en el teléfono. Los pasos son un
    SNAPSHOT del workflow activo al arrancar (walkaround_step): si el manager
    edita el workflow a mitad de corrida, la corrida no se mueve. Al submit
    se materializa todo: defectos (tabla defect, source 'walkaround') con sus
    fotos re-parentadas, odómetro (log_reading) y firma."""
    __tablename__ = "walkaround"

    id: Mapped[int] = mapped_column(primary_key=True)
    unit: Mapped[str] = mapped_column(String(64), index=True)
    driver: Mapped[str] = mapped_column(String(128))
    company: Mapped[str] = mapped_column(String(64), default="")
    workflow_id: Mapped[int] = mapped_column(Integer)
    workflow_name: Mapped[str] = mapped_column(String(80))
    status: Mapped[str] = mapped_column(String(12), default="in_progress")
    started_at: Mapped[datetime] = mapped_column(DateTime)
    submitted_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True)
    defects_created: Mapped[int] = mapped_column(Integer, default=0)


class WalkaroundStep(OrgScoped, Base):
    """Paso de UNA corrida (snapshot del workflow + resultado del driver).
    Las fotos del paso cuelgan de evidence (parent 'walkstep'); si el paso
    termina en defecto, el submit las re-parenta al defect creado — la foto
    sigue al objeto accionable (WO, warranty), y las de pasos OK quedan acá
    como prueba de que el walkaround ocurrió de verdad."""
    __tablename__ = "walkaround_step"

    id: Mapped[int] = mapped_column(primary_key=True)
    walkaround_id: Mapped[int] = mapped_column(Integer, index=True)
    pos: Mapped[int] = mapped_column(Integer)
    type: Mapped[str] = mapped_column(String(8))
    label: Mapped[str] = mapped_column(String(120))
    required: Mapped[bool] = mapped_column(Boolean, default=False)
    verdict: Mapped[str] = mapped_column(String(8), default="")
    value: Mapped[str] = mapped_column(String(40), default="")
    note: Mapped[str] = mapped_column(String(300), default="")


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


# Un lock de proceso por (org, key) para update_setting: serializa los
# escritores del mismo uvicorn (threadpool). Ver update_setting.
_SETTING_LOCKS_GUARD = threading.Lock()
_SETTING_LOCKS: dict[tuple[int, str], threading.Lock] = {}


def _setting_lock(org: int, key: str) -> threading.Lock:
    with _SETTING_LOCKS_GUARD:
        return _SETTING_LOCKS.setdefault((org, key), threading.Lock())


def update_setting(key: str, fn) -> dict:
    """Read-modify-write ATÓMICO del blob de config `key` del tenant actual.

    `fn(data | None) -> dict` recibe el valor guardado y devuelve el nuevo;
    lectura, mutación y escritura ocurren en UNA transacción con la fila
    org_setting bloqueada (SELECT ... FOR UPDATE: efectivo en Postgres, no-op
    en SQLite) y bajo un lock de proceso por (org, key), que serializa los
    escritores concurrentes del mismo uvicorn (en la SQLite de dev el FOR
    UPDATE no existe y dos lecturas seguidas de dos escrituras perdían una;
    con un solo worker el lock alcanza). Mismo patrón que bump_invoice_number
    (DATA-2). Si `fn` lanza, no se escribe nada y la excepción sube. Si el
    valor no cambia (fn devuelve lo mismo) y la fila ya existe, no se
    escribe. Devuelve el valor nuevo."""
    org = _setting_org()
    with _setting_lock(org, key):
        for attempt in (0, 1):
            with SessionLocal() as session:
                row = session.get(OrgSetting, (org, key),
                                  with_for_update=True)
                data = None
                if row is not None:
                    try:
                        data = json.loads(row.value_json)
                    except ValueError:
                        data = None
                new = fn(data)
                if row is not None and new == data:
                    return new
                blob = json.dumps(new, ensure_ascii=False)
                if row is None:
                    session.add(OrgSetting(org_id=org, key=key,
                                           value_json=blob))
                else:
                    row.value_json = blob
                try:
                    session.commit()
                except IntegrityError:
                    # Otro proceso creó la fila a la vez (PK): la segunda
                    # vuelta ya la encuentra y la bloquea.
                    session.rollback()
                    if attempt:
                        raise
                    continue
                return new
    return new                        # pragma: no cover (el for siempre sale)


def bump_invoice_number(default_start: int = 1001) -> int:
    """Toma el próximo número de invoice y AVANZA el contador de forma ATÓMICA
    (DATA-2). Bloquea la fila org_setting('org_config') con SELECT ... FOR
    UPDATE y hace leer-incrementar-escribir en UNA transacción, para que dos
    facturaciones concurrentes NO obtengan el mismo número (antes el
    read-modify-write sobre el JSON no tenía lock -> facturas duplicadas, un
    problema contable serio). Devuelve el entero crudo (sin prefijo). El
    `with_for_update` es no-op en SQLite (dev, single-writer) y efectivo en
    Postgres (prod)."""
    org = _setting_org()
    with SessionLocal() as session:
        row = session.get(OrgSetting, (org, "org_config"),
                          with_for_update=True)
        if row is None:
            n = default_start
            session.add(OrgSetting(
                org_id=org, key="org_config",
                value_json=json.dumps({"invoice": {"next_number": n + 1}},
                                      ensure_ascii=False)))
            session.commit()
            return n
        try:
            data = json.loads(row.value_json)
        except ValueError:
            data = {}
        inv = data.get("invoice") or {}
        n = int(inv.get("next_number", default_start) or default_start)
        inv["next_number"] = n + 1
        data["invoice"] = inv
        row.value_json = json.dumps(data, ensure_ascii=False)
        session.commit()
        return n


def _migrate() -> None:
    """Migraciones aditivas para SQLite (create_all no agrega columnas a
    tablas existentes). Idempotente: solo agrega lo que falte.

    Usa PRAGMA/ALTER especificos de SQLite y solo aplica a bases de
    desarrollo viejas. En Postgres el esquema lo maneja **Alembic**
    (`alembic upgrade head`), no este _migrate()."""
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
            # Multi-unit (v1.26): jerarquía padre/hija para invoices que
            # cubren varias unidades (#4 / #4.1).
            "parent_id": "INTEGER REFERENCES work_order(id)",
            "child_seq": "INTEGER DEFAULT 0",
            # Outside work (v2.21): paridad con la migración Alembic
            # d0e1f2a3b4c5 (inside|outside + taller externo).
            "wo_type": "VARCHAR(10) DEFAULT 'inside'",
            "vendor_id": "INTEGER REFERENCES vendor(id)",
        }
        for col, ddl in adds.items():
            if col not in cols:
                conn.exec_driver_sql(
                    f"ALTER TABLE work_order ADD COLUMN {col} {ddl}")
        conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_work_order_vendor_id "
            "ON work_order (vendor_id)")
        # Outside work (v2.21): el vendor gana tipo + ciudad/estado (paridad
        # con d0e1f2a3b4c5). La tabla ya existe, así que create_all no los
        # agrega.
        vendor_cols = {r[1] for r in conn.exec_driver_sql(
            "PRAGMA table_info(vendor)").fetchall()}
        for col, ddl in {
            "kind": "VARCHAR(12) DEFAULT ''",
            "city": "VARCHAR(80) DEFAULT ''",
            "state": "VARCHAR(20) DEFAULT ''",
        }.items():
            if col not in vendor_cols:
                conn.exec_driver_sql(
                    f"ALTER TABLE vendor ADD COLUMN {col} {ddl}")
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
        # Inventory: la tabla `part` ya existe, así que create_all NO le agrega
        # `reorder_point`; se agrega a mano. (`on_hand` ya existía.) La tabla
        # nueva part_stock_movement sí la crea create_all (tabla faltante).
        part_cols = {r[1] for r in conn.exec_driver_sql(
            "PRAGMA table_info(part)").fetchall()}
        if "reorder_point" not in part_cols:
            conn.exec_driver_sql(
                "ALTER TABLE part ADD COLUMN reorder_point FLOAT DEFAULT 0")
        # Campos ricos del catálogo (v1.48): aditivos (paridad con la
        # migración Alembic c4f7a9e12b8d que los agrega en Postgres).
        for col, ddl in {
            "manufacturer": "VARCHAR(80) DEFAULT ''",
            "bin": "VARCHAR(40) DEFAULT ''",
            "max_qty": "FLOAT DEFAULT 0",
            "avg_cost": "FLOAT DEFAULT 0",
            "upc": "VARCHAR(40) DEFAULT ''",
            "fits": "VARCHAR(200) DEFAULT ''",
            "source": "VARCHAR(30) DEFAULT 'manual'",
            "core_charge": "FLOAT DEFAULT 0",       # core tracking (v2.5)
            "warranty_months": "INTEGER DEFAULT 0",  # warranty tracking (v2.6)
        }.items():
            if col not in part_cols:
                conn.exec_driver_sql(
                    f"ALTER TABLE part ADD COLUMN {col} {ddl}")
        # Recepción con backorders (v2.3): aditivo (paridad con la migración
        # Alembic f1a2b3c4d5e6). Idempotente.
        poline_cols = {r[1] for r in conn.exec_driver_sql(
            "PRAGMA table_info(po_line)").fetchall()}
        for col, ddl in {
            "qty_received": "FLOAT DEFAULT 0",
            "received_at": "DATETIME",
        }.items():
            if col not in poline_cols:
                conn.exec_driver_sql(
                    f"ALTER TABLE po_line ADD COLUMN {col} {ddl}")
        po_cols = {r[1] for r in conn.exec_driver_sql(
            "PRAGMA table_info(purchase_order)").fetchall()}
        for col, ddl in {
            "received_at": "DATETIME",
            "backorder_of_po_id": "INTEGER REFERENCES purchase_order(id)",
        }.items():
            if col not in po_cols:
                conn.exec_driver_sql(
                    f"ALTER TABLE purchase_order ADD COLUMN {col} {ddl}")
        # Backfill: las POs ya 'received' (pre-feature) se marcan completas
        # (qty_received = qty) para que no se "re-reciban" con la lógica de
        # remaining. Solo toca líneas todavía en 0 (no pisa parciales).
        # v2.22: SOLO la vez que se agrega la columna. Antes corría en cada
        # arranque y, ahora que una PO recibida se edita (agregar una línea
        # nueva, qty 0 recibida), la marcaba recibida SIN movimiento de stock.
        if "qty_received" not in poline_cols:
            conn.exec_driver_sql(
                "UPDATE po_line SET qty_received = qty "
                "WHERE qty_received = 0 "
                "AND po_id IN (SELECT id FROM purchase_order "
                "WHERE status='received')")
        # v2.22 costeo de POs post-recepción: paridad con la migración
        # Alembic f2a3b4c5d6e7 (las tablas nuevas po_adjustment/audit_event
        # las crea create_all; acá solo las columnas en tablas existentes).
        _v222_po_cols = {
            "purchase_order": {
                "fin_status": "VARCHAR(16) DEFAULT 'open'",
                "closed_at": "DATETIME",
                "invoice_no": "VARCHAR(40) DEFAULT ''",
                "invoice_date": "VARCHAR(10) DEFAULT ''",
                "tracking_no": "VARCHAR(60) DEFAULT ''",
                "payment_method": "VARCHAR(20) DEFAULT ''",
                "vendor_id": "INTEGER REFERENCES vendor(id)",
            },
            "po_line": {
                "taxable": "BOOLEAN DEFAULT 0",
                "landed_unit_cost": "FLOAT",
            },
            "part": {"last_cost": "FLOAT"},
            "part_stock_movement": {
                "unit_cost": "FLOAT",
                "value_delta": "FLOAT",
                "actor": "VARCHAR(80) DEFAULT ''",
            },
        }
        for _tbl, _adds in _v222_po_cols.items():
            _have = {r[1] for r in conn.exec_driver_sql(
                f'PRAGMA table_info("{_tbl}")').fetchall()}
            for col, ddl in _adds.items():
                if col not in _have:
                    conn.exec_driver_sql(
                        f'ALTER TABLE "{_tbl}" ADD COLUMN {col} {ddl}')
        conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_purchase_order_vendor_id "
            "ON purchase_order (vendor_id)")
        # v2.22 horas de motor (reefer PM): paridad con la migración Alembic
        # a3b4c5d6e7f8. La tabla nueva meter_reading la crea create_all; acá
        # solo las columnas en tablas existentes. (El ensanche de
        # maint_record.kind a VARCHAR(16) no hace falta en SQLite: no aplica
        # el largo de VARCHAR.)
        for _tbl, _adds in {
            "work_order": {"engine_hours": "FLOAT"},
            "maint_record": {"hours": "FLOAT"},
            # Reseteo del horómetro (inicio de tramo). La tabla puede venir
            # de un create_all previo sin la columna.
            "meter_reading": {"is_reset": "BOOLEAN DEFAULT 0 NOT NULL"},
        }.items():
            _have = {r[1] for r in conn.exec_driver_sql(
                f'PRAGMA table_info("{_tbl}")').fetchall()}
            for col, ddl in _adds.items():
                if col not in _have:
                    conn.exec_driver_sql(
                        f'ALTER TABLE "{_tbl}" ADD COLUMN {col} {ddl}')
        # v2.22 Customers (Resources): paridad con la migración Alembic
        # b4c5d6e7f8a9. Las tablas nuevas customer / customer_contact /
        # customer_unit las crea create_all; acá solo las columnas en tablas
        # existentes (WO: a quién se le cobra + cobro; línea: precio
        # congelado al facturar).
        for _tbl, _adds in {
            "work_order": {
                "customer_id": "INTEGER REFERENCES customer(id)",
                "payment_status": "VARCHAR(12) DEFAULT 'unpaid'",
                "paid_at": "DATETIME",
                "tax_pct": "FLOAT",
            },
            "work_order_line": {"unit_price": "FLOAT"},
        }.items():
            _have = {r[1] for r in conn.exec_driver_sql(
                f'PRAGMA table_info("{_tbl}")').fetchall()}
            for col, ddl in _adds.items():
                if col not in _have:
                    conn.exec_driver_sql(
                        f'ALTER TABLE "{_tbl}" ADD COLUMN {col} {ddl}')
        conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_work_order_customer_id "
            "ON work_order (customer_id)")
        # v2.22 Reports (saved_report / report_favorite / report_schedule):
        # paridad con la migración Alembic c5d6e7f8a9b0. Son tablas NUEVAS
        # (las crea create_all, que corre antes): no hay columnas que
        # agregar a tablas existentes.
        # H6 fase 3: cada fila pertenece a una organizacion (tenant). El
        # usuario y las 11 tablas de datos llevan org_id; las DBs viejas no
        # tienen la columna, asi que se agrega y se backfillea a 'default'.
        # (poi queda global: datos publicos compartidos, ver modelo Poi.)
        oid = default_org_id()
        for table in ("user", "report_block", "block_driver", "defect",
                      "work_order", "work_order_line", "tms_driver",
                      "alert_event", "unit_doc", "maint_record", "vendor",
                      "part", "part_stock_movement", "purchase_order",
                      "po_line"):
            cols = {r[1] for r in conn.exec_driver_sql(
                f'PRAGMA table_info("{table}")').fetchall()}
            if "org_id" not in cols:
                conn.exec_driver_sql(
                    f'ALTER TABLE "{table}" ADD COLUMN org_id INTEGER '
                    'REFERENCES organization(id)')
            conn.exec_driver_sql(
                f'UPDATE "{table}" SET org_id = {oid} WHERE org_id IS NULL')
        # v2.16: defect.block_id pasa a NULLABLE (los defectos de walkaround
        # no tienen bloque DVIR) + columna source. SQLite no puede relajar un
        # NOT NULL con ALTER, así que la ÚNICA vez que detectamos el NOT NULL
        # viejo se reconstruye la tabla (create/insert/drop/rename) — mismo
        # truco que usa el modo batch de Alembic. Guardado por PRAGMA:
        # corridas siguientes no hacen nada.
        d_info = conn.exec_driver_sql(
            "PRAGMA table_info(defect)").fetchall()
        d_cols = {r[1]: r for r in d_info}
        blockid_notnull = bool(d_cols.get("block_id", (0, 0, 0, 0))[3]) \
            if "block_id" in d_cols else False
        if "source" not in d_cols:
            conn.exec_driver_sql(
                "ALTER TABLE defect ADD COLUMN source VARCHAR(12) "
                "DEFAULT 'dvir'")
        if blockid_notnull:
            conn.exec_driver_sql("""
                CREATE TABLE defect_new (
                    id INTEGER NOT NULL PRIMARY KEY,
                    block_id INTEGER REFERENCES report_block(id),
                    source VARCHAR(12) DEFAULT 'dvir',
                    company VARCHAR(64) NOT NULL,
                    block_date DATE NOT NULL,
                    date_label VARCHAR(16) NOT NULL,
                    driver VARCHAR(128) NOT NULL,
                    unit VARCHAR(64) NOT NULL,
                    unit_kind VARCHAR(16) NOT NULL,
                    dvir_type VARCHAR(32) NOT NULL,
                    status VARCHAR(32) NOT NULL,
                    detail TEXT NOT NULL,
                    mechanic VARCHAR(128) NOT NULL,
                    mechanic_notes TEXT NOT NULL,
                    org_id INTEGER REFERENCES organization(id))""")
            conn.exec_driver_sql(
                "INSERT INTO defect_new (id, block_id, source, company, "
                "block_date, date_label, driver, unit, unit_kind, dvir_type, "
                "status, detail, mechanic, mechanic_notes, org_id) "
                "SELECT id, block_id, COALESCE(source, 'dvir'), company, "
                "block_date, date_label, driver, unit, unit_kind, dvir_type, "
                "status, detail, mechanic, mechanic_notes, org_id FROM defect")
            conn.exec_driver_sql("DROP TABLE defect")
            conn.exec_driver_sql("ALTER TABLE defect_new RENAME TO defect")
            conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_defect_org_id "
                "ON defect (org_id)")
        conn.commit()


def init_schema() -> None:
    """Inicializa el esquema y siembra la org 'default'.

    Ambos motores: create_all crea las tablas FALTANTES desde los modelos
    actuales (es idempotente: no toca ni altera las tablas existentes). En un
    Postgres FRESCO (deploy piloto en Dokploy/VPS) esto basta para levantar el
    esquema completo y correcto directo de los modelos, sin depender de Alembic
    (que hoy solo tiene la migración inicial y no incluye las tablas agregadas
    después: work_order, purchase_order, part, vendor, etc.).

    NOTA (largo plazo): el camino correcto en producción son migraciones
    Alembic versionadas (`alembic upgrade head`) — fuera del alcance de este
    deploy. Mientras tanto, create_all sobre una base fresca es seguro; sobre
    una base con datos viejos NO agrega columnas nuevas a tablas existentes
    (eso lo cubre _migrate solo en SQLite, ver abajo).

    SQLite (dev): además de create_all corre las migraciones aditivas de
    `_migrate` (ALTER TABLE específicos de SQLite). Ese path queda SOLO para
    SQLite; en Postgres no se corre (su DDL es SQLite-specific)."""
    Base.metadata.create_all(_engine)
    ensure_default_org()
    # _migrate usa PRAGMA/ALTER específicos de SQLite: solo para dev local.
    if config.IS_SQLITE:
        _migrate()


# Inicializa al importar (back-compat: scripts/tests usan db directamente).
# Alembic importa este módulo SOLO por su metadata: setea FLEET_SKIP_DB_INIT
# para no tocar la base al generar/correr migraciones.
if not os.environ.get("FLEET_SKIP_DB_INIT"):
    init_schema()


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


def _month_bounds(d: date) -> tuple[date, date]:
    """(primer dia del mes de d, primer dia del mes siguiente).

    Portable: reemplaza los filtros con func.strftime (SQLite-only, que
    REVIENTA en Postgres) por un rango [inicio, sig) valido en ambos motores
    y que ademas puede usar indice sobre block_date. (DATA-6)"""
    start = d.replace(day=1)
    nxt = (date(d.year + 1, 1, 1) if d.month == 12
           else date(d.year, d.month + 1, 1))
    return start, nxt


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

        start, nxt = _month_bounds(latest)
        rows = session.execute(
            select(BlockDriver.driver, func.count().label("misses"))
            .join(ReportBlock, BlockDriver.block_id == ReportBlock.id)
            .where(
                BlockDriver.is_no_dvir.is_(True),
                ReportBlock.block_date >= start,
                ReportBlock.block_date < nxt,
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
        start, nxt = _month_bounds(latest)
        rows = session.scalars(
            select(ReportBlock).where(
                ReportBlock.block_date >= start,
                ReportBlock.block_date < nxt)
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
            # v2.14: el id real de la fila — la evidencia fotográfica cuelga
            # de él (POST /defects/{id}/photos). Las filas "live" del ELD no
            # pasan por esta tabla y por eso no tienen id.
            "id": r.id,
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
        start, nxt = _month_bounds(latest)
        rows = session.scalars(
            select(ReportBlock)
            .where(ReportBlock.block_date >= start,
                   ReportBlock.block_date < nxt)
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


def delete_block(block_id):
    """Borra un bloque DVIR generado (cascada a drivers + defectos).
    Devuelve True si existia."""
    with SessionLocal() as session:
        block = session.get(ReportBlock, block_id)
        if block is None:
            return False
        session.delete(block)
        session.commit()
        return True
