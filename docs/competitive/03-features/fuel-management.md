# Feature: Fuel Management + Fuel Cards (gestión de combustible + tarjetas)

Prioridad: 🔴 Alta (aparece en casi todos los competidores).

## 1. Qué es y por qué importa

El combustible es, después de la nómina de conductores, el mayor costo variable de una flota (típicamente 25-40% del costo operativo por milla). Hoy Fleet Tracker ya captura el gasto agregado vía los reportes de spend (por categoría/unidad/mes), pero trata "Fuel" como una línea de gasto opaca: sabemos cuánto se gastó, no si ese gasto fue legítimo, eficiente, ni cómo se compara con el consumo real de la unidad.

Fuel Management convierte cada transacción de combustible en un dato de primera clase, ligado a la unidad, al conductor, al odómetro y a la ubicación. Con eso desbloqueamos tres cosas que un dueño de flota paga por tener:

1. **Fuel economy real y cost-per-mile por unidad** cruzando galones contra millaje del sync de telematics. Esto alimenta el TCO por unidad (combustible + mantenimiento en un solo lugar) y detecta unidades que se degradan (un MPG cayendo suele preceder a un problema mecánico: inyectores, DPF tapado, arrastre de frenos).
2. **Detección de excepciones y fraude** sobre cada transacción. El robo y el mal uso de combustible es endémico en flotas medianas (llenar tanques ajenos, "skimming" de galones, compras no-combustible con la tarjeta de flota). Poder decirle al dueño "de estos 340 cargos de la semana, 6 son sospechosos y acá está el porqué" es un diferenciador concreto de ahorro de dinero.
3. **Ingesta automática** vía las fuel-cards (WEX/Comdata/Coast) para que el dato entre solo, sin captura manual, y quede conciliado contra el resto del sistema.

El posicionamiento contra Fullbay es directo: Fullbay es shop-céntrico y no toca combustible. Nosotros ya tenemos el odómetro del sync de telematics y el motor de mantenimiento; sumar combustible cierra el TCO real por unidad que ni Fullbay ni SquareRigger entregan con la agilidad de UI que buscamos.

## 2. Referencia competitiva

**RTA** es la referencia más completa en excepciones. Ingesta por EFI (electronic fuel interface), CSV y manual; inventario de tanque/bomba on-site; asignación de costo por departamento/clase; dashboards de emisiones de carbono. Su núcleo son **6 tipos de excepción de combustible**, que adoptamos como el catálogo canónico del motor:

1. Tipo de combustible inconsistente (unidad diésel con cargo de gasolina).
2. Cantidad excede la capacidad del tanque.
3. MPG anómalo (fuera de rango esperado para la unidad).
4. El vehículo no estaba en la ubicación de la carga (geo-mismatch).
5. Gasto no-combustible (snacks, otros SKUs en la tarjeta de flota).
6. Vehículo o tarjeta desconocido.

**Fleetio**: integración de fuel-cards (WEX/FLEETCOR/Comdata/Coast) con auto-import de transacciones, costo-por-milla, flag de lectura de odómetro inválida y tracking de fuel economy. Es el estándar de "el dato entra solo".

**SquareRigger**: soporta WEX/Comdata/EFS/Fuelman/Voyager más sistemas on-site (FuelConnect/Gasboy/Petrovend); su tesis es fuel + maintenance = TCO real, con detección de baja eficiencia.

**Whip Around**: se apoya en detección de fraude/robo de combustible como gancho comercial.

**Motive**: Motive Card con detección de fraude por AI, cruzando telematics + pago (mismatch de nivel de tanque vs galones comprados, y presencia física del vehículo).

Conclusión de diseño: el catálogo de 6 excepciones de RTA + la ingesta automática de Fleetio + el ángulo de fraude de Whip Around/Motive. Nuestro diferenciador es que **ya tenemos el odómetro y la geolocalización del sync de telematics**, así que las excepciones 3 (MPG) y 4 (geo-mismatch) las podemos correr sin pedirle nada extra al cliente.

## 3. Modelo de datos (SQLAlchemy; nota migración Alembic)

Tres tablas nuevas, todas `OrgScoped` (heredan `org_id` y quedan aisladas por tenant vía los eventos `before_flush` / `do_orm_execute` ya existentes en `backend/app/db.py`). Sigo el estilo del repo: `Mapped`/`mapped_column`, `unit` como clave de negocio (string, no FK dura a `unit.id`, para no romper con unidades que viven solo en el fleet de Samsara).

```python
class FuelCard(OrgScoped, Base):
    """Tarjeta de combustible sincronizada desde el proveedor (WEX/Comdata/Coast)
    o cargada a mano. Se resuelve a una unidad/conductor para atribuir el gasto."""
    __tablename__ = "fuel_card"

    id: Mapped[int] = mapped_column(primary_key=True)
    provider: Mapped[str] = mapped_column(String(20))       # wex|comdata|coast|manual
    card_last4: Mapped[str] = mapped_column(String(4), index=True)
    card_ref: Mapped[str] = mapped_column(String(64), default="")  # id externo del proveedor
    assigned_unit: Mapped[str] = mapped_column(String(64), default="", index=True)
    assigned_driver: Mapped[str] = mapped_column(String(128), default="")
    status: Mapped[str] = mapped_column(String(16), default="active")  # active|suspended|unknown
    created_at: Mapped[datetime] = mapped_column(DateTime)


class FuelTransaction(OrgScoped, Base):
    """Una carga de combustible. Fuente de verdad para fuel economy, cost-per-mile
    y el motor de excepciones. El odometer_at_fill viene del cargo si el POS lo
    capturó; si no, se imputa desde el sync de telematics por unidad+fecha."""
    __tablename__ = "fuel_transaction"
    __table_args__ = (
        # idempotencia de ingesta: un mismo cargo del proveedor no se duplica
        UniqueConstraint("source", "external_id", name="uq_fueltx_source_ext"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    source: Mapped[str] = mapped_column(String(16))         # wex|comdata|coast|csv|manual
    external_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    unit: Mapped[str] = mapped_column(String(64), index=True)   # numero de unidad (clave de negocio)
    driver: Mapped[str] = mapped_column(String(128), default="")
    card_id: Mapped[int | None] = mapped_column(ForeignKey("fuel_card.id"), nullable=True)
    txn_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    fuel_type: Mapped[str] = mapped_column(String(16), default="diesel")  # diesel|gas|def|other
    gallons: Mapped[float] = mapped_column(Float, default=0.0)
    unit_price: Mapped[float | None] = mapped_column(Float, nullable=True)  # $/gal
    total_cost: Mapped[float] = mapped_column(Float, default=0.0)
    is_fuel: Mapped[bool] = mapped_column(Boolean, default=True)  # false = SKU no-combustible
    location_name: Mapped[str] = mapped_column(String(160), default="")
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lon: Mapped[float | None] = mapped_column(Float, nullable=True)
    odometer_at_fill: Mapped[int | None] = mapped_column(Integer, nullable=True)
    odometer_source: Mapped[str] = mapped_column(String(12), default="none")  # pos|telematics|manual|none
    created_at: Mapped[datetime] = mapped_column(DateTime)

    exceptions: Mapped[list["FuelException"]] = relationship(
        back_populates="txn", cascade="all, delete-orphan")


class FuelException(OrgScoped, Base):
    """Una anomalía detectada sobre una transacción. Un cargo puede tener varias.
    kind mapea 1:1 al catálogo de 6 de RTA (mas un 'fraud_suspected' derivado)."""
    __tablename__ = "fuel_exception"

    id: Mapped[int] = mapped_column(primary_key=True)
    txn_id: Mapped[int] = mapped_column(ForeignKey("fuel_transaction.id"), index=True)
    # kind: fuel_type_mismatch | over_tank_capacity | mpg_anomaly |
    #       location_mismatch | non_fuel_purchase | unknown_unit_card | fraud_suspected
    kind: Mapped[str] = mapped_column(String(24), index=True)
    severity: Mapped[str] = mapped_column(String(8), default="warn")  # info|warn|critical
    detail: Mapped[str] = mapped_column(Text, default="")   # explicacion legible + valores
    status: Mapped[str] = mapped_column(String(12), default="open")  # open|acknowledged|dismissed
    created_at: Mapped[datetime] = mapped_column(DateTime)

    txn: Mapped[FuelTransaction] = relationship(back_populates="exceptions")
```

Notas de capacidad de tanque: la excepción 2 (excede capacidad) necesita conocer la capacidad del tanque por unidad. No existe hoy en `Unit`; se agrega `tank_capacity_gal: Mapped[float | None]` (nullable) al modelo `Unit`. Si la unidad no tiene capacidad seteada, la excepción 2 se salta (no se dispara por falso positivo).

**Migración Alembic**: una revisión nueva que (a) `create_table` de `fuel_card`, `fuel_transaction`, `fuel_exception` con sus índices y el `UniqueConstraint` de idempotencia; (b) `add_column` de `tank_capacity_gal` en `unit` (nullable, sin backfill). Todo aditivo, sin `NOT NULL` nuevo sobre datos existentes, así que es seguro en Postgres prod y en SQLite dev. Recordar que `org_id` es nullable en fase 3b: las filas nuevas lo reciben del contexto de tenant vía `before_flush`; los backfills por script deben fijar el contexto explícitamente.

## 4. Backend (core + endpoints; reglas)

Nuevo módulo `core/fuel.py` con dos responsabilidades: (a) normalizar/persistir transacciones (ingesta) y (b) correr el motor de excepciones y las métricas de economía.

**Ingesta** (`ingest_transactions(rows, source)`):
- Normaliza cada fila a un dict canónico (galones, costo, `unit_price` derivado si falta, fecha, ubicación, tarjeta).
- Resuelve la unidad: primero por `card_id` (tarjeta asignada), luego por número de unidad textual del cargo. Si no resuelve → excepción 6 (`unknown_unit_card`) y la transacción se guarda igual con `unit=""` para que no se pierda dinero.
- Imputa el odómetro: si el POS trae odómetro (`odometer_source=pos`), se usa; si no, se busca la lectura más cercana del sync de telematics para esa unidad en la ventana ±6h del `txn_at` (`odometer_source=telematics`); si tampoco hay, queda `none` y se salta cualquier cálculo que dependa de millas.
- Idempotente por `(source, external_id)`: reprocesar el mismo lote no duplica.

**Motor de excepciones** (`detect_exceptions(txn)`), catálogo de 6 de RTA + derivado de fraude:
1. `fuel_type_mismatch`: `fuel_type` del cargo distinto al esperado de la unidad (diésel vs gas). Requiere conocer el tipo de la unidad.
2. `over_tank_capacity`: `gallons > tank_capacity_gal * 1.05` (5% de tolerancia por redondeo de bomba). Se salta si no hay capacidad.
3. `mpg_anomaly`: se calcula MPG del tramo = (odómetro de este fill − odómetro del fill anterior de la misma unidad) / galones de este fill. Se dispara si cae fuera de `[mpg_esperado * 0.6, mpg_esperado * 1.6]`. El `mpg_esperado` arranca como media móvil de los últimos N fills de la unidad (fallback a un default por `unit_type`). Depende del odómetro del sync de telematics: este es el cálculo que nadie más puede hacer sin telematics.
4. `location_mismatch`: si la transacción trae lat/lon y hay una posición del sync de telematics para la unidad en la ventana del `txn_at`, se dispara si la distancia (haversine) supera un umbral (p. ej. 15 mi). Geo-mismatch = posible clonado de tarjeta o llenado de tanque ajeno.
5. `non_fuel_purchase`: `is_fuel = false` (el proveedor marca SKU no-combustible) o un cargo con `gallons = 0` y `total_cost > 0`.
6. `unknown_unit_card`: la unidad o la tarjeta no resuelve a nada del tenant.

Derivado `fraud_suspected` (severidad `critical`): se levanta cuando concurren señales fuertes, típicamente `location_mismatch` + `over_tank_capacity`, o `mpg_anomaly` extremo + `non_fuel_purchase` en la misma tarjeta en ventana corta. Este es el flag que se muestra como diferenciador y el que alimenta la automatización de alerta.

**Métricas** (`unit_fuel_economy(unit, period)`): MPG promedio ponderado por galones, cost-per-mile (Σ costo / Σ millas del período), galones y $ totales. Se expone junto a los reportes de spend ya existentes para que "Fuel" deje de ser una categoría opaca.

**Endpoints** (en `api/routes.py`, todos tenant-scoped por el middleware existente):
- `POST /api/fuel/import` — recibe CSV o payload del adapter de fuel-card; corre ingesta + detección; devuelve resumen (creadas, duplicadas, excepciones por tipo).
- `POST /api/fuel/transactions` — alta manual de una transacción.
- `GET  /api/fuel/transactions` — listado filtrable (unidad, conductor, rango, tipo, con/sin excepciones).
- `GET  /api/fuel/exceptions` — cola de excepciones abiertas para revisión.
- `POST /api/fuel/exceptions/{id}/resolve` — `acknowledge` | `dismiss` con nota.
- `GET  /api/fuel/economy?unit=...&from=...&to=...` — MPG, cost-per-mile, totales.
- `GET  /api/fuel/cards` / `POST /api/fuel/cards` — listar y asignar tarjetas a unidad/conductor.

Regla transversal: nada bloquea la ingesta. Una transacción problemática siempre se guarda (para no perder trazabilidad del dinero) y genera excepciones; nunca se rechaza.

## 5. UI (React; dónde encaja; estados vacío/carga/error)

Nueva sección **Fuel** en la navegación principal, al mismo nivel que Maintenance/Reports. Tres vistas:

1. **Transactions** — tabla densa (unidad, fecha, conductor, galones, $/gal, total, ubicación, MPG del tramo, chip de excepción). Filtros por unidad/conductor/rango/tipo. Fila con excepción resaltada con badge de color por severidad. Reusa el estilo de tabla y los filtros de la vista de spend existente.
2. **Exceptions** — cola de revisión (bandeja). Cada card muestra el `detail` legible ("Unidad 4471: 148 gal cargados, capacidad de tanque 120 gal → excede en 23%"), acciones Acknowledge / Dismiss con nota. El chip `fraud_suspected` va en rojo, arriba de todo, como highlight del diferenciador.
3. **Economy** — por unidad: MPG y cost-per-mile en el tiempo (sparkline), integrado con el card de la unidad donde ya vive el mantenimiento, para el relato de TCO real.

Estados:
- **Vacío**: "Sin transacciones de combustible todavía. Conectá una tarjeta (WEX/Comdata/Coast) en Integraciones o importá un CSV." con dos CTAs (a Integraciones y a importar CSV). En Economy vacío: "Necesitamos al menos dos cargas y odómetro de telematics para calcular MPG."
- **Carga**: skeleton rows en la tabla; spinner inline en el import.
- **Error**: banner no bloqueante. En import fallido, mostrar cuántas filas se procesaron y cuáles fallaron con el motivo, sin descartar el lote entero. En falta de odómetro: nota suave "MPG no disponible: sin lectura de telematics en la ventana" en vez de un valor vacío.

## 6. Automatizaciones (cap 04)

El motor de automatizaciones del cap 04 consume los eventos que emite `core/fuel.py`:

- **Trigger `fuel.exception.created`** con filtro por `kind`/`severity`. Reglas típicas:
  - `fraud_suspected` (critical) → notificación inmediata al dueño/gerente (mismo bus de notify/SMS/Telegram que ya usa el sistema de alertas), con el detalle y link a la transacción.
  - `mpg_anomaly` sostenido en una unidad (≥3 en 30 días) → crear un `WorkOrder` de diagnóstico (`is_pm=false`, título "Revisar caída de MPG unidad X"), enganchando con el pipeline de órdenes existente.
  - `non_fuel_purchase` → agregar a un digest semanal en vez de alertar al instante.
- **Trigger `fuel.economy.degraded`**: cuando el MPG rodante de una unidad cae bajo un umbral relativo a su baseline → alerta preventiva (posible mecánica).

Las acciones (notificar, crear WO, digest) son las mismas primitivas del motor del cap 04; combustible solo aporta triggers nuevos y el payload.

## 7. Integraciones que toca

- **Fuel-cards (cap 04)**: el adapter de categoría "Fuel" (WEX/Comdata/Coast) es la fuente principal de ingesta. El adapter normaliza a las filas canónicas que `ingest_transactions` espera; la resolución unidad/tarjeta y el motor de excepciones viven de nuestro lado. Coast y Motive Card aportan además la señal de nivel de tanque cuando está disponible, que refuerza la excepción de fraude.
- **Telematics (`core/providers/`)**: consumidor del odómetro y la posición ya sincronizados vía el `TelematicsProvider` ABC (Samsara/Motive). Es lo que habilita `mpg_anomaly` (odómetro) y `location_mismatch` (geo). No requiere trabajo nuevo en los providers: solo lectura de las lecturas que ya entran por el sync.
- **CSV**: ruta de respaldo para flotas sin tarjeta integrada o con EFI on-site (paridad con la ingesta EFI/CSV de RTA).
- **Reportes de spend (existente)**: la categoría "Fuel" del spend se enriquece con galones/MPG/cost-per-mile en vez de solo el monto.
- **Work Orders (existente)**: destino de las automatizaciones de MPG degradado.

## 8. Esfuerzo (S/M/L) · prioridad · dependencias

- **Esfuerzo total: L.** Desglose:
  - Modelo + migración Alembic + `tank_capacity_gal`: **S**.
  - `core/fuel.py` ingesta + resolución de unidad/odómetro: **M**.
  - Motor de las 6 excepciones + derivado de fraude: **M** (la lógica de MPG y geo requiere cuidado con ventanas de tiempo y falsos positivos).
  - Endpoints + UI (3 vistas): **M**.
  - Adapter de fuel-card real (WEX primero): **M**, pero pertenece al cap 04.
- **Prioridad: 🔴 Alta.** Es table-stakes competitivo (todos lo tienen) y el ángulo de fraude es un diferenciador de venta con ahorro cuantificable.
- **Dependencias**:
  - Sync de telematics con odómetro y posición ya en producción (existe): **bloqueante** para excepciones 3 y 4.
  - Motor de automatizaciones (cap 04): necesario para las alertas de fraude/MPG; el feature funciona sin él (excepciones visibles en la cola), pero el valor completo llega con las automatizaciones.
  - Adapter de fuel-card (cap 04): necesario para la ingesta automática; el CSV/manual cubre el MVP mientras tanto.
- **Orden sugerido**: modelo → ingesta CSV/manual → motor de excepciones → UI → adapter WEX → automatizaciones. Así hay valor demostrable (excepciones sobre CSV) antes de depender de integraciones externas.

## 9. Ejemplo end-to-end con datos realistas

Flota "TransCarga del Norte", org `transcarga`. La unidad 4471 es un Freightliner Cascadia diésel, `tank_capacity_gal = 120`, MPG esperado (baseline rodante) 6.8.

1. **Ingesta**: el jueves 2026-06-25 entra el lote diario de WEX vía el adapter. Entre 312 cargos llega uno:
   `external_id=WEX-88231045`, tarjeta `••••7788` (asignada a unidad 4471, conductor "M. Reyes"), 148.2 gal de diésel, $3.89/gal, total $576.50, ubicación "Pilot #442, Laredo TX", `txn_at=2026-06-25 03:14`, sin odómetro del POS.
2. **Resolución + odómetro**: la tarjeta resuelve a la unidad 4471. El POS no trajo odómetro, así que `core/fuel.py` busca el sync de telematics: la lectura más cercana de 4471 a las 03:14 fue 402,110 mi. El fill anterior de 4471 fue el 2026-06-22 con odómetro 401,180 mi y 92 gal.
3. **Motor de excepciones**:
   - Excepción 2 `over_tank_capacity`: 148.2 gal > 120 × 1.05 (126) → **dispara**. Detail: "148.2 gal en tanque de 120 gal (excede 23%)".
   - Excepción 3 `mpg_anomaly`: millas del tramo = 402,110 − 401,180 = 930 mi; MPG = 930 / 148.2 = 6.27. Está dentro de `[4.08, 10.88]` → no dispara por MPG. Pero los 148.2 gal para 930 mi implican que el tanque no pudo haber estado vacío-a-lleno: refuerza la 2.
   - Excepción 4 `location_mismatch`: la posición del sync de telematics de 4471 a las 03:14 fue cerca de San Antonio, a ~150 mi de Laredo → **dispara**. Detail: "Vehículo a 152 mi de la ubicación de la carga (Laredo TX)".
   - Derivado `fraud_suspected` (critical): concurren `over_tank_capacity` + `location_mismatch` → **dispara**. El tanque físico no podía recibir 148 gal y el camión no estaba ahí: patrón clásico de tarjeta clonada / llenado de tanque de un tercero.
4. **Automatización (cap 04)**: la regla `fuel.exception.created` con `severity=critical` notifica al gerente por Telegram: "🚨 Posible fraude de combustible — unidad 4471, tarjeta ••••7788, $576.50, Laredo TX. El camión estaba a 152 mi. Revisar." con link a la transacción.
5. **Revisión en UI**: el gerente abre la cola de Exceptions, ve la card en rojo con los tres detalles, confirma con el conductor que 4471 estaba en San Antonio, y marca `acknowledge` con nota "Tarjeta comprometida, reportada a WEX y bloqueada". La tarjeta pasa a `status=suspended`.
6. **Economía**: independientemente del fraude, la vista Economy de 4471 muestra MPG rodante 6.5 y cost-per-mile $0.58 en junio, integrado en el card de la unidad junto a su historial de mantenimiento. El dueño ve, en un solo lugar, que 4471 combina buen MPG pero un cargo fraudulento de $576 que el sistema atajó: ahorro directo y trazable.
