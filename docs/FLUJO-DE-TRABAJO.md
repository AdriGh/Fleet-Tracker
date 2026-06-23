# Flujo de trabajo — Fleet Tracker

Este documento es el procedimiento operativo para trabajar en **Fleet Tracker** (DVIR Report Generator, v1.29.0): SaaS de mantenimiento/cumplimiento de flota, FastAPI + React/Vite + Postgres, **LIVE en producción** (Dokploy/VPS Hostinger, autodeploy On Push). Está escrito para que un agente de IA (o un humano) trabaje paso a paso **sin saltarse verificaciones y sin repetir los errores ya pagados** (build roto en el VPS, login 500 por secrets read-only, `@db` por la URL de Postgres, etc.). Documentos hermanos: [ARQUITECTURA.md](ARQUITECTURA.md), [CONVENCIONES.md](CONVENCIONES.md), [DECISIONES.md](DECISIONES.md), [GLOSARIO.md](GLOSARIO.md), [ERRORES-CONOCIDOS.md](ERRORES-CONOCIDOS.md), [ROADMAP-SEGURIDAD.md](ROADMAP-SEGURIDAD.md), [AUDITORIA.md](AUDITORIA.md).

> **Regla de oro:** la verificación es **build real + arranque manual**. No hay suite de tests automatizados (no existen `test_*.py` en `backend/app`, ni `vitest`/`jest`). El único gate hoy es `npm run build` (= `tsc -b && vite build`) y abrir la app. Ver [§3](#3-checklist-antes-de-commit) y [ERRORES-CONOCIDOS.md].

---

## 0. Mapa de archivos que vas a tocar (rutas reales)

| Capa | Dónde está | Qué hay |
|---|---|---|
| Versión única | `backend/app/__init__.py` | `__version__ = "1.29.0"` (la consume FastAPI y `/api/health`). |
| Config / DB | `backend/app/config.py` | Resolución de `DATABASE_URL`, `IS_SQLITE`, CORS dev, semillas. |
| Modelos + esquema | `backend/app/db.py` | SQLAlchemy 2.0, `OrgScoped`, `init_schema()`, `_migrate()` (solo SQLite). |
| Lógica de dominio | `backend/app/core/*.py` | `workorders.py`, `parts.py`, `inventory.py`, `purchasing.py`, `maint.py`, `pm.py`, `reefer.py`, `auth.py`, `permissions.py`, `tenant.py`, `secretstore.py`, `docscan.py`, … |
| Rutas HTTP | `backend/app/api/routes.py` | Único `APIRouter(prefix="/api")`; rutas finas que delegan al core. |
| Schemas API | `backend/app/schemas.py` | Modelos Pydantic de respuesta (`response_model=`). |
| Middleware/auth | `backend/app/main.py` | `_require_auth`, `_scope_for`, CORS, monta `frontend/dist`. |
| Cliente API front | `frontend/src/api.ts` | ~2300 líneas; `fetch` shadoweado con Bearer; un `async` por endpoint. |
| Vistas | `frontend/src/views/*.tsx` | PascalCase (`PartsPage.tsx`, `Dashboard.tsx`, `MaintBoardPage.tsx`). |
| Design system | `frontend/src/components/ds/` | `Button`, `Card`, `Tabs`, `StatCard`, `StatusPill`, … |
| Lanzadores | `launch-dev.bat`, `launch.bat` | Dev local (SQLite) / cliente de la nube. |
| Deploy | `Dockerfile`, `docker-compose.yml`, `DEPLOY.md` | Imagen única multi-stage; servicios `db` + `app`. |
| Changelog | `CHANGELOG.md` | Keep a Changelog (español) + SemVer. |

---

## 1. Preparación (entorno local)

### 1.1 Clonar
```bash
git clone <repo-url> DVIR-Report-Generator
cd DVIR-Report-Generator
```

> **Aviso de seguridad (CRÍTICO, [AUDITORIA.md] C1):** el commit inicial `97977bf` contiene `roster.csv` con **PII real de la flota del ex-empleador**, y sigue recuperable con `git show 97977bf:roster.csv` pese a que `ca2627d` lo borró del HEAD. **No** publiques ni compartas este repo sin antes purgar la historia (`git filter-repo --path roster.csv --invert-paths` + force-push + reclonar en Dokploy). El `.gitignore` (línea 38) ya cubre `roster.csv` para el futuro, pero no purga el pasado.

### 1.2 Dos formas de arrancar — elige según lo que vas a hacer

| Script | Qué hace | Base de datos | Cuándo usarlo |
|---|---|---|---|
| **`launch-dev.bat`** | Server local FastAPI + frontend compilado, en tu PC | **SQLite** (`backend/dvir.db`) | **Desarrollar.** Aislado de la nube, offline-friendly. |
| **`launch.bat`** | Abre la app de **producción** (URL del VPS) en ventana Chrome `--app` | **Postgres del VPS** | Ver/usar los datos reales del cloud. **No corre nada en tu PC.** |

Para trabajar en el código usas **`launch-dev.bat`**. Lo que hace por dentro (no lo repliques a mano sin entender por qué):

1. `git pull --ff-only` — actualiza la rama actual. (Sin esto, recompila código viejo del disco y "no se ven los cambios".)
2. Verifica deps de Python (`import fastapi, sqlalchemy, googleapiclient, httpx, anthropic`); si faltan, `py -m pip install -r backend\requirements.txt`.
3. **Compila el frontend SIEMPRE**: `cd frontend` → `npm install` (si no hay `node_modules`) → `npm run build`.
4. **Libera el puerto 8765** matando cualquier uvicorn viejo. (Sin esto, el server previo sigue sirviendo código viejo y el nuevo muere callado.)
5. Arranca `py -m uvicorn app.main:app --host 127.0.0.1 --port 8765` desde `backend/`.
6. Espera a que `GET /api/health` responda y abre `http://127.0.0.1:8765` en Chrome `--app`.

### 1.3 Setup manual de deps (si trabajas sin el .bat o en otra shell)

**Backend** (Python 3.12; el `__future__ annotations` y los type hints modernos lo asumen):
```bash
py -m venv .venv && .venv\Scripts\activate     # opcional pero recomendado
py -m pip install -r backend/requirements.txt
```
> `backend/requirements.txt` usa rangos abiertos (`fastapi>=0.115`, `anthropic>=0.100`, …) **sin lockfile** ([AUDITORIA.md] A4). Builds no 100% reproducibles; si algo "rompió y no cambié nada", sospecha de una dependencia nueva.

**Frontend** (Node 22):
```bash
cd frontend
npm ci          # respeta package-lock.json (preferido sobre npm install)
npm run dev     # Vite dev server en :5173 (CORS ya permite 5173 — config.py DEV_ORIGINS)
```
- Para **dev rápido del front** con hot-reload: `npm run dev` en `:5173` (apunta al backend de uvicorn en `:8765`).
- Para **verificar como producción**: `npm run build` (sirve `frontend/dist` desde el propio backend, igual que en el VPS).

### 1.4 Primer arranque (onboarding)
Con la tabla `user` vacía la API queda abierta **solo** hasta crear el primer admin: el frontend muestra el **OnboardingWizard**. Complétalo → crea el usuario `admin`. La org `default` (single-tenant) se siembra sola. Después la API exige Bearer token.

### 1.5 Secretos / integraciones (todos opcionales)
La app **corre sin ningún secreto** (cada integración degrada a offline/demo). Para activar una, copia el `backend/<name>.example.json` → `<name>.local.json` (gitignored, ver `.gitignore` línea 15) y complétalo. Nombres: `samsara`, `docscan`, `avisos`, `twilio`, `lynx`, `thermoking`, `traccar`, `telegram`, `cloudinary`, `secret`. En contenedor viven en `./secrets` vía `FLEET_SECRETS_DIR`. **Nunca** los commitees; **nunca** los pegues en chat/docs sin rotarlos después.

---

## 2. Hacer un cambio

### 2.1 Rama
Estás (probablemente) en `main`, que es **la rama de producción con autodeploy**. **Nunca** trabajes directo en `main`: cualquier push dispara un deploy. Crea rama:
```bash
git checkout -b feature/<nombre-corto>     # o fix/<...>, chore/<...>
```

### 2.2 Dónde tocar, según la capa (flujo de una request)
La arquitectura es **ruta fina → core grueso**. Respeta las capas (detalle en [ARQUITECTURA.md] y [CONVENCIONES.md]):

| Si el cambio es… | Toca… | Y casi siempre también… |
|---|---|---|
| Nueva regla de negocio / hook | `core/<área>.py` (la función de dominio) | nada en la ruta si la firma no cambia |
| Nuevo endpoint o campo de entrada | `api/routes.py` (modelo Pydantic `…In`/`…Patch` + ruta que delega) | la función en `core/`; `frontend/src/api.ts` |
| Nuevo campo de respuesta | `schemas.py` + el serializer del core | la `interface` exportada en `frontend/src/api.ts` |
| Nueva tabla / columna | `db.py` (modelo `Mapped[...]`) | **Alembic** (ver [§2.4], CRÍTICO) + `frontend` si se muestra |
| Permiso/scope nuevo | `core/permissions.py` (`SCOPES`, `ROLE_SCOPES`) | enforcement en `main.py` (`_scope_for`) o en la ruta (`require_scope`) |
| UI nueva / pantalla | `frontend/src/views/*.tsx` (+ subcomponentes en el mismo archivo) | `frontend/src/api.ts` para los datos; `components/ds/` para primitivos |

### 2.3 Convenciones que NO debes romper (resumen; completo en [CONVENCIONES.md])
- **Idioma:** comentarios/docstrings en **español**; identificadores, strings de UI y mensajes de error de la API en **inglés** (p.ej. `"unit and title are required"` — se muestra tal cual en la UI).
- **Backend:** `snake_case`; helpers privados con `_`; constantes `UPPER_SNAKE`; type hints modernos (`int | None`, `list[dict]`, `Mapped[...]`); `from __future__ import annotations` al tope de `core/*`. Imports diferidos dentro de funciones para romper ciclos, con comentario `# import diferido (orden de carga)`.
- **Rutas:** delgadas. El core lanza `ValueError` (mensaje inglés) → la ruta lo convierte: `except ValueError as exc: raise HTTPException(status_code=400, detail=str(exc))`; `404` cuando el core devuelve `None`/`False`. PATCH parcial: `{k: v for k, v in body.model_dump().items() if v is not None}`.
- **Multi-tenant:** **no escribas filtros `org_id` a mano** en queries — el ORM lo auto-completa/filtra por eventos (`before_flush`, `do_orm_execute`). Confiar en ese mecanismo central, no duplicarlo (ver [GLOSARIO.md] OrgScoped/tenant).
- **Frontend:** TanStack Query (`useQuery` + invalidación con `qc.invalidateQueries`); CSS clases globales (no Tailwind, no CSS-in-JS); toasts `notifyOk`/`notifyErr`; tokens en `localStorage` bajo `'ft-token'`; el `fetch` de `api.ts` ya inyecta `Authorization: Bearer`.

### 2.4 Si tu cambio toca el ESQUEMA — leer antes de escribir (CRÍTICO)
> **Este es el gotcha que puede romper producción en silencio.** Hoy el esquema en Postgres se crea con `Base.metadata.create_all` (`db.py` → `init_schema()`), que corre en cada arranque. **`create_all` crea tablas faltantes pero NO altera las existentes:** **no agrega columnas nuevas a una base ya poblada**. El path `_migrate()` (ALTER aditivos) está **restringido a SQLite** — no corre en Postgres.

Consecuencia con autodeploy On Push: si agregas una columna a una tabla existente y mergeas a `main`, el deploy **construye y arranca sin error**, pero la columna **no existe en Postgres** → 500 silenciosos o escrituras que fallan en runtime. La base LIVE ya está poblada con pilotos.

**Reglas:**
- **Tabla nueva (no toca existentes):** `create_all` la cubre. OK por ahora.
- **Columna/cambio en tabla existente:** **NO** confíes en `create_all`. Genera y aplica una migración Alembic (`alembic revision --autogenerate` → revisar → `alembic upgrade head` como paso de arranque). Usa `FLEET_SKIP_DB_INIT` para que Alembic importe metadata sin tocar la base. Coordina con el dueño antes de mergear — Alembic está hoy **incompleto** (solo migración inicial) y adoptarlo de verdad es prioridad [AUDITORIA.md] C2.
- En **dev SQLite**, `_migrate()` cubre los ALTER aditivos automáticamente; eso **no** te protege en Postgres.

---

## 3. Checklist antes de commit

No hay CI ni tests automatizados: **tú eres el gate**. Ejecuta en orden y no sigas si algo falla.

- [ ] **1. Build real del frontend — el gate principal.**
  ```bash
  cd frontend && npm run build       # = tsc -b && vite build
  ```
  **`tsc --noEmit` NO basta.** Lección pagada en v1.28.1: `MarketplacePanel.resultToPart` construía un `Part` sin `reorder_point`; `tsc --noEmit` lo dejaba pasar pero el `tsc -b` del build de producción fallaba → **deploy roto en el VPS** (el `docker build` corre `npm run build`). Si `npm run build` no pasa local, el deploy se romperá en producción.

- [ ] **2. El backend importa limpio.**
  ```bash
  cd backend && py -c "import app.main"
  ```
  Atrapa errores de import / orden de carga / sintaxis antes de que rompan el arranque del contenedor.

- [ ] **3. Arranque manual + verificación funcional.** Corre `launch-dev.bat` (o uvicorn a mano) y comprueba:
  - El badge de versión carga (la app levantó).
  - La **consola del navegador sin errores** (DevTools).
  - El flujo que tocaste funciona end-to-end (crear/editar/listar la entidad real).
  - Si tocaste un endpoint con permisos: probar con un rol sin scope (debe dar 403) — el enforcement es server-side ([GLOSARIO.md] RBAC).

- [ ] **4. Revisión del diff (no aceptes a ciegas el output de IA).** Verifica:
  - **Sin secretos** en el diff (claves, tokens, connection strings, PII). Revisa que ningún `*.local.json` / `*.local.csv` / `service_account.json` / `roster.csv` haya entrado: `git status` + `git diff --staged`.
  - Mensajes de error de la API en inglés; comentarios en español.
  - La ruta sigue fina (lógica en `core/`, no en `api/routes.py`).
  - Si agregaste una dependencia: que **exista y sea la oficial** (anti-slopsquatting) y que esté en `requirements.txt`/`package.json`.
  - Si tocaste esquema: que la migración esté hecha ([§2.4]).

- [ ] **5. Commit** (en tu rama, no en `main`):
  ```bash
  git add -A && git commit -m "feat: <descripción corta en presente>"
  ```

---

## 4. Release (consolidar por incremento)

Pre-autorizado por el flujo del proyecto: **tras cada feature**, consolidar y limpiar. Pasos, en orden:

1. **CHANGELOG.md** — agrega la entrada bajo una nueva versión, formato **Keep a Changelog en español** + SemVer:
   ```markdown
   ## [1.29.1] - 2026-06-22

   ### Agregado / Cambiado / Corregido / Nota
   - **<título en negrita>**: qué cambió y POR QUÉ (las entradas reales explican
     la decisión, p.ej. por qué se eligió X sobre Y). Embebe la fase de roadmap
     si aplica (G1–G7, H1–H6, "Increment A/B/C", "Inventory", "review vN").
   ```
   Mueve lo relevante de `## [No publicado]` (al tope) a la nueva versión. Subsecciones reales usadas: **Agregado / Añadido / Cambiado / Corregido / Nota**.

2. **Bump de versión** — un solo lugar: `backend/app/__init__.py` → `__version__ = "1.29.1"`. (Lo consumen FastAPI y `/api/health`; es lo que muestra el badge.) SemVer: PATCH = fix; MINOR = feature compatible; MAJOR = breaking.

3. **Merge `--no-ff` a `main`:**
   ```bash
   git checkout main && git pull --ff-only
   git merge --no-ff feature/<nombre> -m "merge: <feature> (v1.29.1)"
   ```

4. **Tag + push** (el push a `main` dispara el deploy — ver [§5]):
   ```bash
   git tag v1.29.1
   git push origin main --tags
   ```

5. **Limpieza:** borra la rama mergeada local y remota:
   ```bash
   git branch -d feature/<nombre>
   git push origin --delete feature/<nombre>
   ```

> Confirma siempre que `__version__`, el tag y la entrada de CHANGELOG **coinciden** en número. Una de las tres desincronizada es la causa #1 de "no sé qué hay en producción".

---

## 5. Deploy (autodeploy On Push → Dokploy)

**Arquitectura del deploy:** imagen **única** multi-stage (`Dockerfile`): etapa Node compila `frontend/dist`, etapa Python sirve API + `dist` con SPA-fallback. `docker-compose.yml` levanta `db` (Postgres 16) + `app`. En el VPS, **Dokploy/Traefik** termina TLS (Let's Encrypt) y enruta por dominio al **puerto interno 8000** del contenedor (NO el 8765). URL LIVE: `https://fleet-tracker-fleettracker-pov0zh-95b032-187-77-255-150.sslip.io`.

### 5.1 El flujo normal
1. `git push origin main` (paso [§4.4]).
2. Dokploy detecta el push (**On Push**), reclona `main`, hace `docker build` (Node + Python) y levanta `db` + `app`.
3. **Sigue los logs** en Dokploy hasta `Application startup complete`.
4. Abre la URL de producción (o `launch.bat`) y verifica: carga el front, login OK, el cambio está.

> **El build y el arranque contra Postgres SOLO se verifican en el VPS** — Docker no está instalado en el entorno de dev (DEPLOY.md §7). Por eso el gate de [§3] (`npm run build` + `import app.main` local) es tu única red antes de que el VPS lo ejecute de verdad.

### 5.2 Variables de entorno (Dokploy → Environment)
Setea **siempre** (persisten entre redeploys, sin SSH):
- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` — la `DATABASE_URL` la arma `config.py` con `URL.create` (no la setees a mano).
- Para que el **escaneo de invoices (docscan)** funcione en prod: `DOCSCAN_PROVIDER=groq` + `GROQ_API_KEY=<clave>`. (Sin esto, `auto` cae a Ollama, que **no está en el contenedor** → escaneo sin backend de visión. Groq corre cloud, ~2-3 s vs ~98 s del 7B local.)

### 5.3 Gotchas reales del deploy (todos ya costaron un incidente)

| # | Síntoma | Causa | Fix |
|---|---|---|---|
| **G1** | App en bucle de crash: `failed to resolve host '@db'` | La contraseña de Postgres tenía `@`/`:`/`/` y se pegaba cruda en `DATABASE_URL`, rompiendo el parseo del host. | **Resuelto v1.28.2:** se pasan `POSTGRES_*` por componentes y `config.py` arma la URL con `sqlalchemy.URL.create` (codifica la clave). Si vuelve a aparecer, verifica que **no** hay una `DATABASE_URL` pre-armada sobreescribiendo. |
| **G2** | Login devuelve **500**; no se guardan credenciales desde la UI | El volumen `./secrets` estaba montado `:ro`, pero la app **escribe** ahí el `auth_secret` que firma las sesiones (se autogenera en el primer login). | **Resuelto v1.28.4:** `./secrets` montado **read-write** (sin `:ro`, ver `docker-compose.yml` línea 70). Nunca lo vuelvas a `:ro`. |
| **G3** | El deploy build/arranca pero un endpoint da 500 al escribir | Cambio de esquema en tabla existente + `create_all` (no agrega columnas). | Ver [§2.4]: migración Alembic. **Antes** de mergear, no después. |
| **G4** | TS error rompe el `docker build` **en el VPS** | Se commiteó con `tsc --noEmit` pero `tsc -b` (build de prod) falla. | Gate [§3.1]: `npm run build` local **siempre** antes de push. |
| **G5** | Escaneo de invoices no hace nada en prod | `DOCSCAN_PROVIDER` sin setear → `auto` → Ollama (ausente en el contenedor). | Setear `DOCSCAN_PROVIDER=groq` + `GROQ_API_KEY` en Dokploy ([§5.2]). |
| **G6** | Postgres arrancó con credenciales `fleet/fleet` | `docker-compose.yml` (líneas 16/42) usa `${POSTGRES_PASSWORD:-fleet}`: si la env no se carga, arranca con la default débil **sin fallar**. | **Verifica en Dokploy → Environment** que las 3 vars están con secretos fuertes. (Hardening pendiente: quitar el default → `:?set in .env`, [AUDITORIA.md] A2.) |

### 5.4 Persistencia y datos (no perder lo del cliente)
- La base vive en el **named volume `pgdata`** — sobrevive a `docker compose up --build`. **No** corras `docker compose down -v` en prod (borra todo).
- `./data/uploads` (invoices de WO, docs de unidad) y `./data/jobs` (Excel temp) son bind mounts persistentes.
- **No hay backups automáticos** ([AUDITORIA.md] C3): un fallo de volumen/VPS = pérdida total (WOs, facturas, inventario, PM history — y registros DOT/DVIR con retención legal). Mientras se implementa el `pg_dump` cron, **no toques `pgdata` ni el VPS sin un dump manual previo**.

---

## 6. Troubleshooting rápido

| Problema | Primer chequeo |
|---|---|
| "No se ven mis cambios" en local | ¿Corriste `npm run build`? ¿Quedó un uvicorn viejo en el 8765? (El `.bat` mata el puerto; a mano, mátalo.) ¿Hiciste `git pull`? |
| El front compila pero la app no levanta | `py -c "import app.main"` — busca el error de import/orden de carga. |
| 401 inesperado en el front | El token se invalidó: `api.ts` limpia `'ft-token'` y dispara `ft-unauthorized` → vuelve al login. ¿Se regeneró `secret.local.json`? (Si `./secrets` se recreó, **todas** las sesiones se invalidan — [AUDITORIA.md] B1.) |
| 403 en un endpoint | Falta el scope para ese rol ([GLOSARIO.md] RBAC). Verifica `ROLE_SCOPES` en `core/permissions.py`. |
| Deploy "verde" pero la DB falla | Healthcheck es `/api/health` y **no toca la DB** ([AUDITORIA.md] M2): un verde no garantiza Postgres sano. Mira los logs reales en Dokploy. |
| Diagnóstico a ciegas en prod | No hay logging estructurado ni error tracking ([AUDITORIA.md] M1). Depende de los logs de uvicorn en Dokploy (`PYTHONUNBUFFERED=1` los manda a stdout). |

---

## 7. Definición de "hecho" (DoD)

Un cambio está listo cuando: (1) `npm run build` pasa limpio; (2) `import app.main` OK; (3) arrancó y se verificó el flujo en el navegador sin errores de consola; (4) el diff no filtra secretos/PII y respeta capas+idioma; (5) si tocó esquema, hay migración; (6) CHANGELOG + `__version__` + tag coinciden; (7) mergeado `--no-ff` a `main`, pusheado, ramas borradas; (8) el deploy en Dokploy llegó a `Application startup complete` y la URL LIVE responde con el cambio.

> Las deudas que **suben de severidad al crecer** (backups, Alembic real, CI con `docker build` como required check, usuario no-root, RLS, rate limit, secrets manager) están priorizadas en [ROADMAP-SEGURIDAD.md] y detalladas en [AUDITORIA.md]. Mientras no estén, la disciplina manual de este documento **es** el control de calidad.
