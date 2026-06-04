# -*- coding: utf-8 -*-
"""Servicio de Avisos: une datasource + parseo + notify + mailer.

Expone funciones de alto nivel para los endpoints de la API.
"""

from . import datasource, mailer
from .contacts import parse_contacts
from .notify import build_notices, render_email
from .sheet_report import parse_blocks


def _notice_dict(n, date_label: str) -> dict:
    subject, body = render_email(n, date_label)
    return {
        "driver": n.driver,
        "company": n.company,
        "region": n.region,
        "email": n.email,
        "cc": n.cc,
        "units": n.units,
        "reasons": n.reasons,
        "review_reason": n.review_reason,
        "subject": subject,
        "body": body,
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
    return {
        "mode": data.mode,
        "spreadsheet": data.spreadsheet,
        "gmail_configured": settings.configured,
        "dry_run": settings.dry_run or not settings.configured,
        "sender": settings.sender,
        "blocks": blocks,
    }


def scan(sheet: str, date_label: str) -> dict:
    """Escanea un bloque y devuelve avisos a enviar y a revisar."""
    data = datasource.load_report()
    values = data.sheets.get(sheet)
    if values is None:
        raise KeyError(f"Hoja '{sheet}' no encontrada.")
    parsed = parse_blocks(values)
    groups = parsed.get(date_label)
    if groups is None:
        raise KeyError(f"Bloque '{date_label}' no encontrado en '{sheet}'.")
    book = parse_contacts(data.driver_info)
    notices, review = build_notices(groups, book)
    return {
        "sheet": sheet,
        "company": sheet.split()[0],
        "date_label": date_label,
        "notices": [_notice_dict(n, date_label) for n in notices],
        "review": [_notice_dict(n, date_label) for n in review],
    }


def send(sheet: str, date_label: str, drivers: list[str]) -> dict:
    """Envia (o simula) los avisos de los conductores indicados."""
    scanned = scan(sheet, date_label)
    settings = mailer.load_settings()
    wanted = set(drivers)
    results = []
    for n in scanned["notices"]:
        if n["driver"] not in wanted:
            continue
        res = mailer.send_email(settings, n["email"], n["cc"],
                                n["subject"], n["body"])
        results.append({
            "driver": n["driver"],
            "to": n["email"],
            "cc": n["cc"],
            "ok": res["ok"],
            "error": res["error"],
            "simulated": res["simulated"],
        })
    return {
        "dry_run": settings.dry_run or not settings.configured,
        "results": results,
    }
