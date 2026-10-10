// Drawer de detalle de una Purchase Order (v2.22 [A]/[F], rediseño).
//
// La ventaja sobre SquareRigger: una PO sigue EDITABLE después de recibida y
// después de cerrada. En SR, para corregir un costo hay que reabrir la PO, y
// eso des-recibe las partes y las saca del inventario. Acá:
//  - costo unitario / qty / taxable / descripción se editan a cualquier
//    status y fin_status. Si la línea ya tiene unidades recibidas, cambiar el
//    costo revalúa SOLO lo que sigue en stock (avg $X → $Y) y lo consumido
//    queda como varianza — con un confirm que muestra el impacto antes.
//  - ajustes (descuento/crédito/flete/tax/fee/pago) en cualquier momento;
//    los asignables se reparten en el landed cost.
//  - "Close" es financiero: no toca stock ni congela nada. Reopen tampoco.
//  - recibir de más se corrige con Unreceive por línea (nunca con el
//    pipeline hacia atrás).
//
// Pestañas: Info · Lines · Financial · History (auditoría).
import {
  Fragment, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject,
} from 'react'
import { Drawer } from 'vaul'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addPoAdjustment, addPoLine, closePo, deletePoLine, deletePurchaseOrder,
  getPoAudit, getPurchaseOrder, listParts, listVendors, patchPoLine,
  patchPurchaseOrder, receivePurchaseOrder, reopenPo, unreceivePoLine,
  voidPoAdjustment,
  type AuditEvent, type Part, type POAdjustment, type POAdjustmentKind,
  type POLine, type POPaymentMethod, type PORevaluation, type POStatus,
  type PurchaseOrder,
} from '../api'
import { notifyErr, notifyOk } from '../toast'
import { usePerms } from '../perms'
import { useEscLayer, useOutsidePress } from '../layers'
import { Button, Tabs } from '../components/ds'
import Modal from '../components/Modal'
import Skeleton from '../components/Skeleton'

const money = (n: number | null | undefined) =>
  (n ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const money4 = (n: number | null | undefined) =>
  (n ?? 0).toLocaleString('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })
const qtyFmt = (n: number) => (Math.round(n * 1000) / 1000).toLocaleString('en-US')
const dateOf = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '—')
const stamp = (iso: string | null | undefined) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16)
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

const PO_STATUS_META: Record<POStatus, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: 'wo-open' },
  ordered: { label: 'Ordered', cls: 'wo-progress' },
  received: { label: 'Received', cls: 'wo-done' },
}
const PIPE: POStatus[] = ['draft', 'ordered', 'received']

const PAY_METHODS: { id: POPaymentMethod; label: string }[] = [
  { id: '', label: 'Not set' },
  { id: 'invoice', label: 'On invoice (terms)' },
  { id: 'paid', label: 'Paid' },
  { id: 'card', label: 'Card' },
  { id: 'cash', label: 'Cash' },
]

const ADJ_META: Record<POAdjustmentKind, {
  label: string; sign: -1 | 1; allocatable: boolean; hint: string
}> = {
  discount: { label: 'Discount', sign: -1, allocatable: true,
    hint: 'Lowers the PO total. Spread into landed cost to lower part costs.' },
  credit: { label: 'Credit', sign: -1, allocatable: true,
    hint: 'Vendor credit (core refund, price protection, return).' },
  shipping: { label: 'Shipping', sign: 1, allocatable: true,
    hint: 'Freight. Spread into landed cost so parts carry what they really cost.' },
  tax: { label: 'Tax', sign: 1, allocatable: true,
    hint: 'Sales tax. When spread, it goes to taxable lines only.' },
  fee: { label: 'Fee', sign: 1, allocatable: true,
    hint: 'Handling, hazmat or other vendor fees.' },
  payment: { label: 'Payment', sign: -1, allocatable: false,
    hint: 'Money paid to the vendor. Lowers the balance, never part costs.' },
}
const ADJ_ORDER: POAdjustmentKind[] =
  ['discount', 'credit', 'shipping', 'tax', 'fee', 'payment']

// Capas internas abiertas: Escape las cierra a ellas, no al drawer.
const INNER_LAYERS = '.cb-pop, .modal-backdrop, .po-adj-menu, .po-void-form'

type PoTab = 'info' | 'lines' | 'financial' | 'history'

// Un token por click de "Receive shipment" => recepción idempotente.
function newReceiptToken(): string {
  return (crypto.randomUUID?.() ?? String(Date.now()))
    .replace(/-/g, '').slice(0, 16)
}

export default function PoDrawer({ poId, onClose }: {
  poId: number | null
  onClose: () => void
}) {
  const open = poId != null
  return (
    <Drawer.Root direction="right" open={open} dismissible handleOnly
      onOpenChange={(o) => { if (!o) onClose() }}>
      <Drawer.Portal>
        <Drawer.Overlay className="ud-overlay" />
        <Drawer.Content className="ud-content wo-drawer po-drawer"
          onEscapeKeyDown={(e) => {
            // Capas internas abiertas o una celda con un cambio sin guardar
            // (Escape revierte la celda): el drawer no se cierra.
            if (document.querySelector(INNER_LAYERS)
                || document.activeElement?.matches('[data-dirty="1"]')) {
              e.preventDefault()
            }
          }}>
          <Drawer.Handle className="wo-drawer-handle" />
          <Drawer.Title className="sr-only">
            Purchase order {poId ?? ''}
          </Drawer.Title>
          <Drawer.Description className="sr-only">
            Purchase order details: lines, receiving, financials and history
          </Drawer.Description>
          {poId != null && (
            <PoDetail key={poId} poId={poId} onClose={onClose} />
          )}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

// Confirmación de revaluación pendiente (costo de línea o ajuste asignado).
interface PendingReval {
  title: string
  action: string
  revals: PORevaluation[]
  run: () => Promise<PurchaseOrder>
  done?: string
}

function PoDetail({ poId, onClose }: { poId: number; onClose: () => void }) {
  const qc = useQueryClient()
  const { can } = usePerms()
  const editable = can('maint.edit')
  const [tab, setTab] = useState<PoTab>('info')
  const poQ = useQuery({
    queryKey: ['purchase-order', poId],
    queryFn: () => getPurchaseOrder(poId),
    staleTime: 0,
  })
  const po = poQ.data ?? null
  const partsQ = useQuery({ queryKey: ['parts'], queryFn: listParts })
  const catalog = partsQ.data?.parts ?? []
  const [pending, setPending] = useState<PendingReval | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [finBusy, setFinBusy] = useState(false)

  function apply(updated: PurchaseOrder, stockChanged = false) {
    qc.setQueryData(['purchase-order', updated.id], updated)
    qc.invalidateQueries({ queryKey: ['purchase-orders'] })
    if (stockChanged || (updated.revaluations?.length ?? 0) > 0) {
      qc.invalidateQueries({ queryKey: ['parts'] })
      qc.invalidateQueries({ queryKey: ['part-movements'] })
    }
  }

  // Ejecuta una edición que PUEDE revaluar inventario: primero un preview
  // (dry_run) y, si toca unidades recibidas, se pide confirmación con el
  // impacto ("Revalue N on-hand units — avg $X → $Y").
  async function withRevaluation(opts: {
    preview: () => Promise<PurchaseOrder>
    run: () => Promise<PurchaseOrder>
    title: string
    action: string
    done: string
  }): Promise<boolean> {
    let pv: PurchaseOrder
    try {
      pv = await opts.preview()
    } catch (e) {
      notifyErr("Couldn't save", e)
      return false
    }
    if (pv.dry_run !== true) {
      // El backend ya lo aplicó (sin soporte de preview): reflejarlo.
      apply(pv, true)
      notifyOk(opts.done, revalSummary(pv.revaluations))
      return true
    }
    const revals = (pv.revaluations ?? []).filter((r) =>
      Math.abs((r.new_cost ?? 0) - (r.old_cost ?? 0)) > 1e-9)
    if (revals.length === 0) {
      try {
        apply(await opts.run(), true)
        notifyOk(opts.done)
        return true
      } catch (e) {
        notifyErr("Couldn't save", e)
        return false
      }
    }
    setPending({
      title: opts.title, action: opts.action, revals, run: opts.run,
      done: opts.done,
    })
    return true
  }

  async function confirmPending() {
    if (!pending) return
    setConfirming(true)
    try {
      const updated = await pending.run()
      apply(updated, true)
      notifyOk(pending.done ?? 'Saved',
        revalSummary(updated.revaluations ?? pending.revals))
      setPending(null)
    } catch (e) {
      notifyErr("Couldn't save", e)
    } finally {
      setConfirming(false)
    }
  }

  async function setFin(close: boolean) {
    if (!po) return
    setFinBusy(true)
    try {
      apply(close ? await closePo(po.id) : await reopenPo(po.id))
      notifyOk(close ? `PO #${po.id} closed` : `PO #${po.id} reopened`,
        close ? 'Still editable: costs and adjustments keep working.' : undefined)
    } catch (e) {
      notifyErr(close ? "Couldn't close the PO" : "Couldn't reopen the PO", e)
    } finally {
      setFinBusy(false)
    }
  }

  if (poQ.isPending) {
    return (
      <div className="po-d is-loading" aria-busy="true">
        <div className="po-head"><Skeleton w="45%" h={24} /></div>
        <div className="ud-body">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} h={80} r={12} />)}
        </div>
      </div>
    )
  }
  if (!po) {
    return (
      <div className="po-d">
        <div className="wod-empty">
          <strong>Purchase order not found</strong>
          <span>{poQ.error ? String(poQ.error) : 'It may have been deleted.'}</span>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    )
  }

  const closed = (po.fin_status ?? 'open') === 'closed'
  const fin = po.financial
  const lines = po.lines ?? []
  const nLog = lines.reduce((s, l) => s + (l.received_log?.length ?? 0), 0)
  const activeAdj = (po.adjustments ?? []).filter((a) => !a.voided).length

  return (
    <div className="po-d">
      <header className="po-head">
        <div className="po-head-main">
          <span className="po-eyebrow">Purchase order</span>
          <h2 className="po-title">
            PO #{po.id}
            {po.vendor && <span className="po-title-v">{po.vendor}</span>}
          </h2>
          <div className="ud-chiprow po-chips">
            <span className={`wo-status ${PO_STATUS_META[po.status].cls}`}>
              {PO_STATUS_META[po.status].label}
            </span>
            {po.receiving_state === 'partial' && (
              <span className="wo-status wo-assigned">Partially received</span>
            )}
            <span className={`po-fin-chip ${closed ? 'is-closed' : 'is-open'}`}
              title={closed ? `Financially closed ${dateOf(po.closed_at)}`
                : 'Financially open'}>
              {closed ? 'Closed' : 'Open'}
            </span>
            {po.invoice_no && (
              <span className="ud-chip">Invoice {po.invoice_no}</span>
            )}
            {po.backorder_of_po_id != null && (
              <span className="po-bo-tag">
                ↳ Backorder of PO #{po.backorder_of_po_id}
              </span>
            )}
          </div>
        </div>
        <div className="po-head-actions">
          {editable && (closed ? (
            <Button variant="ghost" size="sm" loading={finBusy}
              onClick={() => setFin(false)}>Reopen</Button>
          ) : (
            <Button variant="ghost" size="sm" loading={finBusy}
              title="Close the PO financially. Lines and adjustments stay editable."
              onClick={() => setFin(true)}>Close PO</Button>
          ))}
          <button type="button" className="icon-btn" onClick={onClose}
            aria-label="Close">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </header>

      {closed && (
        <div className="po-closed-note" role="note">
          <LockOpenIcon />
          <span>
            <strong>Closed {dateOf(po.closed_at)} — still editable.</strong>{' '}
            Fix a unit cost or add a discount, freight or payment without
            reopening: received parts stay in stock and only their value is
            revalued.
          </span>
        </div>
      )}

      <div className="po-tabs">
        <Tabs aria-label="Purchase order sections"
          tabs={[
            { id: 'info', label: 'Info' },
            { id: 'lines', label: <>Lines<Count n={lines.length} /></> },
            { id: 'financial', label: <>Financial<Count n={activeAdj} /></> },
            { id: 'history', label: 'History' },
          ]}
          value={tab} onChange={(t) => setTab(t as PoTab)} />
      </div>

      <div className="ud-body po-body">
        {tab === 'info' && (
          <InfoTab po={po} editable={editable} onApply={apply}
            onGoLines={() => setTab('lines')}
            onGoFinancial={() => setTab('financial')}
            onDeleted={() => {
              qc.invalidateQueries({ queryKey: ['purchase-orders'] })
              qc.invalidateQueries({ queryKey: ['parts-requests'] })
              onClose()
            }} />
        )}
        {tab === 'lines' && (
          <LinesTab po={po} catalog={catalog} editable={editable}
            onApply={apply} withRevaluation={withRevaluation} nLog={nLog} />
        )}
        {tab === 'financial' && fin && (
          <FinancialTab po={po} editable={editable} onApply={apply}
            withRevaluation={withRevaluation} />
        )}
        {tab === 'financial' && !fin && (
          <p className="po-none">
            Financial details aren't available for this purchase order yet.
          </p>
        )}
        {tab === 'history' && <HistoryTab po={po} />}
      </div>

      {pending && (
        <RevalueConfirm pending={pending} catalog={catalog} busy={confirming}
          onCancel={() => setPending(null)} onConfirm={confirmPending} />
      )}
    </div>
  )
}

function Count({ n }: { n: number }) {
  return n ? <span className="rx-tab-n">{n}</span> : null
}

function revalSummary(revals?: PORevaluation[]): string | undefined {
  const r = (revals ?? []).filter((x) => (x.revalued_qty ?? 0) > 0)
  if (!r.length) return undefined
  const units = r.reduce((s, x) => s + x.revalued_qty, 0)
  if (r.length === 1 && r[0].avg_old != null && r[0].avg_new != null) {
    return `Revalued ${qtyFmt(units)} on-hand ${r[0].part_number}: avg ${money(r[0].avg_old)} → ${money(r[0].avg_new)}`
  }
  return `Revalued ${qtyFmt(units)} on-hand units across ${r.length} parts`
}

// ===== Info =================================================================
function InfoTab({ po, editable, onApply, onGoLines, onGoFinancial, onDeleted }: {
  po: PurchaseOrder
  editable: boolean
  onApply: (p: PurchaseOrder, stock?: boolean) => void
  onGoLines: () => void
  onGoFinancial: () => void
  onDeleted: () => void
}) {
  const qc = useQueryClient()
  const vendorsQ = useQuery({ queryKey: ['vendors'], queryFn: listVendors })
  const [busy, setBusy] = useState(false)
  const lines = po.lines ?? []
  const anyReceived = lines.some((l) => l.qty_received > 0)
  const idx = PIPE.indexOf(po.status)
  const next = PIPE[idx + 1] as POStatus | undefined

  async function save(patch: Parameters<typeof patchPurchaseOrder>[1]) {
    try {
      onApply(await patchPurchaseOrder(po.id, patch))
    } catch (e) {
      notifyErr("Couldn't save", e)
    }
  }

  async function advance(to: POStatus) {
    if (to === 'received' && !window.confirm(
      `Receive everything still outstanding on PO #${po.id} into stock?`
      + '\n\nTo receive part of a shipment, use Receive shipment below.')) return
    setBusy(true)
    try {
      onApply(await patchPurchaseOrder(po.id, { status: to }), to === 'received')
      if (to === 'received') qc.invalidateQueries({ queryKey: ['cores'] })
      notifyOk(`PO #${po.id}: ${PO_STATUS_META[to].label}`)
    } catch (e) {
      notifyErr("Can't move there yet", e)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!window.confirm(`Delete PO #${po.id}? This cannot be undone.`)) return
    try {
      await deletePurchaseOrder(po.id)
      notifyOk('Purchase order deleted', `#${po.id}`)
      onDeleted()
    } catch (e) {
      notifyErr("Couldn't delete the PO", e)
    }
  }

  return (
    <div className="po-stack">
      {/* Pipeline de recepción: solo hacia adelante. Volver atrás = Unreceive
          por línea (el stock nunca queda huérfano). */}
      <section className="ud-sec">
        <h3>Receiving</h3>
        <ol className="po-pipe" aria-label="Receiving status">
          {PIPE.map((s, i) => {
            // El último paso alcanzado (Received) se muestra completo.
            const done = i < idx || (i === idx && i === PIPE.length - 1)
            return (
              <li key={s} className={`po-pipe-step ${done ? 'is-done'
                : i === idx ? 'is-current' : ''}`}
                aria-current={i === idx ? 'step' : undefined}>
                <span className="po-pipe-dot" aria-hidden="true">
                  {done ? '✓' : i + 1}
                </span>
                <span>{PO_STATUS_META[s].label}</span>
              </li>
            )
          })}
        </ol>
        <div className="po-pipe-actions">
          {editable && next && (
            <Button variant={next === 'ordered' ? 'primary' : 'ghost'} size="sm"
              loading={busy} onClick={() => advance(next)}>
              {next === 'ordered' ? 'Mark as ordered' : 'Receive everything'}
            </Button>
          )}
          <span className="po-hint">
            {po.status === 'received'
              ? `Received ${dateOf(po.received_at)}. To correct a receipt, use Unreceive on the line.`
              : po.status === 'ordered'
                ? 'Receive what arrived below; short lines can go on a backorder.'
                : 'Mark it ordered once it is sent to the vendor.'}
          </span>
        </div>
      </section>

      <ReceiveSection po={po} editable={editable} onApply={onApply} />

      <section className="ud-sec">
        <h3>Vendor &amp; invoice</h3>
        <div className="po-fields" key={`${po.id}:${po.updated_at}`}>
          <label className="ud-field po-f-wide">
            <span>Vendor</span>
            <input className="cell-input" list={`po-vendors-${po.id}`}
              defaultValue={po.vendor} placeholder="Vendor name"
              disabled={!editable}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v !== po.vendor) save({ vendor: v })
              }} />
            <datalist id={`po-vendors-${po.id}`}>
              {(vendorsQ.data ?? []).map((v) => <option key={v.id} value={v.name} />)}
            </datalist>
          </label>
          <label className="ud-field">
            <span>Vendor invoice #</span>
            <input className="cell-input" defaultValue={po.invoice_no ?? ''}
              maxLength={40} disabled={!editable} placeholder="e.g. 1756"
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v !== (po.invoice_no ?? '')) save({ invoice_no: v })
              }} />
          </label>
          <label className="ud-field">
            <span>Invoice date</span>
            <input className="cell-input" type="date"
              defaultValue={po.invoice_date ?? ''} disabled={!editable}
              onBlur={(e) => {
                const v = e.target.value
                if (v !== (po.invoice_date ?? '')) save({ invoice_date: v })
              }} />
          </label>
          <label className="ud-field">
            <span>Tracking #</span>
            <input className="cell-input" defaultValue={po.tracking_no ?? ''}
              maxLength={60} disabled={!editable} placeholder="Carrier tracking"
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v !== (po.tracking_no ?? '')) save({ tracking_no: v })
              }} />
          </label>
          <label className="ud-field">
            <span>Payment method</span>
            <select className="cell-input" value={po.payment_method ?? ''}
              disabled={!editable}
              onChange={(e) => save({
                payment_method: e.target.value as POPaymentMethod })}>
              {PAY_METHODS.map((m) => (
                <option key={m.id || 'none'} value={m.id}>{m.label}</option>
              ))}
            </select>
          </label>
          <label className="ud-field po-f-wide">
            <span>Notes</span>
            <textarea className="cell-input ud-notes" rows={2}
              defaultValue={po.notes} placeholder="optional"
              disabled={!editable}
              onBlur={(e) => {
                if (e.target.value !== po.notes) save({ notes: e.target.value })
              }} />
          </label>
        </div>
      </section>

      <section className="ud-sec">
        <h3>Summary</h3>
        <div className="po-sumrow">
          <button type="button" className="po-sumcell" onClick={onGoLines}>
            <span>Lines</span>
            <strong>{lines.length}</strong>
          </button>
          <button type="button" className="po-sumcell" onClick={onGoFinancial}>
            <span>Total</span>
            <strong className="mono">{money(po.financial?.total ?? po.total)}</strong>
          </button>
          <button type="button" className="po-sumcell" onClick={onGoFinancial}>
            <span>Balance</span>
            <strong className={`mono ${(po.financial?.balance ?? 0) > 0.005 ? 'is-due' : ''}`}>
              {money(po.financial?.balance ?? po.total)}
            </strong>
          </button>
        </div>
      </section>

      {editable && (
        <section className="ud-sec po-danger">
          <div>
            <strong>Delete purchase order</strong>
            <p>
              {anyReceived
                ? 'This PO has received parts. Unreceive them on the Lines tab first — stock is never left orphaned.'
                : 'Removes the PO. Parts requests bundled into it go back to pending.'}
            </p>
          </div>
          <Button variant="ghost" size="sm" className="up-danger"
            disabled={anyReceived} onClick={remove}>Delete PO</Button>
        </section>
      )}
    </div>
  )
}

function ReceiveSection({ po, editable, onApply }: {
  po: PurchaseOrder
  editable: boolean
  onApply: (p: PurchaseOrder, stock?: boolean) => void
}) {
  const qc = useQueryClient()
  const lines = (po.lines ?? []).filter((l) =>
    (l.part_number || '').trim() && l.qty_outstanding > 0)
  const [recvQty, setRecvQty] = useState<Record<number, string>>({})
  // Una PO ya recibida a la que se le sumó una línea: recibirla sin
  // backorder (el resto no se "cierra" otra vez).
  const [backorder, setBackorder] = useState(po.status !== 'received')
  const [busy, setBusy] = useState(false)
  if (!editable || lines.length === 0) return null
  // PO original ya recibida con backorder: lo que falta vive en la PO hija
  // (POs viejas conservaban el pendiente acá; recibirlo contaría el stock dos
  // veces). Se recibe en el backorder.
  const children = po.backorder_po_ids ?? []
  if (po.status === 'received' && children.length > 0) {
    return (
      <section className="ud-sec po-receive">
        <h3>Receive shipment</h3>
        <p className="po-hint">
          The short quantity of this PO was moved to backorder PO{' '}
          {children.map((c) => `#${c}`).join(', ')} — receive it there.
        </p>
      </section>
    )
  }

  async function receive() {
    const receipts = lines.map((l) => ({
      line_id: l.id,
      qty_now: recvQty[l.id] !== undefined
        ? Number(recvQty[l.id]) || 0 : l.qty_outstanding,
    })).filter((r) => r.qty_now > 0)
    if (!receipts.length) {
      notifyErr('Nothing to receive', 'Enter a qty on at least one line')
      return
    }
    const token = newReceiptToken()
    setBusy(true)
    try {
      const res = await receivePurchaseOrder(po.id, receipts, token, backorder)
      onApply(res.po, true)
      qc.invalidateQueries({ queryKey: ['cores'] })
      setRecvQty({})
      notifyOk(res.backorder ? 'Received + backorder created' : 'Shipment received',
        res.backorder ? `Backorder PO #${res.backorder.id} for the missing qty`
          : `PO #${po.id}`)
    } catch (e) {
      notifyErr("Couldn't receive", e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="ud-sec po-receive">
      <h3>Receive shipment</h3>
      <p className="po-hint">
        Enter what arrived per line. It goes into stock at the line's landed
        cost and updates each part's average cost.
      </p>
      <div className="po-recv-lines">
        {lines.map((l) => (
          <div className="po-recv-line" key={l.id}>
            <span className="po-recv-name">
              <span className="mono">{l.part_number}</span>
              <span className="muted sm">{l.description}</span>
            </span>
            <span className="po-recv-ctl">
              <input className="cell-input po-recv-input" type="number"
                min="0" max={l.qty_outstanding} step="any"
                aria-label={`Quantity received of ${l.part_number}`}
                value={recvQty[l.id] ?? String(l.qty_outstanding)}
                onChange={(e) => setRecvQty({ ...recvQty, [l.id]: e.target.value })} />
              <span className="muted sm">of {qtyFmt(l.qty_outstanding)}</span>
            </span>
          </div>
        ))}
      </div>
      <label className="po-recv-bo">
        <input type="checkbox" checked={backorder}
          onChange={(e) => setBackorder(e.target.checked)} />
        <span>Backorder the rest on a new PO</span>
      </label>
      <Button variant="primary" size="sm" loading={busy} onClick={receive}>
        Receive shipment
      </Button>
    </section>
  )
}

// ===== Lines ================================================================
// ¿Un cambio de líneas (qty, costo de una línea sin recibir, alta, baja)
// puede revaluar inventario? Sí cuando hay ajustes ASIGNADOS (re-prorrateo
// del landed cost) y alguna línea con unidades recibidas.
function repricesStock(po: PurchaseOrder): boolean {
  return (po.adjustments ?? []).some((a) => !a.voided && a.allocate)
    && (po.lines ?? []).some((l) => l.qty_received > 0)
}
const REALLOC = 'Allocated adjustments are spread again across the lines'

type WithReval = (opts: {
  preview: () => Promise<PurchaseOrder>
  run: () => Promise<PurchaseOrder>
  title: string
  action: string
  done: string
}) => Promise<boolean>

function LinesTab({ po, catalog, editable, onApply, withRevaluation, nLog }: {
  po: PurchaseOrder
  catalog: Part[]
  editable: boolean
  onApply: (p: PurchaseOrder, stock?: boolean) => void
  withRevaluation: WithReval
  nLog: number
}) {
  const lines = po.lines ?? []
  const [logOpen, setLogOpen] = useState<Set<number>>(() => new Set())
  const toggleLog = (id: number) => setLogOpen((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })
  const anyLanded = lines.some((l) => l.landed_unit_cost != null)

  return (
    <div className="po-stack">
      <p className="po-edit-note">
        <LockOpenIcon />
        <span>
          Every field stays editable after receiving and after closing.
          Changing the cost of received parts revalues only what is still on
          hand; what was already used is posted as a variance.
        </span>
      </p>
      {lines.length === 0 ? (
        <p className="po-none">No lines yet. Add the first one below.</p>
      ) : (
        <div className="table-wrap po-lines-wrap">
          <table className="defects-table po-lines">
            <thead>
              <tr>
                <th scope="col">Part</th>
                <th scope="col" className="num">Qty</th>
                <th scope="col" className="num">Received</th>
                <th scope="col" className="num">Unit cost</th>
                <th scope="col" className="po-c-tax">Tax</th>
                <th scope="col" className="num">Total</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((ln) => (
                <Fragment key={ln.id}>
                  <LineRow key={`${ln.id}|${ln.qty}|${ln.unit_cost}|${ln.description}`}
                    po={po} ln={ln} catalog={catalog}
                    editable={editable} onApply={onApply}
                    withRevaluation={withRevaluation}
                    logOpen={logOpen.has(ln.id)}
                    onToggleLog={() => toggleLog(ln.id)} />
                  {logOpen.has(ln.id) && (
                    <tr className="po-log-row">
                      <td colSpan={7}><ReceivedLog ln={ln} /></td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="po-lines-foot">
        <span>
          {lines.length} line{lines.length === 1 ? '' : 's'}
          {nLog ? ` · ${nLog} stock movements` : ''}
          {anyLanded ? ' · landed cost includes allocated adjustments' : ''}
        </span>
        <span>Subtotal <strong className="mono">
          {money(po.financial?.subtotal ?? lines.reduce((s, l) => s + l.total, 0))}
        </strong></span>
      </div>
      {editable && (
        <AddLineRow po={po} catalog={catalog} onApply={onApply}
          withRevaluation={withRevaluation} />
      )}
    </div>
  )
}

function LineRow({
  po, ln, catalog, editable, onApply, withRevaluation, logOpen, onToggleLog,
}: {
  po: PurchaseOrder
  ln: POLine
  catalog: Part[]
  editable: boolean
  onApply: (p: PurchaseOrder, stock?: boolean) => void
  withRevaluation: WithReval
  logOpen: boolean
  onToggleLog: () => void
}) {
  // Borradores locales; el padre re-monta la fila (key con los valores del
  // servidor) cuando la línea cambia, así nunca quedan desfasados.
  const [qty, setQty] = useState(String(ln.qty))
  const [cost, setCost] = useState(String(ln.unit_cost))
  const [desc, setDesc] = useState(ln.description)
  const [busy, setBusy] = useState(false)
  const received = ln.qty_received > 0
  const full = ln.qty > 0 && ln.qty_received >= ln.qty
  const nLog = ln.received_log?.length ?? 0
  const part = ln.part_number
    ? catalog.find((p) => p.part_number.toLowerCase()
      === ln.part_number.toLowerCase()) : undefined

  async function commitQty() {
    const v = Number(qty)
    if (!qty.trim() || !Number.isFinite(v) || v <= 0) { setQty(String(ln.qty)); return }
    if (Math.abs(v - ln.qty) < 1e-9) return
    if (v < ln.qty_received - 1e-9) {
      notifyErr("Quantity can't go below what was received",
        `${qtyFmt(ln.qty_received)} already received — use Unreceive to give parts back`)
      setQty(String(ln.qty))
      return
    }
    setBusy(true)
    try {
      if (repricesStock(po)) {
        // Cambiar la qty cambia el valor de la línea -> re-prorrateo que
        // puede revaluar lo recibido de OTRAS líneas: preview + confirmar.
        await withRevaluation({
          preview: () => patchPoLine(po.id, ln.id, { qty: v, dry_run: true }),
          run: () => patchPoLine(po.id, ln.id, { qty: v }),
          title: `Change quantity · ${ln.part_number || ln.description}`,
          action: `${qtyFmt(ln.qty)} → ${qtyFmt(v)}. ${REALLOC}.`,
          done: 'Quantity updated',
        })
        setQty(String(ln.qty))
      } else {
        onApply(await patchPoLine(po.id, ln.id, { qty: v }))
      }
    } catch (e) {
      notifyErr("Couldn't change the quantity", e)
      setQty(String(ln.qty))
    } finally {
      setBusy(false)
    }
  }

  async function commitCost() {
    const v = Number(cost)
    if (cost.trim() === '' || !Number.isFinite(v) || v < 0) {
      setCost(String(ln.unit_cost))
      return
    }
    if (Math.abs(v - ln.unit_cost) < 1e-9) return
    setBusy(true)
    try {
      if (received && ln.part_number) {
        await withRevaluation({
          preview: () => patchPoLine(po.id, ln.id, { unit_cost: v, dry_run: true }),
          run: () => patchPoLine(po.id, ln.id, { unit_cost: v }),
          title: `Change unit cost · ${ln.part_number}`,
          action: `${money4(ln.unit_cost)} → ${money4(v)} on ${qtyFmt(ln.qty_received)} received`,
          done: 'Unit cost updated',
        })
        // El campo vuelve al valor guardado: si se confirma, la PO nueva
        // re-monta la fila con el costo nuevo; si se cancela, queda igual.
        setCost(String(ln.unit_cost))
      } else if (repricesStock(po)) {
        // Línea sin recibir, pero con ajustes asignados su valor re-prorratea
        // el landed cost de las líneas recibidas.
        await withRevaluation({
          preview: () => patchPoLine(po.id, ln.id, { unit_cost: v, dry_run: true }),
          run: () => patchPoLine(po.id, ln.id, { unit_cost: v }),
          title: `Change unit cost · ${ln.part_number || ln.description}`,
          action: `${money4(ln.unit_cost)} → ${money4(v)}. ${REALLOC}.`,
          done: 'Unit cost updated',
        })
        setCost(String(ln.unit_cost))
      } else {
        onApply(await patchPoLine(po.id, ln.id, { unit_cost: v }))
      }
    } catch (e) {
      notifyErr("Couldn't change the cost", e)
      setCost(String(ln.unit_cost))
    } finally {
      setBusy(false)
    }
  }

  async function commitDesc() {
    const d = desc.trim()
    if (d === ln.description || (!d && !ln.part_number)) {
      setDesc(ln.description)
      return
    }
    try {
      onApply(await patchPoLine(po.id, ln.id, { description: d }))
    } catch (e) {
      notifyErr("Couldn't rename the line", e)
      setDesc(ln.description)
    }
  }

  async function toggleTaxable(t: boolean) {
    // Con tax asignado, cambiar taxable re-prorratea: pasa por el preview.
    const taxAllocated = (po.adjustments ?? []).some((a) =>
      !a.voided && a.kind === 'tax' && a.allocate)
    try {
      if (taxAllocated && received) {
        await withRevaluation({
          preview: () => patchPoLine(po.id, ln.id, { taxable: t, dry_run: true }),
          run: () => patchPoLine(po.id, ln.id, { taxable: t }),
          title: `${t ? 'Mark' : 'Unmark'} ${ln.part_number || 'line'} taxable`,
          action: 'Allocated tax is spread again across taxable lines',
          done: 'Line updated',
        })
      } else {
        onApply(await patchPoLine(po.id, ln.id, { taxable: t }))
      }
    } catch (e) {
      notifyErr("Couldn't update the line", e)
    }
  }

  async function unreceive() {
    if (!window.confirm(
      `Unreceive ${qtyFmt(ln.qty_received)} × ${ln.part_number || ln.description}?\n\n`
      + 'Stock goes down by that quantity, the average cost is reversed and '
      + 'pending cores for this line are voided. You can receive it again later.')) return
    setBusy(true)
    try {
      onApply(await unreceivePoLine(po.id, ln.id), true)
      notifyOk('Line unreceived', `${ln.part_number} · stock and average cost reversed`)
    } catch (e) {
      notifyErr("Couldn't unreceive the line", e)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!window.confirm(`Remove ${ln.part_number || ln.description} from PO #${po.id}?`)) return
    try {
      if (repricesStock(po)) {
        await withRevaluation({
          preview: () => deletePoLine(po.id, ln.id, true),
          run: () => deletePoLine(po.id, ln.id),
          title: `Remove ${ln.part_number || ln.description}`,
          action: REALLOC,
          done: 'Line removed',
        })
      } else {
        onApply(await deletePoLine(po.id, ln.id))
      }
    } catch (e) {
      notifyErr("Couldn't delete the line", e)
    }
  }

  const landed = ln.landed_unit_cost != null
    && Math.abs(ln.landed_unit_cost - ln.unit_cost) > 1e-6
  const enter = (fn: () => void) => (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() }
    // Sin stopPropagation: si hay un modal encima, su Escape también corre.
    if (e.key === 'Escape') fn()
  }

  return (
    <tr className={`po-line ${busy ? 'is-busy' : ''}`}>
      <td className="po-c-part">
        {ln.part_number && <span className="mono po-pn">{ln.part_number}</span>}
        {editable ? (
          <input className="po-cell-input po-desc" value={desc}
            aria-label={`Description of line ${ln.part_number || ln.id}`}
            onChange={(e) => setDesc(e.target.value)} onBlur={commitDesc}
            data-dirty={desc !== ln.description ? '1' : undefined}
            onKeyDown={enter(() => setDesc(ln.description))} />
        ) : <span className="po-desc-ro">{ln.description}</span>}
        {part && (
          <span className="po-part-meta">
            {qtyFmt(part.on_hand)} on hand · avg {money(part.avg_cost || part.cost)}
          </span>
        )}
      </td>
      <td className="num" data-label="Qty">
        {editable ? (
          <input className="cell-input po-num" type="number" min={ln.qty_received || 0}
            step="any" value={qty} inputMode="decimal"
            aria-label={`Quantity of ${ln.part_number || 'line'}`}
            onChange={(e) => setQty(e.target.value)} onBlur={commitQty}
            data-dirty={qty !== String(ln.qty) ? '1' : undefined}
            onKeyDown={enter(() => setQty(String(ln.qty)))} />
        ) : qtyFmt(ln.qty)}
      </td>
      <td className="num" data-label="Received">
        <span className={`po-recv ${full ? 'is-full' : received ? 'is-part' : ''}`}>
          {qtyFmt(ln.qty_received)}/{qtyFmt(ln.qty)}
        </span>
        <span className="po-recv-acts">
          {nLog > 0 && (
            <button type="button" className="po-mini" aria-expanded={logOpen}
              onClick={onToggleLog}
              title="Show the received log">Log {nLog}</button>
          )}
          {editable && received && (
            <button type="button" className="po-mini is-warn"
              onClick={unreceive} disabled={busy}
              title="Give the received parts back (reverses stock)">
              Unreceive
            </button>
          )}
        </span>
      </td>
      <td className="num" data-label="Unit cost">
        {editable ? (
          <input className="cell-input po-num po-cost" type="number" min={0}
            step="0.01" value={cost} inputMode="decimal"
            aria-label={`Unit cost of ${ln.part_number || 'line'}`}
            aria-describedby={received ? `po-rv-${ln.id}` : undefined}
            onChange={(e) => setCost(e.target.value)} onBlur={commitCost}
            data-dirty={cost !== String(ln.unit_cost) ? '1' : undefined}
            onKeyDown={enter(() => setCost(String(ln.unit_cost)))} />
        ) : money4(ln.unit_cost)}
        {landed && (
          <span className="po-landed" title="Unit cost plus allocated adjustments">
            landed {money4(ln.landed_unit_cost)}
          </span>
        )}
        {received && editable && (
          <span className="sr-only" id={`po-rv-${ln.id}`}>
            Changing this cost revalues the received parts still on hand
          </span>
        )}
      </td>
      <td className="po-c-tax" data-label="Taxable">
        <input type="checkbox" checked={!!ln.taxable} disabled={!editable}
          aria-label={`${ln.part_number || 'Line'} is taxable`}
          onChange={(e) => toggleTaxable(e.target.checked)} />
      </td>
      <td className="num mono" data-label="Total">{money(ln.total)}</td>
      <td className="num po-c-act">
        {editable && !received && (
          <button type="button" className="icon-x" title="Remove line"
            aria-label={`Remove ${ln.part_number || 'line'}`}
            onClick={remove}>✕</button>
        )}
      </td>
    </tr>
  )
}

function ReceivedLog({ ln }: { ln: POLine }) {
  const log = ln.received_log ?? []
  const label = (r?: string) => r === 'po_cost_adj' ? 'Cost adjusted'
    : r === 'po_unreceive' ? 'Unreceived' : 'Received'
  return (
    <div className="po-log">
      <span className="po-log-t">Received log · {ln.part_number}</span>
      <ul>
        {log.map((r, i) => (
          <li key={`${r.ref}-${i}`}>
            <span className={`po-log-k k-${r.reason ?? 'po_receive'}`}>{label(r.reason)}</span>
            <span className="mono">{stamp(r.date)}</span>
            <span>
              {r.reason === 'po_cost_adj'
                ? <>value {(r.value_delta ?? 0) >= 0 ? '+' : '−'}{money(Math.abs(r.value_delta ?? 0))}
                  {r.unit_cost != null ? ` · now ${money4(r.unit_cost)}/ea` : ''}</>
                : <>{(r.qty > 0 ? '+' : '') + qtyFmt(r.qty)} @ {money4(r.unit_cost)}/ea</>}
            </span>
            <span className="muted">{r.actor || '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function AddLineRow({ po, catalog, onApply, withRevaluation }: {
  po: PurchaseOrder
  catalog: Part[]
  onApply: (p: PurchaseOrder, stock?: boolean) => void
  withRevaluation: WithReval
}) {
  const [pn, setPn] = useState('')
  const [desc, setDesc] = useState('')
  const [qty, setQty] = useState('1')
  const [cost, setCost] = useState('')
  const [taxable, setTaxable] = useState(false)
  const [busy, setBusy] = useState(false)

  function pick(v: string) {
    setPn(v)
    const hit = catalog.find((p) => p.part_number.toLowerCase() === v.trim().toLowerCase())
    if (hit) {
      if (!desc.trim()) setDesc(hit.description)
      // Costo de reposición: el último costo recibido si existe.
      setCost(String(hit.last_cost ?? hit.cost))
    }
  }

  async function add() {
    if ((!desc.trim() && !pn.trim()) || busy) return
    setBusy(true)
    try {
      const line = {
        part_number: pn.trim(), description: desc.trim(),
        qty: Number(qty) || 1, unit_cost: Number(cost) || 0, taxable,
      }
      if (repricesStock(po)) {
        // Una línea nueva re-prorratea los ajustes asignados: preview.
        await withRevaluation({
          preview: () => addPoLine(po.id, { ...line, dry_run: true }),
          run: () => addPoLine(po.id, line),
          title: `Add ${line.part_number || line.description}`,
          action: REALLOC,
          done: 'Line added',
        })
      } else {
        onApply(await addPoLine(po.id, line))
      }
      setPn(''); setDesc(''); setQty('1'); setCost(''); setTaxable(false)
    } catch (e) {
      notifyErr("Couldn't add the line", e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="po-addline" onSubmit={(e) => { e.preventDefault(); void add() }}>
      <span className="po-addline-t">Add line</span>
      <input className="cell-input" list={`po-parts-${po.id}`} placeholder="Part #"
        aria-label="Part number" value={pn} onChange={(e) => pick(e.target.value)} />
      <input className="cell-input" placeholder="Description" aria-label="Description"
        value={desc} onChange={(e) => setDesc(e.target.value)} />
      <input className="cell-input po-num" type="number" min="0" step="any"
        aria-label="Quantity" value={qty} onChange={(e) => setQty(e.target.value)} />
      <input className="cell-input po-num" type="number" min="0" step="0.01"
        aria-label="Unit cost" placeholder="0.00" value={cost}
        onChange={(e) => setCost(e.target.value)} />
      <label className="po-addline-tax">
        <input type="checkbox" checked={taxable}
          onChange={(e) => setTaxable(e.target.checked)} />
        Taxable
      </label>
      <Button variant="primary" size="sm" type="submit" loading={busy}
        disabled={!desc.trim() && !pn.trim()}>Add</Button>
      <datalist id={`po-parts-${po.id}`}>
        {catalog.map((p) => (
          <option key={p.id} value={p.part_number}>{p.description}</option>
        ))}
      </datalist>
    </form>
  )
}

// ===== Financial ============================================================
function FinancialTab({ po, editable, onApply, withRevaluation }: {
  po: PurchaseOrder
  editable: boolean
  onApply: (p: PurchaseOrder, stock?: boolean) => void
  withRevaluation: WithReval
}) {
  const f = po.financial!
  const [menuOpen, setMenuOpen] = useState(false)
  const [form, setForm] = useState<POAdjustmentKind | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const adjs = [...(po.adjustments ?? [])].sort((a, b) =>
    Number(a.voided) - Number(b.voided)
    || (b.created_at ?? '').localeCompare(a.created_at ?? ''))
  const anyReceived = (po.lines ?? []).some((l) => l.qty_received > 0)

  const rows: [string, number, string?][] = [
    ['Subtotal', f.subtotal],
    ['Discount', -f.discount],
    ['Credit', -f.credit],
    ['Shipping', f.shipping],
    ['Tax', f.tax],
    ['Fees', f.fees],
  ]

  return (
    <div className="po-stack">
      <section className="ud-sec">
        <h3>Invoice summary</h3>
        <div className="po-fin">
          {rows.filter(([k, v]) => k === 'Subtotal' || Math.abs(v) > 0.004)
            .map(([k, v]) => (
              <div className="po-fin-row" key={k}>
                <span>{k}</span>
                <span className="mono">{v < 0 ? `−${money(-v)}` : money(v)}</span>
              </div>
            ))}
          <div className="po-fin-row is-total">
            <span>Total</span><span className="mono">{money(f.total)}</span>
          </div>
          <div className="po-fin-row">
            <span>Paid</span>
            <span className="mono">{f.paid ? `−${money(f.paid)}` : money(0)}</span>
          </div>
          <div className={`po-fin-row is-balance ${f.balance > 0.004 ? 'is-due' : 'is-clear'}`}>
            <span>Balance</span><span className="mono">{money(f.balance)}</span>
          </div>
        </div>
      </section>

      <section className="ud-sec">
        <div className="po-adj-head">
          <h3>Adjustments</h3>
          {editable && (
            <div className="po-adj-menu-wrap">
              <button ref={btnRef} type="button" className="btn btn-ghost btn-xs"
                aria-haspopup="menu" aria-expanded={menuOpen}
                onClick={() => setMenuOpen((o) => !o)}>
                Add adjustment ▾
              </button>
              {menuOpen && (
                <AdjMenu anchor={btnRef} onClose={() => setMenuOpen(false)}
                  onPick={(k) => { setMenuOpen(false); setForm(k) }} />
              )}
            </div>
          )}
        </div>
        {form && (
          <AdjForm po={po} kind={form} anyReceived={anyReceived}
            onApply={onApply} withRevaluation={withRevaluation}
            onDone={() => setForm(null)} />
        )}
        {adjs.length === 0 && !form ? (
          <p className="po-none">
            No adjustments. Add a discount, vendor credit, freight, tax, fee
            or payment — even after the PO is received or closed.
          </p>
        ) : (
          <ul className="po-adjs">
            {adjs.map((a) => (
              <AdjRow key={a.id} po={po} a={a} editable={editable}
                onApply={onApply} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

// Menú inline (no portal: el drawer de vaul atrapa el foco) con teclado.
function AdjMenu({ anchor, onClose, onPick }: {
  anchor: RefObject<HTMLButtonElement | null>
  onClose: () => void
  onPick: (k: POAdjustmentKind) => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEscLayer(true, () => { onClose(); anchor.current?.focus() })
  useOutsidePress(true, [ref, anchor], onClose)
  function onKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(
      '[role="menuitem"]') ?? [])
    const i = items.indexOf(document.activeElement as HTMLElement)
    let j = -1
    if (e.key === 'ArrowDown') j = (i + 1) % items.length
    else if (e.key === 'ArrowUp') j = i <= 0 ? items.length - 1 : i - 1
    else if (e.key === 'Home') j = 0
    else if (e.key === 'End') j = items.length - 1
    else if (e.key === 'Tab') onClose()
    if (j >= 0) { e.preventDefault(); items[j].focus() }
  }
  return (
    <div ref={ref} className="po-adj-menu rs-menu" role="menu"
      aria-label="Add adjustment" onKeyDown={onKey}>
      {ADJ_ORDER.map((k, i) => (
        <button key={k} type="button" role="menuitem" className="rs-menu-item"
          autoFocus={i === 0} onClick={() => onPick(k)}>
          <span className={`po-adj-dot k-${k}`} aria-hidden="true" />
          <span className="rs-mi-label">Add {ADJ_META[k].label.toLowerCase()}</span>
        </button>
      ))}
    </div>
  )
}

function AdjForm({ po, kind, anyReceived, onApply, withRevaluation, onDone }: {
  po: PurchaseOrder
  kind: POAdjustmentKind
  anyReceived: boolean
  onApply: (p: PurchaseOrder, stock?: boolean) => void
  withRevaluation: WithReval
  onDone: () => void
}) {
  const meta = ADJ_META[kind]
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [allocate, setAllocate] = useState(meta.allocatable)
  const [busy, setBusy] = useState(false)
  const amt = Number(amount)
  const valid = amount.trim() !== '' && Number.isFinite(amt) && amt > 0

  async function submit() {
    if (!valid || busy) return
    setBusy(true)
    const body = { kind, amount: Math.round(amt * 100) / 100,
      note: note.trim(), allocate: meta.allocatable && allocate }
    try {
      if (body.allocate && anyReceived) {
        const ok = await withRevaluation({
          preview: () => addPoAdjustment(po.id, { ...body, dry_run: true }),
          run: () => addPoAdjustment(po.id, body),
          title: `Add ${meta.label.toLowerCase()} · ${money(body.amount)}`,
          action: 'Spread into the landed cost of every line',
          done: `${meta.label} added`,
        })
        if (ok) onDone()
      } else {
        onApply(await addPoAdjustment(po.id, body))
        notifyOk(`${meta.label} added`, money(body.amount))
        onDone()
      }
    } catch (e) {
      notifyErr(`Couldn't add the ${meta.label.toLowerCase()}`, e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="po-adj-form" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <div className="po-adj-form-h">
        <span className={`po-adj-dot k-${kind}`} aria-hidden="true" />
        <strong>Add {meta.label.toLowerCase()}</strong>
        <span className="po-hint">{meta.hint}</span>
      </div>
      <div className="po-adj-form-row">
        <label className="ud-field">
          <span>Amount</span>
          <input className="cell-input" type="number" min="0.01" step="0.01"
            inputMode="decimal" autoFocus value={amount} placeholder="0.00"
            onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="ud-field po-adj-note">
          <span>Note</span>
          <input className="cell-input" value={note} maxLength={200}
            placeholder={kind === 'payment' ? 'Check #, card, ACH…' : 'optional'}
            onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      {meta.allocatable && (
        <label className="po-adj-alloc">
          <input type="checkbox" checked={allocate}
            onChange={(e) => setAllocate(e.target.checked)} />
          <span>
            <strong>Spread into landed cost</strong>
            <span className="po-hint">
              {anyReceived
                ? ' Revalues received parts still on hand — you confirm the impact first.'
                : ' Lines will enter stock at their landed cost.'}
            </span>
          </span>
        </label>
      )}
      <div className="po-adj-form-actions">
        <Button variant="ghost" size="sm" onClick={onDone}>Cancel</Button>
        <Button variant="primary" size="sm" type="submit" loading={busy}
          disabled={!valid}>Add {meta.label.toLowerCase()}</Button>
      </div>
    </form>
  )
}

function AdjRow({ po, a, editable, onApply }: {
  po: PurchaseOrder
  a: POAdjustment
  editable: boolean
  onApply: (p: PurchaseOrder, stock?: boolean) => void
}) {
  const meta = ADJ_META[a.kind] ?? ADJ_META.fee
  const [voiding, setVoiding] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  useEscLayer(voiding, () => setVoiding(false))
  const signed = meta.sign * a.amount

  async function doVoid() {
    setBusy(true)
    try {
      // Anular un ajuste asignado re-prorratea el landed cost y revalúa lo
      // recibido en la misma operación (el aviso dice cuánto).
      const res = await voidPoAdjustment(po.id, a.id, reason.trim())
      onApply(res, a.allocate)
      notifyOk(`${meta.label} voided`, revalSummary(res.revaluations))
      setVoiding(false)
    } catch (e) {
      notifyErr("Couldn't void the adjustment", e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className={`po-adj ${a.voided ? 'is-voided' : ''}`}>
      <span className={`po-adj-dot k-${a.kind}`} aria-hidden="true" />
      <span className="po-adj-main">
        <strong>
          {meta.label}
          {a.allocate && !a.voided && <span className="po-adj-tag">In landed cost</span>}
          {a.voided && <span className="po-adj-tag is-void">Voided</span>}
        </strong>
        <span className="po-adj-sub">
          {[a.note, a.actor, stamp(a.created_at)].filter(Boolean).join(' · ')}
          {a.voided && a.void_reason ? ` · void: ${a.void_reason}` : ''}
        </span>
      </span>
      <span className={`po-adj-amt mono ${signed < 0 ? 'is-neg' : ''}`}>
        {signed < 0 ? `−${money(-signed)}` : `+${money(signed)}`}
      </span>
      {editable && !a.voided && !voiding && (
        <button type="button" className="po-mini" onClick={() => setVoiding(true)}>
          Void
        </button>
      )}
      {voiding && (
        <form className="po-void-form"
          onSubmit={(e) => { e.preventDefault(); void doVoid() }}>
          <input className="cell-input" autoFocus value={reason} maxLength={200}
            placeholder="Reason (optional)" aria-label="Void reason"
            onChange={(e) => setReason(e.target.value)} />
          <Button variant="ghost" size="sm" onClick={() => setVoiding(false)}>
            Keep
          </Button>
          <Button variant="primary" size="sm" type="submit" loading={busy}>
            Void
          </Button>
        </form>
      )}
    </li>
  )
}

// ===== History ==============================================================
function HistoryTab({ po }: { po: PurchaseOrder }) {
  const [full, setFull] = useState(false)
  const fullQ = useQuery({
    queryKey: ['purchase-order-audit', po.id, po.updated_at],
    queryFn: () => getPoAudit(po.id),
    enabled: full,
  })
  const events: AuditEvent[] = (full && fullQ.data) ? fullQ.data : (po.audit ?? [])
  const sorted = [...events].sort((a, b) =>
    (b.created_at ?? '').localeCompare(a.created_at ?? '') || b.id - a.id)
  const lineName = (eid: string) => {
    const lid = Number(eid.split(':')[1])
    const ln = (po.lines ?? []).find((l) => l.id === lid)
    return ln ? (ln.part_number || ln.description) : `line ${eid.split(':')[1] ?? ''}`
  }

  if (sorted.length === 0) {
    return (
      <p className="po-none">
        No changes recorded yet. Every edit to this PO — costs, quantities,
        receipts, adjustments, close / reopen — is logged here with who made it.
      </p>
    )
  }
  return (
    <div className="po-stack">
      <ol className="po-audit">
        {sorted.map((e) => (
          <li key={e.id} className={`po-ev a-${e.action}`}>
            <span className="po-ev-when mono">{stamp(e.created_at)}</span>
            <span className="po-ev-text">
              {describe(e, e.entity === 'po_line' ? lineName(e.entity_id) : '')}
            </span>
            <span className="po-ev-who">{e.actor || 'system'}</span>
          </li>
        ))}
      </ol>
      {!full && (po.audit?.length ?? 0) >= 100 && (
        <button type="button" className="link-btn" onClick={() => setFull(true)}>
          Load the full history
        </button>
      )}
      {full && fullQ.isPending && <Skeleton h={40} />}
    </div>
  )
}

const FIELD_LABEL: Record<string, string> = {
  unit_cost: 'unit cost', qty: 'quantity', taxable: 'taxable',
  description: 'description', landed_unit_cost: 'landed cost',
  avg_cost: 'average cost', qty_received: 'received qty', status: 'status',
  fin_status: 'financial status', vendor: 'vendor', vendor_id: 'vendor',
  notes: 'notes', invoice_no: 'invoice #', invoice_date: 'invoice date',
  tracking_no: 'tracking #', payment_method: 'payment method',
  core_qty: 'pending cores',
}

function fmtVal(field: string, v: string): string {
  if (v === '') return '—'
  if (['unit_cost', 'landed_unit_cost', 'avg_cost'].includes(field)) {
    const n = Number(v)
    return Number.isFinite(n) ? money4(n) : v
  }
  return v
}

function describe(e: AuditEvent, line: string): ReactNode {
  const f = FIELD_LABEL[e.field] ?? e.field
  const on = line ? <> on <strong>{line}</strong></> : null
  switch (e.action) {
    case 'create': return <>Created the PO</>
    case 'line_add': return <>Added line <strong>{e.new}</strong></>
    case 'line_delete': return <>Removed line <strong>{e.old}</strong></>
    case 'receive':
      return <>Received{on} ({fmtVal(e.field, e.old)} → {fmtVal(e.field, e.new)})</>
    case 'unreceive':
      return <>Unreceived {fmtVal(e.field, e.old)}{on}</>
    case 'core_void': return <>Voided pending cores{on}</>
    case 'reprice':
      return <>Landed cost{on}: {fmtVal(e.field, e.old)} → {fmtVal(e.field, e.new)}</>
    case 'revalue':
      return <>Revalued inventory{on}: avg {fmtVal('avg_cost', e.old)} → {fmtVal('avg_cost', e.new)}</>
    case 'adjustment_add':
      return <>Added {e.field} <strong>{money(Number(e.new))}</strong></>
    case 'adjustment_void':
      return <>Voided {e.field} {money(Number(e.old))}</>
    case 'close': return <>Closed the PO (financial)</>
    case 'reopen': return <>Reopened the PO (financial)</>
    case 'delete': return <>Deleted the PO</>
    default:
      return <>Changed {f}{on}: {fmtVal(e.field, e.old)} → {fmtVal(e.field, e.new)}</>
  }
}

// ===== Confirm de revaluación ================================================
function RevalueConfirm({ pending, catalog, busy, onCancel, onConfirm }: {
  pending: PendingReval
  catalog: Part[]
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const totalDelta = pending.revals.reduce((s, r) =>
    s + (r.value_delta ?? (r.new_cost - r.old_cost) * r.qty_received), 0)
  return (
    <Modal title={pending.title} onClose={onCancel} width={560}>
      <div className="po-rv">
        <p className="po-rv-lead">
          {pending.action}. These parts were already received, so their
          inventory value changes — no stock moves and the PO stays as it is.
        </p>
        <ul className="po-rv-list">
          {pending.revals.map((r, i) => {
            // Sin datos de catálogo del backend: estimación local.
            const part = catalog.find((p) => p.part_number === r.part_number)
            const onHand = r.on_hand ?? part?.on_hand ?? 0
            const revalued = r.revalued_qty ?? Math.min(r.qty_received, onHand)
            const consumed = r.consumed_qty ?? Math.max(0, r.qty_received - revalued)
            const avgOld = r.avg_old ?? part?.avg_cost ?? null
            const avgNew = r.avg_new ?? (avgOld != null && onHand > 0
              ? avgOld + (r.new_cost - r.old_cost) * revalued / onHand : null)
            return (
              <li key={`${r.part_number}-${i}`} className="po-rv-item">
                <div className="po-rv-top">
                  <strong className="mono">{r.part_number}</strong>
                  <span className="mono">{money4(r.old_cost)} → {money4(r.new_cost)}</span>
                </div>
                {revalued > 0 ? (
                  <p className="po-rv-main">
                    Revalue <strong>{qtyFmt(revalued)}</strong> on-hand unit
                    {revalued === 1 ? '' : 's'}
                    {avgOld != null && avgNew != null && (
                      <> — avg <strong>{money(avgOld)}</strong> → <strong>{money(avgNew)}</strong></>
                    )}
                  </p>
                ) : (
                  <p className="po-rv-main">None of these parts are still on hand.</p>
                )}
                {consumed > 0 && (
                  <p className="po-rv-sub">
                    {qtyFmt(consumed)} already used on work orders — posted as a
                    variance; invoiced work orders are not changed.
                  </p>
                )}
                {r.in_catalog === false && (
                  <p className="po-rv-sub">Not in the parts catalog: only the movement value is recorded.</p>
                )}
              </li>
            )
          })}
        </ul>
        <div className="po-rv-total">
          <span>Inventory value change</span>
          <strong className={`mono ${totalDelta < 0 ? 'is-neg' : ''}`}>
            {totalDelta < 0 ? `−${money(-totalDelta)}` : `+${money(totalDelta)}`}
          </strong>
        </div>
        <div className="sr-form-actions">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={onConfirm}>
            Revalue &amp; save
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function LockOpenIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 7.6-1.8" />
    </svg>
  )
}
