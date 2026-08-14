# -*- coding: utf-8 -*-
"""Workflows de inspección del driver (v2.15 — elemento 03 del board).

Cada flota inspecciona distinto (reefer, flatbed, tanker): acá el manager
ARMA el pre-trip de SU flota — pasos tipados (check|photo|read|sign), foto
exigida, obligatoriedad, orden — y el editor muestra en vivo lo que el
driver va a recibir en el teléfono. UN workflow ACTIVO por organización:
el driver no elige, recibe EL pre-trip de su flota. El walkaround PWA
(v2.16) consumirá `active_workflow()` vía GET /api/workflows/active.

Persistencia en `workflow` + `workflow_step` (org-scoped; el aislamiento
por tenant lo hacen los eventos ORM de db.py, igual que el resto). El
guardado es REPLACE-ALL transaccional: el editor manda la lista completa
de pasos y acá se reescribe con pos secuencial — sin diffs finos; un
workflow es chico (decenas de pasos, no miles) y así lo guardado es
exactamente lo que el manager vio en el preview.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import delete, func, select

from ..db import SessionLocal, Workflow, WorkflowStep

# Tipos de paso. Cerrado a propósito: el walkaround (v2.16) renderiza cada
# type con una UI concreta (checkbox / cámara / input numérico / firma);
# un type desconocido sería un paso que el driver no puede completar.
STEP_TYPES = ("check", "photo", "read", "sign")

# Seed del primer workflow del tenant: un pre-trip genérico REAL (luces,
# gomas, acople, odómetro, firma) — el manager edita sobre algo que ya
# funciona en vez de mirar un editor vacío.
_DEFAULT_NAME = "Pre-trip"
_DEFAULT_STEPS = [
    {"type": "photo", "label": "Lights & reflectors", "required": True},
    {"type": "photo", "label": "Tires & wheels", "required": True},
    {"type": "check", "label": "Coupling & air lines", "required": True},
    {"type": "read", "label": "Odometer reading", "required": False},
    {"type": "sign", "label": "Driver signature", "required": True},
]


def _steps_of(session, wid: int) -> list[dict]:
    rows = session.scalars(
        select(WorkflowStep).where(WorkflowStep.workflow_id == wid)
        .order_by(WorkflowStep.pos)).all()
    return [{"id": st.id, "pos": st.pos, "type": st.type,
             "label": st.label, "required": st.required} for st in rows]


def _wf_dict(session, wf: Workflow) -> dict:
    return {
        "id": wf.id, "name": wf.name, "active": wf.active,
        "updated_at": wf.updated_at.isoformat(),
        "steps": _steps_of(session, wf.id),
    }


def _clean_steps(raw: list | None) -> list[dict]:
    """Valida y normaliza los pasos del payload. ValueError con mensaje
    claro (el editor lo muestra tal cual en el toast)."""
    steps = []
    for i, s in enumerate(raw or [], start=1):
        stype = str((s or {}).get("type", "")).strip()
        if stype not in STEP_TYPES:
            raise ValueError(
                f"Step {i}: unknown type '{stype}'. "
                f"Use one of: {', '.join(STEP_TYPES)}.")
        label = str((s or {}).get("label", "")).strip()
        if not label:
            raise ValueError(f"Step {i}: label can't be empty.")
        steps.append({"type": stype, "label": label[:120],
                      "required": bool((s or {}).get("required", False))})
    if not steps:
        raise ValueError("A workflow needs at least one step.")
    return steps


def ensure_default() -> None:
    """Siembra el primer workflow del tenant (idempotente): si la org no
    tiene NINGUNO, crea el "Pre-trip" genérico y lo deja ACTIVO — así el
    editor nunca abre vacío y /workflows/active responde desde el día uno."""
    with SessionLocal() as s:
        if s.scalar(select(func.count()).select_from(Workflow)):
            return
        wf = Workflow(name=_DEFAULT_NAME, active=True,
                      updated_at=datetime.now())
        s.add(wf)
        s.flush()
        for pos, st in enumerate(_DEFAULT_STEPS):
            s.add(WorkflowStep(workflow_id=wf.id, pos=pos, **st))
        s.commit()


def list_workflows() -> list[dict]:
    """Resúmenes para el selector del editor (sin los pasos)."""
    with SessionLocal() as s:
        wfs = s.scalars(select(Workflow).order_by(Workflow.id)).all()
        counts = dict(s.execute(
            select(WorkflowStep.workflow_id, func.count())
            .group_by(WorkflowStep.workflow_id)).all())
        return [{"id": w.id, "name": w.name, "active": w.active,
                 "n_steps": counts.get(w.id, 0),
                 "updated_at": w.updated_at.isoformat()} for w in wfs]


def get_workflow(wid: int) -> dict | None:
    """El workflow con sus pasos ordenados por pos, o None si no existe."""
    with SessionLocal() as s:
        wf = s.scalars(select(Workflow).where(Workflow.id == wid)).first()
        return None if wf is None else _wf_dict(s, wf)


def save_workflow(wid: int | None, payload: dict) -> dict:
    """Crea (wid None) o reemplaza nombre+pasos de un workflow.

    Replace-all en UNA transacción: se borran las hijas y se reinsertan con
    pos secuencial (0..n-1). Si algo del payload no valida, el ValueError
    corta ANTES de tocar la base — nunca queda un workflow a medias."""
    name = str((payload or {}).get("name", "")).strip()
    if not name:
        raise ValueError("The workflow needs a name.")
    steps = _clean_steps((payload or {}).get("steps"))
    with SessionLocal() as s:
        if wid is None:
            wf = Workflow(name=name[:80], active=False,
                          updated_at=datetime.now())
            s.add(wf)
            s.flush()
        else:
            wf = s.scalars(select(Workflow).where(Workflow.id == wid)).first()
            if wf is None:
                raise ValueError("Workflow not found.")
            wf.name = name[:80]
            wf.updated_at = datetime.now()
            s.execute(delete(WorkflowStep)
                      .where(WorkflowStep.workflow_id == wf.id))
        for pos, st in enumerate(steps):
            s.add(WorkflowStep(workflow_id=wf.id, pos=pos, **st))
        s.commit()
        return _wf_dict(s, wf)


def set_active(wid: int) -> None:
    """Activa `wid` y desactiva el resto — el invariante es UN activo por
    org (el walkaround no puede recibir dos pre-trips)."""
    with SessionLocal() as s:
        wf = s.scalars(select(Workflow).where(Workflow.id == wid)).first()
        if wf is None:
            raise ValueError("Workflow not found.")
        for other in s.scalars(select(Workflow)).all():
            other.active = (other.id == wid)
        s.commit()


def delete_workflow(wid: int) -> None:
    """Borra el workflow y sus pasos. Prohibido borrar el ÚNICO (la flota
    quedaría sin pre-trip que darle al driver). Si el borrado era el activo,
    se activa otro: el invariante 'un activo' se sostiene solo."""
    with SessionLocal() as s:
        wfs = s.scalars(select(Workflow).order_by(Workflow.id)).all()
        target = next((w for w in wfs if w.id == wid), None)
        if target is None:
            raise ValueError("Workflow not found.")
        if len(wfs) == 1:
            raise ValueError("Can't delete the only workflow. "
                             "Create another one first.")
        was_active = target.active
        s.execute(delete(WorkflowStep)
                  .where(WorkflowStep.workflow_id == wid))
        s.delete(target)
        if was_active:
            fallback = next(w for w in wfs if w.id != wid)
            fallback.active = True
        s.commit()


def active_workflow() -> dict | None:
    """El workflow ACTIVO con sus pasos ordenados (consumidor futuro: el
    walkaround PWA v2.16). None si el tenant aún no sembró ninguno."""
    with SessionLocal() as s:
        wf = s.scalars(select(Workflow).where(Workflow.active)).first()
        return None if wf is None else _wf_dict(s, wf)
