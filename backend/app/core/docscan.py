# -*- coding: utf-8 -*-
"""Escáner AI de documentos de taller (fase H2.5).

Sube un invoice/estimate/repair order (PDF o foto) y un modelo de visión
extrae los campos de la work order: unidad, fecha, millaje, issue,
mecánico y las líneas de partes/labor con costos. Salida ESTRUCTURADA
(JSON schema de Pydantic): nunca se parsea texto libre.

Proveedores, elegibles en `backend/docscan.local.json` (gitignored):

- "ollama" (GRATIS): modelo local vía Ollama en la propia PC.
  Setup una sola vez:  winget install Ollama.Ollama
                       ollama pull qwen2.5vl:7b   (~6 GB)
  Corre offline, costo cero, los documentos nunca salen de la máquina.
- "textract" (comercial, $0.008/página): AWS Textract AnalyzeExpense,
  el motor purpose-built de invoices que usan los SaaS grandes. Da
  vendor/fecha/invoice#/line items nativamente; los campos de flota
  (unit, odometer, complaint) se completan con el overlay heurístico
  sobre el texto detectado. Credenciales IAM con permiso
  textract:AnalyzeExpense; el ping usa STS GetCallerIdentity (gratis).
- "anthropic" (pago por uso): Claude vía API. Key de platform.claude.com.
- "auto": textract si hay credenciales AWS, si no anthropic si hay
  api_key, si no ollama.

Además hay un fallback heurístico sin AI (regex sobre la capa de texto)
cuando el proveedor elegido no está disponible y el PDF es digital.

PDFs: primero se intenta la CAPA DE TEXTO (pypdf) — los PDFs digitales
de Fullbay/talleres casi siempre la tienen y el texto es más preciso y
rápido que la visión. Si es un escaneo sin texto, se renderizan las
primeras páginas a PNG (pypdfium2, licencia permisiva) y van por visión.

El test de conexión nunca factura: models.retrieve (Anthropic) o
GET /api/tags (Ollama).
"""

from __future__ import annotations

import base64
import io
import json
import re
import time

import httpx
from pydantic import BaseModel, Field, ValidationError

from .. import config

try:
    import anthropic
    _HAS_ANTHROPIC = True
except ImportError:                            # dep opcional
    _HAS_ANTHROPIC = False

try:
    from pypdf import PdfReader
    _HAS_PYPDF = True
except ImportError:
    _HAS_PYPDF = False

try:
    import pypdfium2 as pdfium
    _HAS_PDFIUM = True
except ImportError:
    _HAS_PDFIUM = False

try:
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError
    _HAS_BOTO = True
except ImportError:
    _HAS_BOTO = False

SETTINGS_PATH = config.BACKEND_DIR / "docscan.local.json"
# Compat: la primera versión guardaba en anthropic.local.json.
_LEGACY_PATH = config.BACKEND_DIR / "anthropic.local.json"

DEFAULT_CLAUDE_MODEL = "claude-opus-4-8"
DEFAULT_OLLAMA_MODEL = "qwen2.5vl:7b"
DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"

MEDIA_TYPES = {
    "application/pdf": "document",
    "image/jpeg": "image",
    "image/png": "image",
    "image/webp": "image",
    "image/gif": "image",
}
MAX_BYTES = 20 * 1024 * 1024          # 20 MB
_PDF_PAGES = 3                        # páginas a leer/renderizar
_MIN_TEXT = 200                       # chars para confiar en la capa de texto
_OLLAMA_TIMEOUT = 300                 # un 7B local puede tardar 1-2 min

_PROMPT = """\
This document is a truck repair shop invoice, estimate, or repair order
for a trucking fleet. One invoice can cover MORE THAN ONE job, sometimes
on different units (e.g. a PM on a tractor AND a tire on its trailer).
Extract the shared invoice fields and ONE complaint per distinct job.

Shared fields:
- vendor: the repair shop / vendor name (e.g. "Love's Truck Care",
  "Sounders Truck Repair"). Not the fleet's own name.
- vendor_city, vendor_state: the shop location (city and 2-letter state).
- service_date: the service / invoice / work order date as YYYY-MM-DD.
- invoice_number: the invoice number, or the work order number if that
  is the only number printed.

complaints: a list, ONE entry per distinct job/repair. If the invoice
shows one tractor job and one trailer job, return TWO complaints.
Each complaint:
- unit: the truck/trailer unit number that THIS job was done on
  (e.g. CF2246, 743451, MEM-1042). Prefer the fleet unit code over the
  VIN or plate. Tractor/Truck # and Trailer # are usually separate units.
- mileage: that unit's odometer / hubometer for this job, integer, no
  commas. Null if absent.
- detail: a SHORT, CLEAR description of the issue and work done, at most
  4 short lines. Plain prose, no part numbers or prices. E.g.
  "PM service - oil change with 10W30 and OEM filters (DD13)" or
  "LFO tire blown - replaced 295/75R22.5, aired to 100 psi".
- is_pm: true only if this job is a preventive maintenance service
  (full/wet service, oil change service, PM A/B).

lines: every billed item across the whole invoice. kind "part" for
parts/materials, "labor" for labor/diagnostic time. READ THE QUANTITY
COLUMN CAREFULLY: many invoices print qty (often under QTY or EA) before
the unit price, and it can be large (39 quarts of oil) or fractional
(3.5 hours). qty = billed quantity (hours for labor). unit_cost = price
per single unit/hour. total = the line total if printed. The math must
hold: qty x unit_cost = total. Never default qty to 1 when the document
shows a quantity. Skip taxes, shop supplies percentages, fees and totals.

Use null when a field is not in the document. Do not invent data.
"""


class WoLineExtract(BaseModel):
    kind: str = Field(description="part | labor")
    description: str
    qty: float = 1
    unit_cost: float = 0
    total: float | None = Field(
        default=None,
        description="line total if printed on the document")


class WoComplaint(BaseModel):
    """Un job del invoice (puede haber varios, en distintas unidades)."""
    unit: str | None = None
    mileage: int | None = None
    detail: str = Field(default="",
                        description="short issue description, max 4 lines")
    is_pm: bool = False


class WoExtract(BaseModel):
    service_date: str | None = None
    vendor: str | None = None
    vendor_city: str | None = None
    vendor_state: str | None = None
    invoice_number: str | None = None
    mechanic: str | None = None
    complaints: list[WoComplaint] = []
    lines: list[WoLineExtract] = []


# ----- Settings -----------------------------------------------------------

def load_settings() -> dict:
    path = SETTINGS_PATH if SETTINGS_PATH.exists() else _LEGACY_PATH
    data: dict = {}
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
    return {
        "provider": str(data.get("provider") or "auto"),
        "api_key": str(data.get("api_key") or ""),
        "model": str(data.get("model") or DEFAULT_CLAUDE_MODEL),
        "ollama_url": str(data.get("ollama_url") or DEFAULT_OLLAMA_URL),
        "ollama_model": str(data.get("ollama_model")
                            or DEFAULT_OLLAMA_MODEL),
        "aws_access_key_id": str(data.get("aws_access_key_id") or ""),
        "aws_secret_access_key": str(data.get("aws_secret_access_key")
                                     or ""),
        "aws_region": str(data.get("aws_region") or "us-east-1"),
    }


def _has_aws(s: dict) -> bool:
    return bool(s["aws_access_key_id"] and s["aws_secret_access_key"])


def resolved_provider(s: dict | None = None) -> str:
    s = s or load_settings()
    if s["provider"] in ("anthropic", "ollama", "textract"):
        return s["provider"]
    # auto: el motor comercial primero, luego Claude, luego local gratis.
    if _has_aws(s):
        return "textract"
    if s["api_key"]:
        return "anthropic"
    return "ollama"


def status() -> tuple[str, str]:
    """(status, detail) para la lista de Connectivity, sin red."""
    s = load_settings()
    prov = resolved_provider(s)
    if prov == "textract":
        if not _has_aws(s):
            return "not_configured", "Configure AWS credentials"
        return "connected", f"AWS Textract · {s['aws_region']}"
    if prov == "anthropic":
        if not s["api_key"]:
            return "not_configured", "Configure an Anthropic API key"
        return "connected", f"Claude · {s['model']}"
    return "connected", f"Local Ollama · {s['ollama_model']} (free)"


# ----- Test de conexión ----------------------------------------------------

def _boto(s: dict, service: str):
    return boto3.client(
        service,
        region_name=s["aws_region"],
        aws_access_key_id=s["aws_access_key_id"],
        aws_secret_access_key=s["aws_secret_access_key"],
    )


async def ping() -> dict:
    """Chequeo vivo del proveedor activo. Nunca factura tokens/páginas."""
    s = load_settings()
    prov = resolved_provider(s)
    if prov == "textract":
        if not _HAS_BOTO:
            return {"ok": False, "detail": "pip install boto3"}
        if not _has_aws(s):
            return {"ok": False, "detail": "Not configured"}

        def sts_check() -> dict:
            t0 = time.monotonic()
            try:
                ident = _boto(s, "sts").get_caller_identity()
                ms = int((time.monotonic() - t0) * 1000)
                acct = ident.get("Account", "")
                return {"ok": True,
                        "detail": f"AWS account …{acct[-4:]} OK ({ms} ms) "
                                  f"· {s['aws_region']}"}
            except ClientError as exc:
                code = exc.response.get("Error", {}).get("Code", "")
                return {"ok": False, "detail": f"AWS: {code}"}
            except BotoCoreError as exc:
                return {"ok": False, "detail": type(exc).__name__}

        import asyncio
        return await asyncio.to_thread(sts_check)

    if prov == "anthropic":
        if not _HAS_ANTHROPIC:
            return {"ok": False, "detail": "pip install anthropic"}
        if not s["api_key"]:
            return {"ok": False, "detail": "Not configured"}
        t0 = time.monotonic()
        try:
            client = anthropic.AsyncAnthropic(api_key=s["api_key"])
            m = await client.models.retrieve(s["model"])
            ms = int((time.monotonic() - t0) * 1000)
            return {"ok": True, "detail": f"{m.display_name} OK ({ms} ms)"}
        except anthropic.AuthenticationError:
            return {"ok": False, "detail": "Invalid API key"}
        except anthropic.NotFoundError:
            return {"ok": False, "detail": f"Unknown model '{s['model']}'"}
        except anthropic.APIError as exc:
            return {"ok": False, "detail": type(exc).__name__}

    # Ollama local
    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=4) as client:
            r = await client.get(f"{s['ollama_url']}/api/tags")
        models = [m.get("name", "") for m in r.json().get("models", [])]
        ms = int((time.monotonic() - t0) * 1000)
        want = s["ollama_model"]
        if any(m == want or m.split(":")[0] == want.split(":")[0]
               for m in models):
            return {"ok": True,
                    "detail": f"{want} ready ({ms} ms) · local, free"}
        return {"ok": False,
                "detail": f"Ollama is running but '{want}' is missing. "
                          f"Run: ollama pull {want}"}
    except (httpx.HTTPError, ValueError):
        return {"ok": False,
                "detail": "Ollama not running. Install it (ollama.com) "
                          "and run: ollama pull " + s["ollama_model"]}


# ----- Preparación del documento -------------------------------------------

def _pdf_text(raw: bytes) -> str:
    if not _HAS_PYPDF:
        return ""
    try:
        reader = PdfReader(io.BytesIO(raw))
        pages = reader.pages[:_PDF_PAGES]
        return "\n".join((p.extract_text() or "") for p in pages).strip()
    except Exception:  # noqa: BLE001 — PDFs corruptos: se cae a visión
        return ""


def _pdf_images_b64(raw: bytes) -> list[str]:
    """Renderiza las primeras páginas a PNG base64 (PDF escaneado)."""
    if not _HAS_PDFIUM:
        raise ValueError(
            "This PDF has no text layer and pypdfium2 is not installed. "
            "Run: pip install pypdfium2 (or upload a photo instead).")
    pdf = pdfium.PdfDocument(raw)
    out: list[str] = []
    for i in range(min(len(pdf), _PDF_PAGES)):
        pil = pdf[i].render(scale=2.0).to_pil()
        buf = io.BytesIO()
        pil.save(buf, format="PNG")
        out.append(base64.standard_b64encode(buf.getvalue()).decode())
    return out


def _normalize(extract: WoExtract, model: str,
               tokens: dict | None = None) -> dict:
    out = extract.model_dump()
    for ln in out["lines"]:
        ln["kind"] = ("labor"
                      if str(ln["kind"]).lower().startswith("lab")
                      else "part")
        # Reconciliación de cantidades: si el total impreso no cuadra
        # con qty x unitario, la cantidad real es total / unitario
        # (caso Loves: 39 x 3.51 = 136.88 pero el modelo leyó qty=1).
        total = ln.pop("total", None)
        qty = ln.get("qty") or 1
        unit_cost = ln.get("unit_cost") or 0
        if total and unit_cost and abs(qty * unit_cost - total) > 0.05:
            derived = total / unit_cost
            if 0 < derived < 10000:
                ln["qty"] = round(derived, 2)
    return {"extract": out, "model": model, "tokens": tokens or {}}


# ----- Scan ----------------------------------------------------------------

async def scan(raw: bytes, media_type: str) -> dict:
    """Extrae los campos de la work order. ValueError = mensaje de UI.

    Cadena de degradación: proveedor AI elegido -> si no está disponible
    y el PDF tiene capa de texto, cae al parser heurístico (sin AI, como
    el software clásico de zonal OCR). Las fotos sí necesitan un modelo
    de visión.
    """
    if media_type not in MEDIA_TYPES:
        raise ValueError("Unsupported file type. Use PDF, JPG, PNG or WEBP.")
    s = load_settings()
    prov = resolved_provider(s)

    # PDFs digitales: la capa de texto le sirve a todos los caminos
    # (más precisa y barata que la visión).
    pdf_text = ""
    if media_type == "application/pdf":
        pdf_text = _pdf_text(raw)

    try:
        if prov == "textract":
            return await _scan_textract(s, raw, media_type)
        if prov == "anthropic":
            return await _scan_anthropic(s, raw, media_type)
        return await _scan_ollama(s, raw, media_type, pdf_text)
    except ValueError:
        if len(pdf_text) >= _MIN_TEXT:
            return _scan_heuristic(pdf_text)
        raise


# ----- Parser heurístico (sin AI, sin instalar nada) ------------------------

_RE_UNIT_INLINE = re.compile(
    r"\bunit\s*[:#]?\s*([A-Z]{1,4}[- ]?\d{3,7}[A-Z]?)", re.IGNORECASE)
# Fila de encabezado de unidad (TRACTOR/TRUCK/TRAILER/UNIT #) seguida de la
# fila de datos cuya primera columna es el código de unidad.
_RE_UNIT_HEADER = re.compile(r"\b(TRACTOR|TRUCK|TRAILER|UNIT)\s*#",
                             re.IGNORECASE)
_RE_UNIT_CODE = re.compile(
    r"^[\W]*([A-Z]{1,4}[- ]?\d{3,7}[A-Z]?|\d{4,7})\b")
_RE_DATE = re.compile(r"\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b")
_RE_INVNO = re.compile(
    r"\b(?:invoice|work\s*order|repair\s*order|\bwo\b|\bro\b)\s*#?\s*[:.]?\s*"
    r"(\d[\w-]{3,15}|[A-Z]{2,4}-?\d{2,12})", re.IGNORECASE)
# Layout invertido: el número va ANTES del rótulo (Love's: "4009978541
# WORK ORDER # :").
_RE_INVNO_REV = re.compile(
    r"\b(\d{6,12})\s*(?:work\s*order|invoice|repair\s*order)\s*#",
    re.IGNORECASE)
_RE_CITYST = re.compile(r"([A-Za-z][A-Za-z .'&-]{2,30}?)\s*,\s*([A-Z]{2})\b")
# Sufijos de calle: para quedarnos solo con la ciudad ("482 Tree Farm Rd.
# New Florence" -> "New Florence").
_RE_STREET = re.compile(
    r"^.*\b(?:rd|st|ave|blvd|dr|ln|hwy|pkwy|way|pointe|pike|ct|cir)\.?\s+",
    re.IGNORECASE)
_RE_COMPLAINT = re.compile(
    r"\bcomplaint\s*#?\d*\s*[:\-]?\s*(.+)", re.IGNORECASE)
_RE_CORRECTION = re.compile(
    r"\b(?:correction|service comments?)\s*[:\-]?\s*(.+)", re.IGNORECASE)
# Línea facturable: qty + descripción + precio unitario + total.
_RE_LINE = re.compile(
    r"^\s*(\d+(?:\.\d+)?)\s+(.{3,70}?)\s+\$?([\d,]+\.\d{2})"
    r"\s+\$?([\d,]+\.\d{2})\s*$")
_SKIP_LINE = re.compile(
    r"subtotal|total|tax|shop supplies|qty\b|description",
    re.IGNORECASE)
_LABORISH = re.compile(r"labor|labour|diag|inspect|service call|shop time",
                       re.IGNORECASE)
_PM_RE = re.compile(r"\bPM\b|full (?:wet )?service|oil change|pm service",
                    re.IGNORECASE)
_TIRE_RE = re.compile(
    r"\btires?\b|\bL[FR][OI]?\b|\bR[FR][OI]?\b|\bwheel\b|\brim\b|"
    r"\btread\b|\bblow|\bmount\b", re.IGNORECASE)
_KNOWN_SHOPS = re.compile(
    r"love'?s|speedco|\bta\b|petro|pilot|sounders|fleetpride|truck\s*care|"
    r"truck\s*repair|tire", re.IGNORECASE)


def _clean_detail(s: str) -> str:
    """Limpia un texto de complaint: saca metadatos [Nombre - fecha],
    emails, teléfonos y prefijos de categoría; condensa a ~4 líneas."""
    s = re.sub(r"\[[^\]]*\]", "", s)                       # [Keith - fecha]
    s = re.sub(r"\S+@\S+", "", s)                          # emails
    s = re.sub(r"\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b", "", s)  # teléfonos
    # Prefijos de categoría encadenados ("Tractor/Other- PMs- ").
    s = re.sub(
        r"^(?:(?:tractor|trailer|truck|other|pms?|misc|cause|general)"
        r"\s*[/:\-]+\s*)+", "", s, flags=re.IGNORECASE)
    s = " ".join(s.split())
    return s[:240].strip(" ,.-")


def _clean_city(raw: str) -> str:
    """Saca un prefijo de calle ('482 Tree Farm Rd. New Florence')."""
    city = _RE_STREET.sub("", raw).strip()
    return (city or raw).strip()[:60]


def _find_units(text: str) -> list[tuple[str, int | None, str]]:
    """(unit, mileage, kind) por filas encabezado→datos. kind: tractor|
    trailer|unit."""
    lines = text.splitlines()
    out: list[tuple[str, int | None, str]] = []
    seen: set[str] = set()
    for i, ln in enumerate(lines):
        mh = _RE_UNIT_HEADER.search(ln)
        if not mh:
            continue
        kind = mh.group(1).lower()
        kind = "trailer" if kind == "trailer" else (
            "unit" if kind == "unit" else "tractor")
        for j in range(i + 1, min(i + 3, len(lines))):
            data = lines[j].strip()
            if not data:
                continue
            mc = _RE_UNIT_CODE.match(data)
            if not mc:
                break
            unit = mc.group(1).replace(" ", "").upper()
            # Un token puramente numérico de 4 dígitos en rango de año es
            # el AÑO del vehículo, no la unidad (la fila arrancó sin código).
            if unit.isdigit() and len(unit) == 4 and 1990 <= int(unit) <= 2099:
                break
            if unit in seen:
                break
            miles = None
            rest = data[mc.end():]               # tras el código de unidad
            unit_digits = re.sub(r"\D", "", unit)
            for num in re.findall(r"\b(\d{4,7})\b", rest):
                v = int(num)
                # Excluir años y el ECO del propio número de unidad (un
                # layout que repite el código no debe volverse millaje).
                if num == unit_digits or 1990 <= v <= 2099:
                    continue
                if 1000 <= v <= 2_000_000:
                    miles = max(miles or 0, v)
            seen.add(unit)
            out.append((unit, miles, kind))
            break
    if not out:                                  # respaldo: "unit: CODE"
        for m in _RE_UNIT_INLINE.finditer(text):
            u = m.group(1).replace(" ", "").upper()
            if u not in seen:
                seen.add(u)
                out.append((u, None, "unit"))
    return out


def _build_complaints(text: str,
                      units: list[tuple[str, int | None, str]]
                      ) -> list[WoComplaint]:
    """Arma una complaint por unidad, ruteando los textos de detalle por
    palabra clave (llanta→trailer, PM→tractor)."""
    details: list[str] = []
    for rx in (_RE_COMPLAINT, _RE_CORRECTION):
        for m in rx.finditer(text):
            d = _clean_detail(m.group(1))
            if d and d not in details:
                details.append(d)
    if not units:
        joined = " · ".join(details)[:240] or "Service per invoice"
        return [WoComplaint(unit=None, detail=joined,
                            is_pm=bool(_PM_RE.search(text)))]

    # Dos pasadas GLOBALES para no robar el match de otra unidad: primero
    # se asignan todos los type-match (llanta→trailer, resto→tractor/unit),
    # recién después se reparten los detalles sobrantes.
    used: set[int] = set()
    assigned: dict[int, str] = {}
    for ui, (_unit, _miles, kind) in enumerate(units):
        for k, d in enumerate(details):
            if k in used:
                continue
            if (kind == "trailer") == bool(_TIRE_RE.search(d)):
                assigned[ui] = d
                used.add(k)
                break
    for ui in range(len(units)):
        if ui in assigned:
            continue
        for k, d in enumerate(details):
            if k not in used:
                assigned[ui] = d
                used.add(k)
                break
    complaints: list[WoComplaint] = []
    for ui, (unit, miles, _kind) in enumerate(units):
        pick = assigned.get(ui, "")
        complaints.append(WoComplaint(
            unit=unit, mileage=miles,
            detail=pick or "Service per invoice",
            is_pm=bool(_PM_RE.search(pick or ""))))
    return complaints


def _scan_heuristic(text: str) -> dict:
    """Extracción por patrones (sin AI). Maneja el layout real de los
    invoices de taller: encabezados de unidad en una fila y datos abajo,
    múltiples unidades por invoice, textos de Complaint #N / Correction.
    El usuario revisa el form antes de crear igual."""
    x = WoExtract()
    # Fecha (cualquier MM/DD/YYYY del documento). Validar de verdad con
    # datetime: una falsa coincidencia tipo 13/45/2026 debe descartarse.
    from datetime import datetime as _dt
    if m := _RE_DATE.search(text):
        mo, da, yr = (int(g) for g in m.groups())
        if yr < 100:
            yr += 2000
        try:
            x.service_date = _dt(yr, mo, da).strftime("%Y-%m-%d")
        except ValueError:
            pass
    # Invoice / work order # (rótulo→número o, en Love's, número→rótulo).
    if m := _RE_INVNO.search(text):
        x.invoice_number = m.group(1)[:30]
    elif m := _RE_INVNO_REV.search(text):
        x.invoice_number = m.group(1)[:30]
    # Shop name + ciudad/estado.
    for ln in text.splitlines():
        if _KNOWN_SHOPS.search(ln) and not _RE_CITYST.search(ln):
            x.vendor = " ".join(ln.split())[:80]
            break
    if not x.vendor:
        for ln in text.splitlines():
            t = ln.strip()
            if t and not re.search(r"\d{3,}", t):
                x.vendor = t[:80]
                break
    if m := _RE_CITYST.search(text):
        x.vendor_city = _clean_city(m.group(1))
        x.vendor_state = m.group(2)
    # Unidades + complaints.
    units = _find_units(text)
    x.complaints = _build_complaints(text, units)
    # Líneas facturables (best-effort para invoices simples).
    lines: list[WoLineExtract] = []
    for ln in text.splitlines():
        if _SKIP_LINE.search(ln):
            continue
        if m := _RE_LINE.match(ln):
            qty, desc, unit_cost = m.group(1), m.group(2).strip(), m.group(3)
            lines.append(WoLineExtract(
                kind="labor" if _LABORISH.search(desc) else "part",
                description=desc[:160],
                qty=float(qty),
                unit_cost=float(unit_cost.replace(",", "")),
            ))
    x.lines = lines
    return _normalize(x, "basic text parser (no AI)")


async def _scan_ollama(s: dict, raw: bytes, media_type: str,
                       pdf_text: str) -> dict:
    """Proveedor local gratuito: Ollama con salida JSON-schema."""
    images: list[str] = []
    prompt = _PROMPT
    if media_type == "application/pdf":
        if len(pdf_text) >= _MIN_TEXT:
            prompt = (_PROMPT
                      + "\nThe document text follows:\n\n" + pdf_text)
        else:
            images = _pdf_images_b64(raw)
    else:
        images = [base64.standard_b64encode(raw).decode()]

    msg: dict = {"role": "user", "content": prompt}
    if images:
        msg["images"] = images
    payload = {
        "model": s["ollama_model"],
        "messages": [msg],
        "format": WoExtract.model_json_schema(),
        "stream": False,
        "options": {"temperature": 0},
    }
    try:
        async with httpx.AsyncClient(timeout=_OLLAMA_TIMEOUT) as client:
            r = await client.post(f"{s['ollama_url']}/api/chat",
                                  json=payload)
    except httpx.ConnectError:
        raise ValueError(
            "Ollama is not running. Install it from ollama.com and run: "
            f"ollama pull {s['ollama_model']}")
    except httpx.HTTPError as exc:
        raise ValueError(f"Local scan failed: {type(exc).__name__}")
    if r.status_code == 404:
        raise ValueError(
            f"Model '{s['ollama_model']}' is not pulled. Run: "
            f"ollama pull {s['ollama_model']}")
    if r.status_code != 200:
        detail = ""
        try:
            detail = r.json().get("error", "")[:80]
        except ValueError:
            pass
        raise ValueError(f"Local scan failed ({r.status_code}). {detail}")

    content = (r.json().get("message") or {}).get("content") or ""
    try:
        extract = WoExtract.model_validate_json(content)
    except ValidationError:
        raise ValueError("The local model returned an unreadable result. "
                         "Try a clearer photo or the original PDF.")
    usage = r.json()
    return _normalize(extract, s["ollama_model"], {
        "input": usage.get("prompt_eval_count", 0),
        "output": usage.get("eval_count", 0),
    })


async def _scan_anthropic(s: dict, raw: bytes, media_type: str) -> dict:
    """Proveedor cloud (pago por uso): Claude con messages.parse()."""
    if not _HAS_ANTHROPIC:
        raise ValueError("The anthropic package is not installed.")
    if not s["api_key"]:
        raise ValueError(
            "AI document scan is not configured. Add your Anthropic API "
            "key in Settings, Connectivity.")
    data_b64 = base64.standard_b64encode(raw).decode("ascii")
    if MEDIA_TYPES[media_type] == "document":
        block = {"type": "document",
                 "source": {"type": "base64",
                            "media_type": "application/pdf",
                            "data": data_b64}}
    else:
        block = {"type": "image",
                 "source": {"type": "base64",
                            "media_type": media_type,
                            "data": data_b64}}
    client = anthropic.AsyncAnthropic(api_key=s["api_key"])
    try:
        response = await client.messages.parse(
            model=s["model"],
            max_tokens=4096,           # salida estructurada acotada
            thinking={"type": "adaptive"},
            messages=[{
                "role": "user",
                "content": [block, {"type": "text", "text": _PROMPT}],
            }],
            output_format=WoExtract,
        )
    except anthropic.AuthenticationError:
        raise ValueError("Invalid Anthropic API key. Check Settings, "
                         "Connectivity.")
    except anthropic.RateLimitError:
        raise ValueError("Rate limited by the Anthropic API. Try again "
                         "in a minute.")
    except anthropic.APIStatusError as exc:
        raise ValueError(f"Document scan failed ({exc.status_code}).")
    except anthropic.APIConnectionError:
        raise ValueError("Could not reach the Anthropic API. Check the "
                         "internet connection.")

    extract = response.parsed_output
    if extract is None:
        raise ValueError("The document could not be parsed. Try a "
                         "clearer photo or the original PDF.")
    return _normalize(extract, s["model"], {
        "input": response.usage.input_tokens,
        "output": response.usage.output_tokens,
    })


# ----- AWS Textract AnalyzeExpense (motor comercial) ------------------------

_DATE_FMTS = ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d", "%b %d, %Y",
              "%B %d, %Y", "%d %b %Y", "%m-%d-%Y")


def _to_iso(text: str) -> str | None:
    from datetime import datetime
    t = (text or "").strip()
    for fmt in _DATE_FMTS:
        try:
            return datetime.strptime(t, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _money(text: str) -> float | None:
    m = re.search(r"-?[\d,]+(?:\.\d+)?", (text or "").replace("$", ""))
    if not m:
        return None
    try:
        return float(m.group(0).replace(",", ""))
    except ValueError:
        return None


def _map_expense(resp: dict) -> WoExtract:
    """AnalyzeExpense -> WoExtract. Los campos de invoice salen nativos;
    los de flota (unit/odometer/complaint) se completan con el overlay
    heurístico sobre todo el texto detectado."""
    x = WoExtract()
    texts: list[str] = []
    for doc in resp.get("ExpenseDocuments", []):
        for blk in doc.get("Blocks") or []:
            if blk.get("BlockType") == "LINE" and blk.get("Text"):
                texts.append(blk["Text"])
        for f in doc.get("SummaryFields", []):
            ftype = ((f.get("Type") or {}).get("Text") or "").upper()
            val = ((f.get("ValueDetection") or {}).get("Text") or "").strip()
            label = ((f.get("LabelDetection") or {}).get("Text") or "")
            if label or val:
                texts.append(f"{label} {val}".strip())
            if not val:
                continue
            if ftype == "VENDOR_NAME" and not x.vendor:
                x.vendor = val[:80]
            elif ftype in ("INVOICE_RECEIPT_DATE", "ORDER_DATE") \
                    and not x.service_date:
                x.service_date = _to_iso(val)
            elif ftype == "INVOICE_RECEIPT_ID" and not x.invoice_number:
                x.invoice_number = val[:30]
        for grp in doc.get("LineItemGroups", []):
            for li in grp.get("LineItems", []):
                fields: dict[str, str] = {}
                for lf in li.get("LineItemExpenseFields", []):
                    t = ((lf.get("Type") or {}).get("Text") or "").upper()
                    v = ((lf.get("ValueDetection") or {})
                         .get("Text") or "").strip()
                    if t and v:
                        fields[t] = v
                desc = fields.get("ITEM") or fields.get("EXPENSE_ROW") or ""
                desc = " ".join(desc.split())
                if not desc or _SKIP_LINE.search(desc):
                    continue
                qty = _money(fields.get("QUANTITY", "")) or 1.0
                unit_cost = _money(fields.get("UNIT_PRICE", ""))
                total = _money(fields.get("PRICE", ""))
                if unit_cost is None:
                    if total is not None and qty:
                        unit_cost = round(total / qty, 2)
                    else:
                        unit_cost = total if total is not None else 0.0
                x.lines.append(WoLineExtract(
                    kind=("labor" if _LABORISH.search(desc) else "part"),
                    description=desc[:160],
                    qty=qty,
                    unit_cost=unit_cost,
                    total=total,    # _normalize reconcilia qty si no cuadra
                ))
    # Overlay de campos de flota sobre el texto detectado: Textract da
    # vendor/fecha/invoice# nativos; unidades + complaints + ciudad/estado
    # se derivan con los mismos helpers del parser heurístico.
    full = "\n".join(texts)
    if not x.vendor_city and (m := _RE_CITYST.search(full)):
        x.vendor_city = _clean_city(m.group(1))
        x.vendor_state = m.group(2)
    x.complaints = _build_complaints(full, _find_units(full))
    return x


_TEXTRACT_MAX = int(9.5 * 1024 * 1024)   # límite sync de Textract: 10 MB


def _shrink_image(raw: bytes) -> bytes:
    """Recomprime a JPEG si la foto supera el límite de Textract."""
    if len(raw) <= _TEXTRACT_MAX:
        return raw
    from PIL import Image
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85, optimize=True)
    return buf.getvalue()


async def _scan_textract(s: dict, raw: bytes, media_type: str) -> dict:
    """Motor comercial: $0.008 por página (AnalyzeExpense)."""
    import asyncio
    if not _HAS_BOTO:
        raise ValueError("boto3 is not installed.")
    if not _has_aws(s):
        raise ValueError("AWS credentials are not configured. Add them in "
                         "Settings, Connectivity.")
    # PDFs: render a PNG por página (el endpoint sync no acepta PDFs
    # multipágina por Bytes de forma fiable); fotos: directo.
    if media_type == "application/pdf":
        pages = [base64.standard_b64decode(b) for b in _pdf_images_b64(raw)]
    else:
        pages = [_shrink_image(raw)]

    def analyze() -> list[dict]:
        client = _boto(s, "textract")
        return [client.analyze_expense(Document={"Bytes": page})
                for page in pages]

    try:
        responses = await asyncio.to_thread(analyze)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code in ("UnrecognizedClientException",
                    "InvalidSignatureException"):
            raise ValueError("Invalid AWS credentials. Check Settings, "
                             "Connectivity.")
        if code == "AccessDeniedException":
            raise ValueError("The AWS key lacks the "
                             "textract:AnalyzeExpense permission.")
        if code in ("UnsupportedDocumentException",
                    "BadDocumentException"):
            raise ValueError("Textract could not read this document. Try "
                             "a clearer photo or the original PDF.")
        if code == "ProvisionedThroughputExceededException":
            raise ValueError("Textract rate limit hit. Try again in a "
                             "minute.")
        raise ValueError(f"Textract error: {code or 'unknown'}")
    except BotoCoreError as exc:
        raise ValueError(f"Could not reach AWS: {type(exc).__name__}")

    merged: dict = {"ExpenseDocuments": []}
    for r in responses:
        merged["ExpenseDocuments"].extend(r.get("ExpenseDocuments", []))
    extract = _map_expense(merged)
    return _normalize(extract, "AWS Textract AnalyzeExpense",
                      {"pages": len(pages)})
