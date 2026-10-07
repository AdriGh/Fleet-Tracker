# 06 — SquareRigger por dentro vs Rigsmith (oct-2026)

Fuente: recorrido de solo lectura de una cuenta real de SquareRigger (SR) — un
transportista con taller propio, anonimizado — (oct-2026) + inventario del código de
Rigsmith v2.19.0 y la app local. Las capturas quedan solo como referencia local (fuera
de git). Nada se creó ni se guardó en SR.

## 1. Mapa de SR

| Grupo | Secciones |
|---|---|
| Work | Home, Service Requests, Work Orders, Sales Orders, Parts Requests, Purchase Orders, Transfer Orders, Inspections |
| Resources | Customers, Employees, Equipment, Locations, Parts, Services, Vendors |
| Insights | Reports (~45 predefinidos + Report Builder beta, 41 fuentes de datos) |
| Admin | Shop Watch (tiempo de técnicos), Settings (General + 13 subsecciones) |

UI: lista maestra a la izquierda + panel de detalle a la derecha, filtros con conteos,
vistas guardadas, y la URL siempre lleva `?details=<id>` (se puede compartir un enlace
a cualquier registro).

## 2. Work Orders: cómo despacha cada uno

### SR: Service Request → WO → Services → Partes/Técnicos
1. **Service Requests** agrupa por unidad: PMs vencidos (por millas), pedidos manuales,
   prioridad (Urgent/Emergency) y contadores. Cada ítem: **Deny**, **Snooze** (PM),
   **Add to…** (WO abierta), **Add Service**, o **Create Work Order**.
2. **WO** = contenedor. Tipo Inside/Outside, classification (Scheduled Repair, Accident,
   Breakdown, On Road, PM, Unscheduled, Warranty), cliente (Self o tercero), appointment,
   bay, invoice date, forma de pago, taxability, tax codes, tags.
3. Dentro, **Services** (trabajos del catálogo). Cada uno: partes con COMM/REQ,
   técnicos, labor hourly o flat, rate type, check de completado.
4. Pestañas: **Info · Parts · Invoice · PM**. Footer fijo: "0/2 services completed" +
   **Mark Complete**.
5. Parte sin stock → Parts Request → PO por proveedor. Home cuenta "Parts Blocking WOs".

### Rigsmith hoy
- WO = encabezado (unidad, título, complaint, **un** mecánico, prioridad, campaña PM,
  `waiting_parts`, shop invoice #, PO cliente, autorizador) + **lista plana** de líneas
  parte/labor (`WorkOrderLine`, db.py:207).
- Pipeline visual Open → Assigned → In progress → Completed → Invoiced; vistas List /
  Grid / Board / History.
- Fortalezas reales: WO nace sola desde una falla de reefer (y con un botón desde
  un defecto abierto del DVIR); WOs
  padre/hijas multi-unidad; OUT of stock → "Order new / In stock now / Swap";
  fotos antes/después; actividad; estimate/invoice imprimible; Email/SMS.
- Carencias: no hay service requests ni backlog con Deny/Snooze, no hay "services",
  un solo mecánico, sin classification/fees/tags/bay/appointment, sin clock in/out.

### Recomendación (cambio de despacho)
1. **`ServiceRequest`**: une defectos abiertos (DVIR), PMs/DOT vencidos y pedidos
   manuales. Prioridad + Deny/Snooze/Add to WO/Create WO. Vista "Dispatch" por unidad.
   El insumo ya existe en `open_defects.py` y `maint.py`.
2. **`WorkOrderJob`** entre la WO y las líneas: servicio de catálogo (opcional), complaint /
   cause / correction, técnicos, horas estimadas vs reales, estado done. Las líneas
   actuales migran a un job por defecto.
3. `classification` y tipo **Outside Work** ligado a Vendor (hoy solo `shop_invoice`).
4. Footer "N/M jobs completed" y **Mark Complete** que valida jobs + partes.

## 3. Perfil de unidad

| | SR | Rigsmith |
|---|---|---|
| Header | tipo, #, VIN, owner, location, fleet/group, ícono | foto, odómetro, costo 12m, órdenes activas, mapa de zonas de defecto |
| Tabs | Info · Service · Devices · Financial · History (en panel ancho se colapsan a Information + History) | Components & PMs · Active Services · Service History · Parts used · Attachments |
| Info | odómetro+GPS+Refresh, placa/estado/vencimiento, locations, warranties, specs VIN (~20), operators, related equipment | quick facts (make/model, VIN, placa, compañía, odómetro, defectos, último DVIR) |
| PM | PMs due, PM suscrito ("cada N mi"), service requests, WOs abiertas | campañas por componente (Full Wet DD13/15, DOT anual, kingpins, DPF, clutch) con último/próximo/millas |
| Dinero | book value, residual, depreciación, lease | costo de mantenimiento 12m |
| Historial | WOs cronológicas con millaje (Load More) | Service History + Parts used |

**Nos falta**: vencimiento de registro, related equipment (tractor↔trailer), operators,
devices, lista de service requests en el perfil, lo financiero, warranties por unidad.
**Ganamos**: campañas por componente, mapa de defectos, fotos, costo por unidad.

## 4. Servicios (catálogo)

SR: ~60 servicios agrupados (Brakes/Suspension, Electrical, Body, PM Reefer, Engine,
Fluids…). Cada uno: tiempo estimado, flat fee, kit de partes (qty + ubicación), tipo,
VMRS, reason/work accomplished/failure code, procedures, flag PM, "allow multiple".

Punto débil de SR: **un servicio de PM por camión** (la cuenta observada tiene un
"PM Service Truck" distinto por cada número de unidad).

Propuesta Rigsmith: **`ServiceTemplate`** = grupo + tiempo estándar + labor (hourly/flat) +
kit de partes + checklist + intervalo (millas/días/horas). El kit de PM se resuelve por
**variante de motor** (ya existe en v2.18), no por unidad: un "PM DD15" para toda la
flota. Eso es más limpio que SR y es argumento de venta.

## 5. Partes y catálogo

SR (ficha de parte): Info, Settings (activa, crítica, markup, taxable), Inventory
(available/avail/comm/short/on hand/on order, "desired inv min-max", por ubicación),
Commitments (WOs/POs/Returns/Sales/Transfers), History (log de transacciones),
Vendors (varios, uno default), alternate parts, UoM compra vs emisión, costo promedio
ponderado y último costo, VMRS, barcode.

Rigsmith: `on_hand`, `reorder_point`, `max_qty`, `avg_cost`, un `vendor_id`, barcodes,
Swap por categoría, Smart Fill. **Prioridad**: "comprometido" por WO (sin él no hay
"Parts Blocking WOs" confiable), luego varios proveedores y alternas, UoM, y costo último.

## 6. Reportes
SR: ~45 reportes + builder sobre 41 fuentes (Equipment, WO lines, PO receipts, Labor
log, PM schedule rules…), toggle tabla/gráfico, columnas, filtros, favoritos, Mine/Org/SR,
schedules por email. Ejemplos útiles: Cost per Mile, Vendor Lead Time, Technician
Leaderboard, Mileage Since Last Service, Work Order Kanban Velocity, Parts on Order.
Rigsmith: ~9 secciones fijas + export CSV/PDF/XLSX (PM compliance). Hueco: builder,
schedules, y los reportes de proveedor/técnico.

## 7. Otras brechas (resumen)
Clientes terceros con price codes (markup parte/labor), terms codes (2% 10 Net 30), tax
codes, invoice T&C, email al cerrar WO · Employees con rate types (In-house / Owner
Operator) y Shop Watch · Transfer Orders y multi-ubicación · Returns y Blanket POs ·
Fuel cards · Sales Orders (mostrador) · Inspections de taller · Telematics directo.
Vacíos en la cuenta observada (no los usa): Sales Orders, Transfer Orders, Inspections,
Returns, Blanket POs, Shop Watch, Fuel, GL accounting ("GL Account Structure is not set up").

## 8. Lo que SR NO tiene (nuestro diferencial)
DVIR con fotos de evidencia, ELD (Samsara/Motive/Traccar), reefer/cold chain y
WO automática, docscan de facturas, detección de reinstalación en garantía, core
tracking, campañas PM/DOT por componente, driver compliance, alertas Telegram/SMS,
RBAC por organización.

## 9. API de partes: ¿hace falta?
- SR **no tiene catálogo externo**; finditparts.com aparece solo como proveedor de una
  parte. Para igualar a SR no hace falta API.
- Nuestro catálogo se puede construir con **docscan**: cada factura escaneada crea o
  actualiza parte, costo y proveedor.
- Si se quiere búsqueda externa: probar **PartsTech** (programa de partners) y
  **Nexpart**; cobertura heavy-duty de cada uno: **por verificar con ellos**.
- FinditParts sin respuesta por mail: ir por partnerships / business development y
  ofrecer volumen de compras referidas. `parts_marketplace.py` ya permite cambiar de
  proveedor sin tocar la UI.

## 10. Orden sugerido de construcción
1. `ServiceRequest` + vista Dispatch (reemplaza el flujo actual de despacho).
2. `WorkOrderJob` + `ServiceTemplate` (catálogo + kits de PM por motor).
3. Parts: comprometido / short / on order; múltiples proveedores; alternas.
4. Perfil de unidad: related equipment, operators, registro, financiero, SR en perfil.
5. Classification / outside work ligado a vendor / clientes con markup y terms.
6. Reportes: builder + schedules.

## 11. Decisiones posteriores (6-oct-2026)
- **Walkaround y Driver Workflows se descartan** (v2.20): son propios de los ELD; que los
  drivers abran WOs desde el móvil generaría caos. Las tablas se conservan (sin borrar datos).
- **Service Requests primero** (v2.20): backlog por unidad = defectos DVIR abiertos +
  PM/DOT vencidos o próximos + pedidos manuales; Deny / Snooze / Add to WO / Create WO.
- Próximos: WO **Inside vs Outside Work** (outside ligado a Vendor) con Smart Fill de
  factura para ambos; asignación de mecánico sin trabas; layout estilo SR (sidebar
  compacto, lista + panel, filtros más grandes); rediseñar las metric cards de WO.
