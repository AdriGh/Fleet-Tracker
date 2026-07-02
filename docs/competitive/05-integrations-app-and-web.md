# 05 — Integraciones presentadas (app + web)

> Cómo se muestra Connectivity/Integrations en **dos** lugares: el **hub dentro de la app**
> (donde el cliente conecta sus cosas) y el **marketplace en el sitio de marketing** (donde
> el prospecto ve el ecosistema). El usuario pidió profundizar ambos. Los dos comparten la
> misma taxonomía del cap 04.

## 5.1 En la APP — el hub de Connectivity
**Estado actual (buena base):** `Settings → Connectivity` ya muestra "Data Sources"
(Google Sheets, Fullbay CSV, Google Places, AI document scan, Parts marketplace) con
estado + **Test** + **Configure**. La config de los ELD se auto-genera desde
`config_fields()` del adapter — ese patrón es el correcto.

**A dónde va (con el adapter framework multi-categoría del cap 04):** el hub se reorganiza
**por categoría**:
`Telematics/ELD · Accounting · Parts · Fuel · TMS · Comms`. Cada integración:
- **Card**: logo/nombre, **estado** (connected · live · not-configured · error), **última
  sync**, botones **Test** + **Configure**.
- **Config auto-generada** desde `config_fields()` del adapter (ya lo hacés para ELD →
  generalizarlo a todas las categorías).
- **OAuth (QuickBooks):** en vez de pegar una API key, un botón **"Connect with QuickBooks"**
  que abre el flujo OAuth (habilitador A del cap 04). Nunca se muestra el token.
- **Health por-integración:** last-sync, errores recientes, un botón **Reconnect**.
- **Tab "Automations":** crear reglas **trigger → condición → acción** (cap 04) sobre las
  integraciones conectadas. Ej: "cuando entre un fault-code de severidad alta → creá una WO".

## 5.2 En el SITIO — el marketplace de 2 capas
Patrón robado de **Samsara / Motive / Fleetio** (los 3 lo hacen igual, y es muy superior a
un muro de logos plano). Ver los screenshots `samsara-home.png` / `motive-home.png` /
`fleetio-home.png`.

### Capa 1 — Landing aspiracional (`/integrations`)
Vende el ecosistema **antes** de mostrarlo:
- **Número grande:** *"Conectá tu stack. X+ integraciones, ecosistema abierto."*
- **~5 categorías marketineras** con icono: Telematics/ELD · Accounting · Parts · Fuel · TMS.
- **3-4 value props:** "Connect everything" · "Automatizá el trabajo manual" · "API abierta" ·
  "Become a partner".
- **CTA "Become a partner"** + link a la API / developer docs (habilitador B del cap 04).

### Capa 2 — Directorio funcional (`/integrations/directory`)
La experiencia navegable:
- **~15-20 chips de categoría** (filtro horizontal, no sidebar).
- **Grid de cards:** `logo + nombre + tag de categoría + una línea`.
- Badges **"Newly Added"** (señal de momentum).
- **Search + sort** (Featured / A-Z / Newest).
- **Una página SEO por partner** (`/integrations/samsara`, `/integrations/quickbooks`…) —
  cada una capta búsquedas del tipo *"Fleet Tracker + Samsara integration"*. Esto es lo que
  hace Fleetio y es puro lead-gen.

### Nota de honestidad (importante)
Marketing dice "ecosistema abierto, 15+"; el directorio muestra los **reales** + "por venir".
**No inventar logos de partners.** Mostrar los que SÍ integrás (Samsara, Motive, y QuickBooks
cuando esté) + un **"Request an integration"** para capturar demanda de la cola larga.

## 5.3 El puente app ↔ web
La **misma taxonomía de categorías** (cap 04) sirve para los dos lados: el hub de la app y el
marketplace del sitio comparten el modelo canónico de "integración". Una integración nueva =
**un adapter (backend)** + **una card en el hub** + **una página en el directorio**. Un solo
registro de metadata (nombre, categoría, logo, capabilities, estado) alimenta ambas UIs.

> Esto refuerza el moat del cap 04: cuantas más categorías/adapters, más rico se ve el
> marketplace del sitio (venta) y más "self-driving" la app (retención). El framework paga
> dos veces.
