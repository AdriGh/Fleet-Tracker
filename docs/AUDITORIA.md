# AUDITORIA.md — Auditoría full-stack de Fleet Tracker

Documento de contexto para agentes de IA y mantenedores: una auditoría **profunda y honesta** de todo el stack de Fleet Tracker (FastAPI + React/Vite + Postgres), no solo de seguridad. Aterriza cada flaqueza a archivos y líneas reales del repo (`C:/Users/adrii/DVIR-Report-Generator`, v1.29.0, **LIVE en producción** en Dokploy/Hostinger VPS), con riesgo, fix propuesto y alternativas. Léelo junto a sus docs hermanos: ARQUITECTURA.md, CONVENCIONES.md, DECISIONES.md, GLOSARIO.md, FLUJO-DE-TRABAJO.md, ERRORES-CONOCIDOS.md y, sobre todo, ROADMAP-SEGURIDAD.md (que prioriza y agenda los fixes de aquí).

> **Para el agente:** las severidades reflejan que la app **ya está expuesta a internet con datos reales de pilotos**. No es un sandbox local. Antes de tocar auth, RBAC, multi-tenant o esquema, lee la sección correspondiente: hay invariantes frágiles (ContextVar de tenant, `create_all` sin Alembic, stores en memoria) que se rompen con cambios "inocentes".

---

## 1. Resumen ejecutivo

La base de Fleet Tracker está **por encima del vibecoding promedio**: PBKDF2-SHA256 200k con salt por usuario, `hmac.compare_digest` en password y token, RBAC server-side real, aislamiento multi-tenant de SELECT por eventos ORM, sin SQL injection (todo ORM parametrizado), secretos fuera de git en HEAD. Pero hay agujeros **críticos** explotables hoy y ausencias estructurales (cero tests, cero CI, sin backups, migraciones a la deriva) que impiden llamar a esto "production-grade" para un SaaS que apunta a reemplazar a Fullbay.

### Hallazgos priorizados

| ID | Sev | Área | Archivo:línea | Impacto | Fix | Esfuerzo |
|----|-----|------|---------------|---------|-----|----------|
| **SEC-1** | 🔴 Crítica | Seguridad/Auth | `main.py:48-92,113-117` | RBAC default-allow: cualquier `viewer` ejecuta mutaciones no enumeradas (crear/borrar companies, teams, cambiar ELD activo) | Invertir a fail-closed: todo no-GET sin scope → 403 | M |
| **DATA-1** | 🔴 Crítica | Datos/API | `alerts.py:372-382` + `db.py:486` | UPDATE/DELETE Core no filtra `org_id` → IDOR de escritura cross-tenant; `ack_events()` sin ids toca TODAS las orgs | Listener `is_update/is_delete` + filtro explícito + RLS | M |
| **DATA-2** | 🔴 Crítica | Datos/API | `org_config.py:203-212` | Contador de invoice read-modify-write sin lock → **números de factura duplicados** (problema contable/legal) | `UPDATE ... +1 RETURNING` atómico o `FOR UPDATE` | S |
| **SEC-2** | 🔴 Crítica | Seguridad/Auth | `main.py:106-111`, `routes.py:1120-1123` | Bootstrap "API abierta" sin usuarios → secuestro de la instancia en el primer arranque | Token de setup por env + cerrar API salvo allowlist | S |
| **OPS-1** | 🔴 Crítica | Deploy/Ops | historial git `97977bf`→`ca2627d` | PII real (`roster.csv`) recuperable del historial de git | `git filter-repo` + rotar remoto | M |
| **OPS-2** | 🔴 Crítica | Deploy/Ops | `db.py:681-682` | Esquema por `create_all`; sin Alembic operativo → columna nueva rompe en runtime Postgres (500 silencioso) | Alembic real en entrypoint, quitar `create_all` en PG | L |
| **OPS-3** | 🔴 Crítica | Deploy/Ops | `docker-compose.yml` (volumen `pgdata`) | Sin backups → pérdida total de datos de cumplimiento (DOT/DVIR) | `pg_dump` cron a almacenamiento externo + restore doc | M |
| **SEC-3** | 🟠 Alta | Seguridad/Auth | `routes.py:1155-1161`, `auth.py:159-173` | Sin rate-limit/lockout en login → fuerza bruta + DoS por costo PBKDF2 | slowapi por IP+cuenta + backoff/lockout | M |
| **FE-1 / SEC-4** | 🟠 Alta | Frontend/Auth | `api.ts:13-16`, `auth.py:33` | Token bearer 30 días en `localStorage`, sin revocación → robo por XSS, válido 1 mes | Cookie HttpOnly+Secure+SameSite o TTL corto+refresh+`token_version` | L |
| **DATA-3** | 🟠 Alta | Datos/API | `db.py:247` + `auth.py` | `User.username` único **global** rompe multi-tenant; `update_user` no valida org del target (IDOR) | `UniqueConstraint(org_id, username)` + filtro org | M |
| **DATA-4** | 🟠 Alta | Datos/API | `parts.py:137-168`, `inventory.py:83-104`, `workorders.py:204-207` | Check-then-insert sin UniqueConstraint → partes duplicadas, doble descuento de stock, `child_seq` colisiona | UniqueConstraints + capturar IntegrityError | M |
| **DATA-5** | 🟠 Alta | Performance | `reports.py:208-211` | `spend_report` carga TODAS las WO + líneas a memoria, sin filtro de fecha en SQL | Filtro de fecha en SQL + `GROUP BY` | M |
| **ARCH-1** | 🟠 Alta | Arquitectura | `routes.py:47-50`, `alerts.py:387` | Stores `_jobs`/`_batches` en memoria + loop alertas → **single-replica forzado** | Mover a Postgres/redis + worker | L |
| **OPS-4** | 🟠 Alta | Deploy/Ops | `Dockerfile` (sin `USER`), `docker-compose.yml:15-17` | Contenedor corre como root; Postgres default `fleet/fleet` si falta `.env` | `USER` no-root + `${VAR:?}` sin default | S |
| **OPS-5** | 🟠 Alta | Deploy/Ops | sin `.github/workflows/` | Autodeploy On Push sin CI → cada push va a prod sin red | GitHub Actions con `docker build` como required check | M |
| **DATA-6** | 🟡 Media | Performance | `db.py:789,814,865` | `strftime` (SQLite-only) **falla en Postgres** → `month_summary`/`trends`/`missing_drivers` rotos en prod | Reemplazar por rango de fechas portable | S |
| **DATA-7** | 🟡 Media | Performance | `workorders.py:98,141,419`, `db.py:30` | N+1 en `list_wos`/`stats` (lazy `wo.lines` + disco), engine sin `pool_pre_ping` | `selectinload`/agregación + configurar pool | M |
| **SEC-5** | 🟡 Media | Seguridad | `secretstore.py:68-71`, `auth.py:48-50` | Secreto HMAC autogenerado silencioso, sin `0600`, sin escritura atómica, sin rotación | env/secrets-manager + `os.replace` + chmod | M |
| **ARCH-2** | 🟡 Media | Arquitectura/Deuda | `db.py` (42KB), `routes.py` (79KB), `api.ts` (69KB), `index.css` (235KB) | Monolitos por archivo; lógica DVIR duplicada en cliente; sin capa de servicios | Dividir por dominio incrementalmente | L |
| **SEC-6** | 🟡 Media | Seguridad | `routes.py:726,759`; sin CSP | Endpoints `body: dict` sin Pydantic (mass-assignment); sin CSP ni headers | Schemas `PartIn/VendorIn` + CSP/HSTS | M |
| **FE-2** | 🟡 Media | Frontend | `main.tsx`/`App.tsx`, `LoginPage.tsx:19-22` | Sin Error Boundary (pantalla blanca total); comentario de seguridad FALSO | Error Boundary + corregir comentario | S |
| **OBS-1** | 🟡 Media | Ops/Arquitectura | `main.py` (sin logging) | Sin observabilidad: 500 solo en stdout, sin error tracking ni métricas | Logging estructurado + Sentry + readiness probe | M |

Esfuerzo: S = horas · M = 1-3 días · L = semana(s).

---

## 2. Auditoría por área

### 2.1 Seguridad / Auth

Veredicto: cripto-primitivas correctas, pero el **modelo de control de acceso del middleware es default-allow** y el bootstrap abre toda la API. Esos dos son explotables hoy en internet.

#### SEC-1 · 🔴 Crítica — RBAC default-allow deja escapar mutaciones
**Evidencia:** `backend/app/main.py:48-92` (`_scope_for`) y `:113-117` (`_require_auth`).

`_scope_for` devuelve `None` (= "basta estar autenticado") para cualquier ruta que no haga match con un prefijo hardcodeado. En el middleware, `if scope and not has_scope(...)` → si `scope` es `None`, **no se chequea nada**. Cualquier ruta de escritura no enumerada la ejecuta un `viewer` (que por diseño no tiene ningún scope).

```python
# main.py:92      return None   # fallthrough: POST/PATCH/DELETE no listado pasa solo con token
# main.py:113-114 scope = _scope_for(request.method, path)
#                 if scope and not permissions.has_scope(user["role"], scope):  # scope None => sin chequeo
```

Mutaciones reales no cubiertas por ningún prefijo de `_scope_for` (confirmado contra la lista actual `:58-91`): `POST /api/companies`, `/api/companies/rename`, `DELETE /api/companies/{key}`; `POST /api/teams`, `/api/teams/assign`, `DELETE /api/teams/{key}`; `POST /api/integrations/test` y `/api/integrations/eld/active` (solo `/api/integrations/config` matchea `settings.manage`); `POST /api/batch/generate`, `/api/reporting/eld/import`.

**Riesgo:** escalada de privilegios. Un solo-lectura crea/borra empresas y equipos, dispara imports de ELD, cambia el proveedor ELD activo y prueba integraciones.
**Fix (recomendado):** invertir a **fail-closed** — para todo método ≠ GET, si `_scope_for` devuelve `None`, responder 403. Mantener allowlist mínima explícita de mutaciones públicas (login/setup).
**Alternativas:** (a) migrar a `Depends(require_scope(...))` por endpoint (ya existe a medias en `routes.py:1115`) — más robusto ante rutas nuevas pero más invasivo; (b) tabla explícita `(prefix, method) → scope` con default deny. Detalle y orden en ROADMAP-SEGURIDAD.md.

#### SEC-2 · 🔴 Crítica — Bootstrap abre toda la API sin usuarios
**Evidencia:** `main.py:106-111` y `routes.py:1120-1123`.

```python
# main.py:106-111  si user is None y NO users_exist() -> cae a call_next (API ABIERTA)
# routes.py:1121-1122  require_scope sin usuarios -> devuelve admin sintético {"role":"admin"}
```

Mientras la tabla `User` esté vacía, toda la API responde sin token y `require_scope` retorna un admin. En un host público con autodeploy, entre que el contenedor levanta y el dueño completa el wizard, un atacante puede `POST /api/auth/setup` y quedarse como **el** admin.
**Riesgo:** secuestro de la instancia en el primer arranque.
**Fix:** `FLEET_SETUP_TOKEN` por env de un solo uso para `setup`; con `User` vacío responder solo `auth/status|setup` y `health`, el resto 401/403.

#### SEC-3 · 🟠 Alta — Sin rate-limit ni lockout en login
**Evidencia:** `routes.py:1155-1161`, `auth.py:159-173`. No hay slowapi ni throttling (la única captura es `anthropic.RateLimitError` en `docscan.py:1195`). PBKDF2 200k encarece el cracking offline pero no el online; además cada intento cuesta CPU (vector DoS). Política de password solo `len ≥ 8` (`auth.py:130`), sin breach-check.
**Fix:** slowapi con backend redis, clave por **IP + cuenta**, `5/min` en `/auth/login` y `/auth/setup`, + lockout/backoff tras N fallos. Subir mínimo a 12 y validar contra Pwned Passwords (k-anonymity). Ver ERRORES-CONOCIDOS.md para el detalle de por qué single-replica complica el contador en memoria (usar redis).

#### SEC-4 · 🟠 Alta — Token stateless 30 días, sin revocación
**Evidencia:** `auth.py:33` (`TOKEN_TTL_S = 30*24*3600`), `:75-107`. Payload = `user_id.expiry`; sin `jti`, sin lista de revocación, sin versión de credencial. Cambiar la contraseña **no** invalida tokens viejos (el hash no entra en la firma). Rotar el secreto desloguea a todos.
**Fix:** añadir `token_version`/`pw_version` por usuario en el payload (incrementar al cambiar password o ante incidente) → invalida tokens previos sin matar a todos. Bajar TTL a horas/día + refresh. Ver FE-1 (storage del token).

#### SEC-5 · 🟡 Media — Secreto HMAC: autogen silenciosa, sin 0600/atómica/rotación
**Evidencia:** `auth.py:37-50` (confirmado: si no hay blob, genera 32 bytes y sigue), `secretstore.py:68-71` (`write_text` plano). Si el volumen `./secrets` se pierde, se regenera silenciosamente → logout global. El archivo se escribe con permisos del proceso (root, ver OPS-4). Quien lo lea **forja tokens de cualquier usuario**.
**Fix:** soportar secreto vía env (la abstracción `SecretStore` ya lo permite), `os.replace` atómico + chmod `0600`, rotación con 2 secretos válidos (actual+anterior), y `logging.warning` al autogenerar.

#### SEC-6 · 🟡 Media — Sin CSP/headers; endpoints `body: dict` sin Pydantic
**Evidencia:** no hay middleware de CSP/HSTS/X-Content-Type-Options/X-Frame-Options. `parts_create`/`vendors_create` (`routes.py:726,759`) aceptan `body: dict` sin schema → sin rechazo de campos desconocidos (mass-assignment) ni doc OpenAPI.
**Fix:** middleware de security headers + CSP estricta; `PartIn`/`VendorIn` Pydantic con `extra="forbid"` (como ya se hizo para WO/PO).

**Lo que está BIEN (no romper):** PBKDF2-SHA256 200k + salt 16 bytes (`auth.py:55-70`); `compare_digest` en password (`:68`) y token (`:93`); timing uniforme ante usuario inexistente (`:166-168`); RBAC server-side con matriz rol→scope (`permissions.py:44-58`); reset de password solo por CLI (`scripts/reset_password.py`, sin endpoint HTTP); guard contra auto-desactivación del admin (`auth.py:196-197`).

### 2.2 Datos / API / Performance

Veredicto: ORM elimina SQLi y el **aislamiento de SELECT** está bien. Los agujeros están en escrituras cross-tenant, ausencia de UniqueConstraints (race conditions reales en dinero e inventario), y carga de tablas enteras a memoria.

#### DATA-1 · 🔴 Crítica — UPDATE/DELETE Core no se filtra por org (IDOR write)
**Evidencia:** `db.py:486-500` — el guard `do_orm_execute` solo intercepta `is_select`. `alerts.py:372-382` (confirmado): `ack_events()` hace `update(AlertEvent)` sin `where(org_id)`; sin `ids` marca acked en **toda la base**, con `ids` ajenos marca alertas de otra org.
**Riesgo:** corrupción/manipulación cross-tenant; el patrón afecta a cualquier `update()`/`delete()` Core futuro.
**Fix:** segundo listener para `is_update`/`is_delete` que inyecte `.where(cls.org_id == tenant.get_current_org())`; en `ack_events` filtrar explícito ya. **Definitivo:** RLS de Postgres (fase 3c-2, ver ROADMAP-SEGURIDAD.md).

#### DATA-2 · 🔴 Crítica — Contador de invoice con race → números duplicados
**Evidencia:** `org_config.py:203-212` (read-modify-write del blob JSON, sin lock), invocado desde `workorders.update_wo` (`workorders.py:285`). Dos facturaciones concurrentes → dos invoices con el mismo número.
**Riesgo:** problema contable/legal serio para el reemplazo de Fullbay.
**Fix:** columna en `Organization` con `UPDATE ... SET next_invoice = next_invoice + 1 ... RETURNING` (atómico en Postgres). **Alternativa:** `with_for_update()` sobre la fila de `org_setting`.

#### DATA-3 · 🟠 Alta — `User.username` único GLOBAL + IDOR en `update_user`
**Evidencia:** `db.py:247-248` (confirmado: `unique=True` global, no por org). `User` NO es `OrgScoped`; `auth.update_user(user_id, ...)` no valida que el target pertenezca a la org del admin actuante.
**Riesgo:** (a) org A registra "admin" y org B ya no puede; (b) admin de org A edita usuario de org B.
**Fix:** `UniqueConstraint("org_id", "username")`; filtrar por `org_id` en `update_user`/`list_users`; resolver username dentro de la org en login.

#### DATA-4 · 🟠 Alta — Check-then-insert sin UniqueConstraint (3 sitios)
**Evidencia:** `parts.py:137-168` (parte duplicada → `on_hand` repartido entre dos filas); `inventory.py:83-104` (guard `(reason,ref_type,ref_id)` sin constraint → **doble descuento de stock** en doble-click de "invoiced"); `workorders.py:204-207` (`child_seq = max()+1` sin lock → `#4.1` duplicado).
**Fix:** `UniqueConstraint("org_id", func.lower(part_number))`, `UniqueConstraint("org_id","reason","ref_type","ref_id")`, `UniqueConstraint("parent_id","child_seq")` + capturar `IntegrityError` y reintentar/retornar existente. El docstring de `db.py:384-386` ya promete la unicidad de inventario — solo falta el constraint real.

#### DATA-5 · 🟠 Alta — `spend_report` carga toda la tabla a memoria
**Evidencia:** `reports.py:208-211` — `select(WorkOrder)` sin límite ni filtro de fecha en SQL (el rango se filtra en Python `:227-229`), luego itera `wo.lines` (N+1). Memoria O(total_WOs), se degrada con el tiempo. Es el endpoint de analítica que el jefe abre seguido.
**Fix:** empujar el filtro de fecha a SQL (columna indexada) + `GROUP BY` en vez de traer objetos.

#### DATA-6 · 🟡 Media — `strftime` rompe en Postgres
**Evidencia:** `db.py:789,814,865` usan `func.strftime("%Y-%m", ...)` — **SQLite-only**; en Postgres es error. Probablemente ya rompe `month_summary`/`trends`/`missing_drivers` en prod. **Verificar de inmediato.**
**Fix:** rango de fechas portable (`>= mes_inicio AND < mes_sig`) o `to_char`. Además, función-sobre-columna no usa índice. Ver ERRORES-CONOCIDOS.md.

#### DATA-7 · 🟡 Media — N+1 + engine sin pool_pre_ping
**Evidencia:** `workorders.py:98,141` (`_wo_dict` suma `wo.lines` lazy + `wo_invoices.file_name` toca disco por WO → hasta 201 queries en `GET /api/workorders` con limit=200); `workorders.py:419-424` (`stats` carga objetos en vez de `sum()` SQL); `db.py:30` (`create_engine` sin `pool_pre_ping`/`pool_recycle` → conexiones stale `SSL connection has been closed` en Postgres tras idle).
**Fix:** `selectinload(WorkOrder.lines)` / agregación; `create_engine(URL, pool_pre_ping=True, pool_recycle=1800)`.

**Otros (Media/Baja):** sin paginación real (limit fijo sin offset/total: `list_wos=200`, `list_defects=400`; `list_parts`/`list_vendors` **sin límite** = tabla entera, `parts.py:119`); sin índices en `Defect(company,status,unit)`, `WorkOrderLine.part_number`, `BlockDriver(block_id,driver)`; lazy relation loads sin scope (latente, `db.py:494`); proyecciones de más (`groups_json` Text en `month_summary`); sin cotas numéricas en `qty`/`unit_cost`/`limit`.

**Lo que está BIEN:** sin SQL injection (todo ORM; el único `exec_driver_sql` en `_migrate` usa identificadores hardcodeados y solo en SQLite); cierre de sesiones correcto (`with SessionLocal()` en todo el código, sin fugas).

### 2.3 Multi-tenant / aislamiento

Veredicto: aislamiento **solo a nivel aplicación** (eventos SQLAlchemy), con `org_id` nullable. Funciona para SELECT pero tiene fugas en escrituras y depende de un ContextVar frágil.

- **Mecanismo:** `core/tenant.py` mantiene `org_id` en un `ContextVar`; `db.py:475-500` lo usa en `_assign_org_on_insert` (before_flush) y `_scope_select_to_org` (`do_orm_execute` con `with_loader_criteria`). El SELECT que emite `session.get()` también pasa por el guard (`is_select=True`) → bien aislado.
- **Fugas reales:** DATA-1 (UPDATE/DELETE Core no filtra), DATA-3 (`User` no OrgScoped). **Latente:** `do_orm_execute` excluye `is_relationship_load` (`db.py:494`) → lazy-loads de relaciones no se filtran; hoy seguro solo porque el padre ya se cargó scoped.
- **`org_id` nullable + sin RLS:** un bug que pierda el ContextVar (tareas de fondo, que `tenant.py` reconoce devuelven `None`) filtraría datos entre tenants sin red de seguridad a nivel base.
- **Fix estructural:** RLS de Postgres por `org_id` (una role de app + `SET LOCAL app.current_tenant` por transacción) como defensa en profundidad, y `org_id` NOT NULL. Es la fase 3c-2 ya reconocida en `db.py:471-472`. Planificado en ROADMAP-SEGURIDAD.md.

### 2.4 Deploy / Secrets / Ops

Veredicto: diseño de secretos sólido (montaje externo, `.gitignore`/`.dockerignore` exhaustivos, nada sensible en HEAD), pero **PII en el historial git, sin migraciones reales y sin backups** impiden llamarlo production-grade.

- **OPS-1 · 🔴 Crítica:** `roster.csv` (PII de flota del ex-empleador) en el commit inicial `97977bf`, borrado solo en HEAD por `ca2627d`. Recuperable con `git show 97977bf:roster.csv`. Dokploy clona `main`. **Fix:** `git filter-repo --path roster.csv --invert-paths`, force-push, rotar remoto, confirmar re-clone de Dokploy. Ver secrets_env/runbook en ROADMAP-SEGURIDAD.md.
- **OPS-2 · 🔴 Crítica:** `db.py:681-682` corre `create_all` en cada import (no altera tablas existentes); `_migrate()` (ALTER) restringido a SQLite (`db.py:673-675`). Alembic tiene **una sola** migración (`a518e3d89977_initial_schema`, 16 tablas) vs **23** modelos en `db.py` — faltan `purchase_order`, `po_line`, `part_stock_movement`. **Próxima columna nueva sobre la base Postgres poblada → 500 silencioso en runtime.** **Fix:** Alembic real (`revision --autogenerate` + `upgrade head` en entrypoint, `FLEET_SKIP_DB_INIT` ya existe), quitar `create_all` automático en Postgres. Ver DECISIONES.md (por qué se difirió).
- **OPS-3 · 🔴 Crítica:** sin `pg_dump`, sin snapshots; única protección = no borrar `pgdata`. Pérdida de WOs/facturas/inventario/PM (también retención legal DOT/DVIR). **Fix:** cron `pg_dump` a almacenamiento externo + doc de restore.
- **OPS-4 · 🟠 Alta:** `Dockerfile` sin `USER` (uvicorn + docscan render como root; volúmenes escritos root); `docker-compose.yml:15-17` usa `${POSTGRES_PASSWORD:-fleet}` → arranca con `fleet/fleet` si falta `.env`. **Fix:** `useradd -r app` + `chown -R app:app /app` + `USER app`; cambiar a `${POSTGRES_PASSWORD:?set in .env}`; verificar que la instancia LIVE no quedó con `fleet/fleet`.
- **OPS-5 · 🟠 Alta:** sin `.github/workflows/`; autodeploy On Push sin gate. CHANGELOG v1.28.1 documenta el dolor ("usar `npm run build`, no `tsc --noEmit`"). **Fix:** GitHub Actions que corra el `docker build` completo (multi-stage = `npm run build`) como required check + `import app.main` para errores de backend.
- **Otros (Media/Baja):** cifrado de secretos en reposo pendiente (`auth.py:12-14`, G7.2 — `*.local.json` en claro); base images sin pin de digest y `requirements.txt` con `>=` sin lockfile; `restart: unless-stopped` enmascara crash-loops; `auth_secret` autogenerado en vez de provisto (ver SEC-5).

**Lo que está BIEN:** `.gitignore`/`.dockerignore` exhaustivos y consistentes; secreto runtime por `FLEET_SECRETS_DIR` (rw justificado); `DATABASE_URL` por componentes con `sqlalchemy.URL.create` (codifica `@`, fix v1.28.2); puerto Postgres no publicado (solo `app:8000` vía Traefik); `npm ci` + lockfile + multi-stage.

### 2.5 Frontend

Veredicto: base sólida (sin `dangerouslySetInnerHTML`, sin `eval`, sin secretos en el bundle, prod deps 0 vulnerabilidades, 401 centralizado). Hallazgos: token en localStorage, sin Error Boundary, comentario de seguridad falso, `vite` con CVE dev.

- **FE-1 / SEC-4 · 🟠 Alta:** token bearer 30 días en `localStorage` (`api.ts:13-16`, confirmado). Legible por cualquier JS; stateless sin revocación. Hoy el riesgo XSS es bajo (no hay sinks de HTML crudo) pero el blast radius es alto. **Fix:** cookie `HttpOnly+Secure+SameSite` (requiere cambio de backend, es arquitectura no parche) o, interino, TTL 8-24h + refresh + CSP. No usar `sessionStorage` como falso arreglo.
- **FE-2 · 🟡 Media:** sin React Error Boundary (`main.tsx` monta `<App/>` directo) → una excepción de render = pantalla blanca total sin telemetría. **Fix:** envolver `<App/>` con fallback "Algo salió mal — Recargar".
- **🟡 Media — Comentario de seguridad FALSO:** `LoginPage.tsx:19-22` afirma "no hay endpoint de auth en el backend, acepta cualquier credencial" — **es mentira**: `handleSubmit` llama a `/api/auth/login` real. Documentación de seguridad incorrecta induce a error a futuros mantenedores (y agentes). **Fix:** borrar/corregir el bloque.
- **🟡 Media — Sin CSP** (`index.html`); `vite` 8.0.x con CVE HIGH (dev, Windows — el host de desarrollo) → `npm update vite` a ≥8.0.16.
- **Baja:** `window.open` de blob same-origin sin validar tipo (`api.ts:1142`); `branding.accent` crudo en `color-mix` (`App.tsx:258-267`, validar con regex de color); "Remember me" decorativo (`LoginPage.tsx:247`); "Forgot password" link muerto; imágenes Unsplash hotlinkeadas; modal sin focus trap/`role=dialog` (`Modal.tsx`).
- **Routing:** no hay react-router; `App.tsx` usa `useState('dashboard')` + switch — sin URLs profundas ni back/forward. Deuda de UX, ver ARQUITECTURA.md.

**Lo que está BIEN:** sin secretos en el bundle (Grep de `VITE_`/`sk-`/`groq` = solo labels); `noopener/noreferrer` en todos los `target=_blank`; TanStack Query con caché sensata; descargas auth por fetch+blob.

### 2.6 Arquitectura / Deuda técnica

Veredicto: monolitos por archivo y ausencia de capa de servicios/tests/CI son la deuda estructural más grande.

- **ARCH-1 · 🟠 Alta — Single-replica forzado:** `routes.py:47-50` (confirmado: `_jobs`/`_batches` dicts en memoria del proceso) + loop de alertas `asyncio.create_task` no distribuido. Con >1 instancia los stores no se comparten y el loop se duplica. No hay camino a escalar horizontal sin refactor (Postgres/redis + worker). Generación de Excel y escaneo LLM corren inline en el request.
- **ARCH-2 · 🟡 Media — Monolitos:** `db.py` 42KB (23 modelos + ~15 funciones de datos + init/migrate), `routes.py` 79KB (132 endpoints en un archivo), `api.ts` 69KB, `index.css` 235KB, `docscan.py` 60KB. `core/` es un cajón de sastre (dominio + adapters + framework + helpers), sin `services/`/`repositories/`. Lógica de dominio DVIR **duplicada en el cliente** (`defectAnalysis.ts`, `defectGroups.ts`, `truckZones.ts`).
- **Cero tests + cero CI:** sin pytest/vitest, sin `conftest.py`, sin workflows. La verificación es `npm run build` + arranque manual. Para una app LIVE es el gap más grave junto con migraciones.
- **Sin observabilidad (OBS-1):** sin Sentry/OTel/Prometheus/logging estructurado (`main.py` no configura logging). Un 500 solo se ve en stdout. **Fix:** logging estructurado por env + Sentry + `/api/health/ready` con `SELECT 1` (el HEALTHCHECK actual `curl /api/health` pasa aunque Postgres esté caído).
- **Sin colas/workers/cache servidor; sin migraciones reales (ver OPS-2); sin RLS (ver 2.3).**

**Patrón a respetar (ver CONVENCIONES.md):** rutas finas que delegan al core; core lanza `ValueError` (mensaje inglés UI) → ruta a `HTTPException(400)`; PATCH parcial con `model_dump()` filtrando `None`; hooks de negocio idempotentes en `update_wo`.

---

## 3. Quick wins vs Inversiones grandes

### Quick wins (alto impacto / bajo esfuerzo) — hacer ya
1. **DATA-6** — Reemplazar `strftime` por rango de fechas portable (`db.py:789,814,865`). Probablemente **ya está roto en prod Postgres**; verificar y corregir hoy. (S)
2. **SEC-1** — Invertir el middleware a fail-closed para no-GET (`main.py:113-117`). Cierra la escalada de privilegios con un cambio acotado. (S/M)
3. **DATA-2** — Contador de invoice atómico (`org_config.py:203-212`). Evita facturas duplicadas. (S)
4. **OPS-4** — `USER` no-root en Dockerfile + quitar default `fleet/fleet`. (S)
5. **DATA-4** — Tres `UniqueConstraint` (parts/inventory/child_seq) + capturar IntegrityError. (S/M)
6. **DATA-7** — `pool_pre_ping=True` + `pool_recycle` en `db.py:30`; `selectinload` en `list_wos`. (S)
7. **FE-2** — Error Boundary + corregir comentario falso de `LoginPage.tsx:19-22` + `npm update vite`. (S)
8. **SEC-2** — Cerrar la API durante el bootstrap sin usuarios. (S)

### Inversiones grandes (alto impacto / alto esfuerzo) — planificar en ROADMAP-SEGURIDAD.md
1. **OPS-2** — Alembic operativo antes del próximo cambio de esquema (riesgo de romper datos en silencio con autodeploy). (L)
2. **OPS-1 + OPS-3** — Purga de PII del historial git + backups automáticos `pg_dump`. (M cada uno, críticos)
3. **ARCH-1** — Mover `_jobs`/`_batches` y el loop de alertas a Postgres/redis + worker → habilitar multi-replica. (L)
4. **SEC-4 / FE-1** — Token a cookie HttpOnly + refresh + revocación (`token_version`). Coordinación back+front. (L)
5. **Multi-tenant 2.3 + DATA-1** — RLS de Postgres por `org_id` + `org_id` NOT NULL como red de seguridad. (L)
6. **OPS-5** — CI con `docker build` + SAST (Semgrep) + secret scan (Gitleaks) + `pip-audit`/`npm audit` como required checks; primeros tests de invariantes (aislamiento de tenant, RBAC, no-double-spend). (M→L)
7. **Auth estratégico** — evaluar delegar a un IdP (Auth0/Clerk/Supabase/Keycloak) para obtener MFA, lockout, password policies, sesiones revocables y recuperación "gratis", eliminando la superficie de SEC-1/SEC-3/SEC-4 de un saque. Decisión en DECISIONES.md.

---

## Cómo usar este documento (para agentes)

- **Antes de cualquier fix:** localizar el ID aquí, leer su sección, y cruzar con ERRORES-CONOCIDOS.md (síntomas en prod) y ROADMAP-SEGURIDAD.md (orden/fase). Las severidades asumen la app **expuesta a internet con datos reales**.
- **No tocar sin entender la invariante:** ContextVar de tenant (2.3), `create_all` vs Alembic (OPS-2), stores en memoria/single-replica (ARCH-1).
- **Orden de fix por riesgo en Auth:** SEC-1 → SEC-2 → SEC-3 → SEC-4 → SEC-5.
- **Verificación:** sin suite automatizada hoy; `npm run build` (no solo `tsc --noEmit`) + arranque manual, hasta que exista CI (OPS-5). Ver FLUJO-DE-TRABAJO.md.
- Convenciones de código, glosario de entidades (`WorkOrder`, `Part`, `OrgScoped`, `AlertEvent`, etc.) y decisiones históricas: CONVENCIONES.md, GLOSARIO.md, DECISIONES.md, ARQUITECTURA.md.
