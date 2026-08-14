# -*- coding: utf-8 -*-
"""Progreso real de "Get set up" (v2.13 — centro de guías del Dashboard).

Autoservicio: la meta es que un shop se onboardee sin llamar a nadie. Cada
paso se marca solo cuando el dato EXISTE de verdad en el tenant — nada de
checkboxes manuales que mienten. En demo casi todo nace hecho (la flota
sintética siembra DVIRs, odómetro, drivers): correcto, la demo muestra el
producto ya andando.

Los checks son EXISTS con `select(Model).limit(1)` a propósito: el filtro
multi-tenant (with_loader_criteria de OrgScoped) aplica a selects de entidad;
un `select(func.count())` de columnas lo esquivaría y contaría otros tenants.
"""

from __future__ import annotations

from sqlalchemy import select

from ..db import (
    MaintRecord, OdometerReading, ReportBlock, SessionLocal, TmsDriver,
    Workflow, WorkOrder,
)
from . import manual_units, samsara


def _exists(session, model) -> bool:
    return session.scalars(select(model).limit(1)).first() is not None


def setup_status() -> dict:
    """Pasos del onboarding con su estado real. `section` = a dónde navega
    el botón "Go" del frontend (ids de NAV_SECTIONS)."""
    demo = samsara._demo()
    with SessionLocal() as session:
        has_dvir = _exists(session, ReportBlock)
        has_wo = _exists(session, WorkOrder)
        has_pm = _exists(session, MaintRecord)
        has_odo = _exists(session, OdometerReading)
        has_drivers = _exists(session, TmsDriver)
        has_workflow = _exists(session, Workflow)
    # Flota: demo, Samsara configurada, o unidades cargadas a mano — cualquiera
    # de las tres significa que Fleet ya muestra algo (sin llamadas de red acá).
    has_fleet = demo or bool(samsara._orgs()) \
        or bool(manual_units.merge_into_fleet([]))
    steps = [
        {"key": "fleet", "label": "Add or import your fleet",
         "done": has_fleet, "section": "flota"},
        {"key": "eld", "label": "Connect your ELD (demo works too)",
         "done": demo or bool(samsara._orgs()), "section": "settings"},
        {"key": "dvir", "label": "Import your first DVIR day",
         "done": has_dvir, "section": "dvir"},
        {"key": "wo", "label": "Create your first work order",
         "done": has_wo, "section": "workorders"},
        {"key": "pm", "label": "Record a PM baseline per unit",
         "done": has_pm, "section": "pm"},
        {"key": "odometer", "label": "Log odometer readings (enables CPM)",
         "done": has_odo, "section": "reports"},
        {"key": "drivers", "label": "Complete your driver roster",
         "done": has_drivers, "section": "settings"},
        # v2.15: el workflow se siembra al abrir el editor por primera vez —
        # el paso es literalmente "andá a conocer tu pre-trip".
        {"key": "workflow", "label": "Review your pre-trip workflow",
         "done": has_workflow, "section": "workflows"},
    ]
    done = sum(1 for s in steps if s["done"])
    return {"steps": steps, "done": done, "total": len(steps),
            "demo": demo}
