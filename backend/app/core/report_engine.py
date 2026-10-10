# -*- coding: utf-8 -*-
"""Motor de reportes (v2.22): ReportSpec JSON -> filas tipadas.

Una ReportSpec describe un reporte SIN SQL libre: fuente del registro
(core/report_registry), columnas (con agregación opcional), filtros
(match all/any + grupos de UN nivel), rango de tiempo por preset, agrupado,
orden, límite, totales y gráfico. La validan igual el builder, la
biblioteca, los reportes guardados, los schedules y el asistente de IA.

Ejecución:
  1. Validar contra el registro (campos/ops desconocidos -> ValueError con
     mensaje en inglés -> 400). Los campos PII no se pueden filtrar /
     ordenar / agrupar sin `pii.view`.
  2. Fuente SQL: SELECT de SOLO los campos necesarios (+ dependencias), con
     los joins declarados (outer, cada uno con `alias.org_id == org`
     explícito), filtro de org del modelo base, y "pushdown" del rango de
     tiempo y de las condiciones simples (match all) sobre columnas SQL. En
     Postgres: SET LOCAL statement_timeout. Después, posts en lote y
     derivados en Python.
     Fuente provider: la función async arma las filas.
  3. Normalizar por tipo, aplicar el resto de los filtros y el tiempo en
     Python, agrupar/agregar, ordenar, totalizar, recortar al límite y
     enmascarar PII.

Sin tenant en contexto NO se ejecuta (ValueError): el filtro automático del
ORM no aplicaría y la query leería todas las orgs.
"""

from __future__ import annotations

import asyncio
import calendar
import math
import time as _time
from dataclasses import dataclass, field as dc_field
from datetime import date, datetime, timedelta
from typing import Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field as PField, ValidationError
from sqlalchemy import and_, func, or_, select, text

from ..db import SessionLocal
from . import org_config, pii, tenant
from . import report_registry as reg

MAX_LIMIT = 50_000
DEFAULT_LIMIT = 5_000
MAX_SCAN = 250_000
MAX_COLUMNS = 40
STATEMENT_TIMEOUT_MS = 15_000

AGGS = ("count", "count_distinct", "sum", "avg", "min", "max")
OPS = ("eq", "ne", "in", "not_in", "gt", "gte", "lt", "lte", "between",
       "contains", "empty", "not_empty")
PRESETS = ("today", "yesterday", "this_week", "prev_week", "mtd",
           "prev_month", "last_30d", "last_90d", "qtd", "ytd", "last_12m",
           "all", "custom")
PRESET_LABELS = {
    "today": "Today", "yesterday": "Yesterday", "this_week": "This week",
    "prev_week": "Previous week", "mtd": "Month to date",
    "prev_month": "Previous month", "last_30d": "Last 30 days",
    "last_90d": "Last 90 days", "qtd": "Quarter to date",
    "ytd": "Year to date", "last_12m": "Last 12 months", "all": "All time",
    "custom": "Custom range",
}
OP_LABELS = {
    "eq": "is", "ne": "is not", "in": "is any of", "not_in": "is none of",
    "gt": ">", "gte": "≥", "lt": "<", "lte": "≤", "between": "between",
    "contains": "contains", "empty": "is empty", "not_empty": "is not empty",
}
AGG_LABELS = {"count": "Count of", "count_distinct": "Unique",
              "sum": "Total", "avg": "Avg", "min": "Min", "max": "Max"}
CHART_TYPES = ("bar", "line", "donut", "kpi", "none")

_ORDERED_TYPES = ("number", "money", "date", "datetime")
_NUM_TYPES = ("number", "money")


# ---------------------------------------------------------------------------
# Spec (pydantic, extra='forbid'; los dos niveles de filtro son tipos
# separados — sin recursión, compatible con structured outputs)
# ---------------------------------------------------------------------------

class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class ColumnSpec(_Strict):
    field: str
    agg: Literal["count", "count_distinct", "sum", "avg", "min",
                 "max"] | None = None
    label: str | None = None


class Cond(_Strict):
    field: str
    op: Literal["eq", "ne", "in", "not_in", "gt", "gte", "lt", "lte",
                "between", "contains", "empty", "not_empty"]
    value: Any = None


class CondGroup(_Strict):
    match: Literal["all", "any"] = "all"
    items: list[Cond] = []


class Filters(_Strict):
    match: Literal["all", "any"] = "all"
    items: list[Union[Cond, CondGroup]] = []


class TimeSpec(_Strict):
    field: str
    preset: Literal["today", "yesterday", "this_week", "prev_week", "mtd",
                    "prev_month", "last_30d", "last_90d", "qtd", "ytd",
                    "last_12m", "all", "custom"] = "all"
    from_: str | None = PField(default=None, alias="from")
    to: str | None = None


class SortSpec(_Strict):
    field: str
    dir: Literal["asc", "desc"] = "asc"


class ChartSpec(_Strict):
    type: Literal["bar", "line", "donut", "kpi", "none"] = "none"
    x: str | None = None
    y: list[str] = []


class ReportSpec(_Strict):
    source: str
    columns: list[ColumnSpec] = PField(min_length=1, max_length=MAX_COLUMNS)
    filters: Filters = PField(default_factory=Filters)
    time: TimeSpec | None = None
    group_by: list[str] = []
    sort: list[SortSpec] = []
    limit: int = PField(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT)
    totals: bool = False
    chart: ChartSpec | None = None


def spec_dict(spec: ReportSpec) -> dict:
    """Serialización canónica (alias 'from', sin Nones)."""
    return spec.model_dump(by_alias=True, exclude_none=True)


def _fmt_validation(exc: ValidationError) -> str:
    parts = []
    for e in exc.errors()[:4]:
        loc = ".".join(str(x) for x in e.get("loc", ()) if x not in (
            "Cond", "CondGroup"))
        parts.append(f"{loc}: {e.get('msg')}" if loc else str(e.get("msg")))
    return "invalid report spec — " + "; ".join(parts)


def parse_spec(obj) -> ReportSpec:
    if isinstance(obj, ReportSpec):
        return obj
    if not isinstance(obj, dict):
        raise ValueError("invalid report spec — expected an object")
    try:
        return ReportSpec.model_validate(obj)
    except ValidationError as exc:
        raise ValueError(_fmt_validation(exc)) from None


# ---------------------------------------------------------------------------
# Tiempo
# ---------------------------------------------------------------------------

def _parse_day(s) -> date | None:
    if s is None or s == "":
        return None
    if isinstance(s, datetime):
        return s.date()
    if isinstance(s, date):
        return s
    try:
        return datetime.strptime(str(s).strip()[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def preset_range(preset: str, today: date, d_from=None,
                 d_to=None) -> tuple[date | None, date | None]:
    """(desde, hasta) INCLUSIVOS del preset relativo a `today` (fecha de la
    org). 'all' -> (None, None)."""
    t = today
    if preset == "today":
        return t, t
    if preset == "yesterday":
        y = t - timedelta(days=1)
        return y, y
    if preset == "this_week":
        mon = t - timedelta(days=t.weekday())
        return mon, mon + timedelta(days=6)
    if preset == "prev_week":
        mon = t - timedelta(days=t.weekday() + 7)
        return mon, mon + timedelta(days=6)
    if preset == "mtd":
        return t.replace(day=1), t
    if preset == "prev_month":
        last = t.replace(day=1) - timedelta(days=1)
        return last.replace(day=1), last
    if preset == "last_30d":
        return t - timedelta(days=29), t
    if preset == "last_90d":
        return t - timedelta(days=89), t
    if preset == "qtd":
        q_month = 3 * ((t.month - 1) // 3) + 1
        return t.replace(month=q_month, day=1), t
    if preset == "ytd":
        return t.replace(month=1, day=1), t
    if preset == "last_12m":
        try:
            start = t.replace(year=t.year - 1)
        except ValueError:                       # 29-feb
            start = t.replace(year=t.year - 1, day=28)
        return start + timedelta(days=1), t
    if preset == "custom":
        return _parse_day(d_from), _parse_day(d_to)
    return None, None


# ---------------------------------------------------------------------------
# Contexto de ejecución
# ---------------------------------------------------------------------------

@dataclass
class RunContext:
    org: int
    today: date
    tz: Any
    mask_pii: bool = False
    needed: set = dc_field(default_factory=set)
    date_from: date | None = None
    date_to: date | None = None
    time_field: str | None = None
    cache: dict = dc_field(default_factory=dict)
    warnings: list = dc_field(default_factory=list)


@dataclass
class _Filter:
    field: str
    op: str
    value: Any
    ftype: str


@dataclass
class _Group:
    match: str
    items: list


@dataclass
class _OutCol:
    key: str
    label: str
    type: str
    field: str
    agg: str | None


@dataclass
class Plan:
    spec: ReportSpec
    source: Any
    columns: list
    group_by: list
    is_agg: bool
    filters: _Group
    time_field: str | None
    time_range: tuple
    needed: set


# ---------------------------------------------------------------------------
# Validación
# ---------------------------------------------------------------------------

def _field(src, name: str, where: str):
    f = src.field(name)
    if f is None:
        raise ValueError(f"unknown field '{name}' in {where} for source "
                         f"'{src.key}'")
    return f


def _cast_scalar(v, ftype: str, fname: str):
    if v is None:
        raise ValueError(f"a value is required for '{fname}'")
    if ftype in _NUM_TYPES:
        try:
            out = float(v)
        except (TypeError, ValueError):
            raise ValueError(f"'{fname}' needs a number (got {v!r})") \
                from None
        if not math.isfinite(out):
            raise ValueError(f"'{fname}' needs a number (got {v!r})")
        return out
    if ftype in ("date", "datetime"):
        d = _parse_day(v)
        if d is None:
            raise ValueError(f"'{fname}' needs a date as YYYY-MM-DD "
                             f"(got {v!r})")
        return d.isoformat()
    if ftype == "bool":
        if isinstance(v, bool):
            return v
        s = str(v).strip().lower()
        if s in ("true", "yes", "1", "y"):
            return True
        if s in ("false", "no", "0", "n"):
            return False
        raise ValueError(f"'{fname}' needs true or false (got {v!r})")
    return str(v)


def _as_list(v) -> list:
    if isinstance(v, (list, tuple)):
        return list(v)
    if v is None or v == "":
        return []
    return [x.strip() for x in str(v).split(",") if x.strip()]


def _compile_cond(src, c: Cond, mask_pii: bool) -> _Filter:
    f = _field(src, c.field, "filters")
    if f.pii and mask_pii:
        raise ValueError(f"you need permission to see contact info to "
                         f"filter by '{f.label}'")
    op, t = c.op, f.type
    if op == "contains" and t != "text":
        raise ValueError(f"'contains' only works on text fields "
                         f"('{c.field}' is {t})")
    if op in ("gt", "gte", "lt", "lte", "between") and t not in \
            _ORDERED_TYPES:
        raise ValueError(f"'{op}' needs a number or date field "
                         f"('{c.field}' is {t})")
    if op in ("empty", "not_empty"):
        val = None
    elif op in ("in", "not_in"):
        items = _as_list(c.value)
        if not items:
            raise ValueError(f"'{op}' on '{c.field}' needs a list of values")
        val = [_cast_scalar(x, t, c.field) for x in items[:500]]
    elif op == "between":
        items = _as_list(c.value)
        if len(items) != 2:
            raise ValueError(f"'between' on '{c.field}' needs two values")
        val = [_cast_scalar(x, t, c.field) for x in items]
        if val[0] > val[1]:
            val = [val[1], val[0]]
    else:
        val = _cast_scalar(c.value, t, c.field)
        if op == "contains":
            val = str(val)
    return _Filter(c.field, op, val, t)


def _out_key(col: ColumnSpec) -> str:
    return f"{col.agg}_{col.field}" if col.agg else col.field


def _agg_type(agg: str, ftype: str) -> str:
    if agg in ("count", "count_distinct"):
        return "number"
    if agg == "avg":
        return "money" if ftype == "money" else "number"
    return ftype


def validate(spec_obj, mask_pii: bool = False) -> Plan:
    spec = parse_spec(spec_obj)
    src = reg.get_source(spec.source)
    if src is None:
        raise ValueError(f"unknown source '{spec.source}' (valid: "
                         + ", ".join(reg.SOURCES) + ")")
    cols: list[_OutCol] = []
    seen: set[str] = set()
    is_agg = any(c.agg for c in spec.columns)
    for c in spec.columns:
        f = _field(src, c.field, "columns")
        if c.agg in ("sum", "avg") and f.type not in _NUM_TYPES:
            raise ValueError(f"'{c.agg}' needs a number or money field "
                             f"('{c.field}' is {f.type})")
        if c.agg in ("min", "max") and f.type == "bool":
            raise ValueError(f"'{c.agg}' doesn't work on yes/no fields "
                             f"('{c.field}')")
        key = _out_key(c)
        if key in seen:
            raise ValueError(f"column '{key}' appears twice")
        seen.add(key)
        if c.agg:
            label = c.label or f"{AGG_LABELS[c.agg]} {f.label}"
            if c.agg == "count" and not c.label:
                label = "Count"
            ctype = _agg_type(c.agg, f.type)
        else:
            label, ctype = c.label or f.label, f.type
        cols.append(_OutCol(key, label[:120], ctype, c.field, c.agg))

    group_by = list(dict.fromkeys(spec.group_by))
    for g in group_by:
        _field(src, g, "group_by")
    if is_agg:
        plain = [c.field for c in cols if not c.agg]
        if not group_by:
            group_by = list(dict.fromkeys(plain))
        missing = [p for p in plain if p not in group_by]
        if missing:
            raise ValueError(f"column '{missing[0]}' must be in group_by or "
                             "use an aggregation (count, sum, …)")
    elif group_by:
        raise ValueError("group_by needs at least one column with an "
                         "aggregation (count, sum, avg, min, max)")
    for g in group_by:
        gf = src.fields[g]
        if gf.pii and mask_pii:
            raise ValueError(f"you need permission to see contact info to "
                             f"group by '{gf.label}'")

    def _items(items):
        out = []
        for it in items:
            if isinstance(it, CondGroup):
                out.append(_Group(it.match, [_compile_cond(src, c, mask_pii)
                                             for c in it.items]))
            else:
                out.append(_compile_cond(src, it, mask_pii))
        return out

    filters = _Group(spec.filters.match, _items(spec.filters.items))

    today = org_config.org_today()
    time_field = None
    rng: tuple = (None, None)
    if spec.time is not None:
        tf = spec.time.field
        allowed = reg.time_fields(src)
        if tf not in allowed:
            if src.time_param:
                raise ValueError(f"the time range of '{src.key}' is the "
                                 f"period field '{src.default_time_field}'")
            raise ValueError(f"time field '{tf}' must be a date field of "
                             f"'{src.key}' ({', '.join(allowed) or 'none'})")
        if spec.time.preset == "custom":
            a = _parse_day(spec.time.from_)
            b = _parse_day(spec.time.to)
            if spec.time.from_ and a is None or spec.time.to and b is None:
                raise ValueError("custom time range needs dates as "
                                 "YYYY-MM-DD")
            if a is None and b is None:
                raise ValueError("custom time range needs 'from' and/or "
                                 "'to'")
            if a and b and a > b:
                raise ValueError("time range 'from' is after 'to'")
        rng = preset_range(spec.time.preset, today, spec.time.from_,
                           spec.time.to)
        time_field = tf if rng != (None, None) or src.time_param else None
        if src.time_param:
            time_field = tf

    out_keys = {c.key for c in cols}
    for s in spec.sort:
        if is_agg:
            if s.field not in out_keys and s.field not in group_by:
                raise ValueError(f"sort field '{s.field}' must be one of the "
                                 "report columns")
        else:
            sf = _field(src, s.field, "sort")
            if sf.pii and mask_pii:
                raise ValueError(f"you need permission to see contact info "
                                 f"to sort by '{sf.label}'")
    if spec.chart is not None and spec.chart.type != "none":
        for k in ([spec.chart.x] if spec.chart.x else []) + spec.chart.y:
            if k not in out_keys:
                raise ValueError(f"chart field '{k}' must be one of the "
                                 "report columns")

    needed = {c.field for c in cols} | set(group_by)
    if not is_agg:
        needed |= {s.field for s in spec.sort}

    def _walk(g: _Group):
        for it in g.items:
            if isinstance(it, _Group):
                _walk(it)
            else:
                needed.add(it.field)
    _walk(filters)
    if time_field and not src.time_param:
        needed.add(time_field)
    return Plan(spec, src, cols, group_by, is_agg, filters, time_field, rng,
                needed)


# ---------------------------------------------------------------------------
# Normalización y comparación (Python)
# ---------------------------------------------------------------------------

def _norm_value(v, ftype: str, tz):
    if v is None:
        return None
    if ftype == "text":
        return v if isinstance(v, str) else str(v)
    if ftype in _NUM_TYPES:
        if isinstance(v, bool):
            return float(v)
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        return f if math.isfinite(f) else None
    if ftype == "date":
        d = reg.as_date(v, tz)
        return d.isoformat() if d else None
    if ftype == "datetime":
        if isinstance(v, datetime):
            return reg.to_org_dt(v, tz)
        d = _parse_day(v)
        return datetime.combine(d, datetime.min.time()) if d else None
    if ftype == "bool":
        return bool(v)
    return v


def _cmp_val(v, ftype: str):
    """Valor comparable contra el valor (ya casteado) de un filtro."""
    if v is None:
        return None
    if ftype == "datetime":
        return v.date().isoformat()
    if ftype == "text":
        return v.lower()
    return v


def _eval_filter(row: dict, f: _Filter) -> bool:
    raw = row.get(f.field)
    if f.op == "empty":
        return raw is None or raw == ""
    if f.op == "not_empty":
        return not (raw is None or raw == "")
    v = _cmp_val(raw, f.ftype)
    val = f.value
    if f.ftype == "text":
        val = ([x.lower() for x in val] if isinstance(val, list)
               else str(val).lower())
    if f.op == "eq":
        return v == val
    if f.op == "ne":
        return v != val
    if f.op == "in":
        return v in val
    if f.op == "not_in":
        return v not in val
    if f.op == "contains":
        return v is not None and val in v
    if v is None:
        return False
    if f.op == "gt":
        return v > val
    if f.op == "gte":
        return v >= val
    if f.op == "lt":
        return v < val
    if f.op == "lte":
        return v <= val
    if f.op == "between":
        return val[0] <= v <= val[1]
    return False


def _eval_group(row: dict, g: _Group) -> bool:
    if not g.items:
        return True
    results = (_eval_group(row, it) if isinstance(it, _Group)
               else _eval_filter(row, it) for it in g.items)
    return all(results) if g.match == "all" else any(results)


# ---------------------------------------------------------------------------
# SQL (fuentes tabla)
# ---------------------------------------------------------------------------

def _closure(src, names: set) -> set:
    out: set = set()
    stack = list(names)
    while stack:
        n = stack.pop()
        if n in out:
            continue
        f = src.fields.get(n)
        if f is None:
            continue
        out.add(n)
        stack.extend(f.deps)
    return out


def _joins_for(src, fields: list) -> list[str]:
    want: set = set()
    stack = [src.fields[n].join for n in fields if src.fields[n].join]
    while stack:
        j = stack.pop()
        if j in want:
            continue
        want.add(j)
        stack.extend(src.joins[j].requires)
    return [j for j in src.joins if j in want]


def _py_type(col):
    try:
        return col.type.python_type
    except (AttributeError, NotImplementedError):
        return None


def _sql_cond(src, f: _Filter):
    """Expresión SQL equivalente al filtro Python, o None si no conviene
    empujarlo (derivados, datetimes, contains case-insensitive…)."""
    fd = src.fields[f.field]
    if not fd.is_sql or f.ftype == "datetime":
        return None
    col = fd.col
    if f.ftype == "date":
        # Solo columnas String 'YYYY-MM-DD' (comparación ISO); Date nativa
        # se resuelve en Python.
        if _py_type(col) is not str:
            return None
    op, val = f.op, f.value
    if f.ftype == "text" and op not in ("empty", "not_empty"):
        # Case-insensitive como en Python. Solo con valores ASCII: ahí
        # lower() de SQLite/Postgres y str.lower() coinciden; si no, el
        # filtro queda en Python. `contains` usa LIKE con autoescape (los
        # % y _ del usuario son literales).
        vals = val if isinstance(val, list) else [val]
        if not all(str(v).isascii() for v in vals):
            return None
        lc = func.lower(col)
        if op == "eq":
            return lc == str(val).lower()
        if op == "ne":
            return or_(lc != str(val).lower(), col.is_(None))
        if op == "in":
            return lc.in_([str(v).lower() for v in val])
        if op == "not_in":
            return or_(lc.not_in([str(v).lower() for v in val]),
                       col.is_(None))
        if op == "contains":
            return col.icontains(str(val), autoescape=True)
        return None
    if op == "empty":
        return (or_(col.is_(None), col == "") if f.ftype in ("text", "date")
                else col.is_(None))
    if op == "not_empty":
        return (and_(col.is_not(None), col != "")
                if f.ftype in ("text", "date") else col.is_not(None))
    if op == "eq":
        return col == val
    if op == "ne":
        return or_(col != val, col.is_(None))
    if op == "in":
        return col.in_(val)
    if op == "not_in":
        return or_(col.not_in(val), col.is_(None))
    if op == "gt":
        return col > val
    if op == "gte":
        return col >= val
    if op == "lt":
        return col < val
    if op == "lte":
        return col <= val
    if op == "between":
        return col.between(val[0], val[1])
    return None


def _sql_time(src, field: str, rng: tuple):
    fd = src.fields.get(field)
    if fd is None or not fd.is_sql:
        return None
    a, b = rng
    if fd.type == "datetime":
        conds = []
        if a is not None:
            conds.append(fd.col >= org_config.org_day_start(a))
        if b is not None:
            conds.append(fd.col < org_config.org_day_start(
                b + timedelta(days=1)))
        return and_(*conds) if conds else None
    pytype = _py_type(fd.col)
    conds = []
    if pytype is str:
        if a is not None:
            conds.append(fd.col >= a.isoformat())
        if b is not None:
            conds.append(fd.col <= b.isoformat())
            conds.append(fd.col != "")
    elif pytype is date:
        if a is not None:
            conds.append(fd.col >= a)
        if b is not None:
            conds.append(fd.col <= b)
    else:
        return None
    return and_(*conds) if conds else None


def _fetch_sql(plan: Plan, ctx: RunContext) -> tuple[list[dict], bool, set]:
    """Filas crudas + truncado-por-scan + filtros ya empujados a SQL."""
    src = plan.source
    names = _closure(src, ctx.needed)
    sql_names = [n for n in src.fields if n in names
                 and src.fields[n].is_sql]
    cols = [src.fields[n].col.label(n) for n in sql_names]
    if not cols:
        cols = [src.model.id.label("__pk")]
    stmt = select(*cols).select_from(src.model)
    for jn in _joins_for(src, sql_names):
        j = src.joins[jn]
        stmt = stmt.outerjoin(j.target, and_(j.on,
                                             j.target.org_id == ctx.org))
    stmt = stmt.where(src.model.org_id == ctx.org, *src.where)

    pushed: set = set()
    if plan.time_field:
        tc = _sql_time(src, plan.time_field, plan.time_range)
        if tc is not None:
            stmt = stmt.where(tc)
            pushed.add("__time__")
    if plan.filters.match == "all":
        for it in plan.filters.items:
            if isinstance(it, _Filter):
                expr = _sql_cond(src, it)
                if expr is not None:
                    stmt = stmt.where(expr)
                    pushed.add(id(it))
    stmt = stmt.order_by(src.model.id).limit(MAX_SCAN + 1)

    posts: list = []
    for n in src.fields:
        f = src.fields[n]
        if n in names and f.post is not None and f.post not in posts:
            posts.append(f.post)

    with SessionLocal() as session:
        if session.get_bind().dialect.name == "postgresql":
            session.execute(text(
                f"SET LOCAL statement_timeout = {STATEMENT_TIMEOUT_MS}"))
        rows = [dict(r._mapping) for r in session.execute(stmt)]
        scan_truncated = len(rows) > MAX_SCAN
        if scan_truncated:
            rows = rows[:MAX_SCAN]
        for post in posts:
            post(session, rows, ctx)
        session.rollback()
    for n in src.fields:
        f = src.fields[n]
        if n in names and f.fn is not None:
            for r in rows:
                try:
                    r[n] = f.fn(r, ctx)
                except Exception:  # noqa: BLE001 — un dato raro = vacío
                    r[n] = None
    return rows, scan_truncated, pushed


# ---------------------------------------------------------------------------
# Agregación / orden / salida
# ---------------------------------------------------------------------------

def _agg(values: list, agg: str, ftype: str):
    vals = [v for v in values if v is not None and v != ""]
    if agg == "count":
        return len(vals)
    if agg == "count_distinct":
        return len({(v.lower() if isinstance(v, str) else v) for v in vals})
    if not vals:
        return None
    if agg == "sum":
        return sum(vals)
    if agg == "avg":
        return sum(vals) / len(vals)
    if agg == "min":
        return min(vals)
    if agg == "max":
        return max(vals)
    return None


def _sort_rows(rows: list[dict], sort: list[SortSpec]) -> list[dict]:
    for s in reversed(sort):
        k = s.field
        present = [r for r in rows if r.get(k) is not None
                   and r.get(k) != ""]
        missing = [r for r in rows if r.get(k) is None or r.get(k) == ""]

        def key(r, k=k):
            v = r.get(k)
            return v.lower() if isinstance(v, str) else v
        try:
            present.sort(key=key, reverse=(s.dir == "desc"))
        except TypeError:
            present.sort(key=lambda r, k=k: str(r.get(k)),
                         reverse=(s.dir == "desc"))
        rows = present + missing
    return rows


def _out_value(v, ctype: str):
    if v is None:
        return None
    if ctype == "money":
        return round(float(v), 2)
    if ctype == "number":
        f = float(v)
        if f.is_integer() and abs(f) < 1e15:
            return int(f)
        return round(f, 4)
    if ctype == "datetime" and isinstance(v, datetime):
        return v.replace(microsecond=0).isoformat()
    return v


def _mask(v, kind: str | None):
    if v is None or v == "" or not kind:
        return v
    if kind == "email":
        return pii.mask_email(str(v))
    if kind == "phone":
        return pii.mask_phone(str(v))
    return pii.mask_text(str(v))


def _context() -> tuple[int, date, Any]:
    org = tenant.get_current_org()
    if org is None:
        raise ValueError("no organization in context")
    return org, org_config.org_today(), org_config.org_tz()


async def run(spec_obj, mask_pii: bool = False) -> dict:
    """Ejecuta una spec y devuelve {columns, rows, row_count, total_count,
    truncated, ms, totals?, chart, source, time, warnings, spec}."""
    t0 = _time.perf_counter()
    org, today, tz = _context()
    plan = validate(spec_obj, mask_pii=mask_pii)
    spec, src = plan.spec, plan.source
    ctx = RunContext(org=org, today=today, tz=tz, mask_pii=mask_pii,
                     needed=set(plan.needed), date_from=plan.time_range[0],
                     date_to=plan.time_range[1], time_field=plan.time_field)

    pushed: set = set()
    scan_truncated = False
    if src.is_sql:
        rows, scan_truncated, pushed = await asyncio.to_thread(
            _fetch_sql, plan, ctx)
    else:
        rows = await src.provider(ctx)

    # Normalización por tipo de los campos usados.
    types = {n: src.fields[n].type for n in plan.needed if n in src.fields}
    for r in rows:
        for n, t in types.items():
            r[n] = _norm_value(r.get(n), t, tz)

    # Tiempo (si no se empujó a SQL / provider de período).
    tf = plan.time_field
    if tf and not src.time_param and "__time__" not in pushed:
        a, b = plan.time_range
        lo = a.isoformat() if a else None
        hi = b.isoformat() if b else None
        ftype = src.fields[tf].type

        def _in(r):
            v = r.get(tf)
            if v is None:
                return False
            d = v.date().isoformat() if ftype == "datetime" else v
            return (lo is None or d >= lo) and (hi is None or d <= hi)
        rows = [r for r in rows if _in(r)]

    # Filtros restantes.
    remaining = _Group(plan.filters.match,
                       [it for it in plan.filters.items
                        if id(it) not in pushed])
    if remaining.items:
        rows = [r for r in rows if _eval_group(r, remaining)]

    cols = plan.columns
    totals = None
    if plan.is_agg:
        groups: dict[tuple, list[dict]] = {}
        for r in rows:
            k = tuple((r.get(g).lower() if isinstance(r.get(g), str)
                       else r.get(g)) for g in plan.group_by)
            groups.setdefault(k, []).append(r)
        if not groups and not plan.group_by:
            # Agregado total sin agrupar (KPI): SIEMPRE una fila (count 0),
            # como un SELECT COUNT(*) sin GROUP BY.
            groups[()] = []
        out_rows = []
        for members in groups.values():
            first = members[0] if members else {}
            o = {g: first.get(g) for g in plan.group_by}
            for c in cols:
                if c.agg:
                    o[c.key] = _agg([m.get(c.field) for m in members], c.agg,
                                    src.fields[c.field].type)
                else:
                    o[c.key] = first.get(c.field)
            out_rows.append(o)
        if spec.totals:
            totals = {}
            for c in cols:
                if not c.agg:
                    continue
                vals = [o[c.key] for o in out_rows if o[c.key] is not None]
                if c.agg in ("count", "sum"):
                    totals[c.key] = sum(vals) if vals else 0
                elif c.agg == "count_distinct":
                    totals[c.key] = _agg([r.get(c.field) for r in rows],
                                         "count_distinct", "text")
                elif c.agg == "avg":
                    totals[c.key] = _agg([r.get(c.field) for r in rows],
                                         "avg", c.type)
                elif vals and c.type != "text":
                    totals[c.key] = (min(vals) if c.agg == "min"
                                     else max(vals))
        rows = out_rows
    else:
        if spec.totals:
            totals = {}
            for c in cols:
                f = src.fields[c.field]
                if c.type in _NUM_TYPES and not f.nosum:
                    totals[c.key] = sum(r.get(c.field) or 0 for r in rows)
        rows = [{**{c.key: r.get(c.field) for c in cols},
                 **{s.field: r.get(s.field) for s in spec.sort
                    if s.field not in {c.key for c in cols}}}
                for r in rows]

    if spec.sort:
        rows = _sort_rows(rows, spec.sort)
    total_count = len(rows)
    truncated = total_count > spec.limit or scan_truncated
    rows = rows[:spec.limit]

    pii_kind = {c.key: src.fields[c.field].pii for c in cols
                if src.fields[c.field].pii and mask_pii
                and c.agg not in ("count", "count_distinct")}
    keys = [c.key for c in cols]
    out_rows = []
    for r in rows:
        o = {}
        for c in cols:
            v = _out_value(r.get(c.key), c.type)
            if c.key in pii_kind:
                v = _mask(v, pii_kind[c.key])
            o[c.key] = v
        out_rows.append(o)
    if totals is not None:
        totals = {k: _out_value(v, next(c.type for c in cols if c.key == k))
                  for k, v in totals.items() if k in keys}

    warnings = list(dict.fromkeys(ctx.warnings))
    if scan_truncated:
        warnings.append(f"More than {MAX_SCAN:,} rows matched; narrow the "
                        "date range or add filters.")
    elif truncated and (spec.time is None or spec.time.preset == "all"):
        warnings.append(f"No date filter — results capped at "
                        f"{spec.limit:,} rows.")
    elif truncated:
        warnings.append(f"Results capped at {spec.limit:,} rows.")

    a, b = plan.time_range
    result = {
        "source": src.key,
        "columns": [{"key": c.key, "label": c.label, "type": c.type,
                     "field": c.field, "agg": c.agg,
                     **({"pii": True} if src.fields[c.field].pii else {}),
                     **({"enum": [{"value": k, "label": v} for k, v in
                                  src.fields[c.field].enum.items()]}
                        if src.fields[c.field].enum and not c.agg else {})}
                    for c in cols],
        "rows": out_rows,
        "row_count": len(out_rows),
        "total_count": total_count,
        "truncated": truncated,
        "ms": int((_time.perf_counter() - t0) * 1000),
        "chart": (spec.chart.model_dump(exclude_none=True)
                  if spec.chart else None),
        "time": ({"field": spec.time.field, "preset": spec.time.preset,
                  "label": PRESET_LABELS[spec.time.preset],
                  "from": a.isoformat() if a else None,
                  "to": b.isoformat() if b else None}
                 if spec.time else None),
        "warnings": warnings,
        "spec": spec_dict(spec),
        "pii_masked": bool(pii_kind),
    }
    if totals is not None:
        result["totals"] = totals
    return result


def describe_filters(spec_obj) -> list[str]:
    """Texto legible de los filtros (chips del viewer / cuerpo del email)."""
    spec = parse_spec(spec_obj)
    src = reg.get_source(spec.source)
    out = []

    def one(c: Cond) -> str:
        f = src.fields.get(c.field) if src else None
        label = f.label if f else c.field
        val = "" if c.op in ("empty", "not_empty") else (
            ", ".join(map(str, c.value)) if isinstance(c.value, list)
            else str(c.value))
        return f"{label} {OP_LABELS.get(c.op, c.op)} {val}".strip()
    for it in spec.filters.items:
        if isinstance(it, CondGroup):
            joiner = " and " if it.match == "all" else " or "
            out.append("(" + joiner.join(one(c) for c in it.items) + ")")
        else:
            out.append(one(it))
    return out


def month_end(d: date) -> date:
    return d.replace(day=calendar.monthrange(d.year, d.month)[1])
