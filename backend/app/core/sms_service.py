# -*- coding: utf-8 -*-
"""Envío de avisos por SMS/MMS (Twilio).

Gemelo de `mailer.py`. La configuración se lee de
`backend/twilio.local.json` (NO se versiona, gitignored por `*.local.json`).
Si falta o está incompleta, queda en **modo simulado** (`dry_run`): arma el
mensaje pero no lo envía.

Claves en twilio.local.json:
    {
      "account_sid": "ACxxxx…",
      "auth_token": "xxxxxxxx",
      "from_number": "+15551234567",        // o usar messaging_service_sid
      "messaging_service_sid": "",           // opcional (recomendado p/ 10DLC)
      "dry_run": true,
      "sender_name": "Safety/Maintenance"
    }

Notas Twilio:
- SMS = texto. **MMS** adjunta media vía `MediaUrl` — Twilio descarga ese
  archivo desde una **URL pública** (por eso el media se sube antes a un host;
  ver `media_host.py`). El video por MMS es poco confiable → se manda como
  **link en el cuerpo** del SMS.
- `to`/`from` en formato E.164 **con** '+': "+19015550142".
- Para textear como empresa en EE.UU. hace falta registro **A2P 10DLC**
  (idealmente vía un Messaging Service).
"""

import json
import re
from pathlib import Path

import httpx

SETTINGS_PATH = Path(__file__).resolve().parents[2] / "twilio.local.json"
_API = "https://api.twilio.com/2010-04-01"
_TIMEOUT = 30


class SmsSettings:
    def __init__(self, data: dict):
        self.account_sid = str(data.get("account_sid", "")).strip()
        self.auth_token = str(data.get("auth_token", "")).strip()
        self.from_number = str(data.get("from_number", "")).strip()
        self.messaging_service_sid = str(
            data.get("messaging_service_sid", "")).strip()
        self.dry_run = bool(data.get("dry_run", True))
        self.sender_name = str(
            data.get("sender_name", "Safety/Maintenance")).strip() \
            or "Safety/Maintenance"

    @property
    def configured(self) -> bool:
        return bool(self.account_sid and self.auth_token
                    and (self.from_number or self.messaging_service_sid))


def load_settings() -> SmsSettings:
    if SETTINGS_PATH.exists():
        try:
            return SmsSettings(
                json.loads(SETTINGS_PATH.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            pass
    return SmsSettings({})


def to_e164(phone: str, default_cc: str = "1") -> str | None:
    """Normaliza un teléfono a E.164 CON '+': '(901) 555-0142' -> '+19015550142'.
    Devuelve None si no parece válido (p.ej. el demo 555-0100)."""
    digits = re.sub(r"\D", "", phone or "")
    if not digits:
        return None
    if len(digits) == 10:
        digits = default_cc + digits
    if len(digits) < 11 or len(digits) > 15:
        return None
    return "+" + digits


def build_payload(settings: SmsSettings, to: str, body: str,
                  media_urls: list[str] | None = None) -> dict:
    """Arma los campos del POST a la Messages API de Twilio."""
    data: dict = {"To": to, "Body": body}
    if settings.messaging_service_sid:
        data["MessagingServiceSid"] = settings.messaging_service_sid
    else:
        data["From"] = settings.from_number
    for url in (media_urls or []):
        data.setdefault("MediaUrl", []).append(url)
    return data


def send_sms(settings: SmsSettings, to: str, body: str,
             media_urls: list[str] | None = None) -> dict:
    """Envía (o simula) un SMS/MMS. Devuelve {ok, error, simulated, sid?}."""
    data = build_payload(settings, to, body, media_urls)
    if settings.dry_run or not settings.configured:
        return {"ok": True, "error": "", "simulated": True, "payload": data}
    try:
        url = f"{_API}/Accounts/{settings.account_sid}/Messages.json"
        r = httpx.post(url, data=data,
                       auth=(settings.account_sid, settings.auth_token),
                       timeout=_TIMEOUT)
        r.raise_for_status()
        body_json = r.json()
        return {"ok": True, "error": "", "simulated": False,
                "sid": body_json.get("sid", "")}
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text
        try:
            detail = exc.response.json().get("message", detail)
        except Exception:  # noqa: BLE001
            pass
        return {"ok": False, "error": detail, "simulated": False}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc), "simulated": False}
