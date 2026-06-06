# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es/1.1.0/)
y el proyecto usa [Versionado Semántico](https://semver.org/lang/es/).

## [No publicado]

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
