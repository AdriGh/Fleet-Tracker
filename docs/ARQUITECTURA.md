# Arquitectura — Fleet Tracker

Este documento describe la arquitectura **real** de Fleet Tracker (SaaS de mantenimiento de flota: FastAPI + React/Vite + Postgres), tal como existe hoy en el repositorio `DVIR-Report-Generator` (versión `1.29.0`, `backend/app/__init__.py:3`). Su propósito es dar contexto fiel a futuros agentes de IA para que trabajen sin inventar estructura ni repetir errores ya cometidos. Es descriptivo del estado actual, no aspiracional: la sección final ["QUÉ NO EXISTE"](#7-qué-no-existe-piezas-ausentes-y-deuda) enumera con honestidad lo que falta. El nombre del repo es legacy ("DVIR Report Generator"); el producto creció a un sistema de mantenimiento/flota completo, pero el `FastAPI(title=...)` aún dice "DVIR Report Generator" (`backend/app/main.py:27`).

> Docs hermanos: [CONVENCIONES.md](CONVENCIONES.md) · [DECISIONES.md](DECISIONES.md) · [GLOSARIO.md](GLOSARIO.md) · [FLUJO-DE-TRABAJO.md](FLUJO-DE-TRABAJO.md) · [ERRORES-CONOCIDOS.md](ERRORES-CONOCIDOS.md) · [ROADMAP-SEGURIDAD.md](ROADMAP-SEGURIDAD.md) · [AUDITORIA.md](AUDITORIA.md)

---

## 1. Stack exacto (con versiones reales)

### Backend (`backend/requirements.txt`, Python 3.12 según `Dockerfile:26`)

| Área | Paquete | Uso real en este proyecto |
|------|---------|---------------------------|
| Web/ASGI | `fastapi>=0.115`, `uvicorn[standard]>=0.34` | App y servidor; un solo proceso uvicorn sirve API + SPA |
| ORM | `sqlalchemy>=2.0` | Estilo 2.0 (`Mapped`/`mapped_column`); toda la persistencia en `db.py` |
| Migraciones | `alembic>=1.13` | Cableado pero **parcial** — una sola migración (ver §7) |
| Driver DB | `psycopg[binary]>=3.2` (psycopg3, Postgres prod), SQLite stdlib (dev) | `postgresql+psycopg://...` |
| Excel | `pandas>=2.2` + `openpyxl>=3.1` | Parsing/generación de Excel — núcleo del generador DVIR |
| PDF | `pypdf>=4` + `pypdfium2>=4` | Render/lectura de invoices para el escaneo |
| LLM vision | `anthropic>=0.100` | Escaneo de invoices (`core/docscan.py`); también rutas Ollama y Groq por HTTP |
| Google | `google-api-python-client>=2.130`, `google-auth>=2.30` | Google Sheets |
| HTTP / media | `httpx>=0.27` (clientes ELD/REST), `boto3>=1.34` (S3/host de media), `python-multipart` (uploads) | |
| Validación | **Pydantic** (vía FastAPI) | Solo ~6 modelos en `backend/app/schemas.py` — cobertura mínima (ver §7) |

### Frontend (`frontend/package.json`)

| Área | Paquete | Notas |
|------|---------|-------|
| UI | **React 19.2** + react-dom 19.2 | |
| Lenguaje/build | **TypeScript ~6.0**, **Vite 8** (`@vitejs/plugin-react 6`) | build = `tsc -b && vite build` |
| Estado servidor | `@tanstack/react-query 5.101` | `staleTime` 60s (`main.tsx`) |
| Mapa | `maplibre-gl 5.24` + `react-map-gl 8.1` | Live Map, lazy-loaded |
| Interacción | `@dnd-kit/*` (kanban del Maint Board), `sonner` (toasts), `vaul` (drawers) | |
| Fuentes | `@fontsource-variable/{inter,geist,space-grotesk}` | self-hosted |
| Lint | ESLint 10 + typescript-eslint 8 | |
| Routing | **Ninguno** | No hay react-router (ver §3) |

### Infra

Docker multi-stage (`node:22-alpine` build → `python:3.12-slim` runtime), `docker-compose.yml` con `postgres:16-alpine`, desplegado en Dokploy/VPS detrás de Traefik.

---

## 2. Árbol de carpetas con propósito

### Backend (`backend/`)

```
backend/
├── app/
│   ├── __init__.py          # __version__ = "1.29.0"
│   ├── config.py            # rutas, _resolve_database_url (Postgres por componentes / SQLite), CORS, flags
│   ├── main.py              # FastAPI: middleware auth+RBAC, mount del frontend, SPA fallback, lifespan (loop alertas)
│   ├── db.py                # ~42KB — TODA la persistencia: 23 modelos ORM + ops + init/migrate + tenant scoping
│   ├── schemas.py           # ~6 modelos Pydantic (batch/health/roster/notify) — cobertura mínima
│   ├── api/
│   │   └── routes.py        # ~79KB — 132 endpoints, TODOS en un archivo; stores _jobs/_batches en memoria
│   └── core/                # 62 módulos: mezcla de servicios + adapters + helpers (NO es capa homogénea)
│       ├── auth.py          # usuarios, pbkdf2-sha256 (200k iters), tokens HMAC stateless (TTL 30d)
│       ├── tenant.py        # ContextVar de org_id (multi-tenant H6); bind_tenant (dependencia global)
│       ├── permissions.py   # RBAC: roles → scopes
│       ├── secretstore.py   # abstracción de secretos (FileSecretStore → *.local.json)
│       ├── alerts.py        # motor de alertas en background loop (60s)
│       ├── engine.py, batch.py, excel.py, reports.py, pretrip.py, open_defects.py   # núcleo DVIR/reportes
│       ├── workorders.py, wo_invoice.py, wo_invoices.py, maint.py, pm.py, parts.py,
│       │   purchasing.py, inventory.py, parts_marketplace.py                         # mantenimiento/WO/partes/inventario
│       ├── docscan.py       # escaneo de invoices con LLM vision (Anthropic/Ollama/Groq)
│       ├── samsara.py, lynx.py, thermoking.py, traccar.py, tracking.py, reefer*.py, demo_eld.py  # integraciones ELD/reefer
│       ├── notify*.py, mailer.py, sms_service.py, telegram_notify.py, teams.py       # canales de aviso
│       ├── companies.py, terminals.py, org_config.py, app_config.py, unit_settings.py  # config de negocio
│       └── providers/       # framework de adapters ELD (registry autodescriptivo)
│           ├── __init__.py            # TelematicsProvider ABC + registry() + provider activo
│           ├── samsara_provider.py
│           └── motive_provider.py
├── alembic/                 # migraciones — env.py + UNA sola versión inicial
│   └── versions/a518e3d89977_initial_schema.py   # crea 16 tablas (modelos actuales = 23)
├── scripts/                 # utilidades sueltas (reset_password, make_wo_form, make_icon, test_email)
├── uploads/                 # invoices subidos (bind-mount en prod)
├── .jobs/                   # Excel temporales generados (bind-mount en prod)
├── data/                    # pois_seed.json, sample data
├── dvir.db                  # SQLite local de dev (commiteada)
└── *.example.json / *.local.json  # plantillas y secretos por integración
```

**Observación clave**: `core/` NO es una capa de servicios homogénea — mezcla servicios de dominio (`workorders.py`), adapters de integración (`samsara.py`), framework (`providers/`) y helpers (`duration.py`). No existe la separación `services/ | repositories/ | integrations/`. El acceso a datos vive directo en `db.py`, no en repositorios. Esto contradice la estructura por dominio que recomienda [CONVENCIONES.md](CONVENCIONES.md); es deuda consciente, no un objetivo.

### Frontend (`frontend/src/`)

```
src/
├── main.tsx                 # entry: QueryClient (staleTime 60s) + StrictMode
├── App.tsx                  # ~23KB — shell: sidebar nav, auth gating, switch de vistas por useState (sin router)
├── api.ts                   # ~69KB — cliente API COMPLETO (shadow de fetch con Bearer + manejo de 401)
├── index.css                # ~235KB — TODO el CSS en un archivo
├── views/                   # 19 páginas: Dashboard, WorkOrdersPage, SettingsPage, MapPage, ReportsPage,
│   │                        #   PartsPage, PurchaseOrdersPage, MaintBoardPage, DvirPage, DefectsPage,
│   │                        #   FleetPage, DriversPage, ReeferPage, UnitProfilePage, NotifyPage,
│   │                        #   RosterPage, LoginPage, OnboardingWizard, MarketplacePanel
│   └── ...
├── components/              # ~31 componentes (modales, charts SVG propios, TruckDiagram, reports)
│   └── ds/                  # design system mínimo: Button, Card, Badge, Input, Tabs, StatCard, NavItem, StatusPill...
├── perms.ts, terminal.ts, teams.ts, toast.ts, clipboard.ts   # utilidades cliente
├── defectAnalysis.ts, defectGroups.ts, truckZones.ts         # lógica de dominio DVIR DUPLICADA en cliente
└── dist/                    # build (lo sirve el backend en prod)
```

---

## 3. Flujo de datos request → response y servido del frontend

### Cómo se sirve el frontend (StaticFiles + SPA)

Un solo proceso uvicorn sirve API y SPA (`backend/app/main.py:138-162`). Si `frontend/dist` existe (prod / imagen Docker):

- `/assets` → `StaticFiles` (assets con hash, cacheables) — `main.py:139-143`.
- `/` → `index.html` con `Cache-Control: no-cache` (`main.py:145-147`, `_index_response` en `:131-135`).
- `/{path:path}` → si es archivo en `dist`, lo sirve; si no, **SPA fallback** a `index.html` (`main.py:149-154`).

En **dev sin build**, `/` devuelve un JSON guía (`main.py:156-162`) y el frontend corre en Vite (`:5173`) con proxy `/api → 127.0.0.1:8765` (`vite.config.ts`). El backend de dev escucha en `127.0.0.1:8765` (`config.py:14-15`).

**Routing del cliente**: NO hay react-router. `App.tsx:215` usa `const [section, setSection] = useState('dashboard')` y renderiza la vista por un switch; `navigate(id)` también cierra el perfil de unidad superpuesto (`App.tsx:217-220`). Consecuencia: **no hay URLs profundas ni back/forward del navegador** entre secciones — la navegación es estado en memoria.

### Request a la API → response

1. **Cliente** (`frontend/src/api.ts:21-34`): un *shadow* del `fetch` global, local a `api.ts`, inyecta `Authorization: Bearer <token>` (token en `localStorage['ft-token']`). Un `401` limpia el token y dispara el evento `ft-unauthorized` → `App.tsx` vuelve al login.
2. **CORS** (`main.py:30-35`): solo orígenes de Vite dev (`config.DEV_ORIGINS`, `config.py:55`); sin `allow_credentials` (la API usa Bearer, no cookies).
3. **Middleware `_require_auth`** (`main.py:95-118`): para todo `/api/*` salvo la allowlist (`health`, `auth/status|login|setup`, `org/branding` — `main.py:41-47`), resuelve el usuario del token (`auth.user_from_header`), fija `request.state.user` / `request.state.org_id`, y aplica **RBAC por scope** vía `_scope_for(method, path)` (`main.py:48-92`). Reglas: **GET nunca exige scope**; las escrituras mapean a scopes (`settings.manage`, `maint.edit`, `wo.invoice`, `fleet.edit`, `alerts.manage`, `pii.view`, etc.). Antes de crear el primer usuario, la API queda abierta solo hasta completar el wizard (`main.py:106-111`).
4. **Dependencia global `bind_tenant`** (`tenant.py`, montada en `main.py:123`): copia `org_id` a un `ContextVar` para el contexto del endpoint.
5. **Endpoint** en `api/routes.py` → llama a `core/*` → `db.py`.
6. **Aislamiento multi-tenant automático** (`db.py:474-500`): dos eventos SQLAlchemy:
   - `_assign_org_on_insert` (`before_flush`, `:474-483`): rellena `org_id` en inserts de modelos `OrgScoped` desde el `ContextVar`.
   - `_scope_select_to_org` (`do_orm_execute`, `:486-500`): filtra **todos los SELECT** (incluidos los de `session.get()`) con `with_loader_criteria`. Excluye `is_column_load` e `is_relationship_load`.
   - Si no hay tenant en contexto (loop de alertas, scripts, seeding), no completa ni filtra (`:478-480`, `:491-493`).

### Caso especial — generación de reportes / Excel

`api/routes.py:47-50` mantiene stores **en memoria del proceso**: `_jobs: dict` (Excel generados, `id → {path, filename}`) y `_batches: dict` (sesiones de lote). La descarga de un reporte busca en `_jobs`. **Esto no sobrevive a un reinicio ni escala a múltiples réplicas** (ver §7). La generación de Excel y el escaneo LLM corren **inline en el request**, no en un worker.

---

## 4. Modelo de despliegue

### Contenedor único (`Dockerfile`)

- **Etapa 1** (`node:22-alpine`, `Dockerfile:12-21`): `npm ci` + `npm run build` → `/repo/frontend/dist`.
- **Etapa 2** (`python:3.12-slim`, `:26-62`): instala `requirements.txt`, copia el backend a `/app/backend`, y copia el `dist` de la etapa 1 a `/app/frontend/dist` (layout que `config.FRONTEND_DIST` espera, porque `config.REPO_ROOT = /app`).
- uvicorn corre desde `/app/backend` sirviendo API + SPA en `:8000` (`CMD`, `:62`). `HEALTHCHECK` con `curl /api/health` (`:59-60`).
- **No baja privilegios**: no hay `USER` → el proceso corre como **root** (deuda de seguridad, ver [ROADMAP-SEGURIDAD.md](ROADMAP-SEGURIDAD.md)).

### Postgres y compose (`docker-compose.yml`)

- `postgres:16-alpine`, volumen `pgdata`, healthcheck `pg_isready`; `app` espera `service_healthy` (`:33-35`).
- Credenciales **por componentes** (`POSTGRES_USER/PASSWORD/DB/HOST/PORT`, `:41-45`); `config.py:_resolve_database_url` (`config.py:23-48`) arma la URL con `sqlalchemy.URL.create` para **codificar contraseñas con caracteres especiales** (fue el fix del bug `@db` — una clave con `@` rompía el parseo del host). Default a SQLite si no hay `POSTGRES_*`.
- **Riesgo**: los defaults son `${POSTGRES_PASSWORD:-fleet}` etc. — si el `.env` no se inyecta, Postgres arranca con `fleet/fleet` sin fallar (ver [AUDITORIA.md](AUDITORIA.md)).

### Secretos y persistencia

- Bind-mount `./secrets:/app/secrets` **read-write** (`FLEET_SECRETS_DIR`, `docker-compose.yml:52,70`): la app autogenera ahí el `auth_secret` que firma los tokens en el primer login. Sin él, el login da 500. Los `*.local.json` están en **texto plano** (cifrado en reposo pendiente).
- Bind-mounts de datos: `./data/uploads` y `./data/jobs` (`:61-62`).

### Dokploy / VPS

Detrás de Traefik: normalmente **no publica el puerto**; enruta por dominio al `:8000` del contenedor (`docker-compose.yml:53-57`). Deploy "autodeploy On Push" (sin pipeline de pruebas que bloquee).

### Esquema en el arranque (importante)

`init_schema()` (`db.py:652-675`) corre **al importar `db.py`** (`db.py:681-682`, salvo `FLEET_SKIP_DB_INIT`): ejecuta `Base.metadata.create_all` (idempotente: crea tablas faltantes desde los modelos, **no altera tablas existentes**) + `ensure_default_org()`. **`_migrate()` (ALTER TABLE ad-hoc) corre SOLO en SQLite** (`db.py:674`); su DDL usa `PRAGMA`/`ALTER` específicos de SQLite. **Alembic NO se ejecuta en el arranque.** Implicación crítica: en Postgres con datos, una columna nueva en una tabla existente **no se aplica sola** (ver §7).

---

## 5. Diagrama del sistema

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            VPS Hostinger (Dokploy)                         │
│                                                                            │
│   Internet ──HTTPS──► Traefik (TLS / Let's Encrypt, enruta por dominio)    │
│                            │                                               │
│            ┌───────────────┴────────────────────────┐                     │
│            ▼ (red interna Docker, puerto NO publicado)                     │
│   ┌─────────────────────────── contenedor app (:8000) ──────────────────┐ │
│   │  uvicorn  ──►  FastAPI (app.main)                                     │ │
│   │                  │                                                    │ │
│   │   ┌──────────────┴───────────────┐                                   │ │
│   │   ▼ ruta /api/*                   ▼ resto de rutas                    │ │
│   │  CORS ► _require_auth (token+RBAC por scope)   StaticFiles /assets    │ │
│   │          │                                      + SPA fallback        │ │
│   │          ▼                                      → index.html          │ │
│   │   bind_tenant (ContextVar org_id)              (frontend/dist)        │ │
│   │          │                                                            │ │
│   │          ▼                                                            │ │
│   │   api/routes.py (132 endpoints)  ──►  core/* (servicios/adapters)     │ │
│   │          │  ▲                              │                          │ │
│   │  _jobs/_batches (en memoria)              ▼                          │ │
│   │   loop alertas (asyncio 60s)        db.py (SQLAlchemy ORM)            │ │
│   │                                       │  eventos: assign_org / scope  │ │
│   └───────────────────────────────────────┼──────────────────────────────┘ │
│                                            ▼                                │
│   ┌─────────────────────── contenedor db ─────────────────────────────┐    │
│   │  postgres:16-alpine   (volumen pgdata)                             │    │
│   └────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│   Bind-mounts host: ./secrets (rw, auth_secret + creds)                    │
│                     ./data/uploads (invoices)  ./data/jobs (Excel)         │
└──────────────────────────────────────────────────────────────────────────┘

Integraciones salientes (HTTP, desde core/*):  Samsara/Motive (ELD) · Lynx/ThermoKing/Traccar (reefer/GPS) ·
   Anthropic/Ollama/Groq (LLM vision) · Google Sheets · email/SMS/Telegram/Teams (avisos) · S3/media host

Cliente (navegador): React SPA · sin router (useState) · react-query · token en localStorage['ft-token']
```

---

## 6. Cómo encaja todo (resumen para un agente nuevo)

- **Una request de escritura** entra por Traefik → uvicorn → CORS → `_require_auth` (valida token + scope) → `bind_tenant` (fija el `ContextVar`) → endpoint en `routes.py` → función en `core/*` → `db.py`. Los eventos ORM completan y filtran `org_id` automáticamente: **no pases `org_id` a mano en SELECTs**.
- **Para tocar el dominio**, busca primero el módulo en `core/` (un módulo por área: `workorders.py`, `parts.py`, `inventory.py`, `reports.py`...), no en `routes.py` (que solo orquesta) ni directamente en `db.py` (que es persistencia + modelos).
- **El frontend** llama todo vía `api.ts`; no agregues `fetch` crudo a la API (perderías el Bearer y el manejo de 401). Las vistas viven en `src/views/`, los componentes compartidos en `src/components/` (y `components/ds/` para el design system).
- **Cuidado**: hay lógica de dominio DVIR duplicada en el cliente (`defectAnalysis.ts`, `defectGroups.ts`, `truckZones.ts`) y en el backend; cambios de reglas deben revisarse en ambos lados.

---

## 7. QUÉ NO EXISTE (piezas ausentes y deuda)

Sección honesta. Lo que sigue **no está implementado**; no asumas que existe. Severidad orientativa para priorizar.

| Pieza | Estado | Severidad | Detalle |
|-------|--------|-----------|---------|
| **Capa de servicios / repositorios formal** | NO | Media | `core/` es un cajón de sastre (dominio + adapters + framework + helpers). El acceso a datos vive en `db.py` junto a los 23 modelos. `routes.py` es un monolito de 132 endpoints en un archivo. Lógica DVIR duplicada en el cliente. |
| **Tests automatizados** | NO | **Alta** | Cero unit/integration/e2e. El único `test_*.py` es `backend/scripts/test_email.py` (script manual, no pytest). No hay `pytest.ini`, `conftest.py`, vitest/jest. Verificación 100% manual. |
| **CI/CD** | NO | **Alta** | No existe `.github/workflows`. "Autodeploy On Push" en Dokploy sin gate de build/lint/test. Un error TS que `tsc --noEmit` no atrapa rompe el `docker build` en el VPS (lección documentada en CHANGELOG v1.28.1). |
| **Migraciones reales aplicadas** | PARCIAL / a la deriva | **Alta** | Alembic tiene **una** migración (`a518e3d89977_initial_schema`, 16 tablas); los modelos actuales son **23** — faltan al menos `purchase_order`, `po_line`, `part_stock_movement`. Producción confía en `create_all` (`db.py:652-675`), que NO altera tablas existentes. `_migrate()` ad-hoc es **solo SQLite** (`db.py:674`): en Postgres una columna nueva sobre datos existentes no se aplica sola. |
| **Backups de la base** | NO | **Alta** | `docker-compose.yml` solo tiene el volumen `pgdata`; no hay `pg_dump`, cron ni snapshots. Pérdida total ante `down -v` o fallo del VPS (datos de cumplimiento DOT). |
| **Row-Level Security (Postgres)** | NO (planeada fase 3c-2) | Media-Alta | El aislamiento es solo a nivel app (eventos SQLAlchemy). `org_id` sigue `nullable=True` (`db.py:38-47`). Si se pierde el `ContextVar` (p.ej. tareas de fondo), se filtran/escriben datos cross-tenant. **Además, `UPDATE`/`DELETE` Core NO se filtran por org** (el guard solo intercepta `is_select`) — IDOR de escritura real hoy (ver `core/alerts.py` `ack_events`). |
| **Constraints de unicidad multi-tenant** | NO | **Alta** | No hay `UniqueConstraint` en partes, movimientos de stock, contador de invoices ni `child_seq` → race conditions reales (números de factura duplicados, doble descuento de stock). `User.username` es `unique=True` **global**, rompe el modelo multi-tenant. Ver [AUDITORIA.md](AUDITORIA.md). |
| **Rate limiting / lock-out de login** | NO | Media | No hay slowapi ni throttling. `auth.py` tiene timing uniforme contra enumeración pero sin límite de intentos. Lo único es atrapar `anthropic.RateLimitError` del LLM. |
| **Cache de servidor** | NO | Baja | Solo cliente (react-query, staleTime 60s). Sin redis/`lru_cache`. `_jobs`/`_batches` son dicts en memoria del proceso. |
| **Colas / workers / jobs asíncronos** | NO | Media | No hay Celery/RQ/redis. El único background es `asyncio.create_task(alerts.run_loop())` en el lifespan (`main.py:16-24`, loop 60s). Excel y escaneo LLM corren inline. **Implica deploy single-replica obligado**: los stores en memoria y el loop se romperían/duplicarían con >1 instancia. |
| **Observabilidad** | NO | Media | Sin Sentry/OpenTelemetry/Prometheus ni logging estructurado. Solo el HEALTHCHECK de Docker y el log default de uvicorn a stdout. Diagnóstico ciego en prod. |
| **Cifrado de secretos en reposo** | NO | Media | `auth.py` declara pendiente keyring/DPAPI (G7.2). Los `*.local.json` (tokens Samsara, Groq, Twilio, Gmail SA) están en texto plano en el bind-mount, escritos como root. |
| **Validación de entrada con Pydantic** | Escasa | Media | Solo ~6 schemas en `schemas.py`; la mayoría de los 132 endpoints aceptan `dict`/`Query` sueltos sin modelo tipado (p.ej. `parts_create`/`vendors_create` reciben `body: dict`). Contrato de API débil. |
| **Connection pool afinado** | NO | Media | `create_engine` (`db.py:30`) usa el `QueuePool` por defecto sin `pool_pre_ping`/`pool_recycle` → conexiones stale en Postgres (errores `server closed the connection` intermitentes). |
| **Paginación real** | NO | Media | Listados con `limit` fijo y sin offset/cursor ni `total`; `list_parts`/`list_vendors` sin límite alguno. Reportes (`reports.spend_report`) cargan la tabla entera a memoria. |

### Bug latente de portabilidad a vigilar

`db.py` usa `func.strftime("%Y-%m", ...)` (agrupaciones mensuales en `month_summary`/`trends`/`driver_history`): **`strftime` es SQLite-only y falla en Postgres** (debería ser `to_char`/rango de fechas). Si en producción Postgres ves errores en esos reportes, es esto. Ver detalle y prioridad en [ERRORES-CONOCIDOS.md](ERRORES-CONOCIDOS.md) y [AUDITORIA.md](AUDITORIA.md).

### Riesgos prioritarios (orden de impacto)

1. **Migraciones a la deriva en Postgres** + autodeploy On Push → un cambio de columna se despliega pero rompe en runtime sin error de build.
2. **Cero tests + cero CI** con autodeploy a producción.
3. **Sin backups** de una base de datos LIVE de cumplimiento.
4. **Escrituras cross-tenant sin filtrar + sin RLS** con `org_id` nullable.
5. **Single-replica forzado** por stores en memoria y loop de alertas no distribuido.

---

### Rutas de referencia rápida

- `backend/app/main.py` — auth/RBAC (`:48-118`), servido del frontend (`:138-162`), lifespan (`:16-24`).
- `backend/app/config.py:23-48` — resolución de `DATABASE_URL`.
- `backend/app/db.py:474-500` — tenant scoping (eventos ORM); `:652-682` — `init_schema`/`_migrate`/import-time init.
- `backend/app/api/routes.py:47-50` — stores en memoria `_jobs`/`_batches`.
- `backend/app/core/providers/__init__.py` — framework de adapters ELD.
- `backend/alembic/versions/a518e3d89977_initial_schema.py` — la migración única.
- `frontend/src/App.tsx:215` — routing por `useState`.
- `frontend/src/api.ts:21-34` — fetch autenticado con Bearer.
- `Dockerfile` / `docker-compose.yml` — contenedor único + Postgres.
