# 07 — SquareRigger: paridad de UI y dónde Rigsmith gana (v2.22, oct-2026)

Fuente: recorrido de solo lectura de una cuenta real de SR (transportista con
taller propio), anonimizada — sin nombres de la cuenta, personas, unidades,
VINs ni proveedores — más el código de Rigsmith v2.22.0. Las capturas quedan
solo como referencia local (`docs/competitive/screenshots/` está fuera de git).
Nada se creó ni se guardó en SR. Continúa
[06 — SquareRigger por dentro](06-squarerigger-app-teardown.md).

El dueño fijó seis objetivos: en cada uno, igualar lo que SR hace bien y
ganarle donde falla.

| # | Objetivo | SR hoy | Rigsmith v2.22 |
|---|---|---|---|
| 1 | Editar una PO después de recibida / cerrada | Cerrada = qty, precio y flete deshabilitados; para corregir hay que **reabrir**, lo que des-recibe y saca las partes del inventario | Líneas y ajustes editables en cualquier status; el costo se corrige **revaluando** solo lo que sigue en stock, con preview y auditoría |
| 2 | PM del reefer por horas de motor | El PM "cada 1,500 hrs" se calcula contra el **odómetro** | Horómetro propio por unidad, vence por horas **o** fecha (lo que llegue primero) |
| 3 | Resources (Customers como owner-operators) | Perfil de customer flaco: sin unidades, sin historial, sin saldo | Perfil con unidades, WOs, partes cobradas, saldo y quick-add desde la WO |
| 4 | Reportes | Biblioteca (~44), viewer y builder muy prolijos; el chatbot solo busca en la documentación | Biblioteca de 49 + viewer + builder + envíos, **y** un asistente que arma reportes sobre los datos de la org |
| 5 | Home | Welcome, 4 KPIs, Quick Navigation, Work Orders, PMs Due & Overdue | Mismo layout, tarjeta de WOs más ancha, KPIs que abren la lista exacta |
| 6 | Sidebar | Grupos, colapso animado, flyouts, "+" y buscador | Igual (mismas medidas y curva) + pila de capas para Escape y versión móvil |

## 1. Purchase Orders después de recibir y cerrar

### Qué hace SR
- Statuses: Draft, Submitted, Receiving, Backorder, Pending Invoice, Closed
  (las cerradas se excluyen del listado por defecto).
- En una PO cerrada, "Edit Purchase Order" deja QTY, PRICE PER y SHIPPING
  COST **deshabilitados** y el Save también; solo cambia el Status. La única
  forma de corregir un costo es **reabrir**, y reabrir des-recibe: las partes
  desaparecen del inventario hasta volver a recibir (el dolor del dueño).
- Pestaña Financial: resumen (partes, subtotal, tax, flete, total, pagado,
  saldo) y "Add Adjustment" con descuento y pago; según el dueño, no se
  pueden agregar ajustes una vez cerrada.

### Qué hace Rigsmith
- **Dos ciclos separados**: la recepción (`status`: draft → ordered →
  received) y el financiero (`fin_status`: open ↔ closed). Cerrar y
  reabrir no tocan el stock ni congelan costos.
- **Todo sigue editable** a cualquier status: costo unitario, qty (nunca por
  debajo de lo recibido), taxable, descripción; ajustes de descuento,
  crédito, flete, tax, fee y pago (se anulan con motivo, nunca se borran).
- **Corregir un costo no saca nada del inventario**: si la línea ya tiene
  unidades recibidas se escribe un movimiento de costo (delta 0) y se
  revalúa el promedio ponderado **solo** por las unidades de esa recepción
  que siguen en stock (el consumo se reparte proporcionalmente, como manda
  el promedio móvil); lo ya consumido queda como varianza y las WOs
  facturadas no se reescriben.
- Los ajustes asignables (flete, tax, descuentos…) se reparten en el
  **landed cost** de cada línea y revalúan por el mismo camino.
- **Preview y confirmación** antes de tocar inventario ("Revalue N on-hand
  units — avg $X → $Y"), también cuando un cambio de qty o una línea nueva
  re-reparte los ajustes.
- Des-recibir existe, pero es por línea y explícito (no un efecto
  secundario de corregir un precio): revierte el promedio sin dejarlo en
  cero aunque parte de lo recibido ya se haya usado, y anula los cores
  pendientes.
- Backorder: lo corto se **mueve** a la PO hija (la original queda con lo
  que de verdad llegó), así nunca se recibe dos veces.
- Historia completa (auditoría por campo) y bitácora de recepción por línea.

**Dónde gana Rigsmith:** SR obliga a elegir entre un costo mal cargado o un
inventario que desaparece; acá el costo se corrige en el lugar, con el
impacto a la vista y sin reabrir.

## 2. PM del reefer por horas de motor

### Qué hace SR
- El equipo de frío muestra dos medidores: ENGINE HOURS y ODOMETER.
- El servicio "PM Reefer" se configura como PM por distancia con unidad
  `hrs`, cada 1,500 hrs y aviso a 150 hrs.
- Pero la unidad suscrita muestra el último y el próximo vencimiento **en
  millas del odómetro**: el intervalo en horas se evalúa contra el
  odómetro. En la práctica, el PM del reefer por horas no funciona.

### Qué hace Rigsmith
- **Horómetro propio por unidad** (`meter_reading`), separado del odómetro:
  el cost-per-mile nunca lee horas como millas.
- Lecturas manuales, desde la WO, desde el registro del PM y desde el feed
  del reefer (Lynx, Thermo King, Traccar), con reglas de plausibilidad (no
  baja más de 5 %, no más de 24 h por día) y **reseteo explícito** (cambio
  de controlador): una lectura forzada más baja abre un tramo nuevo del
  medidor en lugar de quedar tapada por la vieja.
- Campaña **Reefer PM (engine hours)**: 1,500 h con aviso a 150 h **o** 365
  días con aviso a 30, lo que llegue primero; sin horómetro, vence por
  fecha y lo dice (`meter_missing`). Se activa sola en los reefers.
- Tablero **Reefer PM**, tarjeta de horas en el perfil de la unidad,
  Service Requests "N hrs over", y la WO lleva las horas al registro del PM
  al facturar (aunque la WO combine DOT + Reefer PM del mismo trailer).

**Dónde gana Rigsmith:** el PM por horas se vence contra horas reales, con
fecha de respaldo y manejo de reseteos.

## 3. Resources

### Qué hace SR
- Grupo RESOURCES: Customers, Employees, Equipment, Locations, Parts,
  Services, Vendors (visibles según permisos).
- Customer: nombre, ciudad, "Since"; perfil con dirección, contactos y
  settings (tipo, términos, markups de partes y labor, exento de tax,
  códigos de tax, ID contable). **No** muestra unidades, ni historial de
  WOs o partes, ni saldo.
- En la WO, CUSTOMER Self | Customer con buscador y un "+" para crear el
  customer sin salir.
- Employees (rol, fecha de alta, tarifas, ubicación), Locations (tipo,
  código, dirección, contactos).

### Qué hace Rigsmith
- **Customers** pensado para el caso real del dueño: owner-operators cuyas
  unidades reciben partes y labor del taller que después se les cobran.
  Perfil con unidades propias (un dueño por unidad, backfill desde el campo
  "Who is the customer?"), WOs con estado de cobro, **partes cobradas**,
  cobrado en el año y **saldo abierto**, contactos con el de facturación,
  términos, markups e impuesto.
- **Bill to: Self | Customer** en la WO, por defecto el dueño de la unidad,
  con quick-add. Al facturar se **congelan** precios (markup) e impuesto:
  cambiar el markup después no reescribe invoices. Invoice impreso y por
  email con el Bill-To del customer. Unpaid/Paid con permiso de facturación.
- **Employees** (roster con rol, tarifa, contacto, WOs asignadas y horas /
  costo de labor de 30 días), **Locations** (tipo, código, dirección),
  **Vendors** con perfil de gasto (outside WOs, POs, partes) y **Drivers**.
- Búsqueda global (`/api/search`) sobre todas las WOs, equipos, customers,
  partes, vendors, requests, técnicos y conductores, con datos de contacto
  enmascarados sin permiso.

**Dónde gana Rigsmith:** el perfil del customer responde "qué unidades
tiene, qué se le hizo, qué se le cobró y cuánto debe" sin salir de la
pantalla.

**Pendiente:** catálogo de Services y Sales Orders (partes vendidas sin WO).

## 4. Reportes

### Qué hace SR
- Lista con pestañas Mine / Org / del sistema, búsqueda, favoritos; cada
  reporte con versión por defecto y cantidad de versiones (presets de
  período). Unos 44 reportes de sistema.
- Viewer: ★, ⓘ, "Add to Mine", Data | Charts, export PDF / CSV, envío
  programado, filtros, Σ totales, selector de columnas, orden por
  encabezado, chips de estado; Charts con tiles KPI y barras.
- Report Builder (beta): 41 fuentes con descripciones "One row per…",
  columnas con búsqueda y tipos, filtros con rango de tiempo y grupos,
  group & summarize, orden, totales, preview en vivo con tiempo de
  ejecución, Draft / Save.
- Su asistente solo responde preguntas y busca en la documentación del
  producto: **no arma reportes**.

### Qué hace Rigsmith
- **Motor de reportes** declarativo (26 fuentes con campos tipados y
  descripciones, filtros de dos niveles, presets en la zona horaria de la
  org, PII enmascarada sin permiso, timeout en Postgres).
- **Biblioteca de 49 reportes de sistema** en 8 categorías: los del
  catálogo de SR que los datos permiten (las aproximaciones lo dicen en su
  ⓘ) más los propios — Spend overview, Cost per mile con split
  partes/labor, PM compliance, Driver compliance, Reefer PM due (horas),
  Service requests backlog, Customer billing, Outside work by vendor,
  Parts revaluation log.
- Viewer y Builder al nivel de SR (versiones, favoritos, "Save as mine",
  Data | Charts, filtros, Σ, columnas, export PDF / CSV / XLSX, preview en
  vivo, group & summarize). Si el resultado se recorta por tamaño, el orden
  y los filtros de la vista corren en el server sobre todas las filas.
- Envíos programados (diario / semanal / mensual, hora de la org, CSV o
  XLSX) con estado real del envío y sin envíos dobles.
- **Ask Rigsmith**: el usuario escribe "costo de partes por unidad en los
  últimos 90 días" o "PMs de reefer vencidos por horas" y el asistente
  arma la spec sobre **los datos de su org** (nunca ve las filas: solo el
  catálogo de campos); el server la valida con el mismo motor y el builder
  la muestra con preview para ajustar y guardar.

**Dónde gana Rigsmith:** misma profundidad de biblioteca, viewer y builder,
más un asistente que construye el reporte en vez de mandar a leer la ayuda.

## 5. Home

### Qué hace SR
- "Welcome back, <nombre>", 4 KPIs (WOs en curso, completadas hoy, horas
  de Shop Watch de la semana, partes bloqueando WOs), Quick Navigation de 6
  tiles, tarjeta de Work Orders (donut por status + semana pasada vs esta)
  y "PMs Due & Overdue" con orden Days | Readings y chip de vencidos.

### Qué hace Rigsmith
- El mismo layout, con la tarjeta de Work Orders **más ancha** (donut,
  comparativa semanal de cerradas, valor, inside / outside, PM nuevos,
  requests, días promedio de cierre, gasto de partes y labor, facturado, y
  top 5 de unidades de la semana).
- Cada KPI abre la lista de WOs **con el mismo criterio del número**
  (p.ej. "completadas hoy" = cerradas hoy en la zona de la org, facturadas
  incluidas).
- PMs Due & Overdue mezcla millas (PM), días (DOT) y horas (reefer), con
  los vencidos siempre arriba.
- El tablero anterior (compliance, tendencias, alertas, cadena de frío)
  siguió como **Fleet overview** hasta la v2.23, que lo retiró: compliance
  vive en DVIR, la cadena de frío en Cold Chain y las alertas llegan como
  toasts y email/SMS (sin historial en la app).

## 6. Sidebar y navegación

### Qué hace SR
- Grupos WORK / RESOURCES / INSIGHTS / ADMIN plegables; 256 px ↔ 70 px con
  `width .3s cubic-bezier(0,0,.2,1)` y etiquetas recortadas (sin fade).
- Colapsado: los grupos de recursos se vuelven un ícono con flyout a la
  derecha, tooltips, y un botón ⚡ con las acciones del encabezado.
- Encabezado: "+" Add New (menú de altas) y Search = command menu
  ("Type a command or search…", Go to / Add New / tema / logout + búsqueda
  de registros agrupada).

### Qué hace Rigsmith
- Las mismas medidas, curva y comportamiento (un solo árbol DOM para ambos
  estados, flyouts y tooltips en portal, ⚡, estado persistido,
  `prefers-reduced-motion`).
- "+" Add New con 11 altas que abren el registro creado; command palette
  con Ctrl/⌘+K, búsqueda en el server y Enter que nunca abre un resultado
  de la búsqueda anterior.
- Pila de capas para Escape (cierra solo la de arriba: menú, flyout,
  palette, modal, drawer móvil) y "+" / Search también en la barra móvil.

## Qué queda para la próxima vuelta
- **Services** (catálogo de trabajos con partes y labor) y **Sales Orders**.
- **Time tracking** (el equivalente a Shop Watch / Team Clocks): hoy las
  horas de labor salen de las líneas de labor de las WOs.
- Employees como tabla (FK desde la WO y la línea de labor, tarifas por
  técnico).
- Impuesto por línea / códigos de tax múltiples (hoy: una tasa del
  customer sobre las partes).
