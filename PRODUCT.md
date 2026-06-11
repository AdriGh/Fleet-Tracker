# Product

## Register

product

## Users

Operadores de flotas de trucking en EE.UU. (5–200 camiones): dueños-operadores de la operación, dispatchers, gerentes de Safety/Maintenance y mecánicos de taller propio. Muchos son bilingües (inglés/español); el español nativo es un diferenciador buscado. Contexto de uso: oficina de dispatch con varios monitores, jornadas largas, datos en vivo (GPS, HoS, reefer) y decisiones operativas urgentes ("¿dónde está el truck?", "¿quién no hizo el DVIR?", "¿a cuánto está el reefer?").

## Product Purpose

Fleet Tracker es el cockpit unificado de operaciones de flota: cumplimiento (DVIR, defectos, avisos a conductores), mantenimiento (PM, work orders), tracking en vivo (mapa, alertas, cold chain) y despacho (drivers, loads) en una sola app que corre sobre el ELD que la flota ya paga (Samsara hoy; Motive/Geotab vía adapters). Nació como herramienta interna de Chaser/MCCI y se está productizando white-label. Éxito = reemplazar Fullbay y los portales GPS legacy (TrackFleet) con algo más barato, más bonito y sin contratos de 3 años.

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
