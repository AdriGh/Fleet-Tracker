# Deploy — Fleet Tracker (Docker + Postgres en Dokploy/VPS)

Guia para correr Fleet Tracker en un VPS con **Dokploy**, usando **Docker** y
**Postgres**. La app es una sola imagen: el backend FastAPI sirve la API y
ademas el frontend ya compilado (`frontend/dist`), con SPA-fallback. No hace
falta un contenedor aparte para el frontend ni un Nginx.

> Estado de este deploy: piloto. El esquema de la base se crea directo de los
> modelos con `create_all` sobre una Postgres **fresca** (ver
> [Base de datos](#base-de-datos)). Las migraciones Alembic versionadas quedan
> como tarea futura.

---

## 0. Que se construye

| Artefacto | Rol |
|-----------|-----|
| `Dockerfile` | Build multi-stage: Node compila el frontend, Python sirve API + dist. |
| `.dockerignore` | Mantiene el contexto chico y **fuera secretos/datos locales**. |
| `docker-compose.yml` | Servicios `db` (Postgres 16) y `app`; volumenes persistentes. |
| `.env` (lo creas vos) | Credenciales de Postgres y puerto. **No commitear.** |
| `./secrets/` (lo creas vos) | Los `*.local.json` opcionales montados en runtime. **No commitear.** |
| `./data/` (se crea solo) | Persistencia de `uploads/` y `.jobs/`. |

---

## 1. Arranque rapido (local con Docker, para probar antes del VPS)

```bash
# En la raiz del repo:
cp backend/.env.example .env     # editar (ver seccion 2); o crear .env a mano
mkdir -p secrets data/uploads data/jobs

docker compose up --build -d
docker compose logs -f app       # esperar "Application startup complete"
```

Abrir http://localhost:8765 → primer arranque muestra el **OnboardingWizard**
para crear el admin (ver seccion 5).

---

## 2. Variables de entorno (`.env`)

Crear un archivo `.env` en la raiz (junto a `docker-compose.yml`):

```dotenv
# --- Postgres ---
POSTGRES_USER=fleet
POSTGRES_PASSWORD=cambiame-por-algo-fuerte
POSTGRES_DB=fleet

# --- Puerto publicado del host (solo si publicas el puerto a mano) ---
APP_PORT=8765
```

El compose arma sola la `DATABASE_URL` apuntando al servicio `db`:

```
postgresql+psycopg://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
```

No hace falta setear `DATABASE_URL` a mano: solo cambiar usuario/clave/db
arriba. El driver es **psycopg3** (`psycopg[binary]`), ya en
`backend/requirements.txt`.

> Si preferis una Postgres externa (gestionada), seteá `DATABASE_URL`
> directamente como variable de entorno del servicio `app` y borrá el servicio
> `db` del compose.

---

## 3. Secretos / integraciones (todos OPCIONALES)

La app **corre sin ningun secreto**: cada integracion sin credenciales arranca
en modo offline/degradado. Los secretos viven como archivos
`backend/<name>.local.json` (gitignored) y NO se hornean en la imagen.

En produccion se montan desde un **unico directorio** `./secrets` (read-write:
la app ademas autogenera ahi el `secret.local.json` que firma las sesiones, y
guarda las credenciales que configures por la UI). El contenedor los lee desde
ahi gracias a `FLEET_SECRETS_DIR=/app/secrets` (ya seteado en el compose).

```bash
mkdir -p secrets
# Copiar SOLO los que uses (nombre exacto: <name>.local.json):
#   secret.local.json      -> secreto de firma de tokens de sesion (recomendado)
#   samsara.local.json     -> ELD/telematica Samsara (roster vivo, GPS)
#   docscan.local.json     -> escaneo de invoices con IA (Groq recomendado; ver CAVEAT abajo)
#   avisos.local.json      -> Gmail/Drive (envio de avisos por email)
#   twilio.local.json      -> SMS
#   cloudinary.local.json  -> hosting de imagenes
#   telegram.local.json    -> notificaciones Telegram
#   lynx.local.json        -> control remoto de reefer (Carrier Lynx)
#   thermoking.local.json  -> reefer Thermo King
#   traccar.local.json     -> tracking Traccar
```

Hay ejemplos versionados (`backend/*.example.json`) para ver el formato de cada
uno. Copiá el `.example.json`, renombralo a `<name>.local.json`, completá los
valores y dejalo en `./secrets`.

> `org_config` (branding, umbrales, datos del taller) **NO** es un secreto que
> se monte: se guarda en la base (tabla `org_setting`) y se edita desde
> **Settings** dentro de la app. El `org.local.json` legacy solo servia para
> migrar datos single-tenant viejos; en un deploy fresco no se usa.

---

## 4. Volumenes persistentes

| Volumen | Para que |
|---------|----------|
| `pgdata` (named) | Datos de Postgres. **No borrar** salvo reset total. |
| `./data/uploads` → `/app/backend/uploads` | Invoices de WO (`wo_invoices/`) y docs de unidad (`unitdocs/`). |
| `./data/jobs` → `/app/backend/.jobs` | Excel temporales generados. |
| `./secrets` → `/app/secrets` (rw) | Los `*.local.json` + el `secret.local.json` autogenerado (firma de sesiones). Persiste entre redeploys. |

Sin los mounts de `uploads` y `.jobs`, esos archivos se pierden al recrear el
contenedor. La base vive en `pgdata` (named volume), que sobrevive a
`docker compose up --build`.

---

## 5. Primer arranque (onboarding del admin)

Cuando la tabla `user` esta vacia, la API queda abierta **solo** hasta crear el
primer usuario, y el frontend muestra el **OnboardingWizard**:

1. Abrir la URL de la app.
2. Completar el wizard → crea el usuario **admin** (rol `admin`).
3. A partir de ese momento la API exige login (Bearer token) y el wizard ya no
   aparece.

La organizacion `default` (modo single-tenant) se siembra sola en el primer
arranque.

---

## 6. Deploy en Dokploy (VPS)

Dokploy corre el `docker-compose.yml` del repo y enruta el trafico con su proxy
interno (Traefik) por dominio. Pasos:

1. **Repo / acceso**: en Dokploy, crear un proyecto y un servicio tipo
   **Compose** apuntando a este repo (rama `main`). Dokploy clona el repo y usa
   el `docker-compose.yml` de la raiz.

2. **Environment**: en la pestaña *Environment* del servicio, cargar las
   variables de la seccion 2 (`POSTGRES_USER`, `POSTGRES_PASSWORD`,
   `POSTGRES_DB`). No hace falta `DATABASE_URL` (la arma el compose).

3. **Secretos / volumenes**: en el host del VPS, dentro de la carpeta del
   servicio (la que Dokploy usa como build context), crear:
   ```bash
   mkdir -p secrets data/uploads data/jobs
   # subir aca los <name>.local.json que correspondan (scp / editor de Dokploy)
   ```
   Los paths `./secrets`, `./data/uploads`, `./data/jobs` del compose son
   relativos a esa carpeta. (Alternativa: usar la seccion *Volumes/Mounts* de
   Dokploy para mapear rutas del host.)

4. **Dominio**: en *Domains*, asignar el dominio y apuntar el **puerto interno
   8000** (el del contenedor, no el 8765 publicado). Traefik termina TLS
   (Let's Encrypt) y enruta al 8000. Con dominio por Dokploy **no** hace falta
   publicar `APP_PORT` (podés quitar el bloque `ports:` o ignorarlo).

5. **Deploy**: pulsar *Deploy*. Dokploy hace el build de la imagen (etapa Node +
   etapa Python) y levanta `db` y `app`. Seguir los logs hasta
   *Application startup complete*.

6. **Onboarding**: abrir el dominio y completar el wizard (seccion 5).

7. **Updates**: cada vez que mergees a la rama desplegada, *Deploy* de nuevo.
   `create_all` es idempotente: no toca las tablas existentes (ver caveats).

---

## 7. Verificacion

- Healthcheck del contenedor: `GET /api/health` (lo usa Docker; en la
  allowlist de auth, no requiere token).
- `docker compose ps` → `app` y `db` en estado *healthy*.
- Abrir la URL → cargar el frontend; tras onboarding, login OK.

> **Importante:** el **build de la imagen** y el **arranque contra Postgres**
> deben verificarse en el VPS/Dokploy. No se pudieron correr en el entorno de
> desarrollo (Docker no esta instalado ahi). Lo unico verificado localmente es
> que `import app.main` sigue limpio tras el cambio de `db.py`/`secretstore.py`.

---

## 8. Caveats (leer antes de prometerle features al cliente)

1. **Base de datos / migraciones.** El esquema se crea con
   `Base.metadata.create_all` directo de los modelos, sobre una Postgres
   **fresca** (que es el caso de un piloto nuevo). `create_all` es idempotente:
   crea las tablas faltantes y **no** altera las existentes. Por eso **no**
   agrega columnas nuevas a una base ya poblada con un esquema viejo. El camino
   correcto a futuro son migraciones **Alembic** versionadas
   (`alembic upgrade head`); hoy Alembic solo tiene la migracion inicial, por
   eso este deploy usa `create_all`. (El path SQLite `_migrate()` quedo
   restringido a dev local.)

2. **Escaneo de invoices con IA (docscan).** El proveedor por defecto es `auto`,
   que cae a **Ollama local** si no hay otras credenciales — y **Ollama NO esta
   en el contenedor**. Groq NO entra en `auto` (se elige explicito). Para que el
   escaneo funcione en prod, **lo mas simple es por variables de entorno** (en
   Dokploy → Environment; persisten entre redeploys, sin SSH ni archivos):
   - **OPCION RECOMENDADA (env vars):** `DOCSCAN_PROVIDER=groq` +
     `GROQ_API_KEY=<clave de console.groq.com>` (usa el modelo
     `meta-llama/llama-4-scout-17b-16e-instruct` por defecto). Es cloud (corre
     dentro del contenedor, a diferencia de Ollama), **~2-3 s vs ~98 s** del 7B
     local, y el free-tier alcanza para un piloto. Este escaneo lo provee el
     **operador** (central) — NO se le pide la key al cliente.
   - **alternativa (archivo):** dejar `docscan.local.json` en `./secrets` con
     `{"provider":"groq","groq_api_key":"..."}` — la app lo lee via
     `FLEET_SECRETS_DIR` (montaje persistente).
   - maxima precision: `DOCSCAN_PROVIDER=anthropic` + `api_key` de
     platform.claude.com (de pago), o `"provider":"anthropic"` en el archivo.
   - o apuntar `"ollama_url"` a un Ollama externo accesible desde el contenedor.
   Sin esto, el resto de la app funciona; solo el auto-fill por escaneo queda sin
   backend de vision.

3. **Cold Chain / reefer.** Sin credenciales reales de OEM (Carrier Lynx,
   Thermo King) o Traccar, la pestaña Cold Chain corre en **modo demo** (datos
   sinteticos). Para datos reales hay que cargar `lynx.local.json` /
   `thermoking.local.json` / `traccar.local.json`.

4. **Secretos = integraciones opcionales.** Samsara, Gmail/avisos, Twilio/SMS,
   Telegram, Cloudinary, etc. degradan a offline/simulado si falta su
   `*.local.json`. La app no se cae por eso.

---

## 9. Onboarding de un cliente piloto (ej. Journey)

Checklist para dejar listo un cliente nuevo **despues** de desplegar la instancia
(secciones 1-6). Marca el orden recomendado:

### 1. Cuenta + empresa
- [ ] Completar el **OnboardingWizard** → admin del cliente.
- [ ] **Settings → Company**: nombre + acento de marca; datos del taller (nombre,
      direccion, telefono — salen impresos en los invoices); Bill-To por empresa.
- [ ] **Settings → Company**: umbrales (PM interval, DVIR min minutes, defect
      lookback), labor rate, y CC routing por terminal si aplica.

### 2. Escaneo de invoices — lo provees TU (central)
- [ ] `docscan.local.json`: `provider: "groq"` + tu `groq_api_key`. NO se lo pides
      al cliente. Verifica que un escaneo tarda ~segundos (no ~98 s).

### 3. Telemetria / ELD del cliente — lo trae Journey
- [ ] `samsara.local.json` (o Motive): token **read-only** de Journey → flota,
      conductores, GPS, DVIR y defectos en vivo. Sin esto la flota/roster no se
      auto-cargan.
- [ ] Confirmar los **scopes** del token (vehiculos, HoS, defectos, y trailer
      stats si hay reefer).

### 4. Cold Chain — el moat (reefers de Journey)
- [ ] Conectar la **fuente real de reefers**: `lynx.local.json` /
      `thermoking.local.json` (OEM, control two-way) o `traccar.local.json`
      (aftermarket). Sin esto, Cold Chain queda en **DEMO**.
- [ ] **Esto es lo clave a conseguir de Journey** para el piloto de reefer:
      acceso a sus dispositivos/plataforma. Es lo que valida el moat reefer→WO.

### 5. Avisos a conductores (opcional)
- [ ] `avisos.local.json` (Gmail) y/o `twilio.local.json` (SMS) si el cliente va
      a mandar notices a sus conductores.

### 6. Datos iniciales
- [ ] **Parts & Vendors**: catalogo de partes + proveedores; **Inventory**: stock
      y reorder points iniciales.
- [ ] **PM history**: export de Fullbay → `pm.local.csv` para arrancar el PM
      Tracker con datos reales.
- [ ] **Settings → Users**: alta del equipo del cliente (dispatcher / mechanic /
      viewer).

### 7. Seguridad
- [ ] **Rotar** cualquier token que se haya pegado en chat/docs.
- [ ] `secret.local.json` presente (firma de sesiones) y `./secrets` en
      read-only.

> Para el piloto compartido (pocos clientes en una instancia): el escaneo central
> con Groq free-tier alcanza. Al crecer, pasar a un plan Groq de pago y mover las
> integraciones de cada cliente (ELD/reefer/email) a config **por-org** — ver el
> backlog de productización.
