# Documentación de contexto — Fleet Tracker

Conjunto de documentos de **contexto para agentes de IA y mantenedores**. La idea (estándar en proyectos serios con IA): no escribir el contexto a mano cada vez, sino mantener docs vivos que el agente lee antes de tocar el código — así no inventa estructura, no rehace lo ya cerrado, no tropieza dos veces y no salta pasos.

Generados el 2026-06-22 a partir de una auditoría full-stack + research de buenas prácticas (OWASP ASVS/SAMM, etc.) anclados al código real (v1.29.0, **LIVE en producción**).

## Los 6 docs de contexto

| Doc | Para qué |
|-----|----------|
| [ARQUITECTURA.md](ARQUITECTURA.md) | Stack con versiones, árbol de carpetas, flujo de datos, despliegue, y **qué NO existe**. |
| [CONVENCIONES.md](CONVENCIONES.md) | Estilo, naming, anatomía de un endpoint, patrones React/api.ts, commits/SemVer, estado de tests. |
| [DECISIONES.md](DECISIONES.md) | ADR ligero: 11 decisiones ya cerradas (para no rehacerlas) + cuáles son re-evaluables. |
| [GLOSARIO.md](GLOSARIO.md) | Entidades del dominio (modelos ORM), jerga de flota (DVIR/PM/DOT/reefer/ELD), siglas, conceptos técnicos. |
| [FLUJO-DE-TRABAJO.md](FLUJO-DE-TRABAJO.md) | Step-by-step: preparación → cambio → checklist → release → deploy, con los gotchas reales. |
| [ERRORES-CONOCIDOS.md](ERRORES-CONOCIDOS.md) | Catálogo de errores ya vividos + los típicos del vibecoding que aplican a este stack. |

## Los 2 docs de seguridad/auditoría (el encargo principal)

| Doc | Para qué |
|-----|----------|
| [AUDITORIA.md](AUDITORIA.md) | **Auditoría full-stack**: 21 hallazgos priorizados (sev/área/archivo:línea/impacto/fix/esfuerzo) + Quick wins vs Inversiones grandes. |
| [ROADMAP-SEGURIDAD.md](ROADMAP-SEGURIDAD.md) | **10 etapas** progresivas de "login casero" → "app blindada (OWASP ASVS L2)", con estado/GAP y checklist por etapa. |

## Cómo usarlos (para agentes)

1. Antes de tocar **auth, RBAC, multi-tenant o esquema de DB**, lee `AUDITORIA.md` + la sección correspondiente: hay invariantes frágiles (ContextVar de tenant, `create_all` sin Alembic, stores en memoria) que se rompen con cambios "inocentes".
2. Para arreglar algo de seguridad: localiza el **ID** en `AUDITORIA.md` (ej. `SEC-1`), cruza con `ERRORES-CONOCIDOS.md` (síntoma) y `ROADMAP-SEGURIDAD.md` (orden/fase).
3. Verificación hasta que exista CI: `npm run build` (no solo `tsc --noEmit`) + arranque manual. Ver `FLUJO-DE-TRABAJO.md`.

## Otros docs del repo (previos)

`ROADMAP-G.md`, `ROADMAP-H.md` (roadmaps de producto históricos), `STRATEGY-data.md` (estrategia de datos), `map-debug-plan.md`, `reefer-dealer-questions.md`.
