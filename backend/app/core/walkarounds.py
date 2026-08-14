# -*- coding: utf-8 -*-
"""Walkaround del driver (v2.16 — elemento 02 del board, el que integra todo).

El pre-trip deja de ser un formulario que se llena desde la cama: la app
camina el camión con el driver — una zona por pantalla, foto donde el
workflow la exige, OK o defecto. Al submit la corrida se MATERIALIZA:

  - paso con defecto → fila en `defect` (source 'walkaround', sin bloque
    DVIR — block_id NULL) con nota y las fotos del paso re-parentadas: el
    defecto entra al pipeline real (Defects → WO → warranty) ya con
    evidencia, sin trabajo extra del driver;
  - paso 'read' con valor → `odometer.log_reading` (el CPM se alimenta del
    walkaround: cada pre-trip es una lectura de odómetro gratis);
  - paso 'sign' → la firma es una foto del paso (canvas del teléfono);
  - los pasos OK con foto quedan como prueba de que la inspección ocurrió
    de verdad (anti pencil-whipping, auditable).

Los pasos de la corrida son un SNAPSHOT del workflow activo al arrancar
(workflows.active_workflow): si el manager edita el workflow a mitad de una
corrida, la corrida no se mueve. La validación del submit es fail-first: si
algo falta, NO se materializa nada (ValueError con el paso señalado).
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import select

from ..db import Defect, SessionLocal, Walkaround, WalkaroundStep
from . import evidence, odometer, workflows

VERDICTS = ("ok", "defect")


def _step_dict(st: WalkaroundStep, photos: int = 0) -> dict:
    return {"id": st.id, "pos": st.pos, "type": st.type, "label": st.label,
            "required": st.required, "verdict": st.verdict,
            "value": st.value, "note": st.note, "photos": photos}


def _run_dict(session, run: Walkaround) -> dict:
    steps = session.scalars(
        select(WalkaroundStep)
        .where(WalkaroundStep.walkaround_id == run.id)
        .order_by(WalkaroundStep.pos)).all()
    counts = evidence.counts("walkstep", [s.id for s in steps])
    return {
        "id": run.id, "unit": run.unit, "driver": run.driver,
        "company": run.company, "workflow_name": run.workflow_name,
        "status": run.status, "started_at": run.started_at.isoformat(),
        "submitted_at": (run.submitted_at.isoformat()
                         if run.submitted_at else None),
        "defects_created": run.defects_created,
        "steps": [_step_dict(s, counts.get(s.id, 0)) for s in steps],
    }


def start(unit: str, driver: str, company: str = "") -> dict:
    """Arranca una corrida: snapshot del workflow activo → walkaround +
    walkaround_step. ValueError si faltan datos o no hay workflow."""
    unit = (unit or "").strip()
    driver = (driver or "").strip()
    if not unit:
        raise ValueError("Pick a unit first.")
    if not driver:
        raise ValueError("Enter the driver's name.")
    wf = workflows.active_workflow()
    if wf is None or not wf["steps"]:
        raise ValueError(
            "No active workflow. Build one in Driver Workflows first.")
    with SessionLocal() as session:
        run = Walkaround(unit=unit[:64], driver=driver[:128],
                         company=(company or "").strip()[:64],
                         workflow_id=wf["id"], workflow_name=wf["name"][:80],
                         status="in_progress", started_at=datetime.now())
        session.add(run)
        session.flush()
        for st in wf["steps"]:
            session.add(WalkaroundStep(
                walkaround_id=run.id, pos=st["pos"], type=st["type"],
                label=st["label"], required=st["required"]))
        session.commit()
        return _run_dict(session, run)


def get(run_id: int) -> dict | None:
    with SessionLocal() as session:
        run = session.get(Walkaround, run_id)
        return None if run is None else _run_dict(session, run)


def _validate(steps: list[WalkaroundStep], by_id: dict[int, dict],
              photo_counts: dict[int, int]) -> None:
    """Fail-first: el primer paso inválido corta el submit entero con el
    número de paso en el mensaje (el driver ve exactamente qué le falta)."""
    for st in steps:
        r = by_id.get(st.id, {})
        verdict = str(r.get("verdict", "")).strip()
        value = str(r.get("value", "")).strip()
        n = st.pos + 1
        if st.type in ("check", "photo"):
            if st.required and verdict not in VERDICTS:
                raise ValueError(f"Step {n} ({st.label}): mark OK or Defect.")
            if verdict and verdict not in VERDICTS:
                raise ValueError(f"Step {n}: bad verdict '{verdict}'.")
        if st.type == "photo" and st.required \
                and photo_counts.get(st.id, 0) == 0:
            raise ValueError(f"Step {n} ({st.label}): a photo is required.")
        if st.type == "read" and st.required:
            try:
                if float(value) <= 0:
                    raise ValueError
            except (TypeError, ValueError):
                raise ValueError(
                    f"Step {n} ({st.label}): enter a valid reading.")
        if st.type == "sign" and st.required \
                and photo_counts.get(st.id, 0) == 0:
            raise ValueError(f"Step {n} ({st.label}): signature is missing.")
        if verdict == "defect" and not str(r.get("note", "")).strip():
            raise ValueError(
                f"Step {n} ({st.label}): describe the defect (note).")


def submit(run_id: int, results: list[dict]) -> dict:
    """Valida y materializa la corrida. Devuelve el resumen final."""
    by_id = {int(r.get("step_id", 0)): r for r in (results or [])}
    with SessionLocal() as session:
        run = session.get(Walkaround, run_id)
        if run is None:
            raise ValueError("Walkaround not found.")
        if run.status != "in_progress":
            raise ValueError("This walkaround was already submitted.")
        steps = session.scalars(
            select(WalkaroundStep)
            .where(WalkaroundStep.walkaround_id == run.id)
            .order_by(WalkaroundStep.pos)).all()
        photo_counts = evidence.counts("walkstep", [s.id for s in steps])
        _validate(steps, by_id, photo_counts)

        # Persistir resultados en los pasos (el snapshot queda completo).
        for st in steps:
            r = by_id.get(st.id, {})
            st.verdict = str(r.get("verdict", "")).strip()[:8]
            st.value = str(r.get("value", "")).strip()[:40]
            st.note = str(r.get("note", "")).strip()[:300]

        # Materializar defectos: una fila REAL en `defect` por paso fallado.
        # Denormalizada como las importadas (company/fecha/driver/unit) para
        # que fluya por Defects → WO sin caso especial. block_id NULL +
        # source 'walkaround' = su certificado de origen.
        today = date.today()
        label = f"{today.month}.{today.day}"
        created = 0
        for st in steps:
            if st.verdict != "defect":
                continue
            d = Defect(block_id=None, source="walkaround",
                       company=run.company, block_date=today,
                       date_label=label, driver=run.driver, unit=run.unit,
                       unit_kind="truck", dvir_type="Pre-trip (walkaround)",
                       status="open",
                       detail=(f"{st.label} — {st.note}" if st.note
                               else st.label),
                       mechanic="", mechanic_notes="")
            session.add(d)
            session.flush()
            # Misma sesión: una segunda sesión de escritura deadlockea
            # SQLite contra la transacción abierta de este submit.
            evidence.reparent("walkstep", st.id, "defect", d.id,
                              session=session)
            created += 1

        run.status = "submitted"
        run.submitted_at = datetime.now()
        run.defects_created = created
        session.commit()

        # Odómetro DESPUÉS del commit del run: log_reading maneja su propia
        # sesión y es idempotente por día — si falla no debe deshacer la
        # corrida (el dato del walkaround vale más que la lectura).
        odo_logged = False
        for st in steps:
            if st.type == "read" and st.value:
                try:
                    odo_logged = odometer.log_reading(
                        run.unit, "", int(float(st.value))) is not None
                except (TypeError, ValueError):
                    odo_logged = False
        out = _run_dict(session, run)
        out["odometer_logged"] = odo_logged
        return out


def recent(limit: int = 8) -> list[dict]:
    """Últimas corridas para la pantalla de inicio (quién inspeccionó qué)."""
    with SessionLocal() as session:
        runs = session.scalars(
            select(Walkaround).order_by(Walkaround.id.desc())
            .limit(limit)).all()
        return [{
            "id": r.id, "unit": r.unit, "driver": r.driver,
            "status": r.status, "started_at": r.started_at.isoformat(),
            "defects_created": r.defects_created,
        } for r in runs]
