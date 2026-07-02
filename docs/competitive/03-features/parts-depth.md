# Feature: Profundidad de inventario de partes

## 1. Qué es y por qué importa

Hoy Fleet Tracker tiene inventario "de una dimensión": una parte tiene UN solo
`on_hand` global, un `reorder_point` plano, movimientos idempotentes en
`part_stock_movement`, y hooks que consumen stock al facturar una WO y lo
reponen al recibir una PO. Eso alcanza para un taller de una sola bodega que
lleva conteos a ojo. No alcanza contra los competidores serios, y no alcanza
para el jefe que hoy paga $577/mes de Fullbay.

La "profundidad" de inventario es el conjunto de capacidades que separan un
conteo de existencias de un sistema de partes de verdad:

- **Ubicaciones de stock** (bin locations): la misma parte vive en varios
  lugares (bodega central, camión de servicio #3, estante de retail) y el
  técnico necesita saber en CUÁL hay y cuánto, no solo el total.
- **Barcode / UPC**: escanear en vez de tipear. Esto es lo que convierte un
  conteo físico de 3 horas en uno de 30 minutos, y lo que evita el error de
  dedo al agregar una parte a una WO.
- **Min/Max** en vez de un solo umbral: pedir cuando cae al mínimo, y pedir
  hasta el máximo (no una cantidad inventada). Es la base del re-pedido
  automático.
- **Last-price-paid y rating de vendor**: cuánto pagaste la última vez y a
  quién le conviene comprar. Alimenta el QuickBuy con datos reales en vez de
  hacer que el usuario adivine el costo.
- **Parts velocity y reporte de obsoletos**: qué se mueve y qué es plata
  muerta en el estante. SquareRigger vende literalmente "recuperá el 25% de tu
  inventario obsoleto" como argumento de venta.

Por qué importa AHORA: el inventario es el pegamento entre WO, PO y el motor de
automatizaciones (cap 04). Sin ubicaciones, un re-pedido automático no sabe QUÉ
bodega quedó corta. Sin last-price-paid, la automatización de QuickBuy no puede
llenar el costo sola. Esto no es una feature aislada: es la que habilita que el
resto del stack de partes se sienta automático en vez de manual.

## 2. Referencia competitiva

| Competidor | Qué tiene en profundidad de inventario |
|---|---|
| **RTA** | Min/max con low-stock automático · **barcode + impresoras de etiquetas** · **hasta 5 ubicaciones de stock por parte** · **last-price-paid** · **rating de vendor** + performance tracking |
| **Fleetio** | Stock multi-ubicación con jerarquía **aisle / row / bin** · reorder points · **auto-decremento al agregar la parte a una WO** (no al facturar: al agregarla) · flujo de receiving contra PO |
| **SquareRigger** | Bin locations · **UPC barcode scanning** · "Smart Fill" que autocompleta specs + imágenes de la parte · min/max thresholds · pitch de **"recuperá el 25% de inventario obsoleto"** |
| **Fullbay** | Multi-ubicación real (service trucks / warehouses / retail bins) · matriz de markup por tipo de parte Y por vendor · **parts velocity** report |

Lecturas clave para nuestro diseño:

1. **Todos** tienen multi-ubicación. Un solo `on_hand` global nos deja fuera de
   la conversación con cualquier taller de más de una bodega.
2. **RTA capa las ubicaciones a 5**; Fleetio no. Nosotros no vamos a capar por
   diseño de datos (una tabla `stock_location` no tiene por qué limitar), pero
   la UI puede sugerir el patrón de 3 a 5 típico.
3. **Fleetio decrementa al AGREGAR a la WO, no al facturar.** Nosotros hoy
   consumimos al facturar (`wo_consume`). Esto es una diferencia de negocio real
   (ver 4.4): decrementar temprano evita vender stock que ya no está, pero exige
   manejar reservas/devoluciones. Lo tratamos como decisión explícita, no como
   bug.
4. **Barcode es UX, no data.** El campo `barcode/upc` es trivial; el valor está
   en el *flujo* de scan-to-count y scan-to-add-to-WO. Ahí ganamos o perdemos.

## 3. Modelo de datos (SQLAlchemy; EXTENDÉ Part/PartStockMovement existentes; nota migración Alembic)

No reinventamos: **extendemos** `Part` y `PartStockMovement` (ya existen,
org-scoped, con constraint `uq_part_org_pn` y el ledger idempotente por
`(reason, ref_type, ref_id)`), y agregamos **una** tabla nueva de ubicaciones.

### 3.1 Nueva tabla: `StockLocation`

Catálogo de ubicaciones físicas de la org. Un `warehouse`, un `service_truck`,
un `bin`. La jerarquía aisle/row/bin de Fleetio se guarda como campos, no como
árbol (no vale la complejidad para nuestro tamaño).

```python
class StockLocation(OrgScoped, Base):
    """Ubicación física de stock (fase Inventory Depth). Una parte puede tener
    existencia en varias de estas (ver PartStockLevel). `kind` distingue bodega,
    camión de servicio y estante de retail (patrón Fullbay/Fleetio)."""
    __tablename__ = "stock_location"
    __table_args__ = (
        UniqueConstraint("org_id", "code", name="uq_stockloc_org_code"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(24), index=True)   # "WH1", "TRK3"
    name: Mapped[str] = mapped_column(String(80), default="")
    kind: Mapped[str] = mapped_column(String(16), default="warehouse")  # warehouse|service_truck|bin
    # Jerarquía opcional estilo Fleetio (aisle/row/bin); texto libre.
    aisle: Mapped[str] = mapped_column(String(16), default="")
    row: Mapped[str] = mapped_column(String(16), default="")
    bin: Mapped[str] = mapped_column(String(16), default="")
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime)
```

### 3.2 Nueva tabla: `PartStockLevel` (stock por-parte-por-ubicación)

El cache `Part.on_hand` deja de ser la verdad por-ubicación: se vuelve el
**total agregado**. La existencia real por lugar vive acá, una fila por
`(part_number, location_id)`.

```python
class PartStockLevel(OrgScoped, Base):
    """Existencia cacheada de una parte EN UNA ubicación (fase Inventory Depth).
    Es al par (parte, ubicación) lo que Part.on_hand era al global: un cache
    sobre el ledger part_stock_movement, que ahora lleva location_id."""
    __tablename__ = "part_stock_level"
    __table_args__ = (
        UniqueConstraint("org_id", "part_number", "location_id",
                         name="uq_stocklevel_org_pn_loc"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    part_number: Mapped[str] = mapped_column(String(60), index=True)
    location_id: Mapped[int] = mapped_column(ForeignKey("stock_location.id"), index=True)
    on_hand: Mapped[float] = mapped_column(Float, default=0.0)
    updated_at: Mapped[datetime] = mapped_column(DateTime)
```

### 3.3 Extensión de `Part` (campos nuevos, ninguno destructivo)

```python
    # --- Inventory Depth ---
    barcode: Mapped[str] = mapped_column(String(64), default="", index=True)  # UPC/EAN/code128
    # Min/Max: extienden reorder_point. min_qty reemplaza semánticamente a
    # reorder_point (se migra el valor); max_qty es el target de re-pedido.
    min_qty: Mapped[float] = mapped_column(Float, default=0.0)
    max_qty: Mapped[float] = mapped_column(Float, default=0.0)
    # Último costo unitario efectivamente pagado (se setea al recibir una PO).
    last_price_paid: Mapped[float] = mapped_column(Float, default=0.0)
    last_price_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_vendor_id: Mapped[int | None] = mapped_column(ForeignKey("vendor.id"), nullable=True)
```

`reorder_point` se **conserva** por compatibilidad (lo lee `low_stock_list` y el
front hoy). La migración copia su valor a `min_qty` y lo deja de escribir; en un
segundo increment se deja `reorder_point` como columna deprecada.

### 3.4 Extensión de `PartStockMovement` (el ledger gana ubicación)

```python
    location_id: Mapped[int | None] = mapped_column(
        ForeignKey("stock_location.id"), nullable=True, index=True)
```

La idempotencia NO cambia: el triple `(reason, ref_type, ref_id)` sigue siendo
único por org. `location_id` es un atributo del movimiento, no de la clave de
dedup. Un `po_receive` de la misma `po_line` a la misma ubicación sigue siendo
un solo movimiento.

### 3.5 Extensión de `Vendor` (rating)

```python
    # --- Vendor rating (fase Inventory Depth) ---
    rating: Mapped[float] = mapped_column(Float, default=0.0)   # 0..5, manual o calculado
    lead_time_days: Mapped[int] = mapped_column(Integer, default=0)  # promedio observado
    on_time_pct: Mapped[float] = mapped_column(Float, default=0.0)   # % PO recibidas a tiempo
```

`rating` puede ser manual (el usuario pone estrellas) o derivado de
`on_time_pct` + `lead_time_days` observados de las PO. Arrancamos manual y
calculamos en un increment posterior.

### 3.6 Nota de migración Alembic

Una migración, aditiva y segura:

1. `create_table("stock_location")` y `create_table("part_stock_level")`.
2. `add_column` en `part`: `barcode, min_qty, max_qty, last_price_paid,
   last_price_at, last_vendor_id`.
3. `add_column` en `part_stock_movement`: `location_id` (nullable).
4. `add_column` en `vendor`: `rating, lead_time_days, on_time_pct`.
5. **Data migration (upgrade):** por cada org, crear una `StockLocation` default
   (`code="MAIN", kind="warehouse", is_default=True`). Por cada `Part` con
   `on_hand != 0`, crear un `PartStockLevel` en esa ubicación con el `on_hand`
   actual, y backfill `min_qty = reorder_point`. Los movimientos históricos
   quedan con `location_id = NULL` (se asumen de la ubicación default en las
   lecturas; no se re-escriben).

Todo nullable / con default, así que el `downgrade` es un `drop_column` /
`drop_table` limpio. Como en dev corremos SQLite, la migración usa
`batch_alter_table` para los `add_column` (SQLite no soporta ALTER en línea).

## 4. Backend (core + endpoints; reglas)

### 4.1 `core/stock_locations.py` (nuevo)

CRUD de ubicaciones, espejando `core/parts.py` (serializer a dict, org-scoping
automático vía los eventos de `SessionLocal`):

- `list_locations(active_only=True) -> list[dict]`
- `create_location(data) -> dict` — `code` único por org (constraint backstop).
- `update_location(id, data) -> dict | None`
- `deactivate_location(id) -> bool` — no borra si tiene stock; hace `active=False`.
- `default_location_id() -> int` — la `is_default`, creándola si falta.

### 4.2 `core/inventory.py` (extender `adjust`, el corazón)

`adjust()` gana un parámetro `location_id`. **La firma sigue retrocompatible**:
si no se pasa, cae en la ubicación default. Reglas:

```python
def adjust(part_number, delta, reason, ref_type="", ref_id="",
           note="", location_id=None) -> dict:
    # ... validación igual ...
    if location_id is None:
        location_id = stock_locations.default_location_id()
    # Guard de idempotencia: SIN CAMBIOS. (reason, ref_type, ref_id) por org.
    # _bump_on_hand ahora hace DOS cosas:
    #   1) upsert de PartStockLevel(part_number, location_id) += delta
    #   2) Part.on_hand = SUM(part_stock_level.on_hand) de esa parte  (total)
```

Regla dura: `Part.on_hand` es **siempre** `SUM(part_stock_level.on_hand)`. Nunca
se escribe a mano; se recalcula al bumpear. Así el listado de `/parts` sigue
mostrando el total sin recorrer el ledger, y nadie puede desincronizar el total
de las partes.

`manual_adjust()` gana `location_id`. `low_stock_list()` cambia de
`on_hand <= reorder_point` a `on_hand <= min_qty` (con `min_qty > 0`), y agrega
`suggested_order_qty = max_qty - on_hand` (si `max_qty > 0`) para alimentar el
QuickBuy y la automatización. Se agrega `stock_by_location(part_number)` que
devuelve el desglose por ubicación (para el detalle de la parte y el scan-count).

### 4.3 `core/purchasing.py` (receiving por ubicación + last-price-paid)

El hook de `update_po(... status="received")` hoy llama `inventory.adjust(pn,
qty, "po_receive", ref_type="po_line", ref_id=line_id)`. Se extiende:

- Cada `POLine` gana un `receive_location_id` opcional (a qué bodega entra). Si
  no se especifica, la default.
- Al recibir, además del `adjust`, se setea en la `Part`:
  `last_price_paid = ln.unit_cost`, `last_price_at = now`,
  `last_vendor_id = <vendor de la PO>`. Esto cierra el loop de "cuánto pagué la
  última vez".
- Si la PO tiene `ordered_at` registrado, se actualiza el `lead_time_days`
  observado del vendor y el `on_time_pct` (recepción a tiempo sí/no). Esto
  alimenta el rating.

La idempotencia protege todo: re-pasar a `received` no duplica el stock (guard
del ledger) y el `last_price_paid` es un set idempotente (mismo valor).

### 4.4 Decisión: ¿decrementar al agregar a la WO (Fleetio) o al facturar (hoy)?

Fleetio decrementa al **agregar** la parte a la WO. Nosotros hoy consumimos al
**facturar** (`wo_consume`). Recomendación para el spec:

- **Mantener `wo_consume` al facturar como el evento de stock definitivo.**
- Agregar un movimiento de **reserva** blando (`reason="wo_reserve"`, delta
  negativo, misma idempotencia por `wo_line`) al agregar la parte a una WO
  abierta, para que el "disponible" refleje lo comprometido. Al facturar, la
  reserva se convierte en consumo; al borrar la línea o cerrar la WO sin
  facturar, se revierte.
- `available = on_hand - reservado`. Es lo que ve el técnico. Esto nos da el
  comportamiento de Fleetio (no vender lo que ya está comprometido) sin perder
  la auditoría fuerte del consumo real. Se puede diferir a un segundo increment:
  el modelo lo soporta sin cambios de esquema (solo un `reason` nuevo).

### 4.5 Endpoints (`api/routes.py`, patrón existente bajo `/api`)

- `GET  /parts/locations` · `POST /parts/locations` · `PATCH /parts/locations/{id}` · `DELETE /parts/locations/{id}`
- `GET  /parts/{part_number}/stock` — desglose por ubicación (`stock_by_location`).
- `POST /parts/adjust` — extiende `StockAdjustIn` con `location_id: int | None`.
- `GET  /parts/lookup?barcode=...` — resuelve un UPC/code128 a una parte. Es el
  endpoint que consume el scanner. Devuelve la parte + su `stock_by_location`.
- `GET  /parts/low-stock` — igual ruta, ahora contra `min_qty` y con
  `suggested_order_qty`.
- `GET  /parts/velocity?days=90` — movimientos de consumo por parte en la
  ventana (para el reporte de velocity).
- `GET  /parts/obsolete?days=180` — partes con `on_hand > 0` sin ningún
  `wo_consume` en la ventana y con `last_price_paid * on_hand` como capital
  inmovilizado (el pitch de SquareRigger).

Scopes: igual que hoy. Las lecturas exigen `parts:read`; los ajustes y el CRUD
de ubicaciones exigen `parts:write` (o `inventory:write` si se separa).

## 5. UI (React; dónde encaja; estados vacío/carga/error)

Todo cuelga de `PartsPage` (que ya existe). No se crea una página nueva; se
agregan una pestaña, un panel de detalle y un modo scanner.

- **Columna "Stock" en la tabla de partes**: muestra el total (`on_hand`) con un
  chip por ubicación al hacer hover/expandir (`WH1: 8 · TRK3: 2`). Si
  `on_hand <= min_qty`, chip rojo "Low"; si `available < min_qty` por reservas,
  chip ámbar.
- **Panel de detalle de parte** (drawer lateral al hacer click en una fila):
  - Tab **Stock**: tabla `ubicación · on_hand · reservado · disponible`, con
    botón "Ajustar" por fila (abre el `POST /parts/adjust` con `location_id`).
  - Campo **Barcode** con botón "Escanear" (usa la cámara vía la API del
    navegador o un lector USB, que teclea el código en el input enfocado).
  - Bloque **Min / Max** editable (reemplaza el input plano de reorder point).
  - Bloque **Last price paid**: `$X pagado el DD/MM a <Vendor>` en solo lectura.
- **Sub-página / pestaña "Ubicaciones"**: CRUD de `StockLocation` (code, name,
  kind, aisle/row/bin, default). Tabla simple estilo Vendors.
- **Modo Scanner (scan-to-count)**: un botón "Conteo por escaneo" abre un panel
  enfocado en un input; cada escaneo hace `GET /parts/lookup?barcode=`, muestra
  la parte y un input de cantidad, y arma un lote de ajustes que se confirma al
  final (un `POST /parts/adjust` por línea, `reason="manual"`, todos a la
  ubicación elegida arriba).
- **Reportes**: dos tarjetas en el dashboard de partes — "Velocity (90d)" y
  "Obsoleto ($ inmovilizado)".

Estados obligatorios en cada panel:

- **Vacío**: sin ubicaciones → "Todavía no tenés ubicaciones. Se usa **MAIN** por
  defecto." con CTA "Crear ubicación". Sin barcode → placeholder "Sin código.
  Escaneá o escribí uno." Velocity/obsoleto sin datos → "Sin movimientos en la
  ventana."
- **Carga**: skeleton de filas en la tabla de stock; spinner inline en el lookup
  del scanner (el input NO se bloquea, para no romper el ritmo de escaneo rápido).
- **Error**: barcode no encontrado en el scanner → banner ámbar "Código `XXX` sin
  parte. ¿Crear una?" con CTA que pre-llena el barcode en el form de nueva parte.
  Fallo de `adjust` → toast rojo con retry, sin perder el lote de conteo en curso.

## 6. Automatizaciones (cap 04)

Esta feature es, sobre todo, **combustible para el motor de automatizaciones**.
Triggers y acciones que habilita:

- **Trigger `stock.below_min`** (por parte y por ubicación): dispara cuando un
  `adjust` deja `on_hand <= min_qty`. Payload: parte, ubicación, `on_hand`,
  `min_qty`, `suggested_order_qty = max_qty - on_hand`, `last_vendor_id`,
  `last_price_paid`.
- **Acción `create_quickbuy_po`**: arma un draft de PO al `last_vendor_id` con
  una línea `qty = suggested_order_qty` y `unit_cost = last_price_paid`. Esto es
  el QuickBuy actual, pero ahora la automatización lo puede llenar SOLA porque
  tiene min/max, last-price y vendor. Es el re-pedido automático de RTA.
- **Regla anti-spam**: no crear una segunda PO si ya hay una `draft`/`ordered`
  con esa parte para ese vendor (dedup por `(part_number, vendor, status!=received)`).
- **Trigger `part.obsolete`** (programado, no por evento): corre el reporte de
  obsoletos semanal y notifica "$X en N partes sin movimiento en 180 días".
- **Trigger `vendor.late_delivery`**: al recibir una PO tarde, baja el
  `on_time_pct` y, si cruza un umbral, notifica para revisar el vendor.

El ledger idempotente es lo que hace esto seguro: una automatización puede
correr en cada cambio de stock sin miedo a duplicar movimientos ni PO (la dedup
de PO + el guard del ledger cubren el doble disparo).

## 7. Integraciones que toca

- **Catálogo de partes externo (FindItParts / PartsTech, cap 04)**: es la
  fuente natural del **barcode/UPC**, de la **descripción/specs** y de la
  **imagen** de la parte (el "Smart Fill" de SquareRigger). El flujo: buscás en
  el marketplace (endpoint `/parts/marketplace/search` ya existe), elegís un
  resultado y se pre-llena `part_number, description, barcode, cost`. Ese `cost`
  del catálogo es distinto del `last_price_paid` (uno es precio de lista, el
  otro lo que realmente pagaste): se muestran ambos.
- **Purchase Orders / QuickBuy (ya existe)**: es donde se setea
  `last_price_paid` y donde entra el receiving por ubicación (sección 4.3). La
  automatización de re-pedido produce PO drafts.
- **Work Orders**: consumen stock (`wo_consume`) y, con la reserva opcional
  (4.4), decrementan el disponible al agregar la línea. La WO elige de qué
  ubicación sale la parte (default: la del técnico / su camión de servicio).
- **QuickBooks (integración priorizada del roadmap)**: el valor de inventario
  (`SUM(on_hand * last_price_paid)`) y los movimientos son la base de un asiento
  de inventario a futuro. Fuera de alcance de esta feature, pero el modelo lo
  soporta.
- **Escáner físico**: lectores USB HID (teclean el código) funcionan sin
  integración; la cámara del navegador es un plus progresivo.

## 8. Esfuerzo (S/M/L) · prioridad · dependencias

**Prioridad: 🟠 (media-alta).** Es un diferenciador claro contra Fullbay/RTA y el
habilitador del re-pedido automático, pero no bloquea el go-live: el inventario
plano de una ubicación ya funciona.

Desglose por increment (permite entregar valor por partes):

| Increment | Alcance | Esfuerzo |
|---|---|---|
| **A — Ubicaciones + stock por ubicación** | `StockLocation`, `PartStockLevel`, migración con backfill, `adjust(location_id)`, `on_hand = SUM`, CRUD + UI de ubicaciones, columna de stock por ubicación | **M** |
| **B — Barcode + scan flows** | Campo `barcode`, `/parts/lookup`, modo scan-to-count, scan-to-add-to-WO | **M** |
| **C — Min/Max + last-price-paid + QuickBuy auto** | `min_qty/max_qty`, migración de `reorder_point`, `suggested_order_qty`, set de last-price en receiving, trigger `stock.below_min` + acción `create_quickbuy_po` (cap 04) | **M** |
| **D — Vendor rating + velocity + obsoletos** | Campos de rating en `Vendor`, cálculo de `on_time_pct`/`lead_time`, reportes velocity y obsoleto | **S–M** |
| **E (diferible) — Reservas** | `wo_reserve`, `available = on_hand - reservado` | **S** |

Total realista: **L** si se toma completo; entregable como 4 M + 1 S.

Dependencias:

- **Duras**: motor de automatizaciones (cap 04) para los increments C y D (el
  trigger/acción). El modelo de datos NO depende de él (se puede construir
  A/B sin automatizaciones).
- **Blandas**: integración de catálogo externo (cap 04) potencia B (Smart Fill
  del barcode), pero B funciona con barcode tipeado a mano.
- **Base ya lista**: `Part`, `PartStockMovement`, `PurchaseOrder`/`POLine`,
  `Vendor`, ledger idempotente, hooks WO/PO, `low_stock_list`, QuickBuy. No se
  parte de cero: se extiende.

Riesgo principal: la **data migration** (backfill de `PartStockLevel` desde el
`on_hand` global). Es aditiva y reversible, pero hay que probarla contra la BD de
producción (Postgres) y contra SQLite dev (batch mode). Mitigación: la migración
no toca los movimientos históricos (quedan `location_id NULL` = default).

## 9. Ejemplo end-to-end con datos realistas

**Contexto.** Taller con dos ubicaciones: `WH1` (bodega, default) y `TRK3`
(camión de servicio del técnico Marco). Parte: filtro de aceite Fleetguard
`LF9009`, `min_qty=4`, `max_qty=12`, `last_price_paid=$18.40`, vendor "FleetPride".

**Estado inicial.** `PartStockLevel`: WH1 = 3, TRK3 = 1 → `Part.on_hand = 4`.
Como `on_hand (4) <= min_qty (4)`, la parte ya está en `low-stock`.

1. **Scan-to-add-to-WO.** Marco abre la WO #218 del truck 4471, escanea la caja
   del filtro. `GET /parts/lookup?barcode=049881600902` → resuelve a `LF9009`,
   muestra `TRK3: 1 · WH1: 3`. Marco elige su camión (`TRK3`) y agrega la línea.
   Con reservas (increment E) se crea `wo_reserve` −1 en TRK3 → disponible TRK3
   = 0. Sin reservas, no pasa nada hasta facturar.

2. **Facturación de la WO.** Al facturar la #218, el hook `wo_consume` corre:
   `inventory.adjust("LF9009", -1, "wo_consume", ref_type="wo_line",
   ref_id=<line_id>, location_id=<TRK3>)`. Movimiento único (idempotente). TRK3
   pasa de 1 → 0. `Part.on_hand` se recalcula: `SUM = WH1 3 + TRK3 0 = 3`.

3. **Automatización de re-pedido (cap 04).** El `adjust` dejó `on_hand=3`, que
   es `< min_qty (4)` → dispara `stock.below_min`. Payload:
   `suggested_order_qty = max_qty(12) - on_hand(3) = 9`, `last_vendor_id =
   FleetPride`, `last_price_paid = 18.40`. La acción `create_quickbuy_po` crea
   una PO **draft** a FleetPride con una línea `LF9009 × 9 @ $18.40 = $165.60`.
   La regla anti-spam confirma que no hay otra PO abierta de esa parte para ese
   vendor. El jefe recibe una notificación "Re-pedido sugerido: LF9009 ×9".

4. **Receiving.** Llega la mercancía. El jefe pasa la PO a `received` y elige
   `receive_location_id = WH1`. El hook: `inventory.adjust("LF9009", +9,
   "po_receive", ref_type="po_line", ref_id=<line_id>, location_id=<WH1>)`. WH1
   pasa de 3 → 12. `Part.on_hand = SUM = WH1 12 + TRK3 0 = 12`. Además se setea
   `last_price_paid = $18.40` (o el nuevo unit_cost si cambió), `last_price_at =
   hoy`, `last_vendor_id = FleetPride`. Si la PO se recibió dentro del lead time,
   `on_time_pct` de FleetPride sube.

5. **Conteo físico (scan-to-count).** Fin de mes. El encargado entra a "Conteo
   por escaneo", elige `WH1`, escanea filtros: cuenta **11** (uno se rompió). El
   panel arma un ajuste `manual` de delta `−1` para `LF9009` en WH1 y lo
   confirma en lote. WH1 12 → 11, `Part.on_hand = 11`. El movimiento queda en el
   ledger con `note="conteo físico mensual"`.

6. **Reporte de obsoletos.** El truck 4471 dejó de circular; el filtro premium
   `LF14000NN` (on_hand 6, last_price $41.10) no tiene ningún `wo_consume` en
   180 días. `GET /parts/obsolete?days=180` lo lista con `$246.60` de capital
   inmovilizado. El jefe decide devolverlo o transferirlo. Esto es, literal, el
   argumento de venta de SquareRigger ("recuperá el 25% de tu inventario
   obsoleto"), corriendo sobre nuestro propio ledger.
