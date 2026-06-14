# Carrier Lynx Fleet — setup (OEM reefer, two-way)

Cómo conectar Fleet Tracker **directo** al Carrier Lynx Fleet API para
**monitorear y CONTROLAR** reefers Carrier (X4 2022 / Vector 8000 ya traen
el módulo de fábrica). Es la fuente OEM del Cold Chain — directa, **sin
pasar por Samsara** (principio de soberanía del dato, ver
`docs/STRATEGY-data.md`).

A diferencia de Traccar (aftermarket, solo lectura + umbral de alerta), el
Lynx API es **bidireccional**: cambia el setpoint/modo REAL del reefer.

## 1. Conseguir credenciales (lo hace el dealer Carrier)

El control vive detrás de una **suscripción Lynx** activada por un dealer
Carrier autorizado. Pasos (ver `docs/reefer-dealer-questions.md` para el
detalle a preguntar):

1. Activar el plan **Monitor and Control** (o **Enhanced**) en las unidades
   — el tier *Monitor* es solo lectura y NO permite control remoto.
2. Pedir al dealer las credenciales de API: **Client ID**, **Client
   Secret** y **API Key** (portal dev: `dev1.lynx.carrier.com` /
   `api.tta.lynxfleet.carrier.com`).
3. Confirmar el **base URL** del API y, si difieren del default, los paths
   de los endpoints (assets / commands / history).

> Precio: NO es público, se cotiza por dealer. Confirmar antes de fijar el
> precio del add-on premium "Cold Chain Control".

## 2. Configurar en la app

**Settings → Connectivity → Cold chain → Carrier Lynx → Configure**, o
copiá `backend/lynx.example.json` a `backend/lynx.local.json` (gitignored)
y completá:

| Campo | Qué es |
|---|---|
| `base_url` | Base del API Lynx (https://…) |
| `client_id` / `client_secret` | OAuth2 client-credentials (del dealer) |
| `api_key` | Header `x-api-key` (del dealer) |
| `tier` | `monitor` (lectura) · `control` · `enhanced` |
| `temp_unit` | Unidad que reporta el API: `F` o `C` (confirmar) |
| `deviation_f` | °F de desvío que dispara la alarma derivada |
| `stale_minutes` | Sin reportar → alarma "no data" |

Probá con **Test**: hace el OAuth y lista assets (no muta nada) e informa
el tier y si habilita control.

## 3. Prioridad de fuentes

El Cold Chain elige, en orden: **Lynx (OEM) → Traccar (aftermarket) →
demo**. La primera configurada y disponible gana.

## 4. Control remoto

Con tier `control`/`enhanced`, los endpoints quedan habilitados:

- `POST /api/reefer/{unit_id}/setpoint` `{ "setpoint_f": -10 }`
- `POST /api/reefer/{unit_id}/command` `{ "command": "mode", "mode": "Continuous" }`
  (también `defrost`, `power`).

Requieren rol con scope `fleet.edit` (admin/dispatcher/safety/mechanic) y
una unidad `lynx-…`. Con tier `monitor` devuelven un error claro sin pegarle
al API.

## Pendiente (boceto)

Los **paths exactos de los endpoints y los nombres de campos del JSON** del
Lynx API no son públicos: en `core/lynx.py` van como defaults overrideables
(`path_assets`/`path_command`/`path_history`) y los campos se leen por
`_pick()` con nombres probables. Ajustarlos en ese único lugar cuando
lleguen las credenciales y el schema del portal.
