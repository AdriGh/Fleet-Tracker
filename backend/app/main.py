"""Aplicacion FastAPI: API + frontend estatico."""

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, config
from .api.routes import router
from .core import alerts, auth


@asynccontextmanager
async def _lifespan(app: FastAPI):
    # Motor de alertas (G3): corre cada 60 s; no hace nada si no hay
    # reglas habilitadas. Se cancela limpio al apagar el server.
    task = asyncio.create_task(alerts.run_loop())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(title="DVIR Report Generator", version=__version__,
              lifespan=_lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.DEV_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----- Enforcement de autenticación (fase G7) ----------------------------
# Toda la API exige token salvo la allowlist (salud, login/setup/estado y
# el branding que necesita la pantalla de login). El frontend manda
# `Authorization: Bearer <token>` desde el wrapper de api.ts.
_AUTH_ALLOWLIST = {
    "/api/health",
    "/api/auth/status",
    "/api/auth/login",
    "/api/auth/setup",
    "/api/org/branding",
}
# Rutas que además exigen rol admin (la verificación fina vive en la
# propia ruta; esto es la barrera de entrada).
_ADMIN_PREFIXES = ("/api/auth/users", "/api/integrations/config")


@app.middleware("http")
async def _require_auth(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api/") and path not in _AUTH_ALLOWLIST:
        user = auth.user_from_header(
            request.headers.get("authorization"))
        if user is None:
            # Sin usuarios todavía (primer arranque): la API queda
            # abierta SOLO hasta crear el admin en el wizard.
            if auth.users_exist():
                return JSONResponse(
                    {"detail": "Not authenticated"}, status_code=401)
        elif (any(path.startswith(p) for p in _ADMIN_PREFIXES)
              and user["role"] != "admin"):
            return JSONResponse(
                {"detail": "Admin role required"},
                status_code=403)
    return await call_next(request)


app.include_router(router)


# Frontend compilado (frontend/dist). En desarrollo puede no existir; en
# ese caso se usa el servidor de Vite por separado.
_NO_CACHE = {"Cache-Control": "no-cache, no-store, must-revalidate"}


def _index_response():
    # index.html nunca se cachea: referencia a los assets con hash, que
    # se actualizan solos al recompilar.
    return FileResponse(config.FRONTEND_DIST / "index.html",
                        headers=_NO_CACHE)


if config.FRONTEND_DIST.exists():
    app.mount(
        "/assets",
        StaticFiles(directory=config.FRONTEND_DIST / "assets"),
        name="assets",
    )

    @app.get("/")
    def index():
        return _index_response()

    @app.get("/{path:path}")
    def spa_fallback(path: str):
        target = config.FRONTEND_DIST / path
        if target.is_file():
            return FileResponse(target)
        return _index_response()
else:
    @app.get("/")
    def index_dev():
        return {
            "message": "Frontend not built. Run 'npm run dev' in "
                       "frontend/ or 'npm run build' for the final version.",
            "api": "/api/health",
        }
