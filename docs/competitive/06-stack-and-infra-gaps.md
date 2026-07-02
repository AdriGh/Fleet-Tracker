# 06 — Gaps de stack e infra

> Qué le falta a tu stack para soportar la plataforma de integración (cap 04) + la
> profundidad de módulos (cap 03) + multi-tenant real. Ordenado por cuánto muerde. Nada
> de esto es opcional para *"plataforma"*; sí lo era para *"app que funciona"*.

## 6.1 Veredicto (sin endulzar)
Tu **código** es bueno y lo endureciste a producción real (cookie auth, RBAC, rate-limit,
CSP, Alembic, backups). Tu **arquitectura** está en "monolito sólido en una caja". El salto
a la plataforma del cap 04 tiene **6 huecos de infra** que no son opcionales.

## 6.2 Los gaps, ranked

### 1. Falta task queue / worker ← EL bloqueador de la visión de integración
Todo lo del cap 04 (sync, webhooks, automatizaciones, write-back a QuickBooks, auto-PO) es
**trabajo en segundo plano**. Hoy: asyncio loop (`alerts.run_loop`) + poll + `_jobs` en
memoria → no sobrevive un restart, no reintenta, no escala más de un proceso, sin
scheduling/fan-out confiable.
→ **Fix:** cola + broker (**Redis + Arq/RQ/Celery**). Desbloquea sync engine + automation
engine + webhooks. **Innegociable.**

### 2. Estado en memoria + single-replica → no escala horizontal
Rate-limit, caches y jobs viven en el proceso. Con 2 réplicas (que vas a necesitar: uptime +
carga) divergen.
→ **Fix:** **Redis** para estado compartido (mismo Redis que #1). Es tu ARCH-1; la visión de
integración lo adelanta.

### 3. Credenciales en archivos → no sirven multi-tenant + OAuth
`*.local.json` es de una sola caja. QuickBooks (cap 04) exige **OAuth2 + refresh por org**.
→ **Fix:** **vault cifrado por-org en Postgres** + flujo OAuth callback/refresh (habilitador A
del cap 04).

### 4. Sin modelo de dominio canónico
(Detallado en cap 04, capa 2.) Los adapters devuelven forma-de-proveedor.
→ **Fix:** esquemas canónicos + mappers por adapter. Barato, es diseño.

### 5. Sin observabilidad → estás ciego ante fallas
Una plataforma que hace miles de llamadas a APIs externas **va a** tener fallas parciales
(rate limits, tokens vencidos, caídas del proveedor). Hoy: logs tipo `print`, cero tracking.
→ **Fix:** **Sentry** (errores) + logging estructurado + **health por-integración** (cap 04).
Sin esto debuggeás fallas de prod a las adivinanzas.

### 6. Un solo test + cero CI
`test_ratelimit.py` es todo, y **autodeployás on-push sin gate**. Peligroso para una
plataforma donde un mapeo de adapter mal hecho **corrompe la data de un cliente**.
→ **Fix:** **contract tests por adapter** (con fixtures de API mockeadas) + **GitHub Actions**
que corra tests + build ANTES de deployar (tu OPS-5).

*(Secundarios reales: falta el framework de API pública/webhooks [cap 04, hab. B]; el
aislamiento multi-tenant necesita un pase de auditoría; el SPA necesita disciplina de
design-system a medida que se multiplican los módulos del cap 03.)*

## 6.3 Qué NO hacer
- No construyas hardware/telematics. Consumilo (cap 04).
- No pongas automatizaciones antes del modelo canónico + el queue. Así se hace spaghetti.
- No sigas sumando módulos (cap 03) sin tests/CI: la superficie de bug crece con cada uno.

## 6.4 La brecha de madurez (en limpio)
Venís operando como un **builder solo, muy productivo**. Para nivel Fleetio el salto es de
*"app que funciona"* a *"plataforma que sobrevive a que otros dependan de ella"*. Cuatro
disciplinas que faltan: (1) **infra async/cola**, (2) **testing + gate de CI**, (3)
**observabilidad**, (4) **rigor de aislamiento multi-tenant**. Ninguna es glamorosa; todas
son la diferencia entre un demo y una empresa. La buena: **tu calidad de código y tu instinto
de producto ya están** — falta madurez **operacional**, no skill de ingeniería.

## 6.5 Secuencia de infra (habilita los cap 03 y 04)
1. **Redis + task queue** (Arq/RQ) → desbloquea sync, automatizaciones y estado compartido (gaps 1+2).
2. **Vault de credenciales + OAuth** (gap 3) → desbloquea QuickBooks.
3. **Sentry + logging estructurado + health por-integración** (gap 5).
4. **CI (GitHub Actions) + contract tests por adapter** (gap 6) — ANTES de multiplicar módulos.
5. **Modelo canónico** (gap 4) va con el cap 04, capa 2.

### Tooling MCP / Claude a adoptar (del F4)
Browser MCP (**✅ ya instalado — Playwright**) · Postgres MCP (query prod seguro) · Sentry MCP ·
docs MCP (Context7, specs API actuales) · **`/code-review` antes de mergear** (hoy cero gate) ·
workflows multi-agente (como esta tanda del cap 03) · Stripe MCP para billing/suscripciones.
