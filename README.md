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

1. Arrastra los CSV de DVIR, de actividad y del report de
   **Pre/Post-trip** (uno o varios días, una o ambas empresas). El de
   Pre/Post-trip es opcional: si falta, esas filas quedan como NO PRE-TRIP.
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

- **Pre-trip** (por conductor) = suma de los segmentos On Duty con remark
  "Pre-Trip Inspection" en sus logs de HoS, según el custom report de
  Samsara. Es lo que importa para DOT (no la duración del DVIR). Verde si
  ≥ 15 min, rojo si < 15 min, `⚠ NO PRE-TRIP` si no la registró. Los
  conductores sin Pre-trip se ordenan al fondo, junto con los NO DVIR.
- **Estado** mostrado = el del DVIR más reciente (por hora de firma).
- Varios tráilers de un conductor → filas de continuación; las celdas
  del lado del camión y la de Pre-trip se fusionan verticalmente.
- **NO DVIR** = un camión que aparece en el CSV de actividad por encima
  del umbral de millas pero sin DVIR de camión ese día. El conductor se
  toma del roster.
- **Distance (mi)** = millas recorridas por el camión ese día según el
  CSV de actividad (`0.0` si la unidad no aparece).

## Estructura del proyecto

```
backend/            API FastAPI + motor de cruce
  app/core/         engine, excel, pretrip (Pre/Post-trip de HoS)
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
