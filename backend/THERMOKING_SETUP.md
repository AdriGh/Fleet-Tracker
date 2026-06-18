# Thermo King TracKing / ConnectedSuite — setup (OEM reefer, two-way)

Cómo conectar Fleet Tracker **directo** al API de Thermo King TracKing /
ConnectedSuite para **monitorear y CONTROLAR** reefers Thermo King. Es el
gemelo del adapter Carrier Lynx (`backend/LYNX_SETUP.md`): fuente OEM del
Cold Chain, **directa, sin pasar por Samsara** (principio de soberanía del
dato, ver `docs/STRATEGY-data.md`).

A diferencia de Traccar (aftermarket, solo lectura + umbral), el API de
TracKing es **bidireccional**: cambia setpoint/modo, pre-trip, defrost y
power on/off del reefer real.

## 1. Conseguir credenciales

TracKing/ConnectedSuite viene de fábrica en los reefers Thermo King. Para
el acceso al API:

1. Activar un **service level de ConnectedSuite con two-way commands** (los
   planes superiores; el básico es solo lectura).
2. Pedir el formulario de credenciales de API a tu proveedor y enviarlo a
   **tracking@thermoking.com**; Thermo King da de alta la cuenta y entrega
   las credenciales (Client ID / Secret / API Key).
3. Mandar a `tracking@thermoking.com` la lista de **números de serie** de
   los reefers a incluir.
4. Confirmar el **base URL** del API y, si difieren del default, los paths
   de los endpoints (assets / commands / history).

> Precio: NO público, se cotiza por dealer/proveedor. Confirmar antes de
> fijar el precio del add-on premium "Cold Chain Control"
> (ver `docs/reefer-dealer-questions.md`).

## 2. Configurar en la app

**Settings → Connectivity → Cold chain → Thermo King → Configure**, o copiá
`backend/thermoking.example.json` a `backend/thermoking.local.json`
(gitignored) y completá `base_url`, `client_id`, `client_secret`,
`api_key`, `tier` (`monitor` lectura · `control`/`enhanced` two-way) y
`temp_unit` (`F`/`C`, confirmar). **Test** hace el OAuth + lista assets sin
mutar nada e informa el tier y si habilita control.

## 3. Prioridad de fuentes

El Cold Chain elige, en orden: **Lynx (OEM) → Thermo King (OEM) → Traccar
(aftermarket) → demo**. La primera configurada y disponible gana. El
control remoto se despacha por prefijo del id (`tk-…` → Thermo King).

## 4. Control remoto

Con un tier two-way, los endpoints quedan habilitados para unidades `tk-…`:

- `POST /api/reefer/{unit_id}/setpoint` `{ "setpoint_f": -10 }`
- `POST /api/reefer/{unit_id}/command` `{ "command": "mode", "mode": "Continuous" }`
  (también `defrost`, `power`).

Requieren rol con scope `fleet.edit`. Con tier `monitor` devuelven un error
claro sin pegarle al API.

## Pendiente (boceto)

Los **paths exactos de los endpoints y los nombres de campos del JSON** del
TracKing API no son públicos: en `core/thermoking.py` van como defaults
overrideables (`path_assets`/`path_command`/`path_history`) y los campos se
leen por `_pick()` con nombres probables. Ajustarlos en ese único lugar
cuando lleguen las credenciales y el schema. La auth se asume OAuth2
client-credentials — **confirmar** (algunos despliegues usan API key sola).
