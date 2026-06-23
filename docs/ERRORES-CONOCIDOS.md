# Errores conocidos

Catálogo de errores YA vividos en Fleet Tracker (deploy real, builds rotos, bugs de runtime) más los errores típicos del "vibecoding" que aplican a este stack concreto (FastAPI + React/Vite + Postgres, multi-tenant por `org_id`). El propósito es darle contexto a futuros agentes de IA para que trabajen sin inventar y sin tropezar dos veces con la misma piedra. Cada entrada trae **síntoma, causa raíz, fix y prevención**, con rutas y entidades reales del repo (`ruta:línea` cuando aplica). Documentos hermanos: [ARQUITECTURA.md](ARQUITECTURA.md), [CONVENCIONES.md](CONVENCIONES.md), [DECISIONES.md](DECISIONES.md), [GLOSARIO.md](GLOSARIO.md), [FLUJO-DE-TRABAJO.md](FLUJO-DE-TRABAJO.md), [ROADMAP-SEGURIDAD.md](ROADMAP-SEGURIDAD.md) y [AUDITORIA.md](AUDITORIA.md).

> **Estado al escribir esto (v1.29.0):** la app está **LIVE en producción** (Dokploy/Traefik, VPS Hostinger `187.77.255.150`, sslip.io), Postgres 16 multi-tenant. Eso eleva la severidad real de varios hallazgos: ya no es "single-box local". Los errores marcados como **ACTIVO** están sin corregir en el código a esta fecha.

---

## Tabla maestra

Leyenda de prioridad: **P0** = corregir antes del próximo cambio de esquema / explotable hoy en internet · **P1** = alto · **P2** = medio · **P3** = bajo/deuda.

| # | Error | Tipo | Prioridad | Estado | Evidencia |
|---|-------|------|-----------|--------|-----------|
| E1 | Build de prod falla por `tsc -b` (no lo atrapa `tsc --noEmit`) | Vivido | P1 | RESUELTO (v1.28.1) | `CHANGELOG` v1.28.1 |
| E2 | Crash-loop por host `@db` (password con `@` en `DATABASE_URL`) | Vivido | P1 | RESUELTO (v1.28.2) | `CHANGELOG` v1.28.2 |
| E3 | Login 500 en prod por `./secrets:ro` (no persiste `auth_secret`) | Vivido | P1 | RESUELTO (v1.28.3) | `CHANGELOG` v1.28.3 |
| E4 | "the app already has users" / API abierta sin usuarios | Vivido | P0 | ACTIVO (parcial) | `main.py:106-111`, `routes.py:1120-1123` |
| E5 | docscan nunca elegía Groq (config solo por archivo en imagen) | Vivido | P2 | RESUELTO (v1.28.4) | `CHANGELOG` v1.28.4 |
| E6 | `strftime` SQLite-only rompe reportes en Postgres | Vivido/latente | P0 | ACTIVO | `db.py:789,814,865` |
| E7 | `create_all` sin Alembic → columna nueva rompe runtime en silencio | Vivido/latente | P0 | ACTIVO | `db.py:652-682` |
| E8 | PII real (`roster.csv`) en el historial de git | Vivido | P0 | ACTIVO | commits `97977bf`/`ca2627d` |
| E9 | Sin backups de Postgres | Vibecoding | P0 | ACTIVO | `docker-compose.yml` (vol `pgdata`) |
| E10 | RBAC default-allow: `viewer` ejecuta mutaciones no listadas | Vibecoding | P0 | ACTIVO | `main.py:48-118` |
| E11 | UPDATE/DELETE Core no filtra `org_id` (IDOR de escritura) | Vibecoding | P0 | ACTIVO | `alerts.py:372-382`, `db.py:486` |
| E12 | Race conditions sin UniqueConstraint (invoice #, stock, parts, child_seq) | Vibecoding | P1 | ACTIVO | `org_config.py:203`, `inventory.py:83`, `parts.py:137`, `workorders.py:204` |
| E13 | `User.username` único GLOBAL + IDOR en `update_user` | Vibecoding | P1 | ACTIVO | `db.py:247`, `auth.py` |
| E14 | Token bearer 30 días en `localStorage` (robable por XSS) | Vibecoding | P1 | ACTIVO | `api.ts:13-16`, `auth.py:33` |
| E15 | Sin rate-limit ni lockout en login (fuerza bruta / DoS) | Vibecoding | P1 | ACTIVO | `routes.py:1155`, `auth.py:159` |
| E16 | N+1 y carga de tablas enteras (spend_report, list_wos) | Vibecoding | P1 | ACTIVO | `reports.py:208`, `workorders.py:98,141` |
| E17 | Sin paginación real / listados sin límite | Vibecoding | P2 | ACTIVO | `parts.py:119`, `parts.py:39` |
| E18 | Endpoints con `body: dict` crudo, sin Pydantic | Vibecoding | P2 | ACTIVO | `routes.py:726,759` |
| E19 | Falta `pool_pre_ping`/`pool_recycle` → conexiones stale en Postgres | Vibecoding | P2 | ACTIVO | `db.py:30` |
| E20 | Defaults débiles `fleet/fleet` + contenedor como root | Vibecoding | P1 | ACTIVO | `docker-compose.yml:15-17`, `Dockerfile` |
| E21 | CORS clavado a localhost; trampa para el "arreglo" `*`+credentials | Vibecoding | P2 | OK hoy (frágil) | `main.py:30-35` |
| E22 | Comentario de seguridad FALSO en `LoginPage.tsx` | Vivido | P2 | ACTIVO | `LoginPage.tsx:19-22` |
| E23 | `vite` 8.0.x con CVE HIGH (dev, Windows) | Vibecoding | P2 | ACTIVO | `package.json:39` |
| E24 | Sin Error Boundary → pantalla blanca total | Vibecoding | P2 | ACTIVO | `main.tsx`, `App.tsx` |
| E25 | Secreto HMAC autogenerado: rotación/`0600`/escritura no atómica | Vibecoding | P2 | ACTIVO | `auth.py:37-50`, `secretstore.py:68-71` |
| E26 | Sin observabilidad (logging plano, sin Sentry, sin audit de auth) | Vibecoding | P2 | ACTIVO | `main.py` |
| E27 | Healthcheck no valida DB (falsos verdes) | Vibecoding | P2 | ACTIVO | `Dockerfile:59-60` |
| E28 | Deps Python con `>=` sin lock; imágenes base sin pin de digest | Vibecoding | P2 | ACTIVO | `requirements.txt`, `Dockerfile:12,26` |
| E29 | Slopsquatting / paquetes inventados por la IA | Vibecoding | P3 | Preventivo | — |
| E30 | Stack traces / `debug=True` filtrando info al cliente | Vibecoding | P3 | Verificar | `main.py` |

---

## Detalle — errores YA vividos en este proyecto

### E1 · Build de producción falla por `tsc -b` aunque `tsc --noEmit` pase · RESUELTO (v1.28.1)
- **Síntoma:** `docker build` en el VPS reventaba en la etapa del frontend con un error de TypeScript que en local nunca apareció porque sólo se corría `tsc --noEmit`. Caso concreto: `MarketplacePanel.resultToPart` construía un `Part` sintético sin `reorder_point`.
- **Causa raíz:** el build real es `npm run build` = `tsc -b && vite build`. El modo **build** (`tsc -b`, project references) es más estricto y emite, mientras que `tsc --noEmit` se saltaba ese chequeo. Verificar con un comando distinto al que usa el deploy = falsa sensación de verde.
- **Fix:** completar el objeto `Part` con `reorder_point` y desplegar v1.28.1.
- **Prevención:** **verificar con el MISMO comando que el deploy.** Correr `npm run build` (no `tsc --noEmit`) antes de mergear a `main`. Idealmente un CI que ejecute el `docker build` multi-stage completo como required check (ver [ROADMAP-SEGURIDAD.md](ROADMAP-SEGURIDAD.md), E1 institucionalizado). Con autodeploy On Push, un error de TS rompe el deploy en el VPS, no en tu máquina.

### E2 · Crash-loop por host `@db`: password con `@` en `DATABASE_URL` · RESUELTO (v1.28.2)
- **Síntoma:** la app entraba en bucle de reinicio; el driver intentaba conectar a un host llamado `db` (o peor) en vez de a Postgres. `restart: unless-stopped` enmascaraba el crash repitiéndolo en silencio.
- **Causa raíz:** se armaba la `DATABASE_URL` por concatenación de string. Si `POSTGRES_PASSWORD` contiene `@` (o `:`/`/`), parte la URL: el `@` de la password se confunde con el separador `user:pass@host`. Clásico de construir URLs a mano.
- **Fix:** construir la URL con `sqlalchemy.URL.create(...)` por componentes, que **codifica** los caracteres especiales correctamente.
- **Prevención:** nunca interpolar credenciales en una URL a mano. Usar `URL.create`/`urlencode`. Ver [DECISIONES.md](DECISIONES.md) (DATABASE_URL por componentes).

### E3 · Login 500 en producción por `./secrets:ro` · RESUELTO (v1.28.3)
- **Síntoma:** todo login en prod devolvía **500**; tampoco se podían guardar credenciales de integraciones desde la UI.
- **Causa raíz:** el volumen `./secrets` se montaba `:ro` (read-only). La app necesita **escribir** ahí el `auth_secret` que firma los tokens (se autogenera en el primer login). Al no poder persistirlo, explotaba.
- **Fix:** montar `./secrets` read-write (v1.28.3).
- **Prevención:** documentar qué directorios necesitan escritura (`./secrets` para `auth_secret` + creds de UI; `./data/uploads`, `./backend/.jobs`). Ojo: esto choca con E20 (root) y E25 (permisos `0600`) — el rw es correcto, pero el dueño debe ser un usuario no-root.

### E4 · "the app already has users" / API abierta en el primer arranque · P0 · ACTIVO (parcial)
- **Síntoma:** dos caras del mismo bootstrap. (a) Al re-correr el wizard de setup tras crear el admin: `setup` rechaza con un error tipo "ya hay usuarios" (esperado). (b) **El problema real:** mientras la tabla `User` está vacía, **toda la API responde sin token** y `require_scope` devuelve un admin sintético.
- **Causa raíz:** `main.py:106-111` — si no hay usuario y `auth.users_exist()` es falso, cae a `call_next` (API abierta). `routes.py:1120-1123` (`require_scope`) devuelve `{"role": "admin", ...}` cuando no hay usuarios. En un VPS público con autodeploy, entre que levanta el contenedor y el dueño completa el setup hay una **ventana de carrera**: cualquiera puede pegar `POST /api/auth/setup` y quedarse como el admin, o escribir/leer todo como admin.
- **Fix:** no abrir toda la API sin usuarios — sólo `auth/status`, `auth/setup`, `health` deben responder; el resto 401/403 hasta que exista admin. Proteger `setup` con un token de bootstrap de un solo uso por env (`FLEET_SETUP_TOKEN`).
- **Prevención:** fail-closed por defecto. Completar el setup inmediatamente tras el primer deploy. Ver E10 (mismo patrón default-allow).

### E5 · docscan nunca elegía Groq (config sólo por archivo en la imagen) · RESUELTO (v1.28.4)
- **Síntoma:** el escaneo de facturas seguía usando el proveedor lento; `auto` nunca seleccionaba Groq en producción.
- **Causa raíz:** `load_settings()` sólo leía `backend/docscan.local.json` **dentro de la imagen** (se pierde en cada redeploy y no es configurable desde Dokploy).
- **Fix:** leer el proveedor de la env `DOCSCAN_PROVIDER` y buscar `docscan.local.json` en `FLEET_SECRETS_DIR` (el `./secrets` persistente) antes que en la imagen. Así se configura `DOCSCAN_PROVIDER=groq` + `GROQ_API_KEY` 100% desde Dokploy.
- **Prevención:** la config de producción debe venir de env vars o de un volumen persistente, **nunca horneada en la imagen**. Patrón ya correcto para secretos vía `SecretStore`.

### E6 · `strftime` (SQLite-only) rompe reportes en Postgres · P0 · ACTIVO
- **Síntoma:** `missing_drivers`, `month_summary`, `trends` fallan o devuelven vacío en **prod Postgres**; en dev SQLite funcionan. Bug de portabilidad latente que probablemente **ya esté rompiendo en producción**.
- **Causa raíz:** `func.strftime("%Y-%m", block_date)` en `db.py:789,814,865`. `strftime` es una función de SQLite; Postgres no la tiene (su equivalente es `to_char`). Además, una función sobre la columna impide usar índice.
- **Fix:** reemplazar por una expresión portable. Preferir **rango de fechas** (`>= mes_inicio AND < mes_siguiente`) que además es indexable, o `to_char(block_date, 'YYYY-MM')` si se acepta el scan.
- **Prevención:** prohibir funciones SQLite-only en código que corre en Postgres. Probar las queries de reportes contra Postgres (no sólo SQLite dev) antes de mergear. Ver [CONVENCIONES.md](CONVENCIONES.md) sobre paridad SQLite↔Postgres.

### E7 · `create_all` sin Alembic → una columna nueva rompe runtime en silencio · P0 · ACTIVO
- **Síntoma:** un feature que agrega una columna a una tabla **ya poblada** se despliega sin error en build ni arranque, pero revienta en runtime ("column does not exist") en cuanto se toca esa entidad — 500 silencioso o bucle.
- **Causa raíz:** `db.py:652-682` corre `Base.metadata.create_all(_engine)` en cada import. `create_all` crea tablas faltantes pero **NO altera tablas existentes** (no agrega columnas). `_migrate()` (ALTER TABLE) está restringido a SQLite (`if config.IS_SQLITE`), no corre en Postgres. Alembic existe pero "sólo tiene la migración inicial". Combinado con autodeploy On Push, un merge a `main` deja la prod rota sin aviso.
- **Fix:** adoptar Alembic de verdad **antes del próximo cambio de esquema**: `alembic revision --autogenerate` por migración, `alembic upgrade head` como paso de arranque del contenedor (entrypoint), y quitar el `create_all` automático en Postgres (dejarlo sólo para SQLite dev). `FLEET_SKIP_DB_INIT` ya existe para que Alembic importe la metadata sin tocar la base.
- **Prevención:** toda modificación de esquema = migración Alembic versionada y revisada. Nunca DDL manual en prod. Ver E11 sobre migraciones en el catálogo vibecoding y [ROADMAP-SEGURIDAD.md](ROADMAP-SEGURIDAD.md).

### E8 · PII real (`roster.csv`) en el historial de git · P0 · ACTIVO
- **Síntoma:** datos personales de la flota del ex-empleador (camión→conductor) recuperables con `git show 97977bf:roster.csv`, aunque el archivo ya no esté en HEAD.
- **Causa raíz:** `roster.csv` se commiteó en el commit inicial `97977bf` y se borró recién en `ca2627d`. Borrar en un commit posterior **no** purga la historia. El `.gitignore` actual lo cubre, pero eso no limpia lo ya commiteado. Es el patrón "secreto/PII en git" con datos personales de terceros.
- **Fix:** reescribir la historia con `git filter-repo --path roster.csv --invert-paths` (o BFG), force-push y rotar el remoto. Confirmar que Dokploy re-clona tras el rewrite. Verificar que ningún `*.local.json`/`service_account.json` haya entrado nunca (esos están limpios).
- **Prevención:** secret/PII scanning (`gitleaks`/`trufflehog`) en pre-commit y CI. Asumir que todo lo commiteado, aunque se borre después, es permanente hasta purgar la historia.

### E22 · Comentario de seguridad FALSO en `LoginPage.tsx` · P2 · ACTIVO
- **Síntoma:** el comentario `LoginPage.tsx:19-22` afirma que el login "es una compuerta de front-end (no hay endpoint de auth en el backend)" y que "acepta cualquier credencial no vacía".
- **Causa raíz:** comentario obsoleto. La realidad: `handleSubmit` llama `authLogin()` → `POST /api/auth/login` real (`api.ts:749-759`), validado contra el backend (PBKDF2 + HMAC). Documentación de seguridad incorrecta induce a un mantenedor (humano o IA) a creer que no hay auth y tomar decisiones erróneas.
- **Fix:** borrar/corregir el bloque para reflejar que la auth es real (token bearer del backend; ver E14 para el endurecimiento pendiente).
- **Prevención:** tratar los comentarios de seguridad como código: actualizarlos en el mismo PR que cambia el comportamiento. **No confiar en comentarios que contradicen el código** — verificar contra la implementación real.

---

## Detalle — errores típicos del vibecoding aplicados a Fleet Tracker

> Contexto del problema (2025-2026): ~45% del código generado por LLMs introduce vulnerabilidades del OWASP Top 10; los commits asistidos por IA filtran secretos al doble de tasa que los humanos; ~20% referencia paquetes inexistentes (slopsquatting). La raíz común: el LLM optimiza el happy path, no concurrencia/seguridad/escala, y el humano acepta el diff sin leerlo.

### E10 · RBAC default-allow: cualquier `viewer` ejecuta mutaciones no listadas · P0 · ACTIVO
- **Síntoma:** un usuario de sólo-lectura (`viewer`, que por diseño no tiene ningún scope) puede crear/borrar empresas, equipos, disparar imports del ELD y cambiar el proveedor ELD activo.
- **Causa raíz:** `main.py:48-92` (`_scope_for`) devuelve `None` para cualquier ruta no enumerada, y `main.py:113-117` sólo chequea scope **si `scope` no es `None`**. Es decir, **fallthrough = se deja pasar con sólo estar autenticado**. Rutas de mutación NO cubiertas por ningún prefijo: `POST /api/companies`, `/api/companies/rename`, `DELETE /api/companies/{key}`, `POST /api/teams`, `/api/teams/assign`, `DELETE /api/teams/{key}`, `POST /api/reporting/eld/import`, `/api/batch/generate`, `POST /api/integrations/test`, `/api/integrations/eld/active`. (`/api/units/`, `/api/parts`, etc. sí están cubiertas.)
- **Fix:** invertir a **default-deny**: para todo método que no sea GET, si `_scope_for` devuelve `None`, responder **403** (fail-closed). Mantener una allowlist mínima de mutaciones públicas (login/setup). A mediano plazo migrar el RBAC de "prefijos de string" a `Depends(require_scope(...))` por endpoint (ya existe a medias en `routes.py:1115`).
- **Prevención:** autorización deny-by-default y server-side en cada endpoint. Cada ruta nueva debe declarar su scope explícito. Tests que verifiquen que un `viewer` recibe 403 en cada mutación. Ver E4 (mismo patrón de fallthrough).

### E11 · UPDATE/DELETE a nivel Core no filtra `org_id` (IDOR de escritura cross-tenant) · P0 · ACTIVO
- **Síntoma:** un usuario de la org A marca como atendidas alertas de la org B (o de **todas** las orgs). Corrupción de datos entre clientes del SaaS.
- **Causa raíz:** el guard de aislamiento `do_orm_execute` (`db.py:486`) sólo intercepta `is_select`. Los `update()`/`delete()` a nivel SQL Core **no llevan** `with_loader_criteria`, así que corren sobre TODAS las organizaciones. Caso real: `alerts.py:372-382` (`ack_events`) hace `update(AlertEvent).values(acked=True)` sin `.where(org_id == ...)`; sin `ids`, marca toda la base.
- **Fix:** parche inmediato en `ack_events`: `.where(AlertEvent.org_id == tenant.get_current_org())`. Estructural: un segundo listener para `is_update`/`is_delete` que inyecte `.where(cls.org_id == org)`, o activar **Row-Level Security de Postgres** (la "fase 3c-2" pendiente en `db.py:471-472`).
- **Prevención:** RLS en Postgres como defensa en profundidad — la base impone el aislamiento aunque el código olvide el filtro. Tests cross-tenant (crear org A y B, verificar que A no puede mutar datos de B) en **cada** endpoint de escritura.

### E12 · Race conditions sin UniqueConstraint (números duplicados, doble stock) · P1 · ACTIVO
- **Síntoma:** dos invoices con el mismo número, partes de catálogo duplicadas, stock descontado dos veces, `child_seq` colisionando (`#4.1` repetido).
- **Causa raíz:** patrón read-modify-write y check-then-insert sin atomicidad ni constraint, asumido "mono-usuario local" pero LIVE multi-usuario en Postgres:
  - `org_config.py:203-212` (`next_invoice_number`): lee el blob JSON, suma 1, escribe. Dos facturaciones concurrentes → mismo número.
  - `inventory.py:83-104`: guard de idempotencia `(reason, ref_type, ref_id)` por SELECT+insert sin constraint → doble `wo_consume` (doble-click en "invoiced").
  - `parts.py:137-168` (`create_part`): SELECT `lower(part_number)` luego insert, sin UniqueConstraint → partes duplicadas.
  - `workorders.py:204-207` (`create_wo` con `parent_id`): `child_seq = max()+1` sin lock → colisión de numeración multi-unit (feature estrella v1.26).
- **Fix:** `UniqueConstraint` a nivel DB + capturar `IntegrityError`: `Unique(org_id, lower(part_number))`, `Unique(org_id, reason, ref_type, ref_id)`, `Unique(parent_id, child_seq)`. Para el contador de invoices: columna atómica `UPDATE organization SET next_invoice = next_invoice + 1 ... RETURNING` (atómico en Postgres) o `with_for_update()`.
- **Prevención:** las invariantes de negocio (unicidad, no-doble-gasto) se imponen en la DB, no en código de aplicación. Idempotency keys con columna `UNIQUE`. Stress test concurrente de los endpoints de facturación/stock.

### E13 · `User.username` único GLOBAL + IDOR en `update_user` · P1 · ACTIVO
- **Síntoma:** (a) si la org A registra "admin", la org B ya no puede tener su propio "admin"; (b) un admin de la org A podría modificar (`PATCH /api/auth/users/{id}`) a un usuario de la org B.
- **Causa raíz:** `db.py:247` declara `username unique=True` (global). Además `User` **no** es `OrgScoped` (no pasa por `with_loader_criteria`), y las queries de `auth.py` (`login`, `verify_token`, `update_user`, `create_user`) buscan por username/id sin filtrar `org_id`. `update_user(user_id, ...)` no valida que el target pertenezca a la org del admin que actúa.
- **Fix:** cambiar a `UniqueConstraint("org_id", "username")`; en `update_user`/`list_users` filtrar por `org_id` del admin actuante; resolver username **dentro** de la org en login (requiere tenant en el path de login).
- **Prevención:** todo lo que tenga tenant debe llevar el `org_id` en su clave única y en cada query. Revisar entidades que no heredan de `OrgScoped`. Ver [ARQUITECTURA.md](ARQUITECTURA.md) sobre el modelo multi-tenant.

### E14 · Token bearer de 30 días en `localStorage` · P1 · ACTIVO
- **Síntoma:** cualquier XSS exfiltra el token con `localStorage.getItem('ft-token')`; robado, vale 30 días sin revocación granular.
- **Causa raíz:** `api.ts:13-16` guarda el bearer en `localStorage` (legible por cualquier JS). El TTL es `TOKEN_TTL_S = 30*24*3600` (`auth.py:33`); el token es stateless HMAC sin `jti` ni lista de revocación: no hay logout server-side ni "cerrar sesión en todos los dispositivos"; cambiar la contraseña no invalida tokens viejos (el hash no entra en la firma).
- **Fix:** mover la sesión a una **cookie `HttpOnly` + `Secure` + `SameSite`** (inaccesible a JS) — requiere que el backend acepte también cookie (cambio de arquitectura, no parche de front). Interino: bajar el TTL a horas/día + refresh; añadir `pw_version`/`token_version` por usuario que se incremente al cambiar password o ante incidente. Endurecer con CSP estricta.
- **Prevención:** nunca almacenar identificadores de sesión en `localStorage`/`sessionStorage`. Tokens cortos + refresh rotatorio. Atacar la causa raíz del XSS (escapado por defecto de React, CSP, sin `dangerouslySetInnerHTML`). Ver E24 y [ROADMAP-SEGURIDAD.md](ROADMAP-SEGURIDAD.md).

### E15 · Sin rate-limit ni lockout en login (fuerza bruta / DoS) · P1 · ACTIVO
- **Síntoma:** `POST /api/auth/login` se puede invocar ilimitadamente; fuerza bruta / credential stuffing, y DoS por el costo CPU de PBKDF2 (200k iteraciones por intento).
- **Causa raíz:** no existe ninguna primitiva de throttling en el backend (`routes.py:1155`, `auth.py:159`). PBKDF2 encarece el cracking offline pero no frena el brute-force online; con política de password de sólo 8 caracteres, una lista común tiene buenas chances.
- **Fix:** rate-limit por IP **y** por username (p.ej. `SlowAPI`, backend Redis para multi-instancia), `@limiter.limit("5/minute")` en `/login` (más estricto que el resto), lockout temporal con backoff exponencial tras N fallos. A nivel infra: `fail2ban`/WAF. Subir el mínimo de password a 12 y rechazar passwords filtradas (HIBP k-anonymity).
- **Prevención:** rate limiting por capas (app + infra), siempre más estricto en auth. El reset de password ya es sólo CLI (`scripts/reset_password.py`, sin endpoint HTTP) — mantenerlo así.

### E16 · N+1 queries y carga de tablas enteras a memoria · P1 · ACTIVO
- **Síntoma:** `GET /api/reports/spend` y `GET /api/workorders` se degradan linealmente con la historia; el endpoint de analítica que el jefe abre seguido carga toda la tabla.
- **Causa raíz:**
  - `reports.py:208-211` (`spend_report`): `select(WorkOrder)).all()` **sin límite ni filtro de fecha en SQL** (filtra en Python), luego itera `wo.lines` (N+1).
  - `workorders.py:98,141` (`_wo_dict`/`list_wos`): `sum(... for ln in wo.lines)` + `len(wo.lines)` lazy por cada WO → hasta 201 queries con `limit=200`; además `wo_invoices.file_name(wo.id)` toca **el disco** por WO.
  - `workorders.py:419-424` (`stats`/`cost_30d`): carga objetos + lines en vez de agregar en SQL.
- **Fix:** `selectinload(WorkOrder.lines)` (1 query extra en vez de N) o agregar con `GROUP BY`/`sum()` en SQL; empujar el filtro de fecha a SQL sobre columna indexada; batch/cache de los `file_name` en disco.
- **Prevención:** rendimiento desde el diseño — paginación, eager loading explícito, agregaciones en SQL. Revisar todo serializer que itere una relación lazy. `EXPLAIN ANALYZE` y conteo de queries por request.

### E17 · Sin paginación real / listados sin límite · P2 · ACTIVO
- **Síntoma:** el frontend no puede paginar (no hay `total` ni cursor); al crecer, los `limit` fijos cortan datos en silencio. `parts.list_parts()` y `list_vendors()` traen la tabla entera.
- **Causa raíz:** listados con `limit` por defecto fijo y sin offset/cursor (`list_wos=200`, `list_defects=400`, `list_pos=200`); `parts.py:119-124` y `parts.py:39-46` sin límite alguno.
- **Fix:** parámetros `limit`+`offset` (o keyset por `id`) y devolver `total`; poner tope a `list_parts`/`list_vendors`. Faltan índices en columnas filtradas (`Defect(company,status,unit)`, `WorkOrderLine.part_number`, `BlockDriver(block_id,driver)`).
- **Prevención:** paginación obligatoria en endpoints de lista (preferir keyset para datasets grandes), índices en columnas de filtro/orden.

### E18 · Endpoints con `body: dict` crudo, sin Pydantic · P2 · ACTIVO
- **Síntoma:** contrato de API débil; entradas inesperadas pasan silenciosas, `vendor_id = int(vid)` puede lanzar y tragarse el error; sin doc OpenAPI para esos endpoints.
- **Causa raíz:** `routes.py:726,759` (`parts_create`/`vendors_create`, y los `*_update`) reciben `body: dict` sin schema; la validación queda en `_apply_part`/`_apply_vendor` (cast/truncado manual). Sin rechazo de campos desconocidos ni cotas numéricas (`qty`/`unit_cost` aceptan cualquier float, incluido NaN/inf).
- **Fix:** definir `PartIn`/`VendorIn` Pydantic (como ya se hizo para WO/PO), con `Field(ge=0, le=...)` para cantidades y costos. Clamp de `limit` en todos los GET.
- **Prevención:** validación de esquema en el borde con Pydantic (back) — allowlist de campos, tipos, rangos. Nunca confiar en la validación del cliente; el servidor es la autoridad. Ver E9 del catálogo (validación de input).

### E19 · Engine sin `pool_pre_ping`/`pool_recycle` → conexiones stale · P2 · ACTIVO
- **Síntoma:** errores intermitentes `SSL connection has been closed` / `server closed the connection` cuando Postgres cierra conexiones idle (detrás de Dokploy).
- **Causa raíz:** `db.py:30` `create_engine(config.DATABASE_URL, ...)` usa el QueuePool por defecto sin `pool_pre_ping=True` ni `pool_recycle`. (El cierre de sesiones está bien: todo usa `with SessionLocal() as session:`.)
- **Fix:** `create_engine(URL, pool_pre_ping=True, pool_recycle=1800, pool_size=..., max_overflow=...)`.
- **Prevención:** afinar el pool para Postgres en producción; garantizar cierre de sesión (ya cubierto por el context manager).

### E20 · Defaults débiles `fleet/fleet` y contenedor como root · P1 · ACTIVO
- **Síntoma:** si `.env` no se carga (typo, Dokploy no inyecta la env), Postgres arranca con usuario/clave/db `fleet`/`fleet`/`fleet` **sin fallar**. Y el proceso uvicorn + parser de uploads corren como UID 0.
- **Causa raíz:** `docker-compose.yml:15-17,41-43` usa `${POSTGRES_PASSWORD:-fleet}`; el `Dockerfile` no tiene `USER`. Cualquier RCE/path-traversal escala a root del contenedor y escribe los bind mounts como root en el host.
- **Fix:** quitar el default (`${POSTGRES_PASSWORD:?set in .env}` → falla ruidoso). Crear usuario no-root y `chown`:
  ```dockerfile
  RUN useradd -r -u 10001 app && chown -R app:app /app
  USER app
  ```
  Verificar que el secret autogenerado y los uploads se escriban con ese UID (alinear con E3/E25). Confirmar que la instancia LIVE no quedó con `fleet/fleet`.
- **Prevención:** sin defaults para credenciales; fail-loud si falta una var crítica. Contenedores con menor privilegio.

### E21 · CORS clavado a localhost (frágil ante el "arreglo" rápido) · P2 · OK hoy, frágil
- **Síntoma:** ningún problema hoy — en prod el frontend se sirve same-origin desde el static mount de FastAPI, así que CORS no abre nada y **no** se setea `allow_credentials`.
- **Causa raíz:** `main.py:30-35` clava `allow_origins=config.DEV_ORIGINS` (localhost) y `allow_methods/headers=["*"]`, sin env var para producción. El riesgo es futuro: el día que se necesite otro dominio, el "arreglo" típico es `allow_origins=["*"]` y, si encima activan `allow_credentials`, se vuelve explotable (equivale a desactivar la same-origin policy).
- **Fix:** mover orígenes a env (`FLEET_CORS_ORIGINS`), allowlist explícita, nunca `*` con credenciales ni reflejar el `Origin` recibido, restringir métodos/headers a los usados.
- **Prevención:** documentar que en prod es same-origin y CORS debe quedar estricto/vacío. Ver [DECISIONES.md](DECISIONES.md).

### E23 · `vite` 8.0.x con CVE HIGH (dev, Windows) · P2 · ACTIVO
- **Síntoma:** `npm audit` reporta 1 high + 1 low, ambas en devDependencies. Prod = 0 vulnerabilidades (Vite no corre en prod; el deploy sirve `dist/` estático).
- **Causa raíz:** `package.json:39` (`vite ^8.0.12`, rango `8.0.0–8.0.15`): NTLMv2 hash disclosure via UNC path on Windows + bypass de `server.fs.deny` (HIGH). Afecta al **dev server** — y el equipo desarrolla en Windows, justo la plataforma del CVE. `@babel/core` (LOW) arbitrary file read.
- **Fix:** `npm update vite` a ≥ 8.0.16 y `npm audit fix`. No exponer el dev server fuera de `localhost` (no `--host` en redes no confiables).
- **Prevención:** `npm audit`/`pip-audit` en CI y cron; Dependabot/Renovate; parchear rápido las críticas. Ver E13 del catálogo (deps con CVE).

### E24 · Sin Error Boundary → pantalla blanca total · P2 · ACTIVO
- **Síntoma:** cualquier excepción de render no capturada (un `.map` sobre `undefined`, un campo nulo inesperado de la API) desmonta toda la app → pantalla en blanco, sin recuperación ni telemetría. Para una app de cumplimiento que el jefe usa en prod, pantalla blanca = caída total percibida.
- **Causa raíz:** no existe ningún React Error Boundary (`Grep ErrorBoundary|componentDidCatch|getDerivedStateFromError` → 0 resultados); `main.tsx` monta `<App/>` directo.
- **Fix:** envolver `<App/>` (o el `<main className="container">`) en un Error Boundary con fallback ("Algo salió mal — Recargar") y botón de reset; opcionalmente uno por sección.
- **Prevención:** Error Boundary + error tracker (Sentry) para no quedar ciego ante el primer fallo de render en prod.

### E25 · Secreto HMAC: autogeneración silenciosa, sin rotación, sin `0600`, escritura no atómica · P2 · ACTIVO
- **Síntoma:** si el volumen `./secrets` se pierde/recrea, el `auth_secret` se **regenera en silencio** y desloguea a todos. El archivo es legible por otros procesos del contenedor y puede corromperse si crashea a mitad de escritura. Quien lo lea **forja tokens de cualquier usuario** (game-over de la auth).
- **Causa raíz:** `auth.py:37-50` autogenera el secreto y sigue; `secretstore.py:68-71` hace `write_text(json.dumps(...))` plano — sin `chmod 0600`, sin escritura atómica, sin rotación con período de gracia.
- **Fix:** soportar el secreto vía env/secrets-manager (la abstracción `SecretStore` ya está lista); `chmod 0600` + escritura atómica (`tempfile`+`os.replace`); esquema de rotación con 2 secretos válidos (actual + anterior); loggear un warning cuando se autogenera uno nuevo. Proveer `secret.local.json` explícito en vez de depender de la autogeneración (alinear con E3/E20).
- **Prevención:** secretos fuera del código, con permisos mínimos y rotación. El modelo "app local single-box" ya no aplica: es un VPS multi-cliente.

### E26 · Sin observabilidad (logging plano, sin error tracking, sin audit de auth) · P2 · ACTIVO
- **Síntoma:** diagnóstico ciego en prod; depurar el primer incidente real (el `@db` de E2, un 500 de docscan) es a tientas. Los 401/403 del middleware no se loguean.
- **Causa raíz:** `main.py` no configura logging; uvicorn corre con el formato default. Sin structured logging, request IDs ni Sentry. (`PYTHONUNBUFFERED=1` está bien — los logs llegan a Dokploy.)
- **Fix:** logging con nivel por env (`LOG_LEVEL`), middleware que loguee método/path/status/latencia, error tracker (Sentry free-tier), y loguear fallos de auth. **No** loguear secretos ni PII.
- **Prevención:** observabilidad mínima antes de escalar a multi-cliente. Alinear con OWASP ASVS V7 (Error Handling & Logging).

### E27 · Healthcheck no valida la DB (falsos verdes) · P2 · ACTIVO
- **Síntoma:** Docker/Dokploy reportan `app` healthy mientras Postgres está caído o el esquema roto → no hay auto-reinicio cuando importa.
- **Causa raíz:** `Dockerfile:59-60` hace `HEALTHCHECK curl /api/health`, y `/api/health` está en la allowlist y no toca DB.
- **Fix:** endpoint `/api/health/ready` (readiness) que haga `SELECT 1` a la DB y usarlo en el HEALTHCHECK; dejar `/api/health` como liveness.
- **Prevención:** separar liveness de readiness; el readiness debe validar dependencias reales.

### E28 · Deps Python con `>=` sin lock; imágenes base sin pin de digest · P2 · ACTIVO
- **Síntoma:** builds no reproducibles — dos deploys del mismo commit pueden traer dependencias distintas ("rompió y no cambié nada"); riesgo de supply-chain.
- **Causa raíz:** `requirements.txt` usa rangos abiertos (`fastapi>=0.115`, `anthropic>=0.100`, `boto3>=1.34`); `Dockerfile:12,26` usa `node:22-alpine` y `python:3.12-slim` (tags móviles, sin `@sha256:`). El frontend sí tiene `package-lock.json` + `npm ci` (bien).
- **Fix:** pin exacto (`==`) generado con `pip-compile`/`uv`/poetry-lock; `FROM ...@sha256:...`; Renovate/Dependabot para renovar.
- **Prevención:** lockfiles y pins en ambos lados; SBOM; Trivy/Grype a la imagen.

### E29 · Slopsquatting / paquetes inventados por la IA · P3 · Preventivo
- **Síntoma:** la IA sugiere instalar un paquete que no existe o que un atacante registró con un nombre similar al inventado.
- **Causa raíz:** ~20% del código generado referencia paquetes inexistentes; instalarlos a ciegas es un vector de supply-chain.
- **Fix/Prevención:** verificar que cada dependencia nueva **existe y es la oficial** antes de instalar; pin + lockfile; revisar el diff. No mergear código de IA sin leerlo.

### E30 · Stack traces / `debug=True` filtrando info al cliente · P3 · Verificar
- **Síntoma:** un 500 podría devolver detalles internos (stack, mensaje de DB) al cliente.
- **Causa raíz:** patrón típico de la IA: devolver el error crudo. Verificar que en prod no haya `debug=True` ni se propaguen excepciones sin envolver.
- **Fix/Prevención:** `debug=False` en prod, errores genéricos al cliente y detalle sólo en logs server-side; sin secretos/PII en logs. Alinear con E26 y OWASP ASVS V7.

---

## Lo que está BIEN (no romperlo al "arreglar" lo de arriba)

Para evitar que un agente future "corrija" lo que ya está correcto:

- **Hashing de passwords sólido:** PBKDF2-SHA256 200k + salt de 16 bytes por usuario (`auth.py:55-70`).
- **Timing-safe:** `hmac.compare_digest` en password y en firma de token (`auth.py:68,93`); timing uniforme ante usuario inexistente (`auth.py:166-168`).
- **RBAC server-side real:** matriz rol→scope explícita en `permissions.py`; el cliente recibe scopes sólo para UI, no autoriza. (El agujero es el fallthrough del middleware, E10, no la matriz.)
- **Aislamiento de SELECT por tenant** vía `do_orm_execute`/`with_loader_criteria` (`db.py:486`). El hueco es sólo en UPDATE/DELETE Core (E11).
- **Sin SQL injection:** todo es ORM parametrizado; el único SQL crudo (`_migrate`) usa identificadores hardcodeados y sólo corre en SQLite dev.
- **Sin secretos en el bundle frontend; sin `dangerouslySetInnerHTML`/`eval`;** `noopener`/`noreferrer` en todos los `target="_blank"`.
- **`DATABASE_URL` por componentes** con `URL.create` (fix de E2); **`.gitignore`/`.dockerignore` exhaustivos** (nada sensible en HEAD); **puerto 5432 no publicado** (sólo `app:8000` vía Traefik); **`npm ci` + lockfile** y multi-stage build.
- **Reset de password sólo CLI** (sin endpoint HTTP que abusar); **401 centralizado** en el front (`api.ts` + evento `ft-unauthorized`).

---

## Orden de ataque sugerido

Por riesgo, ahora que está LIVE en Postgres multi-tenant (detalle y plan en [ROADMAP-SEGURIDAD.md](ROADMAP-SEGURIDAD.md) y [AUDITORIA.md](AUDITORIA.md)):

1. **E6** (strftime — probablemente ya roto en prod), **E11** (IDOR de escritura), **E10** (RBAC default-allow), **E4** (bootstrap abierto).
2. **E8** (purgar PII del git), **E9** (backups `pg_dump`), **E7** (Alembic antes del próximo cambio de esquema).
3. **E12** (constraints/race), **E13** (username por tenant), **E15** (rate-limit login), **E20** (root + defaults).
4. **E14** (token→cookie HttpOnly), **E16/E17** (N+1/paginación), **E1 institucionalizado** (CI con `docker build` real), resto P2/P3.
