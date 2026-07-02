# Feature: DVIR form-builder + app nativa del conductor

## 1. Qué es y por qué importa

El DVIR es nuestra cancha histórica: Fleet Tracker nació parseando los exports de Samsara ("Pre-trip & Post-trip", "Driver Vehicle Inspection Reports - defects"), agregando cumplimiento por conductor y produciendo un tablero de defectos que se convierten en work orders. Pero hoy **dependemos de que la inspección la capture Samsara** y de exports CSV que llegan a mano (`core/pretrip.py`, `core/open_defects.py`). No tenemos ni el formulario ni la app donde el conductor hace la inspección. Whip Around sí, y nos gana justo acá.

Este feature cierra el gap con tres piezas que trabajan juntas:

1. **Form-builder de inspecciones** — el fleet manager arma sus propias plantillas (secciones, ítems, tipos de campo) o parte de una librería regulatoria precargada (DOT §396.11/§396.13, OSHA, NFPA, EPA, NHTSA).
2. **Motor de inspección + defectos** — cada envío del conductor genera una `Inspection` con resultados por ítem; un ítem que falla genera un `Defect` con severidad, y esa severidad dispara el **workflow OOS (out-of-service)** y el auto-ruteo a work order.
3. **App nativa del conductor** — donde se llena la inspección: captura de foto por ítem, OCR del odómetro, voz-a-texto para notas, e-firma, escaneo de barcode/QR del asset y, lo más difícil, **modo offline** con cola de sync.

Por qué importa comercialmente: deja de vender "leemos tu Samsara" y pasa a "somos el sistema de inspección **y** el de mantenimiento, en un solo lugar". El defecto ya no viaja por CSV; nace estructurado, con foto y GPS, y cae directo en la cola del taller. Es el eslabón que nos falta para reemplazar a Fullbay (mantenimiento) **y** a Whip Around (inspección) a la vez. Prioridad 🔴: es la única categoría donde un competidor nos supera en nuestra propia fortaleza.

## 2. Referencia competitiva

**Whip Around (flagship, el que hay que igualar).** Su núcleo es el **constructor de formularios custom**: librería de plantillas + build-from-scratch, con plantillas regulatorias multi-framework (DOT/OSHA/NFPA/EPA/NHTSA). Su **app nativa del conductor** trae: **OCR del odómetro** (el conductor fotografía el tablero y la app lee el millaje), **voz-a-texto** para notas de defecto, **foto obligatoria** por ítem, **e-firma**, **modo OFFLINE** (se puede enviar sin señal y sincroniza después) y **barcode/QR** del asset para identificarlo. Vende cumplimiento con especificidad: cita **49 CFR §§396.11 y 396.13**. En el teardown (cap 02, §2.4) figura explícitamente como el gap "en nuestra cancha".

**Motive.** Formularios DVIR customizables y "Driver Walkthroughs" guiados. Su aporte diferencial es el **workflow OOS por severidad**: un defecto marca el vehículo fuera de servicio, los menores se pueden **diferir**, y el sistema **bloquea que se asigne el conductor a un vehículo OOS**. Ese gate de asignación es la pieza que le da dientes al DVIR.

**RTA.** Plantillas de inspección customizables con una regla simple y poderosa: **inspección fallida → auto-ruteo a la cola de work order**. Es exactamente el puente defecto→WO que ya tenemos a medias (conversión manual) y que acá automatizamos.

Nuestra ventaja al construirlo: ya tenemos el back del taller (WorkOrder, líneas, invoice, campañas PM/DOT), el tablero de defectos y el modelo multi-tenant. Whip Around tiene la captura pero no tiene mantenimiento nativo, ni AI de facturas, ni live map (cap 02, §2.4). Si cerramos captura, los pasamos.

## 3. Modelo de datos (SQLAlchemy; nota migración Alembic)

Todos los modelos nuevos heredan de `OrgScoped` (mixin de `db.py`) para el aislamiento multi-tenant automático (los listeners `before_flush` / `do_orm_execute` completan y filtran por `org_id`). Se agrega un archivo `backend/app/core/inspections.py` para la lógica y se extienden los modelos en `db.py`.

```python
class InspectionTemplate(OrgScoped, Base):
    """Plantilla del form-builder. Una org arma varias (pre-trip camión,
    post-trip, anual DOT, reefer, etc.). Las regulatorias se siembran como
    plantillas de sistema (is_system=True, no editables; se clonan para editar)."""
    __tablename__ = "inspection_template"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    asset_type: Mapped[str] = mapped_column(String(16), default="truck")  # truck|trailer|reefer|any
    framework: Mapped[str] = mapped_column(String(16), default="")        # dot|osha|nfpa|epa|nhtsa|custom
    regulation_ref: Mapped[str] = mapped_column(String(40), default="")   # p.ej. "49 CFR 396.11"
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)       # precargada, read-only
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    version: Mapped[int] = mapped_column(Integer, default=1)              # snapshot al publicar
    created_at: Mapped[datetime] = mapped_column(DateTime)
    sections: Mapped[list["InspectionSection"]] = relationship(
        back_populates="template", cascade="all, delete-orphan",
        order_by="InspectionSection.order_idx")


class InspectionSection(OrgScoped, Base):
    """Sección de la plantilla (p.ej. 'Cabina', 'Frenos', 'Luces')."""
    __tablename__ = "inspection_section"
    id: Mapped[int] = mapped_column(primary_key=True)
    template_id: Mapped[int] = mapped_column(ForeignKey("inspection_template.id"))
    name: Mapped[str] = mapped_column(String(120))
    order_idx: Mapped[int] = mapped_column(Integer, default=0)
    template: Mapped[InspectionTemplate] = relationship(back_populates="sections")
    items: Mapped[list["InspectionItem"]] = relationship(
        back_populates="section", cascade="all, delete-orphan",
        order_by="InspectionItem.order_idx")


class InspectionItem(OrgScoped, Base):
    """Ítem inspeccionable. field_type define el control en la app.
       field_type: pass_fail | photo | numeric | text | signature
       severity: menor|mayor|critico -> gobierna el workflow OOS al fallar."""
    __tablename__ = "inspection_item"
    id: Mapped[int] = mapped_column(primary_key=True)
    section_id: Mapped[int] = mapped_column(ForeignKey("inspection_section.id"))
    label: Mapped[str] = mapped_column(String(160))
    field_type: Mapped[str] = mapped_column(String(16), default="pass_fail")
    order_idx: Mapped[int] = mapped_column(Integer, default=0)
    photo_required: Mapped[bool] = mapped_column(Boolean, default=False)  # foto SIEMPRE
    photo_on_fail: Mapped[bool] = mapped_column(Boolean, default=True)    # foto solo si falla
    severity: Mapped[str] = mapped_column(String(8), default="mayor")     # menor|mayor|critico
    unit_label: Mapped[str] = mapped_column(String(20), default="")       # 'psi', '32nds' (numeric)
    section: Mapped[InspectionSection] = relationship(back_populates="items")


class Inspection(OrgScoped, Base):
    """Una inspección ENVIADA por un conductor sobre un asset, en un momento.
       Es el equivalente estructurado del bloque DVIR que hoy viene de CSV."""
    __tablename__ = "inspection"
    id: Mapped[int] = mapped_column(primary_key=True)
    template_id: Mapped[int] = mapped_column(ForeignKey("inspection_template.id"))
    template_version: Mapped[int] = mapped_column(Integer, default=1)     # congela la versión usada
    unit: Mapped[str] = mapped_column(String(64), index=True)             # nº de unidad (como WorkOrder)
    company: Mapped[str] = mapped_column(String(64), default="")
    driver: Mapped[str] = mapped_column(String(128), default="")
    kind: Mapped[str] = mapped_column(String(12), default="pre_trip")     # pre_trip|post_trip|dot|adhoc
    odometer: Mapped[int | None] = mapped_column(Integer, nullable=True)  # leído por OCR o a mano
    result: Mapped[str] = mapped_column(String(12), default="pass")       # pass|fail
    signature_media: Mapped[str] = mapped_column(String(200), default="") # ruta de la e-firma
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    submitted_at: Mapped[datetime] = mapped_column(DateTime)              # llegó al server
    client_uuid: Mapped[str] = mapped_column(String(40), default="", index=True)  # dedup offline
    __table_args__ = (
        UniqueConstraint("org_id", "client_uuid", name="uq_inspection_client_uuid"),
    )
    results: Mapped[list["InspectionResult"]] = relationship(
        back_populates="inspection", cascade="all, delete-orphan")


class InspectionResult(OrgScoped, Base):
    """Resultado de UN ítem dentro de una inspección. Guarda el valor crudo
       según field_type y la(s) foto(s)."""
    __tablename__ = "inspection_result"
    id: Mapped[int] = mapped_column(primary_key=True)
    inspection_id: Mapped[int] = mapped_column(ForeignKey("inspection.id"))
    item_label: Mapped[str] = mapped_column(String(160))   # copia del label (histórico)
    field_type: Mapped[str] = mapped_column(String(16), default="pass_fail")
    passed: Mapped[bool | None] = mapped_column(Boolean, nullable=True)  # pass_fail
    numeric_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    text_value: Mapped[str] = mapped_column(Text, default="")            # nota (voz-a-texto va acá)
    photo_media: Mapped[str] = mapped_column(String(200), default="")    # ruta(s), CSV si varias
    severity: Mapped[str] = mapped_column(String(8), default="mayor")    # copiada del ítem al fallar
    inspection: Mapped[Inspection] = relationship(back_populates="results")
```

**Reuso del `Defect` existente.** No creamos un modelo paralelo: extendemos el `Defect` actual (que hoy nace de `db.save_block` y de `open_defects.load`). Le agregamos `inspection_id` (FK nullable), `severity` (menor|mayor|critico), `wo_id` (FK a la WO generada) y `source` (samsara|inspection|manual). Así el `DefectsPage` sigue funcionando con las dos fuentes durante la transición, y la conversión a WO se registra en el propio defecto.

**Fotos/firma.** Los archivos no van en la BD. Reusamos el patrón de `UnitDoc` (archivo en `backend/uploads/...`, ruta relativa en la columna). Sugerido `backend/uploads/inspections/<inspection_id>/<result_id>.jpg` y la e-firma como PNG.

**Nota de migración Alembic.** Estas seis tablas + las cuatro columnas de `Defect` son un cambio de esquema real, no aditivo-trivial: **va por Alembic** (`alembic revision --autogenerate -m "inspection form-builder"` y luego `alembic upgrade head`). En dev SQLite, `init_schema()` las crea vía `create_all` (tablas faltantes) pero **NO** agrega las columnas nuevas a `defect`, que ya existe; por eso hay que sumar los `ALTER TABLE` correspondientes al bloque `_migrate()` de `db.py` (mismo patrón que ya usa para `work_order`). En Postgres prod, el esquema lo maneja Alembic; hay que acordarse de agregar estas tablas al `for table in (...)` del backfill de `org_id` de `_migrate` si alguna base dev vieja llega sin la columna.

## 4. Backend (core + endpoints; reglas)

Lógica nueva en `core/inspections.py` (form-builder + submit + workflow OOS). Endpoints en `api/routes.py`, auth por cookie + RBAC ya existente (roles admin/dispatcher/mechanic/viewer).

**Form-builder (admin/dispatcher).**
- `create_template(name, asset_type, framework)` / `update_template` / `publish_template` (incrementa `version`, congela el snapshot). Editar una plantilla publicada sube versión; las inspecciones viejas conservan su `template_version`.
- `clone_template(id)` — clonar una plantilla de sistema (`is_system=True`) para poder editarla. Las de sistema no se editan ni borran.
- CRUD de secciones/ítems con `order_idx` para el drag-and-drop.
- `seed_regulatory_templates()` — idempotente, corre al iniciar (como `ensure_default_org`). Siembra las plantillas DOT §396.11 (pre/post-trip), inspección anual DOT §396.17, y stubs OSHA/NFPA/EPA/NHTSA marcadas `is_system`.

**Submit de inspección (driver, o token de dispositivo).**
- `submit_inspection(payload)` — recibe la inspección completa (cabecera + resultados + medios ya subidos). **Idempotente por `client_uuid`**: si llega dos veces (reintento de la cola offline), la segunda es no-op y devuelve la existente. Es el guard que hace seguro el modo offline; espeja la lógica de idempotencia que ya usamos en `core/inventory.adjust`.
- Valida contra el snapshot de la plantilla: si un ítem tiene `photo_required` o `photo_on_fail` y falló sin foto, se rechaza (422) — salvo bandera de override del admin.
- Calcula `result` global: fail si **algún** ítem falló.
- Por cada ítem fallado, crea un `Defect` (severidad copiada del ítem, `source="inspection"`, `inspection_id` seteado).

**Workflow OOS por severidad (el core del valor).** Al procesar los defectos de un submit:
- `critico` → el asset queda **OOS**: se setea un flag de out-of-service en el perfil de la unidad (nueva columna `oos_since` en `Unit`, o un `OrgSetting` por unidad si el asset es Samsara-only). Se crea una WO `priority="high"` automáticamente (ver abajo). Motive es la referencia: bloquea la asignación.
- `mayor` → defecto abierto en el tablero + WO `priority="normal"`. No pone OOS por sí solo.
- `menor` → defecto **diferible**: entra al tablero como `status="deferred"`, no genera WO ni OOS. Un mayor/admin puede diferir un `mayor` también, con motivo y fecha límite (campos `deferred_reason`, `deferred_until` en `Defect`).
- **Gate de asignación (Motive-style):** cuando el dispatcher intenta asignar un conductor/viaje a una unidad con `oos_since` no nulo, el endpoint responde 409 con el defecto crítico que lo bloquea. Levantar el OOS exige cerrar la WO asociada (o un override explícito de admin, que queda auditado).

**Defecto → work order (RTA-style, automatizable).**
- `defect_to_wo(defect_id)` reusa `core/workorders.create_wo(...)` con `source="inspection"` (el modelo ya soporta `source`, ver `create_wo`, línea 193). El `title` se arma del ítem + unidad ("Frenos - CI2037"), el `complaint` con la nota de voz-a-texto, y `priority` según severidad. Guarda `wo_id` de vuelta en el `Defect` para trazabilidad.
- Para `critico` esto pasa **automático** en el submit; para `mayor` puede ser auto o botón "Crear WO" en el tablero (config por org). Esto reemplaza la conversión manual de hoy.

**Endpoints (bosquejo):**
```
GET    /api/inspection-templates                # lista (sistema + de la org)
POST   /api/inspection-templates                # crear (admin/dispatcher)
POST   /api/inspection-templates/{id}/clone     # clonar una de sistema
PUT    /api/inspection-templates/{id}           # editar -> sube versión
POST   /api/inspections                         # submit del conductor (idempotente)
POST   /api/inspections/media                   # subir foto/firma -> devuelve ruta
GET    /api/inspections?unit=&result=&driver=   # tablero (reusa filtros de list_defects)
POST   /api/defects/{id}/to-wo                  # defecto -> work order
POST   /api/units/{unit}/oos/clear              # levantar OOS (admin, auditado)
GET    /api/inspection-templates/regulatory     # librería precargada
```
RBAC: builder y OOS-clear son admin/dispatcher; submit es driver; el tablero es viewer+.

## 5. UI (React; dónde encaja; estados vacío/carga/error)

Front React + Vite + TS. Encaja alrededor de los `DvirPage` y `DefectsPage` ya existentes.

- **Template Builder** (nueva ruta `/inspections/templates`, admin/dispatcher). Panel de dos columnas: árbol de secciones/ítems a la izquierda (drag-and-drop con `order_idx`), editor del ítem a la derecha (tipo de campo, foto obligatoria/al-fallar, severidad, unidad numérica). Botón "Empezar de una plantilla" abre la **librería regulatoria** (cards DOT/OSHA/NFPA/EPA/NHTSA con el `regulation_ref` visible, como cita Whip Around). "Publicar" sube versión.
  - *Vacío:* "Todavía no tenés plantillas. Empezá de la librería DOT o creá una desde cero." con dos CTAs.
  - *Carga:* skeleton del árbol.
  - *Error:* banner con reintento; el borrador no publicado se conserva en local para no perder el trabajo.

- **DvirPage (existente) → tab "Inspecciones".** Hoy muestra los bloques que vienen de CSV; se le suma la fuente `inspection` (nativa). Cada fila enlaza al detalle con las fotos por ítem, el odómetro, GPS y la e-firma. Un badge distingue origen Samsara vs nativo durante la transición.

- **DefectsPage (existente).** Ya lista defectos con filtros (company/status/unit). Se le agrega: columna **severidad** (menor/mayor/crítico con color), badge **OOS** en la unidad, acción "Crear WO" (si no es automático) y "Diferir" (con motivo + fecha). Un defecto ya convertido muestra link a su WO (`wo_id`).
  - *Vacío:* "Sin defectos abiertos. La flota está limpia." (mantener el tono positivo del tablero actual).
  - *Carga/Error:* spinner y banner con reintento, consistente con el resto de la app.

- **App del conductor (ver §6/§8 para el approach).** Pantallas: seleccionar/escanear asset (barcode/QR) → foto del odómetro (OCR con confirmación manual) → recorrer secciones/ítems (pass/fail con un toque, foto cuando obligatoria, botón de micrófono para voz-a-texto en la nota) → firma → enviar. Indicador claro de **"pendiente de sincronizar"** cuando se envió offline, con contador de cola.

## 6. Automatizaciones (cap 04)

Toda regla se expresa como evento → condición → acción sobre el motor del capítulo 04, con el modelo canónico como fuente. Eventos que emite este feature:

- `inspection.submitted` — al procesar un submit (después de la idempotencia).
- `inspection.failed` — el `result` global fue fail.
- `defect.created` (con `severity`) — por cada ítem fallado.
- `asset.oos.set` / `asset.oos.cleared` — transiciones del flag OOS.

Reglas de fábrica (activables por org):
- **defecto crítico → OOS + WO high + notificar** (mail/SMS/Telegram vía `core/notify_service`, reusando el ruteo por región/terminal de `core/cc_routing.py`).
- **inspección fallida → auto-WO** (RTA-style), con severidad→prioridad.
- **conductor sin inspección hoy → aviso "NO DVIR"** — reusa exactamente la mecánica de missing-drivers que ya existe (`db.missing_drivers`), pero ahora alimentada por inspecciones nativas en vez de CSV.
- **OOS levantado sin WO cerrada → alerta al admin** (control anti-bypass).
- **defecto crítico abierto > N horas → escalar** (recordatorio al taller).

## 7. Integraciones que toca

- **Samsara / providers ELD (`core/providers/`, `core/samsara.py`).** Coexistencia, no reemplazo: seguimos ingiriendo DVIR de Samsara para las flotas que ya lo usan (wedge "nos montamos encima de tu ELD", cap 02). Un defecto Samsara y uno nativo caen en el mismo tablero (`source` los distingue). A futuro, los **fault codes (DTC)** del ELD pueden disparar inspecciones o defectos (gap listado en cap 02, §2.4).
- **Work orders (`core/workorders.py`).** Consumidor principal: `create_wo(source="inspection")` ya soportado. La WO generada arrastra unidad, complaint y prioridad.
- **Units (`db.Unit` + trackers PM/DOT).** El odómetro leído por OCR puede alimentar el `MaintRecord`/PM tracker (millaje real desde el piso). El flag OOS vive en la unidad.
- **Notificaciones (`core/notify_service`, `sms_service`, `telegram_notify`, `mailer`).** Avisos de OOS, fallas críticas y NO DVIR.
- **Media host (`core/media_host.py` / patrón `UnitDoc`).** Almacenamiento de fotos y firmas.
- **Auth/RBAC (`core/auth.py`, `permissions.py`).** El conductor necesita un rol/credencial de dispositivo; hoy los roles son admin/dispatcher/mechanic/viewer, falta un `driver` (o token de dispositivo de alcance acotado).

## 8. Esfuerzo (S/M/L) · prioridad · dependencias

Prioridad global: 🔴. Desglose honesto por pieza:

- **Modelo + form-builder backend + endpoints:** **M**. Es CRUD con versionado y seeds regulatorios; nada exótico, encaja limpio en el patrón `OrgScoped` + Alembic.
- **Motor de inspección + workflow OOS + defecto→WO:** **M**. La conversión a WO ya existe a medias; lo nuevo es el estado OOS, el gate de asignación y la severidad. Requiere el rol `driver`.
- **Template Builder UI (React):** **M**. Drag-and-drop y editor de ítems; trabajo de front real pero acotado.
- **App nativa del conductor:** **L. Es el grueso y no hay que subestimarlo.**

**Approach de la app móvil (decisión honesta).** Recomendación: **PWA offline-first**, no React Native, para la v1.
- *Por qué PWA:* reusa React/Vite/TS que ya tenemos, un solo codebase, sin fricción de App Store / Play Store, deploy instantáneo (crítico con nuestro flujo Dokploy autodeploy). Cubre lo que Whip Around vende: cámara (`getUserMedia`/`<input capture>`), micrófono para voz-a-texto (Web Speech API con fallback a Whisper), geolocalización, e-firma en `<canvas>`.
- *Offline:* **service worker** (Workbox) para cachear el shell y las plantillas; **IndexedDB** para la cola de submits pendientes y sus medios (blobs); **Background Sync API** para drenar la cola al recuperar señal, con reintento y el guard de idempotencia por `client_uuid` del §4. Este es el trabajo más delicado y donde se va la mayor parte de la L.
- *OCR del odómetro:* empezar con **tesseract.js** en el dispositivo (sin costo por request, offline-friendly), acotado a dígitos y con **confirmación manual obligatoria** del número leído (nunca confiar ciego). Si la precisión en campo no alcanza, pasar a una API de OCR server-side como fallback online. No prometer OCR mágico: el humano confirma.
- *Voz-a-texto:* Web Speech API donde el browser la soporte; fallback a subir el audio y transcribir server-side (ya tenemos Groq disponible en el stack para esto). Guardar el texto en `InspectionResult.text_value`.
- *Barcode/QR:* `BarcodeDetector` API nativo donde exista, con fallback a una librería JS (`zxing`/`html5-qrcode`).
- *Límites honestos de PWA:* iOS restringe Background Sync y notificaciones push; en iOS puede requerir que el conductor abra la app para drenar la cola. Si un cliente grande lo exige, una envoltura **Capacitor** sobre la misma PWA da APIs nativas sin reescribir. **React Native queda para v2** solo si el mercado lo pide; no es necesario para igualar a Whip Around en la v1.

**Dependencias:**
- Rol `driver` / token de dispositivo en auth+RBAC (bloqueante del submit).
- Media host para fotos/firmas (patrón `UnitDoc` ya existe; formalizar).
- Motor de automatizaciones del cap 04 (para OOS/notify/auto-WO declarativos; sin él, se cablea a mano en `submit_inspection`).
- Alembic al día en prod (hoy la migración inicial no cubre tablas nuevas; ver §3).

**Secuencia sugerida:** (1) modelo + Alembic + seeds regulatorios → (2) form-builder backend/UI → (3) submit + defecto→WO + OOS → (4) PWA del conductor (la L, en su propio incremento) → (5) automatizaciones cap 04.

## 9. Ejemplo end-to-end con datos realistas

Contexto: CHASER Freight, conductor **Marcus Bell**, tractor **CI2037**, org `default`.

1. **Setup (una vez).** El fleet manager entra a `/inspections/templates`, clona la plantilla de sistema **"DOT Pre-Trip (49 CFR §396.11)"** (`is_system=True`) y la ajusta: en la sección "Frenos" marca el ítem *"Air brake / low pressure warning"* como `severity="critico"` y `photo_on_fail=True`; agrega un ítem numérico *"Tread depth - steer"* con `unit_label="32nds"`. Publica → `version=2`.

2. **En el piso, 05:40, sin señal en el yard.** Marcus abre la PWA, escanea el QR de **CI2037**, fotografía el tablero → OCR lee **418,​205 mi**, él confirma. Recorre los ítems: casi todo pass con un toque; en *"Air brake / low pressure warning"* marca **fail**, la app **exige foto** (la saca) y dicta por voz *"warning light stays on at idle, buzzer intermitente"* → voz-a-texto lo escribe. Firma en el canvas y toca **Enviar**. Sin señal: queda **"1 pendiente de sincronizar"** en IndexedDB con `client_uuid=a3f9...`.

3. **06:02, recupera señal.** El Background Sync drena la cola. `POST /api/inspections` con `client_uuid=a3f9...`. El server valida contra el snapshot v2, sube la foto a `uploads/inspections/8821/...jpg` y la firma, crea `Inspection(unit="CI2037", driver="Marcus Bell", odometer=418205, result="fail")` y un `InspectionResult` fallado con severidad `critico`.

4. **Automático.** Como el ítem es `critico`: se crea `Defect(unit="CI2037", severity="critico", source="inspection", detail="Air brake / low pressure warning - warning light stays on at idle...")`; se setea `CI2037.oos_since = now`; se crea la WO vía `create_wo(unit="CI2037", title="Frenos - CI2037", complaint="warning light...", priority="high", source="inspection")`; el `Defect.wo_id` apunta a esa WO. Sale notificación por el canal de la región CHASER (`cc_routing`) a `safety@` y `maintenance@`.

5. **Dispatch, 06:15.** El despachador intenta asignar a Marcus otra corrida en **CI2037**. El endpoint responde **409**: *"CI2037 está OUT OF SERVICE por defecto crítico #8821 (frenos). Cerrá la WO o pedí override de admin."* Le asigna otro tractor.

6. **Taller.** El mecánico ve la WO high con la foto y la nota de voz; repara, factura (`invoiced`). Al cerrar la WO, el defecto pasa a resuelto y `POST /api/units/CI2037/oos/clear` levanta el OOS (queda auditado). CI2037 vuelve a estar asignable. Todo el recorrido —captura offline, defecto estructurado, OOS, WO, cierre— ocurrió sin un solo CSV de Samsara.
