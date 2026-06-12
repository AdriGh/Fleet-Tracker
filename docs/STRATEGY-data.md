# Estrategia de datos: cómo Fleet Tracker consigue información por su cuenta

Investigación jun-2026 (3 sweeps con fuentes). Responde: qué atrae a un
carrier, qué ofrece Samsara, cómo consiguen datos las apps que no son
ELD, cómo los conseguimos nosotros, y el caso concreto de temperaturas
de trailers.

La conclusión que ordena todo: **ninguna app de mantenimiento/taller es
dueña de sus datos**. Fullbay, Fleetio, Whip Around y Simply Fleet son
consumidores de (1) APIs de ELD autorizadas por la flota, (2) feeds de
fuel cards, (3) entrada del conductor por app móvil con OCR, y (4) APIs
gratuitas del gobierno. El moat es el workflow y la amplitud de
conectores, no la posesión del dato. Nuestro modelo "trae tu token de
Samsara" ya es el patrón estándar de la industria.

## 1. Qué atrae a un carrier (10-150 trucks)

El 97.3% de los carriers registrados en EE.UU. opera <20 trucks. Lo que
los mueve, por orden:

1. **Huir del contrato**: Samsara obliga 3 años no negociables, ETF =
   saldo completo restante (~$220/device), auto-renovación con aviso de
   30 días, sin poder sacar vehículos a mitad de contrato. Hay
   complaints de BBB con cargos de $24,746 mal facturados. Una flota de
   50 trucks paga $16-20k/año solo en suscripciones.
2. **Automatización de compliance**: un DQ file sin MVR o un med cert
   vencido = out-of-service order. ELD/DVIR/IFTA automático es el
   trigger de compra #1 en todas las guías.
3. **La matemática del seguro**: 5-20% de descuento de prima por datos
   de seguridad. Nosotros podemos empaquetar DVIR completion + PM al
   día + rachas sin violaciones en un "insurance packet" para el
   underwriter sin vender cámaras.
4. **Control de costos de mantenimiento**: un breakdown prevenido ahorra
   $5-15k. Mantenimiento no planificado cuesta 2-3x.
5. **Precio plano y soporte humano**: el ideal del foro de TruckersReport
   es "todo en un lugar, gente buena, fee anual simple". Umbral de
   conversión desde spreadsheets: ~$5-10/truck/mes con ROI visible en
   90 días.
6. **Español de verdad**: Samsara/Fleetio/Fullbay traducen la UI, pero
   ventas, onboarding, soporte telefónico, work orders e invoices en
   español casi no existen. TruckX gana flotas solo por idioma.

## 2. Qué ofrece Samsara (2025-26) y dónde no llega

Módulos: telematics (gateway VG), video safety (cámaras AI), equipment
monitoring (gateways AG + asset tags), environmental/reefer (sensores
EM), Driver App + Connected Forms/Workflows/Training, maintenance,
qualifications, routing/dispatch, wearables, agentes de voz AI. ~$1.6B
ARR. Precio efectivo $27-60/vehículo/mes según paquete, contratos 36-60
meses prepagados. **API/webhooks gated por tier de licencia desde 2025**
(riesgo directo para nosotros: abstraer la capa de ingestión ya).

Replicable por software (encima de su propio hardware vía API): mapa
GPS, salud del vehículo, fuel/idling, DVIR, maintenance/work orders, PM,
qualifications, forms, dispatch/TMS-lite, reefer temps, IFTA, reportes.
No replicable: cámaras AI, asset tags/mesh, wearables, sensores propios.

Gaps que no sirve bien: <25 trucks (su propio ecosistema dice que no
compres con <10), workflows de taller (sin parts/PO/invoicing real, nada
estilo Fullbay), UX de owner-op, español de back-office, soporte a
cuentas chicas, y la capa TMS de cargas/settlements.

## 3. Cómo consiguen datos las apps que no son ELD

- **Fullbay**: entrada manual de service orders + integraciones
  telematics (Samsara, Geotab, GPS Trackit, US Fleet Tracking) que el
  CLIENTE de la shop autoriza, refresh DIARIO de millas/horas/ubicación,
  VIN decoder gratis. En marzo 2026 compró Pitstop (predictive
  maintenance) precisamente para ganar ingestión de fault codes.
- **Whip Around**: el teléfono del driver ES la fuente (DVIR manual +
  **OCR de odómetro con foto**) + integraciones ELD opcionales. Negocio
  completo sin hardware.
- **Fleetio**: ~40 integraciones telematics + fuel cards (WEX, Comdata,
  Voyager, Coast: el odómetro que el driver teclea en la bomba llega por
  API) + app móvil. "Integrar todo, no poseer nada".
- **Agregadores ("Plaid for trucking")**: Terminal (withterminal.com,
  30-100+ ELDs, modal de conexión estilo Plaid, sandbox gratis, DTCs +
  HoS + IFTA + reefer passthrough; Panda ELD NO listado), Catena
  (ex-Axle), TruckerCloud (el ÚNICO que lista Panda ELD). Precios por
  cotización.
- **Gobierno, gratis**: NHTSA vPIC (VIN → spec completa, sin registro,
  DB descargable) y FMCSA QCMobile (DOT# → authority/insurance/safety,
  webkey gratis).

## 4. Nuestra escalera de adquisición de datos (recomendación)

1. **Ya** (~$0, 2-4 semanas): vPIC VIN decode al crear unidades
   (auto-llenar año/make/model/GVWR), QCMobile en onboarding de
   carriers, y **foto de odómetro + OCR por visión** en el flujo DVIR
   del driver: cada unidad tiene millaje aunque no haya telematics.
   Con esto, inventario + PM + Annual DOT se auto-sostienen.
2. **Samsara OAuth 2.0 + Motive** (1-2 meses, $0): Motive es la única
   otra API self-serve gratis (developer.gomotive.com, el admin de la
   flota pide su API key con un click). Samsara + Motive cubren la
   mayoría del mercado small/mid. El interface TelematicsProvider de G6
   ya existe para esto.
3. **Fuel cards** (WEX primero): odómetro periódico + economía de
   combustible + base del feature IFTA.
4. **Agregador para la cola larga** (cuando ≥2 prospectos usen "otro"
   ELD): demo con Terminal y TruckerCloud (Panda). Pagar por conexión
   solo donde no llegamos directo.
5. **Hardware white-label** (solo con demanda probada): Teltonika
   FMC003/J1939 ~$60-100 + flespi (~€0.20/device/mes) → margen de
   hardware propio. NUNCA intentar certificación ELD/HoS.

## 5. Temperaturas de trailers (reemplazar TrackFleet)

**TrackFleet es una plataforma reseller white-label**: hardware chino
commodity (Jimi/Concox, ~$30-80 wholesale) + software rentado tipo
GPSWOX ($99/mes el tier white-label completo). La capa que Journey paga
es finísima, y está confirmado que se puede cortar:

| Camino | Upfront/trailer | Mensual | Control remoto | Esfuerzo |
|---|---|---|---|---|
| **1. Propio: Queclink GV600MA o Teltonika FMC130 + sonda temp → Traccar (open source) → FastAPI** | $100-160 | $2-6 (SIM IoT) | No | 2-4 semanas; 100% nuestro y white-label |
| **2. OEM APIs: Thermo King TracKing + Carrier Lynx Fleet** | $0 en reefers ~2019+ (hardware de fábrica) | $15-30 (suscripción OEM vía dealer) | **Sí: setpoint, modo, start/stop, alarmas** | 2 integraciones REST; acceso por cliente (TK: tracking@thermoking.com; Carrier: portal dev, requiere ser suscriptor Lynx) |
| 3. Samsara AG en trailers (código ya hecho) | ~$298 + cable reefer | ~$15 | Sí con cable | Cero: `/fleet/trailers/stats` ya funciona |
| 4. Anytrek ThermoTrack (REST API pública, SMB) | $150-300 | $10-20 | No | Bajo |
| 5. ORBCOMM/Phillips (enterprise) | $400-800 | $15-30 | ORBCOMM sí | Ciclo de venta enterprise |

- Los trackers Teltonika soportan hasta 4 sondas Dallas DS18B20 (~€10-15,
  ±0.5°C) + sensores BLE EYE (~€41, batería 5 años, sensor de puerta);
  Queclink GV600MA es específicamente para trailers (IP67, 90 días de
  batería, sonda 1-Wire + BLE WTH300 $29.99). Traccar los ingiere a
  todos y reenvía por REST/WebSocket a nuestro backend. Ojo: probar
  temperaturas BAJO CERO en Traccar+Teltonika (bug histórico de
  decodificación).
- Los devices de TrackFleet que Journey ya tiene podrían re-apuntarse a
  nuestro server por SMS/config si Journey los posee y no están
  firmware-locked; si no, reemplazo a $99-130 se paga solo en meses.
- **Control remoto**: SOLO existe por dos vías: OEM APIs (TK/Carrier,
  software puro, es lo que usan Samsara y Motive) o hardware cableado al
  controlador del reefer (ORBCOMM/Samsara AG52). No existe camino DIY y
  no hay que intentarlo (protocolos seriales propietarios y safety).

**Jugada**: camino 1 (pipeline Traccar propio) como reemplazo universal
de TrackFleet a costo commodity, camino 2 (TK + Carrier) como tier
premium con control remoto en reefers nuevos, camino 3 donde el carrier
ya pague Samsara en trailers. El modelo de datos reefer de G4 ya sirve
para los tres.

## Riesgos anotados

- Samsara monetizando API por tiers desde 2025: el adapter G6 deja de
  ser opcional, es la póliza de seguro.
- Agregadores son startups seed ($3-8M): no construir encima sin plan B.
- Suscripciones OEM por unidad (TK/Carrier) son cotizadas por dealer:
  pueden comerse el margen; confirmar precio antes de prometer control
  remoto.
- "Vegapix" no existe (alucinación de referencia previa); los reales son
  Terminal, Catena y TruckerCloud.
