# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es/1.1.0/)
y el proyecto usa [Versionado Semántico](https://semver.org/lang/es/).

## [No publicado]

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

[No publicado]: https://github.com/AdriGh/DVIR-Report-Generator/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/AdriGh/DVIR-Report-Generator/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AdriGh/DVIR-Report-Generator/releases/tag/v0.1.0
