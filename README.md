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

La app abre en el **Panel DVIR**: barra de menú arriba y una grilla con
los últimos informes, el top de conductores sin DVIR del mes y la vista
previa del bloque seleccionado.

Para generar un informe, pulsa **Crear DVIR Report**:

1. Arrastra los CSV de DVIR y de actividad (uno o varios días, una o
   ambas empresas).
2. La app los empareja por día y empresa; revisa la tabla y, si hace
   falta, corrige el **tag del día** de cada fila.
3. Pulsa **Crear DVIR Report** → se genera el Excel (una hoja por
   empresa, bloques diarios apilados) y se guarda en el panel.

Cada informe generado queda en la base de datos local (`backend/dvir.db`)
para alimentar el panel. El roster usa por defecto `roster.csv`.

El panel incluye además la **tendencia del mes** (% flota SAFE e
incidencias por día) y la **ficha de conductor** (clic en un conductor
del top sin DVIR). La sección **Defectos** lista todos los defectos
reportados en los DVIR, filtrables por empresa, estado y unidad.

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
