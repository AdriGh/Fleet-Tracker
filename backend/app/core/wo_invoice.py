# -*- coding: utf-8 -*-
"""Estimate / Invoice imprimible de una Work Order (fase H3-C).

El PDF "bonito" lo genera el navegador (componente WorkOrderInvoice.tsx,
patrón print-to-PDF). Este módulo arma la versión para **enviar por
email** (HTML con estilos INLINE, autocontenido — los emails no cargan
el index.css) + un texto plano, y un resumen corto para SMS.

Modo del documento:
- status != 'invoiced'  -> ESTIMATE (número de referencia = WO #id)
- status == 'invoiced'  -> INVOICE  (número = wo.invoice_number)

Datos:
- Taller (From)  = org_config.shop()  (un solo taller, decisión del user)
- Bill-To        = v2.22: el CUSTOMER de la WO (customers.bill_to: nombre,
  contacto de facturación, dirección, teléfono, email, términos); si la WO
  es de Self, org_config.billing()[empresa de la unidad] o el nombre
- Tarifas        = precio de venta al customer (snapshot unit_price o costo
  × markup; `billable_unit_price` del dict); sin customer = el costo
- Unidad (VIN/año/marca/modelo) = `unit_info` que pasa el frontend desde
  su caché de /api/fleet (evita un fetch lento a Samsara al enviar).
"""

from __future__ import annotations

import html

from . import mailer, org_config, sms_service


def _money(n: float) -> str:
    return f"${n:,.2f}"


def _e(v) -> str:
    """Escapa para HTML (anti-inyección en el email)."""
    return html.escape(str(v or ""))


def doc_kind(wo: dict) -> str:
    """'INVOICE' si la orden está facturada, si no 'ESTIMATE'."""
    return "INVOICE" if wo.get("status") == "invoiced" else "ESTIMATE"


def doc_number(wo: dict) -> str:
    """Número mostrado: el invoice # si existe, si no la referencia del WO."""
    return (wo.get("invoice_number") or "").strip() or f"WO-{wo.get('id')}"


def _shop_lines(shop: dict, branding: dict) -> list[str]:
    """Líneas de texto del taller (From), saltando las vacías."""
    name = (shop.get("name") or "").strip() or branding.get("app_name", "")
    city_zip = ", ".join(
        x for x in [shop.get("city", "").strip(),
                    " ".join(p for p in [shop.get("state", "").strip(),
                                         shop.get("zip", "").strip()] if p)]
        if x)
    return [s for s in [name, shop.get("address", "").strip(), city_zip,
                        shop.get("phone", "").strip(),
                        shop.get("email", "").strip()] if s]


def _customer_bill_to(wo: dict) -> dict | None:
    """Bill-To del CUSTOMER de la WO (v2.22), crudo (server-side), o None
    si la WO es de Self."""
    if not wo.get("customer_id"):
        return None
    from . import customers               # import diferido (orden de carga)
    return customers.bill_to(wo["customer_id"])


def _bill_to_lines(wo: dict, billing: dict,
                   cust: dict | None = None) -> list[str]:
    """Líneas del Bill-To. v2.22: si la WO tiene customer, sus datos (nombre,
    atención del contacto de facturación, dirección, teléfono, email); si
    no, la dirección de la empresa (org billing) o solo su nombre."""
    if cust is None:
        cust = _customer_bill_to(wo)
    if cust is not None:
        city_zip = ", ".join(
            x for x in [(cust.get("city") or "").strip(),
                        " ".join(p for p in [(cust.get("state") or "").strip(),
                                             (cust.get("zip") or "").strip()]
                                 if p)]
            if x)
        attn = (cust.get("contact") or "").strip()
        return [s for s in [(cust.get("name") or "").strip() or "—",
                            f"Attn: {attn}" if attn else "",
                            (cust.get("address") or "").strip(), city_zip,
                            (cust.get("phone") or "").strip(),
                            (cust.get("email") or "").strip()] if s]
    company = (wo.get("company") or "").strip()
    addr = billing.get(company) or {}
    name = (addr.get("name") or "").strip() or company or "—"
    city_zip = ", ".join(
        x for x in [addr.get("city", "").strip(),
                    " ".join(p for p in [addr.get("state", "").strip(),
                                         addr.get("zip", "").strip()] if p)]
        if x)
    return [s for s in [name, addr.get("address", "").strip(), city_zip,
                        addr.get("phone", "").strip()] if s]


def _unit_lines(wo: dict, unit_info: dict) -> list[str]:
    """Bloque de la unidad: código, VIN, año/marca/modelo, millaje."""
    out = [f"Unit {wo.get('unit', '')}"]
    vin = (unit_info.get("vin") or "").strip()
    if vin:
        out.append(f"VIN {vin}")
    ymm = " ".join(str(unit_info.get(k, "")).strip()
                   for k in ("year", "make", "model")
                   if str(unit_info.get(k, "")).strip())
    if ymm:
        out.append(ymm)
    if wo.get("mileage") is not None:
        out.append(f"{int(wo['mileage']):,} mi")
    return out


def _rate(l: dict) -> float:
    """Tarifa unitaria del documento: el precio de venta al customer
    (v2.22: snapshot o costo × markup, `billable_unit_price`); sin customer
    es el costo tal cual."""
    p = l.get("billable_unit_price")
    return float(p if p is not None else l["unit_cost"])


def _totals(wo: dict) -> dict:
    """Subtotales por tipo de línea + impuesto + total. El total se calcula
    sobre los subtotales YA redondeados para que parts + labor + tax sumen
    exactamente el total mostrado (sin descuadres de 1¢ en el documento).
    Impuesto (v2.22): tasa del customer (congelada al facturar) sobre las
    partes; sin customer / exento = 0."""
    lines = wo.get("lines") or []
    parts = round(sum(l["qty"] * _rate(l)
                      for l in lines if l["kind"] == "part"), 2)
    labor = round(sum(l["qty"] * _rate(l)
                      for l in lines if l["kind"] == "labor"), 2)
    pct = float(wo.get("tax_pct") or 0.0) if wo.get("customer_id") else 0.0
    tax = round(parts * pct / 100.0, 2) if pct > 0 else 0.0
    return {"parts": parts, "labor": labor, "tax": tax, "tax_pct": pct,
            "total": round(parts + labor + tax, 2)}


def _pct(v: float) -> str:
    return f"{v:g}%"


# --------------------------------------------------------------------------
# Render HTML (email) — estilos INLINE, autocontenido.
# --------------------------------------------------------------------------

def render(wo: dict, unit_info: dict | None = None) -> tuple[str, str, str]:
    """Devuelve (subject, text, html) del estimate/invoice de la orden."""
    cfg = org_config.get()
    shop, billing, inv = cfg["shop"], cfg["billing"], cfg["invoice"]
    branding = cfg["branding"]
    accent = (branding.get("accent") or "").strip() or "#e11900"
    unit_info = unit_info or {}

    kind = doc_kind(wo)
    number = doc_number(wo)
    date = (wo.get("service_date") or "")[:10] or (wo.get("created_at") or "")[:10]
    shop_name = (shop.get("name") or "").strip() or branding.get("app_name", "")
    totals = _totals(wo)
    subject = f"{shop_name} · {kind.title()} {number} · {wo.get('unit', '')}"
    # v2.22: Bill-To del customer (si la WO tiene uno) y sus términos de pago
    # en lugar de los generales del invoice.
    cust = _customer_bill_to(wo)
    terms = ((cust or {}).get("terms_label") or inv.get("terms") or "")
    bill_to = _bill_to_lines(wo, billing, cust)

    # ----- Texto plano -----
    tl: list[str] = [f"{shop_name} — {kind}", ""]
    tl += _shop_lines(shop, branding)
    tl += ["", f"{kind} #: {number}", f"Date: {date}",
           f"Unit: {wo.get('unit', '')}"]
    if wo.get("po_number"):
        tl.append(f"PO #: {wo['po_number']}")
    if terms:
        tl.append(f"Terms: {terms}")
    tl += ["", "Bill To:"] + bill_to
    if wo.get("complaint"):
        tl += ["", "Complaint:", wo["complaint"]]
    tl += ["", "Lines:"]
    for l in (wo.get("lines") or []):
        tag = "Part " if l["kind"] == "part" else "Labor"
        tl.append(f"  {tag}  {l['description']}  "
                  f"{l['qty']} x {_money(_rate(l))} = "
                  f"{_money(l['qty'] * _rate(l))}")
    if not (wo.get("lines") or []):
        tl.append("  (no lines yet)")
    tl += ["", f"Parts:  {_money(totals['parts'])}",
           f"Labor:  {_money(totals['labor'])}"]
    if totals["tax"]:
        tl.append(f"Tax ({_pct(totals['tax_pct'])} on parts):  "
                  f"{_money(totals['tax'])}")
    tl.append(f"Total:  {_money(totals['total'])}")
    if inv.get("footer"):
        tl += ["", inv["footer"]]
    text = "\n".join(tl)

    # ----- HTML (estilos inline) -----
    def rows() -> str:
        out = []
        for l in (wo.get("lines") or []):
            tag = ("Part" if l["kind"] == "part" else "Labor")
            pn = (l.get("part_number") or "").strip()
            desc = (f'<span style="color:#6b7280">{_e(pn)}</span> '
                    if pn else "") + _e(l["description"])
            out.append(
                f'<tr>'
                f'<td style="padding:7px 8px;border-bottom:1px solid #eee;'
                f'font-size:11px;color:#6b7280">{tag}</td>'
                f'<td style="padding:7px 8px;border-bottom:1px solid #eee">'
                f'{desc}</td>'
                f'<td style="padding:7px 8px;border-bottom:1px solid #eee;'
                f'text-align:right;white-space:nowrap">{l["qty"]:g} &times; '
                f'{_money(_rate(l))}</td>'
                f'<td style="padding:7px 8px;border-bottom:1px solid #eee;'
                f'text-align:right;white-space:nowrap">'
                f'{_money(l["qty"] * _rate(l))}</td>'
                f'</tr>')
        if not out:
            out.append('<tr><td colspan="4" style="padding:10px 8px;'
                       'color:#9ca3af">No line items yet.</td></tr>')
        return "".join(out)

    def block(title: str, lines: list[str]) -> str:
        body = "<br>".join(_e(s) for s in lines) or "&mdash;"
        return (f'<div style="font-size:11px;text-transform:uppercase;'
                f'letter-spacing:.06em;color:#9ca3af;margin-bottom:4px">'
                f'{_e(title)}</div>'
                f'<div style="font-size:13px;line-height:1.5">{body}</div>')

    meta_chips = []
    for label, val in [("Date", date), ("Unit", wo.get("unit", "")),
                       ("Shop ref #", wo.get("shop_invoice", "")),
                       ("PO #", wo.get("po_number", "")),
                       ("Terms", terms),
                       ("Technician", wo.get("mechanic", "")),
                       ("Authorizer", wo.get("authorizer", ""))]:
        if val:
            meta_chips.append(
                f'<td style="padding:0 18px 0 0;vertical-align:top">'
                f'<div style="font-size:10px;text-transform:uppercase;'
                f'letter-spacing:.05em;color:#9ca3af">{_e(label)}</div>'
                f'<div style="font-size:13px;font-weight:600">{_e(val)}</div>'
                f'</td>')

    complaint_html = ""
    if wo.get("complaint"):
        complaint_html = (
            f'<div style="margin:18px 0;padding:12px 14px;background:#f9fafb;'
            f'border-radius:8px;font-size:13px;line-height:1.5;'
            f'white-space:pre-wrap">'
            f'<strong>Complaint.</strong> {_e(wo["complaint"])}</div>')

    footer_html = ""
    if inv.get("footer"):
        footer_html = (
            f'<p style="margin-top:18px;font-size:12px;color:#6b7280;'
            f'white-space:pre-wrap">{_e(inv["footer"])}</p>')

    tax_row = ""
    if totals["tax"]:
        tax_row = (f'<tr><td style="padding:3px 8px;color:#6b7280">'
                   f'Tax ({_e(_pct(totals["tax_pct"]))} on parts)</td>'
                   f'<td style="padding:3px 8px;text-align:right">'
                   f'{_money(totals["tax"])}</td></tr>')

    html_doc = f"""\
<div style="max-width:680px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;\
color:#111827;background:#fff">
  <div style="height:5px;background:{_e(accent)};border-radius:3px"></div>
  <table style="width:100%;margin-top:16px"><tr>
    <td style="vertical-align:top">{block("From", _shop_lines(shop, branding))}</td>
    <td style="vertical-align:top;text-align:right">
      <div style="font-size:24px;font-weight:800;letter-spacing:.04em;\
color:{_e(accent)}">{kind}</div>
      <div style="font-size:14px;font-weight:700;margin-top:2px">#{_e(number)}</div>
    </td>
  </tr></table>
  <table style="width:100%;margin-top:20px"><tr>
    <td style="vertical-align:top;width:55%">{block("Bill To", bill_to)}</td>
    <td style="vertical-align:top">{block("Unit", _unit_lines(wo, unit_info))}</td>
  </tr></table>
  <table style="width:100%;margin-top:18px;border-top:1px solid #eee;\
border-bottom:1px solid #eee;padding:10px 0"><tr>{"".join(meta_chips)}</tr></table>
  {complaint_html}
  <table style="width:100%;border-collapse:collapse;margin-top:10px">
    <thead><tr style="text-align:left">
      <th style="padding:6px 8px;font-size:11px;color:#9ca3af;\
text-transform:uppercase">Item</th>
      <th style="padding:6px 8px;font-size:11px;color:#9ca3af;\
text-transform:uppercase">Description</th>
      <th style="padding:6px 8px;font-size:11px;color:#9ca3af;\
text-transform:uppercase;text-align:right">Qty &times; Rate</th>
      <th style="padding:6px 8px;font-size:11px;color:#9ca3af;\
text-transform:uppercase;text-align:right">Amount</th>
    </tr></thead>
    <tbody>{rows()}</tbody>
  </table>
  <table style="width:100%;margin-top:12px"><tr>
    <td></td>
    <td style="width:240px">
      <table style="width:100%;font-size:13px">
        <tr><td style="padding:3px 8px;color:#6b7280">Parts</td>
        <td style="padding:3px 8px;text-align:right">{_money(totals['parts'])}</td></tr>
        <tr><td style="padding:3px 8px;color:#6b7280">Labor</td>
        <td style="padding:3px 8px;text-align:right">{_money(totals['labor'])}</td></tr>
        {tax_row}
        <tr><td style="padding:8px;font-weight:800;border-top:2px solid #111827">\
Total</td>
        <td style="padding:8px;text-align:right;font-weight:800;\
border-top:2px solid #111827">{_money(totals['total'])}</td></tr>
      </table>
    </td>
  </tr></table>
  {footer_html}
  <p style="margin-top:24px;font-size:11px;color:#9ca3af">
    {_e(shop_name)} &middot; {kind.title()} {_e(number)} &middot;
    Generated by {_e(branding.get('app_name', 'Rigsmith'))}.
  </p>
</div>"""
    return subject, text, html_doc


def sms_summary(wo: dict) -> str:
    """Resumen corto para SMS (la factura completa va por email/PDF)."""
    cfg = org_config.get()
    shop_name = ((cfg["shop"].get("name") or "").strip()
                 or cfg["branding"].get("app_name", ""))
    kind = doc_kind(wo).title()
    return (f"{shop_name}: {kind} {doc_number(wo)} for unit "
            f"{wo.get('unit', '')}, total {_money(_totals(wo)['total'])}. "
            f"Full document sent by email.")


# --------------------------------------------------------------------------
# Envío (email real vía mailer + SMS vía Twilio). Gemelo de notify_service.
# --------------------------------------------------------------------------

def send(wo: dict, channels: list[str], email: str = "", phone: str = "",
         unit_info: dict | None = None) -> dict:
    """Envía (o simula) el estimate/invoice por los canales pedidos.

    Devuelve {channels, email_dry_run, sms_dry_run, results:{email?,sms?}}.
    El mailer puede estar en ENVÍO REAL (avisos.local.json dry_run=false);
    el SMS sale dry_run salvo que twilio.local.json esté configurado."""
    channels = [c for c in channels if c in ("email", "sms")]
    results: dict = {}

    mail_cfg = mailer.load_settings()
    sms_cfg = sms_service.load_settings()
    out = {
        "channels": channels,
        "email_dry_run": mail_cfg.dry_run or not mail_cfg.configured,
        "sms_dry_run": sms_cfg.dry_run or not sms_cfg.configured,
        "results": results,
    }

    if "email" in channels:
        to = (email or "").strip()
        if not to:
            results["email"] = {"to": "", "ok": False, "simulated": False,
                                "error": "No recipient email"}
        else:
            subject, text, html_body = render(wo, unit_info)
            r = mailer.send_email(mail_cfg, to, [], subject, text, html=html_body)
            results["email"] = {"to": to, "ok": r["ok"],
                                "simulated": r.get("simulated", False),
                                "error": r.get("error", "")}

    if "sms" in channels:
        e164 = sms_service.to_e164(phone or "")
        if not e164:
            results["sms"] = {"to": phone, "ok": False, "simulated": False,
                              "error": "Invalid or missing phone number"}
        else:
            r = sms_service.send_sms(sms_cfg, e164, sms_summary(wo))
            results["sms"] = {"to": e164, "ok": r["ok"],
                              "simulated": r.get("simulated", False),
                              "error": r.get("error", "")}

    return out
