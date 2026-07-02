# 04 — Arquitectura de la plataforma de integración

> Este capítulo es el **moat técnico**. Todo el capítulo 03 lo referencia (las
> automatizaciones, la ingesta de fuel-cards, el catálogo de partes, QuickBooks).
> Si esto se hace bien, *"telematics-agnóstico + automatizado"* deja de ser slogan y
> pasa a ser arquitectura.

## 4.1 Por qué es el moat
FleetTracker no compite con los ELD (Samsara/Motive): **se sirve** de ellos. La
identidad de producto es *software de mantenimiento que corre ENCIMA de cualquier
ELD/TMS/contable y automatiza el trabajo que hoy es manual*. Eso te separa de:
- los ELD-encroachers (su mantenimiento está atado a SU hardware),
- Fullbay/SquareRigger (integraciones cerradas, catálogo fijo).

El wedge (estilo Whip Around): *"funciona con TU Samsara/Motive/Geotab"* + *"hace la
profundidad de taller que el ELD no hace"* + *"y lo automatiza"*.

## 4.2 Estado actual (buena base, alcance limitado)
Ya tenés el **esqueleto correcto**: `backend/app/core/providers/__init__.py` define
`TelematicsProvider(ABC)` + `registry()`, con adapters vivos (Samsara, Motive) y stubs
(Geotab, Panda). Se autodescriben (`config_fields()`, `capabilities()`, `ping()`,
`save_creds()`). El hub de config (`core/integrations_admin.py`) prueba conexión y
guarda credenciales.

**Límite honesto:** eso es **UNA** categoría (telematics) + un `if/elif` a mano para el
resto (Twilio, Cloudinary, docscan, Places, reefer OEM, Gmail, GSheets, Fullbay-CSV).
No escala a "cualquier ELD/TMS/contable/partes + automatizaciones".

## 4.3 Las 4 capas + 2 habilitadores

### Capa 1 — Adapter framework multi-categoría
Generalizá `TelematicsProvider` a un `Integration` base con **subtipos por categoría**,
cada uno con su contrato de capacidades:
- `TelematicsAdapter` → fleet, odometer, engine-hours, DVIR, DTC/fault-codes, location, reefer
- `AccountingAdapter` → push invoice, push PO, sync chart-of-accounts (QuickBooks)
- `PartsAdapter` → search, price, availability, order (FindItParts/PartsTech)
- `FuelAdapter` → import de transacciones (WEX/Comdata)
- `TmsAdapter` → loads, dispatch (McLeod)

El `registry()` pasa a ser multi-categoría (un registry por categoría). Cada adapter
declara su `capabilities()` para que la UI muestre solo lo que soporta.

### Capa 2 — Modelo de dominio CANÓNICO ← la decisión clave
Hoy los adapters devuelven `dict` con forma-de-proveedor y la app consume forma-Samsara.
Para ser agnóstico de verdad, definí **esquemas canónicos internos** que CADA adapter
mapea hacia/desde:
`CanonicalAsset` · `OdometerReading` · `DvirDefect` · `FaultCode` · `Invoice` · `Part` ·
`PurchaseOrder` · `LedgerEntry` · `FuelTransaction`.

**Regla de oro:** la app NUNCA ve forma-Geotab ni forma-QuickBooks; ve canónico. Sumar
Geotab = escribir **UN mapper**, no tocar media app. Implementación sugerida: modelos
Pydantic como *boundary* + un mapper por adapter (`to_canonical()` / `from_canonical()`).
Sin esta capa, cada integración nueva es cirugía a corazón abierto.

### Capa 3 — Sync + eventos
Hoy es poll + cache (`samsara.clear_cache`). Para **escribir de vuelta** (POs a
FindItParts, facturas a QuickBooks) y **tiempo real** (webhooks entrantes) necesitás:
- **Ingesta:** poll programado por adapter (con su cadencia) + **webhooks entrantes**
  donde el proveedor pushea (Samsara, QuickBooks).
- **Egreso (write-back):** cola de trabajos con **reintentos + idempotencia** (ver cap 06:
  hoy falta el task queue — es el prerequisito).
- **Salud por integración:** `last_sync`, últimos errores, estado — visible en el hub de
  Connectivity (cap 05).

### Capa 4 — Motor de automatizaciones ← el diferenciador
Sobre el modelo canónico + los adapters: **trigger → condición → acción.**
- **Triggers:** `fault_code.received`, `part.low_stock`, `dvir.defect_created`,
  `pm.due`, `invoice.scanned`, `warranty.eligible`.
- **Condiciones:** filtros (severidad, unidad, monto, org).
- **Acciones:** `create_work_order`, `create_purchase_order` (→ PartsAdapter),
  `post_to_accounting` (→ QuickBooks), `notify`, `mark_out_of_service`.

Ejemplos (que aparecen en el cap 03): fault-code → WO · stock bajo → PO a FindItParts ·
factura escaneada → postear a QuickBooks · DVIR defect → WO. Fleetio vende esto como
*"hasta 40 automatizaciones"*; es lo que convierte "integraciones" en **"mantenimiento
que se maneja solo"**. Modelo: `AutomationRule(org_id, trigger, conditions_json, action,
action_params_json, enabled)` + un ejecutor que corre en el worker (cap 06).

### Habilitador A — Vault de credenciales por-org + OAuth
Hoy son `*.local.json` (una sola caja). Para multi-tenant + **QuickBooks (OAuth2 +
refresh de token por org)**: credenciales **cifradas en Postgres por org** (columna
encriptada / KMS) + un flujo OAuth callback/refresh. QuickBooks NO es "un adapter más":
es la primera integración OAuth y **fuerza** esta capa. (Es el G7 que ya tenías anotado.)

### Habilitador B — API pública + webhooks propios
Para la cola larga que no construís: **API keys por org**, endpoints REST versionados, y
**webhooks salientes** (con firma HMAC + reintentos) para eventos (`work_order.completed`,
etc.). Todos los líderes la tienen (Fleetio 50+ webhooks, RTA open API). Es lo que te deja
decir "ecosistema abierto" sin construir cada integración.

## 4.4 Categorías y prioridad de adapters
| Categoría | Framework | Primer adapter | Prioridad |
|---|---|---|---|
| Telematics/ELD | ✅ ya existe (generalizar) | Samsara ✅, Motive ✅ | agnóstico; nuevos **por demanda** |
| Accounting | nuevo (`AccountingAdapter`) | **QuickBooks** (OAuth) | 🔴 kill-shot vs Fullbay |
| Parts | nuevo (`PartsAdapter`) | FindItParts / PartsTech | 🟠 con el módulo Parts & Vendors |
| Fuel | nuevo (`FuelAdapter`) | WEX / Comdata | 🟠 con fuel management (cap 03) |
| TMS | nuevo (`TmsAdapter`) | McLeod | 🟡 por demanda |

**Filosofía (definida por el usuario): sin nombres particulares en el framework.** El
framework es agnóstico; los adapters se construyen por demanda. **QuickBooks es la única
excepción priorizada por nombre** (integración contable = pegajosa → retención + entierra
el moat de "QuickBooks sync" de Fullbay).

## 4.5 Reality check (sin endulzar)
*"Adaptar a CUALQUIER X"* no se cumple out-of-the-box; nadie lo hace. Cada integración es
trabajo real y **continuo** (auth, rarezas de API, rate limits, mapeo, mantenimiento). Lo
que se entrega —y hacen Samsara/Fleetio— es: **framework + modelo canónico + motor de
automatización + top-N adapters first-party + API pública** para el resto. Marketing dice
"ecosistema abierto, 15+ integraciones"; ingeniería entrega el framework + los ~10 que
importan.

## 4.6 Secuencia recomendada
1. **Modelo canónico + generalizar el adapter framework** (la base; sin esto todo lo demás
   es deuda técnica).
2. **Vault de credenciales** (por-org, cifrado, OAuth) → desbloquea QuickBooks.
3. **QuickBooks** (primer `AccountingAdapter` — el kill-shot).
4. **Motor de automatizaciones** (el diferenciador) — requiere el **task queue del cap 06**.
5. **API pública + webhooks + el marketplace** (UI en la app + página en el sitio, cap 05).

> **Dependencia dura:** el **task queue / worker (cap 06)** es prerequisito de las capas 3
> y 4. No se puede tener sync write-back ni automatizaciones confiables sin él.
