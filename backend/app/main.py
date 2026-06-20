"""Aplicacion FastAPI: API + frontend estatico."""

import asyncio
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, config
from .api.routes import router
from .core import alerts, auth, permissions, tenant


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
def _scope_for(method: str, path: str) -> str | None:
    """Scope requerido para (method, path), o None si basta estar autenticado.
    La LECTURA (GET) nunca exige scope. Centraliza el RBAC fino (H4).

    El PATCH de una WO que pasa a 'invoiced' exige `wo.invoice` además del
    `maint.edit` de acá; ese refinamiento (depende del body) vive en la ruta
    `wo_patch`."""
    if method == "GET":
        return None
    # Administración (Company, usuarios, integraciones, terminales, settings).
    if path.startswith(("/api/auth/users", "/api/integrations/config",
                        "/api/org", "/api/terminals")):
        return "settings.manage"
    # Work orders (POST/PATCH/DELETE). /send => facturar.
    if path.startswith("/api/workorders"):
        return "wo.invoice" if path.endswith("/send") else "maint.edit"
    # Avisos: envío real por email/SMS.
    if path.startswith("/api/notify/"):
        return "notices.send"
    # Mantenimiento: PM/DOT, parts, vendors, órdenes de compra (QuickBuy),
    # campañas/docs de unidad.
    if path.startswith(("/api/parts", "/api/vendors", "/api/purchase-orders",
                        "/api/maint/", "/api/pm/")):
        return "maint.edit"
    if path.startswith("/api/units/"):
        # /units/settings = device settings (flota); el resto (campaigns,
        # docs) es mantenimiento de la unidad.
        return ("fleet.edit" if path.startswith("/api/units/settings")
                else "maint.edit")
    # Dispatch / TMS.
    if path.startswith("/api/tms/"):
        return "tms.edit"
    # Flota: archivar, app settings.
    if path.startswith(("/api/fleet", "/api/settings")):
        return "fleet.edit"
    # Alertas de flota.
    if path.startswith("/api/alerts"):
        return "alerts.manage"
    # PII de conductores (editar email, sync de contactos).
    if path.startswith("/api/drivers"):
        return "pii.view"
    # Control remoto de reefers (setpoint/modo OEM vía Lynx): acción de flota.
    if path.startswith("/api/reefer/"):
        return "fleet.edit"
    return None


@app.middleware("http")
async def _require_auth(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api/") and path not in _AUTH_ALLOWLIST:
        user = auth.user_from_header(
            request.headers.get("authorization"))
        # H6 fase 3: el tenant del request viaja en request.state; la
        # dependencia tenant.bind_tenant lo lleva al ContextVar dentro del
        # endpoint. Se setea aca (mismo scope) para que llegue al endpoint.
        request.state.user = user
        request.state.org_id = user["org_id"] if user else None
        if user is None:
            # Sin usuarios todavía (primer arranque): la API queda
            # abierta SOLO hasta crear el admin en el wizard.
            if auth.users_exist():
                return JSONResponse(
                    {"detail": "Not authenticated"}, status_code=401)
        else:
            scope = _scope_for(request.method, path)
            if scope and not permissions.has_scope(user["role"], scope):
                return JSONResponse(
                    {"detail": f"Your role ({user['role']}) can't do this"},
                    status_code=403)
    return await call_next(request)


# bind_tenant corre para toda ruta de la API: fija el ContextVar de tenant
# (H6 fase 3) en el contexto del endpoint, donde corren las queries.
app.include_router(router, dependencies=[Depends(tenant.bind_tenant)])


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
