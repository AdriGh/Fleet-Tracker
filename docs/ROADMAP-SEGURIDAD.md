# Roadmap de Seguridad (login inseguro → app blindada)

Este documento es el plan maestro para llevar Fleet Tracker desde su autenticación casera actual (sin OAuth, sin MFA, sin rate-limit, token de 30 días en `localStorage`) hasta una **app cerrada que protege los datos de sus usuarios** (PII de conductores, facturas, inventario, datos de flota). Está pensado como contexto para futuros agentes de IA: cada etapa dice qué hacer, qué NO hacer, con qué herramientas, **cuál es el estado real hoy en el código** (con `archivo:línea`), el GAP, y un checklist de salida mapeado a OWASP ASVS. Léelo junto a `AUDITORIA.md` (hallazgos crudos), `ARQUITECTURA.md`, `DECISIONES.md`, `ERRORES-CONOCIDOS.md` y `FLUJO-DE-TRABAJO.md`.

> **Aviso de honestidad:** Fleet Tracker está **LIVE en producción** (Dokploy/Hostinger VPS, Postgres multi-tenant). Eso eleva la severidad real de todo lo que sigue: ya no es "app local de una caja". Lo que en single-box era aceptable, en internet es explotable hoy.

---

## Estado actual (línea base) y objetivo

**Lo que ya está bien hecho (NO romper al avanzar):**
- Hashing de contraseñas con PBKDF2-SHA256, 200k iteraciones, salt de 16 bytes por usuario (`backend/app/core/auth.py:55-70`).
- `hmac.compare_digest` en verificación de password y de firma de token → resistente a timing (`auth.py:68`, `auth.py:93`).
- Timing uniforme ante usuario inexistente (`auth.py:166-168`).
- RBAC **server-side** con matriz rol→scope explícita (`backend/app/core/permissions.py:44-58`); el cliente recibe scopes solo para pintar UI, no para autorizar.
- Mensaje de login genérico ("Incorrect username or password", `routes.py:1159-1160`) → sin enumeración por mensaje.
- Reset de password **sin endpoint HTTP** (solo CLI `backend/scripts/reset_password.py`) → no hay flujo de reset por email que abusar.
- Aislamiento multi-tenant de **lecturas** por `org_id` vía `with_loader_criteria` en el evento `do_orm_execute` (`backend/app/db.py`).
- Secretos fuera de git/imagen: `.gitignore`/`.dockerignore` cubren `*.local.json`, `roster.csv`, `.env`; Postgres no publica puerto; abstracción `SecretStore` lista para enchufar un manager (`secretstore.py`).

**Lo que falta (el trabajo de este roadmap):**
- Middleware de autorización **default-allow**: rutas de escritura no enumeradas las ejecuta cualquier autenticado, incluido `viewer` (`main.py:92`, `:106-118`).
- Ventana de toma de control en el primer arranque (API abierta + admin sintético sin usuarios) (`main.py:106-111`, `routes.py:1121-1122`).
- Sin rate-limit ni lockout en login (`auth.py:159-173`).
- Token bearer de **30 días** en `localStorage`, stateless, sin revocación (`auth.py:33`, `frontend/src/api.ts:13-16`).
- Política de password = solo `len ≥ 8`, sin breach-check, duplicada en 3 sitios (`auth.py:130`, `:200`, `scripts/reset_password.py`).
- Sin MFA, sin verificación de email, sin OAuth/OIDC.
- Escrituras Core (`update`/`delete`) **no filtran `org_id`** → IDOR de escritura cross-tenant (`backend/app/core/alerts.py` `ack_events`).
- Sin cabeceras de seguridad (CSP/HSTS), sin CSP, sin observabilidad de seguridad, sin backups de DB, sin Alembic operativo, contenedor como root.

**Objetivo de producción:** alcanzar **OWASP ASVS Level 2 verificado** (estándar para apps con datos personales/financieros), con elementos selectos de L3 (auditoría, defensa en profundidad) en módulos de alto valor (PII, billing). La estrategia de niveles y modelos de madurez (SAMM/ASVS/SSDF) está en `AUDITORIA.md`.

**Orden de prioridad (por riesgo y dependencia):** las etapas son **acumulativas** y van de lo crítico-explotable-hoy a lo de madurez. No se "sale" de una rompiendo la anterior.

---

## Etapa 1 — Cerrar la autorización: default-deny y bootstrap seguro

**Objetivo:** que ningún usuario haga más de lo que su rol permite, y que el primer arranque no sea secuestrable. Es el riesgo #1 (OWASP A01 Broken Access Control) y lo único **explotable sin credenciales** hoy.

**Qué implementar (concreto):**
1. **Invertir el middleware a default-deny** (`main.py:48-118`). Para todo método ≠ GET, si `_scope_for` devuelve `None`, responder **403 fail-closed** en vez de dejar pasar. Mantener una allowlist mínima y explícita de mutaciones públicas (`/api/auth/login`, `/api/auth/setup`).
2. **Cubrir las rutas hoy descubiertas** que el audit confirmó sin scope (existen en `routes.py` pero `_scope_for` no las matchea): `POST /api/companies`, `/api/companies/rename`, `DELETE /api/companies/{key}` (`routes.py:1397-1417`); `POST /api/teams`, `/teams/assign`, `DELETE /api/teams/{key}` (`routes.py:1291-1312`); `POST /api/integrations/test` y `/api/integrations/eld/active` (`routes.py:1439,1466` — solo `/integrations/config` está cubierto); `POST /api/batch/generate` (`routes.py:153`); `POST /api/reporting/eld/import` (`routes.py:273`).
3. **Migrar a `Depends(require_scope(...))` por endpoint** (ya existe a medias en `routes.py:1115`) en vez de prefijos de string frágiles. Cada ruta nueva queda obligada a declarar su scope o no compila la intención.
4. **Bootstrap con token de un solo uso:** proteger `/api/auth/setup` con `FLEET_SETUP_TOKEN` inyectado por env que el dueño debe presentar. **No abrir toda la API** cuando no hay usuarios (`main.py:106-111`): solo `auth/status`, `auth/setup`, `health` responden; el resto da 401/403. Eliminar el admin sintético de `require_scope` cuando `users_exist()` es falso (`routes.py:1121-1122`).
5. **IDOR de escritura cross-tenant:** añadir filtro `org_id` explícito en escrituras Core. Empezar por `core/alerts.py::ack_events` (un `viewer`/usuario de otra org marca alertas ajenas o de toda la base). A mediano plazo, un listener para `is_update`/`is_delete` y/o **Row-Level Security de Postgres** (la "fase 3c-2" pendiente en `db.py`).
6. **`update_user` filtrado por org + sin quedarse sin admin** (`auth.py:186-208`): validar que el target pertenece a la org del admin actuante; impedir degradar al último admin.

**Buenas prácticas:** deny-by-default salvo recursos públicos; autorización 100% server-side; comprobar ownership/tenant en **cada** query (no solo "estar autenticado"); loguear los 403 y alertar ante repetición; un solo mecanismo de control reusado en toda la app.

**Malas prácticas a evitar:** seguridad por "la ruta no está en la lista"; confiar en que el frontend oculte botones; IDs/recursos accesibles por "estar logueado"; dejar `return None` como fallthrough permisivo (`main.py:92`).

**Herramientas:** dependencias FastAPI (`Depends(require_scope)`), Postgres RLS por `tenant_id`, tests automatizados de IDOR/cross-tenant en CI (Schemat_thesis/pytest por tenant).

**Estado actual + GAP:** RBAC server-side existe y es bueno, **pero** el middleware es default-allow (`main.py:92`) y `_scope_for` no cubre companies/teams/integrations-test/batch/reporting → escalada vertical/horizontal real. Bootstrap deja la API abierta + admin sintético (`main.py:106-111`, `routes.py:1121-1122`). Escrituras Core no filtran org.

**Criterios de salida (checklist):**
- [ ] Todo `POST/PATCH/DELETE` sin scope explícito devuelve 403 (probado con un token `viewer` contra companies/teams/integrations/batch/reporting).
- [ ] `/api/auth/setup` exige `FLEET_SETUP_TOKEN`; sin usuarios, solo responden status/setup/health.
- [ ] `ack_events` y demás `update/delete` Core filtran por `org_id`; test cross-tenant pasa.
- [ ] `update_user` rechaza target de otra org y no permite quedarse sin admin.
- [ ] Cada endpoint de mutación usa `Depends(require_scope)`; no quedan prefijos de string como única defensa.

→ **OWASP ASVS V4 (Access Control) Level 2.**

---

## Etapa 2 — Anti-fuerza-bruta: rate limiting, lockout e IP banning

**Objetivo:** frenar fuerza bruta, credential stuffing y DoS por costo de PBKDF2 en login/setup. (OWASP API4:2023 Unrestricted Resource Consumption; A07 Auth Failures.)

**Qué implementar:**
1. **Rate-limit en la app** con `slowapi` + **Redis** (estado compartido, imprescindible multi-worker). Límite estricto y dedicado en `/api/auth/login` y `/api/auth/setup` (p.ej. 5/min) y en endpoints caros (docscan/IA Groq — p.ej. 10/min, ver Etapa 5).
2. **Clave por CUENTA y por IP** (no solo IP: los atacantes rotan IPs). Contador de fallos por username en Redis (TTL 1h) con **backoff exponencial / soft-lockout** tras >5 fallos (umbral ASVS), nunca hard-lockout permanente (sería DoS contra cuentas legítimas).
3. **IP real detrás de Traefik/Dokploy:** arrancar Uvicorn con `--forwarded-allow-ips="<IP de Traefik>"` (nunca `*`); configurar `sourceCriterion.ipStrategy.depth` en el middleware RateLimit de Traefik. Sin esto, el `X-Forwarded-For` es spoofeable y el rate-limit es inútil.
4. **Capa proxy:** middleware `RateLimit` de Traefik (token bucket) + plugin `fail2ban` que banea por ráfaga de 4xx (`maxretry`, `bantime` temporal). Orden: security-headers → ratelimit amplio → fail2ban focalizado.
5. **Respuestas correctas:** HTTP **429** + `Retry-After` + headers `RateLimit-*`.

**Buenas prácticas:** soft-lockout/backoff antes que bloqueo permanente; baneos temporales y graduales; spending caps en proveedores externos (Groq); CAPTCHA condicional (Cloudflare Turnstile) tras varios fallos.

**Malas prácticas a evitar:** rate-limit solo por IP; confiar en `X-Forwarded-For` sin allowlist; limitador in-memory con varios workers (cada uno cuenta aparte); hard-lockout por IP/cuenta; rate-limit solo en frontend.

**Herramientas:** `slowapi` / `fastapi-limiter`, Redis, Traefik RateLimit + plugin fail2ban, Cloudflare (edge) opcional.

**Estado actual + GAP:** **No existe ninguna primitiva de throttling** (`auth.py:159-173`); login invocable ilimitadamente. PBKDF2 200k encarece offline pero no online; cada intento cuesta CPU → vector de DoS. No hay Redis en el stack.

**Criterios de salida:**
- [ ] Login/setup limitados por cuenta+IP con 429+`Retry-After`; verificado con script de fuerza bruta.
- [ ] Soft-lockout/backoff tras >5 fallos por cuenta, con alerta.
- [ ] Uvicorn confía solo en la IP de Traefik; `X-Forwarded-For` spoofeado no salta el límite.
- [ ] Redis desplegado y compartido entre workers.
- [ ] fail2ban de Traefik banea ráfagas de 4xx con bantime temporal.

→ **OWASP ASVS V6 (Authentication) Level 2 (anti-automation).**

---

## Etapa 3 — Sesiones endurecidas: sacar el token de `localStorage` y hacerlo revocable

**Objetivo:** que un XSS no robe la sesión y que un token robado se pueda invalidar. (OWASP Session Management Cheat Sheet; A02.)

**Qué implementar:**
1. **Sacar el token de `localStorage`** (`api.ts:13-16`). Patrón recomendado para esta SPA: **cookie `HttpOnly; Secure; SameSite=Lax; Path=/`** emitida por FastAPI (BFF), inaccesible a JS; el SPA llama con `credentials:'include'`. Alternativa transicional: access token corto **en memoria** (React state) + refresh en cookie HttpOnly.
2. **Bajar el TTL** de 30 días (`auth.py:33`) a horas + **refresh token** rotado en cada uso, con **detección de reuse** (si llega un refresh ya rotado → invalidar toda la familia). Guardar refresh **hasheado** en Postgres.
3. **Revocación granular:** incluir un `token_version`/`pw_version` por usuario en el payload, que se incremente al cambiar password o ante incidente (invalida tokens previos). Hoy cambiar la contraseña **no** invalida tokens viejos (el hash no entra en la firma, `auth.py:75-107`). Alternativa: `jti` + denylist en Redis con TTL = vida restante.
4. **CSRF:** al migrar a cookie, proteger mutaciones con **double-submit token** firmado + header custom; `SameSite` es defensa en profundidad, no reemplaza el token.
5. **Regenerar el identificador de sesión al login** (anti session-fixation); logout que invalida server-side.

**Buenas prácticas:** session ID opaco con ≥128 bits de entropía (CSPRNG); idle + absolute timeout enforced server-side; nunca JWT/token en `localStorage`/`sessionStorage`.

**Malas prácticas a evitar:** token de larga vida sin revocación; rotar el secreto global como único "logout" (desloguea a todos); confiar en TLS para todo (no protege predicción/fixation del ID).

**Herramientas:** cookies HttpOnly de FastAPI, Redis (denylist/refresh), `fastapi-csrf-protect`, `pyjwt` si se mantiene JWT corto.

**Estado actual + GAP:** token bearer de 30 días en `localStorage` (`api.ts:13-16`, `auth.py:33`); payload = `user_id.expiry` sin `jti` ni versión (`auth.py:75-107`); `verify_token` sí revalida `user.active` (desactivar corta el acceso) pero no hay revocación granular. El patrón fetch+blob para descargas (api.ts) existe justamente porque el token va en header; una cookie HttpOnly lo simplificaría.

**Criterios de salida:**
- [ ] El token de sesión **no** es accesible por JS (`localStorage.getItem('ft-token')` ya no aplica).
- [ ] TTL ≤ 24h con refresh rotado y detección de reuse.
- [ ] Cambiar password / "cerrar sesión en todos lados" invalida tokens previos (token_version o jti).
- [ ] CSRF protegido si se usa cookie; CORS estricto con `allow_credentials` solo al origen exacto.

→ **OWASP ASVS V3 (Session Management) Level 2.**

---

## Etapa 4 — Identidad correcta: política de contraseñas, breach-check y verificación de email

**Objetivo:** endurecer el factor único que hoy basta para entrar. (OWASP A07; NIST SP 800-63B.)

**Qué implementar:**
1. **Centralizar la validación de password** (hoy duplicada en `auth.py:130`, `auth.py:200`, `scripts/reset_password.py`) en una función única.
2. **Subir el mínimo** a ≥12 (≥8 solo si hay MFA), permitir Unicode/espacios, máximo ≥64, **sin reglas de composición** forzadas (alineado a NIST).
3. **Breach-check** contra Pwned Passwords (HIBP k-anonymity, sin enviar la clave) en signup y cambio; rechazar comunes/filtradas. `password123` debe fallar.
4. **Validar `username`/email:** hoy `username` es arbitrario, normalizado a `lower()` y truncado a 40 (`auth.py:126`, `:142`), sin formato. Definir charset/formato; si pasa a multi-tenant real, `username` debe ser único **por org**, no global (ver `db.py` `User.username unique=True`).
5. Feedback de fuerza en el frontend (sin confiar solo en él).

**Buenas prácticas:** validación de fuerza server-side; rotación periódica NO obligatoria; mensajes y tiempos constantes en reset/registro (no revelar si la cuenta existe).

**Malas prácticas a evitar:** única regla `len≥8`; reglas de composición que empujan a `Password1!`; validar solo en cliente; `username` único global en un SaaS multi-tenant.

**Herramientas:** API HIBP (k-anonymity), `pydantic` v2 para validar el borde, `zxcvbn` para fuerza en UI.

**Estado actual + GAP:** única regla `len ≥ 8` (`auth.py:130-131`), sin breach-check, duplicada en 3 sitios; `username` sin formato y único global (rompe multi-tenant). Combinado con la falta de rate-limit (Etapa 2), facilita el stuffing.

**Criterios de salida:**
- [ ] Una sola función valida password en todo el código.
- [ ] Mínimo ≥12 sin MFA; breach-check HIBP activo en signup/cambio.
- [ ] `username`/email validados por formato; unicidad por-org si aplica multi-tenant.

→ **OWASP ASVS V6 (Authentication) Level 1→2.**

---

## Etapa 5 — Validación de input, inyección y file uploads (borde de la API)

**Objetivo:** cerrar inyección, mass-assignment, XSS y abuso de uploads. (OWASP A03 Injection; API3 BOPLA; A01.)

**Qué implementar:**
1. **Schemas Pydantic estrictos** (`ConfigDict(extra='forbid', strict=True)`) en todos los bodies. Hoy hay endpoints que aceptan `body: dict` crudo sin schema: `parts_create`/`parts_update` (`routes.py:758,766`), `vendors_create`/`vendors_update` (`routes.py:725,733`) → definir `PartIn`/`VendorIn` como ya se hizo para WO/PO. Esto cierra mass-assignment de un golpe.
2. **Separar schemas por dirección/rol** (`...Create`/`...Update`/`...Out`); campos sensibles (`role`, `org_id`, `active`, `price`) nunca en schemas de creación/edición de usuario normal.
3. **Cotas numéricas:** `qty`/`unit_cost` en líneas de WO/PO sin tope ni rechazo de NaN/inf (`routes.py:524,543`); `limit` de queries sin cota máxima. Aplicar `Field(ge=0, le=...)` y clamp de `limit` en todos los GET.
4. **SQLi: ya cubierto** (ORM parametrizado; el único SQL crudo usa identificadores hardcodeados de dev). Mantener la invariante: nunca f-strings en SQL; identificadores dinámicos solo vía allowlist de columnas.
5. **XSS/CSP:** middleware que setee **CSP** (`script-src 'nonce-...' 'strict-dynamic'; object-src 'none'; base-uri 'none'`), `X-Content-Type-Options`, `Referrer-Policy`, **HSTS** (pendiente el candado HTTPS). React auto-escapa; prohibir `dangerouslySetInnerHTML` sin DOMPurify.
6. **File uploads (flujo docscan de facturas/PDFs):** validar **magic bytes** (`python-magic`) + extensión + content-type; renombrar a UUID; guardar fuera del webroot sin permisos de ejecución; límite de tamaño; re-encode de imágenes con Pillow; servir con `Content-Disposition: attachment`. Revisar el catch-all `spa_fallback` que sirve archivos por path (`main.py:149-154`, `FileResponse(target)`) para descartar traversal fuera de `dist/`.
7. **SSRF:** si hay fetch de URLs de usuario (marketplace/vPIC/webhooks), resolver DNS → validar IP no-privada/no-metadata (`169.254.169.254`) → re-validar tras redirects.

**Buenas prácticas:** allowlist (positive validation), no blocklist; sanitizar por contexto destino; canonicalizar antes de validar; "valida temprano, estricto, una vez".

**Malas prácticas a evitar:** reutilizar el modelo SQLAlchemy como request body; Pydantic sin `extra='forbid'`; validar uploads por extensión/Content-Type; CSP con `unsafe-inline`/`*`.

**Herramientas:** Pydantic v2, `nh3`/DOMPurify, `python-magic`, Pillow, ClamAV, `secweb`/middleware CSP propio.

**Estado actual + GAP:** SQLi sin riesgo (ORM). Pero endpoints `body: dict` sin schema (mass-assignment latente), sin cotas numéricas, **sin cabeceras de seguridad** (no hay middleware CSP/HSTS), file uploads sin validación de magic bytes documentada.

**Criterios de salida:**
- [ ] Todos los bodies usan Pydantic con `extra='forbid'`; no quedan `body: dict`.
- [ ] Cabeceras CSP/HSTS/X-Content-Type-Options en todas las respuestas.
- [ ] Uploads validados por magic bytes + renombrados + fuera del webroot.
- [ ] SAST sin findings críticos de inyección.

→ **OWASP ASVS V5 (Validation/Sanitization/Encoding) Level 2.**

---

## Etapa 6 — Secretos, cripto en reposo y configuración 12-Factor

**Objetivo:** que filtrar el filesystem o el repo no entregue las llaves del reino. (OWASP Secrets Mgmt; ASVS V6/V9.)

**Qué implementar:**
1. **Purgar PII del historial git (CRÍTICO):** `roster.csv` (camión→conductor del ex-empleador) sigue recuperable con `git show 97977bf:roster.csv` aunque `ca2627d` lo borró del HEAD. Reescribir con `git filter-repo --path roster.csv --invert-paths`, force-push, confirmar que Dokploy re-clona. Verificar que ningún `*.local.json`/`service_account.json` entró nunca.
2. **Endurecer el secreto HMAC** (`auth.py:37-50`, `secretstore.py:68-71`): soportarlo vía env/secrets-manager (la abstracción `SecretStore` ya está lista); **escritura atómica** (`tempfile`+`os.replace`) y `chmod 0600` (hoy `write_text` plano sin permisos, `secretstore.py:70-71`); **loggear warn** cuando se autogenera (hoy se regenera en silencio si el volumen se pierde → logout global silencioso); esquema de rotación con 2 secretos (actual+anterior) para no desloguear a todos.
3. **Cifrado en reposo de credenciales de integración** (pendiente G7.2, hoy en claro en `./secrets`): Samsara, Groq, Twilio, Gmail SA. Mínimo inmediato: permisos `600` + dueño no-root.
4. **Config 12-Factor:** cargar con `pydantic-settings` (`BaseSettings`) con `extra='forbid'` y **fail-fast** si falta un secreto. La clave de Groq vive **solo en backend** (el frontend llama a `/api/scan`, nunca a Groq directo). En Vite, solo `VITE_*` públicas; jamás un `*_SECRET` en el bundle.
5. **CORS por env** (`FLEET_CORS_ORIGINS`), nunca `*` con credenciales; hoy está clavado a localhost (`main.py:32`, `config.DEV_ORIGINS`) — correcto en same-origin pero frágil ante "arreglarlo a las apuradas".

**Buenas prácticas:** la prueba 12-Factor (¿podrías hacer el repo público ahora sin filtrar nada?); secretos efímeros/rotables sin redeploy; mínimo privilegio; separación dev/prod; scanning automatizado (Gitleaks pre-commit + TruffleHog periódico).

**Malas prácticas a evitar:** creer que git "olvida" al borrar en un commit posterior; claves de larga vida sin rotación; secretos en `VITE_*`; imprimir config completa al arrancar (secretos en logs).

**Herramientas:** `git filter-repo`/BFG, Gitleaks + TruffleHog + GitHub Push Protection, Doppler/Vault/AWS Secrets Manager, `pydantic-settings`.

**Estado actual + GAP:** diseño de secretos sólido (gitignore/dockerignore correctos, montaje runtime limpio), **pero**: PII viva en el historial git; secreto HMAC con autogen silenciosa, sin `0600`, escritura no atómica; credenciales de integración en claro; sin secret-scanning automatizado.

**Criterios de salida:**
- [ ] `roster.csv` purgado del historial; force-push hecho; Dokploy re-clonó limpio.
- [ ] Secreto HMAC desde env/manager, escritura atómica + `0600`, warn al autogenerar.
- [ ] `./secrets` con permisos `600` y dueño no-root; plan de cifrado de credenciales.
- [ ] `pydantic-settings` con fail-fast; cero secretos en `VITE_*` (auditado el `dist/`).
- [ ] Gitleaks en pre-commit + CI; Push Protection activo.

→ **OWASP ASVS V6 (Stored Crypto) + V9 (Communication) Level 2.**

---

## Etapa 7 — OAuth/OIDC y MFA

**Objetivo:** dejar de cargar solo con auth casera; añadir segundo factor para PII/admin. (OWASP A07; MFA Cheat Sheet — "MFA habría frenado el 99.9% de los compromisos".)

**Qué implementar:**
1. **MFA TOTP** (`pyotp`) al menos para `admin` y `safety`/`dispatcher` (roles con `pii.view`): enrolment con QR, secreto cifrado en DB, **códigos de recuperación** de un solo uso hasheados, re-MFA para acciones sensibles.
2. **OAuth2/OIDC** con `Authorization Code + PKCE` (RFC 7636), validar `state` y `nonce`. Si se delega a un IdP, se obtienen MFA/lockout/recuperación "gratis".
3. **Decisión build-vs-buy (ver `DECISIONES.md`):** evaluar delegar auth a Supabase Auth (nativo Postgres + RLS), Clerk (DX React) o Keycloak (on-prem). Para una app ya en producción que apunta a reemplazar a Fullbay, delegar elimina de un saque la superficie de Etapas 2/3/4/7. Si se mantiene casera, este es el techo del esfuerzo propio.
4. **Roadmap passkeys/WebAuthn** (`py_webauthn`) como dirección resistente a phishing. **Evitar SMS** como MFA (SIM-swap; NIST lo marca "restringido").

**Buenas prácticas:** orden WebAuthn > TOTP > SMS; MFA obligatorio para admins; re-MFA para cambio de email/password/billing.

**Malas prácticas a evitar:** OAuth sin PKCE/sin validar `state`/`nonce`; SMS por defecto en app con PII; mantener auth casera creciendo sin expertise dedicada.

**Herramientas:** `pyotp`, Authlib, `py_webauthn`/SimpleWebAuthn, Auth0/Keycloak/Supabase/Clerk.

**Estado actual + GAP:** **No existe** MFA, verificación de email ni OAuth (`auth.py` es roll-your-own completo). Una sola credencial = acceso total a PII de conductores (CDL/licencias/médicos, scope `pii.view`).

**Criterios de salida:**
- [ ] TOTP disponible y **obligatorio** para `admin` (y roles con `pii.view`), con códigos de recuperación.
- [ ] Si hay OAuth/OIDC: `state`+PKCE+`nonce` validados.
- [ ] Decisión build-vs-buy documentada en `DECISIONES.md`.

→ **OWASP ASVS V6 (Authentication) Level 2 (MFA).**

---

## Etapa 8 — Panel admin / CRM de usuarios + suscripciones (plano de control)

**Objetivo:** dar al dueño un panel admin-only para gestionar usuarios, suscripciones y entitlements, sin abrir nuevos agujeros. (OWASP A01; Authorization/Session Cheat Sheets.)

**Qué implementar:**
1. **App/router admin separado** (`/admin` con dependencia de autorización a nivel de router, deny-by-default), idealmente en subdominio con allowlist de IP/VPN. La separación es de **autorización server-side**, no "otra URL = seguro".
2. **RBAC/ABAC** sobre el modelo existente (`permissions.py`); para acciones críticas, capa ABAC (MFA reciente, IP). Considerar OPA/Oso/OpenFGA si las reglas crecen.
3. **Gestión de usuarios + impersonation segura:** suspensión = invalidar sesiones server-side (depende de Etapa 3). Impersonation con permiso+MFA, token marcado `acting_as`+`real_admin_id`, time-boxed, read-only por defecto, banner visible, **audit obligatorio**, nunca impersonar a otro admin.
4. **Suscripciones (Stripe):** webhook con **verificación de firma sobre raw body**, **idempotencia** por `event.id`, responder 200 rápido y procesar async (cola), manejar out-of-order, mapear estado→entitlement (`past_due` ≠ cancelar de inmediato). Entitlements como fuente de verdad ligada a billing, no copia local mutable.
5. **Feature flags / límites por plan** evaluados server-side (`require_entitlement`/`enforce_limit`); el front solo oculta UI.
6. **Audit log append-only** (sin UPDATE/DELETE; hash encadenado SHA-256), registrando toda acción privilegiada (cambios de rol, suspensión, refund, impersonation). Separación de funciones: quien cambia el sistema no puede alterar el log.
7. **GDPR:** export estructurado y borrado (Art. 17) que propaga a sub-procesadores (Stripe/email) y **conserva el audit log** (el derecho de erasure lo excluye).

**Buenas prácticas:** deny-by-default; enforcement en cada request; ownership/tenant por objeto; loguear fallos de control de acceso.

**Malas prácticas a evitar:** autorización en cliente (ocultar botones en React); webhooks sin firma o sobre body parseado; handlers no idempotentes; tratar `past_due` como cancelación; audit logs mutables; borrar audit logs por una petición GDPR.

**Herramientas:** react-admin (doblar checks en backend), Stripe Billing + Customer Portal, Celery/RQ/arq, OPA/Oso/OpenFGA, tabla `audit_log` append-only en Postgres.

**Estado actual + GAP:** existe gestión básica de usuarios (`/api/auth/users`, `routes.py:1164-1208`) protegida por `_require_admin`, pero sin panel CRM, sin suscripciones/Stripe, sin impersonation, sin audit log inmutable, sin flujos GDPR. Es funcionalidad nueva además de hardening.

**Criterios de salida:**
- [ ] Router admin con autorización a nivel de router + (idealmente) IP/VPN allowlist.
- [ ] Impersonation con MFA, time-box, banner y audit; jamás sobre otro admin.
- [ ] Webhooks Stripe con firma+idempotencia+async; entitlements ligados a billing.
- [ ] `audit_log` append-only con hash encadenado para toda acción admin.
- [ ] Export + borrado GDPR funcionando, conservando el audit log.

→ **OWASP ASVS V4 (Access Control) L2 + V7 (Logging) L2.**

---

## Etapa 9 — Observabilidad, CI/CD seguro y operación (Alembic, backups, contenedor no-root)

**Objetivo:** poder ver, recuperar y no romper datos; institucionalizar las lecciones en gates automáticos. (NIST SSDF PW/PS; ASVS V7.)

**Qué implementar:**
1. **Logging estructurado de seguridad** (`structlog`): login/logout/cambios de privilegio/fallos de authZ, con session-id **hasheado** (nunca crudo), sin PII/secretos. `LOG_LEVEL` por env; middleware de método/path/status/latencia; error tracker (Sentry free-tier). Hoy `main.py` no configura logging y los 401/403 no se loguean.
2. **Alembic operativo (CRÍTICO):** hoy el esquema se crea con `create_all` en cada arranque (`db.py`), que **no altera tablas existentes** → cualquier columna nueva se despliega y rompe en runtime en Postgres (autodeploy On Push + base poblada = 500 silencioso). Adoptar `alembic upgrade head` como paso de arranque; `FLEET_SKIP_DB_INIT` ya existe para que Alembic importe metadata. Verificar que `strftime` (SQLite-only) no esté rompiendo `missing_drivers`/`month_summary`/`trends` en Postgres (debe ser `to_char`/rango de fechas).
3. **Backups de DB (CRÍTICO):** no existen (solo el volumen `pgdata`). Cron `pg_dump` a almacenamiento externo + rotación; documentar el restore. Para una app de cumplimiento DOT/DVIR es también retención legal.
4. **Contenedor no-root:** hoy corre como root (sin `USER` en el Dockerfile). Crear usuario `app` y `chown` de `/app`, `/app/secrets`, uploads. Quitar el default `fleet/fleet` de Postgres (`docker-compose.yml`, `${POSTGRES_PASSWORD:?...}` fail-ruidoso).
5. **CI con gates bloqueantes** (GitHub Actions): correr el **mismo `docker build`** (que ejecuta `npm run build`, no solo `tsc --noEmit` — lección v1.28.1) como required check; + Semgrep + Bandit + pip-audit + npm audit + Gitleaks + Trivy. SBOM con Syft. Pin de digests de imágenes base y `==` en requirements.
6. **Healthcheck de readiness** que haga `SELECT 1` (hoy `/api/health` no toca DB → falsos verdes).
7. **n8n (donde aplique):** automatizaciones (onboarding, emails transaccionales, alertas de cumplimiento, sync CRM, reportes) self-hosted en el mismo Dokploy, en red interna; **editor nunca público**, solo `/webhook/*` con rate-limit + HMAC sobre raw body. n8n llama a la **API FastAPI** (service key con scope mínimo), nunca a Postgres directo. Ver `n8n` en `AUDITORIA.md`.

**Buenas prácticas:** shift-left con gates que rompen el build; logs centralizados off-host; relojes sincronizados; restart con alerta (no enmascarar crash-loops).

**Malas prácticas a evitar:** `create_all` automático en Postgres; `restart: unless-stopped` sin alertar; secretos en logs; webhooks n8n sin firma; n8n escribiendo directo a la DB.

**Herramientas:** structlog, Sentry, Alembic, `pg_dump`+cron, GitHub Actions, Semgrep/Bandit/Trivy/Gitleaks, Syft, n8n (queue mode + Redis).

**Estado actual + GAP:** sin observabilidad, sin Alembic operativo, sin backups, contenedor root, default `fleet/fleet` posible, sin CI, healthcheck que no valida DB. Todo documentado como CRÍTICO/ALTO en `AUDITORIA.md`.

**Criterios de salida:**
- [ ] Logging estructurado de eventos de seguridad + error tracker; 401/403 logueados.
- [ ] Alembic corre en arranque; ningún cambio de esquema rompe en Postgres; `strftime` reemplazado.
- [ ] `pg_dump` automático a destino externo con restore probado.
- [ ] Contenedor no-root; Postgres sin default débil.
- [ ] CI rompe el build ante TS error real, vuln crítica o secreto; SBOM publicado.
- [ ] Readiness con `SELECT 1`; n8n (si se usa) con editor privado + webhooks firmados.

→ **NIST SSDF PW/PS + OWASP ASVS V7/V8 Level 2.**

---

## Etapa 10 — Verificación adversarial y madurez sostenida (cierre: app blindada)

**Objetivo:** verificar de extremo a extremo que los controles funcionan y mantener el nivel en el tiempo. (OWASP ASVS L2 verificado; NIST SSDF RV; SAMM continuo.)

**Qué implementar:**
1. **DAST sobre staging** (OWASP ZAP en CI), **Schemathesis** contra el OpenAPI, pruebas WSTG, tests automatizados de IDOR/cross-tenant/BOLA por tenant.
2. **Pentest externo periódico** + programa de divulgación de vulnerabilidades (SSDF RV), con SLA de remediación.
3. **WAF en el borde** (Cloudflare) + rate-limiting global de API; bot management/Turnstile.
4. **Gobierno continuo:** reevaluación SAMM, elementos selectos de **ASVS L3** en módulos de alto valor (PII, billing, audit), formación recurrente. Camino a SOC 2 cuando el negocio lo requiera.

**Buenas prácticas:** ASVS como criterio de aceptación por feature (no checklist post-hoc); cada historia que toca auth/datos cita su requisito ASVS.

**Malas prácticas a evitar:** "SOC 2 el día 1" del MVP (sobre-ingeniería) y su opuesto, ignorar seguridad hasta el incidente.

**Herramientas:** OWASP ZAP, Schemathesis, WSTG/ASVS checklist, Cloudflare WAF, OWASP SAMM Toolbox.

**Estado actual + GAP:** sin verificación adversarial ni pentest; sin WAF. Es la etapa de cierre tras completar 1-9.

**Criterios de salida:**
- [ ] ZAP + Schemathesis en CI; tests de IDOR/cross-tenant verdes.
- [ ] Pentest sin hallazgos críticos/altos abiertos; SLA de remediación definido.
- [ ] **ASVS L2 verificado de extremo a extremo** (objetivo de "app blindada").
- [ ] Ciclo de mejora continua (SAMM) establecido.

→ **OWASP ASVS Level 2 verificado + SAMM/SSDF continuo.**

---

## Tabla resumen de las etapas

| # | Etapa | Riesgo OWASP | ASVS objetivo | Prioridad | Estado hoy en Fleet Tracker | Evidencia clave |
|---|-------|--------------|---------------|-----------|------------------------------|------------------|
| 1 | Autorización default-deny + bootstrap seguro | A01 Broken Access Control | V4 L2 | **CRÍTICA** | Default-allow + admin sintético + IDOR write | `main.py:92,106-118`; `routes.py:1121-1122`; `alerts.py` |
| 2 | Rate limiting / lockout / IP ban | A07 · API4 | V6 L2 | **CRÍTICA** | No existe throttling | `auth.py:159-173` |
| 3 | Sesiones endurecidas (cookie HttpOnly, revocación) | A02 · Session Mgmt | V3 L2 | **ALTA** | Token 30d en localStorage, sin revocación | `api.ts:13-16`; `auth.py:33,75-107` |
| 4 | Política de password + breach-check + email | A07 | V6 L1→L2 | **ALTA** | Solo `len≥8`, duplicado x3 | `auth.py:130,200` |
| 5 | Validación de input / inyección / uploads / CSP | A03 · API3 · A01 | V5 L2 | **ALTA** | `body:dict` sin schema, sin CSP/HSTS | `routes.py:725,758,524,543`; `main.py` |
| 6 | Secretos, cripto en reposo, 12-Factor | A02 · Secrets Mgmt | V6+V9 L2 | **ALTA** | PII en historial git; secreto sin 0600/atómico | `secretstore.py:70-71`; `auth.py:37-50`; commits `97977bf`/`ca2627d` |
| 7 | OAuth/OIDC + MFA | A07 · MFA | V6 L2 | **MEDIA** | No existe MFA/OAuth | `auth.py` (roll-your-own) |
| 8 | Panel admin / CRM usuarios + suscripciones | A01 · AuthZ/Session | V4+V7 L2 | **MEDIA** | Gestión básica de users; sin CRM/Stripe/audit | `routes.py:1164-1208` |
| 9 | Observabilidad, CI/CD, Alembic, backups, no-root | SSDF PW/PS | V7/V8 L2 | **ALTA (ops)** | Sin logging/Alembic/backups; root; sin CI | `db.py`; `Dockerfile`; `docker-compose.yml` |
| 10 | Verificación adversarial + madurez | SSDF RV · SAMM | **L2 verificado** | **MEDIA** | Sin DAST/pentest/WAF | — |

**Orden de fix por riesgo si se mantiene auth casera:** Etapa 1 → 2 → 3 → 4 → 5/6 → 7 → 9 (ops crítico en paralelo: Alembic + backups + purga de PII pueden adelantarse) → 8 → 10. Si se decide **delegar auth a un IdP** (Etapa 7, build-vs-buy en `DECISIONES.md`), se reduce drásticamente la superficie de las Etapas 2/3/4/7.

Documentos hermanos: `AUDITORIA.md` (hallazgos crudos por dominio y fuentes OWASP/NIST), `ARQUITECTURA.md`, `CONVENCIONES.md`, `DECISIONES.md`, `GLOSARIO.md`, `FLUJO-DE-TRABAJO.md`, `ERRORES-CONOCIDOS.md`.
