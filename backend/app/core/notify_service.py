# -*- coding: utf-8 -*-
"""Servicio de Avisos: une datasource + parseo + notify + mailer.

Expone funciones de alto nivel para los endpoints de la API.
"""

from . import datasource, mailer, sms_service
from .cc_routing import region_from_truck
from .contacts import parse_contacts
from .notify import build_notices, render_email, render_sms
from .sheet_report import parse_blocks


def _notice_dict(n, date_label: str) -> dict:
    subject, body, body_html = render_email(n, date_label)
    return {
        "driver": n.driver,
        "company": n.company,
        "region": n.region,
        "email": n.email,
        "cc": n.cc,
        "phone": n.phone,
        "sms_phone": sms_service.to_e164(n.phone),       # E.164 con '+'
        "units": n.units,
        "reasons": n.reasons,
        "review_reason": n.review_reason,
        "subject": subject,
        "body": body,
        "body_html": body_html,
        "sms_text": render_sms(n, date_label),           # cuerpo del SMS
    }


def list_blocks() -> dict:
    """Bloques disponibles por hoja/empresa."""
    data = datasource.load_report()
    blocks = []
    for sheet, values in data.sheets.items():
        parsed = parse_blocks(values)
        blocks.append({
            "sheet": sheet,
            "company": sheet.split()[0],
            "date_labels": list(parsed.keys()),
        })
    settings = mailer.load_settings()
    sms = sms_service.load_settings()
    return {
        "mode": data.mode,
        "spreadsheet": data.spreadsheet,
        "live_error": data.live_error,
        "gmail_configured": settings.configured,
        "dry_run": settings.dry_run or not settings.configured,
        "sender": settings.sender,
        "sms_configured": sms.configured,
        "sms_dry_run": sms.dry_run or not sms.configured,
        "blocks": blocks,
    }


def scan(sheet: str, date_label: str) -> dict:
    """Escanea un bloque y devuelve avisos a enviar y a revisar."""
    data = datasource.load_report()
    values = data.sheets.get(sheet)
    if values is None:
        raise KeyError(f"Sheet '{sheet}' not found.")
    parsed = parse_blocks(values)
    groups = parsed.get(date_label)
    if groups is None:
        raise KeyError(f"Block '{date_label}' not found in '{sheet}'.")
    book = parse_contacts(data.driver_info, region_from_truck)
    notices, review = build_notices(groups, book)
    return {
        "sheet": sheet,
        "company": sheet.split()[0],
        "date_label": date_label,
        "notices": [_notice_dict(n, date_label) for n in notices],
        "review": [_notice_dict(n, date_label) for n in review],
    }


def send(sheet: str, date_label: str, drivers: list[str],
         channels: list[str] | None = None, media: dict | None = None) -> dict:
    """Envía (o simula) los avisos de los conductores indicados.

    `channels`: lista de 'email' | 'sms'.
    `media`: {'type': 'image'|'video', 'url': <pública para SMS/MMS>} (opcional).
    """
    scanned = scan(sheet, date_label)
    email_settings = mailer.load_settings()
    sms = sms_service.load_settings()
    chans = set(channels or ["email"])
    wanted = set(drivers)
    results = []
    for n in scanned["notices"]:
        if n["driver"] not in wanted:
            continue
        row: dict = {"driver": n["driver"]}

        if "email" in chans:
            if n["email"]:
                r = mailer.send_email(email_settings, n["email"], n["cc"],
                                      n["subject"], n["body"], n["body_html"])
                row["email"] = {"to": n["email"], "cc": n["cc"], "ok": r["ok"],
                                "error": r["error"], "simulated": r["simulated"]}
            else:
                row["email"] = {"to": "", "ok": False, "simulated": False,
                                "error": "no email"}

        if "sms" in chans:
            if n["sms_phone"]:
                body = n["sms_text"]
                media_urls: list[str] = []
                if media and media.get("url"):
                    if media.get("type") == "video":
                        body += f"\nVideo: {media['url']}"   # video → link
                    else:
                        media_urls = [media["url"]]          # imagen → MMS
                r = sms_service.send_sms(sms, n["sms_phone"], body, media_urls)
                row["sms"] = {"to": n["sms_phone"], "ok": r["ok"],
                              "error": r.get("error", ""),
                              "simulated": r["simulated"]}
            else:
                row["sms"] = {"to": "", "ok": False, "simulated": False,
                              "error": "no valid phone"}

        results.append(row)
    return {
        "channels": sorted(chans),
        "email_dry_run": email_settings.dry_run or not email_settings.configured,
        "sms_dry_run": sms.dry_run or not sms.configured,
        "results": results,
    }


def _html_from_text(text: str) -> str:
    import html as _html
    return ('<div style="font-family:Arial,Helvetica,sans-serif;'
            'font-size:14px;line-height:1.5">'
            + _html.escape(text).replace("\n", "<br>") + "</div>")


def broadcast(drivers: list[str], channels: list[str] | None,
              subject: str, body: str) -> dict:
    """Envia (o simula) un mensaje propio (de plantilla) a los conductores
    indicados, resolviendo su contacto del contact book. Reusa mailer/sms y
    sustituye {first_name}/{name} por destinatario. Los videos van como links
    dentro del cuerpo (no media adjunta)."""
    from . import driver_contacts, notice_templates
    from .contacts import name_key

    email_settings = mailer.load_settings()
    sms = sms_service.load_settings()
    chans = set(channels or ["email"])
    store = driver_contacts.load()       # {name_key: {name,email,phone,...}}
    results = []
    for name in drivers:
        info = store.get(name_key(name), {})
        email = driver_contacts.email_for(name) or info.get("email", "")
        phone = info.get("phone", "")
        subj = notice_templates.render(subject, name)
        msg = notice_templates.render(body, name)
        row: dict = {"driver": name}

        if "email" in chans:
            if email:
                r = mailer.send_email(email_settings, email, [], subj, msg,
                                      _html_from_text(msg))
                row["email"] = {"to": email, "ok": r["ok"],
                                "error": r["error"], "simulated": r["simulated"]}
            else:
                row["email"] = {"to": "", "ok": False, "simulated": False,
                                "error": "no email"}

        if "sms" in chans:
            if phone:
                r = sms_service.send_sms(sms, phone, msg, [])
                row["sms"] = {"to": phone, "ok": r["ok"],
                              "error": r.get("error", ""),
                              "simulated": r["simulated"]}
            else:
                row["sms"] = {"to": "", "ok": False, "simulated": False,
                              "error": "no valid phone"}

        results.append(row)
    return {
        "channels": sorted(chans),
        "email_dry_run": email_settings.dry_run or not email_settings.configured,
        "sms_dry_run": sms.dry_run or not sms.configured,
        "sent": sum(1 for r in results if (r.get("email") or {}).get("ok")
                    or (r.get("sms") or {}).get("ok")),
        "results": results,
    }


def recipients() -> list[dict]:
    """Conductores con contacto (para el broadcast): nombre + si tienen
    email/telefono."""
    from . import driver_contacts
    out = []
    for info in driver_contacts.load().values():
        name = (info.get("name") or "").strip()
        if not name:
            continue
        out.append({
            "name": name,
            "company": info.get("company", ""),
            "email": info.get("email", ""),
            "phone": info.get("phone", ""),
            "has_email": bool(driver_contacts.email_for(name)
                              or info.get("email")),
            "has_phone": bool(info.get("phone")),
        })
    out.sort(key=lambda d: d["name"])
    return out

