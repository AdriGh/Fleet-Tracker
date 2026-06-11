# Rework G — Live Map, Cold Chain y Productización

Propuesta de la segunda gran reforma de Fleet Tracker (la primera fue F1–F5,
el rediseño visual v0.20.0). Basada en investigación verificada contra
documentación oficial (junio 2026). Los hechos de API citados aquí fueron
confirmados por verificación adversarial contra developers.samsara.com,
Google Maps Platform, OpenFreeMap, Traccar, flespi, Fullbay y otros.

---

## Estrategia de producto: reemplazar / competir / apoyarse

### Reemplazamos (ya o con este rework)
| Herramienta | Cómo | Evidencia |
|---|---|---|
| **Fullbay** ($188–318/mes por taller + $89–119/usuario extra, contrato anual) | Fase G5: Work Orders nativos (defecto→WO→PM→costos) | Pricing publicado en fullbay.com/pricing |
| **TrackFleet** (portal de temperatura de Journey) | Fase G4: monitoreo reefer propio | Es un white-label báltico en **PHP 5.6.40 (EOL dic-2018)**, sin API pública, sin export, jQuery 1.7. Confirmado contra app.trackfleet.com |
| Excel manual del DVIR Report | Hecho (v0.2–v0.19) | — |

### Competimos
- **Panda ELD** (tracking UI; $59.99–79.99/mes publicado) — clonamos su mapa con mejor diseño.
- **Azuga** ($25–35/vehículo/mes publicado), portales GPS baratos.
- **Fleetio** ($4–10/vehículo/mes) en la parte de mantenimiento.

### No reemplazamos — nos apoyamos en su información
- **ELD (Samsara hoy; Motive/Geotab mañana)**: moat regulatorio FMCSA. Consumimos su API read-only. Motive tiene API REST pública self-serve + OAuth (adapter fácil); Geotab es JSON-RPC con credenciales del cliente (adapter medio).
- **Google Maps**: deep links + búsqueda on-demand en lista (ver restricción legal abajo).
- **Find Truck Service / Trucker Path**: hoy deep links por coordenada; su data de POIs solo se licencia por partnership (FTS API está "Coming Soon"; TP solo da API pública del load board — POIs vía partners@truckerpath.com).
- **OEM de reefer (Carrier Lynx / Thermo King TracKing)**: única vía real de control remoto (ver G4).

### Nuestro moat
1. **Cockpit unificado**: compliance + mantenimiento + tracking + cold chain en una sola app (los incumbentes venden cada pieza por separado).
2. **Bilingüe EN/ES end-to-end** — ~13% de los drivers en EE.UU. son hispanos (20–30% en algunas flotas); ningún vendor ofrece app de driver + portal + reportes + soporte completos en español a precio de flota chica. Carril abierto confirmado.
3. **Sin hardware, sin contrato de 3 años**: corremos sobre el ELD que la flota ya pagó. (Samsara obliga contratos de 3 años, prepagados completos para flotas <11 vehículos; quejas recurrentes de billing/cancelación en G2/Capterra/BBB.)
4. **Precio transparente**: objetivo $5–15/asset/mes, mes a mes, publicado.

---

## Hallazgos técnicos clave (verificados)

### Samsara API — todo lo del mapa existe y es read-only
- `GET /fleet/vehicles/stats/feed?types=gps,engineStates,obdOdometerMeters` →
  lat/lng, `speedMilesPerHour`, `headingDegrees`, **`reverseGeo.formattedLocation`**
  (¡reverse geocoding humano incluido — no necesitamos geocoder!), engine Off/On/Idle.
  Patrón de cursor `endCursor`/`after`; polling cada 5s permitido. Máx **3 stat
  types por request** → segundo feed para `fuelPercents` + `defLevelMilliPercent`.
- `GET /fleet/hos/clocks` → duty status actual de TODOS los drivers en una
  llamada: `hosStatusType` ∈ offDuty | sleeperBed | driving | onDuty | yardMove |
  personalConveyance (string vacío = driver app desconectada) + relojes 11/14/70h
  y violaciones. Esto alimenta la barra DR/ON/SB/OFF estilo Panda.
- Scopes nuevos del token: **"Read Vehicle Statistics"** (Vehicles) y
  **"Read ELD Compliance Settings (US)"** (Compliance). Rate limits sobrados
  (feed = 50 req/s; nosotros usaríamos ~0.2 req/s).
- Reefer: `GET /fleet/trailers/stats(/feed|/history)` con types
  `reeferSetPointTemperatureMilliCZone1-3`, `reeferReturnAirTemperatureMilliCZone1-3`,
  `reeferSupplyAirTemperatureMilliCZone1-3`, `reeferAmbientAirTemperatureMilliC`,
  `reeferAlarms`, `reeferStateZone1-3`, `reeferRunMode`, `reeferFuelPercent`,
  `reeferDoorStateZone1-3`. Scope **"Read Trailer Statistics"**. Temperaturas en
  mili-°C.
- **Control remoto de reefer vía API pública de Samsara: NO EXISTE** (verificado
  contra el OpenAPI spec 2025-10-23 — cero endpoints de escritura de reefer).
  El control two-way (setpoint, on/off, pre-cool) es solo dashboard. Control
  programático → Carrier Lynx Fleet API (tier "Monitor & Control", credenciales
  vía dealer, reefers ~MY2022+) o TK TracKing partner API (application a
  tracking@thermoking.com, MY2018+). Ambos sin pricing público.

### Google Maps — restricción legal que define la arquitectura
- **ToS de Google Places: los resultados de Places mostrados EN UN MAPA deben
  mostrarse en un Google Map.** Pintar POIs de Google sobre MapLibre/Leaflet/OSM
  **viola los términos**. Cachear contenido de Places está prohibido (solo place
  IDs indefinidamente y lat/lng máx 30 días).
- No existen los tipos `truck_repair` ni `weigh_station`. Sí existen
  `truck_dealer` (nuevo, feb-2026), `truck_stop`, `car_repair`, `car_dealer`.
- El crédito de $200/mes murió (marzo 2025) → caps por SKU: 10k llamadas
  Essentials / 5k Pro / 1k Enterprise gratis al mes. Nearby Search = Pro
  ($32/1k tras las 5k gratis).
- **Patrón compliant**: nuestra capa de POIs en el mapa viene de datos PROPIOS
  (OSM + DOT estatales + curación). Google Places solo como búsqueda on-demand
  mostrada EN LISTA (sin mapa) con atribución + botón "abrir en Google Maps".

### POIs de camiones — hay que construir dataset propio
- OSM: `amenity=weighbridge` (básculas), `shop=truck_repair`, `shop=truck` —
  cobertura US pobre; sirve como semilla, no como fuente única.
- **No hay dataset federal** de básculas de enforcement (el NTAD "WIM Stations"
  son sensores de monitoreo, no básculas DOT). Los estados publican capas
  ArcGIS descargables (IDOT, Iowa DOT, Caltrans "Commercial Vehicle Enforcement
  Facilities"...) — agregarlas es tractable (~700 básculas fijas en US).
- Find Truck Service: API anunciada "Coming Soon", solo partnership.
- Trucker Path: API pública solo del load board; POIs solo por partnership.

### Stack de mapa (gratis y white-label)
- **maplibre-gl@5.x** (BSD-3) + **react-map-gl@8** (`react-map-gl/maplibre`).
- Tiles: **OpenFreeMap** — gratis, sin límites, sin API key, uso comercial
  permitido, estilos light (Liberty/Positron/Bright) y dark (Dark/Fiord).
  Sin SLA → contingencia: Protomaps PMTiles self-host (~$14/mes o R2).
- Vehículos como GeoJSON source con `cluster:true` + `setData()` cada 15–30s
  (GPU, no DOM markers). MapTiler/Stadia free = no comerciales; OSM raster
  prohibido para producto comercial; Google Maps JS = no white-label.

### TrackFleet → reemplazo por hardware, no por API
- El portal no tiene API consumible. La vía es ingerir el MISMO hardware:
  **Traccar** (open source Apache-2.0, self-host, 200+ protocolos: Teltonika
  puerto 5027, Ruptela 5046, Galileosky 5034; temps como atributos; REST +
  WebSocket) o **flespi** (managed, €130/mes hasta 1000 devices).
- Re-pointing por SMS (Teltonika `setparam 2004/2005`, Ruptela `econnect`)
  requiere: protocolo/modelo, IMEI, APN, password SMS — y **cooperación de
  Journey** (las SIMs/devices son suyos; algunos modelos permiten servidor
  secundario = dual-send sin sacar a TrackFleet).
- Riesgo: la telemetría CAN profunda del reefer (setpoint/alarmas) no es
  turnkey en Traccar — depende del modelo del tracker.

---

## Las 7 fases

### G1 — Live Map (clon de Panda ELD)
**Backend** `core/tracking.py`: dos feeds paralelos de `/fleet/vehicles/stats/feed`
(gps+engineStates+obdOdometerMeters | fuelPercents+defLevelMilliPercent) con
cursores persistidos; `/fleet/hos/clocks` cada 30–60s; merge por vehicle id.
Endpoints `/api/track/vehicles`, `/api/track/summary`. Requiere regenerar
tokens con los scopes nuevos (**y de paso ROTAR los tokens actuales**).
**Frontend**: sección "Map" en el sidebar; MapLibre + OpenFreeMap (light/dark
según tema); clustering; **sidebar de unidades con la info EXACTA de Panda**:
unit + pill de mph, ubicación humana, **botón Copy que copia las coordenadas
exactas "lat, lng" listas para Google Maps** + botón abrir-en-Google-Maps,
driver + badge de duty status, "Moving for 52m 6s", On/Off/Idle, fuel %, DEF %,
"30 seconds ago", búsqueda, filtros, paginación. **Top bar de status**:
conductores · vehículos · DR · ON · SB · OFF. Sidebar principal de la app
**colapsable a iconos** (estilo Samsara). Refetch 15–30s vía TanStack Query.

### G2 — Capa de servicios (POIs)
Tabla propia `pois` (SQLite→Postgres): básculas DOT curadas de portales
estatales + semilla OSM (weighbridge/truck_repair/truck dealers) + alta manual
desde la UI. Capas con chips de filtro: Repair shops · Truck dealers · Reefer
dealers · DOT scales. "Servicios cerca de la unidad X" (radio). Búsqueda
Google Places on-demand EN LISTA (compliant) con atribución y deep link;
deep links a Find Truck Service y Trucker Path por coordenada. Adapters
`poi_providers/` listos para enchufar FTS/TP si llega partnership.

### G3 — Device settings + alertas
Clon de los settings por device de Panda: perfil de unidad (label, icono,
grupo/terminal, visibilidad). Reglas de alerta por unidad o flota: exceso de
velocidad, idle prolongado, fuel/DEF bajo, sin señal GPS, (geofences después).
Disparan por la infra de Avisos existente (SMS/email) + toast in-app.

### G4 — Cold chain / Reefer (mata-TrackFleet)
**Vía Samsara** (trailers propios con AG + cable TK, o cloud TK TracKing
MY2018+/Carrier Lynx MY2022+): lista de reefers con setpoint/return/supply/
ambient por zona, alarmas con severidad, run mode, fuel, puertas; histórico
graficado; **export CSV/PDF** (lo que TrackFleet no tiene); alertas de rango.
**Vía Traccar** (trailers de Journey con hardware tercero): docker Traccar,
FastAPI consume su REST/WS; requiere acuerdo con Journey (SIMs, re-pointing o
dual-server). **Control remoto**: NO por Samsara — roadmap vía Carrier Lynx /
TK TracKing partner APIs (gestión con dealer). Monitoreo primero, control
después.

### G5 — Work Orders (reemplazo de Fullbay)
Pipeline defecto→WO→PM: crear WO desde un defecto o manual, asignar mecánico,
partes + labor + costos, estados, historial por unidad, cerrar PM desde WO
(actualiza last_pm — adiós export pm.local.csv), invoice/PDF, costo por
unidad/milla. Activa la sección "Work Orders" del sidebar.

### G6 — Multi-ELD adapter + Integraciones en UI
Interfaz `TelematicsProvider`: Samsara (hoy) → Motive (REST público self-serve
+ OAuth; esfuerzo bajo) → Geotab (JSON-RPC, credenciales del cliente; esfuerzo
medio) → Panda ELD (cuando publiquen API / partnership). Settings →
Integrations: tokens gestionados en la app (cifrados), test de conexión, guía
de scopes. Activa "Reports & Analytics" si hay tiempo.
**NOTA (jun-2026): la cáscara de UI se ADELANTÓ — Settings → Connectivity ya
muestra el hub de integraciones (ELD/telemática, mensajería, datos) con estado
por proveedor; G6 le cablea los adapters reales y la edición de credenciales.**

### G-TMS — Drivers & Loads (TMS-lite, referencia QuickManage)
Nueva fase pedida tras revisar QuickManage TMS (lo usa Journey; ver memoria
`reference-quickmanage-tms`). Alcance:
- **Driver profiles**: absorben el Roster y lo convierten en "lugar de paso
  recurrente" — tarjetas de compliance con vencimientos (CDL · Med/Cert · MVR ·
  Clearinghouse) + docs "On File", datos personales/contacto de emergencia,
  contrato (rol, tipo de pago, %), equipo asignado (truck/trailer chips,
  fuel cards, ELD device), deducciones recurrentes y escrow (futuro),
  notas + activity log.
- **Búsqueda global** en la top bar (driver/unidad/carga → perfil directo).
- **Trips por driver**: tabla con la carga más reciente arriba — broker/ref#,
  origen→destino con fechas/citas LEGIBLES (mejorar lo que QuickManage hace
  pequeño), indicadores de docs (RC/BOL/POD), status, millas + deadhead,
  rate + $/mi, tags (Paid/Short pay/Issue), notas con autor.
- **Perfil de carga**: pipeline Upcoming→Dispatched→In Transit→Delivered→
  Invoiced→Closed, mapa de ruta con stops numerados, rates (hauling +
  accesorios → invoicing vs assignee), documentos, notas con timestamp/autor,
  stops al pie + driver asignado + payout estimado por % de contrato.
- **Entrada de cargas** (lo que más subrayó el usuario): formulario rápido
  estilo QuickManage — broker/Bill To, ref#, stops con fechas, rate, asignación
  de driver con cálculo de payout en vivo.
Prioridad: después del mapa (G1–G3); puede solaparse con G5 (Work Orders
comparten el patrón de perfil + pipeline + costos).

### G7 — Productización white-label
Auth real (usuarios + roles admin/dispatcher/mechanic/viewer), migración de
los 7 stores `*.local.*` + SQLite → Postgres multi-empresa, TODO lo hardcodeado
a configuración por tenant (CC routing, terminales, empresas, umbral DVIR 15min,
intervalo PM 20k, lookback 270d, plantillas con merge fields), theming por
tenant (logo/color), **i18n EN/ES end-to-end**, Docker packaging, wizard de
onboarding. Pricing objetivo $5–15/asset/mes, mes a mes.

---

## Riesgos y gestiones externas
1. Tokens Samsara: regenerar con scopes nuevos y rotar los expuestos.
2. POIs de Google jamás como pins en MapLibre (legal) — solo lista + deep link.
3. Re-pointing de devices de Journey = decisión contractual, no técnica.
4. Control remoto reefer = partnership OEM (dealer Carrier / application TK).
5. OpenFreeMap sin SLA → plan B Protomaps documentado.
6. Formato de ubicación "1.4mi SSW of X": Samsara da "Street, Town, ST" — si se
   quiere el formato exacto de Panda, calcular distancia+rumbo contra un
   gazetteer local de ciudades US (GeoNames, ~30k filas, offline).
