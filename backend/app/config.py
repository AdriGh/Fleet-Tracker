"""Configuracion y rutas del backend."""

from pathlib import Path

APP_DIR = Path(__file__).resolve().parent          # backend/app
BACKEND_DIR = APP_DIR.parent                       # backend
REPO_ROOT = BACKEND_DIR.parent                     # raiz del repo

DEFAULT_ROSTER = REPO_ROOT / "roster.csv"
FRONTEND_DIST = REPO_ROOT / "frontend" / "dist"
JOBS_DIR = BACKEND_DIR / ".jobs"                   # Excel generados (temp)

HOST = "127.0.0.1"
PORT = 8765

# Origenes permitidos para CORS (servidor de desarrollo de Vite).
DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]

JOBS_DIR.mkdir(exist_ok=True)
