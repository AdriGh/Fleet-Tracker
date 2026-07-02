# Feature: Purchase Orders + procurement (aprovisionamiento)

## 1. Qué es y por qué importa

Una Purchase Order (PO) es el documento con el que el taller le compra partes a un proveedor: qué se pide, en qué cantidad, a qué precio unitario, y cómo se recibe. El procurement es el ciclo completo alrededor de esa PO: detectar la necesidad (una parte bajo su punto de re-pedido, o una WorkOrder que consume partes que no hay en stock), levantar una requisición, aprobarla según el monto, emitir la PO al vendor, recibir la mercancía (parcial o total) y actualizar el inventario y el costo real pagado.

Por qué importa: hoy Fleet Tracker ya tiene inventario básico (`Part.on_hand`, `reorder_point`) y un QuickBuy que crea una PO de un saque desde el low-stock. Pero el ciclo está cortado a la mitad. Sin PO completa el taller no tiene: control de aprobaciones (cualquiera puede comprometer gasto), historial de precio pagado por proveedor (last-price-paid), recepción parcial (backorders), ni la trazabilidad PO -> WorkOrder -> vendor que audita a dónde se fue cada dólar de partes. Es la pieza que convierte "una lista de partes que compramos" en control de gasto real. Todos los competidores lo tienen, y es una de las razones por las que un shop no migra de Fullbay: sabe cuánto pagó la última vez por ese filtro de aceite y a quién.

El scaffold ya existe (`core/purchasing.py`, modelos `PurchaseOrder`/`POLine`, rutas `/api/purchase-orders`, `PurchaseOrdersPage.tsx`) con el pipeline `draft -> ordered -> received` y el hook de inventario funcionando. Esta spec desarrolla ese scaffold hasta el ciclo de procurement completo.

## 2. Referencia competitiva

- **RTA** — El estándar de la categoría en shops de flota. Requisiciones automáticas cuando una parte cae bajo su reorder point, auto-generación de la PO agrupando por vendor, **cadenas de aprobación** por monto y rol, receiving contra la PO (parcial/total), precio de vendor con **last-price-paid**, y reportes de historial y tendencia de spend por parte/vendor/mes. Es la vara alta.
- **Fleetio** — POs, aprobaciones y receiving en un solo lugar, atados al inventario con **auto-decremento/incremento**: recibir una PO sube el on-hand automáticamente, sin re-tipear. Ese acople PO-inventario es exactamente el patrón que ya tenemos con `inventory.adjust`.
- **SquareRigger** — Convierte WorkOrders o requests aprobados directamente en PO, y trae del vendor **precio, disponibilidad y last-price-paid** al armar la línea. El puente WO -> PO es clave: la partida nace de una necesidad real de reparación.
- **Fullbay** — Pedido al vendor en **1 clic** desde la orden, y una **matriz de markup** para revender la parte al cliente. Fleet Tracker maneja costo interno sin markup (decisión de producto), así que tomamos el "1 clic" pero dejamos la matriz de markup fuera de alcance por ahora.

Lectura para nosotros: nadie gana por tener PO; se pierde por no tenerlas. El diferencial de Fleet Tracker es el **procurement automático de punta a punta** (low-stock -> requisición -> PO agrupada -> aprobación -> receiving -> inventario) montado sobre el motor de automatizaciones (cap 04) y con **precios en vivo del catálogo externo** (FindItParts/PartsTech, cap 04), algo que RTA/Fleetio resuelven con catálogos cerrados o carga manual.

## 3. Modelo de datos (SQLAlchemy; REUSÁ el scaffold PurchaseOrder/po_line existente; nota migración Alembic)

Punto de partida real (`backend/app/db.py`): `PurchaseOrder(OrgScoped)` con `vendor` (texto libre), `status` en `draft|ordered|received`, `total` cacheado, `lines` en cascada; `POLine(OrgScoped)` con `part_number`, `description`, `qty`, `unit_cost`. Ambos ya org-scoped vía el mixin `OrgScoped`.

Cambios propuestos (evolución, no reescritura):

**PurchaseOrder** — extender:
- `vendor_id: FK(vendor.id) nullable` — reemplaza gradualmente el `vendor` texto libre por FK dura al modelo `Vendor` ya existente. Se mantiene `vendor` como snapshot del nombre para PO históricas.
- `status` — ampliar el enum a `draft | pending_approval | approved | ordered | partial | received | canceled`. Los tres viejos (`draft/ordered/received`) siguen válidos; los nuevos cubren aprobación y recepción parcial.
- `wo_id: FK(work_order.id) nullable, index` — vínculo PO -> WorkOrder (la partida nace de una reparación).
- `approved_by_id: FK(user.id) nullable`, `approved_at: DateTime nullable`, `submitted_at`, `ordered_at`, `received_at` — sellos de tiempo del ciclo.
- `expected_total` ya cubierto por `total`; agregar `received_total` (costo real recibido, base del last-price-paid).

**POLine** — extender:
- `qty_received: Float default 0.0` — cuánto llegó de esta línea (habilita recepción parcial: `qty_received < qty` => backorder).
- `line_status: str default 'open'` en `open | partial | received`.
- `wo_line_id: FK(work_order_line.id) nullable` — traza la línea de PO a la línea de WO que la originó.

**Nuevo modelo `PurchaseRequisition(OrgScoped)`** — la necesidad antes de que sea PO:
```
id, created_at, source: str            # 'low_stock' | 'work_order' | 'manual'
part_number, description, qty, est_unit_cost
suggested_vendor_id: FK(vendor.id) nullable
wo_id: FK(work_order.id) nullable
status: str                            # 'open' | 'grouped' | 'dismissed'
po_id: FK(purchase_order.id) nullable  # la PO en que terminó
```
La requisición es efímera y agrupable: N requisiciones del mismo vendor colapsan en 1 PO.

**Vendor** — extender el modelo ya existente con datos de aprovisionamiento:
- `rating: Float default 0.0` (0-5), `lead_time_days: Int default 0`, `active: Bool default True`.
- `last_price_paid` NO es una columna: se deriva por consulta (ver cap 4) del último `POLine` recibido de ese `(vendor_id, part_number)`, para no desincronizar un cache más.

**Aprobaciones** — política por org, no tabla nueva pesada: reusar `org_config` para guardar los umbrales (p.ej. `{"po_approval": {"threshold_usd": 500, "approver_scope": "purchasing.approve"}}`). Una PO sobre el umbral entra a `pending_approval` y requiere un usuario con el scope aprobador.

**Migración Alembic**: todo lo anterior es aditivo (columnas nullable + una tabla nueva + un enum ampliado que ya acepta los valores viejos). Una sola revisión: `alembic revision -m "po_procurement_cycle"` con `op.add_column` para los campos nuevos, `op.create_table("purchase_requisition", ...)`, y un backfill trivial (`status` viejos quedan como están; `vendor_id` se rellena por match de nombre contra `vendor` donde exista, si no queda null y se sigue usando el snapshot de texto). Recordar que en dev es SQLite (batch mode de Alembic para `add_column`) y en prod Postgres. Sin `DROP`, sin `NOT NULL` nuevos: migración segura y reversible.

## 4. Backend (core + endpoints; reglas)

Base actual en `core/purchasing.py`: `list_pos`, `get_po`, `create_po`, `update_po` (con el hook de inventario en `received`), `add_line`, `delete_line`, `delete_po`, `stats`. Se conserva todo; se agrega el ciclo:

**core/purchasing.py — nuevas funciones y reglas:**
- `list_requisitions(status="open")` / `create_requisition(...)` / `dismiss_requisition(id)` — la cola de necesidades.
- `generate_requisitions_from_low_stock()` — lee `inventory.low_stock_list()`, crea una `PurchaseRequisition(source='low_stock')` por parte que aún no tenga una requisición abierta (dedup por `part_number` + `status='open'`). `qty` sugerida = `reorder_point * 2 - on_hand` (regla simple de reposición, configurable). `suggested_vendor_id` = `Part.vendor_id`.
- `group_requisitions_to_pos(requisition_ids)` — agrupa por `suggested_vendor_id`, crea una `PurchaseOrder(status='draft')` por vendor con una `POLine` por requisición, y marca las requisiciones `grouped` con su `po_id`. Este es el "auto-generación de PO" de RTA.
- `create_po_from_workorder(wo_id)` — toma las líneas `kind='part'` de una WorkOrder que no tienen stock suficiente y arma la PO (puente WO -> PO de SquareRigger), seteando `wo_id` en la PO y `wo_line_id` en cada línea.
- `submit_po(po_id)` — `draft -> pending_approval` si `total >= threshold`, si no `draft -> approved` directo. Sella `submitted_at`.
- `approve_po(po_id, user)` — valida que `user` tenga el scope aprobador; `pending_approval -> approved`; sella `approved_by_id`/`approved_at`. Rechazar (`reject_po`) vuelve a `draft` con nota.
- `mark_ordered(po_id)` — `approved -> ordered`, sella `ordered_at` (aquí es donde el "1 clic al vendor" de Fullbay dispara el email/export de la PO, ver cap 7).
- `receive_po(po_id, receipts)` — el corazón del receiving. `receipts` = `[{line_id, qty_received}]`. Por cada línea suma a `qty_received`, recalcula `line_status`, y llama `inventory.adjust(part_number, qty_delta, "po_receive", ref_type="po_line", ref_id=line_id, note=...)`. **Reusa el hook idempotente ya existente**: recibir dos veces la misma cantidad no duplica stock (guard por triple `(reason, ref_type, ref_id)`). Si toda línea llegó completa => PO `received`; si algunas parciales => `partial`. Actualiza `received_total` con el costo real. Para recepción parcial escalonada, el `ref_id` debe incluir el nº de recepción (`po_line:{id}:{receipt_seq}`) para que cada entrega parcial sea un movimiento propio y siga siendo idempotente.
- `last_price_paid(vendor_id, part_number)` — query: último `POLine` con `line_status in (partial,received)` de POs de ese vendor, ordenado por `received_at desc`. Devuelve `{unit_cost, received_at, po_id}`. Alimenta el armado de líneas y los reportes.
- `spend_history(part_number=None, vendor_id=None, months=12)` — agrega `received_total` por mes/vendor/parte para el reporte de tendencia de spend (RTA).

**Reglas duras:**
- Una PO en `ordered`/`partial`/`received` no permite editar líneas (solo receiving). En `draft`/`pending_approval` sí.
- RBAC por scopes (auth cookie existente): `purchasing.read` (ver), `purchasing.write` (crear/editar draft, recibir), `purchasing.approve` (aprobar sobre umbral). El aprobador no puede ser el mismo que creó la PO si `org_config` lo exige (separación de funciones).
- Todo org-scoped automático vía los eventos de `SessionLocal` (nada de filtrar `org_id` a mano).

**Endpoints (extienden `/api/purchase-orders` en `api/routes.py`):**
- `GET /api/requisitions?status=open` · `POST /api/requisitions` · `POST /api/requisitions/generate` (low-stock) · `POST /api/requisitions/group`
- `POST /api/purchase-orders/from-workorder/{wo_id}`
- `POST /api/purchase-orders/{id}/submit` · `/approve` · `/reject` · `/order` · `/receive`
- `GET /api/purchase-orders/{id}/last-price?part_number=…` · `GET /api/purchase-orders/spend?months=12`
- Los `GET/POST/PATCH/DELETE /api/purchase-orders` actuales se mantienen intactos.

## 5. UI (React; dónde encaja; estados vacío/carga/error)

Encaja en `views/PurchaseOrdersPage.tsx` (ya existe) más un tab de requisiciones. Cliente en `api.ts`.

- **Cola de requisiciones** (tab nuevo, o panel arriba de la lista de PO): tabla de necesidades con checkboxes, badge de origen (Low stock / Work order / Manual), qty sugerida editable, vendor sugerido. Botón "Generar PO" agrupa las seleccionadas por vendor. Botón "Refrescar desde inventario" llama `/requisitions/generate`.
- **Lista de PO**: la actual, con la columna `status` mostrando los nuevos estados como chips de color (draft gris, pending_approval ámbar, approved azul, ordered índigo, partial púrpura, received verde, canceled tachado). Filtro por estado y por vendor.
- **Detalle de PO**: cabecera (vendor con su rating y lead-time, WO vinculada como link, sellos de tiempo del ciclo). Líneas con `qty`, `qty_received`, `unit_cost`, y al lado de cada línea el **last-price-paid** ("Última: $12.40 · hace 3 sem") y, si el catálogo externo está conectado, el **precio en vivo** (cap 7). Barra de acciones contextual al estado: draft => Editar/Enviar; pending_approval => Aprobar/Rechazar (solo con scope); approved => Marcar como ordenada; ordered/partial => Recibir.
- **Modal de receiving**: una fila por línea con input "recibido ahora" (default = pendiente), permite parcial; al confirmar llama `/receive`. Feedback: "Stock actualizado: +8 en on-hand" (leído del resultado de `inventory.adjust`).
- **Estado vacío**: sin PO => ilustración + "Aún no hay órdenes de compra. Empezá desde el low-stock o convertí una work order." con CTA a la cola de requisiciones. Sin requisiciones => "Inventario al día, nada por re-pedir."
- **Estado de carga**: skeleton rows en la tabla (mismo patrón que `PartsPage`/`WorkOrdersPage`), spinner en botones de acción mientras corre la transición.
- **Estado de error**: banner rojo no bloqueante con el mensaje del backend (p.ej. "No tenés permiso para aprobar esta PO" en un 403, "Esta PO ya no es editable" en un 409). El modal de receiving revierte los inputs si el POST falla y muestra el error inline.

## 6. Automatizaciones (cap 04)

El procurement es un caso de uso central del motor de automatizaciones. Triggers y acciones que expone/consume:

- **Trigger `part.low_stock`** (parte cruza su `reorder_point`, detectado por el hook de inventario ya existente): acción `create_requisition`. Regla por defecto activable: "cuando una parte cae bajo reorder, crear requisición automática." Es exactamente la **requisición automática de RTA**.
- **Trigger `requisitions.batch_ready`** (cron diario o N requisiciones acumuladas): acción `group_requisitions_to_pos` -> **auto-generación de PO** agrupada por vendor, dejándolas en `draft` o enviándolas a aprobación según monto.
- **Trigger `po.submitted` con `total >= threshold`**: acción `route_for_approval` -> notifica al aprobador (canal de notificaciones existente: `core/notify`/Telegram/email). Trigger `po.approved` -> notifica al creador y, si la org lo configuró, dispara `mark_ordered` + envío al vendor.
- **Trigger `po.received` / `po.partial`**: acción `notify` al solicitante ("llegaron 8 de 10 filtros; 2 en backorder") y, si vino de una WO, marca la WorkOrder como des-bloqueada de partes.
- **Trigger `workorder.needs_parts`** (línea `kind='part'` sin stock al planificar la WO): acción `create_requisition(source='work_order')`, cerrando el lazo reparación -> compra.

Todas estas reglas viven en el motor canónico del cap 04 y son opt-in por org; el procurement expone los triggers/acciones, no re-implementa scheduling.

## 7. Integraciones que toca

- **Catálogo de partes externo (FindItParts/PartsTech, cap 04)** — vía el scaffold `core/parts_marketplace.py` (`PartsProvider` ABC, hoy `MockPartsProvider`). Al armar/editar una línea de PO en `draft`, la UI consulta `search(part_number)` y muestra **precio, disponibilidad y vendor** en vivo (`SearchResult`), replicando el "precio/disponibilidad del vendor" de SquareRigger. Mientras no haya API key, cae al mock con banner "Demo data" (comportamiento ya definido). Cuando el precio en vivo difiere del last-price-paid, la UI lo señala.
- **Inventario** (`core/inventory.py`) — el receiving llama `inventory.adjust(..., "po_receive", ...)`; ya está cableado e idempotente. Es el auto-incremento de stock de Fleetio.
- **WorkOrders** (`core/workorders.py`) — puente WO -> PO (`create_po_from_workorder`) y el `wo_line_id` de traza; simétrico al hook `wo_consume` que ya decrementa stock al facturar la WO.
- **Vendor** — la PO pasa de `vendor` texto libre a `vendor_id`; el rating/lead-time del vendor se muestra en el detalle.
- **QuickBuy** — el flujo actual (low-stock -> crear PO de un saque) se convierte en el camino corto: crear requisición + agrupar en un paso. No se rompe.
- **Notificaciones** (`core/notify`) — aprobaciones y recepciones disparan avisos por los canales ya integrados.
- **QuickBooks (priorizado en el roadmap de integraciones)** — a futuro, la PO `received` es el evento natural para empujar un bill/expense; fuera de alcance de esta spec pero el `received_total` y el `vendor_id` son los campos que esa integración necesitará.

## 8. Esfuerzo (S/M/L) · prioridad · dependencias

**Prioridad: ALTA (todos los competidores lo tienen; es tabla de entrada para reemplazar a Fullbay).** El scaffold ya construido baja el costo real.

Desglose por incremento:
- **S** — Ampliar enum de estados + campos de sellos de tiempo + `qty_received`/`line_status` en POLine + migración Alembic aditiva. Receiving parcial sobre el hook de inventario existente. (Reusa casi todo `purchasing.py`.)
- **M** — `PurchaseRequisition` (modelo + core + endpoints + tab UI), `generate_requisitions_from_low_stock`, `group_requisitions_to_pos`, `last_price_paid`, puente `create_po_from_workorder`, migración de `vendor` texto -> `vendor_id`.
- **M/L** — Cadena de aprobaciones (scopes RBAC nuevos, política en `org_config`, separación de funciones, UI de aprobar/rechazar) + reportes de `spend_history`/tendencias + wiring de los triggers del cap 04.

Total realista: **M-L** repartido en 3 incrementos entregables (receiving parcial primero, requisiciones+last-price después, aprobaciones+spend al final).

Dependencias:
- **Cap 04 motor de automatizaciones** — para requisición automática y auto-PO (sin él, el flujo es manual pero funcional).
- **Cap 04 catálogo externo** — para precio/disponibilidad en vivo (mock cubre el interino).
- **RBAC por scopes** (ya existe) — agregar los tres scopes de purchasing.
- **`Vendor`, `Part`, `PartStockMovement`, hook de inventario** — ya existen, sin dependencia bloqueante.
- **Alembic** — el proyecto ya lo usa; una revisión aditiva.

## 9. Ejemplo end-to-end con datos realistas

Escenario: taller "Journey Fleet Services", org `journey`. Se acaban los filtros de aceite Donaldson.

1. **Detección.** Una WorkOrder cierra y factura, consumiendo 4 filtros `P551000` (hook `wo_consume`). `Part P551000` baja de `on_hand=5` a `on_hand=1`, con `reorder_point=6`. El hook de inventario marca la parte como low-stock.
2. **Requisición automática (cap 04).** El trigger `part.low_stock` dispara `create_requisition`: nace `PurchaseRequisition(source='low_stock', part_number='P551000', qty=11, est_unit_cost=12.40, suggested_vendor_id=7 [Donaldson Direct])`. Qty sugerida = `reorder_point*2 - on_hand = 12 - 1 = 11`.
3. **Agrupación -> PO.** El cron diario junta las requisiciones abiertas y llama `group_requisitions_to_pos`. Hay 3 requisiciones del vendor Donaldson Direct (filtros de aceite, de aire, y separador de combustible). Se crea **PO #148** `draft`, vendor_id=7, con 3 líneas. Total: 11×$12.40 + 6×$34.10 + 3×$58.00 = $136.40 + $204.60 + $174.00 = **$515.00**.
4. **Armado con precios en vivo (cap 7).** Al abrir la PO, la UI consulta el catálogo externo: `P551000` muestra "En stock · $12.40 · Donaldson Direct" y el last-price-paid: "Última: $11.90 · hace 2 meses". El comprador ve la subida de $0.50 y la acepta.
5. **Aprobación.** El comprador envía la PO (`submit_po`). Como $515.00 >= umbral de $500 de la org, la PO pasa a `pending_approval` y se notifica al gerente (scope `purchasing.approve`). El gerente abre la PO y la **aprueba** -> `approved`, `approved_by_id=3`, `approved_at=...`.
6. **Emisión.** El gerente marca "Ordenar" (`mark_ordered`) -> `ordered`, y el trigger `po.ordered` envía la PO al vendor por email en 1 clic (estilo Fullbay).
7. **Recepción parcial.** Llegan solo 8 de los 11 filtros de aceite (3 en backorder), completos los otros dos ítems. En el modal de receiving: filtro aceite `qty_received=8`, filtro aire `6`, separador `3`. `receive_po` llama `inventory.adjust`:
   - `P551000`: `+8` -> `on_hand` pasa de 1 a **9** (movimiento `po_receive`, ref `po_line:412:1`).
   - filtro aire y separador: al 100%.
   - La línea de aceite queda `partial` (`qty_received 8 < qty 11`), la PO queda **`partial`**. `received_total` = 8×$12.40 + resto = $478.60.
8. **Backorder y cierre.** Días después llegan los 3 filtros restantes. Segunda recepción: `P551000 +3` (ref `po_line:412:2`, idempotente por el seq). `on_hand` = **12**, línea `received`, PO **`received`**, `received_total` = $515.00.
9. **Rastro auditable.** El reporte de spend muestra: Donaldson Direct, julio 2026, $515.00; y `last_price_paid('P551000', vendor 7)` ahora devuelve $12.40. La WorkOrder que originó el consumo, la requisición, la PO #148 y los movimientos de inventario quedan encadenados: se puede responder "¿por qué compramos estos filtros y cuánto pagamos la última vez?" en dos clics.
