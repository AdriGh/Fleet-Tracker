# Feature: Technician Time Tracking ("ShopWatch")

## 1. Qué es y por qué importa

ShopWatch captura cuánto tiempo real dedica cada técnico a cada work order y lo compara contra el tiempo facturable (las líneas de labor de la WO) y contra un tiempo estándar (labor guide o histórico). De ahí salen las dos métricas que venden los competidores: **wrench-time %** (proporción de la jornada del técnico que está efectivamente fichado a un job, versus tiempo muerto) y **eficiencia** (horas estándar / horas reales). Hoy Fleet Tracker sabe qué se hizo y qué se facturó, pero no sabe cuánto tardó el técnico ni si el taller es productivo.

Por qué importa para el negocio del taller:

- **Productividad medible.** Sin fichaje, "el mecánico está ocupado" es una impresión. Con fichaje es un número por técnico, por día, por semana. Un taller de 4 técnicos que sube de 55% a 70% de wrench-time recupera el equivalente a más de medio técnico sin contratar a nadie.
- **Estimación y pricing.** El tiempo real acumulado por tipo de job (PM de tractor, cambio de clutch, DOT anual) construye un labor guide propio. Eso mejora los estimates y detecta labor infravendido (2 h facturadas, 4 h reales de forma sistemática).
- **Coaching, no vigilancia.** La brecha entre tiempo estándar y real por técnico identifica quién necesita training en qué (SquareRigger vende esto explícitamente como "training opportunities"), no para castigar sino para nivelar.
- **Accountability del labor.** RTA lo enmarca como "paperless shop": la transacción de labor ocurre en tiempo real desde el piso del taller, no se transcribe a mano al final del día.

Prioridad: **naranja**. Es un diferenciador de gestión de taller, no un bloqueante de compliance. Depende de que las work orders con líneas de labor ya existan (ya existen) y encaja limpio en el drawer de WO.

## 2. Referencia competitiva

- **SquareRigger — "Shopwatch" (nombre propio, del que tomamos el nuestro).** Trackea el tiempo del técnico en cada job. Expone **wrench-time %** y eficiencia; el claim de marketing es "boost technician wrench time to 80%+". Usa la brecha para identificar oportunidades de training. Es la referencia directa de este feature.
- **RTA — "Paperless Shop".** Transacciones de labor en tiempo real desde el taller; foco en productividad y accountability del mecánico. Añade **markups de labor por cliente** (la tarifa de labor cambia según a quién se le factura). Nos da la idea del clock-in/out en vivo y del rate configurable.
- **Fullbay — métricas de performance del técnico.** Compara **horas fichadas versus horas completadas/facturadas** y permite **asignar jobs por eficiencia** (mandar el job al técnico que rinde mejor en ese tipo de trabajo). Nos da el dashboard comparativo y el uso de la métrica para dispatch.

Consenso de los tres: fichaje en vivo desde el job, una métrica de utilización (wrench-time) y una de rendimiento (eficiencia vs estándar), y un reporte por técnico. Fleet Tracker puede igualar el núcleo reutilizando el modelo de líneas de labor que ya tiene, sin reinventar la WO.

## 3. Modelo de datos (SQLAlchemy; REUSÁ WoLine labor; nota migración Alembic)

Se agrega **una** tabla nueva, `TimeLog`, org-scoped como el resto. NO se crea un modelo de labor paralelo: el tiempo **facturable** sigue viviendo en `WorkOrderLine` con `kind="labor"` (`qty` = horas facturadas, `unit_cost` = tarifa/hora). `TimeLog` es el tiempo **real** fichado; el wrench-time y la eficiencia salen de cruzar las dos.

```python
class TimeLog(OrgScoped, Base):
    """Fichaje de tiempo real de un técnico contra una work order
    (ShopWatch). El tiempo FACTURABLE vive en WorkOrderLine(kind='labor');
    esta tabla es el tiempo REAL de reloj. La eficiencia y el wrench-time
    se calculan cruzando ambas (core/shopwatch.py).

    Un log abierto tiene ended_at NULL (reloj corriendo). status:
        running   -> fichado, en curso (ended_at NULL)
        stopped   -> cerrado normal (start/stop)
        manual    -> ingresado a mano (duración directa, sin reloj)
    """
    __tablename__ = "time_log"
    __table_args__ = (
        # Un técnico no puede tener dos relojes corriendo a la vez: a lo sumo
        # UN log abierto (ended_at NULL) por usuario. En Postgres se refuerza
        # con un índice único parcial (WHERE ended_at IS NULL); ver migración.
        # (Nombre reservado; el índice parcial se crea en la revisión Alembic.)
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    wo_id: Mapped[int] = mapped_column(ForeignKey("work_order.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("user.id"), index=True)
    # Reloj: started_at siempre; ended_at NULL mientras corre.
    started_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Duración en MINUTOS, cacheada al cerrar (o ingresada directa en 'manual').
    # Fuente de verdad para 'running' = now - started_at; para el resto = esta.
    minutes: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(10), default="running",
                                        index=True)
    note: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime)
```

Notas de diseño:

- **Técnico = `User`** (rol `mechanic`), no un string libre. `WorkOrder.mechanic` sigue siendo texto (autocompletado histórico) y no se toca; `TimeLog.user_id` es la referencia dura que necesitamos para agregados por persona. En un primer corte se puede matchear el `mechanic` string al `User.name` para pre-seleccionar quién ficha.
- **Duración canónica en minutos.** Para un log corriendo, la duración viva es `now - started_at`; se cachea en `minutes` recién al parar (evita depender del reloj en cada lectura y sobrevive a un log que quedó abierto). Un log `manual` guarda `minutes` directo y deja `started_at = ended_at`.
- **Un solo reloj por técnico.** Invariante de negocio: a lo sumo un `TimeLog` con `ended_at IS NULL` por `user_id`. En Postgres se refuerza con índice único parcial; en SQLite (dev) lo garantiza el core al fichar (auto-stop del log previo).
- **No se toca `WorkOrderLine`.** La línea de labor facturable es el estándar de facturación; separarla del tiempo real es deliberado (se factura lo pactado, no siempre lo que tardó).

**Migración Alembic.** Nueva revisión que hace `create_table("time_log")` con su FK a `work_order` y `user`, más un **índice único parcial** para el invariante de un-reloj-por-técnico:

```python
op.create_index(
    "uq_time_log_one_open_per_user", "time_log", ["user_id"],
    unique=True, postgresql_where=sa.text("ended_at IS NULL"))
```

En SQLite (dev), `init_schema()`/`create_all` crea la tabla; el índice parcial se omite (SQLite no lo soporta igual) y el invariante queda a cargo del core. En Postgres (prod) el path correcto es `alembic upgrade head`, consistente con la nota de `db.py`.

## 4. Backend (core + endpoints; reglas)

Nuevo módulo `core/shopwatch.py`. Reglas:

- `clock_in(wo_id, user_id, session_user)`: si el usuario ya tiene un log `running`, se auto-`stop` (cierra el anterior antes de abrir el nuevo) para respetar el invariante de un solo reloj. Crea `TimeLog(status="running", started_at=now)`. Requiere que la WO no esté en estado terminal `invoiced` (no se ficha contra una orden ya facturada). Un técnico solo puede fichar por sí mismo salvo rol elevado (ver scopes).
- `clock_out(user_id)`: cierra el log corriente del usuario; setea `ended_at=now`, `status="stopped"`, `minutes = round((ended_at - started_at)/60)`. Idempotente si no hay log abierto (devuelve el estado actual sin error).
- `add_manual(wo_id, user_id, minutes, note)`: alta directa sin reloj (`status="manual"`), para el tiempo de ayer que nadie fichó. `minutes > 0`.
- `edit_log` / `delete_log`: corrección de un log (típico: el técnico se olvidó parar y quedaron 6 h de un log nocturno). Recalcula `minutes` si cambian los timestamps.
- `wo_time(wo_id)`: suma de minutos reales de la WO, desglose por técnico, y **comparación con el labor facturable** de la WO (`sum(qty)` de las líneas `kind="labor"`). Devuelve `logged_min`, `billable_hours`, y `efficiency_pct = billable_hours / (logged_min/60) * 100`.
- `tech_report(period)`: agrega por `user_id` en el rango. Por técnico: `clocked_hours` (suma de `minutes`), `billable_hours` (suma de `qty` de líneas de labor de las WOs donde el técnico fichó), **`wrench_pct`** y **`efficiency_pct`** (definiciones abajo).

**Definiciones de las métricas** (documentadas en el módulo para que UI y reporte no diverjan):

- **Wrench-time %** = `horas fichadas a jobs / horas de presencia` × 100. La presencia (shift) no la tenemos como dato duro todavía, así que v1 la aproxima con una jornada configurable (`OrgSetting("shopwatch")`, default 8 h/día laborable) y suma los días con actividad. Es la métrica de **utilización**: cuánto de la jornada fue tiempo de llave. Se anota como aproximación hasta integrar un shift/attendance real.
- **Eficiencia %** = `horas estándar / horas reales` × 100. "Horas estándar" = horas facturables de labor (`WoLine.qty`) o, si hay labor guide, el estándar del job. >100% = más rápido que el estándar; <100% = más lento. Es la métrica de **rendimiento**.

Estándar de comparación (labor guide): v1 usa las horas facturables de la línea de labor como proxy del estándar (es lo que el jefe "esperaba cobrar"). v2 puede promediar el histórico de `TimeLog` por tipo de job (campaña/título normalizado) para un estándar propio del taller, sin depender de MOTOR/comprar labor data.

**Endpoints** (siguiendo `api/routes.py`, espejando el patrón de `/workorders/{id}/lines`; enforcement por scope en el middleware):

```
POST   /api/workorders/{wo_id}/clock-in      -> shopwatch.clock_in
POST   /api/workorders/{wo_id}/clock-out     -> shopwatch.clock_out
POST   /api/workorders/{wo_id}/time          -> shopwatch.add_manual  (body: minutes, user_id?, note)
GET    /api/workorders/{wo_id}/time          -> shopwatch.wo_time     (drawer)
PATCH  /api/time-logs/{log_id}               -> shopwatch.edit_log
DELETE /api/time-logs/{log_id}               -> shopwatch.delete_log
GET    /api/shopwatch/report?from=&to=       -> shopwatch.tech_report (dashboard)
GET    /api/shopwatch/me                      -> log corriente del usuario (para el reloj en vivo)
```

**RBAC (reutiliza `core/permissions.py`).** Fichar cae bajo `maint.edit`, que ya tienen `mechanic`, `dispatcher`, `safety` y `admin` — el mecánico ficha su propio tiempo con lo que ya posee. Editar/borrar el log de OTRO técnico y ver el reporte de productividad del taller es de gestión: se agrega un scope nuevo **`shopwatch.manage`** a `SCOPES`, asignado a `admin` y `dispatcher` (no a `mechanic`, para que un técnico no edite ni vea el rendimiento de sus compañeros). Un `mechanic` sí ve su propio corte vía `/shopwatch/me`. La lectura del `wo_time` en el drawer no exige scope (GET, cualquier autenticado), consistente con la regla "GET nunca exige scope".

Validaciones y bordes: no fichar contra WO `invoiced`; auto-stop del reloj previo; `minutes` acotado a un máximo razonable (p.ej. 24 h) para atrapar el log olvidado; `wo_time` tolera cero labor facturable (eficiencia `null`, no división por cero); todo org-scoped por los listeners de `db.py` (no hace falta filtrar a mano).

## 5. UI (React; dónde encaja; estados vacío/carga/error)

Encaja en dos lugares del front (`frontend/src/`):

**A. Drawer de la WO (`views/WorkOrdersPage.tsx`).** Nueva sección "Time / ShopWatch" bajo las líneas, junto al labor:

- Un botón grande **Start** / **Stop** con cronómetro en vivo (`now - started_at`, tick de 1 s en el cliente; la verdad la tiene el server vía `/shopwatch/me`). Cuando corre, muestra "Fichado hace 00:42 · <técnico>".
- Tabla de logs de la WO: técnico, inicio, fin, duración, nota; con editar/borrar para quien tenga `shopwatch.manage`.
- Fila resumen: **Real X.X h · Facturable Y.Y h · Eficiencia Z%**, con Z coloreado (verde >100, ámbar 85-100, rojo <85). Botón "Add time" para alta manual (modal simple: técnico, minutos, nota).

**B. Dashboard de productividad (nuevo tab, `views/ShopwatchPage.tsx`), gated a `shopwatch.manage`.** Selector de período (semana/mes) y tabla por técnico: horas fichadas, horas facturables, **wrench-time %**, **eficiencia %**, nº de WOs tocadas. Barras comparativas y un badge de "training opportunity" cuando la eficiencia media cae bajo umbral (el enganche de SquareRigger). Sparkline por técnico opcional en v2.

Estados (obligatorios, mismo criterio que el resto de la app):

- **Vacío (drawer):** "Sin tiempo fichado en esta orden. Tocá Start para empezar el reloj, o Add time para cargarlo a mano." con el botón Start visible.
- **Vacío (dashboard):** "Todavía no hay tiempo fichado. Cuando los técnicos empiecen a usar Start/Stop en las órdenes, acá vas a ver su productividad." con enlace a Work Orders.
- **Carga:** skeleton en la tabla de logs y en la fila resumen; el cronómetro no bloquea el resto del drawer.
- **Error:** si `clock-in`/`clock-out` falla, toast con el detalle del backend (p.ej. "cannot clock time on an invoiced work order") y el botón vuelve a su estado previo sin dejar un reloj fantasma en el cliente; el estado real se re-lee de `/shopwatch/me`.
- **Conflicto (reloj ya abierto en otra WO):** al hacer Start, aviso no bloqueante "Se cerró tu reloj en #<n> (<unit>) y se abrió acá" reflejando el auto-stop del server.

## 6. Automatizaciones (cap 04)

El motor de automatizaciones (cap 04) consume eventos de ShopWatch como triggers y expone sus métricas como condiciones:

- **Eventos que emite:** `time_log.started`, `time_log.stopped`, `time_log.manual_added`.
- **Trigger "reloj olvidado".** `time_log.started` sin `stopped` tras N horas (default 10) o cruzando fin de jornada → notifica al técnico y al dispatcher para cerrar/corregir el log. Evita los logs nocturnos que inflan las horas.
- **Trigger "WO sin tiempo".** Al pasar una WO a `completed` sin ningún `TimeLog` asociado → aviso "esta orden se completó sin tiempo fichado; ¿cargar labor real?". Sube la cobertura de datos (el wrench-time solo sirve si se ficha).
- **Trigger "eficiencia baja".** Al cerrar la WO, si `efficiency_pct < umbral` (p.ej. 70%) para un técnico de forma repetida en un tipo de job → tarea/alerta de "training opportunity" al dispatcher, materializando el claim de SquareRigger.
- **Trigger "wrench-time semanal".** Corte programado (fin de semana) que compone el resumen por técnico y lo manda por el canal de notificaciones (email/Teams/Telegram, según `notify`).
- **Condición reutilizable:** métricas del técnico (`wrench_pct`, `efficiency_pct`) disponibles para el ruteo de asignación — base del "asignar jobs por eficiencia" de Fullbay cuando el motor decida a qué mecánico sugerir un job nuevo.

## 7. Integraciones que toca

- **Work Orders / líneas de labor:** dependencia central. El tiempo facturable se lee de `WorkOrderLine(kind="labor")`; no se duplica.
- **Users / RBAC (`core/permissions.py`):** técnico = `User`; scope nuevo `shopwatch.manage`. Auth cookie + scopes ya existentes.
- **PM / campañas:** una WO de PM fichada alimenta el estándar propio por tipo de servicio (v2 del labor guide); no cambia el hook de PM actual.
- **Invoicing (`wo_invoice`):** ShopWatch NO altera el total facturado (el tiempo real es interno). Sí habilita, a futuro, un flujo "traer horas reales a la línea de labor" con un clic, opt-in.
- **Notify (`core/notify*`, Teams/Telegram/email):** canal de salida de los resúmenes y alertas del cap 04.
- **Multi-tenant (`db.py` listeners):** `TimeLog` es `OrgScoped`; el aislamiento es automático.
- **Reportes/Excel (`core/reports`, `excel`):** el `tech_report` se puede exportar con el pipeline existente.

## 8. Esfuerzo (S/M/L) · prioridad · dependencias

- **Esfuerzo: M.** Backend acotado (un modelo, un core con reglas claras, ~8 endpoints que espejan `/workorders/lines`); la migración Alembic con índice parcial es el único punto fino. El grueso del trabajo es UI: el cronómetro en vivo del drawer y el dashboard de productividad con sus estados.
  - Fase 1 (S–M): modelo + migración + clock-in/out + manual + `wo_time` + sección del drawer con Start/Stop y fila de eficiencia. Entrega valor solo.
  - Fase 2 (M): dashboard `shopwatch.manage`, wrench-time con jornada configurable, badges de training.
  - Fase 3 (opcional): labor guide propio desde el histórico de `TimeLog` por tipo de job; markup de labor por cliente estilo RTA.
- **Prioridad: naranja.** Diferenciador de gestión de taller; no bloquea compliance. Va después de que Work Orders/labor esté estable (ya lo está).
- **Dependencias:** Work Orders con líneas de labor (listo); Users con rol `mechanic` (listo); motor de automatizaciones del cap 04 (para los triggers; el fichaje y las métricas funcionan sin él); Alembic operativo en Postgres para la revisión de `time_log`. Sin dependencia de datos de labor de terceros (MOTOR): el estándar arranca con las horas facturables y evoluciona al histórico propio.

## 9. Ejemplo end-to-end con datos realistas

Taller de MCC. Work order **#118**, unidad **T-4471** (tractor Freightliner), título "PM A + reemplazo de clutch", campaña `pm`. El estimate lleva dos líneas de labor: PM A (2.0 h a $95/h) y clutch (6.0 h a $95/h) → **8.0 h facturables** de labor.

1. **Lunes 07:58.** El técnico **Marco Díaz** (`User`, rol `mechanic`) abre el drawer de #118 y toca **Start**. `POST /api/workorders/118/clock-in` → `TimeLog(wo_id=118, user_id=Marco, started_at=07:58, status="running")`. El drawer muestra "Fichado hace 00:00 · Marco Díaz" y el cronómetro corre.
2. **10:31.** Marco toca **Stop** (se va a atender un breakdown). `clock_out` → `ended_at=10:31`, `minutes=153`, `status="stopped"`. Log 1: **2.55 h** reales.
3. **13:05 → 17:40.** Marco vuelve, toca Start y al final Stop. Log 2: **4.58 h** reales. Total real de #118 = 2.55 + 4.58 = **7.13 h**.
4. **Drawer, fila resumen.** `GET /api/workorders/118/time` → `logged_min=428` (7.13 h), `billable_hours=8.0`, `efficiency_pct = 8.0 / 7.13 × 100 ≈ **112%**`. Se muestra en verde: Marco terminó el job más rápido que las horas vendidas.
5. **Facturación.** El dispatcher pasa #118 a `invoiced` (scope `wo.invoice`). El total facturado se calcula de las líneas como siempre (8.0 h × $95 + partes); ShopWatch **no** lo tocó. Ya no se puede fichar más contra #118.
6. **Dashboard semanal (`shopwatch.manage`).** Con `?from=lunes&to=domingo`, el corte de Marco: **fichadas 34.5 h**, **facturables 41.0 h**, **eficiencia 119%**, **wrench-time 86%** (34.5 h sobre 40 h de jornada de la semana). Otro técnico, **Luis Peña**, sale con **eficiencia 78%** y wrench-time 61%: el motor del cap 04 dispara un badge de "training opportunity" en el job de clutch, donde Luis viene 40% sobre el estándar de forma repetida. El jefe decide emparejarlo con Marco en el próximo clutch. Nadie transcribió una sola hora a mano.
