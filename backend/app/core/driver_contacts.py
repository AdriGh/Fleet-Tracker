# -*- coding: utf-8 -*-
"""Snapshot LOCAL de contactos de conductores (emails/teléfonos).

La info sensible (PII) NO se lee en vivo en cada request ni se versiona: se
sincroniza a demanda desde la hoja `Driver info` y se guarda en
`backend/driver_contacts.local.json` (gitignored). El Roster lee de este
snapshot. Pensado como paso previo a migrar todo esto a una base de datos.

Estructura del archivo: { name_key: {name, email, phone, company} }.
"""

from pathlib import Path

from . import datasource
from .. import db
from .contacts import name_key, parse_contacts

# H6: snapshot + overrides en org_setting por-tenant (claves 'driver_contacts'
# y 'driver_emails'); los JSON legacy se importan una vez a la org 'default'.
SETTING_KEY = "driver_contacts"
MANUAL_KEY = "driver_emails"
STORE_PATH = Path(__file__).resolve().parents[2] / "driver_contacts.local.json"  # legacy
# Overrides manuales de email ({name_key: email}), separados para que la
# re-sincronización desde la hoja NO los pise (prioridad sobre el snapshot).
MANUAL_PATH = Path(__file__).resolve().parents[2] / "driver_emails.local.json"  # legacy


def load() -> dict:
    """Snapshot guardado: {name_key: {name, email, phone, company}}."""
    data = db.get_setting(SETTING_KEY, legacy_file=STORE_PATH)
    return data if isinstance(data, dict) else {}


def manual() -> dict:
    """Overrides manuales: {name_key: email}."""
    data = db.get_setting(MANUAL_KEY, legacy_file=MANUAL_PATH)
    return data if isinstance(data, dict) else {}


def set_email(name: str, email: str) -> None:
    """Guarda (o borra si email vacío) un override manual de email por nombre."""
    m = manual()
    key = name_key(name)
    email = (email or "").strip()
    if email:
        m[key] = email
    else:
        m.pop(key, None)
    db.save_setting(MANUAL_KEY, m)


def email_for(name: str) -> str:
    key = name_key(name)
    return manual().get(key) or (load().get(key) or {}).get("email", "")


def info() -> dict:
    """Metadatos del snapshot (cantidad, con email) para la UI."""
    store = load()
    return {
        "exists": bool(store),
        "count": len(store),
        "with_email": sum(1 for v in store.values() if v.get("email")),
    }


def sync_from_sheet() -> dict:
    """Lee `Driver info` EN VIVO una vez y guarda el snapshot local."""
    data = datasource.load_report()
    book = parse_contacts(data.driver_info)
    store: dict = {}
    for c in book.contacts:
        if not c.key:
            continue
        store[c.key] = {
            "name": c.name,
            "email": c.email,
            "phone": c.phone,
            "company": c.company,
        }
    db.save_setting(SETTING_KEY, store)
    return {
        "count": len(store),
        "with_email": sum(1 for v in store.values() if v.get("email")),
        "source": getattr(data, "mode", "?"),
    }
