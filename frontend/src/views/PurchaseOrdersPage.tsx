// Purchase Orders / QuickBuy (Increment B). Primera versión: lista de POs,
// crear una PO (vendor + líneas + total), avanzar estado (draft -> ordered
// -> received) y un atajo "QuickBuy" para comprar una parte rápido. Vive como
// pestaña dentro de Parts & Vendors (cerca del catálogo que alimenta las
// líneas). Espeja los patrones de WorkOrdersPage (TanStack Query + Skeleton +
// drawer de detalle + ds Button/Tabs).
import { useMemo, useState } from 'react'
import { Drawer } from 'vaul'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addPoLine, createPurchaseOrder, deletePoLine, deletePurchaseOrder,
  getPurchaseOrder, listParts, listPurchaseOrders, listVendors,
  patchPurchaseOrder,
  type Part, type POLineInput, type POStatus, type PurchaseOrder, type Vendor,
} from '../api'
import { notifyOk, notifyErr } from '../toast'
import { usePerms } from '../perms'
import { Button, Tabs } from '../components/ds'
import Modal from '../components/Modal'
import Skeleton from '../components/Skeleton'
import StatCard from '../components/StatCard'

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const dateOf = (iso: string) => (iso ? iso.slice(0, 10) : '—')

// Pipeline simple; reusa las clases wo-status del design system (ámbar /
// azul / verde) — sin CSS nuevo.
export const PO_PIPELINE: POStatus[] = ['draft', 'ordered', 'received']
const PO_STATUS_META: Record<POStatus, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: 'wo-open' },
  ordered: { label: 'Ordered', cls: 'wo-progress' },
  received: { label: 'Received', cls: 'wo-done' },
}

// Catálogo: busca una parte por número exacto (autollena desc + costo).
function findPart(parts: Part[], pn: string): Part | undefined {
  const k = (pn || '').trim().toLowerCase()
  return k ? parts.find((p) => p.part_number.toLowerCase() === k) : undefined
}

type LineDraft = { part_number: string; description: string; qty: string
                   unit_cost: string }
const emptyLine = (): LineDraft =>
  ({ part_number: '', description: '', qty: '1', unit_cost: '' })

export default function PurchaseOrdersPage({ quickPart }: {
  // QuickBuy desde el catálogo: si viene una parte, abre el modal precargado.
  quickPart?: Part | null
} = {}) {
  const qc = useQueryClient()
  const { can } = usePerms()
  const [statusFilter, setStatusFilter] = useState('')
  const [q, setQ] = useState('')
  const [openPo, setOpenPo] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [quick, setQuick] = useState<Part | null>(quickPart ?? null)

  const listQ = useQuery({
    queryKey: ['purchase-orders', statusFilter],
    queryFn: () => listPurchaseOrders(statusFilter),
  })
  const pos = listQ.data?.purchase_orders ?? []
  const stats = listQ.data?.stats

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return pos
    return pos.filter((p) =>
      p.vendor.toLowerCase().includes(s) ||
      p.notes.toLowerCase().includes(s) ||
      String(p.id) === s)
  }, [pos, q])

  function refresh() {
    qc.invalidateQueries({ queryKey: ['purchase-orders'] })
  }

  return (
    <>
      {listQ.isFetching && <div className="loadbar" aria-hidden="true" />}

      {listQ.isPending ? (
        <div className="kpi-row">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} h={86} />)}
        </div>
      ) : stats && (
        <div className="kpi-row">
          <StatCard label="Draft" value={stats.draft}
            tone={stats.draft ? 'warn' : 'default'} />
          <StatCard label="Ordered" value={stats.ordered} tone="info" />
          <StatCard label="Received" value={stats.received} tone="ok" />
          <StatCard label="Open value" value={money(stats.open_value)}
            tone="accent" />
        </div>
      )}

      <div className="card">
        <div className="card-body filters-row">
          <Tabs
            tabs={[{ id: '', label: 'All' },
              ...PO_PIPELINE.map((s) => ({ id: s,
                label: PO_STATUS_META[s].label }))]}
            value={statusFilter}
            onChange={(id) => setStatusFilter(id as typeof statusFilter)}
          />
          <span className="head-spacer" />
          <input className="cell-input" placeholder="Vendor, PO#…"
            value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Purchase orders</h2>
          <span className="head-spacer" />
          {can('maint.edit') && (
            <Button variant="primary" onClick={() => setCreating(true)}
              icon={
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" width="16" height="16" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              }>
              New PO
            </Button>
          )}
        </div>
        <div className="card-body">
          {listQ.error && (
            <div className="banner error">
              <span>{String(listQ.error)}</span>
            </div>
          )}
          {listQ.isPending ? (
            <div className="skel-rows">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} h={38} />)}
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty mini">
              <p>
                No purchase orders{statusFilter ? ' in this status' : ' yet'}.
                Create one here, or use QuickBuy from the Parts catalog.
              </p>
              {can('maint.edit') && (
                <button className="btn btn-primary"
                  onClick={() => setCreating(true)}>
                  Create the first PO
                </button>
              )}
            </div>
          ) : (
            <div className="table-wrap">
              <table className="defects-table wo-table">
                <thead>
                  <tr>
                    <th>PO#</th>
                    <th>Vendor</th>
                    <th className="num">Lines</th>
                    <th>Status</th>
                    <th className="num">Total</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p) => (
                    <tr key={p.id} onClick={() => setOpenPo(p.id)}>
                      <td className="mono">#{p.id}</td>
                      <td><strong>{p.vendor
                        || <span className="muted">—</span>}</strong></td>
                      <td className="num">{p.n_lines}</td>
                      <td>
                        <span className={`wo-status ${PO_STATUS_META[p.status].cls}`}>
                          {PO_STATUS_META[p.status].label}
                        </span>
                      </td>
                      <td className="num mono">
                        {p.total ? money(p.total) : '—'}
                      </td>
                      <td className="muted">{dateOf(p.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {creating && (
        <CreatePoModal
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); refresh(); setOpenPo(id) }} />
      )}

      {quick && (
        <CreatePoModal quickPart={quick}
          onClose={() => setQuick(null)}
          onCreated={(id) => { setQuick(null); refresh(); setOpenPo(id) }} />
      )}

      <PoDrawer poId={openPo}
        onClose={() => { setOpenPo(null); refresh() }} />
    </>
  )
}

// ----- Quick action: QuickBuy una parte (botón reutilizable) ---------------
// Lo usa el catálogo de Parts: un clic abre el modal de PO con la parte ya
// cargada como línea. Export para que PartsPage lo monte por fila.
export function QuickBuyButton({ part, onBought }: {
  part: Part
  onBought?: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="btn btn-ghost btn-xs" title={`QuickBuy ${part.part_number}`}
        onClick={(e) => { e.stopPropagation(); setOpen(true) }}>
        QuickBuy
      </button>
      {open && (
        <CreatePoModal quickPart={part}
          onClose={() => setOpen(false)}
          onCreated={() => { setOpen(false); onBought?.() }} />
      )}
    </>
  )
}

// ----- Modal de creación (vendor + líneas + total) -------------------------
// Exportado: el panel de Marketplace lo reusa para mandar un resultado de
// búsqueda a una PO (arma un `Part` sintético con los datos de la oferta).
export function CreatePoModal({ quickPart, onClose, onCreated }: {
  quickPart?: Part | null
  onClose: () => void
  onCreated: (id: number) => void
}) {
  const partsQ = useQuery({ queryKey: ['parts'], queryFn: listParts })
  const vendorsQ = useQuery({ queryKey: ['vendors'], queryFn: listVendors })
  const catalog = partsQ.data?.parts ?? []
  const vendors: Vendor[] = vendorsQ.data ?? []

  // QuickBuy: prefijar vendor (el de la parte) + una línea con la parte.
  const [vendor, setVendor] = useState(quickPart
    ? (quickPart.vendor_name || '') : '')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<LineDraft[]>(() =>
    quickPart
      ? [{ part_number: quickPart.part_number,
           description: quickPart.description || quickPart.part_number,
           qty: '1', unit_cost: String(quickPart.cost || 0) }]
      : [emptyLine()])
  const [saving, setSaving] = useState(false)

  function setLine(i: number, patch: Partial<LineDraft>) {
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  }
  function setLinePart(i: number, pn: string) {
    const hit = findPart(catalog, pn)
    setLines((ls) => ls.map((l, j) => (j === i ? {
      ...l, part_number: pn,
      ...(hit ? { description: l.description || hit.description,
                  unit_cost: String(hit.cost) } : {}),
    } : l)))
  }
  function addLine() { setLines((ls) => [...ls, emptyLine()]) }
  function removeLine(i: number) {
    setLines((ls) => ls.filter((_, j) => j !== i))
  }

  const total = lines.reduce(
    (s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_cost) || 0), 0)

  async function submit() {
    const kept = lines
      .filter((l) => l.description.trim() || l.part_number.trim())
      .map((l) => ({
        part_number: l.part_number.trim(),
        description: l.description.trim(),
        qty: Number(l.qty) || 1,
        unit_cost: Number(l.unit_cost) || 0,
      } satisfies POLineInput))
    if (!vendor.trim() && !kept.length) {
      notifyErr('Empty PO', 'Add a vendor or at least one line')
      return
    }
    setSaving(true)
    try {
      const po = await createPurchaseOrder({
        vendor: vendor.trim(), notes: notes.trim(), lines: kept,
      })
      notifyOk('Purchase order created',
        `#${po.id}${po.vendor ? ` · ${po.vendor}` : ''}`
        + (kept.length ? ` · ${kept.length} line${kept.length === 1 ? '' : 's'}`
          : ''))
      onCreated(po.id)
    } catch (e) {
      notifyErr('Could not create PO', e)
      setSaving(false)
    }
  }

  return (
    <Modal title={quickPart ? `QuickBuy ${quickPart.part_number}` : 'New purchase order'}
      width={720} onClose={onClose}>
      <div className="wo-form">
        <label className="ud-field">
          <span>Vendor</span>
          <input className="cell-input" list="po-vendors" autoFocus
            value={vendor} placeholder="FleetPride"
            onChange={(e) => setVendor(e.target.value)} />
          <datalist id="po-vendors">
            {vendors.map((v) => <option key={v.id} value={v.name} />)}
          </datalist>
        </label>

        <div className="wo-lines-edit">
          <div className="wo-lines-edit-head">
            <span>Lines</span>
            <button className="btn btn-ghost btn-xs" onClick={addLine}>
              + Add line
            </button>
          </div>
          {lines.map((ln, i) => (
            <div key={i} className="wo-line-row po-line-row">
              <input className="cell-input" list="po-catalog-parts"
                title="Part number (catalog)" placeholder="Part #"
                value={ln.part_number}
                onChange={(e) => setLinePart(i, e.target.value)} />
              <input className="cell-input" value={ln.description}
                placeholder="Description"
                onChange={(e) => setLine(i, { description: e.target.value })} />
              <input className="cell-input" type="number" min="0"
                title="Quantity" value={ln.qty}
                onChange={(e) => setLine(i, { qty: e.target.value })} />
              <input className="cell-input" type="number" min="0"
                step="0.01" title="Unit cost" value={ln.unit_cost}
                placeholder="0.00"
                onChange={(e) => setLine(i, { unit_cost: e.target.value })} />
              <button className="mnt-icon" title="Remove line"
                onClick={() => removeLine(i)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.8" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          ))}
          <datalist id="po-catalog-parts">
            {catalog.map((p) => (
              <option key={p.id} value={p.part_number}>{p.description}</option>
            ))}
          </datalist>
          <span className="wo-scan-total">Total · {money(total)}</span>
        </div>

        <label className="ud-field">
          <span>Notes</span>
          <input className="cell-input" value={notes}
            placeholder="optional"
            onChange={(e) => setNotes(e.target.value)} />
        </label>

        <div className="settings-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Creating…' : 'Create PO'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ----- Drawer de detalle (estado + líneas) ---------------------------------
function PoDrawer({ poId, onClose }: {
  poId: number | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const { can } = usePerms()
  const editable = can('maint.edit')
  const open = poId != null
  const poQ = useQuery({
    queryKey: ['purchase-order', poId],
    queryFn: () => getPurchaseOrder(poId!),
    enabled: open,
  })
  const po = poQ.data ?? null
  const partsQ = useQuery({ queryKey: ['parts'], queryFn: listParts })
  const catalog = partsQ.data?.parts ?? []

  const [linePart, setLinePart] = useState('')
  const [lineDesc, setLineDesc] = useState('')
  const [lineQty, setLineQty] = useState('1')
  const [lineCost, setLineCost] = useState('')
  const [busy, setBusy] = useState(false)

  function refreshPo(updated: PurchaseOrder) {
    qc.setQueryData(['purchase-order', updated.id], updated)
    qc.invalidateQueries({ queryKey: ['purchase-orders'] })
  }

  function pickPart(pn: string) {
    setLinePart(pn)
    const hit = findPart(catalog, pn)
    if (hit) {
      if (!lineDesc.trim()) setLineDesc(hit.description)
      setLineCost(String(hit.cost))
    }
  }

  async function setStatus(s: POStatus) {
    if (!po) return
    setBusy(true)
    try {
      refreshPo(await patchPurchaseOrder(po.id, { status: s }))
      notifyOk(`PO #${po.id}: ${PO_STATUS_META[s].label}`)
    } catch (e) {
      notifyErr('Could not change status', e)
    } finally {
      setBusy(false)
    }
  }

  async function addLine() {
    if (!po || (!lineDesc.trim() && !linePart.trim())) return
    setBusy(true)
    try {
      refreshPo(await addPoLine(po.id, {
        part_number: linePart.trim(), description: lineDesc.trim(),
        qty: Number(lineQty) || 1, unit_cost: Number(lineCost) || 0,
      }))
      setLinePart(''); setLineDesc(''); setLineQty('1'); setLineCost('')
    } catch (e) {
      notifyErr('Could not add line', e)
    } finally {
      setBusy(false)
    }
  }

  async function removeLine(lineId: number) {
    if (!po) return
    try {
      refreshPo(await deletePoLine(po.id, lineId))
    } catch (e) {
      notifyErr('Could not delete line', e)
    }
  }

  async function saveField(patch: { vendor?: string; notes?: string }) {
    if (!po) return
    try {
      refreshPo(await patchPurchaseOrder(po.id, patch))
    } catch (e) {
      notifyErr('Could not save', e)
    }
  }

  async function removePo() {
    if (!po) return
    if (!window.confirm(`Delete PO #${po.id}?`)) return
    try {
      await deletePurchaseOrder(po.id)
      qc.invalidateQueries({ queryKey: ['purchase-orders'] })
      notifyOk('Purchase order deleted', `#${po.id}`)
      onClose()
    } catch (e) {
      notifyErr('Could not delete PO', e)
    }
  }

  return (
    <Drawer.Root direction="right" open={open}
      onOpenChange={(o) => { if (!o) onClose() }}>
      <Drawer.Portal>
        <Drawer.Overlay className="ud-overlay" />
        <Drawer.Content className="ud-content wo-drawer">
          {po && (
            <>
              <div className="ud-head">
                <div>
                  <Drawer.Title className="ud-title">
                    PO #{po.id}
                  </Drawer.Title>
                  <span className="ud-chiprow">
                    <span className={`wo-status ${PO_STATUS_META[po.status].cls}`}>
                      {PO_STATUS_META[po.status].label}
                    </span>
                  </span>
                </div>
                <button className="icon-btn" onClick={onClose}
                  aria-label="Close">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
              <Drawer.Description className="sr-only">
                Purchase order {po.id} details
              </Drawer.Description>

              <div className="ud-body">
                {/* Avance de estado (draft -> ordered -> received) */}
                <div className="po-stage-row" style={{ display: 'flex', gap: 8,
                  flexWrap: 'wrap', marginBottom: 14 }}>
                  {PO_PIPELINE.map((s) => (
                    <button key={s}
                      className={`btn btn-xs ${po.status === s
                        ? 'btn-primary' : 'btn-ghost'}`}
                      disabled={!editable || busy || po.status === s}
                      onClick={() => setStatus(s)}>
                      {PO_STATUS_META[s].label}
                    </button>
                  ))}
                </div>

                <section className="ud-sec" key={po.id}>
                  <label className="ud-field">
                    <span>Vendor</span>
                    <input className="cell-input" defaultValue={po.vendor}
                      placeholder="Vendor name" disabled={!editable}
                      onBlur={(e) => {
                        if (e.target.value !== po.vendor) {
                          saveField({ vendor: e.target.value })
                        }
                      }} />
                  </label>
                  <label className="ud-field">
                    <span>Notes</span>
                    <textarea className="cell-input ud-notes" rows={2}
                      defaultValue={po.notes} placeholder="optional"
                      disabled={!editable}
                      onBlur={(e) => {
                        if (e.target.value !== po.notes) {
                          saveField({ notes: e.target.value })
                        }
                      }} />
                  </label>
                </section>

                <section className="ud-sec">
                  <h3>Lines</h3>
                  {po.lines && po.lines.length > 0 ? (
                    <div className="table-wrap">
                      <table className="defects-table">
                        <thead>
                          <tr>
                            <th>Part #</th>
                            <th>Description</th>
                            <th className="num">Qty</th>
                            <th className="num">Unit</th>
                            <th className="num">Total</th>
                            {editable && <th aria-label="Actions" />}
                          </tr>
                        </thead>
                        <tbody>
                          {po.lines.map((ln) => (
                            <tr key={ln.id}>
                              <td className="mono">{ln.part_number
                                || <span className="muted">—</span>}</td>
                              <td>{ln.description}</td>
                              <td className="num">{ln.qty}</td>
                              <td className="num mono">{money(ln.unit_cost)}</td>
                              <td className="num mono">{money(ln.total)}</td>
                              {editable && (
                                <td className="num">
                                  <button className="icon-x" title="Remove line"
                                    onClick={() => removeLine(ln.id)}>✕</button>
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="muted">No lines yet.</p>
                  )}

                  <div className="wo-total-row" style={{ display: 'flex',
                    justifyContent: 'flex-end', fontWeight: 700,
                    margin: '8px 2px' }}>
                    Total&nbsp;<span className="mono">{money(po.total)}</span>
                  </div>

                  {editable && (
                    <div className="wo-line-row po-line-row"
                      style={{ marginTop: 10 }}>
                      <input className="cell-input" list="po-drawer-parts"
                        title="Part number" placeholder="Part #"
                        value={linePart}
                        onChange={(e) => pickPart(e.target.value)} />
                      <input className="cell-input" value={lineDesc}
                        placeholder="Description"
                        onChange={(e) => setLineDesc(e.target.value)} />
                      <input className="cell-input" type="number"
                        min="0" title="Quantity" value={lineQty}
                        onChange={(e) => setLineQty(e.target.value)} />
                      <input className="cell-input" type="number"
                        min="0" step="0.01" title="Unit cost" value={lineCost}
                        placeholder="0.00"
                        onChange={(e) => setLineCost(e.target.value)} />
                      <button className="btn btn-primary btn-xs"
                        disabled={busy} onClick={addLine}>Add</button>
                      <datalist id="po-drawer-parts">
                        {catalog.map((p) => (
                          <option key={p.id} value={p.part_number}>
                            {p.description}
                          </option>
                        ))}
                      </datalist>
                    </div>
                  )}
                </section>

                {editable && (
                  <div className="settings-actions" style={{ marginTop: 18 }}>
                    <button className="btn btn-ghost" onClick={removePo}>
                      Delete PO
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
