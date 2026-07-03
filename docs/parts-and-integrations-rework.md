# Rework de Integrations + Fase Parts & Vendors — informe y plan

> Jul-3-2026. Insumos: teardown web de SquareRigger (SQCore) y Fleetio (parts,
> inventario y compras), relevamiento de APIs públicas de partes heavy-duty, y
> el estado real del código de Rigsmith (v1.41.x). Complementa el doc grande
> de `docs/competitive/` (rama `docs/competitive-teardown`).

---

## 1. Integrations: lo que ya cambió hoy (v1.42.0)

- **La app ya no menciona Samsara** en ninguna superficie de usuario: login,
  Live Map, Defects, PM board, Reefer, Settings, onboarding → todo habla de
  **"your ELD" / "ELD sync"**. El nombre del vendor solo aparece donde debe:
  dentro del flujo de conexión del PROPIO usuario.
- **Connectivity → Integrations** (header + subtítulo).
- **ELD · Telematics = una sola card.** Muestra la conexión activa (o el
  placeholder "Your ELD — Not connected") y un único botón **Connect your
  ELD** que abre el selector de plataformas (Configure / Set active por fila).
  La grilla de 4 cards de vendors murió.
- **Data sources sin Fullbay ni Google Sheets** (quedan: Google Places, AI
  document scan, Parts marketplace).

## 2. Propuesta: el stack de conexiones de Rigsmith

La idea rectora del doc competitivo se mantiene: **una conexión por
categoría**, agnóstica, con un modelo canónico en el medio. El hub de
Integrations debería converger a **5 slots**:

| Slot | Estado | Próximo paso |
|---|---|---|
| **ELD · Telematics** | ✅ hoy (1 activa, adapters Samsara/Motive vivos) | sumar adapters por demanda de clientes |
| **Parts supplier** | scaffold demo | **FinditParts Reseller API** (ver §4) |
| **Accounting** | no existe | QuickBooks OAuth (el kill-shot; fase posterior) |
| **Cold chain** | ✅ hoy (Lynx / Thermo King / Traccar) | queda como está |
| **AI & services** | ✅ hoy (docscan Groq, Places) | queda como está |

### Notices / Messaging: mi recomendación (decisión pendiente tuya)

Estás pensando en eliminar Notices y su sección de messaging (Gmail SMTP,
Twilio, Cloudinary, Telegram). Mi lectura, sin endulzar:

- **Twilio SMS + Cloudinary MMS: matalos.** Son el 80% del costo de
  mantenimiento del módulo (A2P 10DLC compliance, créditos, dry-runs) y no
  diferencian: todos los ELD ya notifican a los drivers por su propia app.
  Chasing de DVIRs por SMS es un workflow que el ELD resuelve mejor.
- **Telegram shop bot: conservalo pero re-etiquetado.** Es barato (un bot
  token), no tiene compliance, y "el taller recibe la WO asignada en su grupo"
  es un feature que un taller real usa. No es "Notices": es **Notifications**
  del módulo Work Orders.
- **Email (Gmail SMTP): degradalo a infraestructura.** Un SaaS necesita mandar
  emails igual (invitaciones de usuarios, reset de password cuando exista,
  digest). No debería ser una "integración configurable por el usuario" sino
  plomería nuestra (un transaccional tipo Resend/Postmark cuando haya dominio).
- **Neto:** la página Notices puede morir como feature visible; el hub de
  Integrations pierde la sección Messaging entera y gana una sola card
  **"Shop notifications (Telegram)"** bajo el slot de servicios. Antes de
  ejecutar: confirmar que nadie usa Notices en prod (hoy el único org es la
  flota piloto — vos sabés si el jefe lo usa).

---

## 3. Parts & Vendors: qué hay HOY en Rigsmith

Lo construido en v1.23–v1.25 (funciona en prod): catálogo de partes con costo,
`on_hand`/`reorder_point`, movimientos idempotentes (`part_stock_movement`),
**QuickBuy** (low stock → PO en un click), POs (`purchase_order`/`po_line`)
con receiving que actualiza stock, hooks WO↔inventario (las líneas de la WO
descuentan stock a costo real), y un marketplace scaffold con datos demo
esperando una API real. El AI scan ya extrae líneas de partes de facturas.
**Base sólida; lo que falta es profundidad y la conexión de compras real.**

## 4. APIs públicas de partes heavy-duty (research verificado)

Ranking para clase 8:

1. **FinditParts Reseller API — el candidato.** Único marketplace HD-first
   con API REST pública y documentada (api-docs.finditparts.com): búsqueda de
   catálogo con precios, cuentas de cliente linkeadas, cotización de envío y
   **colocación de órdenes** white-label. Auth: JWT HS256 por request
   (trivial desde FastAPI). 3.5M+ SKUs HD, 1,100+ marcas. Es exactamente lo
   que usan Fullbay Marketplace y Mitchell 1 Truck Edition. Acceso: mail a
   `api-support@finditparts.com` (onboarding productizado, sin self-serve).
2. **Nexpart / WHI (eBay company)** — red de sellers HD real (dealers PACCAR,
   Volvo/Mack, Navistar, VIPAR). APIs Orderlink (pricing/availability/orden
   headless) y Catlink (catálogo). **Gated por sales call**, sin docs
   públicas. Abrir la conversación en paralelo; lead time largo.
3. **PartsTech (ahora de OEC)** — el que usa Fleetio. Buen DX pero catálogo
   light/medium-duty primero (HD "some availability" según la propia doc de
   Fleetio). Docs ya no navegables post-adquisición; partner por mail a OEC.
   Para flotas mixtas más adelante, no para el core clase 8.
4. **Diesel Laptops API** — no es canal de compra: es **datos** (parts-cross
   con 10M+ cross-references, VIN decode, fault codes, labor guide). El
   interchange programático más accesible del mercado. Complemento, no
   sustituto.
5. **Sin API utilizable:** FleetPride (EDI/sales, en fusión con TruckPro),
   NAPA (punchout automotriz), Vander Haag (workaround: eBay Browse API sobre
   su store), Dorman (feeds de dealer), MyPlace4Parts (automotriz), TecDoc
   (Europa).
6. **Datos de referencia:** VMRS se LICENCIA de ATA TMC (Corporate Developer
   license para embeberlo en un SaaS); MOTOR FleetCross es el interchange
   autoritativo pero es partnership a medida (lo usan Fullbay/Karmak/Procede).

## 5. Qué hacen los referentes (teardown, con lo robable marcado)

### SquareRigger (SQCore) — el benchmark de profundidad
- **QuickBuy WO→PO en un click** es su feature insignia. *Ya lo tenemos —
  validación de que apuntamos bien.*
- 🔥 **Receiving consciente de backorders**: al recibir un envío parcial,
  auto-genera una PO linkeada por las líneas faltantes. Específico y robable.
- Min/max con auto-PO + alertas; transferencias entre ubicaciones; cycle
  counts desde el móvil; costeo por GL; **contratos de precio por vendor**
  (enforcement anti-sobreprecio) + lead times por vendor.
- 🔥 **Smart Fill por UPC**: escaneás el barcode y auto-llena specs + imagen
  de la parte. Encaja perfecto con nuestra cultura de "escanear".
- **Warranty a nivel parte** (su moat): al crear la WO auto-flaggea repairs
  elegibles a garantía, claim en un click, pre-llenado con códigos VMRS.
  Claim de marketing: "$1–2K por vehículo recuperados en 30 días".
- **Flanco abierto: cores.** No hay evidencia pública de tracking de core
  charges/core bank en SQ. Fleetio tampoco lo tiene fuera de líneas
  PartsTech. **Nadie del segmento lo cuenta bien.**
- Dato de mercado: 0 reviews de terceros en 2026 pese a 40 años — social
  proof débil. Pricing: parts+POs incluidos desde $4/asset (tabla stakes).

### Fleetio — el benchmark de pulido (y sus costuras)
- Lo bueno: **PO de 8 estados con receiving parcial y cost locking**,
  valuación **FIFO/LIFO/Average-Cost** real (raro en el segmento), punchout
  PartsTech (precio+stock vivo multi-supplier → PO draft).
- Las costuras (quejas verbatim de usuarios): **no hay min/max** (solo un
  reorder point), **no hay cycle counts**, escaneo **solo con cámara del
  teléfono** (piden scanner de escritorio), **no hay cross-reference de
  números de parte**, y — la gran queja — **las compras no se inician desde
  la work order** ("work orders drive parts, not the other way around").
  El punchout es beta, Premium-only ($10/veh/año anual) y exige mapear cada
  línea a mano. Las partes **no llevan VMRS** (solo los service tasks).

## 6. El plan de Parts para Rigsmith (mi propuesta, por fases)

**Principios:** todo incluido en el plan (nada paywalled — ya es nuestro
pricing), mobile+desktop desde el día 1, y el escáner como identidad.

### P0 — Fundaciones del inventario (código nuestro, sin APIs)
- Min/max reales (no solo reorder point) + ubicaciones con bins.
- POs con ciclo de estados (draft → approval con límite de $ → ordered →
  partial → received → closed) y **receiving parcial con auto-PO de
  backorder** (robado de SQ).
- Ajustes con razón obligatoria + historial auditable (Fleetio lo hace bien).
- Barcode: cámara del teléfono Y scanner USB de escritorio (queja #1 de
  Fleetio resuelta gratis: un scanner USB es un teclado).

### P1 — El diferenciador: el escáner también hace inventario
- 🎯 **Scan-to-receive**: escaneás la factura del proveedor y el sistema
  recibe la PO — crea/actualiza partes, costos y cantidades. Es nuestra
  tecnología estrella aplicada donde nadie la tiene. "El inventario se
  carga solo."
- **Smart Fill por UPC** (foto del barcode → specs + imagen).
- 🎯 **Core tracking**: cargos de core en líneas de PO/WO, banco de cores
  pendientes, créditos al devolver. Es el flanco abierto de TODO el segmento
  y es dolor real de talleres diésel.

### P2 — Compras conectadas
- **FinditParts Reseller API** dentro de QuickBuy: buscar → precio real →
  ordenar sin salir de Rigsmith (reemplaza el scaffold demo). Mandar el mail
  de acceso YA (lead time desconocido).
- **Compra iniciada desde la WO**: parte faltante en la WO → QuickBuy → PO →
  receive-to-WO sin restricciones (la costura de Fleetio, cerrada).
- **Cross-reference**: API de Diesel Laptops (interchange 10M+ crosses) para
  "este número no existe, pero es equivalente a este que SÍ tenés en stock".
- Abrir conversación WHI/Nexpart en paralelo (dealers OEM).

### P3 — Profundidad que vende
- **Warranty a nivel parte**: al usar una parte en una WO, si la misma parte
  falló dentro de su ventana de garantía en esa unidad → flag + claim
  pre-llenado. Tenemos el historial de WOs para hacerlo. (El moat de SQ,
  replicable con nuestros datos.)
- **Licencia VMRS** (TMC Corporate Developer) y codificar tasks Y partes
  (Fleetio solo codifica tasks — ventaja medible).
- Valuación average-cost primero (FIFO/LIFO después si un cliente lo pide).
- Reporte de slow-moving / obsoletos (E&O de SQ, versión simple).

### Orden sugerido
P0 y P1 son código nuestro y caben en 2-3 incrementos; P2 depende de
terceros (por eso los mails salen ahora); P3 es donde el módulo se vuelve
argumento de venta contra los dos.

## 7. Webinars / videos para tu sesión de research
- SQ on-demand: no hay sesión específica de parts; el catálogo tiene
  "paperwork automation" (youtu.be/r048ELAcF0Y) y "budgeted labor times"
  (youtu.be/BZKWqVel4B0). Su blog "Beyond the Stockroom" es el mejor texto
  sobre su filosofía de inventario.
- Fleetio: canal de YouTube con demos de parts (ej. "Print QR Code Labels",
  youtube.com/watch?v=8Ra0JsNR8Ik) y el help center (help.fleetio.com,
  secciones Parts & Inventory / Purchase Orders) es de lectura rápida y
  muestra las pantallas reales.
