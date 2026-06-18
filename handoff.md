# HANDOFF — Fleet Tracker

Documento de traspaso: objetivo, estado, investigación y siguiente paso.
Actualizado: 2026-06-14.

## Objetivo

Convertir Fleet Tracker (app local FastAPI + React de cumplimiento de
flota para Chaser/MCC) en un **producto white-label comercializable**
para carriers de 10-150 trucks: reemplazar Fullbay (taller), TrackFleet
(temperaturas) y complementar al ELD (Samsara/Motive) sirviéndonos de su
información. Diferenciales: sin contrato, precio plano, bilingüe
EN/ES de back-office, y UX muy superior (cinemática, personalizable).

**FOCO DE PRODUCTO (decidido jun-14, detalle en `PRODUCT.md`):**
profundidad, no amplitud. Especializarse en el stack **Taller + Cold Chain**
— el moat es su **intersección** (Fullbay no toca reefers; Samsara/TrackFleet
no tienen taller). Núcleo a profundizar: WO + parts/PO + escáner AI + perfil
de unidad + PM/DOT + Cold Chain con control OEM + **puente reefer→work order**
+ bilingüe de piso de taller. Soporte (se mantiene, no protagoniza): DVIR,
Live Map, notices. **Removido (jun-14):** Loads/dispatch/payout (otro
mercado) — borrado de UI + rutas + modelos (`Load`/`LoadStop`, `LoadsPage`,
grupo nav "Dispatch"). El **roster de conductores se conserva como "Driver
Compliance"** dentro de Maintenance & Compliance (lo usa el tablero de
mantenimiento para mapear truck→conductor; `TmsDriver` + `core/tms.py`
quedan solo-drivers).

**PUENTE reefer→WO (CONSTRUIDO jun-14, el "workflow asesino" del foco):**
`core/reefer_wo.py` `sync(snapshot, min_severity)` crea work orders
IDEMPOTENTES desde los fault codes de los reefers (Lynx/TK/Traccar), con
unidad + código + contexto (setpoint/return/modo) en el complaint y un
marcador `[rf:<code>]` para deduplicar (no duplica mientras haya una WO
viva para el mismo unit+code). Saltea códigos no-mecánicos (`no_data`,
`low_battery`) y datos demo. Lo dispara el loop de `core/alerts.py` con la
regla `reefer_fault_wo` (Settings → Fleet alerts; severidad mínima
configurable); cada WO nueva genera un AlertEvent en el feed
(`record_wo_events`). La WO sale con `source='reefer'` → badge "from reefer
fault" en WorkOrdersPage. Verificado: py_compile + smoke de la lógica
(elegibilidad/dedup/demo) con `workorders` stubbeado; front tsc/vite verdes.
Refinamiento posible: saltear unidades muteadas (hoy el bridge ignora el
mute, que es solo para notificaciones).

## Repos y archivos

- Repo: `AdriGh/DVIR-Report-Generator` (GitHub, privado) en
  `C:\Users\adrii\DVIR-Report-Generator\`.
- Backend FastAPI: `backend/app/` (API en `api/routes.py`, dominio en
  `core/*.py`, modelos SQLite en `db.py`, auth HMAC en `core/auth.py`,
  server 127.0.0.1:8765). Frontend React 19 + Vite: `frontend/src/`
  (vistas en `views/`, API client `api.ts`, estilos `index.css`).
- Datos sensibles NO versionados (gitignored): `*.local.json`,
  `*.local.csv`, `service_account.json`, `dvir.db`. JAMÁS commitearlos.
- Docs vivos: `docs/ROADMAP-G.md` (rework anterior, completado),
  `docs/ROADMAP-H.md` (rework actual), `docs/STRATEGY-data.md`
  (investigación de mercado/datos completa), `docs/map-debug-plan.md`
  (postmortem del bug del mapa), `PRODUCT.md` (registro de producto
  impeccable: personalidad Confiable · Potente · Premium).

## Estado actual (qué hay construido)

**v1.3.0 (H3-C invoice), v1.4.0 (H4 RBAC) y v1.5.0 (H5 reefer/Traccar)
están MERGEADAS a main, tagueadas y PUSHEADAS a origin (jun-13/14).
`main` sincronizado con `origin/main`.**

**v1.5.0 — H5 reefer tracking real (capa de software):** `core/traccar.py`
ingiere reefers reales de un Traccar self-host; Cold Chain prefiere
Traccar → Samsara → demo; Traccar en Connectivity; guía
`backend/REEFER_SETUP.md`. **El piloto físico de hardware queda pendiente
del usuario.** **HALLAZGOS de research (2 workflows verificados):** la flota
son **Carrier X4 (2022, trailers CIMC)** con **telemetría Lynx Fleet de
fábrica**. TrackFleet (white-label de Journey) parece usar **trackers
commodity de sonda** (la pantalla muestra HW IDs, dos temps, IN1/IN2,
Power en V/%). **NO existe forma aftermarket self-host de CONTROLAR el
setpoint de un Carrier X4** (controlador propietario, sin reverse-eng,
Traccar sin comando de reefer; los devices self-host son solo-lectura). El
control real = OEM **Carrier Lynx** ("Two-way Monitor & Control", ya de
fábrica en los X4 2022) o plataformas cerradas pagas (Viachain/ORBCOMM,
CarrierWeb, Blue Tree R:Com). **Como un tracker de sonda NO PUEDE controlar
un X4, el "control" de TrackFleet es casi seguro un UMBRAL DE SOFTWARE, no
control real.** PENDIENTE: respuesta de **"Dario"** (instalador de
TrackFleet) a 4 preguntas (modelo del device; cableado-al-controlador vs
sonda; ¿los devices/SIMs son nuestros o de Journey?; control real vs
umbral) + el test físico (cambiar setpoint en TrackFleet → mirar la pantalla
del reefer). **DOS CAMINOS:** (A) soltar control, self-host monitoreo más
rico (Teltonika + cable RS232 de Carrier → Traccar, ~$30-60 una vez + $0/mes
— confirmar que lee el X4); (B) mantener control activando **Lynx directo**
(corta el markup de TrackFleet; el hardware Lynx ya está en los X4 2022).
**Se generó un PDF guía en el Escritorio del usuario** (`Fleet-Tracker-Cold-
Chain-Guia.pdf`, 13 págs; generador en `%TEMP%\make_reefer_pdf.py`). H4.2
diferido: sidebar por rol, gating por botón, billing por asiento.

**ACTUALIZACIÓN jun-14 — research Lynx Fleet + principio de soberanía del
dato (cambia la conclusión vieja de reefer):** se leyó el brochure oficial
**Carrier Lynx Fleet (62-12176 Rev. C ©2025)** y la doc de integración
pública. HALLAZGO que corrige el handoff anterior: el **Lynx API ES
BIDIRECCIONAL e integrable en sistemas propios** (*"two-way command APIs
that enable remote control… can be integrated in your own systems"*) — NO
es solo-lectura. O sea: no hay control *aftermarket*, pero el **API OEM
directo SÍ controla** (setpoint/modo/IntelliSet/defrost/power) y va **por
nosotros, no por Samsara**. Credenciales (**Client ID + Client Secret +
API Key**, estilo OAuth2) las emite el **dealer Carrier** al activar la
suscripción; portal dev en `dev1.lynx.carrier.com` /
`api.tta.lynxfleet.carrier.com`. El módulo Lynx **viene de fábrica en los
X4 2022** (la flota del cliente YA lo tiene). 3 tiers: Monitor (lectura) /
Monitor+Control (control real) / Monitor+Enhanced Control (+ data
downloads, IntelliSet upload, OTA). **Precio NO público, cotizado por
dealer.** **PRINCIPIO DE ARQUITECTURA fijado por el usuario — soberanía
del dato por dominio:** el **power unit/HoS/fuel** se consume del **ELD que
el cliente eligió** (Samsara/Motive); el **reefer/cold chain es NUESTRO y
directo** — vía OEM (Lynx/Carrier o ConnectedSuite/TracKing de Thermo King)
o aftermarket (Traccar) — **nunca a través de un tercero como Samsara**
(esquiva el API-gating de Samsara). **TIERING decidido:** *Basic* =
monitoreo de temps + setpoint como **umbral de alerta** (no control real);
*add-on premium "Cold Chain Control"* (gateado por la suscripción de dealer
Carrier o Thermo King) = **cambio remoto real de temperatura** vía el API
OEM. **CAMBIO en lo construido:** la prioridad runtime de Cold Chain pasa
de `Traccar → Samsara → demo` a **`Lynx (OEM directo) → Traccar
(aftermarket) → demo`** (Samsara sale como fuente de reefer). Bajado a
`docs/STRATEGY-data.md` (principio + tiering + Jugada revisada).
**ENTREGADO jun-14 (boceto completo, verificado: py_compile + smoke; front
tsc/vite/eslint verdes):** adapters OEM **`core/lynx.py`** (Carrier) y
**`core/thermoking.py`** (Thermo King TracKing/ConnectedSuite) — espejos de
`core/traccar.py`: OAuth2 client-credentials, ingesta a la forma ReeferUnit
(setpoint/supply/ambient/modo/alarmas REALES) y **control two-way gateado
por tier** (`set_setpoint`/`set_mode`/`defrost`/`power`; `monitor` =
read-only → error claro sin pegarle al API). `reefer.py` reordenado a
**Lynx → Thermo King → Traccar → demo** (Samsara fuera) y con **despacho de
control por prefijo** (`lynx-`/`tk-`). Endpoints `POST
/api/reefer/{id}/setpoint` y `/command` (RBAC `fleet.edit`, no abiertos a
viewer). Cards en Connectivity (test+configure) para ambos OEM. **UI de
control** en `ReeferPage` (panel setpoint + modo + defrost, gateado por
`can_control` + `fleet.edit`, badge OEM-aware, chip CTRL, toasts; power
on/off omitido a propósito por seguridad). Guías `backend/LYNX_SETUP.md` y
`backend/THERMOKING_SETUP.md` + `*.example.json`. **PENDIENTES (solo del
usuario, para activarlo de verdad):** (1) cotización + credenciales del
dealer/proveedor (Carrier dealer · `tracking@thermoking.com`) y confirmar
en qué tier el API expone control — preguntas en
`docs/reefer-dealer-questions.md`; (2) confirmar contra el portal los
**paths/campos exactos del JSON** (centralizados en `lynx.py`/
`thermoking.py` como defaults overrideables + `_pick()`) y la auth de TK
(se asume OAuth2; puede ser API key sola).

**v1.4.0 — H4 RBAC real:** 5 roles (+`safety`), scopes finos con enforcement
en el middleware (`_scope_for`), PII enmascarada server-side, gating en la UI
(`usePerms`/`can`). Verificado con E2E aislado.

**v1.3.0 — H3-C:** invoice/estimate imprimible. Incluye H3-C
(estimate/invoice imprimible de Work Orders: print-to-PDF + email/SMS,
identidad de taller + Bill-To + numeración en org_config, campos
invoice_number/po_number/authorizer/shop_invoice, un WO por unidad en
invoices multi-unidad), mejoras del escáner (marcas de cadena
Love's/Speedco/TA/…, total que cuadra con el invoice vía bloque resumen,
parser columnar), title=campaña, textareas autosize, sidebar colapsado
más prolijo, y fix de `launch.bat` (libera el puerto 8765 antes de
arrancar — un server viejo en memoria seguía sirviendo código viejo).
**Próximo: REWORK H4 (RBAC real, 5 roles con `safety`).**

v1.2.1 publicada (tag en main, jun-12; `main` sincronizado con
`origin/main`): app completa con auth real (roles
admin/dispatcher/mechanic/viewer), onboarding wizard, branding
white-label (org.local.json), Dashboard, Live Map (MapLibre +
OpenFreeMap + POIs propios + copy-coords estilo Panda), DVIR diario,
Defects, Notices (email real + SMS Twilio opt-in), Fleet, PM Tracker,
DOT Inspections, Cold Chain (demo si no hay reefers en Samsara), Work
Orders (pipeline UNIQ + escáner AI de invoices multi-complaint + perfil
de unidad estilo Fullbay), Parts & Vendors (catálogo + tarifa de labor),
TMS-lite (Drivers/Loads con payout), Terminales dinámicas, Settings
(Company, Users, Alerts, Connectivity multi-ELD con test de
credenciales, Roster con PII enmascarada). Sidebar agrupado con riel
colapsable y flyouts por grupo (estilo Samsara). Tracking en vivo desde
los tokens Samsara de Chaser y MCC (100 vehículos, HoS clocks, fuel/DEF).

### Qué cambió (jun-12, publicado en v1.2.0 + v1.2.1)

- **v1.2.1 — Riel colapsado con flyouts** (estilo Samsara): al colapsar
  el sidebar cada grupo queda como icono y, al hacer **hover** (no
  click), despliega un flyout con sus ítems navegables (icono + estado
  activo). El flyout escapa del scroll (`overflow: visible` en
  colapsado) con un puente transparente para no cerrarse al cruzar el
  gap; respeta `prefers-reduced-motion`. El modo expandido (lista con
  labels) se conserva como toggle.
- **v1.2.0 — Terminales dinámicas** (Settings → Terminals, solo admin):
  `core/terminals.py` (store `terminals.local.json`, gitignored) con CRUD
  + asignación de flota por terminal. Resolución: pin manual → prefijo
  más largo (carácter siguiente no-letra) → empresa MCC → primera
  terminal; endpoints `GET/POST/DELETE /api/terminals` +
  `POST /api/terminals/assign`. `frontend/src/terminal.ts` reescrito como
  hook `useTerminals()` (TanStack Query, fallback de fábrica
  CHASER/MEM/MDW/MIA/GA). Los filtros de terminal en Fleet, Defects, PM,
  DOT y Work Orders salen de esta config (chips solo si hay >1).
- **v1.2.0 — H3-A Catálogo de Partes + Vendors** (estilo Fullbay, costo
  **interno sin markup**): tablas `vendor`/`part` en db.py, `core/parts.py`
  (CRUD + guards: dedup de part#, borrar vendor desvincula sus partes),
  rutas `/api/vendors` y `/api/parts`, `views/PartsPage.tsx` (pestañas
  Parts/Vendors). Las líneas de Work Order autocompletan desc+costo
  eligiendo un part# del catálogo (`part_number` en la línea).
- **v1.2.0 — H3-B Tarifa de labor**: `org_config.labor_rate` ($/hr,
  editable en Settings → Company); las líneas de labor del WO se costean
  solas con esa tarifa.
- **v1.2.0 — Lote UX Fullbay**: sidebar agrupado "Maintenance &
  Compliance" (Fleet/PM/DOT/WorkOrders/Parts); fix de navegación desde el
  perfil de unidad (`navigate()` cierra `profileUnit` al cambiar de
  sección); modal New WO fluido (`min(--modal-max, 100vw-32px)`) +
  `fullHeight`→`.modal.is-tall` con cuerpo scrolleable; contraste
  theme-aware (`color-mix`) en stat cards y pills de PM/DOT.
- **v1.2.0 — Escaneo multi-complaint**: `docscan.py` reescrito —
  `WoExtract.complaints[]` {unit, mileage, detail, is_pm} + vendor/ciudad/
  estado/invoice#/fecha compartidos; heurístico sin IA reescrito para el
  layout real de invoices (headers de unidad arriba, datos abajo:
  `_find_units`, multi-unidad, `_build_complaints` rutea por keyword
  tire→trailer / PM→tractor). En el modal, el complaint que no matchea la
  unidad del WO se marca "different unit" y se borra (confirm si quedan
  mezclados); se quitó el campo Issue title (se deriva de la 1ª línea).
  Generador del PDF imprimible del WO para la yarda MDW en
  `backend/scripts/make_wo_form.py` (dev-only PyMuPDF).
- **Review adversarial** (workflow ~24 agentes): 10 bugs confirmados → 8
  arreglados (año-como-unidad, millaje=eco del nº de unidad, ruteo de
  complaints, fecha inválida 13/45, línea en blanco espuria, confirm
  mismatch, borrar última terminal/prefijo duplicado, picker des-pinea
  archivadas, filtro WO pegado); 2 minor no-arreglados a propósito.

### Qué cambió (jun-11/12, publicado en v1.1.0)

- **Live Map arreglado** (causa raíz: grid sin `grid-template-rows`, el
  canvas heredaba 10,540px → borroso + "Groenlandia"; fix 4 líneas CSS,
  verificado con Playwright headless; harness en `~/map-test/`).
- **Logo**: favicon.svg + fleet-tracker.ico redibujados a la marca
  actual (badge rojo + flecha); make_icon.py actualizado.
- **Toda la UI al inglés** (~310 strings, 5 agentes; comentarios de
  código quedan en español; valores comparados/almacenados intactos).
- Password del admin `adri` restablecida a temporal (usuario debe
  cambiarla en Settings → Users).
- **H3b COMPLETA Y VERIFICADA — WO↔campañas + modal nuevo**: (1) campo
  `campaign` en work_order (migración: is_pm=1 → campaign='pm'); select
  de campaña (nombres Fullbay) en crear y en el drawer; HOOK al
  facturar: crea el maint_record de la campaña (fecha=service_date,
  millas=mileage|pm_miles, notes="WO #id: title") y el perfil
  Components & PMs se actualiza solo — IDEMPOTENTE (busca "WO #id:" en
  notas; verificado que des-facturar/re-facturar no duplica). (2) Modal
  New work order a DOS COLUMNAS (width 1120, responsive <1000px):
  preview del documento AL LADO del form (img u <iframe> para PDF vía
  objectURL, sticky), dropzone arriba del preview. (3) Cantidades del
  escaneo ARREGLADAS: WoLineExtract ganó `total`, prompt reforzado
  (columna QTY/EA, math qty×unit=total) y _normalize reconcilia
  qty=total/unitario si no cuadra (caso Loves 39×$3.51=$136.88
  verificado offline y E2E: el scan real devolvió qty 2/2/1/3.5
  correctas); Textract pasa PRICE como total al mismo reconciliador.
  (4) Líneas del modal EDITABLES (kind/desc/qty/costo por fila, quitar,
  "+ Add line" manual); typo record unit '2255' borrado a pedido.
- **H3a COMPLETA Y VERIFICADA — perfil de unidad estilo Fullbay**:
  `views/UnitProfilePage.tsx` (se abre clicando una fila de Fleet; App
  state profileUnit) con 4 pestañas: (1) **Components & PMs** =
  campañas por unidad — catálogo en maint.CAMPAIGNS: pm (label por
  make: "DD13/DD15" Freightliner / "ISX" International, vence por
  millas) y dot (365d) DEFAULT; kingpins (365d), dpf y clutch (solo
  registro) agregables/quitables por unidad (unit_settings
  'campaigns'); cada campaña con last done/next due/status pill +
  "Record done" (modal → maint_record, kinds ampliados) + historial;
  (2) **Active Services** = WOs no facturadas agrupadas por status
  estilo Fullbay; (3) **Service History** = WOs invoiced con Edit
  (drawer) y Delete; (4) **Attachments** = documentos de la unidad
  (pm_copy/dot_copy/cab_card/registration/other) con MULTI-UPLOAD
  (varios archivos de un saque, drag&drop), download autenticado por
  blob y delete; tabla `unit_doc` + archivos en backend/uploads/
  (gitignored). Header con 3 stat cards (costo 12m de WOs invoiced,
  servicios activos, odómetro vivo + PM remaining). PIPELINE: estado
  **closed ELIMINADO** (migración closed→invoiced en db._migrate;
  invoiced es terminal); WOs ahora se pueden EDITAR inline (title/
  complaint en el drawer) y ELIMINAR (DELETE /workorders/{id} +
  botón con confirm). WoDrawer/STATUS_META/PIPELINE exportados de
  WorkOrdersPage y reusados. Smoke E2E verde con la unidad real
  CF2255 (campañas con el PM record real del usuario, multi-upload
  2 archivos, 0 pageerrors; datos de prueba limpiados). NOTA: existe
  un maint_record con unit "2255" (typo del usuario, sin prefijo CF)
  — ofrecido borrarlo.
- **H2.5b**: cuarto motor en docscan: **AWS Textract AnalyzeExpense**
  ($0.008/página, el grado comercial elegido para el lanzamiento).
  boto3 (requirements), `_scan_textract` (PDF→PNG por página vía
  pypdfium2, fotos directas con recompresión si >9.5MB; merge multi-
  página), `_map_expense` (SummaryFields→vendor/fecha/invoice#,
  LineItemGroups→líneas con UNIT_PRICE o PRICE/qty derivado) + overlay
  heurístico para campos de flota (unit/odometer/complaint/is_pm)
  sobre los Blocks de texto. Ping = STS GetCallerIdentity (gratis).
  Resolución "auto": textract si hay creds AWS > anthropic si hay key
  > ollama local. Mapper unit-testeado offline con respuesta sintética
  (deriva 332.50/3.5=95/hr correcto); errores ClientError mapeados a
  mensajes limpios (creds inválidas, falta permiso
  textract:AnalyzeExpense, doc ilegible, throttling). PENDIENTE DEL
  USUARIO: crear cuenta AWS + IAM user con textract:AnalyzeExpense +
  pegar access key en Settings → Connectivity (mientras tanto sigue
  en Ollama local gratis, verificado post-cambio).
- **H2.5 COMPLETA**: escáner AI de documentos en Work Orders + drawer
  a 760px. `core/docscan.py` con proveedores elegibles en
  `backend/docscan.local.json` (gitignored; provider auto|ollama|
  anthropic, default auto = anthropic si hay api_key, si no OLLAMA
  LOCAL GRATIS — decisión del usuario: no quiere pagar API):
  (a) **Ollama local** (default): POST /api/chat a 127.0.0.1:11434 con
  `format=WoExtract.model_json_schema()` (salida estructurada nativa de
  Ollama), modelo `qwen2.5vl:7b` (~6 GB, corre en la RTX 2060 SUPER),
  instalado vía winget Ollama.Ollama; ping = GET /api/tags (verifica
  modelo pulled). (b) **Anthropic** (opcional, pago): messages.parse()
  + Pydantic, modelo claude-opus-4-8; ping = models.retrieve (no
  factura). Schema compartido WoExtract (unit, service_date, mileage,
  title, complaint, mechanic, vendor, invoice_number, is_pm, lines
  part|labor qty/unit_cost). PDFs: capa de texto vía pypdf primero
  (digitales) → si es escaneado, render a PNG con pypdfium2 (licencia
  permisiva, NO PyMuPDF/AGPL) → visión. Deps nuevas: anthropic, pypdf,
  pypdfium2 (requirements + launch.bat). Endpoint POST
  /api/workorders/scan (multipart, máx 20 MB). Provider id "docscan"
  en Settings → Connectivity (Configure: provider/ollama_model/
  api_key/model + Test). Frontend: dropzone en New work order que
  autollena el form, previsualiza líneas removibles y las agrega al
  crear (source='scan'); el toast muestra el motor usado. TERCER
  nivel: `_scan_heuristic` (regex sobre capa de texto, sin AI, cero
  instalación) como fallback automático cuando el proveedor AI no está
  disponible y el PDF es digital — extrajo TODO correcto del invoice
  de prueba. VERIFICADO E2E EN LA MÁQUINA DEL USUARIO: Ollama 0.30.6
  instalado vía winget + qwen2.5vl:7b (6.0 GB) pulled; scan del
  invoice PNG por visión local = extracción correcta (unit CF2250,
  fecha, 451,963 mi, 4 líneas part/labor con qty/costos exactos;
  vendor/invoice# los pierde la visión 7B pero los caza el heurístico
  en PDFs). Tiempos en la RTX 2060 SUPER: primera corrida ~2m50s
  (carga del modelo a VRAM), corridas calientes ~10s. Contexto
  industria (verificado): Textract AnalyzeExpense $0.008/pág, Azure
  Document Intelligence $10/1k págs con F0 gratis 500 págs/mes — los
  SaaS pagan por página y lo esconden en la suscripción; nuestro
  pitch: "invoice scan incluido, sin costo por documento".
- **H2 COMPLETA Y VERIFICADA**: Work Orders con pipeline secuencial
  open → assigned → in_progress → completed → invoiced → closed.
  Backend: columnas nuevas en `work_order` (mileage, service_date,
  invoiced_at, waiting_parts como FLAG; migración aditiva `_migrate()`
  en db.py, los `waiting_parts` viejos pasan a in_progress+flag); gates
  en `workorders.update_wo` (assigned exige mecánico, invoiced exige
  total>0, retroceder deshace sellos; ValueError → 400 con el motivo
  textual); hook PM ahora dispara en completed O posterior.
  `core/telegram_notify.py`: bot de Telegram al group chat del taller
  (telegram.local.json, dry_run DEFAULT true, notify_statuses default
  ["assigned"], test getMe sin enviar; en Settings → Connectivity con
  Configure+Test; guía backend/TELEGRAM_SETUP.md + telegram.example.json).
  El PATCH /workorders devuelve `telegram` cuando notificó. Frontend:
  StageBar estilo UNIQ (chevrones clip-path, hover previsualiza el
  camino, clic multi-salto), form del jefe (unit/date/mileage con botón
  Current/issue), toggle "Waiting for parts", chip de fecha de invoice,
  6 KPIs, toasts de gate y de Telegram. Smoke Playwright
  `~/map-test/smoke-h2.js` verde, WOs de prueba borrados (net-zero).
- **H1 COMPLETA Y VERIFICADA**: sección DOT Inspections + PM Tracker
  rediseñado, ambos sobre el tablero compartido
  `views/MaintBoardPage.tsx` (el PMPage viejo se eliminó). Backend:
  tabla `maint_record` (kind pm|dot; cada edición es un evento, el más
  reciente por fecha manda), `core/maint.py` (board unificado; PM
  fusiona CSV Fullbay + overrides + records; DOT vence +365 días,
  upcoming ≤30), `ops_status` manual (out_of_service|in_shop) en
  units.local.json, endpoints `/api/maint/{kind}`, `/maint/record`,
  `/maint/ops-status`, `/maint/odometer/{unit}`. Frontend: tarjetas de
  status filtrables con % y barra, donut compacto, tabla editable
  inline, modal Add PM/DOT con botón "Current" (odómetro Samsara en un
  clic), animación cascada verde "PM/DOT updated" (`ft-cell-sweep`,
  CSS `mnt-*` al final de index.css). Smoke Playwright verde
  (`~/map-test/smoke-h1*.js`), datos de prueba net-zero. El endpoint
  viejo `/api/pm` sigue vivo (lo consume el Dashboard).

### Qué intentamos y qué aprendimos

- **Modales cortados en pantallas anchas (resuelto)**: la animación de
  entrada `.page { animation: ft-page-in ... both }` dejaba el
  transform como matriz identidad PARA SIEMPRE (Chrome con fill-mode
  both/forwards mantiene la animación aplicada y computa
  `matrix(1,0,0,1,0,0)`, no `none`) → `.page` se volvía containing
  block de los `position:fixed` → el backdrop del modal medía la caja
  de la página (1662×504) en vez del viewport (2000×840). Doble fix:
  `fill-mode: backwards` en ft-page-in (página y wizard) y
  `createPortal(document.body)` en components/Modal.tsx (inmuniza TODOS
  los modales: Add PM/DOT, New work order, credenciales de Settings).
  Verificado con Playwright a 2000×840: backdrop 0,0,2000×840 y
  pageTransform "none".

- Chrome `--app` + caché NO era la causa del mapa (index.html ya iba
  `no-cache`); tampoco WebGL ni OpenFreeMap. Lección: con canvas WebGL
  dentro de grid/flex, acotar TODA la cadena de alturas.
- Claude Preview no funciona desde esta sesión (cwd `C:\Program Files\Git`
  sin permisos para `.claude/launch.json`) → usar el harness Playwright
  de `~/map-test/` (`run.js`, `sidebar.js`, `smoke.js`; Chrome instalado,
  headless; token con `auth.issue_token`).
- Tests de backend SIEMPRE con limpieza (no dejar usuarios/WOs/datos
  reales). El mailer está en ENVÍO REAL: nunca disparar sends en tests.
- Reiniciar backend en Windows: PowerShell `Get-NetTCPConnection
  -LocalPort 8765` → `Stop-Process` (pkill de Git Bash no lo mata).
- Push a main SOLO con autorización explícita del usuario nombrando
  main. Staging explícito de archivos (nunca `git add -A`).

## Investigación (resumen ejecutivo; detalle en docs/STRATEGY-data.md)

- **Carriers compran por**: huir de contratos de 3 años (Samsara: ETF =
  saldo completo, quejas BBB), compliance automático, descuento de
  seguro (5-20% de prima), precio plano, soporte humano y español de
  verdad. 97.3% de los carriers de EE.UU. tiene <20 trucks.
- **Samsara 2026**: $27-60/veh/mes, contratos 36-60m, API gated por
  tiers desde 2025 (riesgo → adapter multi-ELD G6 es la póliza). Gaps:
  <25 trucks, taller (sin parts/PO/invoicing), TMS, owner-op UX.
- **Cómo consiguen datos las apps sin hardware**: integraciones ELD
  autorizadas por la flota (Fullbay refresca DIARIO; compró Pitstop
  mar-2026 para fault codes), fuel cards (WEX/Comdata: odómetro tecleado
  en la bomba), app del driver con OCR de odómetro (Whip Around), y
  gratis: NHTSA vPIC (VIN→spec, sin registro) + FMCSA QCMobile
  (DOT#→authority/insurance).
- **Escalera de datos recomendada**: (1) vPIC + OCR de odómetro ya;
  (2) Motive (única otra API self-serve gratis) sobre el provider de G6;
  (3) fuel cards; (4) agregador Terminal/TruckerCloud (este último es el
  ÚNICO que lista Panda ELD; Panda no tiene API); (5) hardware propio.
- **Reefer temps**: TrackFleet = hardware Jimi/Concox commodity
  ($30-80) + plataforma rentada (~$99/mes GPSWOX-style). Reemplazo:
  Queclink GV600MA (~$99-130, IP67, sonda 1-Wire + BLE WTH300 $29.99) o
  Teltonika FMC130 (~€70) + sonda DS18B20 → **Traccar** (open source)
  → nuestro FastAPI; $2-6/trailer/mes todo incluido. Control remoto
  SOLO vía OEM APIs (Thermo King TracKing: solicitar a
  tracking@thermoking.com; Carrier Lynx Fleet: requiere suscripción
  del cliente) o hardware cableado (ORBCOMM, Samsara AG52). No hay DIY
  de control y no debe intentarse.
- Probar SIEMPRE temperaturas bajo cero si usamos Traccar+Teltonika
  (bug histórico de decodificación).

## Qué sigue: REWORK H (8 fases, detalle en docs/ROADMAP-H.md)

Pulir y profundizar como producto: dashboards rediseñados (cinemáticos,
interactivos, personalizables). HECHAS: H1 (DOT + PM gemelos), H2 (Work
Orders pipeline UNIQ + gates QuickManage + Telegram), H2.5/H2.5b
(escáner AI de invoices: Ollama/Anthropic/Textract/heurístico), H3a
(perfil de unidad estilo Fullbay), **H3-A** (catálogo de partes +
vendors) y **H3-B** (tarifa de labor) — publicadas en v1.2.0.

**Siguiente: H4 (RBAC real** con permisos por rol y billing). Luego:
H3-C (estimate → invoice imprimible del WO, **DIFERIDO** a tu pedido),
H5 (piloto reefer con hardware propio), H6 (PostgreSQL + exterminio del
hardcodeo), H7 (rediseño cinemático transversal), H8 (dominio + email
propio + hosting).

Pendientes externos del usuario: (1) **rotar los tokens Samsara**
(Chaser+MCC) que se pegaron en chat; (2) crear cuenta AWS + IAM user con
`textract:AnalyzeExpense` y pegar las keys en Settings → Connectivity
(mientras tanto el scan corre en Ollama local gratis); (3) activar
Telegram: crear el bot con @BotFather y pegar token + chat id en Settings
→ Connectivity (guía en backend/TELEGRAM_SETUP.md); (4) cambiar la
contraseña temporal del admin `adri` en Settings → Users.

Referencias visuales del usuario: su spreadsheet TRUCKS (PM + DOT por
unidad con status ON TRACK/OVERDUE/UPCOMING/NEVER PERFORMED/OUT OF
SERVICE/IN SHOP + tabla resumen con % + pie chart) y UNIQ TMS (barra de
etapas secuencial arrastrable en el perfil de cada orden:
Upcoming → Dispatched → In Transit → Delivered → Invoiced → Closed).
