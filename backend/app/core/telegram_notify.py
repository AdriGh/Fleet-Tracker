# -*- coding: utf-8 -*-
"""Notificaciones por Telegram (fase H2): bot + group chat del taller.

Cuando una work order avanza de etapa (por default, al pasar a
`assigned`), la app manda un mensaje al group chat para que el mecánico
se entere sin abrir la app. Mismo modelo de seguridad que el SMS:

- Credenciales en `backend/telegram.local.json` (gitignored):
  {"bot_token": "...", "chat_id": "-100...", "dry_run": true,
   "notify_statuses": ["assigned"]}
- `dry_run` por DEFAULT en true: simula sin enviar hasta que el usuario
  lo apague desde Settings -> Connectivity.
- El test de conexión usa getMe (identidad del bot): nunca envía nada.

Setup del bot (una vez): hablar con @BotFather -> /newbot -> token;
agregar el bot al grupo del taller; obtener el chat_id del grupo con
getUpdates o @RawDataBot (los de grupo empiezan con -100).
"""

from __future__ import annotations

import json
import time

import httpx

from .. import config

SETTINGS_PATH = config.BACKEND_DIR / "telegram.local.json"
_TIMEOUT = 12
_API = "https://api.telegram.org"

DEFAULT_NOTIFY = ["assigned"]

STATUS_TEXT = {
    "open": "reopened",
    "assigned": "assigned",
    "in_progress": "in progress",
    "completed": "completed",
    "invoiced": "invoiced",
}


def load_settings() -> dict:
    data: dict = {}
    if SETTINGS_PATH.exists():
        try:
            data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
    return {
        "bot_token": str(data.get("bot_token") or ""),
        "chat_id": str(data.get("chat_id") or ""),
        "dry_run": bool(data.get("dry_run", True)),
        "notify_statuses": list(data.get("notify_statuses")
                                or DEFAULT_NOTIFY),
    }


def configured() -> bool:
    s = load_settings()
    return bool(s["bot_token"] and s["chat_id"])


async def ping() -> dict:
    """Test de conexión: identidad del bot vía getMe. No envía nada."""
    s = load_settings()
    if not s["bot_token"]:
        return {"ok": False, "detail": "Not configured"}
    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.get(f"{_API}/bot{s['bot_token']}/getMe")
        ms = int((time.monotonic() - t0) * 1000)
        body = r.json()
        if r.status_code == 200 and body.get("ok"):
            name = body["result"].get("username") or "bot"
            extra = "" if s["chat_id"] else " · chat_id missing"
            mode = "dry run" if s["dry_run"] else "LIVE"
            return {"ok": True,
                    "detail": f"@{name} OK ({ms} ms) · {mode}{extra}"}
        return {"ok": False, "detail": f"HTTP {r.status_code}"}
    except httpx.HTTPError as exc:
        return {"ok": False, "detail": type(exc).__name__}


async def send(text: str) -> dict:
    """Manda `text` al group chat. dry_run simula y no toca la red."""
    s = load_settings()
    if not (s["bot_token"] and s["chat_id"]):
        return {"sent": False, "detail": "not configured"}
    if s["dry_run"]:
        return {"sent": True, "simulated": True,
                "detail": "dry run, nothing sent"}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.post(
                f"{_API}/bot{s['bot_token']}/sendMessage",
                json={"chat_id": s["chat_id"], "text": text})
        if r.status_code == 200 and r.json().get("ok"):
            return {"sent": True, "simulated": False, "detail": "sent"}
        return {"sent": False,
                "detail": f"HTTP {r.status_code}: "
                          f"{r.json().get('description', '')[:60]}"}
    except httpx.HTTPError as exc:
        return {"sent": False, "detail": type(exc).__name__}


async def notify_wo(wo: dict, old_status: str) -> dict | None:
    """Notifica el cambio de etapa de un WO si aplica (None = no aplica).

    Mensaje pensado para el group chat del taller: qué orden, qué unidad,
    quién la tiene y qué se reportó.
    """
    s = load_settings()
    new = wo.get("status", "")
    if new == old_status or new not in s["notify_statuses"]:
        return None
    if not (s["bot_token"] and s["chat_id"]):
        return None

    lines = [f"WO #{wo['id']} {STATUS_TEXT.get(new, new)} · {wo['unit']}"]
    if wo.get("mechanic"):
        lines.append(f"Mechanic: {wo['mechanic']}")
    if wo.get("title"):
        lines.append(f"Issue: {wo['title']}")
    if wo.get("priority") == "high":
        lines.append("Priority: HIGH")
    if new == "invoiced" and wo.get("total"):
        lines.append(f"Invoice total: ${wo['total']:,.2f}")
    return await send("\n".join(lines))
