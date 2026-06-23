# DECISIONES.md — Registro de decisiones técnicas (ADR ligero)

> Registro de decisiones de arquitectura ya **CERRADAS** en Fleet Tracker (FastAPI + React/Vite + Postgres, v1.29.0). Su propósito es darle contexto a futuros agentes de IA y desarrolladores para **no rehacer** lo que ya se decidió ni repetir debates resueltos. Cada decisión indica su **Estado** y si **podría re-evaluarse**. Para problemas activos ver `ERRORES-CONOCIDOS.md` y `ROADMAP-SEGURIDAD.md`; para el cómo del código ver `ARQUITECTURA.md` y `CONVENCIONES.md`.

## Cómo leer este documento

Formato ADR ligero por decisión: **Decisión / Contexto / Estado / Consecuencias**. Estados posibles:

| Estado | Significado |
|---|---|
| ✅ Firme | Decisión asentada; no tocar sin una razón fuerte y nueva. |
| 🔁 Re-evaluable | Correcta para la etapa actual (piloto/multi-cliente temprano); habrá que revisarla al crecer. Tiene gatillo de revisión explícito. |
| ⚠️ Deuda asumida | Se eligió a sabiendas de su costo; el costo está documentado y aceptado por ahora. |

Índice rápido:

| # | Decisión | Estado |
|---|---|---|
| [ADR-01](#adr-01--backend--frontend-en-un-solo-contenedor) | Backend + frontend en un solo contenedor | ✅ Firme |
| [ADR-02](#adr-02--sqlite-en-dev--postgres-en-prod) | SQLite en dev / Postgres en prod | ✅ Firme |
| [ADR-03](#adr-03--databaseurl-por-componentes-postgres_-con-urlcreate) | `DATABASE_URL` por componentes (`URL.create`) | ✅ Firme |
| [ADR-04](#adr-04--auth-propia-hmac-no-idp-de-terceros-por-ahora) | Auth propia HMAC (no IdP de terceros, por ahora) | 🔁 Re-evaluable |
| [ADR-05](#adr-05--multi-tenant-por-org_id--orgscoped-a-nivel-aplicación) | Multi-tenant por `org_id` / OrgScoped a nivel aplicación | 🔁 Re-evaluable |
| [ADR-06](#adr-06--esquema-por-create_all-alembic-diferido) | Esquema por `create_all`, Alembic diferido | ⚠️ Deuda asumida |
| [ADR-07](#adr-07--docscan-con-groq-vision-como-proveedor-de-prod) | docscan con Groq vision como proveedor de prod | 🔁 Re-evaluable |
| [ADR-08](#adr-08--deploy-en-dokploytraefik-sobre-vps-autodeploy-on-push) | Deploy en Dokploy/Traefik sobre VPS (autodeploy On Push) | ⚠️ Deuda asumida |
| [ADR-09](#adr-09--secrets-en-un-bind-mount-read-write-secretstore--localjson) | Secrets en bind-mount read-write (`SecretStore` → `*.local.json`) | 🔁 Re-evaluable |
| [ADR-10](#adr-10--app-de-escritorio--cliente-de-la-nube-no-server-local) | App de escritorio = cliente de la nube (no server local) | ✅ Firme |
| [ADR-11](#adr-11--producto--reemplazo-de-fullbay-tms-descartado) | Producto = reemplazo de Fullbay; TMS descartado | ✅ Firme |

---

## ADR-01 — Backend + frontend en un solo contenedor

**Decisión.** Servir la API (FastAPI/uvicorn) y la SPA de React **desde un único proceso/contenedor**. La etapa Node del `Dockerfile` compila `frontend/dist` y la etapa Python lo copia a `/app/frontend/dist`; uvicorn monta los assets y hace SPA-fallback a `index.html` (`backend/app/main.py:138-162`). En dev, el frontend corre en Vite (`:5173`) con proxy `/api → 127.0.0.1:8765` (`frontend/vite.config.ts`).

**Contexto.** Es una app de un solo operador de despliegue (el jefe / el dev) apuntando a clientes piloto, no una plataforma con equipo de plataforma. Un contenedor único = un objeto que desplegar, un health-check, un dominio, mismo origen (sin CORS en prod). Se evitó separar frontend en un CDN/host aparte porque agrega coordinación de despliegue y un segundo origen (CORS, config de URLs) sin beneficio en esta escala. La imagen final es Python-slim sin la toolchain de Node (multi-stage; `Dockerfile`).

**Estado.** ✅ Firme.

**Consecuencias.**
- Same-origin en prod: el token viaja por header `Authorization`, no por cookie; CORS solo aplica a dev (`config.DEV_ORIGINS`). Ver ADR-04.
- No hay routing de cliente con URLs profundas: `App.tsx` navega por `useState('section')` (`frontend/src/App.tsx`), sin react-router. No hay back/forward del navegador entre secciones — es estado en memoria. Consecuencia consciente del shell único, no un olvido.
- El frontend **debe** estar compilado para que prod sirva la UI; un fallo de build TS rompe el contenedor entero (de ahí la lección de ADR-08 sobre `npm run build`).

---

## ADR-02 — SQLite en dev / Postgres en prod

**Decisión.** Un único motor configurable por entorno: **SQLite** local para desarrollo/tests (`backend/dvir.db`) y **PostgreSQL 16** en producción. La selección es automática en `backend/app/config.py:23-52` (`_resolve_database_url`): si hay `POSTGRES_*` (o `DATABASE_URL`) usa Postgres; si no, cae a `sqlite:///backend/dvir.db`. SQLAlchemy 2.0 (`Mapped`/`mapped_column`) abstrae el dialecto; `config.IS_SQLITE` marca el camino dev.

**Contexto.** Dev necesita cero setup (abrir y correr, sin servidor de base aparte); prod necesita concurrencia real, tipos y durabilidad. SQLite cubre lo primero; Postgres lo segundo. `docker-compose.yml` levanta `postgres:16-alpine` con volumen `pgdata` y `healthcheck pg_isready`; la `app` espera `service_healthy`.

**Estado.** ✅ Firme.

**Consecuencias.**
- Hay **divergencia de dialecto** que el código maneja a mano: el path de migración aditiva ad-hoc `_migrate()` (ALTER TABLE / PRAGMA) **solo corre en SQLite** (`backend/app/db.py`); Postgres no tiene equivalente automático. Esto es la raíz de la deuda de ADR-06.
- `dvir.db` está commiteada en el repo (~761 KB) como base de arranque/demo de dev; no es la base de prod.
- Cualquier feature que toque el esquema debe pensarse en **los dos** motores (ver `CONVENCIONES.md` y ADR-06).

---

## ADR-03 — `DATABASE_URL` por componentes (`POSTGRES_*` con `URL.create`)

**Decisión.** No construir la URL de Postgres concatenando strings. En su lugar, pasar los componentes por separado (`POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_HOST` / `POSTGRES_PORT` / `POSTGRES_DB`) y dejar que `config.py` arme la URL con `sqlalchemy.URL.create(...)`, que **codifica** los caracteres especiales de la contraseña (`backend/app/config.py:38-47`). Se admite además un `DATABASE_URL` explícito como override de máxima prioridad.

**Contexto.** Bug real de producción (v1.28.2): con una contraseña que contenía `@`, el `docker-compose` pegaba la clave cruda en la URL y el parseo del host terminaba resolviendo `'@db'` → la app crasheaba en bucle con `failed to resolve host '@db'`. `URL.create` codifica `@ : /` y demás, así que funciona para cualquier clave de cualquier cliente sin tener que resetear la base ni elegir contraseñas "seguras para URLs".

**Estado.** ✅ Firme. (Es un fix correcto; ver CHANGELOG [1.28.2].)

**Consecuencias.**
- En Dokploy se configuran las cinco vars `POSTGRES_*`, no una URL armada a mano.
- Cuidado en `docker-compose.yml`: el default `${POSTGRES_PASSWORD:-fleet}` permite arrancar con `fleet/fleet` si la env no se inyecta. Eso es un riesgo aparte (ver `ROADMAP-SEGURIDAD.md`), no invalida esta decisión.
- La codificación es transparente para Alembic/SQLAlchemy: ambos consumen `config.DATABASE_URL` ya resuelta.

---

## ADR-04 — Auth propia (HMAC) — no IdP de terceros, **por ahora**

**Decisión.** Implementar autenticación, hashing y RBAC en casa, sin delegar a un IdP (Auth0/Clerk/Supabase/OIDC). Passwords con **PBKDF2-SHA256 (200k iteraciones, salt de 16 bytes por usuario)**, comparación con `hmac.compare_digest`, timing uniforme en login. Tokens **stateless firmados con HMAC** (payload `user_id.expiry`, TTL 30 días), secreto autogenerado en `./secrets`. RBAC server-side con matriz rol→scope en `backend/app/core/permissions.py`, aplicada en el middleware (`backend/app/main.py`). Archivos clave: `backend/app/core/auth.py`, `permissions.py`, `main.py`.

**Contexto.** Empezó como app local de un solo box; un IdP externo era sobreingeniería y dependencia de red/proveedor para un piloto. La implementación casera está **por encima del vibecoding promedio** (PBKDF2+salt, compare_digest, RBAC real server-side, timing uniforme). Se decidió mantenerla casera mientras el producto valida mercado.

**Estado.** 🔁 Re-evaluable. **Gatillo de revisión:** al pasar de piloto a multi-cliente de pago, o al primer requisito de MFA/SSO de un cliente.

**Consecuencias.**
- Al ser propia, carga con todo lo que un IdP daría "gratis" y **hoy falta**: sin rate-limit/lockout en login, sin 2FA/MFA, sin verificación de email, sin breach-check de contraseñas, sin revocación granular de sesión (token de 30 días no se puede invalidar individualmente sin desactivar al usuario o rotar el secreto global). Detalle por severidad en `ROADMAP-SEGURIDAD.md`.
- El token vive en `localStorage` (`frontend/src/api.ts`) — robable por XSS; consecuencia del modelo bearer same-origin (ADR-01).
- Si se delega auth en el futuro, se elimina de un saque una capa grande de superficie de riesgo. Por eso queda explícitamente marcada como re-evaluable y **no** como firme.

---

## ADR-05 — Multi-tenant por `org_id` / OrgScoped a nivel aplicación

**Decisión.** Aislamiento multi-tenant en la **capa de aplicación**, no en la base. Cada request fija `org_id` en un `ContextVar` (`backend/app/core/tenant.py`, dependencia global `bind_tenant`). Los modelos `OrgScoped` se filtran/rellenan automáticamente vía eventos de SQLAlchemy: `_assign_org_on_insert` pone `org_id` en los inserts y `_scope_select_to_org` filtra los SELECT con `with_loader_criteria` (`backend/app/db.py`). La config no-secreta por tenant vive en `OrgSetting` (claves `terminals`, `teams`, `unit_settings`, `pm_overrides`, `driver_contacts`, etc.); los secretos en `SecretStore` (ADR-09).

**Contexto.** Se necesitaba pasar de single-tenant a white-label/multi-cliente sin reescribir cada query con un `where org_id=...` a mano. El patrón de eventos + ContextVar centraliza el scoping y evita el error humano de olvidar el filtro en un endpoint nuevo.

**Estado.** 🔁 Re-evaluable. **Gatillo:** antes de onboardear varios clientes reales con datos sensibles en la misma instancia (la fase H6/3c ya está identificada).

**Consecuencias.**
- `org_id` sigue siendo `nullable=True` y **no hay Row-Level Security** en Postgres (decisión documentada en `db.py` y `tenant.py` como fase futura). El aislamiento es **solo** a nivel app.
- **Riesgo conocido:** si el `ContextVar` no se setea (p.ej. en tareas de fondo como el loop de alertas, que `tenant.py` reconoce devuelven `org_id=None`), un SELECT puede no filtrar → fuga cross-tenant. Pendiente: `org_id NOT NULL` + RLS + columna obligatoria. Ver `ROADMAP-SEGURIDAD.md` y `ERRORES-CONOCIDOS.md`.
- La RBAC del middleware es hoy **default-allow** para rutas de escritura no enumeradas en `_scope_for` — issue de control de acceso separado de tenancy, tratado en `ROADMAP-SEGURIDAD.md`.

---

## ADR-06 — Esquema por `create_all`, Alembic diferido

**Decisión.** Crear/actualizar el esquema con `Base.metadata.create_all` al importar `db.py` (`init_schema()`, idempotente), **tanto en SQLite como en Postgres** (decisión de v1.26.0). Alembic está cableado (`backend/alembic/`, `env.py` + `FLEET_SKIP_DB_INIT` para importar metadata sin tocar la base) pero **no se ejecuta en el arranque**; tiene una sola migración inicial.

**Contexto.** En el momento de comercializar (v1.26) lo urgente era que un Postgres fresco obtuviera el esquema completo desde los modelos sin pelearse con Alembic. `create_all` lo resuelve para una base **vacía**. Las migraciones versionadas quedaron explícitamente como "tarea futura" en el CHANGELOG.

**Estado.** ⚠️ Deuda asumida — **prioritaria de saldar antes del próximo cambio de esquema en prod.**

**Consecuencias (leer con atención — esto rompe datos en silencio).**
- `create_all` **crea tablas faltantes pero NO altera tablas/columnas existentes**. Sobre una base Postgres **ya poblada** (la instancia LIVE con pilotos), agregar una columna a una tabla existente se desplegará pero **fallará en runtime** (la columna no existe), sin error en build ni arranque. Combinado con autodeploy On Push (ADR-08), un merge a `main` puede dejar la app en 500 silencioso.
- El path aditivo `_migrate()` (ALTER TABLE) **solo cubre SQLite** — Postgres no tiene migración automática de columnas.
- **Drift confirmado:** la migración inicial (`backend/alembic/versions/a518e3d89977_initial_schema.py`) crea 16 tablas; los modelos en `db.py` ya definen ~23 — faltan al menos `purchase_order`, `po_line`, `part_stock_movement` (añadidas en v1.23/v1.25). Alembic está varias tablas/columnas por detrás del modelo.
- **Plan de salida** (cuando se aborde): `alembic revision --autogenerate` por cambio; `alembic upgrade head` como paso de entrypoint del contenedor; quitar `create_all` automático en Postgres (dejarlo solo para SQLite dev), usando el `FLEET_SKIP_DB_INIT` que ya existe.

---

## ADR-07 — docscan con Groq vision como proveedor de prod

**Decisión.** El escaneo de facturas de taller (PDF → líneas de partes/labor) usa un framework multi-proveedor (`backend/app/core/docscan.py`) con **Groq vision** (Llama 4 Scout, `meta-llama/llama-4-scout-17b-16e-instruct`) como proveedor elegido en producción. Se configura 100% por entorno desde Dokploy: `DOCSCAN_PROVIDER=groq` + `GROQ_API_KEY`. `load_settings()` busca `docscan.local.json` en `FLEET_SECRETS_DIR` (el `./secrets` montado y persistente) antes que en la imagen. Quedan disponibles Ollama (local/offline), Anthropic y AWS Textract.

**Contexto.** El escaneo con Ollama 7B local tardaba ~98 s y a veces sobre-extraía montos (~$1,748 vs total real ~$1,019). Groq bajó el tiempo a ~2-3 s (≈30×) y mejoró la precisión, reutilizando la API existente. El contenedor de prod no trae Ollama, así que necesitaba un proveedor cloud. La config por env (v1.28.4) reemplazó al archivo horneado en la imagen, que no sobrevivía redeploys y donde `auto` nunca elegía Groq.

**Estado.** 🔁 Re-evaluable (la elección de proveedor/modelo de vision es un parámetro de coste/precisión, no un compromiso arquitectónico).

**Consecuencias.**
- El escaneo corre **inline en el request** (no hay cola/worker; ver ADR-08): una factura grande ocupa el request hasta terminar.
- Dependencia de un servicio externo (Groq) y de su rate-limit; el código atrapa el equivalente a `RateLimitError`. La salida estructurada se sanitiza (`null`→default).
- Cambiar de proveedor es config, no código: el adapter ya soporta Ollama/Anthropic/Textract. `auto` sigue cayendo a Ollama offline por defecto cuando no hay env.

---

## ADR-08 — Deploy en Dokploy/Traefik sobre VPS (autodeploy On Push)

**Decisión.** Desplegar en un VPS (Hostinger, `187.77.255.150`, sslip.io) gestionado por **Dokploy**, detrás de **Traefik** (TLS por Let's Encrypt, enruta por dominio al `:8000` del contenedor, **sin publicar** el puerto Postgres). El modo es **autodeploy "On Push"**: un push a `main` reconstruye y redepliega. El `Dockerfile` multi-stage corre el build completo (`npm run build` = `tsc -b && vite build`) en el VPS.

**Contexto.** Dokploy da un PaaS self-host simple (Git → build → deploy) sin montar un pipeline propio. Para un solo operador es el menor esfuerzo operativo. El despliegue se verifica en el VPS porque Docker no está disponible en el entorno de dev (nota recurrente del CHANGELOG).

**Estado.** ⚠️ Deuda asumida (el modelo de deploy es correcto; lo asumido es la **falta de red de seguridad** alrededor).

**Consecuencias.**
- **Cada push va a producción sin CI/tests/lint que bloqueen.** No hay `.github/workflows`, no hay tests automatizados (cero unit/integration/e2e), no hay gate. Para una app LIVE es el gap operativo más grave. Lección ya pagada: v1.28.1, un error que `tsc --noEmit` no atrapaba rompió el `docker build` en el VPS → **siempre verificar con `npm run build`, no solo `tsc --noEmit`** (ver `ERRORES-CONOCIDOS.md`).
- Combinado con ADR-06: un cambio de esquema vía push puede romper datos en silencio.
- **Single-replica obligado:** los stores en memoria del proceso (`_jobs`/`_batches` en `routes.py`) y el loop de alertas (`asyncio.create_task(alerts.run_loop())`, 60s) no son distribuibles. Escalar horizontalmente exige antes mover esos estados a Postgres/redis + worker.
- Sin observabilidad (sin Sentry/OTel/structured logging): un 500 solo se ve en stdout del contenedor. Ver `ROADMAP-SEGURIDAD.md`.
- **Plan de salida sugerido:** GitHub Action que corra el **mismo** `docker build` como required check antes de merge a `main`; backups `pg_dump` automáticos; readiness check que toque la DB.

---

## ADR-09 — Secrets en un bind-mount read-write (`SecretStore` → `*.local.json`)

**Decisión.** Centralizar secretos en un único directorio `./secrets` montado en el contenedor (`FLEET_SECRETS_DIR`, default `backend/` en dev), **read-write**, vía la abstracción `SecretStore` → `FileSecretStore` que persiste `*.local.json` (`backend/app/core/secretstore.py`). Ahí viven el `auth_secret` (firma de tokens, autogenerado en el primer login) y las credenciales de integraciones configurables desde la UI (Samsara, `groq_api_key`, Twilio, Gmail SA, etc.).

**Contexto.** El secreto de auth **debe escribirse** en runtime (se autogenera la primera vez). Un fix de producción (v1.28.4) cambió el montaje de `:ro` a read-write: con read-only, el login devolvía 500 al no poder persistir el `auth_secret` y no se podían guardar credenciales desde la UI. El bind-mount persiste entre redeploys. Los `*.local.json` están gitignored/dockerignored (verificado: nada sensible en HEAD).

**Estado.** 🔁 Re-evaluable (el patrón de un único dir montado es bueno; el almacenamiento en texto plano es lo re-evaluable).

**Consecuencias.**
- **Secretos en texto plano** en el filesystem del VPS: sin cifrado en reposo (pendiente G7.2, keyring/DPAPI), sin `chmod 600` explícito, escritura no atómica. Quien lea `secret.local.json` puede **forjar tokens de cualquier usuario** — game-over de la auth. El `SecretStore` ya está preparado para enchufar un secrets-manager real (`secretstore.py`). Detalle en `ROADMAP-SEGURIDAD.md`.
- El contenedor corre como **root**, así que los archivos del bind-mount se escriben como root en el host. Riesgo aparte (usuario no-root pendiente).
- Si `./secrets` se pierde/recrea, el `auth_secret` se regenera **silenciosamente** y **desloguea a todos**. Recomendación abierta: proveer `secret.local.json` explícito en vez de depender de la autogeneración.

---

## ADR-10 — App de escritorio = cliente de la nube (no server local)

**Decisión.** La "app de escritorio" **no** corre nada en la PC: `launch.bat` abre la app de **producción** (URL del VPS) en una ventana de aplicación (Chrome `--app`, fallback a Edge). Al loguear, el escritorio usa la **misma base Postgres del server** que la web → datos siempre en sync. El modo legacy (server local + SQLite en `backend/dvir.db`) se preserva en `launch-dev.bat` para desarrollo/offline. (v1.29.0)

**Contexto.** La alternativa considerada era correr un server local conectado a la Postgres remota. Se **descartó** porque: (a) pondría credenciales de la base en el cliente, (b) expondría/usaría el puerto 5432 o exigiría un túnel, y (c) saltaría la capa de auth/API. El cliente-de-la-nube no tiene ninguno de esos problemas: solo es un navegador en modo app contra la API ya autenticada.

**Estado.** ✅ Firme.

**Consecuencias.**
- El escritorio depende de conectividad al VPS; sin red no hay app (para eso queda `launch-dev.bat`).
- Una sola fuente de verdad (Postgres del server) para web y escritorio; sin sincronización ni merge de datos local/remoto.
- Toda la seguridad del escritorio es la misma de la web (ADR-04): no hay superficie extra de "credenciales de DB en el cliente".

---

## ADR-11 — Producto = reemplazo de Fullbay; TMS descartado

**Decisión.** Posicionar Fleet Tracker como competidor de **Fullbay / SquareRigger** (mantenimiento de flota y operación de taller), **no** como TMS. El módulo de Loads/dispatch (TMS) fue **removido** del foco; el roster de conductores queda como "Driver Compliance" dentro de Maintenance & Compliance. Diferenciadores: integración **ELD** (Samsara/Motive vía framework multi-proveedor) + UI ágil/moderna.

**Contexto.** El repo nació como "DVIR-Report-Generator" (nombre legacy) y creció a un sistema de mantenimiento completo. La dirección de producto se definió tras benchmark competitivo (jun-2026): el dolor real y monetizable es el reemplazo de Fullbay (el jefe paga ~$577/mes); el TMS dispersaba el esfuerzo y competía en un mercado distinto. Las features se construyen como "Fullbay-killer slices" (catálogo de partes/vendors, inventario, Work Orders con estimate/invoice, escaneo de facturas, PM/DOT).

**Estado.** ✅ Firme. (Dirección definitiva del benchmark; TMS descartado jun-19.)

**Consecuencias.**
- El nombre del repo es legacy y **no** refleja el producto — no renombrar a la ligera (rompe Dokploy/clones/remotos).
- Las decisiones de roadmap priorizan paridad/superación de Fullbay (inventario, partes, facturación de taller, cold chain) sobre dispatch/cargas.
- Gap conocido a cerrar: API de catálogo de partes en vivo (FinditParts/PartsTech) — hoy el marketplace es scaffold con datos MOCK. Ver `ROADMAP-SEGURIDAD.md`/roadmap de producto.

---

## Documentos hermanos

- `ARQUITECTURA.md` — estructura real del código (backend `core/`, `db.py`, `routes.py`; frontend `App.tsx`, `api.ts`).
- `CONVENCIONES.md` — cómo escribir código aquí (incl. tocar esquema en los dos motores, ver ADR-02/06).
- `GLOSARIO.md` — términos del dominio (OrgScoped, campaña/PM, DVIR, WO padre/hija, reefer/Cold Chain).
- `FLUJO-DE-TRABAJO.md` — flujo de desarrollo, build (`npm run build`), consolidación por incremento.
- `ERRORES-CONOCIDOS.md` — bugs ya resueltos y trampas (clave de Postgres con `@`, `tsc --noEmit` insuficiente, ContextVar de tenant).
- `ROADMAP-SEGURIDAD.md` — hallazgos AppSec/DevSecOps con severidad (RBAC default-allow, sin rate-limit, secrets en claro, root, backups, RLS).
- `AUDITORIA.md` — auditorías arquitectónica y DevOps/SecOps completas que fundamentan estas decisiones.
