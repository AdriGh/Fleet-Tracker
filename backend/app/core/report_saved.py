# -*- coding: utf-8 -*-
"""Reportes guardados y favoritos (v2.22, pestañas Mine / Org de Reports).

- Reporte guardado: nombre + descripción + ReportSpec validada por el motor
  + visibilidad 'mine' (solo el dueño) u 'org' (toda la org). Las reglas de
  permiso viven acá y la ruta solo pasa `can_manage` (= el usuario tiene
  maint.edit): crear/pasar a 'org' y editar/borrar un reporte 'org' ajeno
  lo exigen; un reporte 'mine' solo lo toca su dueño.
- Favoritos: ★ por usuario sobre 'sys:<slug>' o 'saved:<id>'.
- resolve(ref, version, overrides): la spec efectiva de un ref (lo usan
  run, export y los schedules).

Mensajes de error en inglés (ValueError -> 400, PermissionError -> 403,
None -> 404).
"""

from __future__ import annotations

import json
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ..db import ReportFavorite, ReportSchedule, SavedReport, SessionLocal
from . import report_engine, report_library, tenant

VISIBILITIES = ("mine", "org")
_NAME_MSG = "report name is required"
_VIS_MSG = "visibility must be mine or org"
_PERM_MSG = "you can't change this report"
_ORG_PERM_MSG = "sharing a report with the organization needs edit rights"
_OVERRIDE_KEYS = ("columns", "filters", "sort", "time", "group_by", "limit",
                  "totals", "chart")


def _now() -> datetime:
    return datetime.now()


def _iso(dt: datetime | None) -> str | None:
    return dt.replace(microsecond=0).isoformat() if dt else None


def _org() -> int:
    org = tenant.get_current_org()
    if org is None:
        raise ValueError("no organization in context")
    return org


def _visible(r: SavedReport, user_id: int | None) -> bool:
    return r.visibility == "org" or (user_id is not None
                                     and r.owner_user_id == user_id)


def _can_edit(r: SavedReport, user_id: int | None, can_manage: bool) -> bool:
    if r.owner_user_id is not None and r.owner_user_id == user_id:
        return True
    return r.visibility == "org" and can_manage


def saved_dict(r: SavedReport, user_id: int | None = None,
               can_manage: bool = False, with_spec: bool = True) -> dict:
    try:
        spec = json.loads(r.spec_json or "{}")
    except ValueError:
        spec = {}
    out = {
        "id": r.id,
        "ref": f"saved:{r.id}",
        "name": r.name,
        "description": r.description or "",
        "visibility": r.visibility,
        "owner_user_id": r.owner_user_id,
        "mine": user_id is not None and r.owner_user_id == user_id,
        "can_edit": _can_edit(r, user_id, can_manage),
        # Siempre como ref ('sys:<slug>' | 'saved:<id>' | ''), igual que las
        # claves de la librería del frontend ("Based on: <nombre>").
        "based_on": _based_on_ref(r.based_on),
        "source": spec.get("source", ""),
        "created_at": _iso(r.created_at),
        "updated_at": _iso(r.updated_at),
    }
    if with_spec:
        out["spec"] = spec
    return out


def _clean_name(raw) -> str:
    name = " ".join(str(raw or "").split())[:160]
    if not name:
        raise ValueError(_NAME_MSG)
    return name


def _clean_spec(raw) -> str:
    plan = report_engine.validate(raw)          # ValueError si no valida
    return json.dumps(report_engine.spec_dict(plan.spec), ensure_ascii=False)


def _based_on_ref(stored: str | None) -> str:
    """based_on guardado -> ref. Filas previas guardaban el slug suelto."""
    v = (stored or "").strip()
    if not v or v.startswith(("sys:", "saved:")):
        return v
    return f"sys:{v}"


def _clean_based_on(raw, user_id: int | None = None) -> str:
    """Origen de un reporte guardado: 'sys:<slug>' (o el slug suelto) de la
    librería, o 'saved:<id>' de OTRO guardado visible para el usuario (p.ej.
    "Save as mine" de un reporte de la org que no puede editar). Se guarda
    como ref con prefijo."""
    ref = str(raw or "").strip()
    if not ref:
        return ""
    if ref.startswith("saved:"):
        try:
            rid = int(ref[6:])
        except ValueError:
            raise ValueError(f"unknown report '{ref}'") from None
        org = _org()
        with SessionLocal() as s:
            r = s.get(SavedReport, rid)
            if r is None or r.org_id != org or not _visible(r, user_id):
                raise ValueError(f"unknown report '{ref}'")
        return f"saved:{rid}"
    slug = ref[4:] if ref.startswith("sys:") else ref
    if report_library.get_system(slug) is None:
        raise ValueError(f"unknown system report '{slug}'")
    return f"sys:{slug}"[:80]


# ----- CRUD -------------------------------------------------------------------

def list_saved(user_id: int | None, can_manage: bool = False) -> list[dict]:
    org = _org()
    with SessionLocal() as s:
        rows = s.scalars(select(SavedReport).where(
            SavedReport.org_id == org).order_by(SavedReport.name)).all()
        return [saved_dict(r, user_id, can_manage, with_spec=False)
                for r in rows if _visible(r, user_id)]


def get_saved(report_id: int, user_id: int | None,
              can_manage: bool = False) -> dict | None:
    org = _org()
    with SessionLocal() as s:
        r = s.get(SavedReport, report_id)
        if r is None or r.org_id != org or not _visible(r, user_id):
            return None
        return saved_dict(r, user_id, can_manage)


def create_saved(data: dict, user_id: int | None,
                 can_manage: bool = False) -> dict:
    org = _org()
    vis = str(data.get("visibility") or "mine")
    if vis not in VISIBILITIES:
        raise ValueError(_VIS_MSG)
    if vis == "org" and not can_manage:
        raise PermissionError(_ORG_PERM_MSG)
    now = _now()
    r = SavedReport(
        org_id=org,
        name=_clean_name(data.get("name")),
        description=str(data.get("description") or "").strip()[:2000],
        owner_user_id=user_id,
        visibility=vis,
        spec_json=_clean_spec(data.get("spec")),
        based_on=_clean_based_on(data.get("based_on"), user_id),
        created_at=now, updated_at=now)
    with SessionLocal() as s:
        s.add(r)
        s.commit()
        return saved_dict(r, user_id, can_manage)


def update_saved(report_id: int, data: dict, user_id: int | None,
                 can_manage: bool = False) -> dict | None:
    org = _org()
    with SessionLocal() as s:
        r = s.get(SavedReport, report_id)
        if r is None or r.org_id != org or not _visible(r, user_id):
            return None
        if not _can_edit(r, user_id, can_manage):
            raise PermissionError(_PERM_MSG)
        if "name" in data:
            r.name = _clean_name(data.get("name"))
        if "description" in data:
            r.description = str(data.get("description") or "").strip()[:2000]
        if "spec" in data:
            r.spec_json = _clean_spec(data.get("spec"))
        if "visibility" in data:
            vis = str(data.get("visibility") or "")
            if vis not in VISIBILITIES:
                raise ValueError(_VIS_MSG)
            if vis == "org" and r.visibility != "org" and not can_manage:
                raise PermissionError(_ORG_PERM_MSG)
            if vis == "mine" and r.visibility == "org" and \
                    r.owner_user_id != user_id:
                # Un reporte compartido de otro no se "privatiza" a nombre
                # de quien lo edita: se vuelve suyo solo si es el dueño.
                raise PermissionError(_PERM_MSG)
            r.visibility = vis
        r.updated_at = _now()
        s.commit()
        return saved_dict(r, user_id, can_manage)


def delete_saved(report_id: int, user_id: int | None,
                 can_manage: bool = False) -> bool | None:
    org = _org()
    with SessionLocal() as s:
        r = s.get(SavedReport, report_id)
        if r is None or r.org_id != org or not _visible(r, user_id):
            return None
        if not _can_edit(r, user_id, can_manage):
            raise PermissionError(_PERM_MSG)
        ref = f"saved:{r.id}"
        s.delete(r)
        for fav in s.scalars(select(ReportFavorite).where(
                ReportFavorite.org_id == org,
                ReportFavorite.report_ref == ref)).all():
            s.delete(fav)
        # Los envíos programados de este reporte se van con él: si quedaran
        # huérfanos, en SQLite un reporte nuevo puede reusar el id y el
        # schedule mandaría por email un reporte que nadie eligió.
        for sch in s.scalars(select(ReportSchedule).where(
                ReportSchedule.org_id == org,
                ReportSchedule.report_ref == ref)).all():
            s.delete(sch)
        s.commit()
        return True


# ----- Favoritos -----------------------------------------------------------------

def list_favorites(user_id: int | None) -> list[str]:
    if user_id is None:
        return []
    org = _org()
    with SessionLocal() as s:
        return [r for (r,) in s.execute(
            select(ReportFavorite.report_ref).where(
                ReportFavorite.org_id == org,
                ReportFavorite.user_id == user_id)
            .order_by(ReportFavorite.id)).all()]


def _check_ref(ref: str, user_id: int | None) -> str:
    ref = str(ref or "").strip()
    if ref.startswith("sys:"):
        if report_library.get_system(ref[4:]) is None:
            raise ValueError(f"unknown report '{ref}'")
        return ref
    if ref.startswith("saved:"):
        try:
            rid = int(ref[6:])
        except ValueError:
            raise ValueError(f"unknown report '{ref}'") from None
        if get_saved(rid, user_id) is None:
            raise ValueError(f"unknown report '{ref}'")
        return f"saved:{rid}"
    raise ValueError("report ref must be sys:<slug> or saved:<id>")


def add_favorite(ref: str, user_id: int | None) -> list[str]:
    if user_id is None:
        raise ValueError("favorites need a signed-in user")
    org = _org()
    ref = _check_ref(ref, user_id)
    with SessionLocal() as s:
        exists = s.scalar(select(ReportFavorite.id).where(
            ReportFavorite.org_id == org, ReportFavorite.user_id == user_id,
            ReportFavorite.report_ref == ref))
        if exists is None:
            s.add(ReportFavorite(org_id=org, user_id=user_id,
                                 report_ref=ref, created_at=_now()))
            try:
                s.commit()
            except IntegrityError:        # doble clic concurrente
                s.rollback()
    return list_favorites(user_id)


def remove_favorite(ref: str, user_id: int | None) -> list[str]:
    if user_id is None:
        return []
    org = _org()
    ref = str(ref or "").strip()
    with SessionLocal() as s:
        for fav in s.scalars(select(ReportFavorite).where(
                ReportFavorite.org_id == org,
                ReportFavorite.user_id == user_id,
                ReportFavorite.report_ref == ref)).all():
            s.delete(fav)
        s.commit()
    return list_favorites(user_id)


# ----- Resolución de refs ------------------------------------------------------------

def resolve(ref: str, version: str | None = None,
            overrides: dict | None = None, user_id: int | None = None,
            system: bool = False) -> tuple[dict, dict]:
    """(spec efectiva, meta {ref, name, version, version_label, slug?}).

    `system=True` (scheduler) ignora la visibilidad de los guardados: un
    schedule de la org ejecuta el reporte aunque sea 'mine' de quien lo
    creó. ValueError si el ref no existe / no es visible."""
    ref = str(ref or "").strip()
    meta: dict = {"ref": ref}
    if ref.startswith("sys:"):
        slug = ref[4:]
        spec, v = report_library.spec_for(slug, version)
        r = report_library.get_system(slug)
        meta.update({"name": r["name"], "slug": slug, "version": v["key"],
                     "version_label": v["label"], "kind": "system"})
    elif ref.startswith("saved:"):
        try:
            rid = int(ref[6:])
        except ValueError:
            raise ValueError(f"unknown report '{ref}'") from None
        org = _org()
        with SessionLocal() as s:
            r = s.get(SavedReport, rid)
            if r is None or r.org_id != org or (
                    not system and not _visible(r, user_id)):
                raise ValueError(f"unknown report '{ref}'")
            try:
                spec = json.loads(r.spec_json or "{}")
            except ValueError:
                spec = {}
            meta.update({"name": r.name, "version": "", "version_label": "",
                         "kind": "saved", "id": r.id})
    else:
        raise ValueError("report ref must be sys:<slug> or saved:<id>")
    for k, v in (overrides or {}).items():
        if k not in _OVERRIDE_KEYS:
            raise ValueError(f"can't override '{k}' (allowed: "
                             + ", ".join(_OVERRIDE_KEYS) + ")")
        if v is None:
            spec.pop(k, None)
        else:
            spec[k] = v
    return spec, meta
