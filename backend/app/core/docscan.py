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
for a trucking fleet. Extract the work order fields.

Rules:
- unit: the truck/trailer unit number (e.g. CF2246, CI2038, MEM-1042).
  Prefer the fleet's unit code over VIN or plate. Null if absent.
- service_date: the service/invoice date as YYYY-MM-DD. Null if absent.
- mileage: odometer reading as an integer (no commas). Null if absent.
- title: a short issue summary (max 10 words), e.g. "Brake chamber
  replacement" or "PM service + oil leak".
- complaint: the reported complaint/cause/correction text, condensed.
- lines: every billed item. kind "part" for parts/materials, "labor"
  for labor/diagnostic time. READ THE QUANTITY COLUMN CAREFULLY: many
  invoices print qty (often under QTY or EA) before the unit price, and
  it can be large (e.g. 39 quarts of oil) or fractional (3.5 hours).
  qty = the billed quantity (hours for labor). unit_cost = price per
  single unit/hour. total = the line total if printed. The math must
  hold: qty x unit_cost = total. Never default qty to 1 when the
  document shows a quantity. Skip taxes, shop supplies percentages,
  fees and totals rows.
- is_pm: true only if this is clearly a preventive maintenance service
  (full service, oil change service, PM A/B).
- Use null when a field is not in the document. Do not invent data.
"""


class WoLineExtract(BaseModel):
    kind: str = Field(description="part | labor")
    description: str
    qty: float = 1
    unit_cost: float = 0
    total: float | None = Field(
        default=None,
        description="line total if printed on the document")


class WoExtract(BaseModel):
    unit: str | None = None
    service_date: str | None = None
    mileage: int | None = None
    title: str | None = None
    complaint: str | None = None
    mechanic: str | None = None
    vendor: str | None = None
    invoice_number: str | None = None
    is_pm: bool = False
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

_RE_UNIT = re.compile(
    r"\bunit\s*[:#]?\s*([A-Z]{1,4}[- ]?\d{3,7}[A-Z]?)", re.IGNORECASE)
_RE_ODO = re.compile(
    r"\b(?:odometer|mileage|miles)\s*[:#]?\s*([\d][\d,]{2,9})",
    re.IGNORECASE)
_RE_INV = re.compile(r"\binvoice\s*#?\s*[:#]?\s*(\w[\w-]{2,15})",
                     re.IGNORECASE)
_RE_DATE = re.compile(
    r"\bdate\s*[:#]?\s*(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})", re.IGNORECASE)
_RE_COMPLAINT = re.compile(
    r"\b(?:complaint|concern|reason)\s*[:#]?\s*(.+)", re.IGNORECASE)
# Línea facturable: qty + descripción + precio unitario + total.
_RE_LINE = re.compile(
    r"^\s*(\d+(?:\.\d+)?)\s+(.{3,70}?)\s+\$?([\d,]+\.\d{2})"
    r"\s+\$?([\d,]+\.\d{2})\s*$")
_SKIP_LINE = re.compile(
    r"subtotal|total|tax|shop supplies|qty\b|description",
    re.IGNORECASE)
_LABORISH = re.compile(r"labor|labour|diag|inspect|service call|shop time",
                       re.IGNORECASE)


def _scan_heuristic(text: str) -> dict:
    """Extracción básica por patrones, estilo software clásico. Solo para
    PDFs con capa de texto; cubre los campos típicos de un invoice de
    taller en EE.UU. El usuario revisa el form antes de crear igual."""
    x = WoExtract()
    if m := _RE_UNIT.search(text):
        x.unit = m.group(1).replace(" ", "").upper()
    if m := _RE_ODO.search(text):
        x.mileage = int(m.group(1).replace(",", ""))
    if m := _RE_INV.search(text):
        x.invoice_number = m.group(1)
    if m := _RE_DATE.search(text):
        mo, da, yr = (int(g) for g in m.groups())
        if yr < 100:
            yr += 2000
        x.service_date = f"{yr:04d}-{mo:02d}-{da:02d}"
    if m := _RE_COMPLAINT.search(text):
        x.complaint = m.group(1).strip()[:300]
        x.title = " ".join(x.complaint.split()[:8])
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
    # La primera línea no vacía suele ser el nombre del taller.
    for ln in text.splitlines():
        if ln.strip() and not _RE_INV.search(ln):
            x.vendor = ln.strip()[:80]
            break
    if not x.title:
        x.title = "Imported invoice"
    x.is_pm = bool(re.search(r"\bPM\b|full (?:wet )?service|oil change",
                             text, re.IGNORECASE))
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
    # Overlay de campos de flota sobre el texto detectado.
    full = "\n".join(texts)
    if m := _RE_UNIT.search(full):
        x.unit = m.group(1).replace(" ", "").upper()
    if m := _RE_ODO.search(full):
        x.mileage = int(m.group(1).replace(",", ""))
    if m := _RE_COMPLAINT.search(full):
        x.complaint = m.group(1).strip()[:300]
        x.title = " ".join(x.complaint.split()[:8])
    if not x.title:
        x.title = (f"Invoice {x.invoice_number}" if x.invoice_number
                   else "Imported invoice")
    x.is_pm = bool(re.search(r"\bPM\b|full (?:wet )?service|oil change",
                             full, re.IGNORECASE))
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
