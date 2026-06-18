# Product

## Register

product

## Users

Operadores de flotas de trucking en EE.UU. (5–200 camiones): dueños-operadores de la operación, dispatchers, gerentes de Safety/Maintenance y mecánicos de taller propio. Muchos son bilingües (inglés/español); el español nativo es un diferenciador buscado. Contexto de uso: oficina de dispatch con varios monitores, jornadas largas, datos en vivo (GPS, HoS, reefer) y decisiones operativas urgentes ("¿dónde está el truck?", "¿quién no hizo el DVIR?", "¿a cuánto está el reefer?").

## Product Purpose

Fleet Tracker se especializa en el stack **Taller + Cold Chain** para carriers: el taller completo (work orders, parts/PO, escáner AI de invoices, PM/DOT, perfil de unidad estilo Fullbay) integrado con el monitoreo y el **control OEM de reefers** (Carrier Lynx / Thermo King, directo y two-way; aftermarket vía Traccar). El diferencial que nadie más ocupa: **el único software de taller que le habla a tus reefers**. Corre sobre el ELD que la flota ya paga (Samsara hoy; Motive/Geotab vía adapters). Alrededor de ese núcleo mantiene, como soporte (no como protagonista), el cumplimiento (DVIR, defectos, avisos a conductores) y el tracking en vivo (mapa, alertas). Nació como herramienta interna de Chaser/MCCI y se está productizando white-label. Éxito = reemplazar Fullbay (taller) y TrackFleet (reefer) con algo más barato, más bonito, bilingüe de verdad y sin contratos de 3 años.

## Product Focus (decidido jun-2026)

Profundidad, no amplitud. El moat es la **intersección Taller × Cold Chain**: Fullbay es profundo en taller pero no toca telemática de reefers; Samsara/TrackFleet monitorean reefers pero no tienen workflow de taller. Fleet Tracker tiene las dos mitades y conectadas.

- **Núcleo (se lidera y profundiza):** Work Orders + Parts/PO + escáner AI de invoices + perfil de unidad + PM/DOT + **Cold Chain con control OEM (Lynx/TK)** + el puente **reefer → work order** + bilingüe de **piso de taller** (work orders, notas de técnico e invoices nativos en español — el shop floor en US es mayoritariamente hispanohablante; cuña más afilada que el "soporte en español" genérico).
- **Soporte (se mantiene, no protagoniza):** DVIR, Live Map, notices. Sirven al cockpit; no se gasta energía compitiéndole a Samsara en mapas/telemática genérica.
- **Removido (jun-14):** Loads / dispatch / payout — es otro producto y otro mercado. Se borró del producto (UI + rutas + modelos). El **roster de conductores se conserva como "Driver Compliance"** dentro de Maintenance & Compliance (CDL/med cert/MVR/clearinghouse + asignación truck→conductor que el tablero de mantenimiento usa): eso es compliance, no dispatch.

**Workflow asesino (CONSTRUIDO jun-14):** un reefer tira un fault code (vía Lynx/TK/Traccar) → se crea solo un work order con unidad + código + contexto → se agenda y cierra como cualquier WO. Ni Fullbay ni Samsara pueden hacerlo: cada uno tiene solo la mitad. Implementación: regla `reefer_fault_wo` en Settings → Fleet alerts (severidad mínima configurable) → `core/reefer_wo.py` (idempotente: no duplica mientras haya una WO viva para el mismo unit+code) disparada por el loop de `alerts.py`; la WO sale con `source='reefer'` (badge "from reefer fault") y cada una genera un evento en el feed.

> Validación pendiente (no es código): mostrar el demo a 2-3 dueños de flotas de reefer y ver si ese workflow les ilumina la cara. La tesis se confirma con clientes design-partner, no con más features.

## Brand Personality

Confiable · Potente · Premium. Una herramienta seria de operaciones que se siente cara: alto contraste, datos en vivo al frente, tipografía con carácter (Space Grotesk display + Geist), cero estética de juguete. La voz es directa y operativa — números reales, estados claros, sin adornos verbales.

## Anti-references

- **TrackFleet y los portales telemáticos legacy**: tablas grises PHP, iconos de 2008, cero export, jerga traducida a medias. Lo que esta app existe para matar.
- **GPS/ELD genéricos post-mandato**: portales delgados, soporte inexistente, UI de plantilla.
- **SaaS-cream genérico**: fondos beige, tarjetas idénticas con icono+título+texto, gradientes IA violetas, hero-metrics. La familiaridad debe ser ganada (Linear/Samsara-grade), no plantillada.

## Design Principles

1. **El dato vivo manda**: cada pantalla lidera con el estado real de la flota (posiciones, temperaturas, vencimientos), nunca con decoración.
2. **Familiaridad ganada**: patrones que un dispatcher que usa Samsara/QuickManage reconoce al instante, ejecutados con más oficio que el original.
3. **Rojo con propósito**: el acento (#e11900/#ff4438) marca acción primaria, selección y peligro real (LIVE, overdue, alarmas) — jamás relleno.
4. **Denso pero respirable**: densidad de cockpit en tablas y mapas, aire generoso en flujos de decisión (envíos, onboarding, configuración).
5. **Seguro por defecto**: lo que envía de verdad (email LIVE) o destruye se etiqueta en rojo y nace apagado; simular es el default.

## Accessibility & Inclusion

WCAG AA: contraste ≥4.5:1 en texto de cuerpo, ≥3:1 en texto grande; focus-visible en acento en toda superficie interactiva; `prefers-reduced-motion` desactiva todas las animaciones (ya implementado globalmente); formularios con label sobre input y errores inline. Futuro G7.2: i18n EN/ES end-to-end.
