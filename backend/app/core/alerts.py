# -*- coding: utf-8 -*-
"""Motor de alertas de flota (fase G3).

Reglas evaluadas sobre el snapshot de tracking.load_live():
- speeding   : speed_mph > umbral
- idle       : motor en Idle continuo > N minutos
- low_fuel   : fuel_pct <= umbral
- low_def    : def_pct <= umbral
- no_gps     : último ping GPS hace más de N horas

Config en `backend/alerts.local.json` (gitignored). Canales:
- in-app SIEMPRE (eventos en SQLite -> feed del Dashboard + toasts).
- email/SMS SOLO si el usuario los habilita explícitamente (default
  apagado: el email de la app envía EN REAL — un umbral mal puesto no
  puede convertirse en spam). Cooldown de 60 min por (unidad, regla) y
  tope de envíos externos por ciclo.

El loop corre en background (startup de FastAPI) cada 60 s únicamente
si hay alguna regla habilitada.
"""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timedelta

from sqlalchemy import select, update

from .. import config
from ..db import (
    AlertEvent, SessionLocal, default_org_id, get_setting, save_setting,
)
from . import tenant
from . import (
    mailer, odometer, reefer, reefer_wo, sms_service, tracking, unit_settings,
)

SETTING_KEY = "alerts"
SETTINGS_PATH = config.BACKEND_DIR / "alerts.local.json"   # legacy (migracion)

LOOP_SECONDS = 60
COOLDOWN_S = 60 * 60          # no repetir la misma alerta de una unidad
MAX_EXTERNAL_PER_CYCLE = 10   # tope duro de envíos externos por ciclo
EVENTS_KEEP = 500             # retención de eventos en la tabla

DEFAULTS: dict = {
    "rules": {
        "speeding": {"enabled": False, "mph": 75},
        "idle": {"enabled": False, "minutes": 45},
        "low_fuel": {"enabled": False, "pct": 15},
        "low_def": {"enabled": False, "pct": 10},
        "no_gps": {"enabled": False, "hours": 24},
        "reefer_temp": {"enabled": False, "deviation_f": 5},
        # Puente reefer -> work order: crea una WO desde fault codes del
        # reefer con severidad >= min_severity (1 info · 2 check · 3 urgente).
        "reefer_fault_wo": {"enabled": False, "min_severity": 2},
    },
    # email/sms apagados por defecto: el email envía EN REAL.
    "channels": {"email": False, "sms": False},
    "recipients": {"emails": [], "phones": []},
}

RULE_LABEL = {
    "speeding": "Speeding",
    "idle": "Excessive idle",
    "low_fuel": "Low fuel",
    "low_def": "Low DEF",
    "no_gps": "No GPS signal",
    "reefer_temp": "Reefer temp deviation",
    "reefer_fault_wo": "Reefer fault → work order",
}

# (vehicle_id, rule) -> epoch del último disparo (cooldown en memoria).
_last_fired: dict[tuple[str, str], float] = {}


# ----- Config -----------------------------------------------------------

def get_settings() -> dict:
    data = get_setting(SETTING_KEY, legacy_file=SETTINGS_PATH) or {}
    out = json.loads(json.dumps(DEFAULTS))  # deep copy
    for rule, cfg in (data.get("rules") or {}).items():
        if rule in out["rules"] and isinstance(cfg, dict):
            out["rules"][rule].update({
                k: cfg[k] for k in out["rules"][rule] if k in cfg})
    ch = data.get("channels") or {}
    out["channels"]["email"] = bool(ch.get("email", False))
    out["channels"]["sms"] = bool(ch.get("sms", False))
    rec = data.get("recipients") or {}
    out["recipients"]["emails"] = [
        str(e).strip() for e in (rec.get("emails") or []) if str(e).strip()]
    out["recipients"]["phones"] = [
        str(p).strip() for p in (rec.get("phones") or []) if str(p).strip()]
    return out


def save_settings(new: dict) -> dict:
    cur = get_settings()
    for rule, cfg in (new.get("rules") or {}).items():
        if rule in cur["rules"] and isinstance(cfg, dict):
            for k in cur["rules"][rule]:
                if k in cfg:
                    cur["rules"][rule][k] = (
                        bool(cfg[k]) if k == "enabled"
                        else max(1, int(cfg[k])))
    ch = new.get("channels") or {}
    if "email" in ch:
        cur["channels"]["email"] = bool(ch["email"])
    if "sms" in ch:
        cur["channels"]["sms"] = bool(ch["sms"])
    rec = new.get("recipients") or {}
    if "emails" in rec:
        cur["recipients"]["emails"] = [
            str(e).strip() for e in rec["emails"] if str(e).strip()][:10]
    if "phones" in rec:
        cur["recipients"]["phones"] = [
            str(p).strip() for p in rec["phones"] if str(p).strip()][:10]
    save_setting(SETTING_KEY, cur)
    return cur


def any_rule_enabled(cfg: dict | None = None) -> bool:
    cfg = cfg or get_settings()
    return any(r.get("enabled") for r in cfg["rules"].values())


# ----- Evaluación -------------------------------------------------------

def _check_vehicle(v: dict, rules: dict, now_ms: float) -> list[dict]:
    """Eventos candidatos de UNA unidad (sin cooldown todavía)."""
    out = []

    def hit(rule: str, value: str, message: str):
        out.append({"rule": rule, "value": value, "message": message})

    spd = rules["speeding"]
    if spd["enabled"] and v["speed_mph"] > spd["mph"]:
        hit("speeding", f"{v['speed_mph']:.0f} mph",
            f"{v['unit']} at {v['speed_mph']:.0f} mph "
            f"(limit {spd['mph']}) near {v['location'] or 'unknown'}")

    idle = rules["idle"]
    idle_s = v.get("idle_for_s")
    if idle["enabled"] and idle_s and idle_s >= idle["minutes"] * 60:
        hit("idle", f"{idle_s // 60} min",
            f"{v['unit']} idling for {idle_s // 60} min "
            f"at {v['location'] or 'unknown'}")

    fuel = rules["low_fuel"]
    if (fuel["enabled"] and v.get("fuel_pct") is not None
            and v["fuel_pct"] <= fuel["pct"]):
        hit("low_fuel", f"{v['fuel_pct']}%",
            f"{v['unit']} fuel at {v['fuel_pct']}% "
            f"(threshold {fuel['pct']}%)")

    def_r = rules["low_def"]
    if (def_r["enabled"] and v.get("def_pct") is not None
            and v["def_pct"] <= def_r["pct"]):
        hit("low_def", f"{v['def_pct']}%",
            f"{v['unit']} DEF at {v['def_pct']}% "
            f"(threshold {def_r['pct']}%)")

    gps = rules["no_gps"]
    if gps["enabled"] and v.get("gps_time"):
        try:
            ts = datetime.fromisoformat(
                v["gps_time"].replace("Z", "+00:00")).timestamp()
            hours = (now_ms / 1000 - ts) / 3600
            if hours >= gps["hours"]:
                hit("no_gps", f"{hours:.0f} h",
                    f"{v['unit']} has not reported GPS in {hours:.0f} h")
        except ValueError:
            pass

    return out


def evaluate(track: dict, cfg: dict | None = None) -> list[dict]:
    """Evalúa el snapshot y PERSISTE los eventos nuevos. Devuelve los
    eventos recién creados (ya con cooldown y mute aplicados)."""
    cfg = cfg or get_settings()
    if not any_rule_enabled(cfg) or not track.get("available"):
        return []

    muted = unit_settings.muted_units()
    now = time.time()
    now_ms = now * 1000
    created: list[dict] = []

    with SessionLocal() as session:
        for v in track.get("vehicles", []):
            if v["unit"] in muted:
                continue
            for c in _check_vehicle(v, cfg["rules"], now_ms):
                key = (v["id"], c["rule"])
                if now - _last_fired.get(key, 0) < COOLDOWN_S:
                    continue
                _last_fired[key] = now
                ev = AlertEvent(
                    ts=datetime.now(),
                    vehicle_id=v["id"],
                    unit=v["unit"],
                    company=v.get("company") or "",
                    rule=c["rule"],
                    value=c["value"],
                    message=c["message"],
                    acked=False,
                )
                session.add(ev)
                session.flush()
                created.append({
                    "id": ev.id,
                    "ts": ev.ts.isoformat(),
                    "unit": ev.unit,
                    "company": ev.company,
                    "rule": ev.rule,
                    "value": ev.value,
                    "message": ev.message,
                })
        # Retención: borrar lo más viejo por encima del tope.
        ids = session.scalars(
            select(AlertEvent.id).order_by(AlertEvent.id.desc())
            .offset(EVENTS_KEEP)).all()
        if ids:
            for ev in session.scalars(
                    select(AlertEvent).where(AlertEvent.id.in_(ids))):
                session.delete(ev)
        session.commit()

    return created


def evaluate_reefer(snapshot: dict, cfg: dict | None = None) -> list[dict]:
    """Regla reefer_temp: |return − setpoint| > umbral. SOLO con datos
    reales (jamás demo). Mismo cooldown/mute que el resto."""
    cfg = cfg or get_settings()
    rule = cfg["rules"].get("reefer_temp") or {}
    # Sobre datos demo solo se evalúa con FLEET_DEMO=1 explícito (banco de
    # pruebas). El demo por falta de credenciales nunca dispara alertas.
    allow_demo = reefer.demo_evaluation_enabled()
    if (not rule.get("enabled") or not snapshot.get("available")
            or (snapshot.get("demo") and not allow_demo)):
        return []

    muted = unit_settings.muted_units()
    now = time.time()
    threshold = float(rule.get("deviation_f") or 5)
    created: list[dict] = []

    with SessionLocal() as session:
        for u in snapshot.get("units", []):
            if u["unit"] in muted or (u.get("demo") and not allow_demo):
                continue
            sp, ret = u.get("setpoint_f"), u.get("return_f")
            if sp is None or ret is None:
                continue
            dev = abs(ret - sp)
            if dev <= threshold:
                continue
            key = (u["id"], "reefer_temp")
            if now - _last_fired.get(key, 0) < COOLDOWN_S:
                continue
            _last_fired[key] = now
            ev = AlertEvent(
                ts=datetime.now(),
                vehicle_id=u["id"],
                unit=u["unit"],
                company=u.get("company") or "",
                rule="reefer_temp",
                value=f"{dev:.1f} F",
                message=(f"{u['unit']} return air {ret:.1f} F vs "
                         f"setpoint {sp:.0f} F ({dev:.1f} F off, "
                         f"limit {threshold:.0f})"),
                acked=False,
            )
            session.add(ev)
            session.flush()
            created.append({
                "id": ev.id, "ts": ev.ts.isoformat(), "unit": ev.unit,
                "company": ev.company, "rule": ev.rule,
                "value": ev.value, "message": ev.message,
            })
        session.commit()
    return created


def record_wo_events(created_wos: list[dict]) -> list[dict]:
    """Cada WO nueva del puente reefer->WO -> un AlertEvent (feed + dispatch).

    La idempotencia vive en reefer_wo.sync (no duplica WOs), así que cada
    elemento de `created_wos` es genuinamente nuevo; no hace falta cooldown."""
    if not created_wos:
        return []
    out: list[dict] = []
    with SessionLocal() as session:
        for w in created_wos:
            ev = AlertEvent(
                ts=datetime.now(),
                vehicle_id=str(w.get("unit") or ""),
                unit=w.get("unit") or "",
                company="",
                rule="reefer_fault_wo",
                value=f"WO #{w['wo_id']}",
                message=(f"Auto work order #{w['wo_id']} created from reefer "
                         f"fault {w['code']} on {w['unit']}"),
                acked=False,
            )
            session.add(ev)
            session.flush()
            out.append({
                "id": ev.id, "ts": ev.ts.isoformat(), "unit": ev.unit,
                "company": ev.company, "rule": ev.rule,
                "value": ev.value, "message": ev.message,
            })
        session.commit()
    return out


# ----- Despacho externo (email/SMS, opt-in explícito) -------------------

def _dispatch(created: list[dict], cfg: dict) -> None:
    if not created:
        return
    batch = created[:MAX_EXTERNAL_PER_CYCLE]
    lines = [f"- [{RULE_LABEL.get(e['rule'], e['rule'])}] {e['message']}"
             for e in batch]
    body = ("Rigsmith alerts:\n\n" + "\n".join(lines)
            + "\n\nOpen the dashboard for details.")

    if cfg["channels"]["email"] and cfg["recipients"]["emails"]:
        settings = mailer.load_settings()
        subject = (f"Fleet alert: {len(batch)} event"
                   f"{'s' if len(batch) != 1 else ''}")
        for to in cfg["recipients"]["emails"]:
            try:
                mailer.send_email(settings, to, [], subject, body)
            except Exception:
                pass

    if cfg["channels"]["sms"] and cfg["recipients"]["phones"]:
        settings = sms_service.load_settings()
        text = "Rigsmith: " + "; ".join(
            e["message"] for e in batch)[:1500]
        for phone in cfg["recipients"]["phones"]:
            try:
                sms_service.send_sms(
                    settings, sms_service.to_e164(phone), text)
            except Exception:
                pass


# ----- Eventos (feed) ---------------------------------------------------

def list_events(limit: int = 50, unacked_only: bool = False) -> list[dict]:
    with SessionLocal() as session:
        q = select(AlertEvent).order_by(AlertEvent.id.desc()).limit(limit)
        if unacked_only:
            q = select(AlertEvent).where(AlertEvent.acked.is_(False)) \
                .order_by(AlertEvent.id.desc()).limit(limit)
        return [{
            "id": e.id,
            "ts": e.ts.isoformat(),
            "unit": e.unit,
            "company": e.company,
            "rule": e.rule,
            "rule_label": RULE_LABEL.get(e.rule, e.rule),
            "value": e.value,
            "message": e.message,
            "acked": e.acked,
        } for e in session.scalars(q).all()]


def ack_events(ids: list[int] | None = None) -> int:
    """Marca eventos como atendidos. Sin ids -> todos los del tenant actual.

    DATA-1: el UPDATE Core NO pasa por el guard de aislamiento (que solo
    intercepta SELECT), así que filtramos por org_id a mano para no marcar
    (ni dejar marcar) alertas de OTRA organización (IDOR de escritura)."""
    org = tenant.get_current_org()
    if org is None:
        return 0
    with SessionLocal() as session:
        stmt = (update(AlertEvent).values(acked=True)
                .where(AlertEvent.org_id == org))
        if ids:
            stmt = stmt.where(AlertEvent.id.in_(ids))
        else:
            stmt = stmt.where(AlertEvent.acked.is_(False))
        n = session.execute(stmt).rowcount or 0
        session.commit()
        return n


# ----- Loop de background ----------------------------------------------

async def run_loop() -> None:
    """Evalúa cada LOOP_SECONDS mientras haya reglas habilitadas.

    Nunca tumba el server: cualquier excepción se traga y se reintenta
    al ciclo siguiente.
    """
    while True:
        # H6 fase 3c: el loop corre sin request, asi que fija el tenant a
        # mano para que los AlertEvent/WorkOrder que inserta queden tagueados
        # y visibles. Single-tenant -> org 'default'. Multi-tenant (post-3e)
        # deberia iterar las organizaciones evaluando cada una con su contexto.
        org_token = tenant.set_current_org(default_org_id())
        try:
            # Ingesta diaria de odómetro (v2.8, habilitador del CPM): corre
            # independiente de las reglas de alerta, a lo sumo una vez por día.
            await odometer.maybe_snapshot()
            cfg = get_settings()
            if any_rule_enabled(cfg):
                created: list[dict] = []
                vehicle_rules = [k for k, r in cfg["rules"].items()
                                 if r.get("enabled") and k != "reefer_temp"]
                if vehicle_rules:
                    track = await tracking.load_live()
                    created += evaluate(track, cfg)
                reefer_temp_on = cfg["rules"]["reefer_temp"].get("enabled")
                fault_cfg = cfg["rules"].get("reefer_fault_wo") or {}
                if reefer_temp_on or fault_cfg.get("enabled"):
                    snapshot = await reefer.load_live()
                    if reefer_temp_on:
                        created += evaluate_reefer(snapshot, cfg)
                    if fault_cfg.get("enabled"):
                        wos = reefer_wo.sync(
                            snapshot,
                            int(fault_cfg.get("min_severity") or 2))
                        created += record_wo_events(wos)
                if created:
                    _dispatch(created, cfg)
        except Exception:
            pass
        finally:
            tenant.reset_current_org(org_token)
        await asyncio.sleep(LOOP_SECONDS)
