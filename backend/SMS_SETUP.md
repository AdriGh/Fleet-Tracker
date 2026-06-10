# Avisos por SMS/MMS — setup (Twilio + Cloudinary)

La app ya trae la integración; cuando tengas las credenciales las pegás en
`backend/twilio.local.json` y `backend/cloudinary.local.json` (copiá los
`*.example.json`). Mientras tanto, todo funciona en **modo simulado**
(`dry_run: true`): arma el mensaje y muestra el preview, sin enviar.

## 1) Twilio (envío de SMS/MMS)

1. Crear cuenta en <https://www.twilio.com/> y comprar un **número** con
   capacidad SMS/MMS (un número de EE.UU.).
2. Copiar del panel: **Account SID** (`ACxxxx…`) y **Auth Token**.
3. **Registro A2P 10DLC** (obligatorio para textear como empresa en EE.UU.):
   en Twilio → *Messaging → Regulatory Compliance* registrar la **marca** y una
   **campaña**, y crear un **Messaging Service** con el número adentro. Tarda
   días y tiene un fee. Sin esto, las operadoras filtran/bloquean los mensajes.
   - Recomendado: usar el **`messaging_service_sid`** (mejor entrega 10DLC) en
     vez de `from_number`.
4. Pegar en `backend/twilio.local.json`:
   ```json
   {
     "account_sid": "ACxxxx…",
     "auth_token": "…",
     "from_number": "+15551234567",
     "messaging_service_sid": "MGxxxx…",
     "dry_run": true,
     "sender_name": "Safety/Maintenance"
   }
   ```
   Dejá `dry_run: true` hasta querer enviar de verdad; `false` = envío real.
5. **STOP/HELP**: Twilio maneja el opt-out (STOP) automáticamente. Conviene
   tener consentimiento de los drivers.

## 2) Cloudinary (hosting del media para MMS / link de video)

Twilio MMS necesita una **URL pública** del archivo (la app es local, no la
puede servir). Por eso el media se sube a Cloudinary.

1. Crear cuenta free en <https://cloudinary.com/>.
2. Del *Dashboard*: copiar **Cloud name**, **API Key** y **API Secret**.
3. Pegar en `backend/cloudinary.local.json`:
   ```json
   {
     "cloud_name": "…",
     "api_key": "…",
     "api_secret": "…",
     "dry_run": true
   }
   ```

## Cómo se comporta el media
- **Imagen** → se sube a Cloudinary y se manda como **MMS** (adjunto).
- **Video** → se sube a Cloudinary y se manda el **link en el cuerpo** del SMS
  (el video por MMS casi no llega; el link siempre).

## Notas
- Los dos archivos son **secretos** (gitignored por `*.local.json`).
- Costo: SMS/MMS por mensaje (Twilio) + número + fee de 10DLC. Cloudinary free
  alcanza para este uso.
