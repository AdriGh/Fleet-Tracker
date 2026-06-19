# Design System — Fleet Tracker

Sistema de diseño formal de Fleet Tracker. Hermano de `PRODUCT.md`: PRODUCT define **qué** construimos (Taller × Cold Chain), esto define **cómo se ve y se siente**. Fuente de verdad de tokens vive en `frontend/src/index.css` (`:root` + `[data-theme='dark']`); este doc explica el porqué, las reglas de uso y los patrones de componente.

> Norte: una herramienta seria de operaciones que se siente **cara**. Densidad de cockpit donde manda el dato, aire generoso donde se decide. Familiaridad ganada (Linear/Samsara-grade), nunca plantillada.

---

## 1. Principios (de PRODUCT.md, operacionalizados)

1. **El dato vivo manda** — cada pantalla lidera con el estado real (posiciones, temperaturas, vencimientos, WOs abiertas), nunca con decoración. Sin hero-metrics inventadas.
2. **Familiaridad ganada** — patrones que un dispatcher de Samsara/Fullbay reconoce al instante, ejecutados con más oficio.
3. **Rojo con propósito** — `--accent` marca acción primaria, selección y peligro real (LIVE, overdue, alarma). Jamás relleno decorativo.
4. **Denso pero respirable** — densidad de cockpit en tablas/mapas (§5), aire en flujos de decisión (envíos, onboarding, settings).
5. **Seguro por defecto** — lo que envía de verdad o destruye se etiqueta en rojo y nace apagado; simular es el default.

---

## 2. Color

### Marca
| Token | Claro | Oscuro | Uso |
|---|---|---|---|
| `--accent` / `--brand` | `#e11900` | `#ff4438` | acción primaria, selección, LIVE/peligro |
| `--accent-2` | `#ff4d3d` | `#ff6a52` | hover/realce del acento |
| `--accent-strong` | `#b71400` | `#ff5a4a` | presionado, énfasis |
| `--accent-soft` | `rgba(225,25,0,.09)` | `rgba(255,68,56,.15)` | tinte de fondo de selección/foco |

Regla: el rojo es un recurso **escaso**. Si una pantalla tiene más de ~3 zonas rojas a la vez, algo se está usando como relleno.

### Superficies (escalonadas, neutro zinc)
Claro: `--bg #f5f5f6` → `--surface #fff` → `--surface-2 #f1f1f3` → `--surface-3 #e8e8eb`.
Oscuro (tema héroe del cockpit): `--bg #0a0a0b` → `--surface #161618` → `--surface-2 #100f11` → `--surface-3 #1e1e21`.
Texto: `--text` / `--text-muted`. Bordes: `--border` / `--border-strong`. El grano (`--grain`) solo en oscuro (0.04) para romper la planura del negro.

### Semánticos de UI (KPIs, píldoras, donut)
`--ui-danger` · `--ui-success` · `--ui-warn` · `--ui-info` (+ `-bg`). **Desacoplados** de los colores Excel del DVIR a propósito — no mezclar.

### Status de mantenimiento (PM/DOT) — un color = un status en TODA la pantalla
`--st-overdue` (rojo) · `--st-upcoming` (ámbar pato) · `--st-on-track` (verde) · `--st-never` (celeste). El mismo token pinta donut, tarjeta, riel de fila y píldora; el fondo tintado se calcula con `color-mix` sobre `--surface` para adaptarse al tema. `-ink` = color de texto legible sobre el tinte.

### NO TOCAR — colores del Excel (`--safe/unsafe/nodvir-*`)
Reservados para la vista previa del DVIR que **calca** el reporte. No usarlos en UI nueva; para estados de UI usar `--ui-*` o `--st-*`.

---

## 3. Tipografía

- **Display** — `--font-display` Space Grotesk Variable. Títulos, KPIs, números grandes. Carácter sin ser de juguete.
- **Cuerpo** — `--font` Geist Variable. Texto, tablas, formularios.
- **Mono** — `--font-mono` Geist Mono. VINs, odómetros, IDs, códigos de falla.

Escala (cockpit-denso → display): `--fs-micro 10` · `--fs-tiny 11.5` · `--fs-small 13` · `--fs-body 15` · `--fs-h3 15.5` · `--fs-h2 18` · `--fs-stat 1.7rem` · `--fs-h1 1.9rem` · `--fs-display 3.1rem`. Base 15px / line 1.5.
Pesos: 400/500/600/700/800. Tracking: display `-0.02em`, tight `-0.03em`, label `0.12em`, eyebrow `0.16em` (mayúsculas de etiqueta).

Regla: números operativos (millas, temperaturas, totales, $) en `--font-mono` o con `font-variant-numeric: tabular-nums` para que columnas y contadores no "bailen".

---

## 4. Layout · radios · elevación · motion

- **Radios**: `--radius 16` (tarjetas) · `--radius-lg 22` · `--radius-sm 10` · `--radius-xs 7` · `--radius-btn 11` · `--radius-pill 999`.
- **Shell**: `--sidebar-w 250` / `--sidebar-w-collapsed 80`; `--container-pad 32`.
- **Espaciado**: `--space-1..7` = 4/8/12/16/22/32/48.
- **Elevación**: `--shadow-sm` / `--shadow-md`; glows del acento solo para CTA primario. Nada de sombras decorativas por todos lados.
- **Motion**: `--dur-fast .15` / `--dur-mid .22` / `--dur-slow .34`. Todo respeta `prefers-reduced-motion` (ya global). Animar para informar (entrada de fila, pulso LIVE), no para adornar.
- **z-index**: escala con nombre (`--z-sticky 50` → `--z-grain 500`). Sin números mágicos.

---

## 5. Modelo de densidad (AFILADO para taller — clave del rework)

Dos densidades, una sola app:

**Cockpit (tablas, listas, mapa, dashboards):** máxima información legible. Guía data-dense aplicada al sistema. Tokens PROPUESTOS a añadir a `index.css` (hoy faltan los de tabla):
```
--row-h: 36px;          /* alto de fila de tabla densa */
--cell-pad-y: 8px;      /* padding vertical de celda */
--cell-pad-x: 12px;     /* padding horizontal de celda */
--grid-gap: 12px;       /* gap de grids de dashboard */
--kpi-pad: 14px;        /* padding de KPI card compacta */
```
Reglas cockpit: headers **sticky**; fila resalta en hover (`--accent-soft`); ordenable; números `tabular-nums`; sin envolver cada fila en su propia tarjeta (es ruido); export CSV siempre disponible.

**Decisión (envío de avisos, onboarding, settings, perfil de unidad):** aire generoso, `--space-5/6`, un foco por vista, validación inline. Aquí SÍ respiran las tarjetas.

Heurística: si el usuario *escanea* → cockpit; si el usuario *decide/edita* → decisión.

---

## 6. Componentes (patrones para ganarle a Fullbay/SquareRigger en claridad)

- **KPI card** — etiqueta `--fs-tiny` muted arriba, número `--fs-stat` display abajo, delta opcional con `--st-*`/`--ui-*`. Fondo `--surface`, `--kpi-pad`. En grid `repeat(auto-fit, minmax(180px,1fr))`, gap `--grid-gap`.
- **Status pill** — `--radius-pill`, fondo = tinte `color-mix(status, --surface)`, texto = `-ink`. Un status = un color en toda la pantalla (§2).
- **Data table** — header sticky, filas `--row-h`, hover `--accent-soft`, primera columna = identidad de unidad (código + VIN/placa de subtítulo en `--fs-tiny` mono), columnas numéricas alineadas a la derecha en mono.
- **Work Order card** — unidad + estado en pipeline (open→in_progress→waiting_parts→completed), líneas de parte/labor con totales, **badge "from reefer fault"** (`source='reefer'`, acento) cuando viene del puente reefer→WO. Este patrón es el **moat visible**: muéstralo con orgullo.
- **Unit profile** (estilo Fullbay, ejecutado mejor) — ficha + tabs (Defects/PM/DVIR/WOs/Specs); diagrama de unidad SVG kind-aware reutilizando el de `TruckDiagram.tsx`.
- **PM urgency row** — riel izquierdo del color `--st-*`, barra de progreso a next-due, estado (Overdue/Upcoming/On Track/Never Performed).
- **Reefer strip** — chart de temperatura 24h, setpoint vs return/supply, alarma en `--ui-danger`; el diferencial Cold Chain debe estar a un vistazo.
- **Botón destructivo / envío real** — nace apagado, etiqueta roja, confirma antes de ejecutar (principio 5).

---

## 7. Accesibilidad

WCAG AA: contraste ≥4.5:1 cuerpo, ≥3:1 texto grande; `focus-visible` en acento en toda superficie interactiva; `prefers-reduced-motion` desactiva todas las animaciones; labels sobre input + errores inline. Test mental: si el fondo fuera casi negro, ¿se lee todo? (el tema oscuro es el héroe).

---

## 8. Anti-referencias (lo que NO somos)

- **TrackFleet / portales telemáticos legacy** — tablas grises PHP, iconos de 2008, jerga a medio traducir.
- **GPS/ELD genéricos post-mandato** — portales delgados, UI de plantilla.
- **SaaS-cream genérico** — beige, tarjetas idénticas icono+título+texto, gradientes IA violetas, hero-metrics decorativas.

---

## 9. Diferenciadores de UX (la ventaja a defender)

UX moderna · velocidad · DVIR-ELD nativo · bilingüe EN/ES de **piso de taller** · el puente **reefer→work order** que nadie más tiene. El diseño debe hacer que estas ventajas se **vean** en el primer vistazo, no que haya que explicarlas.
