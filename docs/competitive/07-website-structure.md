# 07 — Estructura del sitio de marketing + referencia visual

> Cómo estructurar el sitio público de Fleet Tracker, informado por la competencia, y con
> los **screenshots reales** (`screenshots/*.png`) como referencia visual. Lleva el sitio
> de la v0.1 que ya construimos (`website/`) a la estructura completa.

## 7.1 Estado actual (nuestro sitio)
Ya existe `website/` (Vite + React + Router + Tailwind v4, dark-locked, rojo de marca, logo
reusado): **Home completa** (hero split, stats, bento de features, how-it-works, vs-Fullbay,
CTA) + stubs de Features/Pricing/About. Este capítulo define a dónde va.

## 7.2 IA del sitio — la taxonomía de 3 ejes
De SquareRigger/Fleetio/Samsara/RTA (todos la usan): navegación por **Solución / Industria /
Rol**, más Pricing e Integraciones. Páginas:
- **Home**
- **Features** (hub + una página por área: DVIR, Work Orders, PM, Warranty, Fuel, Parts…)
- **Industries** (verticales — priorizá **Food & Beverage / Cold-chain** por tu wedge de reefer,
  + Construction, Waste, etc.)
- **Roles** (Fleet Manager / Shop Manager / Technician — fase 2, patrón SquareRigger)
- **Pricing** (público, por-activo — te alinea con los modernos; ver cap 01)
- **Integrations** (marketplace de 2 capas — cap 05)
- **Resources** (blog + herramientas imán: ROI calculator, VIN decoder — patrón Fullbay/Fleetio)
- **About / Contact**

## 7.3 Estructura de la Home (sección por sección)
El orden que casi todos repiten (cap 02). Lo que ya tenés está marcado:
1. **Hero** — asymmetric split. ✅ (ya lo tenés)
2. **Prueba social ANTES del producto** — logos de clientes / reviews / stats. *(Samsara y
   Fleetio ponen esto arriba de todo — súbelo.)*
3. **Pilares de valor** — 3-4 outcomes con icono.
4. **Features** — bento ✅, o el flujo **connect-the-dots** de Fleetio (Inspección → Issue →
   WO → Report) que es su gran diferenciador narrativo.
5. **Cómo funciona** — 3 pasos. ✅
6. **Integraciones** — teaser → link al marketplace (cap 05).
7. **vs Fullbay** — comparación honesta. ✅
8. **Métricas / testimonios** — un logo + un número por card (patrón universal).
9. **CTA final + footer**. ✅

## 7.4 El playbook del WOW (para el F6 cinemático)
De **Samsara/Motive** (los únicos cinemáticos del set — ver `samsara-home.png`,
`motive-home.png`). **El wow NO son objetos 3D decorativos:**
1. **UI real con datos realistas** (montos en $, marcas reales, foto del defecto) **compuesta
   sobre foto de flota**.
2. **Mismo flujo en frame de teléfono + tablet + desktop.**
3. **Switcher de producto por tabs** (un componente muestra N features con screenshots reales).
4. **Hero = diagrama de arquitectura** ("una plataforma integrada" — patrón Motive).
5. **UN** video embebido + **reveal-on-scroll** con buen timing.

**Recomendación para el F6 (sin endulzar):** combiná los **3D analíticos** que pediste (gráficos/
objetos de datos en scroll) **SOBRE** esta base de "mostrar la app real". Solo-3D decorativo se
ve impresionante pero vacío; 3D + app real = impactante **y** creíble. Como todavía no hay
screenshots de UI real pulida para componer, la primera versión usa **mockups de la app**
(generados o capturas reales de nuestra propia app) dentro de frames de dispositivo.

## 7.5 Referencia visual — qué robar de cada screenshot
| Screenshot | Qué mirar |
|---|---|
| `samsara-home.png` | El rey cinemático: tabs de producto, UI compuesta sobre foto, video de escala de datos, marketplace |
| `motive-home.png` | **Arch-diagram hero** + tab-to-swap-screenshot + badges de premios |
| `fleetio-home.png` | Limpio, screenshots reales, **connect-the-dots**, doble CTA, integrations directory |
| `squarerigger-home.png` | **Hero-video**, sección **"First 30 Days"**, cada bullet con número |
| `whiparound-home.png` | Copy blue-collar memorable, mockups de teléfono, cada claim = cliente + número |
| `rta-home.png` | **Ángulo carrera/identidad**, asistente AI arriba, moat de contenido |
| `fullbay-home.png` | Qué **NO** hacer (esconde el producto) + su pricing público + secciones por persona/vertical |

## 7.6 Patrones de copy a adoptar
- **Cada claim = cliente con nombre + número duro** (el patrón universal).
- Sección **"First 30 Days"** (des-riesgar el switch).
- **Ángulo carrera/identidad** (RTA: "sé un líder respetado, con datos que prueban tu valor").
- **CTA único** ("Start free") en todo el sitio (ya lo tenés).
- **Cero em-dashes, cero AI-slop** (regla de la skill de diseño que ya usamos en el sitio).
