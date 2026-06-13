import { type CSSProperties, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import type { FleetUnit, OrgConfig, WorkOrder } from '../api'

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

function InvoicePage({ wo, org, unit }: {
  wo: WorkOrder; org: OrgConfig; unit?: FleetUnit
}) {
  const isInvoice = wo.status === 'invoiced'
  const kind = isInvoice ? 'INVOICE' : 'ESTIMATE'
  const number = (wo.invoice_number || '').trim() || `WO-${wo.id}`
  const date = (wo.service_date || wo.created_at || '').slice(0, 10)
  const inv = org.invoice
  const wlines = wo.lines ?? []
  // Subtotales redondeados a centavos; el total se calcula sobre ellos para
  // que parts + labor sumen exactamente el total impreso (mismo criterio que
  // el backend en wo_invoice._totals).
  const r2 = (n: number) => Math.round(n * 100) / 100
  const parts = r2(wlines.filter((l) => l.kind === 'part')
    .reduce((s, l) => s + l.qty * l.unit_cost, 0))
  const labor = r2(wlines.filter((l) => l.kind === 'labor')
    .reduce((s, l) => s + l.qty * l.unit_cost, 0))
  const grand = r2(parts + labor)
  const accent = (org.branding.accent || '').trim() || '#e11900'

  const metaChips = [
    ['Date', date],
    ['Unit', wo.unit],
    ['Shop ref #', wo.shop_invoice],
    ['PO #', wo.po_number],
    ['Terms', inv.terms],
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
        <Block title="Bill To" items={billToLines(org, wo.company)} />
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
              <td className="num">{l.qty.toLocaleString('en-US')} × {money(l.unit_cost)}</td>
              <td className="num">{money(l.qty * l.unit_cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="inv-totals-wrap">
        <table className="inv-totals">
          <tbody>
            <tr><td>Parts</td><td className="num">{money(parts)}</td></tr>
            <tr><td>Labor</td><td className="num">{money(labor)}</td></tr>
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

export default function WorkOrderInvoice({ wo, org, unit, onClose }: {
  wo: WorkOrder
  org: OrgConfig
  unit?: FleetUnit
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
    () => <InvoicePage wo={wo} org={org} unit={unit} />, [wo, org, unit])

  return createPortal(
    <div className="print-root">{page}</div>,
    document.body,
  )
}
