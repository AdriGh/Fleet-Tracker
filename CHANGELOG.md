# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es/1.1.0/)
y el proyecto usa [Versionado Semántico](https://semver.org/lang/es/).

## [No publicado]

### Añadido
- Sección «Avisos» en el menú: detecta conductores con `NO DVIR` o con un
  DVIR de menos de 15 min (camión o tráiler) en un bloque del DVIR Report,
  arma el aviso por correo al conductor y calcula el CC según su terminal
  (CHASER / MDW Chicago / MEM Memphis / ATL Atlanta / SAV Savannah / MIA
  Miami). El email se cruza con la hoja «Driver info»; los conductores que
  no coinciden o sin terminal reconocida quedan en una lista «a revisar»
  en lugar de mandarse mal. Por ahora en modo offline (snapshot de la
  planilla) con envío simulado; la lectura en vivo de Drive (Service
  Account) y el envío real por Gmail (App Password) se activan con
  configuración local no versionada.

### Cambiado
- Umbral de duración de un DVIR: pasa de 10 a **15 minutos**. Por debajo se
  marca en rojo en el Excel y en la vista previa, y dispara aviso por correo.
  Centralizado en `engine.MIN_DURATION_SECONDS`.

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
