// Catálogo de Partes + Vendors (fase H3, estilo Fullbay). Dos pestañas:
// Parts (catálogo con costo interno, vendor, inventario manual) y Vendors
// (proveedores). Se reusan al cargar líneas de una work order.
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  deletePart, deleteVendor, listParts, listVendors, savePart, saveVendor,
  type Part, type PartInput, type Vendor, type VendorInput,
} from '../api'
import { notifyOk, notifyErr } from '../toast'
import { Button, Tabs } from '../components/ds'
import Modal from '../components/Modal'
import Skeleton from '../components/Skeleton'
import StatCard from '../components/StatCard'

type Tab = 'parts' | 'vendors'

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
            Shop catalog: parts with internal cost and the vendors you buy
            them from. Reused when building work orders.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-body filters-row">
          <Tabs
            tabs={[{ id: 'parts', label: 'Parts' },
              { id: 'vendors', label: 'Vendors' }]}
            value={tab}
            onChange={(id) => setTab(id as Tab)}
          />
        </div>
      </div>

      {tab === 'parts' ? <PartsTab /> : <VendorsTab />}
    </div>
  )
}

// ----- Pestaña Parts -------------------------------------------------------
function PartsTab() {
  const qc = useQueryClient()
  const partsQ = useQuery({ queryKey: ['parts'], queryFn: listParts })
  const vendorsQ = useQuery({ queryKey: ['vendors'], queryFn: listVendors })
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<Part | null>(null)
  const [adding, setAdding] = useState(false)

  const parts = partsQ.data?.parts ?? []
  const usage = partsQ.data?.usage ?? {}
  const vendors = vendorsQ.data ?? []

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return parts
    return parts.filter((p) =>
      p.part_number.toLowerCase().includes(s) ||
      p.description.toLowerCase().includes(s) ||
      p.category.toLowerCase().includes(s) ||
      p.vendor_name.toLowerCase().includes(s))
  }, [parts, q])

  const totalValue = useMemo(
    () => parts.reduce((s, p) => s + p.cost * (p.on_hand || 0), 0), [parts])

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
      <div className="kpi-row">
        <StatCard label="Parts" value={parts.length} tone="info" />
        <StatCard label="Categories"
          value={(partsQ.data?.categories ?? []).length} tone="default" />
        <StatCard label="Inventory value" value={money(totalValue)}
          tone="accent" />
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Parts catalog</h2>
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
                    <th className="num">Used</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p) => (
                    <tr key={p.id} onClick={() => setEditing(p)}>
                      <td className="mono"><strong>{p.part_number}</strong></td>
                      <td>{p.description || <span className="muted">—</span>}</td>
                      <td>{p.category
                        ? <span className="intg-chip">{p.category}</span>
                        : <span className="muted">—</span>}</td>
                      <td className="num mono">{money(p.cost)}</td>
                      <td>{p.vendor_name || <span className="muted">—</span>}</td>
                      <td className="num">{p.on_hand || 0}</td>
                      <td className="num">
                        {usage[p.part_number]
                          ? <span className="wo-pm-tag">{usage[p.part_number]}×</span>
                          : <span className="muted">—</span>}
                      </td>
                      <td className="num" onClick={(e) => e.stopPropagation()}>
                        <button className="icon-x" title="Delete part"
                          onClick={() => remove(p)}>✕</button>
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
        <PartModal part={editing} vendors={vendors}
          categories={partsQ.data?.categories ?? []}
          onClose={() => { setAdding(false); setEditing(null) }}
          onSaved={() => {
            setAdding(false); setEditing(null)
            qc.invalidateQueries({ queryKey: ['parts'] })
          }} />
      )}
    </>
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
