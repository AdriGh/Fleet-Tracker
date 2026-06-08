"""Lectura de la hoja `Driver info` (contactos de conductores).

Columnas esperadas (el orden no importa; se detectan por encabezado):
    DRIVER NAME, PHONE, EMAIL, COMPANY, Truck#

El cruce con el nombre del conductor del reporte se hace por una clave
normalizada (mayusculas, sin acentos ni signos, espacios colapsados), para
tolerar diferencias de mayusculas/espacios. Si el nombre no coincide exacto
(p. ej. un error de tipeo en la hoja), el conductor queda sin contacto y se
deriva a la lista de "revisar".
"""

import re
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass


def name_key(name) -> str:
    """Clave normalizada de un nombre para comparar de forma robusta."""
    s = unicodedata.normalize("NFKD", str(name or ""))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.upper()
    s = re.sub(r"[^A-Z0-9 ]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


@dataclass
class Contact:
    name: str
    phone: str
    email: str
    company: str
    truck: str
    region: str | None
    key: str


def _find_col(headers: list[str], *needles: str) -> int | None:
    for i, h in enumerate(headers):
        hl = str(h or "").strip().lower()
        if any(n in hl for n in needles):
            return i
    return None


class ContactBook:
    """Coleccion de contactos con busqueda por nombre normalizado."""

    def __init__(self, contacts: list[Contact]):
        self.contacts = contacts
        self._by_key: dict[str, Contact] = {}
        self.duplicates: list[str] = []
        for c in contacts:
            if c.key in self._by_key:
                self.duplicates.append(c.name)
            else:
                self._by_key[c.key] = c

    def match(self, driver_name) -> Contact | None:
        return self._by_key.get(name_key(driver_name))

    def __len__(self) -> int:
        return len(self.contacts)


def parse_contacts(
    rows: list[list],
    region_resolver: Callable[[str], str | None] | None = None,
) -> ContactBook:
    """Convierte las filas de la hoja `Driver info` en un ContactBook.

    `rows` es una lista de filas (cada una lista de celdas); la primera fila
    son los encabezados.

    `region_resolver` (opcional): funcion que mapea un `Truck#` a su region.
    Se inyecta para que este modulo (matching de nombres) no dependa de la
    logica de ruteo por region (`cc_routing`). Si no se pasa, `Contact.region`
    queda en None y quien necesite la region la resuelve aparte.
    """
    if not rows:
        return ContactBook([])
    headers = [str(h or "") for h in rows[0]]
    i_name = _find_col(headers, "driver", "name", "nombre")
    i_phone = _find_col(headers, "phone", "tel")
    i_email = _find_col(headers, "email", "mail", "correo")
    i_company = _find_col(headers, "company", "empresa")
    i_truck = _find_col(headers, "truck", "unit", "camion")

    def cell(row, idx):
        if idx is None or idx >= len(row) or row[idx] is None:
            return ""
        return str(row[idx]).strip()

    contacts: list[Contact] = []
    for row in rows[1:]:
        name = cell(row, i_name)
        email = cell(row, i_email)
        if not name and not email:
            continue
        truck = cell(row, i_truck)
        contacts.append(Contact(
            name=name,
            phone=cell(row, i_phone),
            email=email,
            company=cell(row, i_company),
            truck=truck,
            region=region_resolver(truck) if region_resolver else None,
            key=name_key(name),
        ))
    return ContactBook(contacts)
