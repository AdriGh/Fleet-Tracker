# Avisos — Configuración (Drive en vivo + envío por Gmail)

La sección **Avisos** funciona sin configurar nada en **modo demo** (datos de
ejemplo) con **envío simulado**. Para que lea tu planilla real y mande correos
de verdad, configurá lo siguiente. Todo va en un único archivo local
**no versionado**: `backend/avisos.local.json` (copialo de `avisos.example.json`).

---

## Parte A — Lectura en vivo de la planilla (Service Account)

1. **Crear un proyecto en Google Cloud** (o usar uno existente):
   https://console.cloud.google.com/ → menú de proyectos → *Nuevo proyecto*.

2. **Habilitar la API de Google Sheets**:
   *APIs y servicios → Biblioteca* → buscar **Google Sheets API** → *Habilitar*.

3. **Crear la cuenta de servicio**:
   *APIs y servicios → Credenciales → Crear credenciales → Cuenta de servicio*.
   - Nombre: por ej. `dvir-avisos`.
   - No hace falta asignarle roles. *Listo*.

4. **Generar la clave JSON**:
   Entrá a la cuenta de servicio creada → pestaña *Claves* →
   *Agregar clave → Crear clave nueva → JSON*. Se descarga un archivo `.json`.
   - Guardalo como `backend/service_account.json` (NO se versiona).
   - Adentro vas a ver un campo `"client_email"` tipo
     `dvir-avisos@tu-proyecto.iam.gserviceaccount.com`. Copialo.

5. **Compartir la planilla con la cuenta de servicio**:
   Abrí tu **DVIR Report** en Google Sheets → *Compartir* → pegá el
   `client_email` del paso anterior → permiso **Lector** → *Enviar*.

6. **Configurar `avisos.local.json`** (copiá `avisos.example.json`):
   - `spreadsheet_id`: el ID que está en la URL de la planilla, entre `/d/` y
     `/edit` (`https://docs.google.com/spreadsheets/d/`**`ESTE_ES_EL_ID`**`/edit`).
   - `service_account_file`: `service_account.json` (o la ruta donde lo dejaste).
   - `company_sheets`: dejalo en `[]` para que detecte solas las hojas del mes
     más reciente (`CHASER N`, `MCC N`). O fijalas, por ej. `["CHASER 6", "MCC 6"]`.
   - `driver_info_sheet`: `Driver info` (nombre de la hoja de contactos).

Reiniciá la app. En la pantalla Avisos el banner debería decir
**«🔗 Leyendo en vivo: DVIR Report»**. Si algo falla, muestra el motivo y
sigue en modo demo.

---

## Parte B — Envío real por Gmail (App Password)

1. La cuenta debe tener **verificación en 2 pasos** activada.
2. Generá una **contraseña de aplicación** en
   https://myaccount.google.com/apppasswords (nombre: por ej. *DVIR Mailer*).
   Google te da una clave de 16 caracteres.
3. En `avisos.local.json`:
   - `gmail_sender`: tu correo (`luisadrianr13@gmail.com`).
   - `gmail_app_password`: la clave de 16 caracteres (con o sin espacios).
   - `dry_run`: `true` para seguir **simulando**, `false` para **enviar de verdad**.

> Recomendación: dejá `dry_run: true` hasta verificar en la vista previa que los
> destinatarios y el CC son correctos. Cambialo a `false` cuando estés listo.

---

## Seguridad

`backend/avisos.local.json` y `backend/service_account.json` están en
`.gitignore` y **nunca** se suben al repo. No los compartas ni los pegues en
ningún lado público.
