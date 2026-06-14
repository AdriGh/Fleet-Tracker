# Cold Chain en vivo — piloto de reefer con hardware propio (H5)

Reemplaza el modo DEMO del Cold Chain con temperaturas REALES, sin pagar
APIs mensuales de terceros. El camino:

```
[Trailer] Teltonika FMC130 + sonda DS18B20 ──(celular)──▶ Traccar (VPS) ──(REST)──▶ Fleet Tracker
```

La sonda da **temp de caja + GPS + (opcional) puerta + batería del tracker**
cada ≤5 min. El setpoint/modo/alarmas del compresor (Thermo King/Carrier)
NO salen de la sonda — eso necesita la API del OEM (fase posterior). Acá el
"setpoint" es el target que cargás vos para medir el desvío.

---

## 1. Hardware (por trailer)

| Item | Modelo sugerido | Costo aprox |
|---|---|---|
| Tracker | **Teltonika FMC130** (4G, 1-Wire, IP) | ~€70 |
| Sonda de temperatura | **DS18B20** (1-Wire, waterproof) | ~$3-8 |
| SIM de datos IoT | cualquiera data-only (Hologram, Twilio, etc.) | ~$2-6/mes |
| VPS para Traccar | Hetzner CX22 / DigitalOcean | ~$5/mes |

Total por trailer en marcha: **~$2-6/mes** (SIM) + el VPS compartido entre todos.

> Alternativa de hardware: **Queclink GV600MA** (IP67 rugged, sonda 1-Wire o
> BLE WTH300). El software de Fleet Tracker es genérico; solo cambia el
> cableado y el nombre del atributo de temperatura en Traccar.

---

## 2. Traccar en el VPS

Traccar es open source (Apache-2.0). En el VPS:

```bash
# Docker (lo más simple)
mkdir -p /opt/traccar/{logs,data}
docker run -d --name traccar --restart unless-stopped \
  -p 8082:8082 \          # web/API
  -p 5027:5027/tcp \      # protocolo Teltonika (codec 8/8E)
  -v /opt/traccar/logs:/opt/traccar/logs \
  -v /opt/traccar/data:/opt/traccar/data \
  traccar/traccar:latest
```

- Abrí en el firewall del VPS: **8082** (HTTPS por reverse proxy) y **5027/tcp**
  (el puerto del protocolo Teltonika — el device le pega a este).
- Poné **HTTPS** delante del 8082 (Caddy/Nginx + Let's Encrypt). El device
  manda al 5027 en texto; la API web va por HTTPS.
- Entrá a `https://traccar.tu-dominio` → creá tu usuario admin.
- **Token**: arriba a la derecha → tu cuenta → **"Token"** → generá uno.
  Ese token va en Fleet Tracker (paso 5).

---

## 3. Configurar el Teltonika FMC130

Con **Teltonika Configurator** (USB) o por SMS/FOTA:

1. **GPRS / APN**: el de la SIM (data-only). Server: `IP_DEL_VPS`, Port:
   `5027`, Protocol: **TCP**.
2. **1-Wire / Dallas**: habilitá el sensor **Dallas Temperature 1** (la sonda
   DS18B20). Traccar lo va a exponer como el atributo **`temp1`**.
3. **Data acquisition**: reporting cada **≤5 min** (moviéndose y detenido).
   Si querés alarma rápida de temp, bajá el "on change" del sensor de temp.
4. (Opcional) **Puerta**: cableá un sensor magnético a un **DIN** y mapealo;
   en Traccar aparece como `in1` → cargá ese nombre en `door_attr`.

---

## 4. Dar de alta el device en Traccar

En Traccar → **+** (Devices):
- **Name**: el número de trailer (ej. `53206`) — Fleet Tracker lo usa como
  "unit".
- **Identifier**: el **IMEI** del FMC130.

Cuando el device reporte, abrí la posición y confirmá que está el atributo
**`temp1`** con la temperatura (en **°C**).

---

## 5. Conectar Fleet Tracker

Opción A (UI): **Settings → Connectivity → Traccar** → cargá:
- **Server URL**: `https://traccar.tu-dominio`
- **API token**: el del paso 2
- **Temp attribute**: `temp1`
- **Door input attr**: `in1` (o vacío si no pusiste sensor de puerta)
- **Test** debe decir "N device(s) OK".

Opción B (archivo): editá `backend/traccar.local.json` (ver
`traccar.example.json`). Ahí también cargás:
- **`setpoints`**: el target °F por unidad, ej. `{"53206": -10}` — Fleet
  Tracker alerta si la caja se desvía más de `deviation_f` (default 8 °F).
- **`company`**, **`temp_unit`** (C/F de la sonda), **`stale_minutes`**.

Reiniciá el server (cerrá/abrí la app). El Cold Chain pasa de **DEMO** a
**LIVE · TRACCAR** automáticamente cuando Traccar está configurado y responde.
El historial, las alarmas por umbral y el export ya están cableados.

---

## 6. ⚠️ Probar BAJO CERO antes de confiar

Hay un **bug histórico de decodificación de temperaturas negativas** en
algunos firmwares Teltonika. Antes de poner esto en producción:

1. Meté la sonda a un freezer (o hielo + sal, ~ -10 °C).
2. Confirmá en Traccar que `temp1` reporta **el signo negativo correcto**
   (no un número enorme positivo por overflow).
3. Recién ahí confiá en las alarmas de desvío. Si el signo viene mal,
   actualizá el firmware del FMC130 o ajustá el mapeo.

---

## Resumen de costos vs Fullbay/TrackFleet

- TrackFleet (Journey) = hardware commodity + plataforma rentada (~$99/mes).
- Este piloto: ~$2-6/trailer/mes (SIM) + ~$5/mes de VPS compartido, todo el
  dato es tuyo y va directo a Fleet Tracker. Sin suscripción por trailer.
