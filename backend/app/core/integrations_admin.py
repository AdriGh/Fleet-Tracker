# -*- coding: utf-8 -*-
"""Administración de integraciones (fase G6): test + configuración.

Permite, desde Settings -> Connectivity:
- Probar la conexión de cada proveedor (chequeos VIVOS baratos y
  seguros: lecturas mínimas, login SMTP sin enviar nada).
- Escribir/mergear credenciales en los `*.local.json` sin editar
  archivos a mano. Los secretos NUNCA se devuelven por la API (solo
  colas enmascaradas tipo "…a1b2").

NOTA de seguridad: la app corre en 127.0.0.1 para un solo operador;
las credenciales viven en archivos locales gitignored. El cifrado en
reposo (keyring/DPAPI) llega con la multi-empresa (G7).
"""

from __future__ import annotations

import asyncio
import json
import smtplib
import time
from pathlib import Path

import httpx

from .. import config
from . import local_config, mailer, media_host, pm, pois, samsara, sms_service
from .providers import registry

_TIMEOUT = 15


def _read_json(path: Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
    return {}


def _write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1),
                    encoding="utf-8")


def _tail(secret: str) -> str:
    secret = (secret or "").strip()
    return f"…{secret[-4:]}" if len(secret) >= 4 else ""


# ----- Specs de configuración por proveedor ------------------------------
# field: {key, label, secret?, kind: text|password|toggle, help?}

def config_specs() -> dict[str, dict]:
    """Qué campos edita cada proveedor y su estado enmascarado actual."""
    twilio = sms_service.load_settings()
    cloud = media_host.load_settings()
    avisos = local_config.load()
    motive = _read_json(config.BACKEND_DIR / "motive.local.json")
    google = _read_json(pois.GOOGLE_CONF)

    return {
        "samsara": {
            "title": "Samsara API tokens",
            "help": ("Read-only tokens, one per org. Leave the token "
                     "empty to keep the existing one."),
            "orgs": [
                {"company": o["company"],
                 "token_tail": f"…{o['token_tail']}",
                 "trailer_dvirs": o["trailer_dvirs"]}
                for o in samsara.org_summaries()
            ],
        },
        "motive": {
            "title": "Motive API key",
            "help": "Self-serve key from developer.gomotive.com.",
            "fields": [
                {"key": "api_key", "label": "API key", "kind": "password",
                 "tail": _tail(motive.get("api_key", ""))},
            ],
        },
        "twilio": {
            "title": "Twilio SMS",
            "help": "Requires an A2P 10DLC-registered number.",
            "fields": [
                {"key": "account_sid", "label": "Account SID",
                 "kind": "password", "tail": _tail(twilio.account_sid)},
                {"key": "auth_token", "label": "Auth token",
                 "kind": "password", "tail": _tail(twilio.auth_token)},
                {"key": "from_number", "label": "From number",
                 "kind": "text", "tail": twilio.from_number},
                {"key": "dry_run", "label": "Dry run (simulate sends)",
                 "kind": "toggle", "value": twilio.dry_run},
            ],
        },
        "cloudinary": {
            "title": "Cloudinary media hosting",
            "help": "Public URLs for MMS attachments.",
            "fields": [
                {"key": "cloud_name", "label": "Cloud name",
                 "kind": "text", "tail": cloud.cloud_name},
                {"key": "api_key", "label": "API key", "kind": "password",
                 "tail": _tail(cloud.api_key)},
                {"key": "api_secret", "label": "API secret",
                 "kind": "password", "tail": _tail(cloud.api_secret)},
                {"key": "dry_run", "label": "Dry run",
                 "kind": "toggle", "value": cloud.dry_run},
            ],
        },
        "gplaces": {
            "title": "Google Places API",
            "help": ("Text Search key. Results show in lists only "
                     "(Google ToS)."),
            "fields": [
                {"key": "places_api_key", "label": "Places API key",
                 "kind": "password",
                 "tail": _tail(google.get("places_api_key", ""))},
            ],
        },
        "gmail": {
            "title": "Email (Gmail SMTP)",
            "help": ("App Password from myaccount.google.com/apppasswords. "
                     "Dry run OFF means notices SEND FOR REAL."),
            "danger": True,
            "fields": [
                {"key": "gmail_sender", "label": "Sender address",
                 "kind": "text", "tail": avisos.get("gmail_sender", "")},
                {"key": "gmail_app_password", "label": "App password",
                 "kind": "password",
                 "tail": _tail(avisos.get("gmail_app_password", ""))},
                {"key": "dry_run", "label": "Dry run (simulate sends)",
                 "kind": "toggle",
                 "value": bool(avisos.get("dry_run", True))},
            ],
        },
    }


def save_config(provider: str, values: dict) -> dict:
    """Mergea credenciales al *.local.json del proveedor.

    Campos secretos vacíos = conservar el valor existente.
    """
    def merge(path: Path, keys: list[str]) -> None:
        data = _read_json(path)
        for k in keys:
            if k not in values:
                continue
            v = values[k]
            if isinstance(v, str):
                v = v.strip()
                if v == "":
                    continue          # vacío -> conservar
            data[k] = v
        _write_json(path, data)

    if provider == "motive":
        merge(config.BACKEND_DIR / "motive.local.json", ["api_key"])
    elif provider == "twilio":
        merge(sms_service.SETTINGS_PATH,
              ["account_sid", "auth_token", "from_number",
               "messaging_service_sid", "dry_run"])
    elif provider == "cloudinary":
        merge(media_host.SETTINGS_PATH,
              ["cloud_name", "api_key", "api_secret", "dry_run"])
    elif provider == "gplaces":
        merge(pois.GOOGLE_CONF, ["places_api_key"])
    elif provider == "gmail":
        merge(Path(local_config.CONFIG_PATH),
              ["gmail_sender", "gmail_app_password", "dry_run"])
    elif provider == "samsara":
        _save_samsara_orgs(values)
    else:
        raise ValueError(f"Proveedor no configurable: {provider}")
    return {"ok": True}


def _save_samsara_orgs(values: dict) -> None:
    """Actualiza tokens por org (token vacío = conservar) y permite
    agregar un org nuevo."""
    path = Path(samsara.CONF_PATH)
    data = _read_json(path)
    entries = data.get("orgs")
    if not entries and data.get("api_token"):
        entries = [data]
    entries = entries or []

    for upd in values.get("orgs") or []:
        comp = str(upd.get("company") or "").strip()
        token = str(upd.get("api_token") or "").strip()
        match = next(
            (e for e in entries
             if (e.get("company") or "").strip() == comp), None)
        if match is None and comp:
            if not token:
                continue              # org nuevo requiere token
            match = {"company": comp,
                     "base_url": "https://api.samsara.com"}
            entries.append(match)
        if match is None:
            continue
        if token:
            match["api_token"] = token
        if "trailer_dvirs" in upd:
            match["trailer_dvirs"] = bool(upd["trailer_dvirs"])

    _write_json(path, {"orgs": entries})


# ----- Test de conexión ---------------------------------------------------

async def test(provider: str) -> dict:
    """Chequeo vivo barato y SEGURO por proveedor. Nunca envía nada."""
    provs = registry()
    if provider in provs:
        return await provs[provider].ping()

    if provider == "twilio":
        s = sms_service.load_settings()
        if not s.configured:
            return {"ok": False, "detail": "Not configured"}
        t0 = time.monotonic()
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.get(
                "https://api.twilio.com/2010-04-01/Accounts/"
                f"{s.account_sid}.json",
                auth=(s.account_sid, s.auth_token))
        ms = int((time.monotonic() - t0) * 1000)
        if r.status_code == 200:
            name = (r.json().get("friendly_name") or "account")[:40]
            return {"ok": True, "detail": f"{name} OK ({ms} ms)"}
        return {"ok": False, "detail": f"HTTP {r.status_code}"}

    if provider == "cloudinary":
        s = media_host.load_settings()
        if not s.configured:
            return {"ok": False, "detail": "Not configured"}
        t0 = time.monotonic()
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.get(
                f"https://api.cloudinary.com/v1_1/{s.cloud_name}/ping",
                auth=(s.api_key, s.api_secret))
        ms = int((time.monotonic() - t0) * 1000)
        return ({"ok": True, "detail": f"ping OK ({ms} ms)"}
                if r.status_code == 200
                else {"ok": False, "detail": f"HTTP {r.status_code}"})

    if provider == "gmail":
        s = mailer.load_settings()
        if not s.configured:
            return {"ok": False, "detail": "Not configured"}

        def smtp_login() -> dict:
            t0 = time.monotonic()
            try:
                with smtplib.SMTP_SSL("smtp.gmail.com", 465,
                                      timeout=_TIMEOUT) as server:
                    server.login(s.sender, s.password)
                ms = int((time.monotonic() - t0) * 1000)
                return {"ok": True,
                        "detail": f"SMTP login OK ({ms} ms) — "
                                  "nothing was sent"}
            except smtplib.SMTPException as exc:
                return {"ok": False,
                        "detail": f"SMTP: {type(exc).__name__}"}
            except OSError as exc:
                return {"ok": False, "detail": f"{type(exc).__name__}"}

        return await asyncio.to_thread(smtp_login)

    if provider == "gplaces":
        if not pois.google_configured():
            return {"ok": False, "detail": "Not configured"}
        t0 = time.monotonic()
        r = await pois.google_search("truck stop", 35.1, -90.0)
        ms = int((time.monotonic() - t0) * 1000)
        if r.get("error"):
            return {"ok": False, "detail": r["error"][:80]}
        return {"ok": True,
                "detail": f"{len(r['results'])} results ({ms} ms)"}

    if provider == "gsheets":
        avisos = local_config.load()
        sa = avisos.get("service_account_file") or ""
        sa_path = config.BACKEND_DIR / sa if sa else None
        if avisos.get("spreadsheet_id") and sa_path and sa_path.exists():
            return {"ok": True,
                    "detail": "Config + service account present"}
        return {"ok": False, "detail": "avisos.local.json incomplete"}

    if provider == "fullbay":
        return ({"ok": True, "detail": "pm.local.csv present"}
                if pm.is_available()
                else {"ok": False, "detail": "pm.local.csv missing"})

    return {"ok": False, "detail": f"No test for '{provider}'"}
