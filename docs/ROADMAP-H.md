# REWORK H — profundidad de producto (8 fases)

Objetivo: pulir y enriquecer la app como producto. Dashboards
visualmente llamativos, cinemáticos, interactivos y personalizables.
Mapeo con el brief del usuario: su Fase 4 se divide en H4+H5; el
rediseño transversal que pidió ("más cinemático e interactivo") es H7.

## H1 — DOT Inspections + dashboards gemelos PM/DOT  ← EN CURSO

Nueva sección **DOT Inspections** (inspección anual DOT por unidad) y
rediseño del PM Tracker para que ambos usen EL MISMO dashboard nuevo
(diseñado desde cero, sin heredar el PM viejo):

- Tabla editable por unidad: driver, unit, model/engine, current meter,
  last date, last miles, next due, miles/days to due, status, notes.
- Status auto: ON TRACK / UPCOMING / OVERDUE / NEVER PERFORMED +
  estados manuales OUT OF SERVICE / IN SHOP (override por unidad).
- Resumen tipo spreadsheet del usuario: tarjetas por status con conteo
  y %, clic = filtro; donut.
- Botones **Add PM** / **Add DOT** → modal con animación sutil:
  UNIT#, Date, Mileage (+ botón que trae el odómetro actual de
  Samsara), Notes.
- Al editar fecha/millaje: la celda del unit se rellena de verde en
  cascada con el mensaje "PM updated" / "DOT updated" en la tipografía
  de la app.
- Backend: tabla `maint_record` (kind pm|dot, unit, date, mileage,
  notes) como historial; DOT next due = +365 días; PM sigue
  last + 20,000 mi (umbral org). PM merge: CSV Fullbay + overrides +
  records nuevos.

## H2 — Work Orders 2.0 (pipeline UNIQ + reglas QuickManage + Telegram)

- Form de creación que pidió el jefe: unit, mileage, date, issue
  description (más asignación de mecánico).
- Pipeline **Open → Assigned → In Progress → Completed → Invoiced**
  (+ Closed al pagar) como **barra secuencial interactiva** en el
  perfil de la orden (estilo UNIQ TMS: arrastrar/clic a la siguiente
  etapa o varias de un saque, completando los datos faltantes que la
  etapa exija).
- Reglas de avance estilo QuickManage: Assigned requiere mecánico,
  Invoiced requiere total > 0, Closed requiere pago manual.
- **Notificaciones Telegram**: bot + group chat por taller/terminal;
  al pasar a Assigned/Dispatched se notifica automáticamente al
  mecánico/driver. (Bot token en telegram.local.json, opt-in,
  dry-run por default igual que SMS.)

## H3 — Fullbay-killer (partes, labor, invoice)

Investigar a fondo qué hace Fullbay que aún no hacemos (parts ordering
con shops/vendors, labor rates e invoicing de horas, estimates →
authorization → invoice) y construir lo que bloquee la superación:
catálogo de partes + vendors, costos de labor por tarifa, flujo
estimate→invoice imprimible. Lo que dependa de su red de proveedores
(Marketplace) se reemplaza con búsqueda de POIs/dealers propios (G2) +
órdenes por email/Telegram.

## H4 — RBAC real (roles, permisos y billing)

Profundizar Settings → Users & Roles: matriz de permisos por rol
(admin, dispatch, safety, tech/mechanic, viewer) con scopes concretos
(quién ve PII, quién edita PM/DOT, quién enviará comandos remotos de
reefer cuando existan, quién factura). Roles visibles en billing
futuro (precio por asiento). Gating en backend (middleware por scope,
no solo admin/no-admin) y en UI (acciones ocultas/deshabilitadas).

## H5 — Reefer tracking real (piloto hardware)

Paso a paso concreto para trackear trailers refrigerados SIN APIs
mensuales de terceros: Queclink GV600MA o Teltonika FMC130 + sonda →
**Traccar self-host** → ingesta FastAPI → Cold Chain con datos reales
(reemplaza el modo demo). Definir: scope de datos alcanzable
(box temp, GPS, puerta, batería), ideal (setpoint/modo/alarmas vía
OEM APIs TK/Carrier) y mínimo estándar del dashboard (temp cada ≤5
min, alertas por umbral, historial 7d, export). Piloto: 1-2 trailers
de Journey.

## H6 — Base de datos real (PostgreSQL)

Migrar SQLite + JSON/CSV locales a **PostgreSQL** (el estándar en
ofertas laborales y ecosistema). Exterminar hardcodeo: terminales,
umbrales, contactos y PII a tablas; migraciones con Alembic; SQLite
queda como modo dev/fallback. Preparar multi-tenant (org_id en
tablas núcleo).

## H7 — Rediseño cinemático transversal

Con referencias nuevas (no las actuales): dashboards personalizables
(widgets reordenables, densidad, acento por org ya existente),
microinteracciones (hover states con profundidad, transiciones de
sección, números animados count-up, skeletons direccionales), y un
"modo TV" para pantalla de taller/dispatch. Herramientas a usar:
MCP de 21st.dev Magic (componentes), skill impeccable (flujo craft +
referencias), Mobbin/Dribbble para benchmarks visuales.

## H8 — Dominio, email y hosting

Evaluar y costear: dominio propio + email con dominio (Google
Workspace vs Zoho vs Fastmail), hosting de la app (VPS Hetzner/
DigitalOcean vs Fly.io/Railway; Postgres gestionado vs propio),
TLS, backups, y el camino de "app local" a SaaS multi-tenant.
Presupuesto objetivo: <$50/mes para empezar.

## Decisiones de diseño que rigen todo el rework

- PRODUCT.md manda: Confiable · Potente · Premium; nada de SaaS-cream
  genérico; WCAG AA; sin em-dashes ni emojis en UI.
- Todo editable donde el usuario hoy usa spreadsheet.
- Toda animación respeta `prefers-reduced-motion`.
- Nada de datos demo sin etiquetar; nunca evaluar alertas sobre demo.
