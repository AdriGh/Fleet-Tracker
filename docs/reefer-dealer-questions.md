# Preguntas al dealer — habilitar reefer (Carrier Lynx / Thermo King)

Objetivo: conseguir el **precio real** de la suscripción OEM (no es
público, se cotiza por dealer) y **confirmar el acceso al API
bidireccional**, para fijar el precio del add-on premium "Cold Chain
Control" de Fleet Tracker. La flota actual son **Carrier X4 (2022)** que
ya traen el módulo Lynx de fábrica → empezar por el dealer Carrier.

Estado: PENDIENTE (acción del usuario / su jefe, que ya tiene relación con
el dealer por el mantenimiento de los X4).

---

## Para el dealer Carrier (Lynx Fleet)

1. **Precio por unidad/mes** de cada uno de los 3 planes:
   Monitor, Monitor and Control, Monitor and Enhanced Control.
   ¿Hay descuento por volumen (la flota completa) o por plan anual?
2. **Comisionado**: ¿hay costo de activación/instalación por unidad?
   Los X4 2022 ya traen el hardware de fábrica — ¿solo hay que activar
   el plan, o igual cobran commissioning?
3. **API**: confirmar que con **Monitor and Control** (o superior) tenemos
   acceso al **Lynx API bidireccional** (two-way command APIs) para
   **leer datos Y cambiar setpoint/modo remotamente desde nuestra propia
   plataforma** (no vía Samsara). ¿En qué tier exacto se habilita el
   control por API?
4. **Credenciales**: ¿el dealer emite **Client ID + Client Secret + API
   Key** para integrar en un sistema propio? ¿Hay costo extra por el
   acceso de developer / por el portal (`dev1.lynx.carrier.com` /
   `api.tta.lynxfleet.carrier.com`)?
5. ¿Límites de rate / cuotas del API? ¿Sandbox para desarrollo?
6. **Contrato**: ¿la suscripción Lynx tiene plazo mínimo / penalidad por
   cancelación, o es mes a mes?

## Para el dealer Thermo King (ConnectedSuite / TracKing) — paralelo

Mismo set, para soportar flotas con reefers Thermo King:

1. Precio por unidad/mes de los **5 niveles de ConnectedSuite**.
2. ¿Qué nivel habilita el **TracKing API bidireccional** (setpoint/modo
   remoto) para integrar en sistema propio?
3. Credenciales de API + costo del acceso developer
   (contacto histórico: `tracking@thermoking.com`).
4. Comisionado / contrato / mínimos.

---

## Por qué importa (contexto de pricing)

- El add-on premium se cobra como **bump de tier**, estilo Fullbay
  (su Basic→Elite es ~+$274/mes vendiendo integraciones). El número del
  add-on de Fleet Tracker se fija recién con la cotización de arriba.
- Benchmark de mercado para encuadrar la respuesta: reefer telematics va
  de ~$30/mes (Samsara) a ~$99/mes (TrackFleet). Lynx, por ser OEM con
  control real, probablemente caiga en la franja alta.
- Modelo de margen sin revender hardware: el cliente paga a Carrier/TK su
  suscripción (passthrough o ya la tiene); Fleet Tracker cobra el
  **premium de plataforma** por surfacearlo en UX unificada + control.
