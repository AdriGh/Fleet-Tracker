# 08 — Roadmap & secuenciación

> El orden de ejecución. Principio rector: **infra primero, features en olas.** Cada feature
> es aditiva → shippeá por incremento (tu workflow de `merge --no-ff` + CHANGELOG + tag).

## 8.1 Principio
No se pueden construir las features del cap 03 "de verdad" (con automatizaciones + QuickBooks
+ write-back) sin la **infra habilitante** del cap 06. Por eso hay una **Fase 0** de infra
antes de las olas de features.

## Fase 0 — Infra habilitante (cap 06) · **prerequisito**
1. **Redis + task queue** (Arq/RQ) → desbloquea sync, automatizaciones, estado compartido.
2. **Vault de credenciales por-org + OAuth** → desbloquea QuickBooks.
3. **Sentry + logging estructurado + health por-integración.**
4. **CI (GitHub Actions) + primeros contract tests** → gate antes de multiplicar módulos.
5. **Modelo canónico + generalizar el adapter framework** (cap 04, capas 1-2).

## Fase 1 — Ola "money loop + kill-shots" (🔴)
- **Warranty & core recovery** — el argumento de venta #1 ("eso solo pagó el software").
- **QuickBooks adapter** — el kill-shot vs Fullbay (requiere vault+OAuth de Fase 0).
- **Purchase Orders** (reusa el scaffold) **+ profundidad de partes** → juntos habilitan el
  módulo **Parts & Vendors** (donde entra FindItParts/PartsTech, cap 04).

## Fase 2 — Ola "cerrar DVIR + operación" (🔴/🟠)
- **DVIR form-builder + app nativa del conductor** — cerrar el gap donde Whip Around nos gana
  (es esfuerzo L por la app móvil PWA offline).
- **Fuel management + fuel-cards** (con el motor de las 6 excepciones).
- **Motor de automatizaciones** (cap 04, capa 4) — requiere el queue de Fase 0. Acá arranca el
  "mantenimiento que se maneja solo": fault-code→WO, stock-bajo→PO, factura→QuickBooks.

## Fase 3 — Ola "profundidad + credibilidad" (🟠)
- **Technician time (ShopWatch)** · **Tire management** · **VMRS coding** · **Asistente AI + NL
  analytics** (reusa Groq).

## Fase 4 — Ola "insight + plataforma" (🟡)
- **Lifecycle / TCO + recomendación de reemplazo.**
- **API pública + webhooks + marketplace** (cap 04 hab. B + cap 05).
- Secundarios por demanda: OOS workflow, breakdown mgmt, outside-work, multi-shop, motor pool,
  campaign/recall, Wallet de compliance, customer portal.

## En paralelo — el sitio de marketing (cap 07)
Se construye en paralelo al producto (equipo/tiempo distinto). Prioridad:
1. Home cinemático (F6, con el playbook del cap 07.4).
2. Pricing público + self-signup abierto (el CTA "Start free" lo necesita).
3. Integrations marketplace (cap 05, se llena a medida que se agregan adapters).
4. Features / Industries / Resources.

## Regla de oro (sin endulzar)
- **No metas automatizaciones ni QuickBooks antes de la Fase 0** (queue + vault). Así se hace
  spaghetti / deuda.
- **No multipliques módulos sin CI** — la superficie de bug crece con cada uno.
- **Defendé y publicitá lo que ya ganás** (cold-chain, loop de taller nativo, live map,
  telematics-agnóstico) mientras construís lo que falta.
- **Tabla-stakes ≠ diferenciador:** el AI invoice scan es table-stakes (Samsara/Fleetio/RTA lo
  tienen) — liderá en UX/velocidad, no en "únicos".

## Resumen en una línea
**Fase 0 (infra) → Warranty + QuickBooks + POs/Parts → cerrar DVIR + Fuel + Automatizaciones →
profundidad (tech-time/tire/VMRS/AI) → plataforma (TCO/API/marketplace).** El sitio, en
paralelo, arrancando por el Home cinemático.
