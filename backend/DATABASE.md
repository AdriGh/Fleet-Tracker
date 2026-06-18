# Base de datos — Fleet Tracker

Dev usa **SQLite** (sin configuración); producción usa **PostgreSQL** con
migraciones **Alembic**. El motor se elige por la env var `DATABASE_URL`
(`app/config.py`); sin ella se cae a `backend/dvir.db`.

## Dev (SQLite, por defecto)

No hay que hacer nada: la app crea/actualiza el esquema sola al arrancar
(`db.init_schema()` → `create_all` + migraciones aditivas de `_migrate()`).
Alembic no hace falta en dev.

## Producción (PostgreSQL)

1. Seteá la URL del motor:

       export DATABASE_URL="postgresql+psycopg://user:pass@host:5432/fleet"

2. Creá/actualizá el esquema con Alembic **antes** de arrancar la app:

       cd backend && alembic upgrade head

3. Arrancá la app. En Postgres **no** se hace `create_all`: el esquema lo
   maneja Alembic; la app solo asegura la organización `default`.

## Crear una migración nueva (tras cambiar los modelos en `db.py`)

    cd backend
    alembic revision --autogenerate -m "describe el cambio"
    # revisá el archivo generado en alembic/versions/ y luego:
    alembic upgrade head

## Notas

- La URL del motor la lee `alembic/env.py` de `app.config.DATABASE_URL`
  (misma selección que la app), así dev/prod usan el mismo flujo.
- En SQLite, Alembic corre en **modo batch** (recrea la tabla para los
  `ALTER` que SQLite no soporta).
- Importar `app.db` con `FLEET_SKIP_DB_INIT=1` carga solo la metadata sin
  tocar la base (lo usa Alembic al autogenerar/migrar).
- **Pendiente de H6**: migrar los `*.local.json/csv` de config/PII restantes
  a tablas/`OrgSetting`, `org_id` NOT NULL + Row-Level Security en Postgres,
  y un script de migración de datos SQLite→Postgres.
