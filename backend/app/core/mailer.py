# -*- coding: utf-8 -*-
"""Envio de correos por Gmail (SMTP + App Password).

La configuracion (remitente, App Password, modo simulado) se lee de
`backend/avisos.local.json`, que NO se versiona. Si no existe o no esta
completa, la herramienta queda en modo simulado: arma los correos pero no
los envia.

Claves en avisos.local.json:
    {
      "gmail_sender": "tu-correo@gmail.com",
      "gmail_app_password": "xxxx xxxx xxxx xxxx",
      "dry_run": true
    }
"""

import smtplib
import ssl
from email.message import EmailMessage

from . import local_config

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465


class EmailSettings:
    def __init__(self, data: dict):
        self.sender = str(data.get("gmail_sender", "")).strip()
        self.password = str(data.get("gmail_app_password", "")).replace(" ", "")
        # dry_run por defecto True salvo que el JSON diga lo contrario.
        self.dry_run = bool(data.get("dry_run", True))

    @property
    def configured(self) -> bool:
        return bool(self.sender and self.password)


def load_settings() -> EmailSettings:
    return EmailSettings(local_config.load())


def send_email(settings: EmailSettings, to: str, cc: list[str],
               subject: str, body: str) -> dict:
    """Envia (o simula) un correo. Devuelve {ok, error, simulated}."""
    simulate = settings.dry_run or not settings.configured
    if simulate:
        return {"ok": True, "error": "", "simulated": True}

    msg = EmailMessage()
    msg["From"] = settings.sender
    msg["To"] = to
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg["Subject"] = subject
    msg.set_content(body)

    recipients = [to] + list(cc)
    try:
        ctx = ssl.create_default_context()
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ctx) as s:
            s.login(settings.sender, settings.password)
            s.send_message(msg, to_addrs=recipients)
        return {"ok": True, "error": "", "simulated": False}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc), "simulated": False}


def send_test(settings: EmailSettings, to: str | None = None) -> dict:
    """Envia un correo de prueba REAL (ignora dry_run) para validar la
    App Password. Por defecto se lo manda al propio remitente."""
    if not settings.configured:
        return {"ok": False, "simulated": False,
                "error": ("Faltan 'gmail_sender' o 'gmail_app_password' en "
                          "avisos.local.json")}
    forced = EmailSettings({
        "gmail_sender": settings.sender,
        "gmail_app_password": settings.password,
        "dry_run": False,
    })
    return send_email(
        forced, to or settings.sender, [],
        "DVIR Mailer — prueba de configuración",
        "Si recibís este correo, el envío por Gmail quedó configurado "
        "correctamente. ✅\n\n— DVIR Report Generator")
