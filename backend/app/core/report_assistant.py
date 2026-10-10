# -*- coding: utf-8 -*-
"""Asistente de IA "Ask Rigsmith" (v2.22): pedido en lenguaje natural ->
ReportSpec del motor de reportes.

Diferencial frente a SquareRigger (su chatbot solo busca documentación):
acá Claude ARMA el reporte sobre los datos de la propia org. Lo que viaja
al modelo es SOLO el esquema (fuentes, campos, tipos, valores de enums,
operadores y presets) + el pedido del usuario + la spec actual si está
refinando: NUNCA filas de datos. La spec devuelta se valida con el MISMO
motor (core/report_engine.validate) y el frontend la previsualiza llamando
a /api/reports/run.

Implementación (skill claude-api, SDK oficial `anthropic`):
  - AsyncAnthropic().beta.messages.parse(output_format=<modelo pydantic>)
    -> structured outputs; el esquema de salida modela los DOS niveles de
    filtro como tipos separados (sin recursión) y todos los campos son
    obligatorios (nullable), como exige el formato estricto.
  - System prompt = catálogo compacto del registro + reglas, con
    cache_control (prompt caching: es idéntico entre pedidos). La fecha de
    hoy va en el mensaje del usuario para no romper el caché.
  - thinking adaptive + output_config.effort explícito ('medium').
  - Fallbacks server-side por defecto (beta server-side-fallback-2026-07-01,
    fallbacks "default") en los modelos que lo soportan: un falso positivo
    de los clasificadores no deja al usuario sin respuesta.
  - stop_reason 'refusal' / 'max_tokens' -> advertencia clara, sin spec.
  - Spec inválida -> UN reintento con el error del validador; si sigue
    inválida, se descartan las partes que no validan (con aviso).

Clave de API: secretstore blob 'assistant' -> env ANTHROPIC_API_KEY ->
api_key del escaneo de documentos (docscan). Modelo: org_config
`assistant_model` (vacío = DEFAULT_MODEL). Interruptor del plan: org_config
`ai_assistant_enabled`.
"""

from __future__ import annotations

import json
import os
import warnings
from typing import Literal, Union

from pydantic import BaseModel, ConfigDict, ValidationError

from . import org_config, report_engine
from . import report_registry as reg

try:
    import anthropic
    _HAS_ANTHROPIC = True
except ImportError:                                # dependencia opcional
    _HAS_ANTHROPIC = False

DEFAULT_MODEL = "claude-opus-5-5"
ASSISTANT_MODELS = ("claude-opus-5-5", "claude-sonnet-5-5",
                    "claude-haiku-5-5")
# Modelos con fallback server-side "default" (Haiku 5.5 no tiene).
_FALLBACK_MODELS = {"claude-opus-5-5", "claude-sonnet-5-5"}
_FALLBACK_BETA = "server-side-fallback-2026-07-01"
EFFORT = "medium"
MAX_TOKENS = 16000
TIMEOUT_S = 120.0
MAX_PROMPT = 2000

NOT_CONFIGURED = "AI assistant isn't configured"
DISABLED = "AI assistant isn't configured — it's turned off in Settings"


class AssistantUnavailable(Exception):
    """503: sin clave, sin paquete o apagado por la org."""


class AssistantError(Exception):
    """Falla de la API (status HTTP sugerido + mensaje en inglés)."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------------------
# Esquema de salida para structured outputs (sin recursión, sin defaults)
# ---------------------------------------------------------------------------

class _M(BaseModel):
    model_config = ConfigDict(extra="forbid")


_SourceKey = Literal[tuple(reg.SOURCES)]          # type: ignore[valid-type]
_Agg = Literal["count", "count_distinct", "sum", "avg", "min", "max"]
_Op = Literal["eq", "ne", "in", "not_in", "gt", "gte", "lt", "lte",
              "between", "contains", "empty", "not_empty"]
_Preset = Literal["today", "yesterday", "this_week", "prev_week", "mtd",
                  "prev_month", "last_30d", "last_90d", "qtd", "ytd",
                  "last_12m", "all", "custom"]


class LlmColumn(_M):
    field: str
    agg: _Agg | None
    label: str | None


class LlmCond(_M):
    field: str
    op: _Op
    value: Union[str, float, bool, list[str], None]


class LlmGroup(_M):
    match: Literal["all", "any"]
    items: list[LlmCond]


class LlmFilters(_M):
    match: Literal["all", "any"]
    items: list[Union[LlmCond, LlmGroup]]


class LlmTime(_M):
    field: str
    preset: _Preset
    date_from: str | None
    date_to: str | None


class LlmSort(_M):
    field: str
    dir: Literal["asc", "desc"]


class LlmChart(_M):
    type: Literal["bar", "line", "donut", "kpi", "none"]
    x: str | None
    y: list[str]


class LlmSpec(_M):
    source: _SourceKey
    columns: list[LlmColumn]
    filters: LlmFilters
    time: LlmTime | None
    group_by: list[str]
    sort: list[LlmSort]
    limit: int | None
    totals: bool
    chart: LlmChart | None


class AssistantAnswer(_M):
    spec: LlmSpec
    explanation: str


def _value_out(v):
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def llm_to_spec(s: LlmSpec) -> dict:
    """LlmSpec -> dict de ReportSpec del motor."""
    def cond(c: LlmCond) -> dict:
        d = {"field": c.field, "op": c.op}
        if c.value is not None and c.op not in ("empty", "not_empty"):
            d["value"] = (list(c.value) if isinstance(c.value, list)
                          else _value_out(c.value))
        return d
    items = []
    for it in s.filters.items:
        if isinstance(it, LlmGroup):
            items.append({"match": it.match,
                          "items": [cond(c) for c in it.items]})
        else:
            items.append(cond(it))
    out: dict = {
        "source": s.source,
        "columns": [{"field": c.field,
                     **({"agg": c.agg} if c.agg else {}),
                     **({"label": c.label} if c.label else {})}
                    for c in s.columns],
        "filters": {"match": s.filters.match, "items": items},
        "group_by": list(s.group_by),
        "sort": [{"field": x.field, "dir": x.dir} for x in s.sort],
        "totals": bool(s.totals),
    }
    if s.time is not None:
        t: dict = {"field": s.time.field, "preset": s.time.preset}
        if s.time.date_from:
            t["from"] = s.time.date_from
        if s.time.date_to:
            t["to"] = s.time.date_to
        out["time"] = t
    if s.limit:
        out["limit"] = max(1, min(int(s.limit), report_engine.MAX_LIMIT))
    if s.chart is not None and s.chart.type != "none":
        out["chart"] = {"type": s.chart.type,
                        **({"x": s.chart.x} if s.chart.x else {}),
                        "y": list(s.chart.y)}
    # group_by con dimensiones que no son columnas: se agregan como columnas
    # visibles (antes de la primera métrica). El motor lo aceptaba, pero el
    # builder agrupa por sus columnas y el preview no coincidía con la spec
    # validada (ni con la explicación).
    cols = out["columns"]
    if any(c.get("agg") for c in cols):
        plain = {c["field"] for c in cols if not c.get("agg")}
        extra = [f for f in dict.fromkeys(out["group_by"]) if f not in plain]
        if extra:
            at = next(i for i, c in enumerate(cols) if c.get("agg"))
            out["columns"] = (cols[:at] + [{"field": f} for f in extra]
                              + cols[at:])
    return out


# ---------------------------------------------------------------------------
# Prompt (estable -> cacheable)
# ---------------------------------------------------------------------------

_RULES = """You build reports for Rigsmith, a fleet-maintenance shop app. \
You turn the user's request into a report spec (JSON) over the sources \
listed below, plus a short explanation. You never see the organization's \
data: never invent values, counts or names.

Spec rules:
- source: one key from the catalog. Use only that source's field names, \
spelled exactly.
- columns: 1-40. A plain column shows the field. For summaries ("by X", \
"per X", "total", "how many", "top N"), give the metric columns an agg \
(sum, count, count_distinct, avg, min, max) and put the dimension fields \
in group_by; group_by lists exactly the non-aggregated columns (every \
dimension you group by is also a plain column). Without any agg, group_by \
must be [].
- An aggregated column's key is "<agg>_<field>" (e.g. sum_amount, \
count_id). Use these keys in sort and chart.
- sum/avg only on number or money fields. count works on any field (count \
the id field to count rows).
- filters: match "all" or "any"; items are conditions or one level of \
groups. ops: eq, ne, in, not_in (value = list), gt, gte, lt, lte, between \
(value = [low, high]), contains (text), empty, not_empty (value null). \
Text comparisons ignore case. Enum fields take the raw values listed \
(e.g. status "in_progress"). Booleans take true/false. Dates are \
YYYY-MM-DD.
- time: null when the request has no period. Otherwise field = a date \
field of the source (prefer its default) and a preset: today, yesterday, \
this_week, prev_week ("last week"), mtd ("this month"), prev_month \
("last month"), last_30d, last_90d, qtd ("this quarter"), ytd ("this \
year"), last_12m ("past year"), all, or custom with date_from/date_to. \
Sources marked PERIOD (cpm, unit_miles) compute over the time range: use \
field "period".
- sort: rankings and "top N" sort the metric desc and set limit to N. \
limit null = default.
- totals: true when the report has money or number columns.
- chart: bar for rankings by a category, line for trends by month (group \
by the month field), donut for shares of a total, kpi for one or a few \
totals, or null. x and y must be column keys; y lists numeric keys.

Picking sources:
- Maintenance spend by category / unit / month / preventive vs reactive: \
spend_lines (amount, category_label, month, spend_type).
- Cost per mile: cpm. Miles driven: unit_miles.
- Parts and labor used on work orders: wo_lines (kind "part" or "labor"; \
labor hours = labor_hours; amount = qty x unit cost).
- Work order counts, totals, days to close, outside work: work_orders.
- What customers / owner-operators were billed: work_orders with status \
"invoiced" and customer_id not_empty, sum billable_total, grouped by \
customer_name; balances per customer: customers.
- PMs due or overdue: pm_due. Full PM schedule for every unit: \
maint_board. Reefer PM by engine hours: maint_board with campaign "reefer" \
(engine hours are their own meter; never use odometer readings for \
hours). Engine hour readings: meter_readings.
- Inventory, stock value, low stock: parts. Inventory movements and cost \
corrections: stock_movements (reason "po_cost_adj" = revaluation).
- Purchasing: purchase_orders, po_lines, po_adjustments, vendors.

When a current spec is given, change only what the request asks and keep \
the rest. If the data can't answer the request exactly, build the closest \
useful report and say what is missing.

explanation: 1-3 short plain-English sentences (no markdown) saying what \
the report shows and any assumption you made."""


def _catalog_text() -> str:
    lines = []
    for src in reg.SOURCES.values():
        tag = " [PERIOD]" if src.time_param else ""
        lines.append(f"\nSOURCE {src.key}{tag} — {src.label}. "
                     f"{src.description} Default time field: "
                     f"{src.default_time_field or 'none'}.")
        parts = []
        for f in src.fields.values():
            if f.hidden:
                continue
            t = f.type
            if f.enum:
                vals = "|".join(k if k else "''" for k in f.enum)
                t = f"{t}: {vals}"
            extra = f" — {f.desc}" if f.desc and len(f.desc) < 90 else ""
            pii = " [personal]" if f.pii else ""
            parts.append(f"{f.name} ({t}) {f.label}{pii}{extra}")
        lines.append("  fields: " + "; ".join(parts))
    return "CATALOG" + "".join(lines)


_SYSTEM: str | None = None


def system_prompt() -> str:
    global _SYSTEM
    if _SYSTEM is None:
        _SYSTEM = _RULES + "\n\n" + _catalog_text()
    return _SYSTEM


# ---------------------------------------------------------------------------
# Configuración
# ---------------------------------------------------------------------------

def _api_key() -> tuple[str, str]:
    """(key, origen). Orden: secretstore 'assistant' -> env -> docscan."""
    from . import docscan, secretstore
    try:
        k = str(secretstore.store().get_blob("assistant").get("api_key")
                or "").strip()
        if k:
            return k, "assistant"
    except Exception:  # noqa: BLE001
        pass
    k = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if k:
        return k, "env"
    try:
        k = str(docscan.load_settings().get("api_key") or "").strip()
        if k:
            return k, "docscan"
    except Exception:  # noqa: BLE001
        pass
    return "", ""


def _settings() -> tuple[bool, str]:
    cfg = org_config.get()
    enabled = bool(cfg.get("ai_assistant_enabled", True))
    model = str(cfg.get("assistant_model") or "").strip() or DEFAULT_MODEL
    return enabled, model


def status() -> dict:
    enabled, model = _settings()
    key, origin = _api_key()
    configured = bool(key) and _HAS_ANTHROPIC
    return {
        "enabled": enabled,
        "configured": configured,
        "available": enabled and configured,
        "model": model,
        "default_model": DEFAULT_MODEL,
        "models": list(ASSISTANT_MODELS),
        "key_source": origin or None,
        "message": ("" if enabled and configured else
                    DISABLED if not enabled else NOT_CONFIGURED),
    }


# ---------------------------------------------------------------------------
# Llamada al modelo
# ---------------------------------------------------------------------------

def _user_text(prompt: str, spec: dict | None, today: str,
               error: str | None = None, bad: dict | None = None) -> str:
    parts = [f"Today (organization time zone): {today}."]
    if spec:
        parts.append("Current report spec:\n"
                     + json.dumps(spec, ensure_ascii=False, sort_keys=True))
    if error:
        parts.append("Your previous spec failed validation with this "
                     f"error: {error}\nPrevious spec:\n"
                     + json.dumps(bad or {}, ensure_ascii=False,
                                  sort_keys=True)
                     + "\nReturn a corrected spec for the same request.")
    parts.append(f"Request: {prompt}")
    return "\n\n".join(parts)


async def _call_model(api_key: str, model: str, user_text: str
                      ) -> tuple[str, AssistantAnswer | None, str]:
    """Una llamada a Claude. (stop_reason, respuesta parseada | None,
    modelo que respondió). Los tests reemplazan esta función."""
    client = anthropic.AsyncAnthropic(api_key=api_key, timeout=TIMEOUT_S,
                                      max_retries=1)
    kwargs: dict = {
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": [{"type": "text", "text": system_prompt(),
                    "cache_control": {"type": "ephemeral"}}],
        "messages": [{"role": "user", "content": user_text}],
        "thinking": {"type": "adaptive"},
        "output_config": {"effort": EFFORT},
        "output_format": AssistantAnswer,
    }
    if model in _FALLBACK_MODELS:
        kwargs["betas"] = [_FALLBACK_BETA]
        # El SDK instalado tipa `fallbacks` como lista: la forma "default"
        # (Anthropic elige el modelo según la categoría) va en el body.
        kwargs["extra_body"] = {"fallbacks": "default"}
    try:
        with warnings.catch_warnings():
            # output_format sigue soportado (skill claude-api); el SDK
            # avisa que prefiere output_config.format.
            warnings.simplefilter("ignore", DeprecationWarning)
            resp = await client.beta.messages.parse(**kwargs)
    except (ValidationError, ValueError):
        # El texto no cumplió el esquema (respuesta cortada / rechazo a
        # mitad de camino): se trata como respuesta inválida.
        return "invalid", None, model
    finally:
        await client.close()
    if resp.stop_reason in ("refusal", "max_tokens"):
        return resp.stop_reason, None, resp.model
    return resp.stop_reason or "end_turn", resp.parsed_output, resp.model


async def _ask_once(api_key: str, model: str, text: str
                    ) -> tuple[str, AssistantAnswer | None, str]:
    try:
        return await _call_model(api_key, model, text)
    except anthropic.AuthenticationError:
        raise AssistantUnavailable(
            NOT_CONFIGURED + " — the API key was rejected") from None
    except anthropic.RateLimitError:
        raise AssistantError(429, "The AI assistant is busy. Try again in "
                                  "a minute.") from None
    except anthropic.BadRequestError as exc:
        raise AssistantError(502, "The AI assistant couldn't process this "
                                  f"request ({exc.status_code}).") from None
    except anthropic.APIStatusError as exc:
        raise AssistantError(502, "The AI assistant failed "
                                  f"({exc.status_code}). Try again.") \
            from None
    except anthropic.APIConnectionError:
        raise AssistantError(502, "Couldn't reach the AI service. Check "
                                  "the internet connection.") from None


# ---------------------------------------------------------------------------
# Saneo de una spec inválida (último recurso)
# ---------------------------------------------------------------------------

def _salvage(spec: dict, mask_pii: bool) -> tuple[dict | None, list[str]]:
    """Descarta las partes que no validan, una por una. (spec | None,
    avisos)."""
    src = reg.get_source(spec.get("source", ""))
    if src is None:
        return None, []
    notes: list[str] = []
    ok = lambda n: src.field(n) is not None            # noqa: E731
    cols = [c for c in spec.get("columns") or []
            if isinstance(c, dict) and ok(c.get("field", ""))]
    if len(cols) < len(spec.get("columns") or []):
        notes.append("Some suggested columns don't exist and were removed.")
    if not cols:
        return None, notes
    spec = {**spec, "columns": cols}

    def good_cond(c):
        return isinstance(c, dict) and ok(c.get("field", ""))
    items = []
    for it in (spec.get("filters") or {}).get("items") or []:
        if isinstance(it, dict) and "items" in it:
            sub = [c for c in it["items"] if good_cond(c)]
            if sub:
                items.append({**it, "items": sub})
        elif good_cond(it):
            items.append(it)
    if len(items) < len((spec.get("filters") or {}).get("items") or []):
        notes.append("Some suggested filters don't exist and were removed.")
    spec["filters"] = {"match": (spec.get("filters") or {}).get("match",
                                                                "all"),
                       "items": items}
    spec["group_by"] = [g for g in spec.get("group_by") or [] if ok(g)]
    for attempt in range(6):
        try:
            report_engine.validate(spec, mask_pii=mask_pii)
            return spec, notes
        except ValueError as exc:
            msg = str(exc)
            if attempt == 0:
                spec.pop("chart", None)
            elif attempt == 1:
                spec["sort"] = []
            elif attempt == 2:
                spec.pop("time", None)
                notes.append("The suggested time range didn't fit and was "
                             "removed.")
            elif attempt == 3:
                spec["filters"] = {"match": "all", "items": []}
                notes.append("The suggested filters didn't validate and "
                             "were removed.")
            elif attempt == 4:
                spec["columns"] = [{"field": c["field"]} for c in cols]
                spec["group_by"] = []
                notes.append("The summary couldn't be built; showing plain "
                             "columns.")
            else:
                notes.append(f"Couldn't repair the report: {msg}")
    return None, notes


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

async def ask(prompt: str, spec: dict | None = None,
              mask_pii: bool = False) -> dict:
    """{spec, explanation, warnings[], model, ok}. `spec` None = no se pudo
    armar un reporte válido (los avisos dicen por qué).

    AssistantUnavailable -> 503; AssistantError -> su status; ValueError
    (pedido vacío) -> 400."""
    prompt = " ".join(str(prompt or "").split())
    if not prompt:
        raise ValueError("describe the report you need")
    prompt = prompt[:MAX_PROMPT]
    enabled, model = _settings()
    if not enabled:
        raise AssistantUnavailable(DISABLED)
    key, _origin = _api_key()
    if not key or not _HAS_ANTHROPIC:
        raise AssistantUnavailable(NOT_CONFIGURED)

    current = None
    if spec:
        try:
            current = report_engine.spec_dict(report_engine.parse_spec(spec))
        except ValueError:
            current = spec if isinstance(spec, dict) else None
    today = org_config.org_today().isoformat()
    warnings_out: list[str] = []

    stop, answer, served = await _ask_once(
        key, model, _user_text(prompt, current, today))
    if answer is None:
        return {"spec": None, "explanation": "", "model": served,
                "ok": False, "warnings": [_stop_warning(stop)]}

    candidate = llm_to_spec(answer.spec)
    explanation = answer.explanation.strip()
    try:
        report_engine.validate(candidate, mask_pii=mask_pii)
    except ValueError as exc:
        # Un reintento con el error del validador.
        stop2, answer2, served2 = await _ask_once(
            key, model, _user_text(prompt, current, today, str(exc),
                                   candidate))
        if answer2 is not None:
            cand2 = llm_to_spec(answer2.spec)
            try:
                report_engine.validate(cand2, mask_pii=mask_pii)
                candidate, served = cand2, served2
                explanation = answer2.explanation.strip() or explanation
                exc = None
            except ValueError as exc2:
                candidate, exc = cand2, exc2
        if exc is not None:
            fixed, notes = _salvage(candidate, mask_pii)
            warnings_out += notes
            if fixed is None:
                warnings_out.append(f"The assistant's report didn't "
                                    f"validate: {exc}")
                return {"spec": None, "explanation": explanation,
                        "model": served, "ok": False,
                        "warnings": warnings_out}
            candidate = fixed
    plan = report_engine.validate(candidate, mask_pii=mask_pii)
    if served and served != model:
        warnings_out.append(f"Answered by {served} (fallback model).")
    return {"spec": report_engine.spec_dict(plan.spec),
            "explanation": explanation[:1200], "model": served,
            "ok": True, "warnings": warnings_out}


def _stop_warning(stop: str) -> str:
    if stop == "refusal":
        return ("The assistant declined this request. Try describing the "
                "report you need from your shop data.")
    if stop == "max_tokens":
        return ("The assistant's answer was cut off. Try a shorter or "
                "simpler request.")
    return ("The assistant didn't return a usable report. Try rephrasing "
            "the request.")
