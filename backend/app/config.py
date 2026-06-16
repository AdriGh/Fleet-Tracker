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
DATABASE_URL = os.environ.get("DATABASE_URL", _DEFAULT_SQLITE_URL)
IS_SQLITE = DATABASE_URL.startswith("sqlite")

# Origenes permitidos para CORS (servidor de desarrollo de Vite).
DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]

# Modo demo del ELD: usa datos sinteticos (core.demo_eld) en vez de Samsara.
# Si no se fuerza, se activa solo cuando no hay Samsara configurada.
DEMO_ELD = os.environ.get("FLEET_DEMO", "").strip().lower() in ("1", "true", "yes")

JOBS_DIR.mkdir(exist_ok=True)
