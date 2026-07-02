# 03 — Specs de build por feature

> El corazón del documento: **10 specs de build**, una por cada gap 🛠️ del capítulo 01.
> Cada spec vive en `03-features/` y sigue la MISMA plantilla: *qué hace el competidor →
> modelo de datos en TU stack → backend → UI → automatizaciones → integraciones →
> esfuerzo/prioridad → ejemplo end-to-end*. Todas están **ancladas al código real** de
> Fleet Tracker (no genéricas).

## Índice de specs (por prioridad)

### 🔴 ALTA
| Feature | Archivo | Esfuerzo |
|---|---|---|
| **Warranty & core recovery** (el ROI de venta #1) | [warranty-recovery.md](03-features/warranty-recovery.md) | L (3 fases; fase 1 demoable) |
| **Purchase Orders + procurement** | [purchase-orders.md](03-features/purchase-orders.md) | M (reusa el scaffold PO existente) |
| **Fuel management + fuel-cards** | [fuel-management.md](03-features/fuel-management.md) | M-L (motor de 6 excepciones) |
| **DVIR form-builder + app del conductor** | [dvir-form-builder-driver-app.md](03-features/dvir-form-builder-driver-app.md) | L (la app móvil PWA offline es lo pesado) |

### 🟠 MEDIA-ALTA / MEDIA
| Feature | Archivo | Esfuerzo |
|---|---|---|
| **Technician time (ShopWatch)** | [technician-time.md](03-features/technician-time.md) | M |
| **Tire management** | [tire-management.md](03-features/tire-management.md) | M |
| **Asistente AI + NL analytics** | [ai-assistant.md](03-features/ai-assistant.md) | M (reusa Groq de docscan) |
| **Profundidad de partes** (bin/barcode/min-max/vendor) | [parts-depth.md](03-features/parts-depth.md) | M (extiende lo existente) |
| **VMRS coding** | [vmrs-coding.md](03-features/vmrs-coding.md) | M (+ evaluar licencia TMC) |

### 🟡 MEDIA
| Feature | Archivo | Esfuerzo |
|---|---|---|
| **Lifecycle / TCO + reemplazo** | [lifecycle-tco.md](03-features/lifecycle-tco.md) | M (extiende los reportes de spend) |

## Cómo leerlas
Cada spec es **independiente y self-contained**. Todas asumen:
- El **motor de automatizaciones + modelo canónico** del **cap 04** (los triggers→acciones).
- El **task queue** del **cap 06** (prerequisito de las automatizaciones y el write-back).

El **orden de construcción** recomendado está en el **cap 08 (roadmap)**. Regla general: las
🔴 primero, pero **Warranty va #1** (es el argumento de venta más fuerte y ya estaba en tu
backlog), y **POs + profundidad de partes** habilitan el módulo Parts & Vendors (donde entra
FindItParts, cap 04).

## Patrón común detectado (buena señal)
Los 10 specs comparten estructura porque tu stack ya tiene las piezas base: `WorkOrder` +
`WoLine` (labor/parts), `Part` + `PartStockMovement` (inventario idempotente), el mixin
`OrgScoped` (multi-tenant), el `TelematicsProvider` (odómetro para cost-per-mile / MPG /
geo), y los reportes de spend (`core/reports.py`). **La mayoría de estas features son
EXTENSIONES aditivas, no reescrituras** — por eso casi todas son esfuerzo M.
