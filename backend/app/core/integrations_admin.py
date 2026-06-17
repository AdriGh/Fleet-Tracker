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
from . import (
    docscan, local_config, lynx, mailer, media_host, pm, pois, samsara,
    sms_service, telegram_notify, thermoking, traccar,
)
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

def _provider_spec(p) -> dict:
    """Spec de configuración generado desde un TelematicsProvider que se
    autodescribe (campos + colas enmascaradas leídas de sus credenciales)."""
    creds = p.creds()
    fields = []
    for f in p.config_fields():
        item = dict(f)
        if f.get("kind") == "toggle":
            item["value"] = bool(creds.get(f["key"], False))
        elif f.get("kind") == "password":
            item["tail"] = _tail(str(creds.get(f["key"], "")))
        else:
            item["tail"] = str(creds.get(f["key"], ""))
        fields.append(item)
    return {"title": f"{p.name} API", "help": p.docs, "fields": fields}


def config_specs() -> dict[str, dict]:
    """Qué campos edita cada proveedor y su estado enmascarado actual.

    Los proveedores ELD (registry) se generan solos desde su autodescripción;
    el resto son specs explícitos."""
    twilio = sms_service.load_settings()
    cloud = media_host.load_settings()
    avisos = local_config.load()
    google = _read_json(pois.GOOGLE_CONF)
    telegram = telegram_notify.load_settings()
    claude = docscan.load_settings()
    trc = traccar.load_settings()
    lyn = lynx.load_settings()
    tk = thermoking.load_settings()

    specs = {
        "thermoking": {
            "title": "Thermo King TracKing (OEM reefer)",
            "help": ("Direct two-way Thermo King TracKing / ConnectedSuite "
                     "API: real setpoint/mode control on TK reefers. Request "
                     "API credentials from tracking@thermoking.com. Tier must "
                     "be a ConnectedSuite level with two-way commands. See "
                     "backend/THERMOKING_SETUP.md."),
            "fields": [
                {"key": "base_url", "label": "API base URL (https://…)",
                 "kind": "text", "tail": tk["base_url"]},
                {"key": "client_id", "label": "Client ID", "kind": "password",
                 "tail": _tail(tk["client_id"])},
                {"key": "client_secret", "label": "Client secret",
                 "kind": "password", "tail": _tail(tk["client_secret"])},
                {"key": "api_key", "label": "API key", "kind": "password",
                 "tail": _tail(tk["api_key"])},
                {"key": "tier", "label": "Tier (monitor | control | enhanced)",
                 "kind": "text", "tail": tk["tier"]},
            ],
        },
        "lynx": {
            "title": "Carrier Lynx Fleet (OEM reefer)",
            "help": ("Direct two-way Carrier Lynx API: real setpoint/mode "
                     "control on X4/Vector TRUs. Your Carrier dealer issues "
                     "the Client ID / Secret / API Key after activating a "
                     "Lynx subscription. Tier must be 'control' (Monitor and "
                     "Control) or 'enhanced' to change temps remotely. See "
                     "backend/LYNX_SETUP.md."),
            "fields": [
                {"key": "base_url", "label": "API base URL (https://…)",
                 "kind": "text", "tail": lyn["base_url"]},
                {"key": "client_id", "label": "Client ID", "kind": "password",
                 "tail": _tail(lyn["client_id"])},
                {"key": "client_secret", "label": "Client secret",
                 "kind": "password", "tail": _tail(lyn["client_secret"])},
                {"key": "api_key", "label": "API key", "kind": "password",
                 "tail": _tail(lyn["api_key"])},
                {"key": "tier", "label": "Tier (monitor | control | enhanced)",
                 "kind": "text", "tail": lyn["tier"]},
            ],
        },
        "traccar": {
            "title": "Traccar (reefer hardware)",
            "help": ("Self-hosted Traccar that receives the reefer tracker "
                     "(Teltonika FMC130 / Queclink + temp probe). Feeds the "
                     "Cold Chain with real data. See backend/REEFER_SETUP.md."),
            "fields": [
                {"key": "url", "label": "Server URL (https://…)",
                 "kind": "text", "tail": trc["url"]},
                {"key": "token", "label": "API token", "kind": "password",
                 "tail": _tail(trc["token"])},
                {"key": "temp_attr",
                 "label": "Temp attribute (DS18B20 = temp1)",
                 "kind": "text", "tail": trc["temp_attr"]},
                {"key": "door_attr", "label": "Door input attr (optional)",
                 "kind": "text", "tail": trc["door_attr"]},
            ],
        },
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
        "telegram": {
            "title": "Telegram shop notifications",
            "help": ("Bot from @BotFather + the shop group chat id "
                     "(starts with -100). Notifies the group when a "
                     "work order is assigned."),
            "fields": [
                {"key": "bot_token", "label": "Bot token",
                 "kind": "password",
                 "tail": _tail(telegram.get("bot_token", ""))},
                {"key": "chat_id", "label": "Group chat id",
                 "kind": "text", "tail": telegram.get("chat_id", "")},
                {"key": "dry_run", "label": "Dry run (simulate sends)",
                 "kind": "toggle",
                 "value": bool(telegram.get("dry_run", True))},
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
        "docscan": {
            "title": "AI document scan",
            "help": ("Scans shop invoices and estimates to autofill work "
                     "orders. Engines: AWS Textract AnalyzeExpense "
                     "($0.008/page, the commercial-grade option), local "
                     "Ollama (free, needs 'ollama pull qwen2.5vl:7b') or "
                     "Claude API. Auto picks Textract if AWS keys exist, "
                     "then Claude, then local."),
            "fields": [
                {"key": "provider",
                 "label": "Provider (auto | textract | ollama | anthropic)",
                 "kind": "text", "tail": claude["provider"]},
                {"key": "aws_access_key_id", "label": "AWS access key id",
                 "kind": "password",
                 "tail": _tail(claude["aws_access_key_id"])},
                {"key": "aws_secret_access_key",
                 "label": "AWS secret access key", "kind": "password",
                 "tail": _tail(claude["aws_secret_access_key"])},
                {"key": "aws_region", "label": "AWS region",
                 "kind": "text", "tail": claude["aws_region"]},
                {"key": "ollama_model", "label": "Local model (Ollama)",
                 "kind": "text", "tail": claude["ollama_model"]},
                {"key": "api_key", "label": "Anthropic API key (optional)",
                 "kind": "password", "tail": _tail(claude["api_key"])},
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

    # Proveedores ELD que se autodescriben (Motive y cualquier adapter
    # futuro con config_fields). Samsara ya tiene su spec especial (multi-org).
    for p in registry().values():
        if p.id not in specs and p.config_fields():
            specs[p.id] = _provider_spec(p)
    return specs


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

    # Proveedores ELD que se autodescriben: delegan en su propio adapter.
    reg = registry()
    if provider in reg and provider != "samsara":
        prov = reg[provider]
        if not prov.config_fields():
            raise ValueError(f"Provider not configurable: {provider}")
        prov.save_creds(values)
        return {"ok": True}

    if provider == "twilio":
        merge(sms_service.SETTINGS_PATH,
              ["account_sid", "auth_token", "from_number",
               "messaging_service_sid", "dry_run"])
    elif provider == "cloudinary":
        merge(media_host.SETTINGS_PATH,
              ["cloud_name", "api_key", "api_secret", "dry_run"])
    elif provider == "telegram":
        merge(telegram_notify.SETTINGS_PATH,
              ["bot_token", "chat_id", "dry_run"])
    elif provider == "docscan":
        merge(docscan.SETTINGS_PATH,
              ["provider", "api_key", "model", "ollama_url",
               "ollama_model", "aws_access_key_id",
               "aws_secret_access_key", "aws_region"])
    elif provider == "gplaces":
        merge(pois.GOOGLE_CONF, ["places_api_key"])
    elif provider == "lynx":
        merge(lynx.SETTINGS_PATH,
              ["base_url", "token_url", "client_id", "client_secret",
               "api_key", "company", "tier", "temp_unit",
               "path_assets", "path_command", "path_history"])
    elif provider == "thermoking":
        merge(thermoking.SETTINGS_PATH,
              ["base_url", "token_url", "client_id", "client_secret",
               "api_key", "company", "tier", "temp_unit",
               "path_assets", "path_command", "path_history"])
    elif provider == "traccar":
        merge(traccar.SETTINGS_PATH,
              ["url", "token", "temp_attr", "temp_unit", "door_attr",
               "battery_attr", "company"])
    elif provider == "gmail":
        merge(Path(local_config.CONFIG_PATH),
              ["gmail_sender", "gmail_app_password", "dry_run"])
    elif provider == "samsara":
        _save_samsara_orgs(values)
    else:
        raise ValueError(f"Provider not configurable: {provider}")
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

    if provider == "telegram":
        return await telegram_notify.ping()

    if provider == "lynx":
        return await lynx.ping()

    if provider == "thermoking":
        return await thermoking.ping()

    if provider == "traccar":
        return await traccar.ping()

    if provider == "docscan":
        return await docscan.ping()

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
