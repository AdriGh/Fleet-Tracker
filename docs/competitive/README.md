# FleetTracker — Teardown Competitivo & Spec de Build (F5)

> Documento de referencia para **igualar o superar** a la competencia de software de
> mantenimiento de flota. Basado en un teardown de **7 sitios** (jul-2026): 5
> competidores directos + 2 plataformas ELD (partners de integración + benchmark).
> No es un doc de marketing: es un **plan de construcción** — qué muestra cada
> competidor, cómo lo implementamos en NUESTRO stack, y en qué orden.

## Cómo leer esto
- Cada capítulo es un archivo en esta carpeta. Empezá por `01`.
- La **columna vertebral** es la lista maestra de gaps del capítulo 01 (§1.5): todo
  lo demás la desarrolla.
- Estado: ✅ escrito · 🚧 en progreso · ⬜ pendiente.

## Índice
| # | Capítulo | Qué cubre | Estado |
|---|---|---|---|
| 01 | **Landscape & posicionamiento** | Set competitivo (directos vs ELD-partners), dónde estás parado, el moat, la **lista maestra de gaps** | ✅ |
| 02 | **Teardowns por competidor** | Los 7, condensados: hero, features, cómo venden, "robar esto", gaps | ✅ |
| 03 | **Specs de build por feature** | 10 specs (índice en `03-feature-build-specs.md`, specs en `03-features/`): Warranty · POs · Fuel · DVIR-builder+app · Technician-time · Tire · AI · VMRS · Lifecycle/TCO · profundidad de partes. Cada una anclada al código real | ✅ |
| 04 | **Arquitectura de la plataforma de integración** | Modelo canónico · adapter framework multi-categoría · sync/eventos · motor de automatizaciones · vault de credenciales/OAuth · API pública | ✅ |
| 05 | **Integraciones presentadas (app + web)** | El hub de Connectivity en la app + el marketplace de 2 capas en el sitio; organización sección por sección | ✅ |
| 06 | **Gaps de stack e infra** | F4 formalizado: queue/Redis · observabilidad · testing/CI · aislamiento multi-tenant. Con pasos de migración | ✅ |
| 07 | **Estructura del sitio de marketing** | IA del sitio + spec sección por sección (referencia de competidores) + playbook del "wow" + referencia VISUAL (screenshots) | ✅ |
| 08 | **Roadmap & secuenciación** | Qué construir, en qué orden, por fases | ✅ |
| A | **Apéndice — teardowns crudos** | Los 7 teardowns completos | ⬜ (opcional; el cap 02 condensado + los screenshots cubren lo esencial) |

## Fuentes
Teardown de 7 sitios (jul-1-2026), research web con 7 analistas en paralelo:
- **Directos:** Fullbay, SquareRigger, Fleetio, RTA, Whip Around.
- **ELD (partners + benchmark):** Samsara, Motive.

> **Screenshots capturados** ✅ (Playwright MCP, jul-1): las 7 homes full-page en
> `screenshots/*.png` — incluidos Fleetio/Samsara/Motive que habían bloqueado a los
> bots en la research de texto (el navegador real sí los cargó). Assets listos para
> el capítulo 07 (referencia visual).
