# -*- coding: utf-8 -*-
"""Permisos por rol (fase H4 — RBAC real).

Hasta H3 el enforcement era binario: el middleware exigía token y rol
`admin` para unas pocas rutas. H4 lo vuelve fino con SCOPES concretos y una
matriz rol → scopes. El enforcement vive en el middleware de `main.py`
(`_scope_for(method, path)` mapea cada acción a su scope) y, para el caso
dependiente del body (facturar una WO), en la propia ruta.

Roles (5): admin · dispatcher · safety · mechanic · viewer.
`admin` tiene TODOS los scopes implícitamente. `viewer` no tiene ninguno
(solo lectura). Lectura (GET) nunca exige scope — cualquier autenticado ve.
"""

from __future__ import annotations

# Capacidades de escritura/acción. La lectura no necesita scope.
SCOPES: tuple[str, ...] = (
    "settings.manage",   # Company, terminales, integraciones, usuarios (admin)
    "pii.view",          # ver/editar contactos de conductores sin enmascarar
    "maint.edit",        # crear/editar WO, registrar PM/DOT, parts/vendors, docs
    "wo.invoice",        # facturar una WO + enviar invoice/estimate
    "notices.send",      # enviar avisos (email/SMS REAL)
    "tms.edit",          # crear/editar loads y drivers (dispatch)
    "fleet.edit",        # archivar unidades, unit settings, app settings
    "alerts.manage",     # configurar alertas de flota
)

# Etiquetas legibles para la UI (Settings → Users).
SCOPE_LABELS: dict[str, str] = {
    "settings.manage": "Company, users & integrations",
    "pii.view": "See driver contact info (PII)",
    "maint.edit": "Edit work orders, PM/DOT, parts",
    "wo.invoice": "Invoice work orders & send documents",
    "notices.send": "Send driver notices (email/SMS)",
    "tms.edit": "Dispatch: loads & drivers",
    "fleet.edit": "Fleet: archive, unit & app settings",
    "alerts.manage": "Configure fleet alerts",
}

# Matriz rol → scopes. `admin` se resuelve aparte (todos). Confirmada con el
# usuario (jun-13): safety NO factura ni hace dispatch; mechanic solo
# mantenimiento + flota (sin avisos, PII, TMS ni alertas).
ROLE_SCOPES: dict[str, set[str]] = {
    "admin": set(SCOPES),
    "dispatcher": {"maint.edit", "wo.invoice", "notices.send", "pii.view",
                   "tms.edit", "fleet.edit", "alerts.manage"},
    "safety": {"maint.edit", "notices.send", "pii.view", "fleet.edit",
               "alerts.manage"},
    "mechanic": {"maint.edit", "fleet.edit"},
    "viewer": set(),
}


def has_scope(role: str, scope: str) -> bool:
    if role == "admin":
        return True
    return scope in ROLE_SCOPES.get(role, set())


def scopes_for(role: str) -> list[str]:
    """Lista ordenada de scopes de un rol (para mandarla al frontend)."""
    if role == "admin":
        return list(SCOPES)
    return [s for s in SCOPES if s in ROLE_SCOPES.get(role, set())]
