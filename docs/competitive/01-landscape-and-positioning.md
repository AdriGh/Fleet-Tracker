# 01 — Landscape competitivo & posicionamiento

## 1.1 Para qué es este capítulo
Es la **columna vertebral** del documento. Fija tres cosas: (1) contra quién competís
de verdad y de quién te servís, (2) dónde estás parado hoy, y (3) la **lista maestra
de gaps** que el resto del doc convierte en specs de build. Si solo leés un capítulo,
leé este.

## 1.2 El set competitivo (reclasificado)

No todos los "competidores" son competidores. La distinción es estratégica:

| Grupo | Quiénes | Rol para FleetTracker |
|---|---|---|
| **Directos** | **Fullbay**, **SquareRigger**, **Fleetio**, **RTA**, **Whip Around** | Mismo comprador (jefe de flota / taller), mismo trabajo. **De acá sale qué CONSTRUIR.** |
| **ELD / telematics** | **Samsara**, **Motive** | **Partners de integración** (les consumís odómetro/DVIR/fault-codes) + **benchmark de diseño** + **"encroachers"** (están subiendo a la capa de mantenimiento). **De acá sale qué INTEGRAR y cómo DISEÑAR.** |

**Por qué importa:** FleetTracker *se sirve* de los ELD, no compite con ellos de
frente. Pero ambos (Samsara "Connected Maintenance", Motive "Maintenance") están
metiéndose en mantenimiento. Riesgo real: un fleet que ya usa Samsara podría
conformarse con el mantenimiento nativo del ELD. **Conclusión:** tu defensa no puede
ser "leemos el odómetro" (eso lo dan ellos) — tiene que ser profundidad de taller +
cold-chain + automatizaciones + ser **telematics-agnóstico**.

### Snapshot de cada uno
| Competidor | Qué es | Hero / ángulo | Pricing | Diseño |
|---|---|---|---|---|
| **Fullbay** | Shop mgmt para talleres HD | *"repair shop software" · #1 HD* | Público $188+/taller + usuario | Esconde el producto, low-motion |
| **SquareRigger** | Fleet maint + shop ops (40 años) | *"Fleet Maintenance, Without the Chaos"* | Público $4/$7/asset | Moderno, hero-video, conservador |
| **Fleetio** | Líder moderno de fleet maint | *"Run Your Fleet Smarter" · connect-the-dots* | Público $4/$7/$10 por vehículo | Limpio, screenshots reales, motion sobrio |
| **Whip Around** | DVIR / inspecciones | *"…doesn't suck" · "encima de tu ELD"* | Público free/$5/$9/asset | Casual, low-motion |
| **Samsara** | Telematics platform (CMMS) | *"Operate Smarter™"* | Gated (configurador) | **Cinemático** (UI real + tabs + video) |
| **Motive** | Plataforma AI de "physical ops" | *"AI safer & efficient"* | Gated | Arch-diagram hero + tabs |
| **RTA** | FMIS público-sector (1979) | *"Be a respected leader"* | Público $6/$8/$11/asset | Convencional, folksy |

**Señal transversal:** **5 de 7 publican precio** (por-activo, usuarios ilimitados).
Solo los gigantes de hardware gatean. Tu **pricing transparente + self-signup** te
alinea con los modernos.

## 1.3 Dónde estás parado (FleetTracker hoy)
**Ya tenés:** DVIR compliance · PM tracking · work orders multi-unidad · **AI invoice
scanning** · cold-chain/reefer · live map · Samsara/ELD sync · inventario de partes ·
reportes. Base sólida, LIVE en producción, UI moderna.

**Te falta (lo que este doc ataca):** el loop del dinero (estimate→invoice→pago),
warranty recovery, POs/procurement, fuel management, profundidad de DVIR
(form-builder + app del conductor), technician time, tire, VMRS, asistente AI, y —
lo más importante — la **plataforma de integración** que te hace agnóstico.

## 1.4 El moat (por qué te elegirían a vos y no al ELD ni a Fullbay)
1. **Telematics-agnóstico** — corrés *encima de cualquier ELD* (Samsara, Motive,
   Geotab…), no atado a uno. Mismo wedge que usa Whip Around: *"nos montamos encima
   de TU ELD"*. Nunca te posicionás "vs Samsara"; siempre *"funciona con tu Samsara"*.
2. **Profundidad de taller nativa** — DVIR → WO → AI-factura → costo, **cerrado en una
   sola app**. Samsara/Motive tercerizan el shop workflow (a Fleetio/CMMS).
3. **Cold-chain / reefer** — nativo. Nadie del set lo tiene salvo Samsara (y como
   add-on de sensor). Wedge limpio para food/pharma.
4. **Automatizaciones sobre integraciones** — "mantenimiento que se maneja solo".
5. **UX ágil + pricing transparente / self-serve** — vs. los enterprise gated.

## 1.5 Lista maestra de gaps (la columna vertebral)

### 🛠️ CONSTRUIR (de los 5 directos — prioridad = frecuencia × valor)
| # | Gap | Quién lo tiene | Prioridad | Cap |
|---|---|---|---|---|
| 1 | **Warranty & core recovery** | SquareRigger★, Samsara, RTA, Fullbay | 🔴 ALTA | 03 |
| 2 | **Purchase Orders + procurement** | Todos | 🔴 ALTA | 03 |
| 3 | **Fuel management + fuel-cards** | Fleetio, SquareRigger, RTA, WhipAround, Motive | 🔴 ALTA | 03 |
| 4 | **DVIR form-builder + app nativa del conductor** (offline/OCR/voz/foto/e-firma) | WhipAround★, Motive, RTA | 🔴 ALTA | 03 |
| 5 | **Technician time / ShopWatch** | SquareRigger★, RTA, Fullbay | 🟠 MED-ALTA | 03 |
| 6 | **Tire management** (posición, cost-per-mile) | SquareRigger, RTA | 🟠 MED-ALTA | 03 |
| 7 | **Asistente AI + analítica en lenguaje natural** | RTA, Motive, SquareRigger | 🟠 MED-ALTA | 03 |
| 8 | **Profundidad de partes** (bin, barcode, min/max, vendor rating) | Fleetio, SquareRigger, RTA, Fullbay | 🟠 MED | 03 |
| 9 | **VMRS coding** | SquareRigger, RTA | 🟠 MED | 03 |
| 10 | **Lifecycle / TCO + reemplazo** | Fleetio, SquareRigger, RTA | 🟡 MED | 03 |
| — | OOS severity, breakdown, outside-work, multi-shop, motor-pool, campaign/recall, Wallet compliance/CSA, customer portal | varios | 🟡 sec. | 03 |

### 🔗 INTEGRAR (consumir vía API — NO construir)
DTC/fault-codes + interpretación AI (Samsara/Motive) · PM por engine-hours ·
catálogo de partes (FindItParts/PartsTech) · contabilidad (**QuickBooks** ← el
priorizado) · fuel-card data. → Detalle en capítulo 04.

### ✅ DONDE GANAMOS (defender + publicitar)
Cold-chain/reefer · loop de taller nativo cerrado · live map nativo ·
transparente/self-serve.

### ⚠️ TABLE-STAKES (no vender como exclusivo)
**AI invoice scanning** — Samsara, Fleetio y RTA lo tienen. Liderar en UX/velocidad/
*incluido*, no en "somos los únicos".

## 1.6 Cómo se usa este documento
- **Cap 02** → el detalle por competidor (qué robar de cada uno).
- **Cap 03** → cada gap 🛠️ convertido en spec de build (modelo de datos, UI, API,
  automatizaciones, esfuerzo).
- **Cap 04** → la arquitectura de integración que hace posible el moat #1.
- **Cap 05** → cómo se presenta Connectivity/Integrations en la app y en el sitio.
- **Cap 06** → qué le falta al stack para soportar todo esto (queue, observabilidad,
  tests/CI, multi-tenant).
- **Cap 07** → la estructura del sitio de marketing + referencia visual.
- **Cap 08** → el orden de ejecución.
