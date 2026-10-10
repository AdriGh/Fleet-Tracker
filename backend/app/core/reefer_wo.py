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

v2.23: el tipo de la WO (inside/outside) es FIJO desde la creación, así que
para pasar una WO automática a outside el usuario la BORRA y crea otra (sin
el marker [rf:…]). Borrar una WO viva del puente deja el fault "descartado"
(org_setting, sin tabla): mientras el reefer siga reportando ese código no
se recrea; cuando el código desaparece del snapshot se olvida y una próxima
ocurrencia abre WO de nuevo. Además la deduplicación mira el marker en
CUALQUIER WO viva de la unidad, no solo las de source 'reefer'.
"""

from __future__ import annotations

import re
from datetime import datetime

from .. import db
from . import reefer, workorders

# Estados no terminales: si hay una WO viva para el mismo fault, no duplicar.
_OPEN_STATUSES = {"open", "assigned", "in_progress", "completed"}

# Alarmas derivadas por software (no son fault codes mecánicos del reefer):
# conectividad y batería del tracker no abren work order.
_SKIP_CODES = {"no_data", "low_battery"}

# v2.23: faults cuya WO automática el usuario borró mientras seguían
# activos. Forma: {"items": {unit: {code: iso_ts}}}.
_DISMISSED_KEY = "reefer_wo_dismissed"
_MARKER_RE = re.compile(r"\[rf:([^\]]+)\]")


def _marker(code) -> str:
    """Token estable embebido en el complaint para deduplicar por unit+code."""
    return f"[rf:{code}]"


def _dismissed() -> dict:
    """{unit: {code: iso_ts}} de los faults descartados (borrados) del tenant."""
    items = (db.get_setting(_DISMISSED_KEY) or {}).get("items")
    return items if isinstance(items, dict) else {}


def on_wos_deleted(rows: list[dict]) -> None:
    """Hook de workorders.delete_wo (DESPUÉS del commit): cada WO VIVA del
    puente que se borró deja su fault descartado, para que sync() no la
    recree mientras el código siga activo (el usuario la borró a propósito,
    p.ej. para crearla de nuevo como outside work). Una WO ya cerrada no
    descarta nada. `rows` = [{unit, status, source, complaint}]."""
    marks: dict[str, set[str]] = {}
    for r in rows:
        if (r.get("source") != "reefer"
                or r.get("status") not in _OPEN_STATUSES):
            continue
        unit = (r.get("unit") or "").strip()
        codes = _MARKER_RE.findall(r.get("complaint") or "")
        if unit and codes:
            marks.setdefault(unit, set()).update(codes)
    if not marks:
        return
    now = datetime.now().isoformat(timespec="seconds")

    def _add(data):
        items = {u: dict(c) for u, c in
                 ((data or {}).get("items") or {}).items()}
        for unit, codes in marks.items():
            cur = items.setdefault(unit, {})
            for c in codes:
                cur.setdefault(c, now)
        return {"items": items}

    db.update_setting(_DISMISSED_KEY, _add)


def _forget(stale: dict[str, list[str]]) -> None:
    """Olvida los descartes cuyo código ya no reporta el reefer (el fault se
    fue: una próxima ocurrencia vuelve a abrir WO)."""
    def _drop(data):
        items = {u: dict(c) for u, c in
                 ((data or {}).get("items") or {}).items()}
        for unit, codes in stale.items():
            cur = items.get(unit) or {}
            for c in codes:
                cur.pop(c, None)
            if not cur:
                items.pop(unit, None)
        return {"items": items}

    db.update_setting(_DISMISSED_KEY, _drop)


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
    dismissed = _dismissed()
    stale: dict[str, list[str]] = {}
    for u in snapshot.get("units", []):
        if u.get("demo") and not allow_demo:
            continue
        unit = (u.get("unit") or "").strip()
        if not unit:
            continue
        # v2.23: los descartes de esta unidad cuyo código ya no reporta se
        # olvidan (el fault se fue; si vuelve, es una ocurrencia nueva).
        live_codes = {str(a.get("code")) for a in (u.get("alarms") or [])}
        gone = [c for c in dismissed.get(unit) or {} if c not in live_codes]
        if gone:
            stale[unit] = gone
        alarms = [a for a in (u.get("alarms") or [])
                  if _eligible(a, min_severity)]
        if not alarms:
            continue

        # WOs vivas de esta unidad con el marker del fault (para deduplicar).
        # v2.23: de CUALQUIER source/tipo, no solo las que creó el puente.
        existing = [w for w in workorders.list_wos(unit=unit)
                    if w.get("status") in _OPEN_STATUSES]
        open_markers = " ".join(w.get("complaint") or "" for w in existing)

        for a in alarms:
            code = str(a.get("code"))
            if _marker(code) in open_markers:
                continue                       # ya hay WO viva para este fault
            # El usuario borró la WO de este fault mientras seguía activo
            # (lectura fresca: el borrado pudo pasar durante este sync).
            if code in (_dismissed().get(unit) or {}):
                continue
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
    if stale:
        _forget(stale)
    return created
