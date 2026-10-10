import { type CSSProperties, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import type {
  CustomerProfile, FleetUnit, OrgConfig, WoLine, WorkOrder,
} from '../api'

// Documento imprimible de una Work Order (fase H3-C). Igual que UnitReport:
// se monta en un portal offscreen (.print-root) y dispara window.print();
// al cerrar el diálogo, se desmonta. Modo ESTIMATE (antes de facturar) o
// INVOICE (status invoiced), con el branding del taller (org_config).

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

function lines(...parts: (string | number | null | undefined)[]): string[] {
  return parts.map((p) => String(p ?? '').trim()).filter(Boolean)
}

function shopLines(org: OrgConfig): string[] {
  const s = org.shop
  const name = (s.name || '').trim() || org.branding.app_name
  const stateZip = lines(s.state, s.zip).join(' ')
  const cityZip = lines(s.city, stateZip).join(', ')
  return lines(name, s.address, cityZip, s.phone, s.email)
}

function billToLines(org: OrgConfig, company: string): string[] {
  const a = org.billing?.[company] ?? {}
  const name = (a.name || '').trim() || company || '—'
  const stateZip = lines(a.state, a.zip).join(' ')
  const cityZip = lines(a.city, stateZip).join(', ')
  return lines(name, a.address, cityZip, a.phone)
}

// v2.22 [C]: Bill To = el cliente (owner-operator) si la WO tiene uno:
// nombre, dirección, contacto de facturación. Un dato enmascarado (sin
// pii.view) no se imprime.
const clean = (v: string | null | undefined) =>
  (v && !v.includes('•') ? v : '')

function customerLines(p: CustomerProfile): string[] {
  const c = p.customer
  const stateZip = lines(clean(c.state), clean(c.zip)).join(' ')
  const cityZip = lines(clean(c.city), stateZip).join(', ')
  const billing = p.contacts.find((x) => x.is_billing)
  return lines(
    c.name, clean(c.address), cityZip,
    billing ? `Attn: ${billing.name}` : '',
    clean(billing?.phone) || clean(c.phone),
    clean(billing?.email) || clean(c.email),
  )
}

function unitLines(wo: WorkOrder, unit?: FleetUnit): string[] {
  const ymm = unit
    ? lines(unit.year, unit.make, unit.model).join(' ')
    : ''
  return lines(
    `Unit ${wo.unit}`,
    unit?.vin ? `VIN ${unit.vin}` : '',
    ymm,
    wo.mileage != null ? `${wo.mileage.toLocaleString('en-US')} mi` : '',
  )
}

function Block({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="inv-block">
      <span className="inv-block-t">{title}</span>
      <div className="inv-block-b">
        {items.length
          ? items.map((l, i) => <div key={i}>{l}</div>)
          : <div className="inv-muted">—</div>}
      </div>
    </div>
  )
}

const TERMS_TEXT: Record<string, string> = {
  cod: 'COD', net7: 'Net 7', net15: 'Net 15', net30: 'Net 30',
  '2_10_net30': '2% 10, Net 30', prepay: 'Prepay',
}

function InvoicePage({ wo, org, unit, customer }: {
  wo: WorkOrder; org: OrgConfig; unit?: FleetUnit; customer?: CustomerProfile
}) {
  const isInvoice = wo.status === 'invoiced'
  const kind = isInvoice ? 'INVOICE' : 'ESTIMATE'
  const number = (wo.invoice_number || '').trim() || `WO-${wo.id}`
  const date = (wo.service_date || wo.created_at || '').slice(0, 10)
  const inv = org.invoice
  const wlines = wo.lines ?? []
  // v2.22 [C]: con cliente, cada línea va a SU precio (snapshot unit_price o
  // costo × (1 + markup del cliente)); sin cliente, al costo (como antes).
  const c = wo.customer_id != null ? customer?.customer : undefined
  const rate = (l: WoLine) => {
    if (!c) return l.unit_cost
    if (l.unit_price != null) return l.unit_price
    const mk = (l.kind === 'part' ? c.parts_markup_pct : c.labor_markup_pct) || 0
    return l.unit_cost * (1 + mk / 100)
  }
  // Subtotales redondeados a centavos; el total se calcula sobre ellos para
  // que parts + labor sumen exactamente el total impreso (mismo criterio que
  // el backend en wo_invoice._totals).
  const r2 = (n: number) => Math.round(n * 100) / 100
  const parts = r2(wlines.filter((l) => l.kind === 'part')
    .reduce((s, l) => s + l.qty * rate(l), 0))
  const labor = r2(wlines.filter((l) => l.kind === 'labor')
    .reduce((s, l) => s + l.qty * rate(l), 0))
  // Impuesto del cliente sobre las partes (tasa congelada al facturar; mismo
  // cálculo que wo_invoice._totals). Self / exento = 0.
  const taxPct = c ? (wo.tax_pct ?? 0) : 0
  const tax = taxPct > 0 ? r2(parts * taxPct / 100) : 0
  const grand = r2(parts + labor + tax)
  const accent = (org.branding.accent || '').trim() || '#e11900'
  const billTo = c && customer ? customerLines(customer)
    : billToLines(org, wo.company)
  const terms = c?.terms ? (TERMS_TEXT[c.terms] ?? c.terms) : inv.terms

  const metaChips = [
    ['Date', date],
    ['Unit', wo.unit],
    ['Shop ref #', wo.shop_invoice],
    ['PO #', wo.po_number],
    ['Terms', terms],
    ['Account', c ? clean(c.accounting_id) : ''],
    ['Status', c && isInvoice
      ? (wo.payment_status === 'paid' ? 'Paid' : 'Balance due') : ''],
    ['Technician', wo.mechanic],
    ['Authorizer', wo.authorizer],
  ].filter(([, v]) => (v || '').toString().trim())

  return (
    <div className="wo-invoice" data-theme="light"
      style={{ '--inv-accent': accent } as CSSProperties}>
      <div className="inv-accentbar" />

      <header className="inv-head">
        <div className="inv-from">
          {shopLines(org).map((l, i) => (
            <div key={i} className={i === 0 ? 'inv-shopname' : ''}>{l}</div>
          ))}
        </div>
        <div className="inv-doc">
          <div className="inv-kind">{kind}</div>
          <div className="inv-num">#{number}</div>
        </div>
      </header>

      <div className="inv-parties">
        <Block title="Bill To" items={billTo} />
        <Block title="Unit" items={unitLines(wo, unit)} />
      </div>

      <div className="inv-meta">
        {metaChips.map(([k, v]) => (
          <div className="inv-meta-chip" key={k}>
            <span className="inv-meta-k">{k}</span>
            <span className="inv-meta-v">{v}</span>
          </div>
        ))}
      </div>

      {wo.complaint && (
        <div className="inv-complaint">
          <strong>Complaint.</strong> {wo.complaint}
        </div>
      )}

      <table className="inv-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Description</th>
            <th className="num">Qty × Rate</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {wlines.length === 0 ? (
            <tr><td colSpan={4} className="inv-muted">No line items yet.</td></tr>
          ) : wlines.map((l) => (
            <tr key={l.id}>
              <td className="inv-kindcell">
                {l.kind === 'part' ? 'Part' : 'Labor'}
              </td>
              <td>
                {l.part_number && (
                  <span className="inv-pn">{l.part_number}</span>
                )}
                {l.description}
              </td>
              <td className="num">{l.qty.toLocaleString('en-US')} × {money(rate(l))}</td>
              <td className="num">{money(l.qty * rate(l))}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="inv-totals-wrap">
        <table className="inv-totals">
          <tbody>
            <tr><td>Parts</td><td className="num">{money(parts)}</td></tr>
            <tr><td>Labor</td><td className="num">{money(labor)}</td></tr>
            {tax > 0 && (
              <tr><td>Tax ({taxPct}% on parts)</td><td className="num">{money(tax)}</td></tr>
            )}
            <tr className="inv-total-row">
              <td>Total</td><td className="num">{money(grand)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {inv.footer && <p className="inv-footer-note">{inv.footer}</p>}

      <div className="inv-sign">
        <div className="inv-sign-line">
          <span>Authorized by</span>
        </div>
        <div className="inv-sign-line">
          <span>Date</span>
        </div>
      </div>

      <footer className="inv-foot">
        {(org.shop.name || org.branding.app_name)} · {kind === 'INVOICE' ? 'Invoice' : 'Estimate'} {number} ·
        {' '}Generated by {org.branding.app_name}.
      </footer>
    </div>
  )
}

export default function WorkOrderInvoice({ wo, org, unit, customer, onClose }: {
  wo: WorkOrder
  org: OrgConfig
  unit?: FleetUnit
  // v2.22 [C]: perfil del cliente facturado (Bill To + markup).
  customer?: CustomerProfile
  onClose: () => void
}) {
  useEffect(() => {
    const done = () => onClose()
    window.addEventListener('afterprint', done, { once: true })
    const t = window.setTimeout(() => window.print(), 150)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('afterprint', done)
    }
  }, [onClose])

  // Memo del documento (no recomputa al re-render del padre).
  const page = useMemo(
    () => <InvoicePage wo={wo} org={org} unit={unit} customer={customer} />,
    [wo, org, unit, customer])

  return createPortal(
    <div className="print-root">{page}</div>,
    document.body,
  )
}
