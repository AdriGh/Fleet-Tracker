# Samsara — Conectar la app a los defectos en vivo

Esta guía es para obtener el **API token de Samsara** y dejar la app leyendo
los **defectos abiertos** directo de Samsara (sin subir CSV a mano).

Todo el secreto va en un único archivo local **no versionado**:
`backend/samsara.local.json` (copialo de `samsara.example.json`).

> Tiempo estimado: 5 minutos. Solo necesitás permisos de admin en tu cuenta de
> Samsara para crear el token.

---

## Qué vamos a usar

- Endpoint: **`GET https://api.samsara.com/defects/stream`**
- Parámetro clave: **`isResolved=false`** → Samsara devuelve **solo los defectos
  abiertos** (los resueltos quedan afuera). Por eso no hace falta ningún CSV ni
  marcar estados a mano: el estado "abierto/resuelto" lo maneja Samsara.
- Permiso necesario: **Read Defects** (categoría *Maintenance*). Es **solo
  lectura** — la app nunca modifica nada en Samsara.

---

## Paso a paso — crear el API token

1. **Entrá al dashboard de Samsara**: https://cloud.samsara.com
   (si tu cuenta es de la región Europa, es https://eu.samsara.com — ver nota
   de región más abajo).

2. Abrí **Settings / Configuración** (el engranaje, normalmente abajo a la
   izquierda).

3. Buscá **API Tokens** (puede aparecer como *Configuración → API Tokens*, o
   dentro de *Administración / Developer*). El nombre exacto del menú varía
   según tu rol y la versión del dashboard.

4. Tocá **Create API Token / Crear token**.
   - **Nombre**: `Fleet Tracker` (o el que quieras, para identificarlo).
   - **Scopes / Permisos**: marcá **únicamente** **Read Defects** dentro de la
     categoría **Maintenance**. No le des nada más (mínimo privilegio).

5. **Guardá / Generá** el token. Samsara te muestra una cadena larga
   (algo como `samsara_api_xxxxxxxxxxxxxxxxxxxx`).
   ⚠️ **Copiala en ese momento**: Samsara no te la vuelve a mostrar después.

6. Pasame el token (como hiciste con el App Password de Gmail) **o** dejalo
   configurado vos mismo en el paso siguiente.

---

## Configurar la app

1. En la carpeta `backend/`, copiá `samsara.example.json` a
   **`samsara.local.json`**.

2. Abrilo y completá. **Cada empresa (Chaser, MCC) es un org SEPARADO en
   Samsara, con su propio token.** Se listan en `orgs`:

   ```json
   {
     "open_only": true,
     "orgs": [
       {
         "name": "Chaser",
         "company": "CHASER",
         "api_token": "TOKEN_DE_CHASER",
         "base_url": "https://api.samsara.com"
       },
       {
         "name": "MCC (Memphis)",
         "company": "MCC",
         "api_token": "TOKEN_DE_MCC",
         "base_url": "https://api.samsara.com"
       }
     ]
   }
   ```

   - `api_token`: el token de ESE org (creado con los pasos de arriba, en la
     cuenta de Samsara de esa empresa).
   - `company`: `CHASER` o `MCC` — fuerza la empresa de todas las unidades de
     ese org (así caen en la pestaña correcta).
   - `base_url`: `https://api.samsara.com` (EE. UU.) o
     `https://api.eu.samsara.com` (Europa) — ver nota de región.
   - `open_only`: `true` para traer solo los defectos **abiertos**. Dejalo así.
   - Si todavía tenés **un solo** token, dejá un solo objeto en `orgs`. Un org
     con el token sin completar (placeholder) simplemente se ignora.

3. Reiniciá la app (`launch.bat`). En la pestaña **Defectos** el banner debería
   decir que está leyendo en vivo desde Samsara. Si un token falla, la app te
   muestra el motivo y no rompe nada (cae al CSV).

---

## Nota de región (importante)

Samsara tiene dos "nubes" separadas y **el token de una NO sirve en la otra**:

- **EE. UU. / resto del mundo** → `https://api.samsara.com`
- **Europa** → `https://api.eu.samsara.com`

Si entrás al dashboard por `eu.samsara.com`, usá la URL `api.eu.samsara.com`.
Para una flota en EE. UU. es casi seguro `api.samsara.com`.

---

## Seguridad

- `backend/samsara.local.json` está en `.gitignore` (patrón `*.local.json`) y
  **nunca** se sube al repo.
- El token es **read-only** (solo Read Defects). Aun así, tratalo como una
  contraseña: no lo pegues en chats públicos, mails ni capturas.
- Si alguna vez se filtra, en Samsara podés **revocar** el token y crear uno
  nuevo en segundos (mismo menú de API Tokens).

---

## Qué hago yo con esto

Una vez que tengas el token, del lado de la app queda:

- Módulo `core/samsara.py`: pide los defectos abiertos a `/defects/stream`
  (paginado), y arma por unidad: empresa (por prefijo MEM/MDW… → MCCI; sin
  prefijo → Chaser), tipo de defecto y comentario.
- La pestaña **Defectos** muestra el **Resumen por unidad** con los 3 botones
  **Chaser / MCCI / All**, sin selector de días, y un botón **Actualizar**.
- Fallback opcional: subir el CSV a mano por si la API no responde.

Cuando lo tengas, pasámelo (o avisame que ya está en `samsara.local.json`) y
lo enchufo.
