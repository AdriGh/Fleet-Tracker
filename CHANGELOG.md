# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es/1.1.0/)
y el proyecto usa [Versionado Semántico](https://semver.org/lang/es/).

## [No publicado]

## [1.28.1] - 2026-06-22

### Corregido
- **Build de Docker (deploy)**: `MarketplacePanel.resultToPart` construía un `Part`
  sin `reorder_point` (campo obligatorio desde v1.25/Inventory) → el `tsc -b` del
  build de producción fallaba. Agregado `reorder_point: 0`. Verificado con
  `npm run build` (tsc -b + vite build) limpio. (Nota: usar `npm run build`, no
  solo `tsc --noEmit`, para verificar — son más estrictos.)

## [1.28.0] - 2026-06-21

Escaneo de facturas ~30× más rápido — proveedor Groq vision.

### Añadido
- **docscan · proveedor Groq** (Llama 4 Scout,
  `meta-llama/llama-4-scout-17b-16e-instruct`): el escaneo de invoices pasa de
  **~98 s (Ollama local) a ~2-3 s** (≈30×), reusando la API de Groq.
  Configurable en Settings → Connectivity (`groq_api_key`, o env `GROQ_API_KEY`).
  Mejora también la **precisión**: en una factura real sacó el total correcto
  (~$1,019) donde el 7B local sobre-extraía (~$1,748). Reutiliza el render
  PDF→imagen; salida estructurada validada (sanitiza `null`→default). Los
  proveedores Ollama/Anthropic/Textract quedan intactos; `auto` sigue cayendo a
  Ollama offline por defecto.

## [1.27.0] - 2026-06-21

Review v1.26 — facturas multi-unidad, UX del drawer y Reports.

### Añadido
- **WO multi-unidad**: una factura que cubre varias unidades crea una orden
  **PADRE + N HIJAS** enlazadas (**#4 / #4.1**), cada una con SUS líneas (sin
  duplicar el costo → la suma = total del invoice). La misma factura se adjunta
  en **todas**. `parent_id`/`child_seq` (migrados vía `_migrate`). El drawer
  muestra el link padre/hija y navega entre las enlazadas.
- **Conciliación de total**: el escaneo extrae el **total impreso** del invoice;
  si la suma de líneas no cuadra, sale un **aviso** en el modal (no auto-escala).

### Corregido
- **Drawer del WO**: se puede **seleccionar texto** sin arrastrar el panel (vaul
  handle-only) + cierra con **Escape** / botón X.
- **Reports**: el botón **Refresh** ahora refresca de verdad (invalida + refetch);
  el gasto **incluye cualquier WO con líneas** (antes solo completed/invoiced, por
  eso los WO recién creados no aparecían).

### Cambiado
- **Reports**: el donut genérico → **breakdown segmentado a medida** (barra de
  asignación + grilla por categoría), sin espacios vacíos.

## [1.26.0] - 2026-06-19

Deploy — Docker + Postgres listos para Dokploy/VPS (rework · comercialización).

### Añadido
- **Dockerfile** multi-stage (build del frontend con Node → backend Python sirve
  `dist` + API con uvicorn), **`.dockerignore`**, **`docker-compose.yml`** (app +
  Postgres + volúmenes persistentes para uploads/jobs/db) y **`DEPLOY.md`** (guía
  paso a paso para Dokploy/VPS + caveats).

### Cambiado
- `db.py`: `create_all` ahora corre también en **Postgres** (idempotente) → un
  Postgres fresco obtiene el esquema completo desde los modelos actuales (las
  migraciones Alembic versionadas quedan como tarea futura). El path
  SQLite/`_migrate` del dev no cambia.
- `secretstore.py`: nuevo env `FLEET_SECRETS_DIR` para montar los `*.local.json`
  desde un volumen de solo-lectura en prod (default = `backend/` en dev).

### Nota
- En prod, **docscan** debe apuntar a Anthropic (o un Ollama externo) — el
  contenedor no trae Ollama. El **build/run** del contenedor se verifica en el
  VPS (Docker no está disponible en el entorno de dev).

## [1.25.0] - 2026-06-19

Inventory de partes — stock, reorder point y movimientos auditables (rework).

### Añadido
- **Inventory de partes**: `on_hand` + `reorder_point` por parte, con **log de
  movimientos** (`part_stock_movement`) auditable e **idempotente**. **Hooks**:
  PO → received **suma** stock; WO → invoiced **resta** las partes consumidas
  (guard por (reason, ref) → sin doble conteo al alternar estados). **Low-stock**
  (on_hand ≤ reorder_point) con pill "Low" en el catálogo + KPI/filtro y botón
  **QuickBuy** de reposición. **Ajuste manual** de stock con preview + historial
  de movimientos. Endpoints `POST /api/parts/adjust`, `GET /api/parts/low-stock`,
  `GET /api/parts/{pn}/movements`; el catálogo muestra On hand / Reorder. Columnas
  migradas vía `_migrate()` (ALTER TABLE en SQLite, no solo create_all).

## [1.24.0] - 2026-06-19

Paso 3 · C — rediseños aprobados aplicados a las pantallas reales (quirúrgico,
preservando lo ya aprobado).

### Cambiado
- **Cold Chain**: sub-línea "Active alarms" (critical/door/low-fuel desde datos
  reales) + grid de **sparklines 24h por unidad** (mismo endpoint de historial)
  que llena el espacio inferior. PRESERVADO: celdas verdes en rango, valores
  centrados, columna Fuel coloreada.
- **Dashboard**: banda inferior con **mini-tabla de Open Work Orders** (datos
  reales) con badge **"from reefer fault"** + **mini-strip de Cold Chain** (solo
  con reefer en vivo). PRESERVADOS todos los KPIs/charts.
- **Unit Profile**: banda overview con **Quick facts** (VIN/placa/marca-modelo/
  odómetro/last DVIR reales) + diagrama etiquetado con leyenda.
- **Work Order**: pulido de espacios; PRESERVADOS el thumbnail de factura, el
  input decimal y el auto-fill del escaneo.

### Nota
- Elementos ilustrativos de los mockups sin fuente de datos real (logs de
  excursiones, timelines inventados, deltas de KPI) se OMITIERON a propósito —
  cero datos falsos en la app. Logo intacto.

## [1.23.0] - 2026-06-19

Paso 3 · B — Smart Fill, QuickBuy/POs y scaffold de marketplace de partes.

### Añadido
- **Smart Fill (VIN → specs)**: en "Add unit", un botón **Smart Fill** autocompleta
  año/marca/modelo (+ body/engine) desde el VIN vía la API gratuita **vPIC de
  NHTSA** (sin key). Endpoint `GET /api/vin/{vin}`.
- **QuickBuy / Purchase Orders**: módulo de órdenes de compra — modelos
  `PurchaseOrder`/`POLine`, `core/purchasing.py`, `/api/purchase-orders` (CRUD +
  estado draft→ordered→received + líneas). Tab **Purchase Orders** dentro de
  Parts & Vendors + acción **QuickBuy** por parte en el catálogo. (write =
  maint.edit; read = auth)
- **Marketplace de partes (scaffold)**: búsqueda con adapter + proveedor MOCK
  (`core/parts_marketplace.py`, `GET /api/parts/marketplace/search`), panel con
  banner **"Demo data — conecta FindItParts/PartsTech en Settings"**.
  Integration-ready: pendiente la API key del proveedor para datos en vivo.

## [1.22.0] - 2026-06-19

Reports & Analytics — gasto de mantenimiento por categoría/unidad/mes (Paso 3 · A).

### Añadido
- **Reports & Analytics** (sección nueva, antes "coming soon"): tablero de
  **gasto de mantenimiento** agregado desde las líneas de los Work Orders —
  responde "¿cuánto gastamos en llantas/frenos/labor?". KPIs (total, parts vs
  labor, # WOs, promedio/WO), **gasto por categoría** (clasificador por
  part#/descripción: tires/brakes/engine/oil/electrical/suspension/labor/…),
  por **unidad**, **tendencia mensual**, y **top parts**; filtros de **rango de
  fechas** (mes/trimestre/YTD/custom) y **terminal**; export CSV. Backend
  `core/reports.py` + `GET /api/reports/spend` (solo cuenta WOs
  completed/invoiced; fecha efectiva service→closed→created).

## [1.21.0] - 2026-06-19

Review: la factura del WO se muestra como miniatura en una sección destacada.

### Cambiado
- **WO · Source invoice**: la factura adjunta ahora se muestra como **miniatura
  real** (render de la 1ª página del PDF / la imagen propia) dentro de una **card
  anidada más grande y destacada** (tinte de acento, miniatura con elevación al
  hover y easing custom). Clic en la miniatura abre el documento. El empty-state
  pasó a una drop-zone prominente. Endpoint nuevo
  `GET /api/workorders/{id}/invoice-file/thumb` (PNG, reusa el render de docscan).
  Aplicado /high-end-visual-design adaptado al dashboard denso (tokens reales, no
  estética de landing).

## [1.20.0] - 2026-06-19

Ronda 3 de la review: el escaneo de facturas ahora extrae las líneas.

### Corregido
- **WO · escaneo IA (Ollama local)**: el escáner ahora **extrae los renglones de
  partes/labor** del invoice. Causa raíz doble: (1) enviaba el PDF como texto
  plano en vez de imagen al modelo de visión, y (2) faltaba `num_ctx` (el
  contexto default de Ollama truncaba los tokens de la imagen → 0 líneas igual).
  Ahora rasteriza el PDF a PNG (pypdfium2/PyMuPDF, ~170 DPI, 1-2 páginas), lo
  envía como visión y sube `num_ctx` a 8192. Verificado en una factura real:
  0 → 4 líneas.

### Añadido
- **WO · modal de escaneo**: cuando el escaneo no detecta líneas, un aviso inline
  sugiere agregarlas a mano o configurar un proveedor más fuerte (Anthropic) en
  Settings.

### Nota
- El modelo local de 7B acierta montos/cantidades pero a veces confunde
  part/labor (corregible en el form antes de crear). Para precisión total,
  configurar el proveedor **Anthropic** en docscan.

## [1.19.0] - 2026-06-19

Ronda 2 de la review en video (sobre v1.18): Work Orders y PM/DOT.

### Añadido
- **WO · escaneo IA**: las líneas extraídas del documento ahora incluyen el
  **número de parte** (PART #/SKU) cuando está impreso — alimenta el reporte de
  gasto por parte/categoría.
- **WO · Source invoice**: al crear un WO desde un documento escaneado, el
  **archivo original se adjunta automáticamente** (la sección ya lo muestra, sin
  subida manual); se conserva el botón de subida para WOs no escaneados.

### Corregido
- **WO · Parts & Labor**: el campo de monto **ya admite decimales** — antes,
  teclear un punto reseteaba el valor a 0 (nuevo `DecimalInput`).
- **PM Tracker / DOT Inspections**: la celda **Current meter** es ahora
  editable/con resaltado en **toda la celda** (como "Last PM"), no solo sobre el
  número.

## [1.18.0] - 2026-06-19

Cambios de la review en video (sobre v1.17): Cold Chain, PM/DOT, board DVIR y Work Orders.

### Añadido
- **Work Orders**: adjuntar la **factura original del taller** a una orden — subir,
  **ver** (PDF inline) y **descargar** desde el drawer del WO (sección "Source
  invoice"). Almacenamiento por `wo_id` en `backend/uploads/wo_invoices/` (sin
  migración de DB); endpoints `POST/GET/DELETE /api/workorders/{id}/invoice-file`.
  El WO expone `has_invoice_file`/`invoice_file_name`.
- **Board DVIR**: botón para **borrar un reporte generado** de la lista "Recent
  DVIRs" (con confirmación). Endpoint `DELETE /api/dvir/blocks/{id}` con borrado en
  cascada de drivers/defectos.

### Cambiado
- **Cold Chain**: los valores de temperatura/combustible se **centran** (H+V) en su
  columna; la columna **Fuel** se colorea por nivel (verde/ámbar/rojo).
- **PM Tracker** y **DOT Inspections**: se eliminan las columnas **Driver** y
  **Notes**; el texto de la tabla se **centra** (H+V); se unifica el tamaño de los
  labels del panel de salud ("Most overdue"/"Next due" con "Fleet readiness").

### Corregido
- **Cold Chain**: las celdas de temperatura **en rango** ahora reciben su fondo
  **verde** (`.rt-ok`) — antes solo se coloreaban los valores fuera de rango.

### Diseño
- Nuevo **DESIGN.md**: sistema de diseño formalizado para el foco Taller × Cold Chain.

## [1.17.0] - 2026-06-19

H7 (parte 8) — Panel "Maintenance status" en el perfil de unidad.

### Añadido
- **UnitProfile**: nuevo panel entre las tarjetas resumen y las pestañas que
  rellena el espacio vacío y refuerza la jerarquía. Muestra la salud de
  PMs/componentes de la unidad de un vistazo: una **barra apilada** con la
  distribución de status (paleta `--st-*`), una **leyenda** con el conteo por
  status, y un **chip de acción** con lo más urgente — el componente vencido por
  mayor margen (rojo) o el próximo a vencer (amarillo), o "All components on
  track" (verde) si no hay nada pendiente. Solo aparece si la unidad tiene
  campañas/componentes cargados.

## [1.16.0] - 2026-06-19

H7 (parte 7) — Cohesión de color: Cold Chain (Reefer) adopta la paleta `--st-*`.

### Cambiado
- **Estado del reefer y desviación de temperatura** ahora usan la MISMA
  identidad de color que PM/DOT: el punto de estado On = verde (`--st-on-track`)
  con glow del mismo tono, Off = rojo (`--st-overdue`); los valores de
  temperatura ok/warn/danger usan los tonos `--st-*-ink` (legibles) en vez de
  `--ui-*`/ámbar suelto.
- **Las celdas warn/danger** de temperatura (y combustible bajo) llevan ahora un
  **tinte translúcido** (`color-mix … 12%`) para que las desviaciones salten a
  la vista — antes solo cambiaban el color del texto.

## [1.15.0] - 2026-06-19

H7 (parte 6) — Rollout del Design System: Settings (tanda 2).

### Cambiado
- **Settings** adopta `ds/Button` en las 6 acciones limpias de
  `.settings-actions`: Save changes, Save company, Save alert rules (las tres
  con `loading`), Download template, y los dos **Open fleet board** (con el
  glifo `⠿` como `icon`). Se mantienen sin tocar, a propósito: el **Upload CSV**
  (es un `<label>` que envuelve un `<input type=file>`, no un botón), los
  botones de guardar dentro de modales y las acciones inline de tablas
  (Add/Edit/Delete, paginación, IntegrationCard, theme picker) — quedan para
  una pasada con verificación visual por su layout/espaciado a medida.

### Notas
- Con esto, el rollout de header-actions/filtros del DS cubre todas las
  pantallas. Pendiente de "wow" visual (no mecánico): adoptar la paleta `--st-*`
  en Reefer (estado + desviación de temperatura) y un panel de estado bajo las
  tarjetas de UnitProfile (rellenar espacio, estilo "Fleet readiness").

## [1.14.0] - 2026-06-19

H7 (parte 5) — Rollout del Design System a las pantallas restantes (tanda 1).

### Cambiado
- **Drivers, DVIR, Cold Chain (Reefer), Parts, Roster, Onboarding y Map**
  adoptan los componentes `ds/`: botones de acción de header (Refresh/Sync/
  Export/Save/Create/Add… con `loading` e `icon` donde aplica) → `ds/Button`;
  los controles de filtro segmentado (Parts: parts/vendors; Roster: empresa)
  → `ds/Tabs`. Sin cambios de comportamiento.
- Pendiente para la próxima tanda: **Settings** (≈7 acciones limpias de
  `.settings-actions`) y los items diferidos (selects/inputs inline, botones
  `.btn-xs` dentro de tablas/drawers/modales). **UnitProfile** se deja como
  está: sus pestañas son nav de sección con subrayado (paradigma distinto del
  segmentado), no un filtro — se abordará en una pasada de polish dedicada.

## [1.13.0] - 2026-06-19

H7 — Identidad de color por status en PM/DOT y panel de salud de la flota.

### Añadido
- **Panel "Fleet readiness"** bajo las tarjetas de status (columna izquierda):
  crece para igualar la altura del donut (elimina el espacio vacío que quedaba
  a su lado). Muestra el % de unidades en regla (animado con CountUp), una barra
  apilada con la distribución de status y dos chips de acción — *Most overdue*
  (unidad con el `to_due` más negativo) y *Next due* (la más próxima a vencer).
  Aplica a PM y DOT (comparten `MaintBoardPage`).

### Cambiado
- **Filas de la tabla tintadas por status**: Overdue = rojo, On track = verde,
  Upcoming = amarillo pato, Never performed = celeste oscuro. Fondo muy tenue
  (≤8%, vía `color-mix` sobre `--surface` para adaptarse a dark) + riel lateral
  del color en la 1.ª celda — sin sacrificar el contraste del texto.
- **Identidad de color unificada por status** (un color = un status en toda la
  pantalla): nuevas variables `--st-*` / `--st-*-ink` claras y oscuras. El donut,
  las tarjetas, las barras y las píldoras de estado (`.mnt-status`,
  `.mnt-status-pill`) ahora usan la misma paleta; `Upcoming` pasa de ámbar a
  amarillo pato y `Never performed` de gris a celeste oscuro.

## [1.12.0] - 2026-06-19

H7 — Fix del donut de estado (PM + DOT) y rediseño de su leyenda.

### Arreglado
- **El arco resaltado en hover ya no se corta**: el segmento engrosaba (+5px)
  y su borde se salía del `viewBox` del SVG; ahora el radio reserva ese
  espacio. `.mnt-donut .card-body` pasa a `overflow: visible`.

### Cambiado
- **Leyenda del donut rediseñada y responsive** (PM y DOT comparten el
  componente): cada fila es un grid `[punto] [label 1fr] [valor] [% chip]` — el
  label crece y llena el hueco (con ellipsis, no se desborda) y el % pasa a ser
  un chip-pill. Medidas en `rem`/`%` en vez de px; el donut escala con el
  contenedor (`width:100%` + `max-width` + `aspect-ratio`) en vez de tamaño fijo.

## [1.11.0] - 2026-06-18

H7 (parte 4) — Rollout del Design System a las pantallas operativas.

### Cambiado
- **Fleet, Work Orders y PM/DOT (MaintBoard)** adoptan los componentes `ds/`:
  los botones de header (Refresh con `loading`, Export, Add/New) → `ds/Button`;
  los controles de filtro (tipo, estado, terminal) → `ds/Tabs` (conservando el
  toggle-off de terminal donde existía). Sin cambios de comportamiento.
- Pendiente (pasada con verificación visual): selects/inputs inline, pills de
  estado con conteo, chips de categoría y los botones `.btn-xs` dentro de
  tablas / drawers / modales.

## [1.10.0] - 2026-06-18

H7 (parte 3) — Rollout del Design System por pantalla (piloto: Defects).

### Cambiado
- **DefectsPage** adopta los componentes `ds/`: los 4 botones de acción
  (Refresh con `loading`, Copy, Export CSV, Clear) → `ds/Button`; los 2
  controles de filtro (rango de fechas, terminal) → `ds/Tabs`. Sin cambios de
  comportamiento. Los selects/inputs inline, los pills con conteo embebido y
  los chips de categoría se dejan para una pasada con verificación visual
  (riesgo med/high según el análisis).

### Notas
- Primer screen del rollout `ds/` (low-risk: acciones→Button, filtros→Tabs);
  pendiente eyeball visual antes de extender a Fleet / PM-DOT / Work Orders.

## [1.9.0] - 2026-06-18

H7 (parte 2) — Cinemática: count-up en los KPIs + arranque de la adopción del
Design System en el Dashboard (la vidriera).

### Añadido
- **`CountUp`** (`components/CountUp.tsx`): número que se anima (easeOutCubic)
  de su valor previo al nuevo; respeta `prefers-reduced-motion` (salta al valor).
- **KPIs con count-up en toda la app**: el `StatCard` compartido auto-anima los
  valores numéricos → los KPIs de Dashboard, Defects, PM/DOT, Fleet, Work
  Orders, etc. cuentan al cargar.
- **Dashboard construido con `ds/`**: botón Refresh → `ds/Button` (con `loading`),
  KPIs → `ds/StatCard`, valores con `CountUp` (incl. el % con formato).

### Notas
- La capa de motion ya era rica (F5: transiciones de página, entradas
  escalonadas, cascada de filas, lift/press, spring del sidebar, modal pop, con
  guards de `prefers-reduced-motion`); esta parte suma el count-up y empieza a
  consumir los `ds/`.
- **Rollout del DS por pantalla**: un análisis (workflow sobre 16 pantallas)
  mapeó qué migra a `ds/` y su riesgo. Acciones→Button y filtros→Tabs son
  low-risk; los pills con conteo embebido, los wrappers Card (clases de grid) y
  los tiles bespoke son med/high y se migran en pasadas siguientes con
  verificación visual.

## [1.8.0] - 2026-06-18

H7 (parte 1) — Design System core: tokens + 9 componentes base (del design
handoff de Claude Design), listos para construir las pantallas a partir de
ellos en vez de estilos one-off.

### Añadido
- **Design System core** (`frontend/src/components/ds/`): 9 componentes React
  base — Button, IconButton, StatusPill, Badge, Tabs, Input, StatCard,
  NavItem, Card. Se estilizan 100% con inline styles que leen los tokens
  (`var(--*)`); sin dependencias nuevas. Importables desde `components/ds`.
- **Tokens faltantes** en `index.css`: `--radius-btn`/`--radius-pill`, escala de
  tipo (`--fs-*`), espaciado (`--space-*`), pesos (`--fw-*`), tracking,
  `--glow-accent(-hover)`, `--dur-*`, `--shadow` alias, `--container-pad`,
  `--sidebar-w-collapsed`, y el keyframe `ft-spin`. (Colores, temas, fuentes y
  easings ya existían y coincidían con el handoff.)

### Arreglado
- Deps del frontend sincronizadas: `@dnd-kit/*` estaba en `package.json` pero sin
  instalar → el Fleet board fallaba en runtime y el typecheck/build estaban
  rojos. Tras `npm install`, typecheck y build vuelven a **verde**. Tipo de
  `FleetBoard.autoHintOf` ahora admite `undefined`; quitado un `labelOf` sin
  usar en `SettingsPage`.

## [1.7.0] - 2026-06-18

H6 — config y PII por-tenant: los stores de configuración que todavía eran
archivos `*.local.json` ahora viven en la base (`OrgSetting`, por
organización), con import transparente del JSON legacy.

### Cambiado
- **terminals**, **teams**, **unit_settings** (device settings por unidad),
  **pm overrides** y **driver contacts/emails** (PII) migrados de
  `*.local.json` a `OrgSetting` (claves `terminals`/`teams`/`unit_settings`/
  `pm_overrides`/`driver_contacts`/`driver_emails`), vía
  `db.get_setting`/`save_setting` con `legacy_file` — los JSON existentes se
  importan una sola vez a la org `default`. Quedan org-scoped (multi-tenant)
  sin cambiar la API pública de cada módulo.

### Notas
- Con esto, toda la configuración no-secreta vive en `OrgSetting` (org_config,
  app_config, alerts, companies, notice_templates, providers, terminals,
  teams, unit_settings, pm_overrides, driver_contacts). Pendiente de H6:
  `org_id` NOT NULL + Row-Level Security en Postgres y un script de migración
  de datos SQLite→Postgres.

## [1.6.0] - 2026-06-18

Release de consolidación: todo el trabajo acumulado desde v1.5.0 (no
publicado hasta ahora) — productización multi-tenant, Postgres/Alembic,
control de reefer por OEM, framework multi-ELD y un modo demo para
portafolio.

### Añadido
- **H6 — Multi-tenant + Postgres/Alembic**: motor de base configurable por
  `DATABASE_URL` (PostgreSQL en prod, SQLite en dev); aislamiento por
  organización (`org_id`) con `Organization`/`OrgSetting`, contexto de tenant
  por request y scoping a nivel ORM; config no-secreta por tenant en
  `OrgSetting` y secretos en `SecretStore`. **Alembic** para migraciones de
  esquema (migración inicial con todo el esquema); guía `backend/DATABASE.md`.
- **Cold Chain — control OEM bidireccional**: adapters **Carrier Lynx** y
  **Thermo King** (setpoint/modo/defrost, two-way) con orden de fuentes por
  soberanía del dato (OEM → Traccar → demo) y UI de control gateada por rol.
- **Puente reefer → Work Order** (`core/reefer_wo.py`): un fault code de
  reefer crea una orden de trabajo idempotente, disparado por el loop de
  alertas.
- **Framework multi-ELD**: proveedores auto-descriptivos + hub por registry;
  proveedor **Motive** además de Samsara.
- **Teams (Equipos)** + **Fleet board** con asignación drag-and-drop; **alta
  manual de unidades + VIN decoder**; CRUD de empresas + import de unidades
  por CSV en Settings.
- **Reporting desde el ELD**: import de DVIR/actividad/pre-trip desde Samsara
  (distancia por odómetro, pre-trip desde HoS) con plantillas Standard/Legacy;
  plantillas de avisos + broadcast a conductores.
- **PM/DOT**: export a PDF con reporte diseñado (donut + tarjetas), filas
  coloreadas por estado, fechas en formato US.
- **Modo demo (portafolio)**: ELD sintético (`core/demo_eld.py`) para correr
  sin Samsara, con flota ficticia "Summit Freight"; `clean_for_demo.bat` para
  limpiar datos/credenciales locales; empresa SUMMIT en el import de CSV.

### Cambiado
- **Foco de producto**: se removió Loads/dispatch; el roster de conductores
  queda como **Driver Compliance** dentro de Maintenance & Compliance.
- **Settings rework**: botones hover-expand, fila de alta rediseñada, CC
  routing dinámico por terminal, Connectivity colapsable.
- `db.py`: la creación del esquema se movió a `init_schema()`. SQLite (dev)
  sigue con `create_all` + migraciones aditivas; en **Postgres el esquema lo
  maneja Alembic** (`alembic upgrade head`). `FLEET_SKIP_DB_INIT` permite a
  Alembic importar la metadata sin tocar la base.
- `launch.bat`: auto-actualiza (`git pull --ff-only`) al arrancar.

### Seguridad / privacidad
- Se eliminaron del repo los datos/PII del ex-empleador; semillas vacías para
  un demo limpio. Los `*.local.json/csv` (credenciales/PII) siguen gitignored.

## [1.5.0] - 2026-06-14

H5 — Reefer tracking real (capa de software/ingesta): el Cold Chain puede
consumir telemetría REAL de reefers desde un Traccar self-host, reemplazando
el modo demo. El piloto físico de hardware queda pendiente del usuario.

### Añadido
- **`core/traccar.py`**: cliente del REST de Traccar (token) que lee devices +
  posiciones + historial y los mapea a la forma `ReeferUnit` del Cold Chain
  (temp de caja, puerta, batería, GPS) con mapeo de atributos configurable,
  setpoint/umbral por unidad y **alarmas por umbral** propias (desvío de temp,
  sin-datos/stale, batería baja). Probado con JSON sintético (incl. bajo cero).
- **Cold Chain en vivo**: `/api/reefer` ahora prefiere **Traccar (real) →
  Samsara → demo**, con un campo `source`; el historial de un device va a
  Traccar. `ReeferPage` muestra el origen ("LIVE · TRACCAR") y el banner demo
  apunta al camino Traccar.
- **Traccar en Connectivity**: proveedor testeable/configurable (Test = lee
  `/server` + cuenta devices) en un grupo nuevo "Cold chain".
- **Guía del piloto**: `backend/REEFER_SETUP.md` (VPS + Teltonika FMC130 +
  DS18B20, con el recordatorio de probar bajo cero) + `traccar.example.json`.

### Notas
- Investigación verificada (2 workflows) sobre el control remoto de reefers
  Carrier X4, documentada en el handoff y la memoria. Conclusión: **NO** hay
  forma aftermarket self-host de **controlar** el setpoint de un Carrier X4
  (controlador propietario, sin protocolo reverse-engineered, Traccar sin
  comando de reefer). El control real es solo vía OEM (Carrier Lynx, ya de
  fábrica en los X4 2022) o plataformas cerradas pagas; el **monitoreo** sí es
  self-host (Teltonika + cable RS232 de Carrier → Traccar).

## [1.4.0] - 2026-06-13

H4 — RBAC real: permisos finos por rol (antes el enforcement era binario
admin/no-admin).

### Añadido
- **Rol `safety`** (5 roles: admin · dispatcher · safety · mechanic ·
  viewer). `safety` cubre cumplimiento (DVIR/PM/DOT, avisos, PII), sin
  facturar ni dispatch.
- **`core/permissions.py`**: scopes concretos (`maint.edit`, `wo.invoice`,
  `notices.send`, `pii.view`, `tms.edit`, `fleet.edit`, `alerts.manage`,
  `settings.manage`) + matriz rol → scopes (`has_scope`, `scopes_for`).
- **Enforcement por scope en el middleware** (`_scope_for(method, path)` en
  main.py): cada escritura exige su scope; la lectura (GET) la ve cualquier
  autenticado. Facturar una WO exige `wo.invoice` (chequeo extra en la ruta,
  depende del body). `/api/auth/status` devuelve los `scopes` del usuario.
- **PII enmascarada server-side**: `/api/drivers` ofusca email/teléfono si el
  rol no tiene `pii.view` (defense-in-depth, además del masking de F4).
- **Frontend `usePerms()`/`can(scope)`** (`src/perms.ts` + contexto en
  App.tsx): se ocultan/deshabilitan acciones según el rol. Gateado: botón
  **New work order** (maint.edit), etapa **Invoiced** + **Email/SMS**
  (wo.invoice), **Send** de Avisos (notices.send). Selector de roles en
  Settings → Users incluye **safety** + un resumen de lo que puede cada rol.

### Notas
- Verificado: matriz + mapeo de rutas (asserts) + **E2E aislado** (usuarios y
  tokens reales sobre DB temporal: viewer/mechanic/dispatcher/admin reciben
  403/200 según corresponde).
- Diferido a H4.2: ocultar secciones del sidebar por rol, gatear cada botón de
  edición individual en la UI (hoy el backend 403ea), y billing por asiento.

## [1.3.0] - 2026-06-13

H3-C (Fullbay-killer slice C): estimate/invoice imprimible de Work Orders,
más una tanda de mejoras al escáner de invoices y de UX a partir del review
del usuario.

### Añadido
- **Estimate / Invoice imprimible (H3-C)**: documento por Work Order que se
  imprime a PDF desde el navegador (patrón print-to-PDF, sin deps, como
  `UnitReport`) — `components/WorkOrderInvoice.tsx`. Modo **ESTIMATE** si la
  orden no está facturada e **INVOICE** cuando pasa a `invoiced`. Botones
  **Print** y **Email / SMS** en el drawer de la orden.
- **Identidad del taller + Bill-To + numeración** en `org_config`
  (Settings → Company): bloque `shop` (el "From" del documento), `billing`
  (dirección de Bill-To por empresa CHASER/MCC) e `invoice` (prefijo, terms,
  footer + contador `next_number` autoincremental). `next_invoice_number()`
  asigna el número al facturar por primera vez; el formato se configura una
  vez en Settings y **no es editable por orden**.
- **Envío del documento** (`core/wo_invoice.py`): email HTML con estilos
  inline (vía mailer, real) + texto + resumen SMS (Twilio); todos los campos
  del usuario van escapados (anti-inyección). Endpoint
  `POST /api/workorders/{id}/send`.
- **Campos nuevos de Work Order**: `invoice_number` (propio, auto),
  `po_number`, `authorizer`, `shop_invoice` (nº de invoice del taller
  externo, del escaneo) — visibles/editables en el drawer y en el documento.
- **Un Work Order por unidad**: si un invoice cubre varias unidades (PM al
  tractor + llanta al trailer), al crear se genera **una orden por cada
  unidad distinta** (WO#1 CF2246 + WO#2 743451). Las líneas de costo van en
  la orden primaria (su total cuadra con el invoice); las otras quedan como
  registro por unidad.
- **Rol nuevo (preparación H4)**: pendiente — esta versión deja el terreno
  listo para RBAC fino.

### Cambiado
- **Escáner de invoices — marcas de cadena**: reconoce Love's, Speedco, TA,
  Petro, Boss Shop, Pilot/Flying J, FleetPride y Sapp Bros leyendo el
  encabezado (no el pie de garantía), y normaliza el vendor a la marca real
  (antes tomaba el header genérico "TOTAL TRUCK CARE").
- **Escáner — total que cuadra**: las líneas se toman del **bloque resumen**
  del fondo del invoice (Parts/Labor/Tires/Fees/Tax), anclado a la línea del
  Total, de modo que la suma **siempre coincide con el monto final** impreso
  (la suma de ítems sueltos no cuadraba). Fallback a parser columnar
  (Love's/Speedco) y luego al simple.
- **Title = campaña**: si la orden tiene una campaña (p.ej. PM), el título
  es el nombre de la campaña ("Full Wet Service (PM)") en vez de la 1ª línea
  del complaint.
- **Textareas de complaint** que se acomodan al texto (`field-sizing:
  content`) para que siempre se vea todo el contenido.
- **Sidebar colapsado**: iconos más grandes (cajas 48×44, icono 22px),
  más padding y separación, botones del pie acordes; el riel se ve más
  prolijo (antes los recuadros quedaban apretados).
- **`launch.bat`**: libera el puerto 8765 antes de arrancar (un uvicorn
  viejo en memoria seguía sirviendo código viejo y "no se veían los
  cambios"; el nuevo no podía tomar el puerto y moría callado).

### Arreglado
- El botón de **borrar complaint** en el modal de New work order estaba
  invisible (`.mnt-icon { opacity: 0 }`, solo se mostraba en filas de
  tabla): ahora se ve siempre.
- **Redondeo del documento**: los subtotales Parts/Labor ahora suman
  exactamente el total mostrado (se redondea por subtotal antes de sumar);
  antes podían descuadrar 1¢ en una minoría de documentos.
- En impresión, sólo el documento es visible: se ocultan `#root`, el toaster
  y los portales de drawers (vaul) — antes un drawer abierto podía colarse
  en el PDF.

## [1.2.1] - 2026-06-12

### Añadido
- **Riel colapsado con flyouts por grupo** (estilo Samsara): al colapsar
  el sidebar, cada grupo se muestra como un icono y al hacer **hover**
  (no click) se despliega un flyout con sus ítems navegables (con icono
  y estado activo). Iconos de grupo nuevos (Overview/Operations/
  Maintenance & Compliance/Dispatch/Coming soon); el modo expandido (lista
  completa con labels) se conserva como toggle. El flyout escapa del
  scroll (`overflow: visible` en colapsado) y usa un puente transparente
  para no cerrarse al cruzar el gap; respeta `prefers-reduced-motion`.

## [1.2.0] - 2026-06-12

Terminales dinámicas, profundidad Fullbay-killer (H3: catálogo de partes +
vendors y tarifa de labor) y un lote grande de UX de mantenimiento:
agrupado del sidebar, fix de navegación, modal de work order fluido y de
alto completo, y escaneo de invoices **multi-complaint** con extracción
sin IA reescrita.

### Añadido
- **Terminales dinámicas** (Settings → Terminals, solo admin):
  `core/terminals.py` (store `terminals.local.json`, gitignored) con CRUD
  y asignación de flota por terminal. Cada terminal define `prefixes` y se
  le puede **pinnear** unidades a mano. Resolución: pin manual → prefijo
  más largo (el carácter siguiente no puede ser letra) → empresa MCC →
  primera terminal. Endpoints `GET/POST/DELETE /api/terminals` +
  `POST /api/terminals/assign`. `frontend/src/terminal.ts` reescrito como
  hook `useTerminals()` (TanStack Query, fallback de fábrica). Los filtros
  de terminal en **Fleet, Defects, PM Tracker, DOT Inspections y Work
  Orders** ahora salen de esta config (chips solo si hay más de una).
- **Catálogo de Partes + Vendors (H3-A)** estilo Fullbay: tablas `vendor`
  y `part` (costo **interno**, sin markup), `core/parts.py` con CRUD +
  guards (dedup de part#, borrar vendor desvincula sus partes), rutas
  `/api/vendors` y `/api/parts`. Nueva sección **Parts & Vendors**
  (`views/PartsPage.tsx`) con pestañas Parts/Vendors, KPIs, búsqueda y
  alta/edición por modal. Las **líneas de Work Order** autocompletan
  descripción + costo eligiendo un part# del catálogo (chip + conteo de
  uso); `part_number` se guarda en la línea.
- **Tarifa de labor del taller (H3-B)**: `org_config.labor_rate` ($/hr,
  editable en Settings → Company); las líneas de labor de un WO se
  costean solas con esa tarifa.
- **Grupo de sidebar "Maintenance & Compliance"** (Fleet, PM Tracker, DOT
  Inspections, Work Orders, Parts & Vendors).
- **Escaneo de invoices multi-complaint**: un invoice puede generar
  **varios complaints** (p. ej. un PM al tractor + una llanta al
  trailer), cada uno con su unidad/millaje; el que no corresponde a la
  unidad del WO se marca **"different unit"** y se borra con un clic
  (confirmación al crear si quedan mezclados). El texto del complaint usa
  el formato del usuario (descripción / SHOP, CITY, STATE / blank /
  ` Shop Invoice # NUM | DATE` / `UNIT - MILEAGE`).
- Generador del **formulario imprimible de Work Order** para la yarda
  (`backend/scripts/make_wo_form.py`, PDF a mano, dev-only).

### Cambiado
- **Modal de New Work Order** ahora es **fluido** (`min(width, 100vw-32px)`
  vía variable CSS, en vez de un ancho fijo en px) y de **alto completo**
  (`Modal` con prop `fullHeight` → `.modal.is-tall`, cuerpo scrolleable).
- **Escáner de documentos reescrito** (`core/docscan.py`): `WoExtract`
  devuelve `complaints[]` (unit/mileage/detail ≤4 líneas/is_pm) +
  vendor/ciudad/estado/invoice#/fecha compartidos. El **parser heurístico
  sin IA** se reescribió para el layout real de los invoices de taller
  (encabezados de unidad en una fila y datos abajo, múltiples unidades,
  textos `Complaint #N`/`Correction`, ciudad/estado, invoice# en layout
  invertido). Los proveedores de IA (Ollama/Claude/Textract) siguen como
  motor principal; el heurístico es el fallback sin red.
- **New Work Order**: se quitó el campo *Issue title*; el título se deriva
  de la primera línea del complaint.
- **Contraste del perfil de unidad y de los tableros PM/DOT**: las stat
  cards y las pills de status pasan a colores theme-aware (`color-mix`
  con `--text` y tokens `--ui-*`), legibles (AA) en claro y oscuro.

### Arreglado
- **Navegación desde el perfil de unidad**: al estar abierto el perfil,
  clic en otra sección del sidebar no hacía nada (solo el botón Fleet lo
  cerraba). Ahora un helper `navigate()` cierra el perfil al cambiar de
  sección, cableado en todos los puntos de navegación.
- **Work Orders**: filtro de terminal que quedaba pegado e invisible al
  cambiar de status (clamp + `keepPreviousData`).
- **Terminales**: rechazo de prefijo ya usado por otra terminal (400);
  veto a borrar la última terminal; el picker de flota ya no des-pinea en
  silencio unidades archivadas.
- **Heurístico de docscan** (hallazgos del review adversarial): año de 4
  dígitos capturado como unidad; millaje que tomaba el eco del propio
  número de unidad; ruteo de complaints que robaba el match de otra
  unidad; fecha inválida (13/45) que pasaba sin validar.
- **Formato del complaint**: línea en blanco espuria cuando no hay shop
  ni invoice.

## [1.1.0] - 2026-06-12

Rework H fases 1-3b: mantenimiento DOT+PM unificado, pipeline de Work
Orders estilo UNIQ con Telegram, escáner AI de invoices (4 motores) y
perfil de unidad estilo Fullbay. Además: fix de causa raíz del Live Map,
toda la UI en inglés y logo/favicon a la marca actual.

### Añadido
- **DOT Inspections + PM Tracker unificados (H1)**: tablero compartido
  `views/MaintBoardPage.tsx` (reemplaza PMPage) para los kinds `pm` y
  `dot`; tabla `maint_record` (cada edición es un evento, manda el más
  reciente por fecha), `core/maint.py` con board unificado (PM fusiona
  CSV Fullbay + overrides + records; DOT vence +365 días, upcoming ≤30);
  `ops_status` manual por unidad (out_of_service|in_shop); endpoints
  `/api/maint/{kind}`, `/maint/record`, `/maint/ops-status`,
  `/maint/odometer/{unit}`; tarjetas de status filtrables con % y barra,
  tabla editable inline, modal Add PM/DOT con botón "Current" (odómetro
  Samsara en un clic) y animación de confirmación en cascada.
- **Work Orders pipeline secuencial (H2)**: open → assigned →
  in_progress → completed → invoiced; StageBar de chevrones estilo UNIQ
  (hover previsualiza el camino, clic multi-salto); gates de negocio
  (assigned exige mecánico, invoiced exige total>0, retroceder deshace
  sellos); columnas nuevas mileage/service_date/invoiced_at y
  "Waiting for parts" como flag; form del jefe con botón Current; 6
  KPIs; el hook de PM dispara desde completed.
- **Notificaciones Telegram (H2)**: `core/telegram_notify.py` — bot al
  group chat del taller al cambiar de estado un WO (configurable por
  estado, dry_run por defecto); test getMe sin enviar; en Settings →
  Connectivity con Configure+Test; guía `backend/TELEGRAM_SETUP.md` +
  `telegram.example.json`.
- **Escáner AI de invoices (H2.5/H2.5b)**: `core/docscan.py` con 4
  motores y resolución auto (Textract si hay creds AWS > Claude si hay
  api key > Ollama local gratis > heurístico regex para PDFs digitales):
  AWS Textract AnalyzeExpense (grado comercial, PDF→PNG por página vía
  pypdfium2, merge multi-página, overlay heurístico para campos de
  flota), Anthropic (messages.parse + Pydantic), Ollama local
  (qwen2.5vl:7b, salida estructurada nativa, verificado E2E). Endpoint
  POST `/api/workorders/scan`; dropzone en New work order que autollena
  el form y agrega las líneas extraídas; reconciliación de cantidades
  qty=total/unitario; provider "docscan" en Settings → Connectivity.
  Deps nuevas: anthropic, pypdf, pypdfium2, boto3.
- **Perfil de unidad estilo Fullbay (H3a)**: `views/UnitProfilePage.tsx`
  (clic en una fila de Fleet) con 4 pestañas — Components & PMs
  (campañas por unidad: pm/dot por defecto, kingpins/dpf/clutch opt-in,
  con last done/next due/status y "Record done" + historial), Active
  Services (WOs abiertas por status), Service History (WOs facturadas
  con Edit/Delete) y Attachments (documentos por unidad con multi-upload
  drag&drop, download autenticado y delete; tabla `unit_doc`, archivos
  en `backend/uploads/` gitignored). Header con 3 stat cards (costo 12m,
  servicios activos, odómetro vivo + PM remaining).
- **WO ↔ campañas (H3b)**: campo `campaign` en work_order (migración
  is_pm → 'pm'); select de campaña en crear y en el drawer; al facturar
  se crea el maint_record de la campaña (idempotente por "WO #id:" en
  notas) y el perfil Components & PMs se actualiza solo; modal New work
  order a dos columnas con preview del documento junto al form (img o
  iframe PDF, sticky); líneas del modal editables (kind/desc/qty/costo,
  quitar, "+ Add line").
- Docs vivos nuevos: `docs/ROADMAP-H.md` (plan del rework),
  `docs/STRATEGY-data.md` (investigación de mercado/datos),
  `docs/map-debug-plan.md` (postmortem del mapa) y `handoff.md` (raíz).

### Cambiado
- **Toda la UI en inglés** (~310 strings: vistas, componentes y mensajes
  de error del backend que viajan por la API); comentarios de código
  quedan en español; valores almacenados/comparados intactos.
- **Logo/favicon a la marca actual**: `favicon.svg` y
  `fleet-tracker.ico` redibujados (badge rojo + flecha de navegación);
  `make_icon.py` actualizado.
- Work Orders: el estado `closed` se eliminó del pipeline (migración
  closed → invoiced; invoiced es terminal); las WOs ahora se pueden
  editar inline (title/complaint) y eliminar (DELETE + confirm).
- Los modales se renderizan vía portal en `document.body`
  (`components/Modal.tsx`) y la animación de página usa
  `fill-mode: backwards` — inmuniza los modales contra el bug de
  containing block de Chrome con `position:fixed`.

### Arreglado
- **Live Map borroso y con la cámara perdida**: `.map-shell` (grid) no
  acotaba la fila → el canvas WebGL heredaba ~10,540px y se clampeaba a
  4096px estirado; fix `grid-template-rows: minmax(0,1fr)` +
  `min-height:0` en la cadena (verificado con Playwright headless;
  postmortem en `docs/map-debug-plan.md`).
- Cantidades del escaneo de invoices: WoLineExtract ganó `total` y
  `_normalize` reconcilia qty cuando qty×unitario no cuadra (caso Loves
  39×$3.51 verificado).

## [1.0.0] - 2026-06-11

El release mayor: el **Rework G completo (8 fases)**. Fleet Tracker pasa de
herramienta interna a plataforma de operaciones de flota white-label:
tracking en vivo, alertas, cold chain, work orders, TMS de despacho,
multi-ELD y productización con auth real.

### Añadido
- **Live Map (G1)**: mapa en tiempo real (MapLibre + OpenFreeMap, sin API
  key) con la flota completa de Samsara — velocidad, rumbo, ubicación
  geocodificada, engine state, fuel % y DEF % por unidad; panel lateral
  estilo Panda ELD con **botón de copiar coordenadas** y abrir en Google
  Maps; barra de duty status DR/ON/SB/OFF desde HoS clocks; clustering,
  búsqueda, filtro "Moving", refresco cada 20 s. Backend
  `core/tracking.py` (stats feed + hos/clocks por org en paralelo).
- **Servicios en el mapa (G2)**: dataset propio de **4,281 POIs**
  (talleres de camión, dealers de trucks y trailers/reefers, básculas —
  OSM con atribución ODbL + Illinois DOT) sembrado en SQLite desde
  `backend/data/pois_seed.json`; capas con chips de filtro y sub-filtro
  "DOT only"; popups con teléfono/coordenadas; **Nearby services** (los 5
  más cercanos a la unidad seleccionada con distancia en millas); CRUD de
  POIs; proxy de búsqueda Google Places **solo-lista** (sus ToS prohíben
  pintar resultados en mapas no-Google).
- **Alertas de flota (G3)** (`core/alerts.py`): 6 reglas configurables
  (velocidad, idle, fuel bajo, DEF bajo, sin GPS, desviación de reefer)
  evaluadas cada 60 s en background con cooldown de 60 min por
  unidad+regla; feed en Dashboard con Ack, toasts in-app; email/SMS
  **opt-in y apagados por defecto**; device settings por unidad
  (apodo, grupo, mute, notas) en el drawer de Fleet.
- **Cold Chain (G4)** (`core/reefer.py`): monitoreo de reefers vía
  trailer stats de Samsara (setpoint/return/supply/ambient en °F,
  alarmas con severidad, run mode, fuel, puertas), chart SVG de 24 h por
  unidad, export CSV y **modo demo etiquetado** mientras no haya
  hardware de reefer reportando; regla de alerta por desviación que
  solo evalúa datos reales.
- **Work Orders (G5)**: pipeline de taller (Open → In Progress → Waiting
  Parts → Completed) con partes y labor (qty × costo, totales en vivo),
  mecánicos, prioridades, KPIs de costo 30d; **botón "→ WO" en cada
  defecto abierto** del drawer de unidad; **cerrar un WO de PM con
  odómetro actualiza el PM tracker** (adiós dependencia del CSV de
  Fullbay para registrar servicios).
- **Dispatch TMS (G-TMS)**: secciones **Drivers** (perfil estilo
  QuickManage: tarjetas de vencimientos CDL/Med/MVR/Clearinghouse con
  semáforo, contrato con % de pago, equipo asignado, contacto de
  emergencia, pestaña Trips) y **Loads** (entrada de cargas con stops
  dinámicos y citas, **payout del driver calculado en vivo según su
  contrato**, pipeline de 6 estados, tags, checklist de documentos
  RC/BOL/POD, desglose invoice vs payout).
- **Multi-ELD (G6)**: capa `core/providers/` con la interfaz
  `TelematicsProvider` (Samsara la implementa; **Motive** cableado con
  ping real y mapa de endpoints); **Test de conexión** por integración
  (lecturas mínimas seguras, login SMTP sin enviar) y **Configure desde
  la UI** (escribe los `*.local.json` mergeando; los secretos jamás se
  devuelven — solo colas enmascaradas).
- **Productización (G7)**: **autenticación real** (pbkdf2-sha256,
  tokens HMAC de 30 días, middleware que exige token en toda la API,
  roles admin/dispatcher/mechanic/viewer con anti-lockout), **wizard de
  primer arranque** (crea el admin, nombra la empresa, elige el acento),
  **white-label en vivo** (nombre/tagline/acento aplicados a toda la app
  vía color-mix), **Settings → Company** (umbrales de negocio y CC
  routing por terminal configurables — los hardcodeos de Chaser/MCCI
  quedan como defaults de fábrica) y **Settings → Users** (gestión de
  cuentas y roles). `PRODUCT.md` con la estrategia de diseño.
- Sidebar **colapsable a riel de iconos** y reorganizado (Overview /
  Operations / Dispatch / Admin); hub **Connectivity** en Settings.
- Dataset y branding listos para otras empresas: defaults de fábrica +
  `org.local.json` por tenant.

### Cambiado
- **Avisos rediseñado**: flujo en 3 pasos, pills de estado por canal
  (con LIVE en rojo), tabla de destinatarios con avatares, dock de
  envío, resultados como timeline y preview tipo cliente de correo con
  tabs Email/SMS y marco de teléfono.
- **Login real**: usuario+contraseña contra `/api/auth/login` con
  errores del servidor; branding de la empresa en el hero.
- PM: el intervalo y el umbral "Upcoming" salen de la configuración de
  empresa; pase de taste-skill (sin emojis en UI nueva, copy revisado).

### Seguridad
- Toda la API exige `Authorization: Bearer` (allowlist mínima: salud,
  login/setup/estado y branding). El primer arranque queda abierto SOLO
  hasta crear la cuenta admin.
- Credenciales siempre en `*.local.json` gitignored; la edición en-app
  nunca expone secretos. Canales de envío reales opt-in.

## [0.20.0] - 2026-06-10

### Añadido
- **Rediseño grande (Fase 1–3)** — base visual de alto contraste enfocada a
  comercializar la app.
- **Fundación de diseño**: tipografía **Space Grotesk** (display) + **Geist**
  (cuerpo); tokens de color con rojo de marca `#e11900`/`#ff4438`, charcoales
  en capas (no planos), overlay de grano (ruido SVG), sombras tintadas y escala
  de z-index. **Logo nuevo**: badge squircle rojo con flecha de navegación.
- **Login comercial** (`views/LoginPage.tsx`): hero con **fotos rotativas**
  (4 imágenes de logística que rotan cada 6s con cross-fade + Ken-Burns y dots
  clicables), copy de marketing sincronizado, strip de stats de confianza y
  panel de acceso premium. Las fotos son intercambiables y caen con gracia al
  gradiente de marca si una URL falla. Respeta `prefers-reduced-motion`.
- **Dashboard home** (`views/Dashboard.tsx`): nueva landing por defecto con
  5 KPIs en vivo (Fleet SAFE del mes, defectos abiertos, PM vencidos/próximos,
  unidades activas, DVIR pendientes), tendencia mensual, donut SAFE, listas de
  "Requiere atención" (PM) y "Top DVIR pendientes", actividad reciente y
  accesos rápidos a cada sección. Reusa las query keys existentes.

### Cambiado
- **Sidebar reorganizado** en grupos con encabezados: **Overview** (Dashboard),
  **Operations** (DVIR, Defects, Notices, Fleet, PM Tracker), **Coming soon**
  (Reports & Analytics, Work Orders — deshabilitados) y **Admin** (Roster,
  Settings) al fondo.
- **Roster movido a Admin**: la info sensible sale de la zona de operación
  frontal y baja a la sección Admin del sidebar (el enmascarado/reveal llega
  en una fase posterior).

## [0.19.0] - 2026-06-10

### Añadido
- **Avisos multi-canal (Email + SMS)**: en la página de Avisos se eligen los
  canales (chips multi-selección) y se envía por los dos a la vez.
- **SMS/MMS por Twilio** (`core/sms_service.py`): texto, imagen como **MMS** y
  video como **link** en el cuerpo. Teléfonos normalizados a E.164. Modo
  `dry_run` hasta cargar `backend/twilio.local.json`. Requiere registro
  **A2P 10DLC**.
- **Hosting de media (Cloudinary)** (`core/media_host.py`): como Twilio MMS
  necesita URL pública y la app es local, el adjunto (imagen/video) se sube a
  Cloudinary y se usa su URL. Config en `backend/cloudinary.local.json`.
- Endpoint `/notify/media` (sube el adjunto) y `/notify/send` con `channels` +
  media. Guía **`backend/SMS_SETUP.md`** + `twilio.example.json` /
  `cloudinary.example.json`.
- Preview de SMS estilo burbuja, columna de teléfono por conductor, resultados
  por canal y banner de estado por canal.
- `.mcp.json` (config del MCP de 21st.dev "Magic" por variable de entorno).

### Cambiado
- **Plantillas de aviso reescritas** (texto oficial de Safety/Maintenance): el
  **email** lleva el texto completo (saludo + unidades marcadas + cuerpo +
  firma); el **SMS** una versión **compacta** que conserva los 10 pasos del
  proceso (~9 segmentos en vez de ~24).

### Cambiado
- **Fleet y Defects**: se quita el selector de empresa (Chaser/MCCI/All); el
  filtro geográfico queda unificado en el **selector de terminal**:
  **Chaser · Memphis · Chicago · Miami · Georgia** (Atlanta + Savannah
  agrupadas en *Georgia*). Los chips se muestran solo si hay unidades de esa
  terminal. Las unidades de MCC sin prefijo de terminal (trailers/chassis)
  quedan bajo "All terminals".

## [0.18.0] - 2026-06-08

### Añadido
- **Pantalla de login** (capa visual): gate de acceso con `LoginPage` y botón
  de cierre de sesión. Por ahora no hay backend de auth (la API sigue abierta).
- **Notificaciones (Sonner)**: toasts de éxito/error en acciones clave (copiar
  día DVIR, enviar avisos, guardar/sincronizar emails, guardar settings).
- **Drawer de detalle de unidad (Vaul)**: clic en una unidad en **Fleet** (fila)
  o **Defects** (código) abre un panel lateral con ficha, defectos abiertos y
  PM, además de un botón para **archivar/excluir** la unidad.
- **Fleet**: clasificación de tipo **Truck / Trailer / Chassis** (chassis =
  `unpowered` con nombre-código tipo CELL/CELF/G…); se **oculta la chatarra**
  (gateways sueltos y assets dados de baja). Filtros por **tipo** y por
  **terminal** (Memphis/Miami/Atlanta/Savannah/Chicago/Chaser). KPI de Chassis.
- **Defects**: **chips de categoría** color-codificados y filtro por **terminal**.
- **PM**: filtro por **terminal**; gráfico de estado convertido en **donut**
  interactivo (hover ↔ porción) con leyenda en pills 2×2.

### Cambiado
- **Logo** rediseñado (ilustración de tractomula + wordmark en itálica, estilo
  Fullbay) y wordmark en itálica en sidebar y login.
- **PM**: estados renombrados — `OK → On Track`, `No PM record → Never
  Performed`, `Due soon → Upcoming`; el umbral de **Upcoming** pasa a
  **5 500 millas**. Botones Edit/Exclude como **iconos** y marcas EDITED/MANUAL
  como un lapicito discreto.
- **Rediseño general** de listas (Fleet/Defects/PM): tipografía (encabezados en
  mayúscula, códigos más marcados), animaciones de entrada y hovers, y botones
  de acción como **iconos**.

### Arreglado
- **DVIR Report**: la columna **Post-trip** mostraba `⚠ NO PRE-TRIP` cuando
  faltaba el log de post-trip → ahora muestra **`⚠ NO POST-TRIP`**. Además se
  **quitó la columna Post-trip** del reporte (a pedido) y los conductores sin
  Pre-trip se ordenan al fondo, junto con los NO DVIR.
- **Defectos fantasma**: la lista de defectos abiertos arrastraba defectos
  viejos (de 2025) colgados de assets renombrados/duplicados en Samsara. La
  ventana del stream baja de **730 → 270 días**, así se descartan los fantasmas
  sin perder ningún defecto vigente (incluidos los creados a mano). Los assets
  archivados quedan excluidos de los defectos.
- **`contacts`**: se rompe la dependencia circular con `cc_routing` inyectando
  el resolutor de región.

## [0.17.0] - 2026-06-07

### Cambiado
- **El DVIR Report deja de medir la duración del DVIR.** Lo relevante para DOT
  es que el conductor registre su **Pre-Trip** y **Post-Trip** en sus logs de
  HoS (On Duty), no la duración del DVIR. Las columnas `Duration trk` /
  `Duration trl` se reemplazan por **`Pre-trip`** y **`Post-trip`** (por
  conductor).
  - La duración de cada inspección se calcula como `End − Start` del custom
    report de Samsara *"Pre-trip & Post-trip | Remark not empty"* (se suman
    todos los segmentos On Duty con remark "Pre-Trip Inspection" /
    "Post-Trip Inspection"). Verde si ≥ 15 min, rojo si < 15 min.
  - Si el conductor no registró la inspección → **`⚠ NO PRE-TRIP`** (naranja).
  - El banner **`⚠ NO DVIR`** ahora se fusiona de la columna D a la F (antes
    D–H); Pre-trip y Post-trip (G, H) muestran su propio estado aunque no haya
    DVIR.
- **Avisos**: un conductor es infractor si su Pre-trip o Post-trip falta o dura
  menos de 15 min (se mantiene la regla de NO DVIR). El correo lista esas
  inspecciones en vez de la duración del DVIR.

### Añadido
- **`core/pretrip.py`**: parser del custom report de HoS (Driver Name, HoS
  Status, Start/End Time, Remark) → duración de Pre/Post-trip por conductor.
- En **Crear DVIR Report**, un tercer archivo opcional: el CSV de Pre/Post-trip
  (se empareja por día y empresa, como el de actividad; si falta, esas filas
  quedan como NO PRE-TRIP).

## [0.16.0] - 2026-06-07

### Añadido
- **Sección PM (mantenimiento preventivo)** para camiones: combina el último PM
  (export de Fullbay en `backend/pm.local.csv`, gitignored) con el **odómetro
  actual en vivo de Samsara** (`obdOdometerMeters`, fallback gps) para calcular
  el **próximo PM (cada 20.000 millas)** y las millas restantes.
  - Tabla ordenada por urgencia: Last PM, Current (con fuente), Next due,
    Remaining, **barra de progreso** y **Status** (Overdue / Due soon / On track
    / Never performed / No odometer).
  - **Gráfico de torta** "PM status" con la distribución de la flota (On track /
    Overdue / Upcoming / Never performed) + leyenda con conteo y %.
  - **Overrides manuales** por unidad (telemetría/Fullbay errados), editables
    desde la UI y persistentes (`pm_overrides.local.json`, gitignored): override
    de **millaje actual** y/o **del último PM**, y **excluir** unidades (con
    sección para re-incluir). Prioridad del millaje: override → Samsara → reporte.
  - Endpoints: `GET /api/pm`, `POST /api/pm/override`, `POST /api/pm/exclude`.
  - `samsara.vehicle_odometers()` lee `/fleet/vehicles/stats`.
- Componente `PieChart` (SVG, sin librería).

## [0.15.1] - 2026-06-07

### Añadido
- **Roster: emails de los conductores** desde un **snapshot local** de la hoja
  `Driver info` (no se lee en vivo en cada carga). `core/driver_contacts.py`
  guarda `driver_contacts.local.json` (gitignored, PII); botón **"Sync emails"**
  para re-sincronizar a demanda. Email cruzado por nombre normalizado.
  - **Email editable** por fila (override manual en `driver_emails.local.json`),
    con **prioridad** sobre el snapshot y que **sobrevive** a la sync — para
    nombres que no matchean o conductores ausentes en la hoja.
  - Endpoints: `POST /api/drivers/sync-contacts`, `POST /api/drivers/email`.
- **Settings → Archivo de unidades**: la lista de archivadas ahora tiene
  **búsqueda**, **paginación (50/página)** y un **selector** ("+ Archive units")
  para archivar varias unidades activas a mano desde Settings.

## [0.15.0] - 2026-06-07

### Añadido
- **Sección Fleet**: inventario en vivo de todas las unidades (Chaser + MCC)
  desde Samsara `/assets` — tipo (camión/trailer), empresa, make/model/year,
  VIN, patente y **defectos abiertos** por unidad. Filtros (empresa, tipo,
  búsqueda), orden, Export CSV y Refresh.
- **Sección Roster**: conductores **activos** desde Samsara `/fleet/drivers`
  (`GET /api/drivers`) — nombre, empresa, teléfono, licencia, username. Filtros,
  búsqueda, Export CSV.
- **Sección Settings** (botón al fondo del sidebar) — primera función
  configurable: **Archivo de unidades** (colapsable):
  - **Archivado manual** desde Fleet (oculta unidades sin uso/chassis).
  - **Auto-archivo por inactividad de DVIR**: archiva una unidad sin DVIR hace
    más de N días, leyendo `/fleet/dvirs/history` de Samsara (troceado en
    ventanas de ≤30 días). Configurable (on/off + días).
  - Lista de **archivadas** dentro de Settings con Unarchive / Keep active.
  - Persistencia en `app_config.local.json` (local, no versionado).
- **Lectura de DVIRs de Samsara** (`core/samsara.list_fleet/list_drivers` +
  `/fleet/dvirs/history`): un DVIR cubre el camión y su trailer enganchado.
- Flag **`trailer_dvirs`** por org en `samsara.local.json` (Chaser `true`,
  MCC `false`): los trailers solo se auto-archivan donde se les hace DVIR.

### Cambiado
- Auto-archivo y emparejado de DVIR por **id de asset** (no por nombre), para no
  confundir unidades con nombre repetido. Robusto ante fallos de la API (la
  flota nunca se vacía; si no hay datos de DVIR, no se auto-archiva).

## [0.14.0] - 2026-06-06

### Cambiado
- **Backend asíncrono** (`core/samsara.py`): pasó de `urllib` bloqueante a
  **`httpx.AsyncClient` + `asyncio`**. Los orgs (Chaser + MCC) y, dentro de cada
  uno, `reference-data` + `defects` se piden **en paralelo** (`asyncio.gather`)
  en vez de sumarse. Endpoints `/dvir/open-defects` y `/dvir/defect-stats` ahora
  `async def`. **Caché de reference-data** (assets + defect-types, TTL 15 min)
  compartida entre ambos endpoints, con lock por org. Flag **`?refresh=1`** para
  bustear el caché. Resultado: la carga de Defects bajó ~**4×** (≈9 s → ≈2.3 s).
  Nueva dependencia: `httpx` (en `requirements.txt`; `launch.bat` la instala).

### Añadido
- **Capa de carga en el frontend (TanStack Query)** en **todas** las páginas
  (Defects, DVIR, Avisos): caché + **stale-while-revalidate** (volver a una
  pestaña muestra los datos al instante y revalida en segundo plano).
  - **Skeletons** con shimmer en la primera carga (KPIs, gráficos, tablas).
  - **Barra de progreso** indeterminada arriba mientras hay un fetch.
  - Botón **Refresh** (Defects y DVIR) que re-consulta Samsara.
  - **Sin parpadeo** al cambiar el rango en Defects (`keepPreviousData`).
  - Respeta `prefers-reduced-motion`.

## [0.13.1] - 2026-06-06

### Cambiado
- **Diseño full-width** extendido a las páginas **Defects** y **DVIR** (clase
  `page-wide`, igual que Avisos): en resoluciones grandes usan todo el ancho
  disponible en vez del cap de 1140px. Las grillas internas ya eran fluidas, así
  que se adaptan solas.

## [0.13.0] - 2026-06-06

### Añadido
- **Samsara multi-org**: `samsara.local.json` ahora acepta `orgs: [...]` (un
  token por empresa, ya que Chaser y MCC son cuentas **separadas** en Samsara).
  Cada org puede fijar `company` (CHASER/MCC) para forzar la empresa de todas
  sus unidades. **MCC ahora se lee EN VIVO** junto con Chaser; el CSV de
  open-defects queda como fallback. Compatible con el formato viejo de un solo
  token en la raíz. Doc/ejemplo actualizados (`SAMSARA_SETUP.md`,
  `samsara.example.json`).

### Cambiado
- **Avisos / CC**: **Ryan Andrews** (`randrews@memphiscitycartage.com`) ahora va
  en copia en **todas** las terminales (vía `_ALWAYS_CC`, sin duplicar donde ya
  estaba). Miami mantiene a **Roberto Victorero** (`rvictorero@…`).
- **Avisos UI**: la página usa **todo el ancho** en resoluciones grandes
  (`page-wide` + `:has()` rompe el cap de 1140px); el **preview** del email pasó
  a ser un **panel sticky con scroll interno** (ya no estira la página) y las
  columnas quedaron balanceadas, con apilado correcto en pantallas angostas.

## [0.12.0] - 2026-06-05

### Añadido
- **Conexión EN VIVO con Samsara** (`core/samsara.py`): la pestaña Defectos lee
  los defectos abiertos directo de la API (`GET /defects/stream?isResolved=false`),
  resolviendo nombre + tipo de unidad por `/assets` (vehicle→camión,
  trailer/unpowered→tráiler) y la categoría por `/defect-types` (o **inferida del
  comentario** cuando el defecto no la trae). Solo lectura; token en
  `samsara.local.json` (gitignored). El endpoint `/api/dvir/open-defects`
  **prefiere Samsara** y **cae al CSV** si la API falla; las empresas fuera del
  org de Samsara (p.ej. MCC) siguen viniendo de su CSV.
- **Dashboard de Defectos por RANGO** (nuevo `GET /api/dvir/defect-stats?days=N`):
  KPIs y gráficos (Records, Open, Resolved, % Resolved, By status, Daily trend,
  By defect type, Top units) salen de los defectos **abiertos + resueltos
  creados en los últimos N días**, con **selector 7 / 30 / 90** (default **7**).
- **Panel «By unit type»** (camión vs tráiler) en lugar de «Top drivers» (la API
  de defectos no trae conductor).
- **Reporte PDF por unidad** (vista imprimible → «Download PDF» al expandir):
  muestra lo que escribió el driver y **propone una descripción/análisis**
  (severidad, ubicación expandida LFO/RFI…, acción recomendada), **agrupado por
  categoría**, con **todos los diagramas** de la unidad (Top/Front/Side o
  Top/Side) y **auto-ajuste a una hoja** (escala el contenido sin recortar).
- **Export masivo** («Export report»): modal para marcar/desmarcar unidades y
  bajar un PDF con **una hoja por unidad**.
- **Export de la lista** («Export list»): PDF liviano a **2 columnas** con las
  unidades y sus defectos, **sin diagramas**.
- **Conteo de repeticiones** (`reports`): los defectos repetidos muestran
  **«×N» / «Reported N times»** (en el panel y en el PDF).
- Soporte de **múltiples CSV** de defectos abiertos (`open_defects*.local.csv`,
  uno por empresa).

### Cambiado
- La pestaña Defectos diferencia **camión vs tráiler** de forma autoritativa
  (por tipo de asset en Samsara; por nombre/tipo de defecto en el CSV) y dibuja
  el diagrama correcto.
- `TruckDiagram` acepta una vista fija (`fixedView`) para renderizar todas las
  vistas en el PDF, sin el selector interactivo.

## [0.11.0] - 2026-06-05

### Cambiado
- **Formato del DVIR Report** (aplicado de forma consistente en los **3
  lugares**: Excel descargado, «Copy day» al portapapeles y la vista previa
  en la app):
  - **Fuente tamaño 15** en todo (Excel/copia).
  - **Todas las celdas centradas** vertical y horizontalmente (incluida la
    columna Driver, que antes iba a la izquierda).
  - Las filas **NO DVIR**: la celda «⚠ NO DVIR» se **fusiona de la columna D
    a la H**.
  - **Trl#** y **Distance (mi)** usan el mismo **relleno azulado** que las
    celdas vacías con guion.

### Añadido
- Diagrama del camión: **vista superior (top-down)** con **toggle Top / Side**
  (la lateral estilo Cascadia queda como alternativa).

## [0.10.2] - 2026-06-05

### Añadido
- **Logo / ícono de Fleet Tracker**: nuevo `favicon.svg` (squircle con gradiente
  índigo→cyan, ruta de rastreo + pin de ubicación) para la app/pestaña, e
  ícono `fleet-tracker.ico` multi-resolución para el acceso directo del
  escritorio. Generado con `backend/scripts/make_icon.py` (reutilizable).

## [0.10.1] - 2026-06-05

### Cambiado
- `launch.bat`: textos de marca renombrados de «DVIR Report Generator» a
  **«Fleet Tracker»** (banner de consola y título de la ventana del servidor).

## [0.10.0] - 2026-06-05

### Cambiado
- **Rediseño completo de UI (Modern SaaS)** y renombre de la app a
  **Fleet Tracker**: nuevo shell con **sidebar** (logo animado full-width +
  navegación con iconos + tema/conexión/versión al pie), paleta **índigo/
  violeta**, tokens de superficie más aireados, cards de radio mayor y sombras
  suaves, títulos más grandes. Tokens **semánticos de UI** (`--ui-*`)
  desacoplados de los colores Excel: el dashboard armoniza en claro/oscuro y la
  **vista previa del DVIR sigue calcando** el reporte exacto.
- **Logo animado** de Fleet Tracker (SVG): ruta de rastreo con pulso viajero,
  radar ping y partículas; respeta `prefers-reduced-motion`.
- Gráfico **«Por estado»** ahora ocupa el ancho (donut + barras de proporción
  con %). Colores de estado: **Safe = verde**, **Resolved = celeste**,
  **Unsafe = rojo**. Panel del camión balanceado (tarjeta centrada, más grande).
- **Toda la interfaz pasa al inglés.**

### Añadido
- **Defectos abiertos**: el «Summary by unit» admite **defectos abiertos** desde
  un export de Samsara (CSV local, `core/open_defects.py` + endpoint
  `/api/dvir/open-defects`): empresa por prefijo (MEM/MDW… → MCCI), dedup y
  filtrado de re-inspecciones. Botones **Chaser / MCCI / All** (reemplazan el
  selector de día), columna de conductor quitada, píldora **Open** para MCCI.
- Guía `backend/SAMSARA_SETUP.md` + `samsara.example.json` para conectar la API
  de Samsara (token read-only, `defects/stream?isResolved=false`).

## [0.9.1] - 2026-06-04

### Cambiado
- Diagrama del camión del panel por unidad **adaptado al tipo de unidad**:
  vista lateral estilo **Freightliner Cascadia day-cab** (capó aerodinámico,
  fairing de techo, parabrisas/espejo, tanque de combustible, escape,
  guardabarros y mud flap) para los **camiones**, y caja de carga con puertas
  traseras, tren de aterrizaje y tándem para los **tráilers**. Antes mostraba
  siempre un tractor + tráiler.
- Mapeo de defecto→zona **según el tipo**: en un tráiler «Doors» son las
  **puertas traseras** (antes caían en «cabina»); el tráiler ya no muestra
  motor/parabrisas/luces delanteras.
- Correo de Avisos: ahora se envía como **multipart (texto + HTML)** y el
  párrafo de contacto (Ryan Andrews) va en **negrita** en la versión HTML.

## [0.9.0] - 2026-06-04

### Añadido
- Tabla «Resumen por unidad»: cada unidad es **clickeable** y despliega un
  **panel ancho**. A la derecha, un **diagrama del camión** (vista lateral,
  tractor + tráiler) dividido por zonas (motor, parabrisas/espejos, luces
  delanteras/traseras, cabina, neumáticos, frenos, suspensión, tráiler): las
  zonas **con defectos** se marcan en **rojo sutil** y las **sin defectos** en
  **verde**, con insignia de cantidad y tooltip. A la izquierda, la **lista de
  defectos agrupados** mostrando cuántas veces reportó el conductor cada uno
  (`×N`), ordenada por frecuencia.
- Se filtran las re-inspecciones sin novedad (`Previous inspection`,
  `Nothing changed`, `Same issues/status`…) para contar solo defectos reales.

## [0.8.0] - 2026-06-04

### Cambiado
- Pestaña «Defectos» rediseñada como **panel**: tarjetas KPI (registros,
  Unsafe abiertos, resueltos, % resuelto, unidad más afectada); gráficos SVG
  propios (desglose por estado, tendencia diaria, tipo de defecto); rankings
  de top unidades y conductores (click para filtrar); y tabla **«Resumen por
  unidad»** consolidada —una fila por unidad, sin duplicados—, **ordenable**
  por unidad/empresa/defectos, con **selector de día / Global** y **export**
  (copiar y CSV). Los análisis se centran en incidencias (Unsafe + Resolved);
  el conteo de defectos por unidad usa defectos distintos.
- Gráfico de tendencia del **Panel DVIR**: ahora **barras legibles con el
  número por día** (incidencias NO DVIR + Unsafe), en vez de la combinación
  línea de % + barras apiladas.

## [0.7.1] - 2026-06-04

### Cambiado
- Plantilla del aviso: «it is a DOT REQUIREMENT» pasa a «it is a Company
  requirement».

## [0.7.0] - 2026-06-04

### Añadido
- Sección «Avisos» en el menú: detecta conductores con `NO DVIR` o con un
  DVIR de menos de 15 min (camión o tráiler) en un bloque del DVIR Report,
  arma el aviso por correo al conductor y calcula el CC según su terminal
  (CHASER / MDW Chicago / MEM Memphis / ATL Atlanta / SAV Savannah / MIA
  Miami). El email se cruza con la hoja «Driver info»; los conductores que
  no coinciden o sin terminal reconocida quedan en una lista «a revisar»
  en lugar de mandarse mal.
- Lectura **en vivo** del «DVIR Report» desde Google Drive con una cuenta de
  servicio (Sheets API, solo lectura): auto-detecta las hojas del mes más
  reciente (`CHASER N`, `MCC N`) y la hoja `Driver info`. Si no hay
  credenciales, usa un snapshot de respaldo (modo demo).
- Envío real por **Gmail** (SMTP + App Password) con la plantilla oficial de
  Safety/Maintenance, saludo por nombre de pila y lista de unidades
  infractoras. Modo simulado (`dry_run`) y prueba de envío a uno mismo
  (`scripts/test_email.py`).
- Configuración local **no versionada** (`avisos.local.json` +
  `service_account.json`), plantilla `avisos.example.json` y guía de setup
  `backend/AVISOS_SETUP.md`. Endpoints `/api/notify/blocks|scan|send`.

### Cambiado
- Umbral de duración de un DVIR: pasa de 10 a **15 minutos**. Por debajo se
  marca en rojo en el Excel y en la vista previa, y dispara aviso por correo.
  Centralizado en `engine.MIN_DURATION_SECONDS`.

### Seguridad
- El snapshot de respaldo (`sample_data.py`) se anonimiza: los emails y
  teléfonos reales de los conductores viven solo en la planilla de Drive,
  no en el repositorio.

## [0.6.0] - 2026-06-03

### Cambiado
- Columnas del bloque del DVIR Report: se eliminan `DOT Issues trk`,
  `DOT Issues trl`, `Fullbay trk` y `Fullbay trl`; en su lugar se añade
  `Distance (mi)` (lado camión) con las millas recorridas ese día según
  el CSV de actividad. Los bloques antiguos guardados en la base de
  datos se siguen mostrando, dejando la nueva columna vacía.

## [0.5.0] - 2026-05-18

### Añadido
- Sección «Defectos» en el menú: captura los defectos reportados en los
  DVIR (vehículo, tráiler, notas de mecánico) y los muestra en una tabla
  filtrable por empresa, estado y unidad.
- Tarjeta «Tendencia del mes» en el panel DVIR: gráfico de % flota SAFE
  e incidencias (NO DVIR, Unsafe) por día.
- Ficha de conductor: al hacer clic en un conductor del top sin DVIR se
  abre un modal con su cumplimiento, días registrados y defectos.
- Endpoints `/api/dvir/defects`, `/api/dvir/trends`, `/api/dvir/drivers`.

### Cambiado
- El bloque generado replica el formato del DVIR Report: duraciones
  < 10 min en rojo y ≥ 10 min en verde, celdas sin info con «-» azul.
- Las filas del bloque se ordenan por unidad (Trk#), no por conductor.
- DOT Issues trk/trl fijo en «NO» (verde); Fullbay trk «YES» (verde) y
  Fullbay trl vacío.

## [0.4.0] - 2026-05-18

### Añadido
- Base de datos local (SQLite): cada bloque generado se guarda con sus
  métricas y los conductores del día.
- Panel DVIR: barra de menú horizontal y página en grilla responsive con
  (1) últimos informes ordenables por reports, NO DVIR, Unsafe y % SAFE,
  (2) top de conductores sin DVIR del mes, (3) vista previa del bloque.
- Modal «Crear DVIR Report»: subes los CSV, revisas el emparejado con el
  tag de día editable por fila, y se genera.
- Endpoints `/api/dvir/recent`, `/api/dvir/missing`, `/api/dvir/blocks`.

### Cambiado
- Se unifican «Informe diario» y «Lote mensual» en un único flujo
  «Crear DVIR Report» (un día es un lote de un bloque).

## [0.3.0] - 2026-05-18

### Añadido
- Procesamiento por lote multi-día / multi-empresa: se suben todos los
  CSV del periodo y se genera un único workbook con una hoja por
  empresa y los bloques diarios apilados.
- Emparejado automático DVIR↔actividad por día y empresa, deducido del
  nombre del archivo (fecha/empresa) y del contenido (prefijos de
  unidad), con una tabla editable para revisarlo antes de generar.
- Interfaz con pestañas: «Informe diario» y «Lote mensual».
- Endpoints `/api/batch/analyze` y `/api/batch/generate`.
- Aviso automático cuando un bloque sale con más filas «NO DVIR» que
  conductores con DVIR (señal de un CSV de DVIR incompleto).

### Cambiado
- El umbral de millas para «NO DVIR» queda fijo en 30; se elimina el
  campo editable de la interfaz.

## [0.2.0] - 2026-05-18

### Cambiado
- Reescritura completa a app web local: backend FastAPI + frontend
  React/TypeScript, sustituyendo la app de escritorio Tkinter.
- El motor de cruce se refactorizó en módulos (`core/duration`,
  `core/engine`, `core/excel`).

### Añadido
- Interfaz responsive con carga de archivos por arrastrar y soltar.
- Vista previa en pantalla del bloque diario antes de descargar el Excel,
  con colores de estado y celdas fusionadas por conductor.
- API REST: `/api/health`, `/api/roster`, `/api/reports`,
  `/api/reports/{id}/download`.
- `launch.bat`: instala dependencias, compila la interfaz y abre la app.

### Eliminado
- App de escritorio Tkinter (`gui.py`, `dvir_report.py`) — disponible en
  el tag `v0.1.0`.

## [0.1.0] - 2026-05-18

### Añadido
- App de escritorio (Tkinter) que genera el informe DVIR diario.
- Motor de cruce: consolida DVIR por conductor, suma duraciones y usa
  el estado del DVIR más reciente.
- Detección automática de "NO DVIR" cruzando el CSV de actividad de
  Samsara con el roster camión→conductor.
- Exportación a Excel con el formato del informe (colores de estado,
  fusión de celdas por conductor).
- Roster inicial `roster.csv` con 22 camiones.

[No publicado]: https://github.com/AdriGh/DVIR-Report-Generator/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/AdriGh/DVIR-Report-Generator/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/AdriGh/DVIR-Report-Generator/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/AdriGh/DVIR-Report-Generator/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/AdriGh/DVIR-Report-Generator/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AdriGh/DVIR-Report-Generator/releases/tag/v0.1.0
