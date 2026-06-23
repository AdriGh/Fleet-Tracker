# GLOSARIO

Diccionario de referencia de Fleet Tracker (repo `DVIR-Report-Generator`): entidades del dominio, jerga de flota, siglas y conceptos técnicos propios. El objetivo es que cualquier agente de IA hable el mismo idioma que el código **sin inventar nombres ni reglas**: cada término apunta a su modelo, archivo o función reales. Para el panorama de capas ver ARQUITECTURA.md; para estilo y patrones, CONVENCIONES.md; para los riesgos vivos, AUDITORIA.md y ERRORES-CONOCIDOS.md.

> Nota de naming: el repo se llama `DVIR-Report-Generator` por su origen (generador de reportes DVIR), pero el producto creció a un sistema completo de mantenimiento/flota. **Fleet Tracker** es el nombre del producto. Versión actual: **v1.29.0** (`backend/app/__init__.py`).

---

## 1. Entidades del dominio (modelos ORM en `db.py`)

Todos los modelos están en `backend/app/db.py`. Los de **datos de negocio** heredan de `OrgScoped` (aporta `org_id`, ver §4); los de **config/sistema** (`Organization`, `OrgSetting`, `User`, `Poi`) heredan solo de `Base`. `__tablename__` siempre en snake_case singular.

| Entidad (clase) | Tabla | Definición y relaciones |
|---|---|---|
| **Organization** | `organization` | Tenant del SaaS (H6 fase 3): la cuenta-cliente que paga. Por **encima** de `company` (los carriers tipo CHASER/MCC viven dentro de una org). `slug` único; hay una org `'default'` sembrada por `ensure_default_org()` (`db.py:506`) = modo single-tenant actual. No es `OrgScoped`. |
| **OrgScoped** | (mixin) | No es tabla: mixin (`db.py:38`) que agrega `org_id` (FK a `organization`, `index=True`, **`nullable=True` por ahora**) a toda tabla de negocio. El aislamiento por tenant se aplica con eventos ORM (ver §4). |
| **OrgSetting** | `org_setting` | Config **NO secreta** por tenant (H6 fase 3d): blob JSON con PK compuesta `(org_id, key)`. Reemplaza los `*.local.json` single-tenant de `org_config`/`app_config`/`alerts`. Acceso vía `get_setting()`/`save_setting()` (`db.py:532`/`560`). Los secretos NO viven aquí (van a `SecretStore`). |
| **User** | `user` | Usuario de la app (G7). `role` ∈ admin/dispatcher/safety/mechanic/viewer. `pw_hash` = pbkdf2-sha256 (200k iters, salt propio) en formato `salt_hex$digest_hex` (`core/auth.py`). Pertenece a una org (`org_id`). **`username` es `unique=True` GLOBAL** (`db.py:247`) — bug multi-tenant conocido (ver AUDITORIA.md H6). |
| **Unit** | `unit` | Unidad agregada a mano (Fleet → Add New Unit) para terminales/clientes fuera de Samsara. Clave de negocio: `unit` (número de unidad). `unit_type`: truck/trailer/chassis. Complementa el fleet vivo de Samsara y alimenta los trackers PM/DOT. |
| **WorkOrder (WO)** | `work_order` | Orden de trabajo (G5/H2 — reemplazo de Fullbay). Pipeline `open → assigned → in_progress → completed → invoiced`. `waiting_parts` es un **flag, no un estado**. Gates en `core/workorders.py`: assigned exige mecánico, invoiced exige total > 0. Multi-unidad: orden **PADRE** + N **HIJAS** vía `parent_id`/`child_seq` (display `#4`/`#4.1`). `shop_invoice` = nº de factura del taller externo (del escaneo); `invoice_number` = el propio de Fleet Tracker (auto al facturar). `campaign` la liga a una campaña de mantenimiento. → `lines` (cascade `all, delete-orphan`). |
| **WorkOrderLine** | `work_order_line` | Línea de un WO: `kind` = `part` (qty × unit_cost) o `labor` (horas × tarifa). `part_number` opcional referencia el catálogo `Part` (vacío = línea a mano). FK `wo_id`. |
| **Part** | `part` | Parte del catálogo (estilo Fullbay, H3). `cost` es **interno** (lo que paga el taller, sin markup). `on_hand` = existencia **cacheada**; `reorder_point` = umbral de low-stock (`0` = sin seguimiento). FK opcional `vendor_id`. |
| **PartStockMovement** | `part_stock_movement` | Libro **auditable** de inventario (fase Inventory): cada cambio de existencia. `delta` (+recepción PO / −consumo WO / ajuste), `reason` ∈ `po_receive`/`wo_consume`/`manual`, `ref_type`/`ref_id` = origen exacto. El triple `(reason, ref_type, ref_id)` se **pretende** único por org (guard de idempotencia en `core/inventory.adjust`) — pero **no hay UniqueConstraint real** (ver AUDITORIA.md H4). `Part.on_hand` es el cache; esta tabla es la fuente de verdad. |
| **PurchaseOrder (PO)** | `purchase_order` | Orden de compra de partes a un vendor (QuickBuy, Increment B). Pipeline `draft → ordered → received`; al recibir repone stock. `total` recalculado en el serializer (no se confía en el crudo). `vendor` es **texto libre** (sin FK dura). → `lines` (cascade). |
| **POLine** | `po_line` | Línea de una PO: una parte (qty × unit_cost). Espeja `WorkOrderLine`; `part_number` referencia `Part`. FK `po_id`. |
| **Vendor** | `vendor` | Proveedor de partes/servicios (H3). El taller le compra; referenciado por `Part.vendor_id`. Campos: contacto, teléfono, email, dirección, nº de cuenta. |
| **MaintRecord** | `maint_record` | Evento de mantenimiento por unidad (H1). `kind` = `pm` o `dot` (en código; las campañas extendidas viven en `CAMPAIGNS`). Historial editable desde los dashboards gemelos PM/DOT; **el más reciente por fecha manda**. Se inserta al facturar un WO con campaña. |
| **ReportBlock** | `report_block` | Bloque DVIR diario generado (una `company` + una `block_date`). Guarda métricas (`n_reports`, `n_no_dvir`, `n_unsafe`, `fleet_safe_pct`) y los grupos en `groups_json` (Text). Alimenta el panel "Recent DVIRs". → `drivers`, `defect_items` (cascade). |
| **BlockDriver** | `block_driver` | Conductor dentro de un `ReportBlock` + flag `is_no_dvir`. Alimenta el top de conductores sin DVIR (`missing_drivers`). FK `block_id`. |
| **Defect** | `defect` | Defecto reportado en un DVIR: `unit`, `dvir_type` (pre/post-trip), `status`, `detail`, `mechanic` y `mechanic_notes`. FK `block_id`. |
| **TmsDriver** | `tms_driver` | Perfil de despacho/compliance de un conductor (G-TMS): extiende el roster vivo de Samsara con contrato (`role`, `pay_type`, `pay_pct`), equipo asignado (`truck`/`trailer`), vencimientos (`cdl_exp`/`med_exp`/`mvr_exp`/`chouse_exp`) y contacto de emergencia. **PII, solo SQLite local, gitignored**. PK = `name` normalizado del roster. |
| **AlertEvent** | `alert_event` | Evento de alerta de flota (G3): `rule` ∈ speeding/idle/low_fuel/low_def/no_gps/reefer_temp. Lo genera el loop de `core/alerts.py`. `acked` = reconocido. |
| **UnitDoc** | `unit_doc` | Documento adjunto de una unidad (H3, pestaña Attachments): copia de PM/DOT, CAB card, registration. `kind`/`filename`/`stored` (ruta relativa). Archivo en `backend/uploads/units/<unit>/`. |
| **Poi** | `poi` | Punto de interés del Live Map (talleres/dealers/básculas). Datos **públicos** (OSM/DOT, atribución ODbL), **NO aislados por tenant** (PK = `id` global de OSM; una copia por org colisionaría). `kind`: repair/dealer_truck/dealer_trailer/scale; `subtype`: `enforcement` para básculas DOT. Sembrado desde `backend/data/pois_seed.json`. |

---

## 2. Términos de negocio de flota

| Término | Definición (cómo lo usa Fleet Tracker) |
|---|---|
| **DVIR** | Driver Vehicle Inspection Report — inspección pre/post-viaje obligatoria del conductor. Producto base: genera reportes diarios por empresa y mide "NO DVIR", "unsafe" y `fleet_safe_pct` (modelo `ReportBlock`). |
| **PM** | Preventive Maintenance — servicio preventivo ("Full Wet Service"). Tablero con intervalo en millas; el nombre del PM varía por motor (DD13/DD15 Freightliner, ISX International). |
| **DOT** | Department of Transportation. En la app: inspección anual federal (uno de los dos tableros gemelos junto con PM). También "básculas DOT" (POIs `subtype = enforcement`). |
| **reefer** | Refrigerated trailer (tráiler refrigerado). |
| **cold chain** | Cadena de frío: monitoreo de temperatura del reefer. Fuente por prioridad: **Lynx (OEM Carrier) → Thermo King → Traccar (aftermarket) → demo**. Control two-way (setpoint/mode/defrost/power) según tier OEM. Temperaturas en °F; alarmas con `severity` 1/2/3. |
| **work order / WO** | Orden de trabajo del taller. Ver entidad `WorkOrder`. |
| **PO** | Purchase Order — orden de compra de partes a un vendor. Ver `PurchaseOrder`. |
| **QuickBuy** | Crear una PO con sus líneas de una sola vez (Increment B). |
| **estimate / invoice** | Un WO imprimible: **estimate** antes de facturar; **invoice** tras pasar a `invoiced` (asigna `invoice_number` del contador de `org_config`). Se envía por email/SMS. |
| **unit** | Unidad de flota (truck/trailer/chassis). Identificada por su número (`unit`). Ver entidad `Unit`. |
| **campaign / campaña** | Tipo de servicio recurrente por unidad (`CAMPAIGNS`: pm/dot/kingpins/dpf/clutch). `due`: miles/days/none. Al facturar un WO con campaña se registra un `MaintRecord`. |
| **company / carrier** | Transportista (CHASER/MCC...). Vive **dentro** de una `Organization`; el campo `company` está en casi todas las tablas de negocio. |
| **terminal** | Agrupación geográfica de unidades por prefijos o asignación manual (Settings → Terminals). En `Unit`, el campo `terminal` es la key (ex-`nickname`). |
| **team** | Grupo explícito de unidades + conductores (sin prefijos; solo por asignación manual). |
| **roster** | Lista viva camión→conductor (de Samsara). `TmsDriver` lo extiende con datos de despacho. |
| **fleet_safe_pct** | % de la flota SAFE (sin defectos unsafe) en un bloque DVIR; KPI central del producto. |
| **kingpins / DPF / clutch** | Campañas de mantenimiento específicas (kingpins de tráiler, Diesel Particulate Filter, embrague), miembros de `CAMPAIGNS` junto con pm/dot. |

---

## 3. Siglas

| Sigla | Significado | Contexto en el código |
|---|---|---|
| **DVIR** | Driver Vehicle Inspection Report | Producto base; `ReportBlock`/`Defect`/`BlockDriver`. |
| **PM** | Preventive Maintenance | Campaña `pm`; tablero gemelo con DOT. |
| **DOT** | Department of Transportation | Campaña `dot`; básculas POI `enforcement`. |
| **WO** | Work Order | `WorkOrder`; `core/workorders.py`. |
| **PO** | Purchase Order | `PurchaseOrder`; `core/purchasing.py`. |
| **ELD** | Electronic Logging Device | Fuente de datos de flota/HOS/DVIR; Samsara (principal), Motive y otros vía `core/providers/`. |
| **HOS** | Hours of Service | Duty status del conductor en el Live Map (driving/onDuty/sleeperBed/offDuty/yardMove/personalConveyance). |
| **TMS** | Transportation Management System | `TmsDriver` (perfil de despacho); **el TMS completo fue DESCARTADO** como dirección de producto (ver DECISIONES.md). |
| **RBAC** | Role-Based Access Control | `core/permissions.py`: roles → scopes. |
| **PII** | Personally Identifiable Information | Contactos de conductores; scope `pii.view`; `TmsDriver` gitignored. |
| **RLS** | Row-Level Security | Aislamiento a nivel base en Postgres; **pendiente** (fase 3c-2, ver ROADMAP-SEGURIDAD.md). |
| **VIN** | Vehicle Identification Number | Decodificado vía vPIC/NHTSA en "Smart Fill" (`/api/vin/{vin}`). |
| **vPIC / NHTSA** | API de NHTSA para decodificar VIN | Year/Make/Model al alta de unidades. |
| **CDL / MVR** | Commercial Driver's License / Motor Vehicle Record | Vencimientos en `TmsDriver` (`cdl_exp`, `mvr_exp`). |
| **DEF** | Diesel Exhaust Fluid | Alerta `low_def` en `AlertEvent`. |
| **DPF** | Diesel Particulate Filter | Campaña `dpf`. |
| **OSM / ODbL** | OpenStreetMap / Open Database License | Fuente y licencia de los `Poi` del Live Map. |
| **SPA** | Single Page Application | El frontend React servido por el backend con fallback a `index.html`. |
| **HMAC** | Hash-based Message Authentication Code | Firma de tokens (HMAC-SHA256) en `core/auth.py`. |

---

## 4. Conceptos técnicos propios del proyecto

| Concepto | Definición |
|---|---|
| **OrgScoped + tenant** | Multi-tenancy (H6 fase 3). `core/tenant.py` mantiene el `org_id` del request en un `ContextVar`; el middleware (`main.py`) lo deja en `request.state.org_id` y la dependencia global `bind_tenant` lo copia al ContextVar **dentro** del endpoint (donde corren las queries) y lo limpia al terminar. Si no hay tenant en contexto (jobs, seeding, arranque), `get_current_org()` devuelve `None` y no se completa ni filtra. |
| **Eventos de aislamiento ORM** | Dos listeners en `db.py`: `_assign_org_on_insert` (`before_flush`, `db.py:474`) autocompleta `org_id` en filas nuevas `OrgScoped`; `_scope_select_to_org` (`do_orm_execute`, `db.py:486`) filtra los SELECT con `with_loader_criteria(OrgScoped, ...)`, **excluyendo** `is_column_load` e `is_relationship_load`. **Importante:** `session.get()` emite un SELECT que SÍ pasa por este filtro (es la base del aislamiento de lectura); los `update()`/`delete()` Core **NO se filtran** (agujero de escritura cross-tenant, ver AUDITORIA.md H1). |
| **RBAC / scopes** | `core/permissions.py`: 8 SCOPES de escritura (`settings.manage`, `pii.view`, `maint.edit`, `wo.invoice`, `notices.send`, `tms.edit`, `fleet.edit`, `alerts.manage`) y la matriz `ROLE_SCOPES`. `admin` tiene todos (resuelto aparte en `has_scope`); `viewer` ninguno; **GET nunca exige scope**. Enforcement en el middleware (`_scope_for(method, path)` por prefijo de path) y, para casos dependientes del body (facturar un WO), en la propia ruta con `require_scope`. |
| **Roles (5)** | admin · dispatcher · safety · mechanic · viewer (`core/auth.ROLES`). `safety` = cumplimiento (DVIR/PM/DOT, avisos, PII) pero **no factura ni hace dispatch**; `mechanic` = solo mantenimiento + flota. |
| **tokens / auth** | `core/auth.py`: tokens **stateless** firmados HMAC-SHA256, payload `user_id.expiry_epoch` codificado base64url → `f"{b64}.{sig}"`. TTL **30 días**. Reiniciar el server NO invalida sesiones; rotar el secreto sí. Contraseñas pbkdf2-sha256 (200k iters). Login con coste fijo ante usuario inexistente (timing uniforme). |
| **SecretStore / FLEET_SECRETS_DIR** | `core/secretstore.py`: abstracción de secretos (firma de tokens, tokens de Samsara/Google, api_keys de LLM). NO van a la DB ni al repo. Backend `FileSecretStore` guarda un blob JSON por `<base>/<name>.local.json` (gitignored). `FLEET_SECRETS_DIR` apunta a un volumen montado en contenedores (default = `config.BACKEND_DIR`). Backend elegido por env `SECRETS_BACKEND` (hoy solo `file`). El montaje **debe ser read-write**: la app autogenera `auth_secret` en el primer uso (bug corregido v1.28.4, ver ERRORES-CONOCIDOS.md). |
| **docscan** | `core/docscan.py` (~60KB): escáner AI de invoices/estimates (PDF/foto) → JSON estructurado (Pydantic, **nunca** texto libre). Proveedores: `ollama` (local, gratis), `textract` (AWS), `anthropic` (Claude), `groq` (Llama 4 Scout, ~30× más rápido), `auto`. PDFs digitales: primero capa de texto (pypdf); escaneos: render a PNG (pypdfium2) → visión. Config por env `DOCSCAN_PROVIDER` + `docscan.local.json` en `FLEET_SECRETS_DIR`. |
| **`*.local.json`** | Convención de archivos de config/secretos locales **gitignored** (`secret.local.json`, `docscan.local.json`, `units.local.json`, `pm.local.csv`...). Migrados gradualmente a `OrgSetting` (config) y `SecretStore` (secretos). `get_setting()` importa el legacy *una vez* a la org `'default'`. |
| **`_migrate()` vs Alembic** | Dos caminos de migración. **SQLite dev**: `_migrate()` (`db.py:573`) con `PRAGMA table_info` + `ALTER TABLE` aditivos idempotentes (incluye backfill de `org_id` a `'default'`). **Postgres prod**: Alembic (`alembic upgrade head`), hoy **a la deriva** — la única migración crea 16 tablas y el modelo define 23; en la práctica `create_all` cubre el gap en base fresca pero NO altera tablas con datos. `FLEET_SKIP_DB_INIT` evita tocar la base al correr Alembic. Ver ARQUITECTURA.md §5 y AUDITORIA.md. |
| **`init_schema()` / import-time init** | `db.py:652` corre `Base.metadata.create_all` + `ensure_default_org()` (+ `_migrate()` solo en SQLite) **al importar el módulo `db`**, salvo que `FLEET_SKIP_DB_INIT` esté seteada. Por eso importar `db` tiene efectos secundarios. |
| **idempotencia de hooks** | Al facturar un WO se disparan hooks (consumir inventario, registrar PM/campaña — todo en `workorders.update_wo`). Pretenden ser idempotentes: inventario por el guard `(reason, ref_type, ref_id)`; campaña por buscar `"WO #id:"` en notas. **Advertencia:** sin UniqueConstraint a nivel DB, el guard de inventario es vulnerable a doble click / concurrencia (AUDITORIA.md H4). |
| **multi-unit WO (#4 / #4.1)** | Un invoice que cubre varias unidades = una orden PADRE + N HIJAS (`parent_id`/`child_seq`), `_display_no` = `"4"` o `"4.1"`. Cada una con sus líneas (suma = total del invoice); la misma factura adjunta en todas; borrar el padre borra las hijas (cascade). `child_seq` se calcula por `max()+1` sin lock — race conocido (AUDITORIA.md H5). |
| **DATABASE_URL / POSTGRES_*** | `config.py` resuelve la base por prioridad: `DATABASE_URL` explícita → componentes `POSTGRES_*` (armados con `sqlalchemy.URL.create`, que codifica `@`/`:`/`/` en la clave — fix v1.28.2) → SQLite local. `IS_SQLITE` decide migraciones y `connect_args` (`check_same_thread=False` solo en SQLite). |
| **SecretStore vs OrgSetting** | Distinción clave: **secretos** (api_keys, tokens, firma) → `SecretStore` (`*.local.json` o secrets manager). **Config no-secreta** (branding, alertas, contadores) → `OrgSetting` (DB, por tenant). No mezclar. |
| **`_jobs` / `_batches` (stores en memoria)** | Dicts en memoria del proceso en `api/routes.py` para Excel generados y sesiones de lote. **No sobreviven a restart ni escalan a múltiples réplicas** → deploy single-replica obligado (ver ARQUITECTURA.md §5). |
| **providers (framework ELD)** | `core/providers/`: `TelematicsProvider` (ABC) + `registry()` autodescriptivo + provider activo (`samsara_provider.py`, `motive_provider.py`). Marco para adaptadores ELD intercambiables. |
| **fases (G/H/Increment)** | Etiquetas de roadmap embebidas como trazabilidad en código y CHANGELOG: G1 Live Map, G3 alertas, G4 reefers, G5 work orders, G7 auth, G-TMS roster; H1 tableros PM/DOT, H2 pipeline WO, H2.5 docscan, H3 catálogo partes/vendors/perfil unidad, H4 RBAC, H6 multi-tenant (3a/3b/3c/3d); Increment A Reports, B QuickBuy/Smart Fill, Inventory. Ver FLUJO-DE-TRABAJO.md. |
| **deploy** | Dockerfile multi-stage (Node build del frontend → backend Python sirve `dist` + uvicorn en un único contenedor), `docker-compose.yml` (app + Postgres 16 + volúmenes), Dokploy/VPS (Hostinger) detrás de Traefik. **LIVE en producción**. |

---

Documentos hermanos: ARQUITECTURA.md · CONVENCIONES.md · DECISIONES.md · FLUJO-DE-TRABAJO.md · ERRORES-CONOCIDOS.md · ROADMAP-SEGURIDAD.md · AUDITORIA.md
