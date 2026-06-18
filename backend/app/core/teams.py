# -*- coding: utf-8 -*-
"""Equipos (Settings → Teams).

Un equipo es un grupo explícito de unidades de flota MÁS una lista de
conductores ({name, email}). A diferencia de las terminales, no hay
prefijos ni resolución automática: una unidad pertenece a un equipo solo
si está asignada (pinneada) a él.

`backend/teams.local.json` (gitignored) guarda los equipos
{key, label, drivers} y el mapeo unidad→equipo. Sin archivo, no hay
equipos (la lista vacía es válida: los equipos son opcionales y el admin
los crea desde Settings → Teams).
"""

from __future__ import annotations

import json
import re

from .. import config

PATH = config.BACKEND_DIR / "teams.local.json"

# Los equipos son opcionales: sin config no hay ninguno (a diferencia de
# las terminales, que siempre tienen al menos una de fábrica).
DEFAULTS: list[dict] = []

_MAX_TEAMS = 50
_MAX_DRIVERS = 50


def _load() -> dict:
    if PATH.exists():
        try:
            data = json.loads(PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except (OSError, ValueError):
            pass
    return {}


def _save(data: dict) -> None:
    PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def _clean_drivers(drivers: list) -> list[dict]:
    out: list[dict] = []
    for d in drivers or []:
        if not isinstance(d, dict):
            continue
        name = str(d.get("name", "")).strip()[:60]
        email = str(d.get("email", "")).strip().lower()[:120]
        # Un conductor necesita al menos nombre o email para existir.
        if name or email:
            out.append({"name": name, "email": email})
        if len(out) >= _MAX_DRIVERS:
            break
    return out


def _teams(data: dict | None = None) -> list[dict]:
    data = _load() if data is None else data
    stored = data.get("teams")
    if isinstance(stored, list):
        return [
            {"key": str(t.get("key", "")),
             "label": str(t.get("label", "")),
             "drivers": _clean_drivers(t.get("drivers") or [])}
            for t in stored if isinstance(t, dict) and t.get("key")
        ]
    return json.loads(json.dumps(DEFAULTS))


def _members(data: dict | None = None) -> dict[str, str]:
    data = _load() if data is None else data
    raw = data.get("members")
    if not isinstance(raw, dict):
        return {}
    return {str(u): str(t) for u, t in raw.items() if str(u) and str(t)}


def get_all() -> dict:
    data = _load()
    teams = _teams(data)
    keys = {t["key"] for t in teams}
    # Membresías hacia equipos borrados no se exponen (quedan inertes).
    members = {u: t for u, t in _members(data).items() if t in keys}
    return {"teams": teams, "members": members}


def _slug(label: str, taken: set[str]) -> str:
    base = re.sub(r"[^A-Z0-9]+", "_", label.strip().upper()).strip("_")[:12]
    base = base or "TEAM"
    key, n = base, 2
    while key in taken:
        key = f"{base[:10]}_{n}"
        n += 1
    return key


def save_team(key: str, label: str, drivers: list) -> dict:
    """Crea (key vacío) o edita (key existente) un equipo."""
    label = str(label or "").strip()[:40]
    if not label:
        raise ValueError("Team name is required")
    data = _load()
    teams = _teams(data)
    key = str(key or "").strip().upper()
    cleaned = _clean_drivers(drivers)

    if key:
        for t in teams:
            if t["key"] == key:
                t["label"] = label
                t["drivers"] = cleaned
                break
        else:
            raise ValueError(f"Team {key} does not exist")
    else:
        if len(teams) >= _MAX_TEAMS:
            raise ValueError("Too many teams")
        key = _slug(label, {t["key"] for t in teams})
        teams.append({"key": key, "label": label, "drivers": cleaned})

    data["teams"] = teams
    data["members"] = _members(data)
    _save(data)
    return get_all()


def delete_team(key: str) -> dict:
    key = str(key or "").strip().upper()
    data = _load()
    teams = _teams(data)
    if key not in {t["key"] for t in teams}:
        raise ValueError(f"Team {key} does not exist")
    data["teams"] = [t for t in teams if t["key"] != key]
    data["members"] = {
        u: t for u, t in _members(data).items() if t != key}
    _save(data)
    return get_all()


def assign(team: str, units: list) -> dict:
    """Reemplaza la flota del equipo por `units`.

    Las unidades que estaban en ese equipo y no vienen en la lista quedan
    sin equipo. Una unidad solo puede pertenecer a un equipo a la vez.
    """
    team = str(team or "").strip().upper()
    data = _load()
    teams = _teams(data)
    if team not in {t["key"] for t in teams}:
        raise ValueError(f"Team {team} does not exist")
    members = {u: t for u, t in _members(data).items() if t != team}
    for u in units or []:
        name = str(u).strip()
        if name:
            members[name] = team
    data["teams"] = teams
    data["members"] = members
    _save(data)
    return get_all()


def team_of(unit: str) -> str:
    """Equipo de una unidad, o '' si no pertenece a ninguno."""
    return get_all()["members"].get(str(unit or "").strip(), "")
