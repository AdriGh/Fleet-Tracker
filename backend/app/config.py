"""Configuracion y rutas del backend."""

import os
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent          # backend/app
BACKEND_DIR = APP_DIR.parent                       # backend
REPO_ROOT = BACKEND_DIR.parent                     # raiz del repo

DEFAULT_ROSTER = REPO_ROOT / "roster.csv"
FRONTEND_DIST = REPO_ROOT / "frontend" / "dist"
JOBS_DIR = BACKEND_DIR / ".jobs"                   # Excel generados (temp)

HOST = os.environ.get("DVIR_HOST", "127.0.0.1")
PORT = int(os.environ.get("DVIR_PORT", "8765"))

# Motor de base de datos. En produccion (nube) se setea DATABASE_URL a una
# Postgres, p.ej.  postgresql+psycopg://user:pass@host:5432/dvir
# Si no esta seteada, se cae a una SQLite local para desarrollo/tests.
_DEFAULT_SQLITE_URL = f"sqlite:///{BACKEND_DIR / 'dvir.db'}"


def _resolve_database_url() -> str:
    """Resuelve la URL de la base, en orden de prioridad:
    1) DATABASE_URL explicita (si alguien la setea a mano).
    2) Componentes POSTGRES_* (user/clave/host/db): se arma con
       sqlalchemy.URL.create, que CODIFICA caracteres especiales de la
       contraseña (@ : / ...). Antes pegabamos la clave cruda en la URL y una
       contraseña con '@' rompia el parseo del host (host quedaba '@db').
    3) SQLite local (dev/tests).
    """
    explicit = os.environ.get("DATABASE_URL")
    if explicit:
        return explicit
    user = os.environ.get("POSTGRES_USER")
    database = os.environ.get("POSTGRES_DB")
    host = os.environ.get("POSTGRES_HOST")
    if user and database and host:
        from sqlalchemy import URL
        return URL.create(
            "postgresql+psycopg",
            username=user,
            password=os.environ.get("POSTGRES_PASSWORD") or None,
            host=host,
            port=int(os.environ.get("POSTGRES_PORT", "5432")),
            database=database,
        ).render_as_string(hide_password=False)
    return _DEFAULT_SQLITE_URL


DATABASE_URL = _resolve_database_url()
IS_SQLITE = DATABASE_URL.startswith("sqlite")

# Origenes permitidos para CORS (servidor de desarrollo de Vite).
DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]

# Modo demo del ELD: usa datos sinteticos (core.demo_eld) en vez de Samsara.
# Si no se fuerza, se activa solo cuando no hay Samsara configurada.
DEMO_ELD = os.environ.get("FLEET_DEMO", "").strip().lower() in ("1", "true", "yes")

# Semillas opcionales para el PRIMER arranque (util en deploys de nube). Si el
# store de empresas/terminales esta vacio, se siembra una sola vez desde estas
# env vars; despues se gestiona todo desde Settings. Formato: JSON
# ([{key,label}] o lista de strings) o nombres separados por coma.
SEED_COMPANIES_RAW = os.environ.get("FLEET_COMPANIES", "")
SEED_TERMINALS_RAW = os.environ.get("FLEET_TERMINALS", "")

JOBS_DIR.mkdir(exist_ok=True)
