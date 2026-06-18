# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es/1.1.0/)
y el proyecto usa [Versionado Semántico](https://semver.org/lang/es/).

## [No publicado]

### Añadido
- **Alembic** (H6 fase 2): migraciones de esquema versionadas. `backend/alembic/`
  con `env.py` que toma la URL del motor de `app.config` (Postgres en prod,
  SQLite en dev) y `Base.metadata` para `--autogenerate`; migración inicial
  con todo el esquema. Dep `alembic` en requirements. Guía en
  `backend/DATABASE.md`.

### Cambiado
- `db.py`: la creación del esquema se movió a `init_schema()`. SQLite (dev)
  sigue con `create_all` + migraciones aditivas; en **Postgres el esquema lo
  maneja Alembic** (`alembic upgrade head`), ya no `create_all`. Importar
  `app.db` con `FLEET_SKIP_DB_INIT=1` da la metadata sin tocar la base.

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
