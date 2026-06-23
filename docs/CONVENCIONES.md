# Convenciones

Este documento fija el estilo y los patrones REALES de Fleet Tracker (DVIR Report Generator) para que cualquier agente o persona escriba código que se vea idéntico al que ya existe, sin inventar estructura ni repetir errores ya resueltos. Es descriptivo del repo tal cual está hoy (v1.29.0), no un ideal teórico: cuando una práctica recomendada NO se cumple aún, se marca como tal. Para el "dónde vive cada cosa" ver [ARQUITECTURA.md](ARQUITECTURA.md); para el "por qué" de las decisiones ver [DECISIONES.md](DECISIONES.md); para términos de dominio ver [GLOSARIO.md](GLOSARIO.md).

---

## 1. Idioma

Regla dura, sin excepciones nuevas:

| Qué | Idioma | Ejemplo real |
|---|---|---|
| Comentarios y docstrings | **Español** (con acentos) | `core/workorders.py:2` *"Work Orders (G5; pipeline H2 — el reemplazo de Fullbay)"* |
| Identificadores (funciones, vars, clases, archivos) | **Inglés** | `create_wo`, `gate_error`, `WorkOrderLine`, `PartsPage.tsx` |
| Strings de UI y mensajes de error de la API | **Inglés** | `"add parts or labor lines before invoicing"`, `"assign a mechanic before moving past Open"` |
| `detail` de `HTTPException` | **Inglés** (se muestra tal cual en la UI) | `"WO not found"`, `"File too large (max 20 MB)"` |

- El comentario que precede a un `raise` aclara en español que el mensaje se ve en la UI: `# Gate del pipeline: el mensaje se muestra tal cual en la UI.` (`api/routes.py:627`). Si el texto del `raise` cambia, cambia lo que ve el usuario final: trátalo como copy.
- Hay mezcla histórica de español en algunos `detail` (`"date debe ser YYYY-MM-DD"`, `"Falta la empresa"` en `routes.py:281,284`). **No lo imites**: texto nuevo de error va en inglés. No salgas a "arreglar" los viejos salvo que toques esa ruta por otra razón.
- Archivos con acentos en el código abren con `# -*- coding: utf-8 -*-` (`core/workorders.py:1`). Solo añádelo si el archivo realmente tiene acentos en literales/identificadores; no todos lo llevan.

---

## 2. Backend — estructura y naming

### 2.1 Layout
- Toda la app vive en `backend/app/`: `config.py`, `db.py`, `main.py`, `__init__.py` (solo `__version__`), `api/routes.py`, `schemas.py`, y **toda la lógica de dominio en `core/*.py`** — un módulo por área (`workorders.py`, `parts.py`, `purchasing.py`, `inventory.py`, `maint.py`, `pm.py`, `reefer.py`, `tracking.py`, `alerts.py`, `auth.py`, `permissions.py`, `tenant.py`, `secretstore.py`, `docscan.py`, etc.).
- `from __future__ import annotations` al tope de los módulos de `core/` (ver `core/workorders.py:20`). **No** en `db.py` / `config.py`.

### 2.2 Naming
- Funciones y variables: **snake_case**.
- Helpers privados de módulo: prefijo `_` (`_line_dict`, `_wo_dict`, `_display_no`, `_scope_for`, `_migrate`, `_secret`, `_mask_email`).
- Constantes a nivel módulo en **UPPER_SNAKE**, como tuplas/dicts (`STATUSES`, `PRIORITIES`, `LINE_KINDS`, `ROLES`, `SCOPES`). Ejemplo real `core/workorders.py:29-32`:
  ```python
  STATUSES = ("open", "assigned", "in_progress", "completed", "invoiced")
  _ORDER = {s: i for i, s in enumerate(STATUSES)}
  PRIORITIES = ("low", "normal", "high")
  LINE_KINDS = ("part", "labor")
  ```
- **Type hints modernos**: `int | None`, `str | None`, `dict | None`, `list[dict]`, y `Mapped[...]` en modelos. No uses `Optional[...]` / `List[...]` de `typing` en código nuevo.
- **Imports diferidos dentro de funciones** para romper ciclos de orden de carga, siempre con comentario: `from . import maint  # import diferido (orden de carga)`.

### 2.3 Modelos SQLAlchemy (`db.py`)
- SQLAlchemy 2.0 declarativo: `class Base(DeclarativeBase)`, columnas `Mapped[...] = mapped_column(...)`.
- Las tablas de datos de negocio heredan del mixin **`OrgScoped`** (aporta `org_id`) además de `Base`: `class WorkOrder(OrgScoped, Base)`. Las de config/sistema (`Organization`, `OrgSetting`, `User`, `Poi`) heredan solo de `Base`. **Si creas una tabla nueva de datos de tenant, DEBE heredar de `OrgScoped`** — si no, se filtra entre clientes (ver [ERRORES-CONOCIDOS.md](ERRORES-CONOCIDOS.md)).
- `__tablename__` en **snake_case singular** (`work_order`, `purchase_order`, `part_stock_movement`).
- Líneas hijas con `relationship(back_populates=..., cascade="all, delete-orphan")` (WO/PO → líneas).
- Multi-tenancy a nivel ORM por eventos: `before_flush` autocompleta `org_id`; `do_orm_execute` filtra SELECT con `with_loader_criteria`. No agregues `WHERE org_id=...` manual en queries: ya lo hace la capa ORM. Sin tenant en contexto (jobs, seeding) no filtra.

---

## 3. Anatomía de un endpoint (`api/routes.py`)

Un solo router: `router = APIRouter(prefix="/api")` (`routes.py:45`). El patrón canónico es el grupo de work orders (`routes.py:562-648`). Replícalo:

1. **Modelos Pydantic de entrada por endpoint**, declarados justo encima del grupo de rutas: `class WorkOrderIn(BaseModel)`, `class WorkOrderPatch(BaseModel)` (en PATCH **todos** los campos `| None = None`), `class WoLineIn(BaseModel)`.
2. **La ruta es fina**: delega TODA la lógica al módulo `core/`. Caso ideal (`routes.py:562-566`):
   ```python
   @router.get("/workorders")
   def wo_list(status: str = "", unit: str = ""):
       return {"workorders": workorders.list_wos(status, unit),
               "stats": workorders.stats(),
               "mechanics": workorders.mechanics()}
   ```
3. **Manejo de errores (contrato fijo):** el core lanza `ValueError` con mensaje en inglés; la ruta lo traduce a HTTP:
   ```python
   try:
       return workorders.create_wo(...)
   except ValueError as exc:
       raise HTTPException(status_code=400, detail=str(exc))   # routes.py:577
   ```
   `404` cuando el core devuelve `None`/`False`: `if wo is None: raise HTTPException(status_code=404, detail="WO not found")` (`routes.py:600`). `422` para uploads vacíos / formato de fecha (`routes.py:281,587`). **No** inventes otros status ni metas la lógica en el `except`.
4. **PATCH parcial:** manda al core solo los campos presentes:
   ```python
   workorders.update_wo(wo_id, {k: v for k, v in body.model_dump().items() if v is not None})  # routes.py:624
   ```
5. **Auth/RBAC:** el enforcement primario es el **middleware** `_require_auth` + `_scope_for` en `main.py:48-118`. La ruta solo refina lo que depende del body, recibiendo `authorization: str | None = Header(default=None)` y llamando `require_scope(...)`. Caso real: facturar exige `wo.invoice` además del `maint.edit` del middleware (`routes.py:614-618`):
   ```python
   if body.status == "invoiced":
       require_scope("wo.invoice", authorization)
   ```
6. **Reglas de scope:** GET nunca exige scope (cualquier autenticado lee). POST/PATCH/DELETE mapean a un scope por **prefijo de path** en `_scope_for` (`main.py:48-92`). Si agregas una familia de rutas nueva con escritura, agrega su prefijo ahí — si no, queda sin protección de rol.
7. **Hooks de negocio viven en el core, no en la ruta.** Al facturar un WO (`workorders.update_wo`) se consume inventario, se actualiza el PM tracker y se registra la campaña — todo idempotente vía guards. La ruta no orquesta nada de eso.
8. **Respuestas:** dict crudo o modelo Pydantic (`response_model=...` cuando hay schema en `schemas.py`, ej. `HealthResponse` en `routes.py:53`). Los serializers **recalculan totales desde las líneas** (`_line_dict` hace `round(ln.qty * ln.unit_cost, 2)`), no confían en valores cacheados.

**Qué NO hacer en una ruta:** queries SQLAlchemy directas, reglas de negocio, llamadas a proveedores externos (Samsara/Groq/email), o `try/except` que tape errores. Si te ves escribiendo `SessionLocal()` dentro de `routes.py`, va en un `core/`.

---

## 4. Frontend — React / TypeScript

### 4.1 Estructura y naming
- **Vistas:** `src/views/*.tsx` en PascalCase (`PartsPage.tsx`, `Dashboard.tsx`, `MaintBoardPage.tsx`).
- **Componentes compartidos:** `src/components/*.tsx`; **design system** en `src/components/ds/` (`Button`, `Card`, `Tabs`, `StatCard`, `StatusPill`, `Badge`, `NavItem`, `Input`, `IconButton`).
- Componentes funcionales con hooks. `export default function PageName()`. **Subcomponentes y modales se declaran en el mismo archivo de la vista**: `PartsTab`, `VendorsTab`, `PartModal`, `AdjustStockModal` viven dentro de `PartsPage.tsx`. No partas una vista en N archivos salvo que un componente se reutilice de verdad.

### 4.2 Data fetching — TanStack React Query
Patrón único (real, `PartsPage.tsx:76-119`):
```tsx
const qc = useQueryClient()
const partsQ = useQuery({ queryKey: ['parts'], queryFn: listParts })
// ...tras mutar:
qc.invalidateQueries({ queryKey: ['parts'] })   // refetch por invalidación
notifyOk('Part deleted', p.part_number)
```
- Mutaciones por **invalidación** de `queryKey`, no actualización optimista manual.
- Una operación puede invalidar varias keys relacionadas (borrar un vendor invalida `['vendors']` y `['parts']`, `PartsPage.tsx:561-562`).
- `queryKey` con parámetros como segundo elemento del array: `['part-movements', part.part_number]` (`PartsPage.tsx:299`).

### 4.3 Estilos
- **className con CSS global** (no CSS-in-JS, no Tailwind): `card`, `card-head`, `card-body`, `kpi-row`, `cell-input`, `btn btn-primary` / `btn-ghost` / `btn-xs`, `empty mini`, `table-wrap`, `muted`, `mono`, `num`. Estados de fila condicionales (`row-low`). Reutiliza estas clases; no introduzcas un sistema de estilos nuevo.

### 4.4 TS y feedback
- `interface` para shapes de datos; `type` para uniones: `type WoStatus = 'open' | 'assigned' | ...`, `type Tab = 'parts' | 'vendors' | ...`. Opcionales con `?`.
- Toasts: `notifyOk(title, detail)` / `notifyErr(title, error)` desde `../toast` (`PartsPage.tsx:12`). El segundo argumento de `notifyErr` puede ser el `Error` capturado: `notifyErr("Couldn't delete part", e)`.
- Comentarios inline en español aclarando intención/reglas.

---

## 5. Cómo `api.ts` habla con el backend (`frontend/src/api.ts`)

Un único cliente (~2300 líneas), una función `async` exportada por endpoint.

- **`fetch` está shadoweado a nivel módulo** (`api.ts:21-34`): inyecta `Authorization: Bearer <token>` automáticamente. El token vive en `localStorage` bajo `'ft-token'` (helpers `getToken` / `setToken` / `clearToken`, `api.ts:13-16`). Un **401** limpia el token y dispara `window.dispatchEvent(new Event('ft-unauthorized'))` para que `App` vuelva al login.
- **Patrón estándar de cada función** (cópialo literal):
  ```ts
  const res = await fetch(url, {...})
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
  ```
- `readError(res)` (`api.ts:36-47`) extrae `data.detail` (string), o concatena `data.detail[].msg` (errores de validación Pydantic), o cae a `Error <status>`. **No reimplementes parsing de error**; usa `readError`.
- Cada respuesta tiene su `interface` exportada (`WorkOrder`, `WoStats`, `ReeferUnit`, `MaintRow`, `FleetUnit`…).
- **Descargas auth-protegidas (PDF/Excel)** se bajan por **fetch + blob** y `URL.createObjectURL`. Un `<a href>` directo NO lleva el Bearer → 401. Ver `downloadUnitDoc`, `viewWoInvoiceFile`, `fetchWoInvoiceThumbUrl`. No agregues descargas por link directo a endpoints autenticados.
- Query params con `URLSearchParams`; segmentos de path con `encodeURIComponent`.
- **No metas secretos en el front.** Hoy el bundle está limpio (cero `VITE_*` con claves). Toda integración sensible (Samsara, Groq, email/SMS) vive en el backend; el front solo manda `provider + values` a `/api/integrations/config`.

---

## 6. Commits, CHANGELOG y versionado

### 6.1 CHANGELOG
- `CHANGELOG.md` sigue **Keep a Changelog (en español)** con **SemVer** (`CHANGELOG.md:1-6`).
- Entrada por versión: `## [1.29.0] - 2026-06-22`, con subsecciones **Agregado / Añadido / Cambiado / Corregido / Nota**. Hay un `## [No publicado]` al tope para acumular cambios sin liberar.
- Estilo de entrada: **negrita** para el título del cambio + prosa que explica el porqué y, si aplica, el síntoma corregido. Ver las entradas v1.28.x como modelo (explican causa raíz, no solo "fix").
- Las entradas referencian **fases del roadmap** como etiquetas de trazabilidad: G1–G7, G-TMS, H1–H6 (sub-fases 3a/3b/3c/3d), "Increment A/B/C", "Inventory". Úsalas si tu cambio pertenece a una fase.

### 6.2 Versión
- **Fuente única de versión:** `backend/app/__init__.py` → `__version__ = "1.29.0"`. La consume FastAPI (`version=__version__` en `main.py:27`) y `/api/health` (`routes.py:53-55`). Al liberar, **bump aquí** y nada más.

### 6.3 Flujo de release (pre-autorizado, ver [FLUJO-DE-TRABAJO.md](FLUJO-DE-TRABAJO.md))
Tras cada feature, por incremento:
1. `merge --no-ff` de la rama de feature a `main`.
2. Entrada en `CHANGELOG.md`.
3. Bump de `__version__`.
4. `tag` SemVer + `push`.
5. Borrar las ramas ya mergeadas.

Producción es **LIVE** (Dokploy/Hostinger VPS, autodeploy On Push). Un push a `main` despliega: no rompas el build.

---

## 7. Tests — estado real y convención

> **Severidad: ALTA (deuda).** Hoy **no hay suite de tests automatizados.**

- No existen `test_*.py` en `backend/app`, ni `pytest.ini` / `conftest.py` / `tox.ini`, ni `*.test.tsx` / Vitest / Jest. El único `test_*` es `backend/scripts/test_email.py`, un script manual de prueba de email — **no** un test unitario.
- **Verificación actual = build + arranque manual.** El proceso documentado (CHANGELOG v1.28.1, task #6) es:
  ```
  npm run build        # tsc -b + vite build — más estricto que tsc --noEmit
  ```
  y lanzar la app comprobando que no haya errores de consola. `tsc -b` ha cazado regresiones reales (campo obligatorio faltante, v1.28.1). **Siempre corre `npm run build`, no solo `tsc --noEmit`.**
- Endpoints `/integrations/test` y `/eld/.../fleet-preview` sirven como chequeos vivos de proveedores externos.

**Convención recomendada cuando se introduzcan tests** (para mantener coherencia con la arquitectura por-dominio):
- Backend: `pytest` con `httpx.AsyncClient` + `ASGITransport`; sobrescribir dependencias con `app.dependency_overrides` (no monkeypatch). Tests en `backend/tests/` espejando `core/`. Empieza por el **core**, no por las rutas: ahí vive la lógica (gates de pipeline, idempotencia de hooks, recálculo de totales).
- Frontend: Vitest + Testing Library, co-localizados; MSW para mockear la API.
- Prioridad alta de cobertura: `core/workorders.gate_error` y los hooks de facturación (consumo de inventario / PM / campaña) — su idempotencia es crítica y hoy no está verificada por nada salvo inspección.

---

## 8. Qué hacer y qué NO hacer (checklist)

**HAZLO:**
- Comentarios/docstrings en español; identificadores y mensajes de UI/API en inglés.
- Ruta fina → core gordo. `ValueError` (inglés) en el core → `HTTPException(400, str(exc))` en la ruta; `None`/`False` → `404`.
- Tablas nuevas de datos de tenant heredan de `OrgScoped`.
- Type hints modernos (`x | None`, `list[dict]`, `Mapped[...]`).
- Subcomponentes/modales en el mismo `.tsx` de la vista; data por `useQuery` + invalidación; estilos por clases CSS globales existentes.
- En `api.ts`: el patrón `fetch → if (!res.ok) throw new Error(await readError(res)) → res.json()`; descargas autenticadas por blob.
- Por incremento: CHANGELOG + bump de `__version__` + `merge --no-ff` + tag + push.
- Verifica con `npm run build` antes de dar por hecho un cambio de front.

**NO LO HAGAS:**
- No metas SQL, reglas de negocio ni llamadas externas en `api/routes.py`.
- No agregues `WHERE org_id=...` manual (lo hace el ORM); no crees tablas de tenant sin `OrgScoped`.
- No introduzcas Tailwind/CSS-in-JS ni un segundo cliente HTTP; no descargues endpoints autenticados con `<a href>` directo.
- No pongas claves/secretos en el front (`VITE_*` con secretos) ni en la DB/repo — van por `SecretStore` (ver [GLOSARIO.md](GLOSARIO.md)).
- No uses `Optional[...]`/`List[...]`; no devuelvas status HTTP fuera del contrato (400/404/422).
- No cambies textos de `detail` sin asumir que cambias copy visible.
- No rompas el build de `main`: despliega solo.
- No confíes en "compila luego funciona": no hay tests; valida manualmente el flujo afectado.

Errores ya cometidos y resueltos (no repetir): codificación de `@`/`:` en `DATABASE_URL`, montaje de secrets read-only que rompía el login, campo `reorder_point` obligatorio faltante en el build. Detalle en [ERRORES-CONOCIDOS.md](ERRORES-CONOCIDOS.md). Pendientes de seguridad (token 30d en localStorage, sin CSP, sin Error Boundary) en [ROADMAP-SEGURIDAD.md](ROADMAP-SEGURIDAD.md) y [AUDITORIA.md](AUDITORIA.md).
