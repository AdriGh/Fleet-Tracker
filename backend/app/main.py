"""Aplicacion FastAPI: API + frontend estatico."""

import asyncio
import os
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
    "/api/auth/logout",
    "/api/auth/setup",
    "/api/org/branding",
}
# SEC-1: escrituras (no-GET) que cualquier AUTENTICADO puede hacer (generar
# reportes DVIR). Se listan EXPLICITAMENTE para que el fallthrough de
# _scope_for sea fail-closed (admin-only) en vez de default-allow.
_AUTHONLY_WRITE = {
    "/api/batch/analyze",
    "/api/batch/generate",
}
def _scope_for(method: str, path: str) -> str | None:
    """Scope requerido para (method, path), o None si basta estar autenticado.
    La LECTURA (GET) nunca exige scope. Centraliza el RBAC fino (H4).

    El PATCH de una WO que pasa a 'invoiced' exige `wo.invoice` además del
    `maint.edit` de acá; ese refinamiento (depende del body) vive en la ruta
    `wo_patch`."""
    if method == "GET":
        return None
    # Administración (Company/org, usuarios, integraciones, terminales, equipos).
    # SEC-1: ampliado a /api/companies, /api/teams y a TODO /api/integrations
    # (antes solo /integrations/config, dejando /integrations/test y
    # /integrations/eld/active SIN scope -> los ejecutaba un viewer).
    if path.startswith(("/api/auth/users", "/api/org", "/api/terminals",
                        "/api/companies", "/api/teams", "/api/integrations")):
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
    # SEC-1: mapa (POIs + búsqueda Google que factura), import de reporting ELD
    # y borrado de bloques DVIR -> acción de flota (no para 'viewer').
    if path.startswith(("/api/pois", "/api/reporting", "/api/dvir")):
        return "fleet.edit"
    # Escrituras abiertas a cualquier autenticado (generar reportes DVIR).
    if path in _AUTHONLY_WRITE:
        return None
    # SEC-1 — FAIL-CLOSED: cualquier otra escritura no contemplada queda
    # admin-only. Antes caía en `return None` (default-allow) y un 'viewer'
    # ejecutaba mutaciones no enumeradas. 'settings.manage' solo lo tiene admin,
    # así que es un default seguro que NO rompe al admin si quedó alguna ruta
    # sin mapear. Toda ruta de escritura nueva debe declararse arriba.
    return "settings.manage"


@app.middleware("http")
async def _require_auth(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api/") and path not in _AUTH_ALLOWLIST:
        user = auth.user_from_request(request)
        # H6 fase 3: el tenant del request viaja en request.state; la
        # dependencia tenant.bind_tenant lo lleva al ContextVar dentro del
        # endpoint. Se setea aca (mismo scope) para que llegue al endpoint.
        request.state.user = user
        request.state.org_id = user["org_id"] if user else None
        if user is None:
            # SEC-2: sin sesión válida -> 401 SIEMPRE. Antes, si la tabla de
            # usuarios estaba vacía (primer arranque), la API quedaba ABIERTA
            # y la instancia era secuestrable. Ahora solo el allowlist
            # (auth/status, auth/setup, login, health, branding) responde sin
            # token, así que el wizard de onboarding sigue funcionando.
            return JSONResponse(
                {"detail": "Not authenticated"}, status_code=401)
        scope = _scope_for(request.method, path)
        if scope and not permissions.has_scope(user["role"], scope):
            return JSONResponse(
                {"detail": f"Your role ({user['role']}) can't do this"},
                status_code=403)
    return await call_next(request)


# ----- SEC-5: cabeceras de seguridad + CSP -------------------------------
# CSP calibrada al frontend REAL (build inspeccionado: NO hay <script> inline,
# fuentes self-hosted). Externos reales: images.unsplash.com (fondo del login) y
# tiles.openfreemap.org (mapa). maplibre crea su worker desde un blob: ->
# worker-src blob:. Los estilos inline de React/maplibre/sonner exigen
# style-src 'unsafe-inline' (bajo riesgo); script-src queda SIN 'unsafe-inline'
# — eso es lo que corta un XSS: un <script> inyectado NO ejecuta.
_CSP = (
    "default-src 'self'; "
    "base-uri 'self'; "
    "object-src 'none'; "
    "frame-ancestors 'none'; "
    "form-action 'self'; "
    "img-src 'self' data: blob: "
    "https://images.unsplash.com https://tiles.openfreemap.org; "
    "style-src 'self' 'unsafe-inline'; "
    "script-src 'self'; "
    "font-src 'self' data:; "
    "connect-src 'self' https://tiles.openfreemap.org; "
    "worker-src 'self' blob:; "
    "child-src 'self' blob:; "
    "manifest-src 'self'"
)
# Modo CSP por env, por si algo se coló en el piloto (rollback sin tocar código):
#   SEC5_CSP = on (default, enforce) | report (Report-Only, NO bloquea) | off
_CSP_MODE = os.environ.get("SEC5_CSP", "on").strip().lower()
_PERMISSIONS_POLICY = (
    "geolocation=(), camera=(), microphone=(), payment=(), usb=(), "
    "magnetometer=(), gyroscope=(), accelerometer=()"
)


@app.middleware("http")
async def _security_headers(request: Request, call_next):
    """SEC-5: cabeceras de seguridad en TODA respuesta (incl. 401/403 y los
    assets del SPA). Se registra DESPUÉS de _require_auth → queda como capa
    EXTERNA y cubre también las respuestas de error del auth."""
    response = await call_next(request)
    h = response.headers
    h.setdefault("X-Content-Type-Options", "nosniff")
    h.setdefault("X-Frame-Options", "DENY")
    h.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    h.setdefault("Permissions-Policy", _PERMISSIONS_POLICY)
    # HSTS solo si el cliente llegó por HTTPS (Traefik lo marca en
    # X-Forwarded-Proto). Sobre HTTP el navegador lo ignora; no lo mandamos
    # para no afirmarlo antes de confirmar el candado.
    if request.headers.get("x-forwarded-proto",
                           request.url.scheme) == "https":
        h.setdefault("Strict-Transport-Security",
                     "max-age=31536000; includeSubDomains")
    if _CSP_MODE == "on":
        h.setdefault("Content-Security-Policy", _CSP)
    elif _CSP_MODE == "report":
        h.setdefault("Content-Security-Policy-Report-Only", _CSP)
    return response


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
