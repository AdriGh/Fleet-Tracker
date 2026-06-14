"""Contexto de tenant por request (H6 fase 3).

Mantiene el org_id (organizacion/tenant) del request actual en un ContextVar,
para que la capa de persistencia pueda aislar la data por organizacion sin
pasar el org_id a mano en cada llamada.

Flujo:
- el middleware de auth (main.py) resuelve el usuario y deja su org_id en
  `request.state.org_id`;
- `bind_tenant` (dependencia global del router de la API) lo copia al
  ContextVar DENTRO del contexto del endpoint —donde corren las queries— y lo
  limpia al terminar.

Sin enforcement todavia: la fase 3c consume este contexto (auto-completar
org_id en inserts, auto-filtrar selects via with_loader_criteria) y activa
Row-Level Security en Postgres. Este modulo no importa db ni auth a proposito
(asi db puede importarlo en 3c sin ciclos)."""

from __future__ import annotations

import contextvars

from fastapi import Request

_current_org: contextvars.ContextVar[int | None] = contextvars.ContextVar(
    "current_org", default=None)


def set_current_org(org_id: int | None) -> contextvars.Token:
    """Fija el tenant del contexto actual; devuelve el token para revertir."""
    return _current_org.set(org_id)


def get_current_org() -> int | None:
    """org_id del tenant del request actual, o None si no hay (paths sin
    autenticar como login/health, o trabajos de fondo)."""
    return _current_org.get()


def reset_current_org(token: contextvars.Token) -> None:
    _current_org.reset(token)


async def bind_tenant(request: Request):
    """Dependencia global del router de la API: fija el ContextVar de tenant
    al org_id del request (resuelto por el middleware de auth) durante el
    endpoint y lo limpia al terminar."""
    token = set_current_org(getattr(request.state, "org_id", None))
    try:
        yield
    finally:
        reset_current_org(token)


def current_org() -> int | None:
    """Dependencia para rutas que quieran el org_id del request inyectado."""
    return get_current_org()
