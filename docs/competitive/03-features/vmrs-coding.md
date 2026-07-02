# Feature: VMRS coding

> Capítulo 03 · Prioridad 🟠 · Esfuerzo **M**
> Codificación de mantenimiento con el estándar de la industria (ATA/TMC), para
> credibilidad enterprise y reportería comparable con Fullbay/SquareRigger/RTA.

## 1. Qué es y por qué importa

**VMRS** (Vehicle Maintenance Reporting Standards) es la taxonomía estándar que
la **ATA (American Trucking Associations)**, a través de su **TMC (Technology &
Maintenance Council)**, mantiene desde 1970 para clasificar todo trabajo de
mantenimiento de flota. Es el vocabulario común con el que los talleres, los
fabricantes de partes (OEM) y los software de mantenimiento hablan entre sí:
cuando un fleet dice "gasté X en el sistema 013", cualquiera en la industria sabe
que habla de **frenos**, sin ambigüedad de idioma ni de rótulo libre.

La estructura es jerárquica y numérica, agrupada en tríos de dígitos
(`###-###-###`):

- **System** (3 díg): el sistema mayor del vehículo. Ej.: `013` = Brakes,
  `045` = Engine, `032` = Suspension, `042` = Transmission.
- **Assembly** (3 díg): el sub-sistema dentro del system. Ej.: dentro de `013`,
  `001` = Air Brake System.
- **Component / Part** (3 díg): la pieza específica. Ej.: `067` = Brake Chamber.

A eso se le suman dos "code keys" muy usados en la orden de trabajo:

- **Reason for Repair** (Code Key 14): POR QUÉ se hizo el trabajo (desgaste,
  falla, PM programado, daño de accidente, campaña/recall).
- **Work Accomplished** (Code Key 15): QUÉ se hizo (reemplazar, reparar,
  ajustar, inspeccionar, R&R).

El set completo cubre **34,000+ códigos** en **65 code keys** — es exhaustivo y
está **licenciado** por la TMC (ver §8, el punto honesto de esta feature).

**Por qué importa para Fleet Tracker.** Hoy nuestro reporte de spend clasifica
las líneas de WO con reglas de keywords propias (`core/reports.py:classify_line`
→ categorías tipo "brakes/tires/engine/labor/other"). Funciona, pero es un
vocabulario **inventado por nosotros**: un director de mantenimiento que viene de
Fullbay o RTA no lo reconoce, y no puede comparar su spend contra benchmarks de
la industria ni contra su propio histórico en otro sistema. VMRS convierte esa
misma reportería en algo que **el comprador enterprise ya espera** y sabe leer.
Es una feature de credibilidad más que de función nueva: reusa el pipeline de
spend que ya tenemos, pero cambia el eje de agrupación por el estándar real.

## 2. Referencia competitiva

- **SquareRigger** — su módulo **"Fleet Insights"** promociona explícitamente
  codificación **VMRS estándar** aplicada tanto en el trabajo (la orden) como en
  la reportería. Es su gancho de "hablamos el idioma de la industria".
- **RTA Fleet** — aplica VMRS en tres lugares que a nosotros nos importan:
  **defectos** (clasificar el hallazgo del DVIR), **garantía** (el claim va con
  su código VMRS, que es lo que el OEM pide) y **core credits** (devolución de
  partes reacondicionables). RTA trata VMRS como plumbing, no como extra.
- **Fleetio / Geotab / Samsara / Motive** — todos documentan VMRS en su glosario
  y lo soportan a algún nivel; es la línea de base que un serio "fleet software"
  publica. No tenerlo es una casilla vacía visible en cualquier comparativa.

Conclusión: VMRS no es un diferenciador (todos lo tienen), es un **requisito de
paridad** para jugar en el segmento enterprise. Nuestra ventaja no será "tener
VMRS" sino **conectarlo al motor de automatizaciones (cap 04)**: reglas que
disparan según el system codificado, algo que los legacy no hacen con soltura.

## 3. Modelo de datos (SQLAlchemy; nota migración Alembic)

Dos piezas: (a) una tabla de **catálogo** para la jerarquía de códigos, y (b)
**campos VMRS** en las tablas transaccionales que ya existen (`WorkOrderLine`,
`Defect`). Todo `OrgScoped` salvo el catálogo, que se decide abajo.

```python
# backend/app/db.py

class VmrsCode(Base):
    """Nodo de la jerarquia VMRS (System -> Assembly -> Component).

    Catalogo de referencia, NO transaccional. Decision de tenancy: los codigos
    de la TMC son un estandar publico compartido, asi que el set semilla
    (systems + subset comun) vive GLOBAL, igual que Poi. Si a futuro un tenant
    define codigos propios (VMRS permite el System 997 para codigos de usuario),
    esas filas SI llevan org_id -> por eso la columna es nullable: NULL = codigo
    estandar TMC compartido; con valor = codigo propio de esa organizacion.
    """
    __tablename__ = "vmrs_code"
    __table_args__ = (
        UniqueConstraint("org_id", "code", name="uq_vmrs_org_code"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int | None] = mapped_column(
        ForeignKey("organization.id"), index=True, nullable=True)  # NULL = TMC estandar
    code: Mapped[str] = mapped_column(String(11), index=True)   # '013' o '013-001-067'
    level: Mapped[str] = mapped_column(String(10), index=True)  # system|assembly|component
    description: Mapped[str] = mapped_column(String(160))
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("vmrs_code.id"), nullable=True, index=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)

    parent: Mapped["VmrsCode | None"] = relationship(remote_side=[id])
```

Campos en las transaccionales (aditivos, todos opcionales para no romper el flujo
actual de carga a mano):

```python
class WorkOrderLine(OrgScoped, Base):
    # ... columnas existentes (kind, description, qty, unit_cost, part_number) ...
    # VMRS: la jerarquia se guarda desnormalizada (los 3 segmentos) para que el
    # reporte agrupe sin joins recursivos; vmrs_code es el string completo.
    vmrs_code: Mapped[str] = mapped_column(String(11), default="", index=True)   # '013-001-067'
    vmrs_system: Mapped[str] = mapped_column(String(3), default="", index=True)  # '013' (para agrupar rapido)
    vmrs_reason: Mapped[str] = mapped_column(String(6), default="")   # Reason for Repair (key 14)
    vmrs_work: Mapped[str] = mapped_column(String(6), default="")     # Work Accomplished (key 15)


class Defect(OrgScoped, Base):
    # ... columnas existentes ...
    vmrs_system: Mapped[str] = mapped_column(String(3), default="", index=True)
    vmrs_code: Mapped[str] = mapped_column(String(11), default="")
```

**Nota migración Alembic.** Postgres (prod) va por Alembic: una revisión que
`create_table("vmrs_code")` + `add_column` de los campos VMRS en `work_order_line`
y `defect`, todos `nullable`/con default `''` (aditivo, sin backfill destructivo).
El sembrado del subset de systems se hace en un **paso de datos idempotente** (data
migration o script de seed que hace upsert por `code` con `org_id IS NULL`), no en
el `create_all`. En SQLite (dev) se replica el patrón de `_migrate()`: `PRAGMA
table_info` + `ALTER TABLE ADD COLUMN` para los campos nuevos, y el mismo seed
idempotente. Como todas las columnas son opcionales, las WO viejas quedan con VMRS
vacío y el reporte las agrupa bajo "Sin codificar".

## 4. Backend (core + endpoints; reglas)

Nuevo módulo **`core/vmrs.py`** + extensión de `core/reports.py`.

**`core/vmrs.py`**
- `seed_systems()` — idempotente; carga el subset de systems de nivel superior
  (ver §8) haciendo upsert por `code` sobre las filas `org_id IS NULL`. Se llama
  desde `init_schema()` como se hace hoy con la org default.
- `list_systems()` / `children_of(code)` — alimentan el selector jerárquico de la
  UI. `children_of('013')` devuelve los assemblies bajo Brakes.
- `search(q)` — búsqueda laxa por código o descripción ("brake" → `013…`), para
  el typeahead del selector.
- `validate(code)` — chequea que exista y esté `active`; el System 997 (rango de
  usuario) se acepta aunque no esté en el catálogo estándar.
- `parse_segments(code)` → `(system, assembly, component)` para desnormalizar al
  guardar la línea.

**Reglas de negocio**
1. **VMRS es opcional en la carga.** Una línea sin código no bloquea nada; el
   flujo actual de WO/invoice no cambia. La codificación se puede completar al
   crear la línea o después (reportería "as you go").
2. **Se guarda desnormalizado.** Al setear `vmrs_code`, el backend rellena
   `vmrs_system` con los 3 primeros dígitos. La fuente de verdad es `vmrs_code`;
   `vmrs_system` es cache para agrupar sin join recursivo (mismo patrón que
   `Part.on_hand` cachea el inventario).
3. **Labor también codifica.** La línea de labor lleva su System (el sistema que
   se estuvo reparando), típicamente el mismo que la parte asociada.
4. **`classify_line` convive con VMRS, no se reemplaza.** El reporte de spend
   existente sigue clasificando por nuestras keywords cuando NO hay VMRS; cuando
   la línea trae `vmrs_system`, el nuevo eje VMRS lo usa directo. Migración suave:
   nada se rompe, VMRS mejora la reportería a medida que se codifica.

**Endpoints (`api/routes.py`)**
- `GET  /api/vmrs/systems` — lista de systems (para el selector).
- `GET  /api/vmrs/children?code=013` — assemblies/components de un nodo.
- `GET  /api/vmrs/search?q=brake` — typeahead.
- `PATCH /api/workorders/{id}/lines/{line_id}` — acepta `vmrs_code`, `vmrs_reason`,
  `vmrs_work` (valida y desnormaliza server-side).
- `GET  /api/reports/spend?group_by=vmrs_system` — el reporte de spend existente
  gana un eje de agrupación VMRS (ver §5 y §9). Roles: lectura para admin/
  dispatcher (mismo gate que el resto de reportería).

## 5. UI (React; dónde encaja; estados vacío/carga/error)

**Selector VMRS en la línea de WO.** En el editor de líneas de la Work Order
(donde hoy se pone descripción + qty + costo + part_number), se agrega un control
**VmrsPicker**: tres dropdowns encadenados (System → Assembly → Component) o un
único combobox con búsqueda que muestra `013-001-067 · Brake Chamber`. Al lado,
dos selects chicos para **Reason** y **Work Accomplished**. El campo es opcional y
colapsable ("+ Código VMRS") para no recargar la carga rápida del jefe.

- **Vacío:** placeholder "Sin codificar (opcional)"; la línea se guarda igual.
- **Carga:** el árbol de systems se cachea en el cliente (es chico y estable); el
  typeahead muestra spinner inline mientras consulta `/api/vmrs/search`.
- **Error:** si `/api/vmrs/*` falla, el picker cae a input de texto libre con hint
  "no se pudo cargar el catálogo VMRS, podés escribir el código a mano" — nunca
  bloquea guardar la WO.

**Reportería agrupada por VMRS.** En la vista de **Spend Report** (la que ya
grafica `by_category`), se agrega un toggle de eje: *Por categoría (nuestra)* ↔
*Por VMRS System*. Con VMRS activo, la barra/tabla agrupa el gasto por system
(`013 Brakes: $X`, `045 Engine: $Y`) y permite **drill-down** a assembly. Debajo,
un breakdown de **Reason for Repair** (cuánto gasto fue PM vs falla vs accidente),
que es la lectura que el enterprise busca.

- **Vacío:** si ningún WO está codificado, la vista VMRS muestra "Aún no hay
  líneas codificadas con VMRS" + link a codificar, y todo el gasto aparece bajo
  "Sin codificar".
- **Carga / Error:** reusa los estados del Spend Report actual (skeleton de
  chart; banner de error con retry).

## 6. Automatizaciones (cap 04)

VMRS le da al **motor de automatizaciones** un eje semántico limpio para disparar
reglas (mucho mejor que hacer match sobre texto libre de la descripción):

- **Spend por system fuera de rango** → "el gasto en System 017 (Tires) superó el
  umbral mensual del terminal X" → alerta / tarea.
- **Repetición por unit + system** → una unidad con N reparaciones del mismo
  system en M meses (síntoma de problema crónico) → sugiere inspección o
  reemplazo, alimenta el TCO/lifecycle.
- **Reason = Warranty/Recall** → al codificar una línea con ese reason, dispara
  el flujo de **Warranty recovery** (feature hermana del cap 03) con el código
  VMRS ya listo para el claim al OEM.
- **Reason = PM** en un system → cruza contra el PM tracker para validar que la
  campaña quede registrada.

La automatización lee el modelo canónico (cap 04); VMRS es uno de sus campos de
clasificación de primera clase.

## 7. Integraciones que toca

- **Warranty (futuro)** — el claim al OEM se arma con el código VMRS de la línea;
  es exactamente el formato que fabricantes y proveedores esperan (RTA lo hace
  así). VMRS es prerequisito práctico de un Warranty recovery creíble.
- **Catálogo de partes / FinditParts (gap de API de partes)** — muchas partes de
  proveedor traen su VMRS component asociado; al elegir una `Part` del catálogo,
  se puede **prefill** el `vmrs_code` de la línea desde el mapeo parte→VMRS.
- **Reportería de spend existente** (`core/reports.py`) — VMRS se suma como eje de
  agrupación, no la reemplaza.
- **Telematics / DVIR** — el `Defect` codificado con VMRS system conecta el
  hallazgo del DVIR con el gasto de la reparación (mismo system), cerrando el loop
  defecto→WO→spend por código.
- **Export contable / QuickBooks (priorizado)** — el system VMRS puede mapearse a
  cuentas contables para un desglose de gasto por sistema en el libro mayor.

## 8. Esfuerzo (S/M/L) · prioridad · dependencias

**Esfuerzo: M.** Modelo + seed del subset + selector UI + eje nuevo en un reporte
que ya existe. No requiere infraestructura nueva.

**Prioridad: 🟠** — credibilidad enterprise y reportería comparable con la
industria; no bloquea a nadie hoy, pero cierra una casilla visible en toda
comparativa contra SquareRigger/RTA.

**Dependencias:** ninguna dura. Se apoya en el pipeline de spend existente
(`reports.py`) y en el patrón de tablas `OrgScoped`/seed global (como `Poi`). Se
potencia con el motor de automatizaciones (cap 04) y habilita Warranty recovery.

**El tema del licenciamiento (abordado con honestidad).** El set completo de VMRS
(34,000+ códigos, 65 code keys) es **propiedad licenciada de la TMC/ATA** —
Complete Corporate License / Distribution License para ofrecerlo en un SaaS. **No
podemos redistribuir el set completo sin licencia.** Recomendación en dos fases:

1. **Fase 1 (ahora, sin licencia):** sembrar solo los **códigos de System de
   nivel superior** (los ~60-70 systems mayores: Brakes, Engine, Transmission,
   Tires, Electrical, etc. — información de dominio público y ampliamente
   documentada) + **entrada manual** de assembly/component como texto/código
   libre, usando el rango de usuario **System 997** que la propia TMC reserva para
   códigos definidos por el cliente. Esto ya da el 80% del valor: reportería de
   spend por system, que es la lectura de gerencia que importa.
2. **Fase 2 (evaluar licencia TMC):** si la tracción enterprise lo justifica,
   licenciar el set completo de la TMC y poblar `vmrs_code` con assemblies y
   components oficiales. El modelo de datos ya está diseñado para absorberlo sin
   cambios (basta correr un seed más grande) — por eso `VmrsCode` es jerárquico y
   el `org_id` nullable separa lo estándar de lo propio del cliente.

Esta postura hay que dejarla explícita en el material de venta: "VMRS a nivel
system out-of-the-box; set completo TMC bajo licencia" es honesto y suficiente
para la mayoría de los compradores.

## 9. Ejemplo end-to-end con datos realistas

**Escenario.** Unidad **T-238** (Freightliner Cascadia) entra al taller: el
conductor reportó en el DVIR que el pedal de freno va largo. Se abre WO #1047.

1. **Defecto (DVIR).** El `Defect` del reporte diario se codifica con
   `vmrs_system = '013'` (Brakes). El motor de automatizaciones ya podría sugerir
   abrir la WO en el system de frenos.
2. **Work Order #1047.** El mecánico Luis carga dos líneas:
   - Línea parte: `Brake Chamber, Type 30` · part_number `BW-802627` · qty 2 ·
     $84.50 c/u → el picker lo codifica `013-001-067` (System 013 Brakes,
     Assembly 001 Air Brake System, Component 067 Brake Chamber). **Reason** =
     `Wear`, **Work Accomplished** = `Replace`. `vmrs_system` se desnormaliza a
     `013`.
   - Línea labor: "R&R brake chambers, adjust slack" · 1.5 h × $95 = $142.50 →
     `vmrs_system = '013'`, Work = `Replace`.
3. **Facturación.** La WO se factura normal; el total ($311.50) no depende de
   VMRS. El inventario descuenta las 2 cámaras como siempre.
4. **Reportería.** En el Spend Report, toggle **Por VMRS System**, rango del mes:

   | System | Descripción | Gasto | % |
   |--------|-------------|------:|--:|
   | 013 | Brakes | $4,820 | 31% |
   | 045 | Engine | $3,110 | 20% |
   | 017 | Tires | $2,540 | 16% |
   | 032 | Suspension | $1,180 | 8% |
   | — | Sin codificar | $3,900 | 25% |

   Drill-down de `013` muestra `013-001 Air Brake System: $3,200` vs
   `013-002 Hydraulic: $1,620`. Breakdown de **Reason**: PM 42%, Wear 38%,
   Failure 20% — la lectura que el director de mantenimiento reconoce al instante
   porque es el mismo eje que veía en Fullbay/RTA.
5. **Automatización (cap 04).** Como `013` de T-238 acumuló 3 reparaciones en 90
   días, se genera una tarea "revisar sistema de frenos de T-238 — patrón
   recurrente", alimentando el análisis de TCO de la unidad.
