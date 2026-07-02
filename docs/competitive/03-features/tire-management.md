# Feature: Tire Management (gestion de neumaticos)

Prioridad: 🟠

## 1. Que es y por que importa

Los neumaticos son, despues del combustible, la segunda linea de costo variable mas grande de una flota de camiones. Un tractocamion clase 8 con trailer rueda sobre 18 posiciones; un juego completo de tapa nueva cuesta entre 4,000 y 6,000 USD, y cada reencauche (retread) recupera parte de esa inversion a un tercio del costo. La diferencia entre una flota que trackea neumaticos por posicion y una que no lo hace se mide en miles de dolares al ano por unidad: rotaciones a destiempo aceleran el desgaste, un neumatico jubilado antes de tiempo tira plata, y un neumatico corrido de mas es una violacion DOT (profundidad minima legal: 4/32" en eje direccional, 2/32" en el resto).

Hoy Fleet Tracker sabe de work orders, partes e inventario, pero un neumatico cargado como `Part` es anonimo: no sabemos en que rueda esta, cuantas millas lleva, ni cuanto cuesta por milla. Tire Management cierra ese hueco. Convierte al neumatico en un activo serializado con historia propia (install, rotate, retread, remove), lo ubica en un mapa de posiciones por eje, y usa el millaje que ya llega del sync de telematics para calcular **costo por milla por neumatico**, la metrica que ninguna hoja de calculo casera produce bien.

El publico es el shop manager y el owner-operator. El primero quiere saber que rueda rotar esta semana y que casco (casing) todavia sirve para un segundo retread; el segundo quiere saber si la marca X le rinde mas millas por dolar que la marca Y. Ambas preguntas se responden con los mismos datos.

## 2. Referencia competitiva

**SquareRigger** es el estandar de facto en shops de mantenimiento pesado. Su modulo de neumaticos maneja inventario de neumaticos como activos, e installs, rotaciones, retreads y reemplazos como eventos. El diferenciador real es que monitorea desgaste y condicion **por activo Y por posicion de la rueda** (no solo "el camion 214 tiene neumaticos gastados", sino "la posicion LRO del camion 214 esta en 5/32""). Rastrea costo de labor, partes y vendor de cada neumatico para alimentar el **cost-per-mile**, que es como la industria compara marcas y decide compras.

**RTA** tiene un modulo dedicado de tires con las mismas piezas: tracking **por posicion**, el neumatico tratado como item de inventario, y soporte de **barcode** para identificar el casco fisico en el piso del taller sin tipear numeros de serie de 10 digitos.

El patron comun de ambos, y el que copiamos: el neumatico es una entidad de primera clase con serie unica, la posicion es un ciudadano del modelo (no un texto libre), y el costo se acumula a lo largo de la vida del casco (compra + retreads + labor de montaje) para dividirlo entre las millas rodadas. Donde Fleet Tracker puede diferenciarse: el millaje viene solo del sync de telematics (no hay que capturar odometro a mano en cada evento), y el motor de automatizaciones (cap 04) dispara las alertas de rotacion y de tread depth sin que nadie corra un reporte.

## 3. Modelo de datos (SQLAlchemy; relacion con Part/Asset; nota migracion Alembic)

Tres tablas nuevas, todas `OrgScoped` (multi-tenant, se autocompletan y filtran por `org_id` via los eventos de sesion ya existentes en `db.py`). Siguen las convenciones del repo: PK entera autoincremental, `created_at` explicito, texto de negocio en `String` acotado.

```python
class Tire(OrgScoped, Base):
    """Un casco (casing) fisico serializado. Vive a lo largo de multiples
    installs y retreads. `part_number` liga al catalogo Part para inventario
    y compras; `cost_total` acumula compra + retreads + labor de montaje y es
    el numerador del cost-per-mile. `status`: in_stock | mounted | retreading
    | scrapped. `barcode` es el codigo escaneable del casco (RTA-style)."""
    __tablename__ = "tire"
    __table_args__ = (
        UniqueConstraint("org_id", "serial", name="uq_tire_org_serial"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    serial: Mapped[str] = mapped_column(String(40), index=True)   # DOT/serie
    barcode: Mapped[str] = mapped_column(String(40), default="", index=True)
    brand: Mapped[str] = mapped_column(String(60), default="")
    model: Mapped[str] = mapped_column(String(60), default="")
    size: Mapped[str] = mapped_column(String(24), default="")      # 295/75R22.5
    part_number: Mapped[str] = mapped_column(String(60), default="")  # -> Part
    tread_depth: Mapped[float] = mapped_column(Float, default=0.0)  # 32avos
    status: Mapped[str] = mapped_column(String(12), default="in_stock",
                                        index=True)
    condition: Mapped[str] = mapped_column(String(12), default="new")  # new|retread
    cost_total: Mapped[float] = mapped_column(Float, default=0.0)
    retread_count: Mapped[int] = mapped_column(Integer, default=0)
    # cache del ultimo evento install/rotate: donde esta montado ahora
    current_unit: Mapped[str] = mapped_column(String(64), default="", index=True)
    current_position: Mapped[str] = mapped_column(String(6), default="")
    mounted_odometer: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime)


class TirePosition(OrgScoped, Base):
    """Slot fisico de rueda de un Asset segun su config de ejes. Un truck 6x4
    tiene 10 slots (2 direccional + 8 traccion en dual); un trailer tandem
    tiene 8. Se siembra desde una plantilla por `axle_config` cuando se crea
    la unidad. `code` es la nomenclatura estandar del piso: LF, RF (direccional),
    LRO/LRI, RRO/RRI (traccion outer/inner), etc."""
    __tablename__ = "tire_position"
    __table_args__ = (
        UniqueConstraint("org_id", "unit", "code", name="uq_pos_unit_code"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    unit: Mapped[str] = mapped_column(String(64), index=True)  # Unit.unit
    unit_type: Mapped[str] = mapped_column(String(16), default="truck")
    axle: Mapped[int] = mapped_column(Integer, default=1)      # eje 1,2,3...
    code: Mapped[str] = mapped_column(String(6))               # LF, LRO...
    is_steer: Mapped[bool] = mapped_column(Boolean, default=False)


class TireEvent(OrgScoped, Base):
    """Libro auditable de la vida del casco. Espeja el patron de
    PartStockMovement: cada evento es inmutable y lleva su odometro. `kind`:
    install | rotate | retread | remove | scrap. En install/rotate/remove
    lleva unit+position+odometer; en retread lleva costo. El odometro sale
    del sync de telematics al momento del evento (no se tipea a mano)."""
    __tablename__ = "tire_event"

    id: Mapped[int] = mapped_column(primary_key=True)
    tire_id: Mapped[int] = mapped_column(ForeignKey("tire.id"), index=True)
    kind: Mapped[str] = mapped_column(String(10), index=True)
    unit: Mapped[str] = mapped_column(String(64), default="", index=True)
    position: Mapped[str] = mapped_column(String(6), default="")
    odometer: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tread_depth: Mapped[float] = mapped_column(Float, default=0.0)
    cost: Mapped[float] = mapped_column(Float, default=0.0)   # retread/mount
    wo_id: Mapped[int | None] = mapped_column(
        ForeignKey("work_order.id"), nullable=True)   # linea que lo genero
    note: Mapped[str] = mapped_column(String(200), default="")
    event_date: Mapped[str] = mapped_column(String(10))       # YYYY-MM-DD
    created_at: Mapped[datetime] = mapped_column(DateTime)
```

**Relacion con Part/Asset.** El neumatico NO reemplaza a `Part`: lo referencia por `part_number`. Un modelo de neumatico (p.ej. `TIRE-29575R225-DRIVE`) vive en el catalogo `Part` con su `cost`, `on_hand` y `reorder_point`; el `Tire` es la instancia serializada de ese SKU. Cuando el shop compra 8 neumaticos, sube `Part.on_hand` a 8 (via PO / PartStockMovement, el flujo ya existente) y opcionalmente crea 8 filas `Tire` con serie. Al montar uno, se consume una unidad del inventario del SKU (delta -1, reason `wo_consume`) y el `Tire` pasa a `mounted`. `TirePosition.unit` referencia `Unit.unit` (clave de negocio de la unidad), y `unit_type` reusa el enum de `Unit` (`truck | trailer | chassis`).

**Nota migracion Alembic.** Las tres tablas son nuevas, asi que `create_all` las levanta solas en cualquier motor sobre base fresca (deploy Dokploy/VPS incluido). Para bases con datos hay que generar una revision Alembic con las tres tablas + sus indices y constraints unicos (`alembic revision --autogenerate -m "tire management"`, luego `alembic upgrade head`). El `_migrate()` de SQLite no necesita tocarse: al ser tablas faltantes, `create_all` las crea en dev sin ALTER. La unica columna a vigilar si mas adelante se agrega algo a una tabla existente seria repetir el patron PRAGMA/ALTER del resto de `_migrate`.

## 4. Backend (core + endpoints; reglas)

Logica nueva en `core/tires.py`, endpoints en `api/routes.py`.

**core/tires.py**

- `seed_positions(unit, unit_type, axle_config)`: al crear/editar una `Unit`, genera las filas `TirePosition` desde una plantilla. Plantillas: `truck_6x4` (LF, RF, LRO, LRI, RRO, RRI... por eje de traccion), `trailer_tandem` (LFO/LFI... x 2 ejes), etc. Idempotente (respeta el unique `unit+code`).
- `record_event(tire_id, kind, unit=None, position=None, cost=0, wo_id=None)`: inserta el `TireEvent`, **resuelve el odometro leyendo el ultimo sync de telematics de esa unidad** (`core/providers/`), y actualiza el cache en `Tire` (`current_unit`, `current_position`, `status`, `mounted_odometer`; en retread sube `retread_count`, `condition='retread'` y suma `cost` a `cost_total`). Reglas: no montar en una posicion ya ocupada (un `mounted` activo por `unit+position`); `retread` solo sobre un casco `in_stock` o recien `remove`d; `scrap` es terminal.
- `cost_per_mile(tire_id)`: `cost_total / millas_rodadas`, donde millas = suma de (odometro_remove menos odometro_install) por cada tramo montado, cerrando el tramo abierto con el odometro actual de la unidad (del sync). Devuelve None si millas == 0 (evita div/0). Esta es la metrica estrella.
- `wear_check()`: recorre neumaticos `mounted`, compara `tread_depth` contra el minimo por posicion (4/32" steer, 2/32" resto, con un buffer configurable de alerta a 6/32"), y estima millas desde el ultimo install para gatillar rotacion por millaje (default 30,000 mi). Emite las alertas del cap 04.

**Endpoints (`api/routes.py`)**

- `GET /api/tires` (filtros: status, unit, brand) y `GET /api/tires/{id}` (con su timeline de eventos y cost-per-mile).
- `POST /api/tires` (alta de casco), `POST /api/tires/{id}/events` (install/rotate/retread/remove/scrap).
- `GET /api/units/{unit}/wheel-map`: devuelve las `TirePosition` de la unidad con el `Tire` montado en cada una (o vacio) mas su tread depth. Es lo que pinta el mapa de la UI.
- `GET /api/tires/report/cost-per-mile`: ranking por marca/modelo (agrega el cost-per-mile de todos los cascos de ese SKU).

Todos pasan por el RBAC existente: `mechanic` y `admin` escriben eventos; `viewer` solo lee. Reusar el guard de roles de `core/auth.py`.

## 5. UI (React; donde encaja; estados vacio/carga/error)

Tres puntos de entrada, todos en el front React+Vite+TS existente.

1. **Pestana "Tires" en el perfil de la unidad** (junto a Attachments/Maintenance). El corazon es el **Wheel Position Map**: un diagrama SVG de la unidad visto desde arriba, con cada rueda como un chip clickeable ubicado en su eje. Color por tread depth (verde >6/32", amarillo 4-6/32", rojo <4/32", gris = slot vacio). Click en una rueda abre un panel lateral con el neumatico montado (serie, marca, tread, cost-per-mile) y botones Rotate / Remove / Retread.

2. **Vista global "Tire Inventory"** (nivel flota): tabla de cascos con filtros (status, marca, unidad), barra de busqueda por serie/barcode, y el CTA de alta. Fila expandible al timeline del casco.

3. **Reporte Cost-per-Mile**: tabla/bar chart comparando marcas y modelos por costo por milla, para decisiones de compra.

Wheel map en ASCII (la UI lo renderiza como SVG proporcional):

```
   Truck 214  (6x4)              Trailer 88  (tandem)
      steer                          
   [LF]    [RF]                   [LFO|LFI]   [RFO|RFI]   <- axle 1
                                  [LRO|LRI]   [RRO|RRI]   <- axle 2
   drive axle 1
   [LRO|LRI][RRO|RRI]
   drive axle 2
   [L2O|L2I][R2O|R2I]
```

**Estados.**
- Vacio (unidad sin posiciones sembradas): banner "Esta unidad no tiene configuracion de ejes" con boton "Generar mapa" que elige plantilla por `unit_type`. Vacio en inventario: ilustracion + "Agrega tu primer neumatico".
- Carga: skeleton del wheel map (siluetas grises de las ruedas) y skeleton rows en la tabla; nunca spinner suelto.
- Error: banner rojo reintentar sobre el ultimo estado bueno; si un evento (rotate/retread) falla por regla de negocio (posicion ocupada), toast con el mensaje del backend y el panel no se cierra para no perder el input.

## 6. Automatizaciones (cap 04)

El motor de automatizaciones dispara sobre eventos y sobre umbrales evaluados en el cron de flota:

- **Tread depth bajo**: cuando `wear_check` detecta un casco `mounted` bajo el buffer (6/32" warn, 4/32" steer critico). Accion: alerta al shop manager + (opcional) crear un borrador de work order de reemplazo.
- **Rotacion por millaje**: millas desde el ultimo `install`/`rotate` de una unidad superan el umbral (30k default, configurable por org). Accion: tarea "Rotar neumaticos unidad X".
- **Casco agotado**: `retread_count` llega al maximo de la marca (tipico 2-3). Accion: marcar el casco como candidato a scrap al proximo remove.
- **Neumatico huerfano**: un `Tire` en `mounted` cuya `unit` dejo de aparecer en el sync (unidad vendida/baja). Accion: alerta para reconciliar inventario.

Todas emiten via el mismo canal de alertas que ya usa `AlertEvent`, encajando en el patron regla/accion del cap 04 sin tuberia nueva.

## 7. Integraciones que toca

- **Telematics sync (`core/providers/`)**: fuente del odometro en cada evento y del odometro actual para cerrar el tramo del cost-per-mile. Es la dependencia dura; sin millaje, la metrica estrella no existe.
- **Inventory (Part / PartStockMovement / PurchaseOrder)**: el neumatico como SKU. Montar consume stock; comprar (PO recibida) lo repone. Reusa el libro de movimientos y su guard de idempotencia.
- **Work Orders**: una rotacion o reemplazo genera lineas de WO (labor de montaje + la parte si es casco nuevo). El `TireEvent.wo_id` liga el evento a la orden que lo cobro, cerrando el costo de labor hacia el `cost_total`.
- **Unit / Asset**: `TirePosition` cuelga de la unidad; crear una unidad ofrece sembrar su mapa de ejes.
- **Escaner de documentos / barcode**: el `barcode` del casco se lee en el piso para no tipear series; encaja con el pipeline de escaneo ya presente en el stack.

## 8. Esfuerzo (S/M/L) - prioridad - dependencias

**Esfuerzo: L.** Tres tablas, un modulo core con la logica de cost-per-mile (la parte fina: reconstruir tramos montados desde el timeline y cerrar con el odometro del sync), y una UI con un componente SVG a medida (el wheel map) que no se parece a nada ya construido. El backend es M; el wheel map interactivo empuja el total a L.

**Prioridad: 🟠.** Es un diferenciador claro frente a competidores mas caros y un ahorro real medible, pero esta detras de las features de compliance y del motor de work orders. Buen candidato para un increment despues de que Inventory este estable.

**Dependencias.**
- Requiere: sync de telematics con odometro confiable por unidad (existe); modelo `Unit` con `unit_type` (existe); Inventory con Part/PartStockMovement (existe); motor de automatizaciones del cap 04 (para las alertas; la feature funciona sin el, solo pierde las alertas proactivas).
- Habilita: reporte de cost-per-mile a nivel flota, y una futura integracion de compra de neumaticos por API de vendor (paralelo al gap de partes FinditParts).

## 9. Ejemplo end-to-end con datos realistas

Shop: MCC Fleet Services. Unidad: truck **214** (config 6x4, 10 posiciones). Casco nuevo Bridgestone.

1. **Compra.** El shop recibe una PO de 8 Bridgestone M726 (`295/75R22.5`) a 412 USD c/u del vendor "Southern Tire". La PO recibida sube `Part.on_hand` del SKU `TIRE-M726-29575` a 8 (PartStockMovement delta +8, reason `po_receive`). El manager crea 8 filas `Tire` escaneando cada barcode; una queda con `serial="B3F729KA1"`, `cost_total=412`, `status=in_stock`, `condition=new`.

2. **Install.** Se monta en la posicion **LRO** (left rear outer, eje de traccion 1) del truck 214. El mecanico registra el evento desde el wheel map. `record_event(tire_id, "install", unit="214", position="LRO")` lee el sync: odometro **487,300 mi**. Se crea una WO con linea de labor "Mount tire LRO" (0.5 h x 85 USD = 42.50 USD); al facturar, `TireEvent.wo_id` liga el evento, y los 42.50 se suman a `cost_total` -> **454.50 USD**. El SKU baja a `on_hand=7`. El `Tire` queda `mounted`, `current_position="LRO"`, `mounted_odometer=487300`.

3. **Rodaje y alerta.** Ocho meses despues el sync marca **612,800 mi**. La unidad rodo 125,500 mi. En la ultima inspeccion el tread bajo de 20/32" a 7/32". El cron de `wear_check` aun no alerta (buffer 6/32"), pero si dispara **rotacion por millaje** (>30k desde el install): tarea "Rotar neumaticos 214". El mecanico rota LRO -> LRI; `record_event("rotate")` cierra implicito el tramo y abre uno nuevo, odometro 612,800.

4. **Cost-per-mile.** A las 640,000 mi el tread llega a 5/32" (amarillo en el mapa) y el manager decide reencaucharlo. Antes de removerlo consulta la ficha: `cost_per_mile` = 454.50 / (640,000 - 487,300) = 454.50 / 152,700 = **0.00298 USD/mi** (0.30 centavos por milla). El reporte de flota muestra que el Bridgestone M726 promedia 0.31 c/mi vs 0.44 del competidor generico: el manager estandariza compras en M726.

5. **Retread.** Se remueve (`remove`, odometro 640,000) y se manda a reencauchar por 155 USD. `record_event("retread", cost=155)` sube `retread_count=1`, `condition="retread"`, `cost_total=609.50`, `status=retreading` -> luego `in_stock`. El casco vuelve al inventario listo para un segundo ciclo de vida, y su nuevo cost-per-mile se recalculara sobre la vida acumulada cuando vuelva a rodar.
