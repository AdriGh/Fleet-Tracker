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
    "tms.edit",          # editar perfil/compliance de conductores (roster)
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
    "tms.edit": "Driver roster & compliance",
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


# ===== RBAC editable por-org (Increment 5b) =================================
# La matriz efectiva de una org sale de los defaults hardcodeados de arriba,
# SALVO que la org haya customizado (filas en `role_scope`), en cuyo caso su
# matriz es autoritativa. TODO lo de abajo toma `org_id` como primer argumento.
# Propiedades de seguridad:
#   - Sin overrides (org sin filas) -> IDÉNTICO a los defaults de siempre.
#   - `admin` SIEMPRE tiene todos los scopes (no editable).
#   - Fail-safe: ante cualquier error de lectura -> defaults (no deja a nadie
#     afuera). Cache por-org en memoria, invalidado al guardar (deploy es
#     single-worker, así que el cache es consistente en el proceso).

_MARKER = "__custom__"     # fila sentinela: marca que la org está customizada
_cache: dict = {}          # org_id -> dict[role -> set(scopes)]


def _defaults() -> dict[str, set[str]]:
    return {r: set(s) for r, s in ROLE_SCOPES.items()}


def _load_effective(org_id) -> dict[str, set[str]]:
    """Lee la matriz efectiva de una org desde `role_scope`. Sin filas o ante
    error -> defaults. Con filas -> autoritativa (roles sin filas = sin scopes;
    admin siempre completo). Filtra por org_id EXPLÍCITO (correcto haya o no
    contexto de tenant en el auto-scope de SessionLocal)."""
    if org_id is None:
        return _defaults()
    try:
        from sqlalchemy import select as _select
        from ..db import RoleScope, SessionLocal
        with SessionLocal() as session:
            rows = session.execute(
                _select(RoleScope.role, RoleScope.scope)
                .where(RoleScope.org_id == org_id)).all()
    except Exception:
        return _defaults()
    if not rows:
        return _defaults()
    eff = {r: set() for r in ROLE_SCOPES}
    for role, scope in rows:
        if role == _MARKER or scope == _MARKER:
            continue
        if scope in SCOPES and role in ROLE_SCOPES:
            eff[role].add(scope)
    eff["admin"] = set(SCOPES)  # admin nunca se restringe
    return eff


def effective_role_scopes(org_id) -> dict[str, set[str]]:
    if org_id is None:
        return _defaults()
    cached = _cache.get(org_id)
    if cached is not None:
        return cached
    eff = _load_effective(org_id)
    _cache[org_id] = eff
    return eff


def invalidate(org_id=None) -> None:
    if org_id is None:
        _cache.clear()
    else:
        _cache.pop(org_id, None)


def has_scope(org_id, role: str, scope: str) -> bool:
    if role == "admin":
        return True
    return scope in effective_role_scopes(org_id).get(role, set())


def scopes_for(org_id, role: str) -> list[str]:
    """Lista ordenada de scopes de un rol en una org (para el frontend)."""
    if role == "admin":
        return list(SCOPES)
    eff = effective_role_scopes(org_id).get(role, set())
    return [s for s in SCOPES if s in eff]


def matrix(org_id) -> dict:
    """Matriz rol → capacidad para la UI de permisos, según la org.

    Cada celda es 'edit' (el rol tiene el scope) o 'view' (la lectura nunca
    exige scope, así que todos ven). `editable: True` — el admin puede
    guardarla; la columna admin queda lockeada en 'edit'."""
    eff = effective_role_scopes(org_id)
    roles = list(ROLE_SCOPES.keys())
    return {
        "roles": roles,
        "scopes": [{"id": s, "label": SCOPE_LABELS.get(s, s)} for s in SCOPES],
        "matrix": {
            r: {s: ("edit" if s in eff.get(r, set()) else "view")
                for s in SCOPES}
            for r in roles
        },
        "editable": True,
    }


def save_matrix(org_id, grants: dict) -> dict:
    """Persiste la matriz de una org: borra sus overrides y reescribe los
    grants {rol: [scopes]} + una fila marcador (para que 'customizada' se
    detecte aunque algún rol quede sin scopes). `admin` se ignora (siempre
    full). Solo roles/scopes conocidos. Invalida el cache. org_id EXPLÍCITO."""
    if org_id is None:
        raise ValueError("no organization in context")
    from sqlalchemy import delete as _delete
    from ..db import RoleScope, SessionLocal
    with SessionLocal() as session:
        session.execute(_delete(RoleScope).where(RoleScope.org_id == org_id))
        session.add(RoleScope(org_id=org_id, role=_MARKER, scope=_MARKER))
        for role, scopes in (grants or {}).items():
            if role == "admin" or role not in ROLE_SCOPES:
                continue
            for scope in set(scopes or []):
                if scope in SCOPES:
                    session.add(RoleScope(
                        org_id=org_id, role=role, scope=scope))
        session.commit()
    invalidate(org_id)
    return matrix(org_id)
