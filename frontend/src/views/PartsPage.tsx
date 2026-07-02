// Catálogo de Partes + Vendors (fase H3, estilo Fullbay). Dos pestañas:
// Parts (catálogo con costo interno, vendor, inventario manual) y Vendors
// (proveedores). Se reusan al cargar líneas de una work order.
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  adjustPartStock, deletePart, deleteVendor, listPartMovements,
  listParts, listVendors, savePart, saveVendor,
  type Part, type PartInput, type StockMovement, type Vendor,
  type VendorInput,
} from '../api'
import { notifyOk, notifyErr } from '../toast'
import { Button, Tabs } from '../components/ds'
import Modal from '../components/Modal'
import Skeleton from '../components/Skeleton'
import StatCard from '../components/StatCard'
import { StatCluster } from '../components/ds'
import PurchaseOrdersPage, { QuickBuyButton } from './PurchaseOrdersPage'
import MarketplacePanel from './MarketplacePanel'

// ¿La parte está en/bajo su punto de reorden? (solo cuenta si reorder_point > 0)
function isLow(p: { on_hand: number; reorder_point: number }): boolean {
  return p.reorder_point > 0 && p.on_hand <= p.reorder_point
}

const fmtDate = (iso: string) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—')
const STOCK_REASON_LABEL: Record<string, string> = {
  po_receive: 'PO received',
  wo_consume: 'WO consumed',
  manual: 'Manual',
}

type Tab = 'parts' | 'vendors' | 'pos' | 'marketplace'

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export default function PartsPage() {
  const [tab, setTab] = useState<Tab>('parts')

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <h1>Parts &amp; Vendors</h1>
          <p className="page-sub">
            Shop catalog: parts with internal cost, the vendors you buy them
            from, purchase orders, and a marketplace search. Reused when
            building work orders.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-body filters-row">
          <Tabs
            tabs={[{ id: 'parts', label: 'Parts' },
              { id: 'vendors', label: 'Vendors' },
              { id: 'pos', label: 'Purchase Orders' },
              { id: 'marketplace', label: 'Marketplace' }]}
            value={tab}
            onChange={(id) => setTab(id as Tab)}
          />
        </div>
      </div>

      {tab === 'parts' && <PartsTab />}
      {tab === 'vendors' && <VendorsTab />}
      {tab === 'pos' && <PurchaseOrdersPage />}
      {tab === 'marketplace' && <MarketplacePanel />}
    </div>
  )
}

// ----- Pestaña Parts -------------------------------------------------------
function PartsTab() {
  const qc = useQueryClient()
  const partsQ = useQuery({ queryKey: ['parts'], queryFn: listParts })
  const vendorsQ = useQuery({ queryKey: ['vendors'], queryFn: listVendors })
  const [q, setQ] = useState('')
  const [lowOnly, setLowOnly] = useState(false)   // segmento "solo bajo stock"
  const [editing, setEditing] = useState<Part | null>(null)
  const [adding, setAdding] = useState(false)
  const [adjusting, setAdjusting] = useState<Part | null>(null)

  const parts = partsQ.data?.parts ?? []
  const usage = partsQ.data?.usage ?? {}
  const vendors = vendorsQ.data ?? []

  const lowCount = useMemo(() => parts.filter(isLow).length, [parts])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    let rows = parts
    if (lowOnly) rows = rows.filter(isLow)
    if (!s) return rows
    return rows.filter((p) =>
      p.part_number.toLowerCase().includes(s) ||
      p.description.toLowerCase().includes(s) ||
      p.category.toLowerCase().includes(s) ||
      p.vendor_name.toLowerCase().includes(s))
  }, [parts, q, lowOnly])

  const totalValue = useMemo(
    () => parts.reduce((s, p) => s + p.cost * (p.on_hand || 0), 0), [parts])

  // Refresca el catálogo: on_hand/reorder y, derivado de ahí, el KPI de bajo
  // stock y el filtro se recalculan solos (invalidación → refetch de 'parts').
  function refreshInventory() {
    qc.invalidateQueries({ queryKey: ['parts'] })
  }

  async function remove(p: Part) {
    if (!window.confirm(`Delete part ${p.part_number}?`)) return
    try {
      await deletePart(p.id)
      qc.invalidateQueries({ queryKey: ['parts'] })
      notifyOk('Part deleted', p.part_number)
    } catch (e) {
      notifyErr("Couldn't delete part", e)
    }
  }

  return (
    <>
      {partsQ.isFetching && <div className="loadbar" aria-hidden="true" />}
      <StatCluster className="kpi-row">
        <StatCard label="Parts" value={parts.length} tone="info" />
        <StatCard label="Categories"
          value={(partsQ.data?.categories ?? []).length} tone="default" />
        <StatCard label="Inventory value" value={money(totalValue)}
          tone="accent" />
        {/* KPI de bajo stock: clic = filtra el catálogo a esas partes. */}
        <button type="button"
          className={`kpi-card-btn${lowOnly ? ' is-active' : ''}`}
          onClick={() => setLowOnly((v) => !v)}
          title={lowCount
            ? 'Show only parts at/under reorder point'
            : 'No parts under reorder point'}>
          <StatCard label="Low stock" value={lowCount}
            sub={lowOnly ? 'filter on · click to clear'
              : lowCount ? 'click to filter' : 'all stocked'}
            tone={lowCount ? 'warn' : 'ok'} />
        </button>
      </StatCluster>

      <section className="card">
        <div className="card-head">
          <h2>Parts catalog</h2>
          {lowOnly && (
            <button type="button" className="low-filter-chip"
              onClick={() => setLowOnly(false)}
              title="Clear low-stock filter">
              Low stock only · clear ✕
            </button>
          )}
          <span className="head-spacer" />
          <input className="cell-input" placeholder="Search part, vendor…"
            value={q} onChange={(e) => setQ(e.target.value)} />
          <Button variant="primary" onClick={() => setAdding(true)}
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" width="16" height="16" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            }>
            Add part
          </Button>
        </div>
        <div className="card-body">
          {partsQ.isPending ? (
            <div className="skel-rows">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} h={36} />)}
            </div>
          ) : parts.length === 0 ? (
            <div className="empty mini">
              <p>No parts yet. Add the parts you stock or buy often.</p>
              <button className="btn btn-primary" onClick={() => setAdding(true)}>
                Add the first part
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty mini">
              <p>
                {lowOnly
                  ? 'No parts are at or under their reorder point. Nice — fully stocked.'
                  : 'No parts match your search.'}
              </p>
              {lowOnly && (
                <button className="btn btn-ghost" onClick={() => setLowOnly(false)}>
                  Show all parts
                </button>
              )}
            </div>
          ) : (
            <div className="table-wrap">
              <table className="defects-table">
                <thead>
                  <tr>
                    <th>Part #</th>
                    <th>Description</th>
                    <th>Category</th>
                    <th className="num">Cost</th>
                    <th>Vendor</th>
                    <th className="num">On hand</th>
                    <th className="num">Reorder</th>
                    <th className="num">Used</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p) => {
                    const low = isLow(p)
                    return (
                    <tr key={p.id} className={low ? 'row-low' : undefined}
                      onClick={() => setEditing(p)}>
                      <td className="mono"><strong>{p.part_number}</strong></td>
                      <td>{p.description || <span className="muted">—</span>}</td>
                      <td>{p.category
                        ? <span className="intg-chip">{p.category}</span>
                        : <span className="muted">—</span>}</td>
                      <td className="num mono">{money(p.cost)}</td>
                      <td>{p.vendor_name || <span className="muted">—</span>}</td>
                      <td className="num">
                        <span className="oh-cell">
                          {p.on_hand || 0}
                          {low && <span className="low-pill">Low</span>}
                        </span>
                      </td>
                      <td className="num">
                        {p.reorder_point > 0
                          ? p.reorder_point
                          : <span className="muted">—</span>}
                      </td>
                      <td className="num">
                        {usage[p.part_number]
                          ? <span className="wo-pm-tag">{usage[p.part_number]}×</span>
                          : <span className="muted">—</span>}
                      </td>
                      <td className="num parts-row-actions"
                        onClick={(e) => e.stopPropagation()}>
                        <button className="btn btn-ghost btn-xs"
                          title={`Adjust stock for ${p.part_number}`}
                          onClick={() => setAdjusting(p)}>
                          Adjust
                        </button>
                        <QuickBuyButton part={p}
                          onBought={() => {
                            qc.invalidateQueries({ queryKey: ['purchase-orders'] })
                            refreshInventory()
                          }} />
                        <button className="icon-x" title="Delete part"
                          onClick={() => remove(p)}>✕</button>
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {(adding || editing) && (
        <PartModal part={editing} vendors={vendors}
          categories={partsQ.data?.categories ?? []}
          onClose={() => { setAdding(false); setEditing(null) }}
          onSaved={() => {
            setAdding(false); setEditing(null)
            refreshInventory()
          }} />
      )}

      {adjusting && (
        <AdjustStockModal part={adjusting}
          onClose={() => setAdjusting(null)}
          onAdjusted={refreshInventory} />
      )}
    </>
  )
}

// ----- Ajuste manual de stock + bitácora ----------------------------------
// Modal por parte: aplica un delta (+/-) con nota y muestra los movimientos
// recientes (auditoría). El refresh es por invalidación de query (optimista
// vía refetch), siguiendo el patrón TanStack del resto de la página.
function AdjustStockModal({ part, onClose, onAdjusted }: {
  part: Part
  onClose: () => void
  onAdjusted: () => void
}) {
  const [delta, setDelta] = useState('')
  const [note, setNote] = useState('')
  const [onHand, setOnHand] = useState(part.on_hand || 0)
  const [saving, setSaving] = useState(false)

  // Bitácora de movimientos (más reciente primero).
  const movesQ = useQuery({
    queryKey: ['part-movements', part.part_number],
    queryFn: () => listPartMovements(part.part_number),
  })
  const moves: StockMovement[] = movesQ.data ?? []

  // Resultado previsto del ajuste (para mostrar "→ N" antes de aplicar).
  const d = Number(delta)
  const preview = Number.isFinite(d) && delta.trim() !== '' ? onHand + d : null

  async function apply(sign: 1 | -1) {
    const mag = Math.abs(Number(delta))
    if (!mag || !Number.isFinite(mag)) {
      notifyErr('Enter a quantity', 'Type how many units to add or remove')
      return
    }
    setSaving(true)
    try {
      const res = await adjustPartStock(part.part_number, sign * mag, note.trim())
      setOnHand(res.on_hand)
      setDelta(''); setNote('')
      notifyOk('Stock adjusted',
        `${part.part_number} · ${sign > 0 ? '+' : '−'}${mag} → ${res.on_hand}`)
      onAdjusted()
      movesQ.refetch()
    } catch (e) {
      notifyErr("Couldn't adjust stock", e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`Adjust stock · ${part.part_number}`} width={560}
      onClose={onClose}>
      <div className="wo-form">
        <div className="adj-onhand">
          <span className="adj-onhand-label">On hand</span>
          <span className="adj-onhand-val mono">{onHand}</span>
          {part.reorder_point > 0 && (
            <span className="adj-onhand-ro">
              reorder at {part.reorder_point}
              {isLow({ on_hand: onHand, reorder_point: part.reorder_point }) &&
                <span className="low-pill">Low</span>}
            </span>
          )}
        </div>

        <div className="wo-form-row">
          <label className="ud-field">
            <span>Quantity</span>
            <input className="cell-input" type="number" min="0" step="1"
              autoFocus value={delta} placeholder="e.g. 5"
              onChange={(e) => setDelta(e.target.value)} />
          </label>
          <label className="ud-field">
            <span>New on hand</span>
            <input className="cell-input" value={preview ?? onHand} disabled
              title="Preview of on hand after a +quantity adjust" />
          </label>
        </div>
        <label className="ud-field">
          <span>Note (optional)</span>
          <input className="cell-input" value={note}
            placeholder="Cycle count, found in bin, damaged…"
            onChange={(e) => setNote(e.target.value)} />
        </label>

        <div className="adj-actions">
          <button className="btn btn-ghost" onClick={() => apply(-1)}
            disabled={saving} title="Remove from stock">− Remove</button>
          <button className="btn btn-primary" onClick={() => apply(1)}
            disabled={saving} title="Add to stock">+ Add</button>
        </div>

        <section className="ud-sec adj-log">
          <h3>Recent movements</h3>
          {movesQ.isPending ? (
            <div className="skel-rows">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} h={28} />)}
            </div>
          ) : moves.length === 0 ? (
            <p className="muted">No movements yet for this part.</p>
          ) : (
            <div className="table-wrap adj-log-wrap">
              <table className="defects-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Reason</th>
                    <th className="num">Δ</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {moves.map((m) => (
                    <tr key={m.id}>
                      <td className="muted mono">{fmtDate(m.created_at)}</td>
                      <td>
                        <span className="intg-chip">
                          {STOCK_REASON_LABEL[m.reason] ?? m.reason}
                        </span>
                      </td>
                      <td className={`num mono adj-delta ${
                        m.delta < 0 ? 'is-neg' : 'is-pos'}`}>
                        {m.delta > 0 ? `+${m.delta}` : m.delta}
                      </td>
                      <td>{m.note || <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="settings-actions">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </Modal>
  )
}

function PartModal({ part, vendors, categories, onClose, onSaved }: {
  part: Part | null
  vendors: Vendor[]
  categories: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const [f, setF] = useState<PartInput & { id?: number }>(() => ({
    id: part?.id,
    part_number: part?.part_number ?? '',
    description: part?.description ?? '',
    category: part?.category ?? '',
    cost: part?.cost ?? 0,
    vendor_id: part?.vendor_id ?? null,
    on_hand: part?.on_hand ?? 0,
    reorder_point: part?.reorder_point ?? 0,
    notes: part?.notes ?? '',
  }))
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch })

  async function submit() {
    if (!String(f.part_number ?? '').trim()) {
      notifyErr('Missing part number', 'A part number is required')
      return
    }
    setSaving(true)
    try {
      await savePart(f)
      notifyOk(part ? 'Part updated' : 'Part added', f.part_number)
      onSaved()
    } catch (e) {
      notifyErr("Couldn't save part", e)
      setSaving(false)
    }
  }

  return (
    <Modal title={part ? `Edit ${part.part_number}` : 'Add part'} width={520}
      onClose={onClose}>
      <div className="wo-form">
        <div className="wo-form-row">
          <label className="ud-field">
            <span>Part number</span>
            <input className="cell-input" autoFocus value={f.part_number ?? ''}
              placeholder="BRK-100"
              onChange={(e) => set({ part_number: e.target.value })} />
          </label>
          <label className="ud-field">
            <span>Category</span>
            <input className="cell-input" list="part-cats" value={f.category ?? ''}
              placeholder="Brakes" onChange={(e) => set({ category: e.target.value })} />
            <datalist id="part-cats">
              {categories.map((c) => <option key={c} value={c} />)}
            </datalist>
          </label>
        </div>
        <label className="ud-field">
          <span>Description</span>
          <input className="cell-input" value={f.description ?? ''}
            placeholder="Brake pad set, steer axle"
            onChange={(e) => set({ description: e.target.value })} />
        </label>
        <div className="wo-form-row">
          <label className="ud-field">
            <span>Cost (internal)</span>
            <input className="cell-input" type="number" step="0.01"
              value={f.cost ?? 0}
              onChange={(e) => set({ cost: Number(e.target.value) })} />
          </label>
          <label className="ud-field">
            <span>On hand</span>
            <input className="cell-input" type="number"
              value={f.on_hand ?? 0}
              onChange={(e) => set({ on_hand: Number(e.target.value) })} />
          </label>
        </div>
        <label className="ud-field">
          <span>Reorder point</span>
          <input className="cell-input" type="number" min="0"
            value={f.reorder_point ?? 0}
            placeholder="0 = no low-stock alert"
            onChange={(e) => set({ reorder_point: Number(e.target.value) })} />
          <small className="field-hint">
            Flags this part as <strong>Low</strong> when on hand drops to or
            below this number. Leave 0 to disable the alert.
          </small>
        </label>
        <label className="ud-field">
          <span>Vendor</span>
          <select className="cell-input" value={f.vendor_id ?? ''}
            onChange={(e) => set({
              vendor_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">— none —</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </label>
        <label className="ud-field">
          <span>Notes</span>
          <input className="cell-input" value={f.notes ?? ''}
            onChange={(e) => set({ notes: e.target.value })} />
        </label>
        <div className="settings-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : part ? 'Save part' : 'Add part'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ----- Pestaña Vendors -----------------------------------------------------
function VendorsTab() {
  const qc = useQueryClient()
  const vendorsQ = useQuery({ queryKey: ['vendors'], queryFn: listVendors })
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<Vendor | null>(null)
  const [adding, setAdding] = useState(false)
  const vendors = vendorsQ.data ?? []

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return vendors
    return vendors.filter((v) =>
      v.name.toLowerCase().includes(s) ||
      v.contact.toLowerCase().includes(s) ||
      v.phone.toLowerCase().includes(s))
  }, [vendors, q])

  async function remove(v: Vendor) {
    if (!window.confirm(
      `Delete vendor ${v.name}?` +
      (v.parts_count ? ` ${v.parts_count} part(s) will keep no vendor.` : ''))) return
    try {
      await deleteVendor(v.id)
      qc.invalidateQueries({ queryKey: ['vendors'] })
      qc.invalidateQueries({ queryKey: ['parts'] })
      notifyOk('Vendor deleted', v.name)
    } catch (e) {
      notifyErr("Couldn't delete vendor", e)
    }
  }

  return (
    <>
      {vendorsQ.isFetching && <div className="loadbar" aria-hidden="true" />}
      <section className="card">
        <div className="card-head">
          <h2>Vendors</h2>
          <span className="head-spacer" />
          <input className="cell-input" placeholder="Search vendor…"
            value={q} onChange={(e) => setQ(e.target.value)} />
          <Button variant="primary" onClick={() => setAdding(true)}
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" width="16" height="16" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            }>
            Add vendor
          </Button>
        </div>
        <div className="card-body">
          {vendorsQ.isPending ? (
            <div className="skel-rows">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} h={36} />)}
            </div>
          ) : vendors.length === 0 ? (
            <div className="empty mini">
              <p>No vendors yet. Add the shops and suppliers you buy from.</p>
              <button className="btn btn-primary" onClick={() => setAdding(true)}>
                Add the first vendor
              </button>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="defects-table">
                <thead>
                  <tr>
                    <th>Vendor</th>
                    <th>Contact</th>
                    <th>Phone</th>
                    <th>Email</th>
                    <th className="num">Parts</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((v) => (
                    <tr key={v.id} onClick={() => setEditing(v)}>
                      <td><strong>{v.name}</strong></td>
                      <td>{v.contact || <span className="muted">—</span>}</td>
                      <td>{v.phone || <span className="muted">—</span>}</td>
                      <td>{v.email || <span className="muted">—</span>}</td>
                      <td className="num">{v.parts_count || 0}</td>
                      <td className="num" onClick={(e) => e.stopPropagation()}>
                        <button className="icon-x" title="Delete vendor"
                          onClick={() => remove(v)}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {(adding || editing) && (
        <VendorModal vendor={editing}
          onClose={() => { setAdding(false); setEditing(null) }}
          onSaved={() => {
            setAdding(false); setEditing(null)
            qc.invalidateQueries({ queryKey: ['vendors'] })
          }} />
      )}
    </>
  )
}

function VendorModal({ vendor, onClose, onSaved }: {
  vendor: Vendor | null
  onClose: () => void
  onSaved: () => void
}) {
  const [f, setF] = useState<VendorInput & { id?: number }>(() => ({
    id: vendor?.id,
    name: vendor?.name ?? '',
    contact: vendor?.contact ?? '',
    phone: vendor?.phone ?? '',
    email: vendor?.email ?? '',
    address: vendor?.address ?? '',
    account: vendor?.account ?? '',
    notes: vendor?.notes ?? '',
  }))
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch })

  async function submit() {
    if (!String(f.name ?? '').trim()) {
      notifyErr('Missing name', 'A vendor name is required')
      return
    }
    setSaving(true)
    try {
      await saveVendor(f)
      notifyOk(vendor ? 'Vendor updated' : 'Vendor added', f.name)
      onSaved()
    } catch (e) {
      notifyErr("Couldn't save vendor", e)
      setSaving(false)
    }
  }

  return (
    <Modal title={vendor ? `Edit ${vendor.name}` : 'Add vendor'} width={520}
      onClose={onClose}>
      <div className="wo-form">
        <label className="ud-field">
          <span>Name</span>
          <input className="cell-input" autoFocus value={f.name ?? ''}
            placeholder="FleetPride" onChange={(e) => set({ name: e.target.value })} />
        </label>
        <div className="wo-form-row">
          <label className="ud-field">
            <span>Contact</span>
            <input className="cell-input" value={f.contact ?? ''}
              onChange={(e) => set({ contact: e.target.value })} />
          </label>
          <label className="ud-field">
            <span>Account #</span>
            <input className="cell-input" value={f.account ?? ''}
              onChange={(e) => set({ account: e.target.value })} />
          </label>
        </div>
        <div className="wo-form-row">
          <label className="ud-field">
            <span>Phone</span>
            <input className="cell-input" value={f.phone ?? ''}
              onChange={(e) => set({ phone: e.target.value })} />
          </label>
          <label className="ud-field">
            <span>Email</span>
            <input className="cell-input" type="email" value={f.email ?? ''}
              onChange={(e) => set({ email: e.target.value })} />
          </label>
        </div>
        <label className="ud-field">
          <span>Address</span>
          <input className="cell-input" value={f.address ?? ''}
            onChange={(e) => set({ address: e.target.value })} />
        </label>
        <label className="ud-field">
          <span>Notes</span>
          <input className="cell-input" value={f.notes ?? ''}
            onChange={(e) => set({ notes: e.target.value })} />
        </label>
        <div className="settings-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : vendor ? 'Save vendor' : 'Add vendor'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
