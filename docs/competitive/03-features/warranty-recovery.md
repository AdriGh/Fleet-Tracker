# Feature: Warranty & core recovery

## 1. Qué es y por qué importa

**Recuperación de garantías y de cores.** Dos flujos de plata que hoy se pierden en silencio porque nadie los rastrea al momento de la reparación:

1. **Garantías.** Cuando una reparación cae bajo una cobertura vigente (garantía de fábrica del motor, garantía extendida del powertrain, póliza de componente, garantía del taller externo, o garantía de la parte aftermarket), el taller **no debería comerse ese costo**: lo reclama al fabricante/vendor y le reembolsan la parte y a veces la labor. El problema real: nadie sabe, al abrir la work order, que el turbo que se está cambiando todavía tiene 8 meses de garantía de fábrica. Se factura como reparación normal, se paga de bolsillo, y la plata no vuelve nunca.

2. **Cores.** Muchas partes de camión HD (arrancadores, alternadores, compresores de aire, cajas de dirección, inyectores, turbos reman) se venden con un **depósito de core**: pagás de más y ese sobreprecio se te devuelve como **crédito** cuando devolvés la pieza vieja (el "core") al vendor. Si el core no se devuelve, o se devuelve y nadie registra el crédito que entra, el depósito se pierde. En una flota que hace cientos de reparaciones al año, son miles de dólares olvidados en un rincón del taller.

**Por qué es la prioridad #1.** Es el ROI de venta más fuerte de toda la categoría, y es literalmente demostrable en dólares. SquareRigger lo pone como su testimonial estrella ("*no teníamos idea de cuánta plata estábamos perdiendo… la recuperación de garantías sola pagó el software*"), con clientes recuperando **$1,000 a $2,000 por vehículo**. Samsara habla de **7× ROI** en ahorros de garantía. Para nuestro pitch de reemplazo de Fullbay (el jefe paga $577/mes), un solo turbo bajo garantía recuperado ($1,800) paga tres meses del producto. Es la feature que se vende sola en la demo: "cargá tus últimas 20 work orders y te muestro cuánto dejaste sobre la mesa".

**Nuestro estado.** Tenemos `WorkOrder` / `WorkOrderLine` / `Part` / `PartStockMovement` sólidos, con el hook de facturación ya consumiendo inventario. Pero **no existe ningún concepto de garantía ni de core**: una WoLine no sabe si está cubierta, y no hay entidad que modele la vigencia de una cobertura ni el ciclo de un claim. Esto se construye desde cero, pero encima de un pipeline de WO que ya sabe engancharse a hooks (ver `update_wo` en `core/workorders.py`).

## 2. Referencia competitiva

- **SquareRigger** (referencia principal, feature estrella): vincula garantías a **activos, partes y work orders**; **auto-marca las reparaciones cubiertas AL CREAR la work order** (no después, cuando ya es tarde); permite lanzar el claim en **1 clic**; **alertas de deadline** antes de que venza la cobertura; **multi-tipo**: fábrica / extendida / póliza / servicio / aftermarket. El testimonial de recuperar $1-2K por vehículo es de acá.
- **Samsara**: cuando se reporta un defecto en un componente, **auto-chequea la garantía** de ese componente y avisa; **trackea los reembolsos**; marketing de "7× ROI en warranty savings".
- **RTA**: garantía **+ core credits** trackeados con **códigos VMRS**; **auto-notifica** si un repair está cubierto; **recordatorios** antes de que venza la garantía.
- **Fullbay**: core tracking / core credits, específico de heavy-duty (arrancadores, alternadores, etc.). El loop parte-vendor con depósito y devolución.

**Lo que robamos y dónde ganamos.** Robamos el auto-matching-al-crear-la-WO (el gran diferenciador de SquareRigger: la plata se recupera porque el sistema avisa *antes* de facturar) y el claim en 1 clic. Ganamos porque nuestro **matching automático** se alimenta del catálogo `Part` real y del historial de WOs por unidad que ya tenemos, y porque el **motor de automatizaciones (cap 04)** vuelve las alertas de deadline y el auto-marcado configurables por el cliente, no cableadas. VMRS lo dejamos como campo opcional (`vmrs_code`) para paridad con RTA/Fullbay sin bloquear la v1.

## 3. Modelo de datos (SQLAlchemy; REUSÁ lo existente; nota migración Alembic)

Se reusa `WorkOrder`, `WorkOrderLine`, `Part`, `Vendor` tal cual. Se agregan **dos entidades nuevas** (`Warranty`, `WarrantyClaim`) y **columnas nuevas en `WorkOrderLine`** para marcar cobertura y estado de core sin duplicar la línea. Todo `OrgScoped` (mixin existente), así el aislamiento multi-tenant y el auto-relleno de `org_id` funcionan sin tocar nada (ver los eventos `before_flush` / `do_orm_execute` en `db.py`).

```python
# --- Entidad nueva: cobertura de garantía ---
class Warranty(OrgScoped, Base):
    """Cobertura de garantía sobre un activo, un componente o una parte.

    scope define a QUÉ aplica:
      unit      -> toda la unidad (garantía de fábrica del vehículo)
      component -> un sistema/componente por VMRS o texto (p.ej. 'engine',
                   'transmission', 'turbo') sobre una unidad
      part      -> un part_number del catálogo (garantía del fabricante de
                   la parte / aftermarket), aplicable a cualquier unidad
    Vigencia por tiempo (expires_on) y/o por millaje (expires_miles);
    el matching honra ambos si están seteados."""
    __tablename__ = "warranty"

    id: Mapped[int] = mapped_column(primary_key=True)
    scope: Mapped[str] = mapped_column(String(12), index=True)  # unit|component|part
    unit: Mapped[str] = mapped_column(String(64), default="", index=True)
    component: Mapped[str] = mapped_column(String(60), default="")  # texto libre
    part_number: Mapped[str] = mapped_column(String(60), default="", index=True)
    vmrs_code: Mapped[str] = mapped_column(String(20), default="")  # opcional (paridad RTA)
    # Tipo de cobertura (multi-tipo, estilo SquareRigger).
    kind: Mapped[str] = mapped_column(String(16), default="factory")
    #   factory | extended | policy | service | aftermarket
    provider: Mapped[str] = mapped_column(String(120), default="")  # fabricante/vendor que paga
    vendor_id: Mapped[int | None] = mapped_column(
        ForeignKey("vendor.id"), nullable=True)
    policy_number: Mapped[str] = mapped_column(String(80), default="")
    covers_parts: Mapped[bool] = mapped_column(Boolean, default=True)
    covers_labor: Mapped[bool] = mapped_column(Boolean, default=False)
    starts_on: Mapped[str] = mapped_column(String(10), default="")   # YYYY-MM-DD
    expires_on: Mapped[str | None] = mapped_column(String(10), nullable=True)
    start_miles: Mapped[int | None] = mapped_column(Integer, nullable=True)
    expires_miles: Mapped[int | None] = mapped_column(Integer, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    notes: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime)


# --- Entidad nueva: claim de garantía sobre una línea de WO ---
class WarrantyClaim(OrgScoped, Base):
    """Un claim de garantía sobre UNA línea de work order cubierta.

    Ciclo de estado (status):
      eligible  -> el matching detectó cobertura, aún no se reclamó
      submitted -> enviado al provider/vendor (con submitted_at)
      approved  -> aprobado (a la espera del reembolso)
      denied    -> rechazado (con reason)
      reimbursed-> plata recuperada (amount_recovered, reimbursed_at) [terminal]
    amount_claimed = costo de la línea cubierta; amount_recovered = lo que
    efectivamente reembolsaron (puede diferir: solo partes, no labor, etc.)."""
    __tablename__ = "warranty_claim"

    id: Mapped[int] = mapped_column(primary_key=True)
    warranty_id: Mapped[int] = mapped_column(ForeignKey("warranty.id"), index=True)
    wo_id: Mapped[int] = mapped_column(ForeignKey("work_order.id"), index=True)
    line_id: Mapped[int] = mapped_column(ForeignKey("work_order_line.id"))
    unit: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(12), default="eligible", index=True)
    amount_claimed: Mapped[float] = mapped_column(Float, default=0.0)
    amount_recovered: Mapped[float] = mapped_column(Float, default=0.0)
    claim_number: Mapped[str] = mapped_column(String(80), default="")  # nº del provider
    reason: Mapped[str] = mapped_column(String(200), default="")       # motivo de rechazo
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reimbursed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime)
```

**Columnas nuevas en `WorkOrderLine`** (para marcar cobertura y core en la propia línea, sin tabla extra para cores en la v1):

```python
    # Warranty & core recovery: banderas sobre la línea de parte/labor.
    warranty_status: Mapped[str] = mapped_column(String(12), default="")
    #   ''(ninguna) | flagged (matcheó, sin claim) | claimed | recovered
    # Core tracking: depósito de core de la parte (0 = sin core).
    core_deposit: Mapped[float] = mapped_column(Float, default=0.0)
    core_status: Mapped[str] = mapped_column(String(12), default="")
    #   ''(n/a) | owed (core sin devolver) | returned (devuelto) | credited (crédito recibido)
    core_credit: Mapped[float] = mapped_column(Float, default=0.0)  # crédito efectivo
```

**Campo nuevo en `Part`** (default de core para que el matching de cores sea automático):

```python
    core_deposit: Mapped[float] = mapped_column(Float, default=0.0)  # depósito estándar del core
```

**Migración Alembic.** Igual que el resto del stack: en Postgres (prod) esto es **una migración Alembic versionada** (`alembic revision --autogenerate -m "warranty & core recovery"` → revisar → `alembic upgrade head`), que crea `warranty` + `warranty_claim` y hace `ALTER TABLE work_order_line ADD COLUMN warranty_status/core_*` y `ALTER TABLE part ADD COLUMN core_deposit`. En SQLite (dev) las tablas nuevas las crea `create_all`, pero las **columnas nuevas sobre tablas existentes** hay que agregarlas en `_migrate()` de `db.py` (bloque de `ALTER TABLE work_order_line …` y `part …`, siguiendo el patrón ya presente para `part_number`/`reorder_point`). Recordá sumar `warranty` y `warranty_claim` a la lista de tablas del backfill de `org_id` en `_migrate()`.

## 4. Backend (core/*.py + endpoints; reglas)

Módulo nuevo **`core/warranty.py`**, espejando la forma de `core/workorders.py` (serializers `_warranty_dict` / `_claim_dict`, funciones CRUD, sesión por operación). Un helper de matching **`core/warranty_matching.py`** que sea puro y testeable (recibe datos, no toca sesión).

**Reglas de matching (el corazón de la feature).** `match_line(unit, part_number, component, line_kind, wo_mileage, when) -> Warranty | None`:

1. Buscar `Warranty` activas del tenant que apliquen, por precedencia: `part` (match exacto de `part_number`) > `component` (match de `component`/`vmrs_code` sobre esa `unit`) > `unit` (garantía de vehículo).
2. **Vigencia por tiempo**: `starts_on <= when <= expires_on` (si `expires_on` está seteado).
3. **Vigencia por millaje**: `wo_mileage <= expires_miles` (si `expires_miles` está seteado). El `wo_mileage` sale de `WorkOrder.mileage` (ya existe).
4. **Cobertura por tipo de línea**: si la línea es `kind="labor"`, solo matchea si `covers_labor=True`; si es `kind="part"`, requiere `covers_parts=True`.
5. Devuelve la primera que cumpla todo, o `None`.

**Auto-marcado al crear/editar la WoLine (diferenciador SquareRigger).** Se engancha en `core/workorders.add_line()` y en el path de edición: después de agregar una línea, correr `warranty.flag_line(wo, line)`. Si `match_line` devuelve cobertura, setear `line.warranty_status = "flagged"` y **crear un `WarrantyClaim` en estado `eligible`** (con `amount_claimed = qty*unit_cost`). Esto es lo que hace que el usuario vea el badge "🛡 Under warranty" en el drawer del WO *en el momento*, no después de pagar. El match también corre **al crear la WO por escaneo de factura** (AI invoice scan / Groq): cada línea extraída pasa por `flag_line`, así una factura del taller externo con un turbo cubierto se marca sola.

**Core tracking.** En `add_line()`, si la parte del catálogo tiene `Part.core_deposit > 0`, se copia a `line.core_deposit` y `line.core_status = "owed"`. Funciones `mark_core_returned(line_id)` (`owed -> returned`) y `credit_core(line_id, amount)` (`returned -> credited`, setea `core_credit`). El crédito de core **no** pasa por inventario (no es stock), pero sí alimenta el warranty savings report.

**Ciclo del claim** (`core/warranty.py`): `submit_claim(claim_id, claim_number)` (`eligible -> submitted`, sella `submitted_at`, línea `-> claimed`); `resolve_claim(claim_id, approved: bool, reason)` (`submitted -> approved|denied`); `reimburse_claim(claim_id, amount_recovered)` (`approved -> reimbursed`, sella `reimbursed_at`, línea `-> recovered`). Estados con guard de transición (rechazar saltos ilegales con `ValueError` legible, mismo patrón que `gate_error` en workorders).

**Endpoints** (en `api/routes.py`, prefijo `/api`, siguiendo el estilo de `/workorders`):

| Método | Ruta | Scope | Acción |
|---|---|---|---|
| GET | `/warranties` | — (lectura) | Listar coberturas (filtros `unit`, `part_number`, `active`) |
| POST | `/warranties` | `maint.edit` | Crear cobertura |
| PATCH | `/warranties/{id}` | `maint.edit` | Editar / desactivar |
| DELETE | `/warranties/{id}` | `maint.edit` | Borrar |
| GET | `/warranty-claims` | — | Listar claims (filtros `status`, `unit`, `wo_id`) |
| POST | `/warranty-claims/{id}/submit` | `wo.invoice` | Enviar claim |
| POST | `/warranty-claims/{id}/resolve` | `wo.invoice` | Aprobar/rechazar |
| POST | `/warranty-claims/{id}/reimburse` | `wo.invoice` | Registrar reembolso |
| GET | `/workorders/{id}/warranty-check` | — | Correr matching bajo demanda sobre una WO (para el botón "re-check") |
| POST | `/workorder-lines/{id}/core/return` | `maint.edit` | Marcar core devuelto |
| POST | `/workorder-lines/{id}/core/credit` | `maint.edit` | Registrar crédito de core |
| GET | `/reports/warranty-savings` | — | Warranty savings report |

**Scopes** (reusan la matriz de `core/permissions.py`): crear/editar coberturas y cores es `maint.edit` (mechanic + dispatcher + safety lo tienen); mandar/resolver/reembolsar claims es `wo.invoice` (dispatcher, no mechanic ni safety), porque toca plata que entra, alineado con quién factura. `viewer` solo lee.

**Warranty savings report** (`core/reports.py`, junto al de spend que ya existe): agrega `WarrantyClaim` + core credits del período. Devuelve:
- `recovered`: suma de `amount_recovered` de claims `reimbursed` + suma de `core_credit` de líneas `credited`.
- `pending`: `amount_claimed` de claims `eligible|submitted|approved` (plata en vuelo).
- `at_risk`: líneas `flagged` sin claim + cores `owed` (plata que se está por perder si nadie actúa).
- `denied`: suma de claims `denied` (para auditar por qué se rechazan).
- Desglose por unidad y por tipo de cobertura, más "recuperado por vehículo" (el número del pitch).

## 5. UI (React; dónde encaja; estados vacío/carga/error)

Front en React + Vite + CSS vanilla + TS. Tres puntos de contacto, más una página nueva.

**a) Drawer de la Work Order** (`views/WorkOrdersPage.tsx`, el drawer de detalle que ya muestra líneas). Cada línea de parte/labor cubierta muestra un **badge "🛡 Under warranty"** (`warranty_status = flagged/claimed/recovered` con color por estado: ámbar flagged, azul claimed, verde recovered). Al lado del badge, botón **"File claim"** (1 clic → `POST /warranty-claims/{id}/submit`, pidiendo nº de claim en un prompt inline). Las líneas con core muestran un chip **"Core $X — owed/returned/credited"** con acción para avanzarlo. Arriba del drawer, si hay líneas flagged sin claim, un banner: *"3 líneas bajo garantía · $1,240 recuperables"* con botón "File all".

**b) Pestaña Warranties en el Unit Profile** (`views/UnitProfilePage.tsx`, que ya tiene pestañas Attachments/Components). Lista las coberturas de esa unidad (fábrica, extendida, componentes) con su vigencia y un semáforo de vencimiento (verde / ámbar a <60 días o <10% del millaje / rojo vencida). Botón "Add warranty".

**c) Página nueva "Warranty" en la nav** (`views/WarrantyPage.tsx`, nueva entrada de menú entre Parts y Reports). Tres tabs: **Coverages** (todas las garantías del tenant, buscables), **Claims** (tablero por estado eligible→submitted→approved→reimbursed, estilo el pipeline de WOs, con acciones de avance), **Savings** (el report: número grande "Recuperado este año: $18,400 · $1,533/vehículo", con desglose y la lista "at risk" accionable).

**API client** (`frontend/src/api.ts`): agregar `listWarranties()`, `createWarranty()`, `listClaims()`, `submitClaim()`, `resolveClaim()`, `reimburseClaim()`, `warrantyCheck(woId)`, `coreReturn()`, `coreCredit()`, `warrantySavings(period)`, siguiendo el patrón `export async function` con `fetch` + credenciales de cookie que ya usan todas las demás.

**Estados:**
- **Vacío (coverages)**: "Todavía no cargaste garantías. Cargá la garantía de fábrica de una unidad o el core estándar de una parte para empezar a recuperar plata." + CTA "Add warranty" + link "Import from a work order" (matchear WOs pasadas).
- **Vacío (savings)**: "Aún no hay recuperaciones registradas. En cuanto marques una línea bajo garantía y registres el reembolso, vas a ver acá cuánto recuperaste."
- **Carga**: skeleton de filas en las tablas; el badge del drawer muestra un spinner chico mientras corre `warranty-check`.
- **Error**: toast con el mensaje del backend (los `ValueError` de transición salen legibles, p.ej. "no se puede reembolsar un claim que no fue aprobado"); la tabla mantiene el último estado bueno y ofrece "Reintentar".

## 6. Automatizaciones (cap 04)

El motor del cap 04 (**trigger → condición → acción**) es lo que vuelve esto "mantenimiento que se maneja solo". Triggers y acciones nuevos que esta feature aporta:

**Triggers nuevos:**
- `wo_line.added` — se agregó una línea a una WO (dispara el matching de garantía).
- `warranty.expiring` — una cobertura entra en ventana de vencimiento (tiempo o millaje).
- `core.owed_aging` — un core lleva N días en `owed` sin devolverse.
- `claim.status_changed` — un claim cambió de estado.

**Acciones nuevas:**
- `warranty.flag_line` — correr el matching y marcar la línea (ver §4).
- `warranty.open_claim` — crear el `WarrantyClaim` en `eligible`.
- `notify` (acción existente del cap 04) — mandar el aviso por el canal configurado.

**Automatizaciones que vienen de fábrica (defaults del tenant):**
1. **Auto-marcado de cobertura**: `wo_line.added` → (sin condición) → `warranty.flag_line` + `warranty.open_claim`. Esto es el comportamiento estrella de SquareRigger, pero expresado como regla editable: un cliente que no quiera el auto-claim la desactiva y solo deja el flag.
2. **Alerta de deadline de garantía**: `warranty.expiring` → `condición: quedan <60 días o <5,000 millas` → `notify` al safety/dispatcher ("La garantía del motor de la unidad 4471 vence el 2026-08-15"). Espeja los recordatorios de RTA/SquareRigger.
3. **Core sin devolver**: `core.owed_aging` → `condición: >14 días owed` → `notify` ("Core del arrancador de la WO #312 lleva 3 semanas sin devolver — $180 en riesgo").
4. **Claim aprobado, falta cobrar**: `claim.status_changed` → `condición: status = approved` → `notify` al dispatcher para que persiga el reembolso.

Las condiciones (umbrales de días/millas) son parámetros de la regla, no constantes, así cada tenant los calibra. La acción `notify` reusa el `notify_service` existente (email/SMS/Teams/Telegram ya cableados en `core/`).

## 7. Integraciones que toca

- **AI invoice scan (Groq / `core/docscan.py` + `wo_invoice.py`)**: cada línea que el scan extrae de una factura del taller externo pasa por `warranty.flag_line`. Es un multiplicador enorme: el flujo de "escaneo la factura de Love's y el sistema me avisa que el turbo estaba bajo garantía" es exactamente el momento-wow.
- **Inventario de partes (`core/inventory.py` + `Part`)**: el core deposit se siembra desde `Part.core_deposit`. El crédito de core **no** genera `PartStockMovement` (no es stock), pero la parte devuelta sí puede disparar un ajuste manual si el taller la reacondiciona. La garantía scope `part` se ancla al `part_number` del catálogo.
- **Work Orders (`core/workorders.py`)**: hooks en `add_line` y en el path de facturación de `update_wo`. El matching lee `WorkOrder.mileage` y `WorkOrder.unit`.
- **Purchasing / POs (`PurchaseOrder` / `POLine`)**: a futuro, cuando se recibe una parte reman con core en una PO, el depósito se puede registrar desde ahí. Fuera de alcance de la v1 (la v1 lo toma de `Part.core_deposit`).
- **Vendors (`Vendor`)**: `Warranty.vendor_id` y `WarrantyClaim` se cruzan con el vendor que paga, para el desglose del report y para saber a quién se le reclama.
- **Reportería (`core/reports.py`)**: el savings report vive junto al de spend, y comparte el filtro por período.
- **Motor de automatizaciones (cap 04)**: triggers/acciones de §6.
- **Multi-tenant**: nada especial — `OrgScoped` en las dos entidades nuevas hace que el aislamiento y el relleno de `org_id` funcionen por los eventos de `db.py`.

## 8. Esfuerzo (S/M/L) · prioridad · dependencias

**Esfuerzo: L** (es la feature más grande del roadmap primario). Desglose:
- Modelo + migración (2 tablas nuevas + columnas + Alembic + `_migrate` SQLite): **S**.
- `core/warranty.py` + `core/warranty_matching.py` + hooks en workorders + ciclo de claim: **M**.
- Endpoints + scopes + serializers: **S**.
- UI (drawer badges + Unit Profile tab + página Warranty con 3 tabs + api.ts): **M-L**.
- Savings report + integración con AI scan: **S-M**.
- Automatizaciones del cap 04 (si el motor ya existe, son reglas; si no, dependen de él): **S** sobre motor existente.

**Prioridad: 🔴 #1.** Es el ROI de venta más fuerte de la categoría y el gancho de la demo. Se puede entregar en **fases** para acortar el time-to-value:
- **Fase 1 (MVP demoable)**: `Warranty` + matching + auto-flag en `add_line` + badge en el drawer + claim manual (submit/reimburse) + savings report básico. Ya permite el pitch "cargá tus WOs y mirá cuánto recuperás".
- **Fase 2**: core tracking + página Warranty completa + automatizaciones de deadline/aging.
- **Fase 3**: VMRS, matching sobre WOs históricas en bulk, PO-driven core deposits.

**Dependencias:**
- **Dura**: `WorkOrder`/`WorkOrderLine`/`Part`/`Vendor` (ya existen ✓). Alembic vivo en prod (pendiente en el backlog general — mientras tanto `create_all` + `_migrate` cubre dev y un Postgres fresco).
- **Blanda**: motor de automatizaciones del cap 04 para §6 (Fase 2). Sin él, las alertas de deadline se pueden cablear temporalmente en el loop de alertas existente (`core/alerts.py`), como fallback.
- **Datos**: el valor depende de que el cliente **cargue las coberturas**. Mitigación: importador que corra el matching sobre WOs pasadas y proponga garantías a partir de las partes reman detectadas.

## 9. Ejemplo end-to-end con datos realistas

**Escenario.** Flota mixta, unidad **4471** (Freightliner Cascadia 2023, motor Detroit DD15). El 2023-03-10 se compró con garantía de fábrica del powertrain: **5 años / 750,000 millas**, provider Detroit Diesel. Se cargó en el sistema:

```
Warranty #12
  scope=component  unit=4471  component="engine"  kind=factory
  provider="Detroit Diesel"  covers_parts=True  covers_labor=True
  starts_on=2023-03-10  expires_on=2028-03-10  start_miles=0  expires_miles=750000
  active=True
```

**1. Reparación.** El 2026-07-01, la unidad 4471 (odómetro **412,300 mi**) entra por baja presión de turbo. El mecánico abre la **WO #312** (`mileage=412300`) y agrega líneas:

```
WoLine A  kind=part   description="DD15 turbocharger (reman)"
          part_number="A4720901080"  qty=1  unit_cost=1780.00
WoLine B  kind=labor  description="Turbo R&R — 6.5 hrs @ $135"
          qty=6.5  unit_cost=135.00  (=877.50)
```

La parte `A4720901080` en el catálogo `Part` tiene `core_deposit=350.00`.

**2. Auto-matching (al agregar, no al facturar).** `add_line` dispara `warranty.flag_line` para cada línea:
- **WoLine A** (part, componente turbo → engine): `match_line` encuentra **Warranty #12**. Vigencia: 2026-07-01 está entre 2023-03-10 y 2028-03-10 ✓; 412,300 ≤ 750,000 ✓; `covers_parts=True` ✓. → `warranty_status="flagged"`, se crea **WarrantyClaim #45** (`status=eligible`, `amount_claimed=1780.00`). Además `Part.core_deposit=350 > 0` → `core_deposit=350.00`, `core_status="owed"`.
- **WoLine B** (labor): matchea la misma Warranty #12 (`covers_labor=True`) → `flagged`, **WarrantyClaim #46** (`amount_claimed=877.50`).

En el drawer de la WO #312, arriba, aparece el banner: **"🛡 2 líneas bajo garantía · $2,657.50 recuperables · Core $350 pendiente"**.

**3. Claim en 1 clic.** El dispatcher aprieta **"File all"**. `submit_claim` para #45 y #46 con el nº de claim de Detroit (`DD-2026-88141`): ambos pasan a `submitted`, `submitted_at=2026-07-01`, líneas `-> claimed`.

**4. Core devuelto.** El taller manda el turbo viejo al vendor. Alguien aprieta "Mark core returned" en WoLine A → `core_status="returned"`.

**5. Resolución y reembolso.** El 2026-07-20 Detroit aprueba solo las partes (política: reman turbo cubierto, labor prorrateada al 50% por millaje):
- `resolve_claim(#45, approved=True)` → `approved`. `reimburse_claim(#45, 1780.00)` → `reimbursed`, línea A `-> recovered`.
- `resolve_claim(#46, approved=True)` → `approved`. `reimburse_claim(#46, 438.75)` → `reimbursed` (labor al 50%).
- El vendor acredita el core: "Register core credit" en WoLine A, `credit_core(line_A, 350.00)` → `core_status="credited"`, `core_credit=350.00`.

**6. Savings report** (`GET /reports/warranty-savings?period=2026`):

```json
{
  "period": "2026",
  "recovered": 2568.75,          // 1780.00 + 438.75 (claims) + 350.00 (core)
  "pending": 0.0,
  "at_risk": 0.0,
  "denied": 0.0,
  "by_unit": [{ "unit": "4471", "recovered": 2568.75 }],
  "by_kind": [{ "kind": "factory", "recovered": 2218.75 },
              { "kind": "core",    "recovered": 350.00 }],
  "recovered_per_vehicle": 2568.75
}
```

**Resultado del pitch.** Una sola reparación en una sola unidad recuperó **$2,568.75** que, sin la feature, se habrían facturado como costo del taller y nunca vuelto. A $577/mes de Fullbay, eso es **4.4 meses de software pagados por un turbo**. Multiplicado por una flota que hace cientos de reparaciones al año, es el "$1-2K por vehículo" de SquareRigger — y la línea del testimonial se escribe sola.
