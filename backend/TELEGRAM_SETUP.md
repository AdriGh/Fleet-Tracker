# Telegram — notificaciones del taller (fase H2)

Cuando una work order pasa a **Assigned** (configurable), la app manda
un mensaje al group chat del taller para que el mecánico se entere sin
abrir la app. Igual que el SMS: **dry run por default**, no se envía
nada hasta que lo apagues en Settings → Connectivity.

## Setup (una sola vez, ~5 minutos)

1. En Telegram, habla con **@BotFather** → `/newbot` → nombre y usuario
   del bot (p. ej. `ChaserShopBot`). BotFather te da el **token**.
2. Crea (o usa) el **grupo del taller** y agrega el bot como miembro.
3. Consigue el **chat id** del grupo: agrega @RawDataBot al grupo un
   momento (te muestra el id, empieza con `-100…`) y luego sácalo; o
   manda un mensaje al grupo y abre
   `https://api.telegram.org/bot<TOKEN>/getUpdates`.
4. En Fleet Tracker: **Settings → Connectivity → Telegram · shop bot →
   Configure** → pega token y chat id. Deja **Dry run ON** para probar.
5. Botón **Test**: hace `getMe` (identidad del bot). Nunca envía nada.
6. Cuando quieras envíos reales: Configure → apaga Dry run.

## Config (backend/telegram.local.json, gitignored)

```json
{
  "bot_token": "123456789:AA…",
  "chat_id": "-1001234567890",
  "dry_run": true,
  "notify_statuses": ["assigned"]
}
```

`notify_statuses` admite cualquier etapa del pipeline
(`assigned`, `in_progress`, `completed`, `invoiced`, `closed`).
El mensaje incluye WO#, unidad, mecánico, issue, prioridad si es alta
y el total cuando se factura.
