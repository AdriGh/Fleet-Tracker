# Feature: Lifecycle / TCO + recomendación de reemplazo

> Prioridad 🟡 · EXTIENDE los reportes de spend que ya existen (`core/reports.py`,
> `/api/reports/spend`, `ReportsPage.tsx`). No es un módulo nuevo desde cero: es
> la capa de **costo total de propiedad por activo** montada sobre la agregación
> de gasto de mantenimiento que ya tenemos, más los datos financieros y de
> combustible que faltan.

## 1. Qué es y por qué importa

Hoy Reports responde "cuánto gasté en frenos este trimestre". No responde la
pregunta cara: **"¿esta unidad ya no conviene tenerla?"**. El dueño de flota
decide reemplazos por olfato (kilometraje alto, muchas visitas al taller), no por
número. Ese olfato le cuesta plata en las dos direcciones: retiene camiones que ya
gastan más en mantenimiento de lo que valen, y a veces reemplaza uno bueno porque
"se siente viejo".

El **TCO por activo** junta las cuatro fuentes de costo de un camión/trailer a lo
largo de su vida: **mantenimiento** (de las Work Orders, que ya sumamos),
**combustible** (de FuelTransaction, futuro), **depreciación** (del precio de
compra vs valor residual) y **financiamiento** (interés del préstamo/lease). Con
eso calculamos un **cost-per-mile total** y lo comparamos contra el valor del
activo y su vida útil esperada. Cuando el cost-per-mile sube más allá de un
umbral, o el mantenimiento acumulado supera un porcentaje del valor del activo, o
la edad/millaje pasa la vida útil configurada → la unidad se marca **candidata a
retiro**.

Por qué importa para el negocio:

- **Cierra el bucle de Reports.** Ya medimos gasto; esto lo convierte en una
  decisión ("retirá la 118, reemplazala") con el número que la respalda.
- **Es el pitch de venta de Fleetio 2026 y del "Lifecycle Management" de
  SquareRigger.** Sin esto, en un demo lado a lado tenemos un hueco visible.
- **Aprovecha data que ya cargamos.** El jefe ya mete cada invoice del taller como
  una WO. El TCO no le pide trabajo nuevo salvo cargar UNA vez los datos
  financieros del activo (precio, fecha, vida útil).

## 2. Referencia competitiva

- **Fleetio** — su push 2026. **TCO rollup por activo**: combustible + préstamos/
  leases + mantenimiento + depreciación, todo sumado por vehículo. Sobre eso monta
  **right-sizing / utilización / planificación de reemplazo de ciclo de vida**.
  Es el benchmark de diseño: TCO como número de primera clase en el perfil del
  activo, no enterrado en un reporte.
- **SquareRigger** — "Lifecycle Management": modela el ciclo completo
  **adquisición → mantenimiento → depreciación → reventa**, optimiza el **ciclo de
  reemplazo** y **marca activos bajo-performantes para retiro**. Su ángulo fuerte
  es el valor de reventa/recuperación al final de la vida.
- **RTA** — "Fleet Success Scorecard" + reportes de **recomendación de reemplazo**
  y **forecast de necesidades de capital** (cuánta plata vas a necesitar para
  renovar la flota en los próximos N años). El ángulo de RTA es el de planificación
  presupuestaria, no solo por-activo.

Dónde jugamos nosotros: los tres tienen el TCO detrás de "Request a Demo" o en un
tier caro. Nuestro diferencial es que **ya tenemos la mitad hecha** (el spend por
WO) y podemos mostrar el TCO real con la data del cliente en el primer día, sin
setup de meses. El candidato-a-retiro con su curva de costo es un momento "wow"
barato de construir.

## 3. Modelo de datos (SQLAlchemy; EXTIENDE los reportes de spend existentes; nota migración Alembic)

Dos piezas nuevas. Ninguna toca las tablas de spend: `spend_report` sigue leyendo
`WorkOrder`/`WorkOrderLine` igual que hoy. El TCO **compone** esa agregación con
las nuevas fuentes.

### 3.1 `AssetFinancials` — datos económicos por activo (nuevo)

Uno-a-uno con `Unit` por número de unidad (misma clave de negocio que usa el resto
de la app). Es opcional: una unidad sin fila financiera todavía tiene TCO de
mantenimiento + combustible, solo le falta depreciación/financiamiento.

```python
class AssetFinancials(OrgScoped, Base):
    """Datos económicos de un activo para el cálculo de TCO (fase Lifecycle).

    Uno-a-uno con Unit por `unit` (número de unidad, único por organización).
    Todo opcional: sin esta fila, el TCO de la unidad sale solo de mantenimiento
    (WOs) + combustible (FuelTransaction). Con ella se suman depreciación y
    financiamiento. org-scoped (multi-tenant, H6 fase 3)."""
    __tablename__ = "asset_financials"
    __table_args__ = (
        UniqueConstraint("org_id", "unit", name="uq_assetfin_org_unit"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    unit: Mapped[str] = mapped_column(String(64), index=True)

    # Adquisición
    acquisition_cost: Mapped[float] = mapped_column(Float, default=0.0)
    acquisition_date: Mapped[str | None] = mapped_column(
        String(10), nullable=True)              # YYYY-MM-DD
    # Vida útil esperada y salvamento (para depreciación lineal)
    expected_life_years: Mapped[float] = mapped_column(Float, default=0.0)
    expected_life_miles: Mapped[int | None] = mapped_column(
        Integer, nullable=True)
    residual_value: Mapped[float] = mapped_column(Float, default=0.0)  # salvage

    # Financiamiento (préstamo o lease). finance_type: '' | loan | lease
    finance_type: Mapped[str] = mapped_column(String(10), default="")
    monthly_payment: Mapped[float] = mapped_column(Float, default=0.0)
    interest_rate: Mapped[float] = mapped_column(Float, default=0.0)  # APR %
    term_months: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Umbrales de reemplazo (override por-activo; '' o 0 = usa el default de org)
    replace_cpm_threshold: Mapped[float] = mapped_column(Float, default=0.0)
    replace_m2v_threshold: Mapped[float] = mapped_column(Float, default=0.0)

    notes: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime)
```

### 3.2 `FuelTransaction` — costo de combustible por unidad (futuro, ya asumido)

El prompt lo marca como futuro; el TCO lo trata como fuente opcional (si no hay
filas, el componente combustible es 0 y el TCO sigue siendo válido, solo más
conservador). Se documenta acá el mínimo que el cálculo de TCO necesita leer:

```python
class FuelTransaction(OrgScoped, Base):
    """Transacción de combustible por unidad (fase Fuel mgmt, futuro).

    La alimenta el import de fuel-cards o el sync de telematics. El TCO solo
    necesita: unidad, fecha, galones, monto y odómetro. org-scoped."""
    __tablename__ = "fuel_transaction"

    id: Mapped[int] = mapped_column(primary_key=True)
    unit: Mapped[str] = mapped_column(String(64), index=True)
    ts: Mapped[datetime] = mapped_column(DateTime, index=True)
    gallons: Mapped[float] = mapped_column(Float, default=0.0)
    amount: Mapped[float] = mapped_column(Float, default=0.0)   # USD total
    odometer: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source: Mapped[str] = mapped_column(String(20), default="manual")
```

### 3.3 Odómetro / utilización

El cost-per-mile necesita millas recorridas. Vienen del **sync de telematics**
(`core/providers/`, que ya trae odómetro y utilización) y, como fallback, del
`mileage` que el jefe carga en cada WO y del `odometer` de `FuelTransaction`. No
hace falta tabla nueva: `core/lifecycle.py` resuelve las millas del período con la
mejor fuente disponible (telematics > fuel > WO), documentado en §4.

### Nota migración Alembic

Sumar `AssetFinancials` (y a futuro `FuelTransaction`) es **puramente aditivo**:
tablas nuevas, ninguna columna sobre tablas existentes, ningún cambio a las de
spend. Sigue el patrón ya establecido en `db.py`:

- **Postgres (prod):** una revisión Alembic nueva (`alembic revision --autogenerate
  -m "asset_financials + fuel_transaction"` → revisar → `alembic upgrade head`).
  Como son tablas nuevas, `create_all` sobre una base fresca también las levanta,
  pero el camino correcto en prod es la migración versionada.
- **SQLite (dev):** `Base.metadata.create_all` las crea solas (tablas faltantes);
  no requieren un `ALTER TABLE` en `_migrate()` porque no agregamos columnas a
  tablas viejas. Si más adelante se agregara una columna a `Unit`, ahí sí iría un
  bloque en `_migrate()`.
- Ambas tablas heredan de `OrgScoped`: el `org_id` lo completa y lo filtra la capa
  ORM (`_assign_org_on_insert` / `_scope_select_to_org`), igual que el resto. No se
  pasa `org_id` a mano en las queries.

## 4. Backend (core + endpoints; reglas)

### 4.1 `core/lifecycle.py` (nuevo)

Módulo hermano de `core/reports.py`. Reusa sus helpers en vez de duplicarlos:
`_effective_date`, `_parse_date` y el propio recorrido de líneas. La regla de qué
WO cuenta es la MISMA que spend (cualquier orden no-borrador con líneas de monto
> 0; ver `_EXCLUDED_STATUSES` en `reports.py`), para que el mantenimiento del TCO
cuadre exactamente con lo que muestra el reporte de spend.

**Componentes del TCO de un activo** (en una ventana `[from, to]`, default = vida
del activo):

1. **Mantenimiento** — suma de líneas de sus WOs en la ventana. Reusa la lógica de
   `spend_report` filtrada por unidad. Ya lo tenemos: es el `by_unit` de spend,
   pero desglosado en el tiempo para la curva.
2. **Combustible** — suma de `FuelTransaction.amount` de la unidad en la ventana.
   0 si no hay filas.
3. **Depreciación** — lineal:
   `(acquisition_cost - residual_value) / expected_life_years`, prorrateada a la
   ventana. Si falta `acquisition_cost` o `expected_life_years`, el componente es
   0 y se marca `depreciation_estimated=false`.
4. **Financiamiento** — interés pagado en la ventana. Simplificación v1:
   `monthly_payment * meses_en_ventana - principal_amortizado`, o si falta el
   desglose, `acquisition_cost * interest_rate/100 * años_en_ventana` como
   aproximación. Se marca `finance_estimated=true` cuando se aproxima.

**Millas del período** (`_period_miles(unit, from, to)`): mejor fuente disponible
en orden telematics (odómetro fin − inicio del sync) → delta de `odometer` en
`FuelTransaction` → suma de deltas de `mileage` entre WOs consecutivas. Si no hay
ninguna, `miles = 0` y el cost-per-mile queda `null` (no dividimos por cero; la UI
lo muestra como "sin datos de millaje").

**Métricas derivadas por activo:**

- `tco_total = maint + fuel + depreciation + finance`
- `cost_per_mile = tco_total / miles` (o `null` si `miles == 0`)
- `maint_per_mile = maint / miles`
- `maint_to_value = maint_ventana / current_value`, donde
  `current_value = max(residual_value, acquisition_cost − depreciación acumulada)`
- `age_years` y `age_miles` desde `acquisition_date` / odómetro actual
- `life_used_pct = max(age_years / expected_life_years, age_miles / expected_life_miles)`

### 4.2 Motor de recomendación de reemplazo

Una unidad es **candidata a retiro** si cruza CUALQUIERA de estos gates (el
primero que dispara da la razón principal; se listan todas las razones):

- **cost-per-mile** > `replace_cpm_threshold` (override del activo, o el default de
  org). Señal de que operarla ya sale caro por milla.
- **maintenance-to-value** > `replace_m2v_threshold` (p.ej. 0.5 → gastaste en
  mantenimiento anual más de la mitad de lo que hoy vale el activo).
- **life_used_pct** ≥ 1.0 → edad o millaje pasaron la vida útil configurada.

Cada candidato devuelve un **score de urgencia** (0–100, combinación normalizada de
cuánto excede cada umbral) para ordenar el dashboard, y una **razón legible**
("Cost/mile $0.71 supera el umbral $0.55" · "Mantenimiento del último año = 62% del
valor actual").

**La curva de costo (por qué existe el punto óptimo de reemplazo).** El costo de
mantenimiento por milla **sube con la edad**: un camión nuevo casi no rompe, uno
viejo acumula fallas caras (motor, aftertreatment, suspensión). La depreciación
hace lo contrario: **cae con la edad** (un activo viejo ya perdió casi todo su
valor, deprecia poco por año). El **costo total por milla** es la suma de ambas
curvas: alto al principio (deprecia mucho), baja hasta un mínimo, y vuelve a subir
cuando el mantenimiento se dispara. Ese **mínimo es el punto óptimo de reemplazo**:
tener el activo más allá de ese punto significa que cada milla extra cuesta más que
reemplazarlo. El motor aproxima ese punto comparando el cost-per-mile marginal
reciente contra el cost-per-mile promedio de un reemplazo típico de esa clase
(configurable por org). RTA lo llama "recomendación de reemplazo"; nosotros lo
mostramos como la curva + el marcador del óptimo.

### 4.3 Endpoints (`api/routes.py`, router `reports`)

Se agregan al mismo router `reports` que ya expone `/reports/spend`. GET, solo
requieren estar autenticado (mismo middleware que los otros GET de reports). Rango
vacío o sin datos → ceros/arrays vacíos, nunca rompe (misma convención que
`spend_report`).

- `GET /api/reports/tco` — TCO rollup de la flota. Query: `from`, `to`, `terminal`,
  `top_units`. Devuelve totales de flota + array por-activo con los componentes y
  las métricas derivadas. **Extiende** la forma de salida de spend (mismos
  `range`/`totals`, más `by_asset`).
- `GET /api/reports/tco/{unit}` — detalle de un activo: componentes desglosados +
  la **serie temporal de la curva de costo** (mantenimiento/milla y costo total/
  milla por período) para graficar el punto óptimo.
- `GET /api/reports/replacement-candidates` — lista de candidatos a retiro,
  ordenada por score de urgencia, con razones y las métricas que dispararon el
  gate. Query: `terminal`, `limit`.

Escritura de los datos financieros (fuera del router de reports, junto a los CRUD
de unidades):

- `PUT /api/units/{unit}/financials` — upsert de `AssetFinancials` (requiere scope
  de edición, igual que editar la unidad).

## 5. UI (React; dónde encaja; estados vacío/carga/error)

Encaja en dos lugares, reusando los patrones de `ReportsPage.tsx`:

**(a) Nueva pestaña "TCO" en Reports** (junto a la de Spend, con el mismo
`Tabs` del design-system). Cockpit denso, misma estética que el de spend:

- **KPIs** arriba (`CountUp`): TCO total de flota, cost-per-mile promedio, # de
  candidatos a retiro, activo más caro por milla.
- **Tabla por activo**: unidad · TCO · cost/mile · maint/mile · maint-to-value ·
  life-used% · badge de estado (verde OK / ámbar "vigilar" / rojo "candidato a
  retiro"). Reusa la paleta de estado que ya define `CAT_COLOR` /
  `var(--st-*)` en ReportsPage.
- **Donut de composición del TCO de la flota** (mantenimiento / combustible /
  depreciación / financiamiento) reusando el mismo componente de donut que hoy
  muestra el gasto por categoría.
- Filtros de rango (presets `mtd`/`qtd`/`ytd`/`all`/`custom`) y terminal,
  idénticos a los de spend (mismo `useTerminals`, mismos presets).

**(b) Card "Lifecycle / TCO" en el perfil de la unidad** (Fleet → perfil): el TCO
del activo, sus cuatro componentes, y **la curva de costo** (SVG inline, mismo
estilo que la tendencia mensual de ReportsPage) con el marcador del punto óptimo de
reemplazo. Si es candidato a retiro, un banner con la razón.

**(c) Widget "Replacement candidates"** en el dashboard de Reports: top N
candidatos con su razón y score, cada uno enlazando al perfil de la unidad.

Estados (misma disciplina que ReportsPage, que ya usa `Skeleton` +
`keepPreviousData` + `notifyErr`):

- **Carga:** `Skeleton` en KPIs, tabla y curva (con `keepPreviousData` para no
  parpadear al cambiar filtros).
- **Vacío global** (sin WOs ni financials): estado ilustrado "Todavía no hay datos
  de costo" con CTA a cargar los datos financieros de una unidad.
- **Vacío parcial** (hay mantenimiento pero falta `AssetFinancials`): el TCO se
  muestra igual, con badge "estimado — falta precio de compra / vida útil" y un
  link para completarlo. Nunca se oculta el número; se marca su confianza.
- **Sin millaje:** cost-per-mile como "—" con tooltip "sin datos de odómetro"; el
  TCO total sigue visible.
- **Error:** toast vía `notifyErr` + estado de reintento, igual que hoy.

## 6. Automatizaciones (cap 04)

El TCO/lifecycle es una **fuente de triggers de primera clase** para el motor de
automatizaciones (cap 04). Eventos y acciones que expone:

- **Trigger `asset.replacement_candidate`** — se emite cuando una unidad cruza un
  gate por primera vez (edge, no cada evaluación). Payload: unidad, razón, score,
  métricas.
- **Trigger `asset.cost_per_mile_exceeded`** — cost-per-mile cruza el umbral en la
  última ventana móvil.
- **Trigger `asset.life_threshold`** — `life_used_pct` cruza 0.8 / 0.9 / 1.0
  (avisos escalonados antes del retiro).
- **Acciones** típicas encadenadas: notificar (Telegram/SMS/email vía los
  `*_service` que ya existen), crear una tarea/nota en el perfil, o abrir un ítem en
  un "plan de reemplazo".
- **Evaluación:** un job periódico (el mismo scheduler que corre alertas y PM)
  recomputa TCO por activo una vez al día y dispara los edges. Fija el contexto de
  tenant explícitamente (patrón del loop de alertas, ver nota de aislamiento en
  `db.py`), porque corre server-side sin request.

## 7. Integraciones que toca

- **Telematics (`core/providers/`)** — fuente primaria de odómetro/utilización para
  el cost-per-mile. Ya sincroniza; el TCO solo consume esa data.
- **Fuel cards / Fuel mgmt** — alimenta `FuelTransaction` (el componente
  combustible del TCO). Futuro; el TCO degrada con gracia sin él.
- **Work Orders / Reports** — fuente del componente mantenimiento; el TCO reusa
  `core/reports.py` para que ambos números cuadren.
- **QuickBooks (priorizado en el roadmap de integraciones)** — a futuro, los
  datos de adquisición/financiamiento y la depreciación pueden sincronizar con
  contabilidad (asset register), evitando doble carga. No es v1.
- **Alertas / notificaciones (`core/alerts.py`, `*_service`)** — canal de salida de
  los triggers de §6.

## 8. Esfuerzo (S/M/L) · prioridad · dependencias

- **Prioridad:** 🟡 (media). Alto valor de demo y de retención, pero no bloquea la
  paridad básica (spend ya cubre lo urgente). Va después de Warranty recovery y POs.
- **Esfuerzo:** **M**. Desglose:
  - `AssetFinancials` + CRUD + card de perfil: **S** (tabla nueva, patrón conocido).
  - `core/lifecycle.py` (TCO + curva + motor de candidatos) reusando
    `core/reports.py`: **M** (la lógica de componentes y millas es la parte fina).
  - UI cockpit TCO + curva SVG + widget candidatos: **M** (reusa mucho de
    ReportsPage, pero la curva y la tabla por-activo son nuevas).
  - Triggers de automatización: **S**, pero **depende del cap 04**.
- **Dependencias:**
  - **Dura:** los reportes de spend ya existentes (base del componente
    mantenimiento). ✅ ya está.
  - **Dura para cost-per-mile confiable:** odómetro del sync de telematics
    (`core/providers/`). Sin él, cae a millas de WO/fuel (menos preciso).
  - **Blanda:** `FuelTransaction` (Fuel mgmt) para el componente combustible; el
    TCO funciona sin él, solo más conservador.
  - **Blanda:** motor de automatizaciones (cap 04) para los triggers de §6; el
    reporte y el dashboard funcionan sin él.

## 9. Ejemplo end-to-end con datos realistas

**Unidad 118** — Freightliner Cascadia 2019, terminal CHASER.

Datos financieros cargados una vez (`PUT /api/units/118/financials`):

- `acquisition_cost` = $135,000 · `acquisition_date` = 2019-03-01
- `expected_life_years` = 7 · `expected_life_miles` = 750,000 · `residual_value` =
  $28,000
- `finance_type` = loan · `monthly_payment` = $2,150 · `interest_rate` = 6.5% ·
  `term_months` = 60 (ya pagado al 2026)
- umbrales: usa los defaults de org (`replace_cpm_threshold` = $0.55,
  `replace_m2v_threshold` = 0.45)

Ventana de análisis: **últimos 12 meses** (2025-07-01 → 2026-06-30).

El cálculo de `core/lifecycle.py`:

- **Mantenimiento** (de las WOs de la 118 en la ventana, mismo criterio que
  spend): 4 WOs, entre ellas un DPF/aftertreatment de $4,200 y un in-frame parcial
  de motor → **$19,400**.
- **Combustible** (`FuelTransaction`): 92,000 millas a ~6.1 mpg, diésel promedio
  $3.95/gal → **$59,600**.
- **Millas del período** (odómetro de telematics, fin − inicio): **92,000 mi**.
- **Depreciación** lineal: (135,000 − 28,000) / 7 = **$15,286/año** → $15,286 en la
  ventana de 12 meses.
- **Financiamiento**: préstamo ya amortizado en la ventana → **$0** de interés.

Rollup:

- `tco_total` = 19,400 + 59,600 + 15,286 + 0 = **$94,286**
- `cost_per_mile` = 94,286 / 92,000 = **$1.025/mi** (incluye combustible)
- `maint_per_mile` = 19,400 / 92,000 = **$0.211/mi**
- `current_value` ≈ 135,000 − depreciación acumulada (7 años ≈ tope) →
  ~**$28,000** (piso de salvamento)
- `maint_to_value` = 19,400 / 28,000 = **0.69**
- `age_years` = 7.3 · `age_miles` ≈ 720,000 · `life_used_pct` = **1.04**

**Recomendación:** la 118 dispara **tres** gates → candidata a retiro, score alto:

1. `maint_to_value` 0.69 > 0.45 → "Gastaste en mantenimiento el 69% de lo que hoy
   vale el activo."
2. `life_used_pct` 1.04 ≥ 1.0 → "Superó su vida útil (7.3 años / 720k mi vs 7 años
   / 750k mi)."
3. `maint_per_mile` $0.211 en tendencia creciente vs una unidad 2023 comparable en
   ~$0.09 → la curva de costo ya pasó su mínimo.

**En la UI:** en la pestaña TCO la 118 aparece con badge rojo y ordenada arriba en
"Replacement candidates" con la razón principal. En su perfil, la card Lifecycle
muestra los cuatro componentes y la curva de costo: mantenimiento/milla plano y
bajo hasta 2023, subiendo fuerte en 2025–2026; el marcador del punto óptimo cae a
fines de 2025 → el sistema recomienda reemplazo. **Si además hay una automatización
(cap 04)** con trigger `asset.replacement_candidate`, el jefe recibe un Telegram:
*"Unidad 118: candidata a retiro (mant. = 69% del valor, vida útil superada).
Cost/mile $1.03."*
