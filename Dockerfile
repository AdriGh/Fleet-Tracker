# Fleet Tracker — imagen unica que sirve API (FastAPI) + frontend compilado.
#
# El backend ya monta el frontend de frontend/dist y hace SPA-fallback a
# index.html (ver backend/app/main.py), asi que un SOLO contenedor alcanza:
# se compila el frontend en una etapa y la etapa final lo copia junto al
# backend, preservando el layout REPO_ROOT/frontend/dist relativo a backend/
# para que config.FRONTEND_DIST resuelva.

# ---------------------------------------------------------------------------
# Etapa 1: build del frontend (Node) -> /repo/frontend/dist
# ---------------------------------------------------------------------------
FROM node:22-alpine AS frontend
WORKDIR /repo/frontend

# Primero solo los manifests para cachear `npm ci` mientras el codigo cambia.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# Resto del codigo del frontend y build (tsc -b && vite build) -> dist/.
COPY frontend/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Etapa 2: runtime (Python) -> sirve API + dist
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS runtime

# No escribir .pyc y log sin buffer (mejor para contenedores).
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# Dependencias de sistema: las wheels de pypdfium2/psycopg[binary]/pandas
# traen sus binarios, asi que no hace falta toolchain de compilacion. Solo
# curl para el HEALTHCHECK.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencias de Python primero (capa cacheable).
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install -r /app/backend/requirements.txt

# Codigo del backend.
COPY backend/ /app/backend/

# Frontend compilado de la etapa 1, en el layout que espera config.py:
# config.REPO_ROOT = /app, asi config.FRONTEND_DIST = /app/frontend/dist.
COPY --from=frontend /repo/frontend/dist /app/frontend/dist

# El server corre desde backend/ (uvicorn importa app.main, que ejecuta
# init_schema() -> create_all en el arranque, idempotente).
WORKDIR /app/backend
EXPOSE 8000

# Healthcheck contra el endpoint publico /api/health (en la allowlist de auth).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
