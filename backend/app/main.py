"""Aplicacion FastAPI: API + frontend estatico."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, config
from .api.routes import router

app = FastAPI(title="DVIR Report Generator", version=__version__)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.DEV_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
            "message": "Frontend sin compilar. Ejecuta 'npm run dev' en "
                       "frontend/ o 'npm run build' para la version final.",
            "api": "/api/health",
        }
