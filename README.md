# DVIR Report Generator

Aplicación local que produce el informe diario de inspecciones DVIR de la
flota. Cruza dos exportaciones CSV de Samsara con un roster
camión→conductor, muestra una **vista previa en pantalla** y genera el
Excel del bloque del día.

A partir de la **v0.2.0** es una app web local: un backend en Python
(FastAPI) con el motor de cruce, y una interfaz en React + TypeScript.

## Requisitos

- Windows
- [Python 3.x](https://www.python.org/downloads/)
- [Node.js LTS](https://nodejs.org/) (solo para compilar la interfaz)

Las dependencias se instalan solas la primera vez que se ejecuta.

## Uso

Doble clic en **`launch.bat`**. La primera vez instala dependencias y
compila la interfaz; después abre la aplicación en una ventana dedicada.

La app tiene dos pestañas:

**Informe diario** — un bloque de un día:

1. Arrastra el **CSV de DVIR** y el **CSV de actividad**.
2. Ajusta **Empresa**, **etiqueta del día** y **millas mín. activo**.
3. Pulsa **Generar informe** → vista previa → **Descargar Excel**.

**Lote mensual** — varios días y empresas de una vez:

1. Arrastra todos los CSV del periodo.
2. La app los empareja por día y empresa; revisa o corrige la tabla.
3. Pulsa **Generar workbook** → un Excel con una hoja por empresa y los
   bloques diarios apilados.

El roster usa por defecto `roster.csv`; en el modo diario se puede subir
otro desde la app.

## Lógica del informe

- **Duración** de un camión/tráiler = suma de todos sus DVIR del día.
- **Estado** mostrado = el del DVIR más reciente (por hora de firma).
- Varios tráilers de un conductor → filas de continuación; las celdas
  del lado del camión se fusionan verticalmente.
- **NO DVIR** = un camión que aparece en el CSV de actividad por encima
  del umbral de millas pero sin DVIR de camión ese día. El conductor se
  toma del roster.
- Las columnas `DOT Issues` y `Fullbay` se rellenan siempre con `YES`.

## Estructura del proyecto

```
backend/            API FastAPI + motor de cruce
  app/core/         duration, engine, excel
  app/api/          endpoints
frontend/           interfaz React + TypeScript (Vite)
  src/components/   FileDrop, PreviewTable
roster.csv          roster camión->conductor (editable)
launch.bat          lanzador
```

## Desarrollo

Backend (recarga en caliente):

```
cd backend
py -m uvicorn app.main:app --reload --port 8765
```

Frontend (servidor de Vite con proxy a la API):

```
cd frontend
npm install
npm run dev
```

## Versionado

El proyecto usa [Versionado Semántico](https://semver.org/lang/es/).
Los cambios se documentan en [`CHANGELOG.md`](CHANGELOG.md). El trabajo
nuevo se hace en ramas `feature/*` y cada release lleva su tag de git.
