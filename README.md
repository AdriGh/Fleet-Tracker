# Generador de Informe DVIR

Aplicación de escritorio que produce el informe diario de inspecciones
DVIR de la flota. Cruza dos exportaciones CSV de Samsara con un roster
camión→conductor y genera un Excel con el bloque del día.

## Requisitos

- Windows
- Python 3.x ([python.org](https://www.python.org/downloads/))
- Dependencias: `pandas`, `openpyxl` (se instalan solas la primera vez)

## Uso

Doble clic en **`Generar Informe DVIR.bat`**.

La primera vez instala las dependencias y abre la aplicación. En la
ventana:

1. **CSV de DVIR** — exportación de inspecciones (Driver Vehicle
   Inspection Reports).
2. **CSV de actividad** — reporte de actividad de vehículos de Samsara.
3. **CSV de roster** — asignación camión→conductor (`roster.csv`).
4. **Empresa** y **etiqueta del día** (ej. `5.18`).
5. **Millas mín. activo** — umbral para considerar que un camión circuló.
6. Pulsa **Generar informe**.

Se crea un `.xlsx` nuevo en la carpeta de salida.

## Lógica del informe

Para cada conductor del CSV de DVIR:

- **Duración** de un camión/tráiler = suma de todos sus DVIR del día.
- **Estado** mostrado = el del DVIR más reciente (por hora de firma).
- Varios tráilers de un conductor → filas de continuación; las celdas
  del camión se fusionan verticalmente.
- **NO DVIR** = un camión que aparece en el CSV de actividad por encima
  del umbral de millas pero sin DVIR de camión ese día. El conductor se
  toma del roster.
- Las columnas `DOT Issues` y `Fullbay` se rellenan siempre con `YES`.

## Archivos

| Archivo | Función |
|---|---|
| `Generar Informe DVIR.bat` | Lanzador (doble clic) |
| `dvir_report.py` | Motor de cruce y escritura del Excel |
| `gui.py` | Interfaz de escritorio (Tkinter) |
| `roster.csv` | Roster camión→conductor (editable) |

## Mantenimiento del roster

`roster.csv` tiene dos columnas: `Truck,Driver`. Edítalo cuando cambien
las asignaciones de camión a conductor; lo usa la detección de NO DVIR
para poner el nombre del conductor.
