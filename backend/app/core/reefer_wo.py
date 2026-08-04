# -*- coding: utf-8 -*-
"""Puente reefer -> work order (intersección Taller × Cold Chain).

Cuando un reefer reporta un FAULT CODE (Lynx / Thermo King / Traccar), se
crea solo un work order para esa unidad con el código + contexto,
IDEMPOTENTE: no duplica mientras haya una WO viva para el mismo unit+code.
Es el workflow que ni Fullbay (no ve reefers) ni Samsara (no tiene taller)
pueden hacer — la prueba de la tesis del producto.

Lo dispara el loop de `alerts.py` cuando la regla `reefer_fault_wo` está
habilitada (Settings → Fleet alerts). El cierre/facturación de la WO usa
el hook de campañas existente de `workorders` para el PM.
"""

from __future__ import annotations

from . import reefer, workorders

# Estados no terminales: si hay una WO viva para el mismo fault, no duplicar.
_OPEN_STATUSES = {"open", "assigned", "in_progress", "completed"}

# Alarmas derivadas por software (no son fault codes mecánicos del reefer):
# conectividad y batería del tracker no abren work order.
_SKIP_CODES = {"no_data", "low_battery"}


def _marker(code) -> str:
    """Token estable embebido en el complaint para deduplicar por unit+code."""
    return f"[rf:{code}]"


def _priority(severity: int) -> str:
    return "high" if severity >= 3 else "normal"


def _eligible(alarm: dict, min_severity: int) -> bool:
    code = str(alarm.get("code") or "").strip()
    if not code or code in _SKIP_CODES:
        return False
    try:
        sev = int(alarm.get("severity") or 0)
    except (TypeError, ValueError):
        sev = 0
    return sev >= min_severity


def sync(snapshot: dict, min_severity: int = 2) -> list[dict]:
    """Crea WOs idempotentes desde los fault codes del snapshot de reefers.

    Nunca corre sobre datos demo o no disponibles. Devuelve
    [{wo_id, unit, code, title}] de las WOs NUEVAS creadas (vacío si nada)."""
    # Sobre el simulador solo corre con FLEET_DEMO=1 explicito (banco de
    # pruebas); el demo por falta de credenciales nunca crea work orders.
    allow_demo = reefer.demo_evaluation_enabled()
    if not snapshot.get("available") or (snapshot.get("demo") and not allow_demo):
        return []
    created: list[dict] = []
    for u in snapshot.get("units", []):
        if u.get("demo") and not allow_demo:
            continue
        unit = (u.get("unit") or "").strip()
        if not unit:
            continue
        alarms = [a for a in (u.get("alarms") or [])
                  if _eligible(a, min_severity)]
        if not alarms:
            continue

        # WOs vivas de esta unidad creadas por el puente (para deduplicar).
        existing = [w for w in workorders.list_wos(unit=unit)
                    if w.get("source") == "reefer"
                    and w.get("status") in _OPEN_STATUSES]
        open_markers = " ".join(w.get("complaint") or "" for w in existing)

        for a in alarms:
            code = str(a.get("code"))
            if _marker(code) in open_markers:
                continue                       # ya hay WO viva para este fault
            desc = str(a.get("description") or "").strip()
            action = str(a.get("operator_action") or "").strip()
            try:
                sev = int(a.get("severity") or 0)
            except (TypeError, ValueError):
                sev = 0
            title = f"Reefer fault {code}" + (f": {desc}" if desc else "")

            ctx = []
            if u.get("setpoint_f") is not None:
                ctx.append(f"setpoint {u['setpoint_f']}°F")
            if u.get("return_f") is not None:
                ctx.append(f"return {u['return_f']}°F")
            if u.get("run_mode"):
                ctx.append(f"mode {u['run_mode']}")
            complaint = (
                f"Auto-created from a reefer fault on {unit} "
                f"({u.get('source') or 'reefer'}).\n"
                f"Code {code}: {desc or 'fault reported'}.\n"
                + (f"Operator action: {action}.\n" if action else "")
                + ("Snapshot: " + ", ".join(ctx) + ".\n" if ctx else "")
                + _marker(code))

            wo = workorders.create_wo(
                unit=unit, title=title[:140], complaint=complaint,
                company=u.get("company") or "",
                priority=_priority(sev), source="reefer")
            created.append({"wo_id": wo["id"], "unit": unit,
                            "code": code, "title": title})
    return created
