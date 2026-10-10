# -*- coding: utf-8 -*-
"""Configuración de empresa (fase G7): lo que antes vivía hardcodeado.

`backend/org.local.json` (gitignored) guarda branding, umbrales de
negocio y CC routing. Los DEFAULTS son exactamente los valores que el
código traía en duro (Chaser/MCCI), así que sin archivo la app se
comporta idéntico — y otra empresa solo necesita su propio org.local.

Consumidores cableados (con fallback a default):
- cc_routing.cc_for_region   -> cc por terminal + always_cc
- pm (intervalo y upcoming)  -> thresholds.pm_*
- maint (PM del reefer)      -> thresholds.reefer_pm_* (v2.22, horas + días)
- samsara (lookback defectos)-> thresholds.defect_lookback_days
- engine (umbral DVIR rojo)  -> thresholds.dvir_min_minutes
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime, time, timedelta, tzinfo
from zoneinfo import ZoneInfo

from .. import config, db

# v2.22: zona horaria de la org (IANA). Define "hoy", "esta semana" (lun–dom),
# los presets de reportes y la hora de envío de los schedules. Default
# America/Chicago (la misma que ya usaba samsara.py para los DVIR).
DEFAULT_TIMEZONE = "America/Chicago"

# H6 fase 3d: la config vive por-tenant en la tabla org_setting (clave
# 'org_config'); el JSON legacy se importa una sola vez a la org 'default'.
SETTING_KEY = "org_config"
CONFIG_PATH = config.BACKEND_DIR / "org.local.json"   # legacy (migracion)

# Nombre fijo de la app. NO es editable desde Settings (se ignora cualquier
# valor que llegue en branding.app_name y get() siempre devuelve este).
APP_NAME = "Rigsmith"

DEFAULTS: dict = {
    "branding": {
        "app_name": APP_NAME,
        "tagline": "Your fleet, forged right.",
        "accent": "",                # vacío = rojo de fábrica (#e11900)
    },
    "thresholds": {
        "dvir_min_minutes": 15,      # pre-trip más corto = rojo
        "pm_interval_miles": 20000,
        "pm_upcoming_miles": 5500,
        "defect_lookback_days": 270,
        # v2.22: PM del reefer por HORAS de motor (meter_reading), con la
        # fecha como respaldo: vence lo que llegue primero.
        "reefer_pm_interval_hours": 1500,
        "reefer_pm_upcoming_hours": 150,
        "reefer_pm_interval_days": 365,
        "reefer_pm_upcoming_days": 30,
    },
    # H3: tarifa de labor del taller ($/hora). 0 = sin tarifa por defecto
    # (las líneas de labor no se autollenan). Decisión del usuario: una
    # tarifa única de taller (no por mecánico).
    "labor_rate": 0.0,
    # CC routing de Avisos: lista por terminal + lista que SIEMPRE va.
    # Vacío = usar el REGION_CC hardcodeado histórico de cc_routing.py.
    "cc": {},
    "always_cc": [],
    # H3-C: identidad del taller (el "From" del estimate/invoice). Un solo
    # taller (decisión del usuario). `name` vacío = usar branding.app_name.
    "shop": {
        "name": "", "address": "", "city": "", "state": "", "zip": "",
        "phone": "", "email": "",
    },
    # Bill-To por empresa dueña de la unidad (CHASER/MCC). Vacío = solo el
    # nombre de la empresa, sin dirección. No es una entidad Customer: es
    # un mapa empresa -> dirección de facturación.
    "billing": {},   # { "CHASER": {name,address,city,state,zip,phone,email}, ... }
    # Numeración y textos por defecto del invoice. `next_number` lo gestiona
    # next_invoice_number() (se autoincrementa al facturar); save() NO lo
    # toca para no pisarlo con un valor viejo del formulario.
    "invoice": {
        "next_number": 1001, "prefix": "", "terms": "", "footer": "",
    },
    # v2.22: zona horaria IANA de la org (ver org_now/org_today abajo).
    "timezone": DEFAULT_TIMEZONE,
    # v2.22 (Reports): asistente de IA que arma reportes en lenguaje
    # natural. `ai_assistant_enabled` es el interruptor del plan (Settings,
    # admin); `assistant_model` vacío = el modelo por defecto del asistente
    # (core/report_assistant.DEFAULT_MODEL).
    "ai_assistant_enabled": True,
    "assistant_model": "",
}

# Id de modelo de Claude aceptable en Settings (la UI ofrece la lista de
# core/report_assistant.ASSISTANT_MODELS; acá solo se valida la forma).
_MODEL_RE = re.compile(r"^claude-[a-z0-9][a-z0-9.-]{1,60}$")

# Campos de texto de una dirección de Bill-To (se sanean al guardar).
_ADDR_FIELDS = ("name", "address", "city", "state", "zip", "phone", "email")


def _read() -> dict:
    return db.get_setting(SETTING_KEY, legacy_file=CONFIG_PATH) or {}


def _write(data: dict) -> None:
    db.save_setting(SETTING_KEY, data)


def get() -> dict:
    data = _read()
    out = json.loads(json.dumps(DEFAULTS))
    for section in ("branding", "thresholds"):
        for k, v in (data.get(section) or {}).items():
            if k in out[section]:
                out[section][k] = v
    if isinstance(data.get("cc"), dict):
        out["cc"] = {
            str(t): [str(e).strip() for e in v if str(e).strip()]
            for t, v in data["cc"].items() if isinstance(v, list)
        }
    if isinstance(data.get("always_cc"), list):
        out["always_cc"] = [str(e).strip() for e in data["always_cc"]
                            if str(e).strip()]
    try:
        out["labor_rate"] = max(0.0, float(data.get("labor_rate", 0)))
    except (TypeError, ValueError):
        out["labor_rate"] = 0.0
    # H3-C: taller (strings), invoice (contador + textos), Bill-To por empresa.
    for k, v in (data.get("shop") or {}).items():
        if k in out["shop"]:
            out["shop"][k] = str(v)
    inv = data.get("invoice") or {}
    try:
        out["invoice"]["next_number"] = max(1, int(inv.get("next_number", 1001)))
    except (TypeError, ValueError):
        pass
    for k in ("prefix", "terms", "footer"):
        if k in inv:
            out["invoice"][k] = str(inv[k])
    if isinstance(data.get("billing"), dict):
        out["billing"] = {
            str(co): {f: str(addr.get(f, "")) for f in _ADDR_FIELDS}
            for co, addr in data["billing"].items() if isinstance(addr, dict)
        }
    tz_name = str(data.get("timezone") or "").strip()
    if tz_name and _zone(tz_name) is not None:
        out["timezone"] = tz_name
    if isinstance(data.get("ai_assistant_enabled"), bool):
        out["ai_assistant_enabled"] = data["ai_assistant_enabled"]
    model = str(data.get("assistant_model") or "").strip()
    if model and _MODEL_RE.match(model):
        out["assistant_model"] = model
    out["branding"]["app_name"] = APP_NAME      # nombre fijo, no editable
    return out


def save(new: dict) -> dict:
    cur = get()
    for section in ("branding", "thresholds"):
        for k, v in (new.get(section) or {}).items():
            if k not in cur[section]:
                continue
            if section == "branding" and k == "app_name":
                continue                        # nombre fijo, no editable
            if section == "thresholds":
                try:
                    cur[section][k] = max(1, int(v))
                except (TypeError, ValueError):
                    continue
            else:
                cur[section][k] = str(v).strip()[:80]
    if isinstance(new.get("cc"), dict):
        cur["cc"] = {
            str(t)[:12]: [str(e).strip()[:80] for e in v
                          if str(e).strip()][:10]
            for t, v in new["cc"].items() if isinstance(v, list)
        }
    if isinstance(new.get("always_cc"), list):
        cur["always_cc"] = [str(e).strip()[:80] for e in new["always_cc"]
                            if str(e).strip()][:10]
    if "labor_rate" in new:
        try:
            cur["labor_rate"] = max(0.0, float(new["labor_rate"] or 0))
        except (TypeError, ValueError):
            pass
    # H3-C: taller + textos del invoice + Bill-To. OJO: NO se persiste
    # `invoice.next_number` desde el formulario (lo gestiona en exclusiva
    # next_invoice_number); así un form viejo no retrocede el contador.
    if isinstance(new.get("shop"), dict):
        for k, v in new["shop"].items():
            if k in cur["shop"]:
                cur["shop"][k] = str(v).strip()[:120]
    if isinstance(new.get("invoice"), dict):
        for k in ("prefix", "terms", "footer"):
            if k in new["invoice"]:
                cap = 12 if k == "prefix" else 400
                cur["invoice"][k] = str(new["invoice"][k]).strip()[:cap]
    if isinstance(new.get("billing"), dict):
        cur["billing"] = {
            str(co)[:64]: {f: str(addr.get(f, "")).strip()[:120]
                           for f in _ADDR_FIELDS}
            for co, addr in new["billing"].items() if isinstance(addr, dict)
        }
    if "timezone" in new:
        tz_name = str(new.get("timezone") or "").strip()[:64]
        if not tz_name:
            tz_name = DEFAULT_TIMEZONE
        if _zone(tz_name) is None:
            raise ValueError(f"invalid timezone: {tz_name}")
        cur["timezone"] = tz_name
    if "ai_assistant_enabled" in new:
        cur["ai_assistant_enabled"] = bool(new.get("ai_assistant_enabled"))
    if "assistant_model" in new:
        model = str(new.get("assistant_model") or "").strip()
        if model and not _MODEL_RE.match(model):
            raise ValueError(f"invalid assistant model: {model[:60]}")
        cur["assistant_model"] = model
    _write(cur)
    return cur


# ----- Accesores cómodos para los consumidores ---------------------------

def branding() -> dict:
    return get()["branding"]


def threshold(key: str) -> int:
    return int(get()["thresholds"].get(
        key, DEFAULTS["thresholds"].get(key, 0)))


def labor_rate() -> float:
    """Tarifa de labor del taller ($/hora). 0 = sin default."""
    return float(get().get("labor_rate", 0.0))


def shop() -> dict:
    """Identidad del taller (el "From" del estimate/invoice)."""
    return get()["shop"]


def billing() -> dict:
    """Mapa empresa -> dirección de Bill-To."""
    return get()["billing"]


def invoice_cfg() -> dict:
    """Config del invoice (next_number, prefix, terms, footer)."""
    return get()["invoice"]


def next_invoice_number() -> str:
    """Toma el próximo número de invoice y AVANZA el contador de forma ATÓMICA.
    Devuelve el número con prefijo (p.ej. 'INV-1042'). El incremento atómico
    (lock de fila) vive en db.bump_invoice_number (DATA-2): antes era un
    read-modify-write sin lock sobre el JSON -> dos facturaciones simultáneas
    podían tomar el mismo número."""
    prefix = str(invoice_cfg().get("prefix", "") or "")
    n = db.bump_invoice_number(default_start=1001)
    return f"{prefix}{n}"


def cc_override() -> tuple[dict[str, list[str]], list[str]]:
    """(cc_por_terminal, always_cc). Vacíos = usar los hardcodeados."""
    data = get()
    return data["cc"], data["always_cc"]


# ----- Zona horaria de la org (v2.22) ---------------------------------------
# Los timestamps de la base son NAIVE en hora LOCAL DEL SERVIDOR
# (datetime.now(); en el contenedor eso es UTC). Para "hoy" / "esta semana" /
# presets de reportes / hora de envío de schedules se usa la zona de la org:
#   - org_now()/org_today(): reloj de pared de la org.
#   - to_org()/to_org_date(): un timestamp de la base -> hora/fecha de la org.
#   - org_day_start()/org_range(): límites de días de la org expresados como
#     datetimes naive del servidor, listos para filtrar columnas DateTime.

def _zone(name: str) -> tzinfo | None:
    """ZoneInfo de `name`, o None si no es una zona IANA válida (o si el
    sistema no tiene base de zonas: requirements trae `tzdata`)."""
    try:
        return ZoneInfo(str(name))
    except Exception:  # ZoneInfoNotFoundError, ValueError, OSError…
        return None


def timezone_name() -> str:
    """Zona IANA configurada para la org actual (default America/Chicago)."""
    return get().get("timezone") or DEFAULT_TIMEZONE


def org_tz() -> tzinfo:
    """tzinfo de la org. Fallbacks: zona default; si el sistema no tiene
    ninguna base de zonas, la zona local del servidor."""
    return (_zone(timezone_name()) or _zone(DEFAULT_TIMEZONE)
            or datetime.now().astimezone().tzinfo)


def org_now() -> datetime:
    """Ahora, AWARE, en la zona de la org."""
    return datetime.now(org_tz())


def org_today() -> date:
    """Fecha de hoy en la zona de la org."""
    return org_now().date()


def to_org(dt: datetime | None) -> datetime | None:
    """Convierte un timestamp a la zona de la org (aware). Los naive se
    interpretan como hora local del servidor (así se guardan en la base)."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.astimezone()          # naive -> local del servidor (aware)
    return dt.astimezone(org_tz())


def org_iso(dt: datetime | None) -> str | None:
    """ISO naive en la hora de la org, para mostrar (igual que los reportes).
    El frontend interpreta un ISO sin offset como hora de pared: así el
    historial muestra la hora del taller y no la del servidor (UTC en prod)."""
    o = to_org(dt)
    return o.replace(tzinfo=None, microsecond=0).isoformat() if o else None


def to_org_date(dt: datetime | None) -> date | None:
    """Fecha de la org de un timestamp de la base (None -> None)."""
    o = to_org(dt)
    return o.date() if o is not None else None


def org_day_start(d: date) -> datetime:
    """Medianoche de la fecha `d` de la org, como datetime NAIVE en hora del
    servidor (comparable con las columnas DateTime de la base)."""
    aware = datetime.combine(d, time(0, 0), tzinfo=org_tz())
    return aware.astimezone().replace(tzinfo=None)


def org_range(start: date, end_inclusive: date) -> tuple[datetime, datetime]:
    """[inicio, fin) naive del servidor que cubre los días de la org
    start..end_inclusive. Uso: col >= a AND col < b."""
    return org_day_start(start), org_day_start(end_inclusive
                                               + timedelta(days=1))


def week_bounds(d: date | None = None) -> tuple[date, date]:
    """(lunes, domingo) de la semana de `d` (default: hoy en la org)."""
    d = d or org_today()
    monday = d - timedelta(days=d.weekday())
    return monday, monday + timedelta(days=6)
