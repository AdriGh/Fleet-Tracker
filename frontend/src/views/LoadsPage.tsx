import { useMemo, useState } from 'react'
import { Drawer } from 'vaul'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createLoad, getLoad, listLoads, listTmsDrivers, patchLoad,
  type Load, type LoadStatus,
} from '../api'
import { notifyOk, notifyErr } from '../toast'
import Modal from '../components/Modal'
import Skeleton from '../components/Skeleton'
import StatCard from '../components/StatCard'
import {
  DocsDots, fmtAppt, LOAD_STATUS_META, LoadStatusPill, RouteCell,
} from './DriversPage'

const PIPELINE: LoadStatus[] = [
  'upcoming', 'dispatched', 'in_transit', 'delivered', 'invoiced', 'closed',
]
const TAG_META: Record<string, { label: string; cls: string }> = {
  set: { label: 'Set', cls: 'lt-set' },
  paid: { label: 'Paid', cls: 'lt-paid' },
  short_pay: { label: 'Short pay', cls: 'lt-short' },
  lumper_pending: { label: 'Lumper PND', cls: 'lt-lumper' },
  issue: { label: 'Issue', cls: 'lt-issue' },
}

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

type StopDraft = {
  kind: 'pickup' | 'delivery'
  name: string
  city: string
  state: string
  appt: string
}

export default function LoadsPage() {
  const [statusFilter, setStatusFilter] = useState('')
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const [openLoad, setOpenLoad] = useState<number | null>(null)
  const qc = useQueryClient()

  const listQ = useQuery({
    queryKey: ['tms-loads', statusFilter],
    queryFn: () => listLoads(statusFilter),
  })
  const loads = listQ.data?.loads ?? []
  const stats = listQ.data?.stats

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return loads
    return loads.filter((l) =>
      l.broker.toLowerCase().includes(s) ||
      l.ref.toLowerCase().includes(s) ||
      l.driver.toLowerCase().includes(s) ||
      l.unit.toLowerCase().includes(s) ||
      String(l.id) === s)
  }, [loads, q])

  function refresh() {
    qc.invalidateQueries({ queryKey: ['tms-loads'] })
  }

  return (
    <div className="page page-wide">
      {listQ.isFetching && <div className="loadbar" aria-hidden="true" />}
      <div className="page-head">
        <div>
          <h1>Loads</h1>
          <p className="page-sub">
            Dispatch board: brokers, stops, rates and driver payouts.
          </p>
        </div>
        <div className="head-actions">
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" width="17" height="17" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New load
          </button>
        </div>
      </div>

      {listQ.error && (
        <div className="banner error"><span>{String(listQ.error)}</span></div>
      )}

      {listQ.isPending ? (
        <div className="kpi-row">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} h={86} />)}
        </div>
      ) : stats && (
        <div className="kpi-row">
          <StatCard label="Active loads" value={stats.active}
            tone="accent" />
          <StatCard label="In transit" value={stats.in_transit} tone="info" />
          <StatCard label="Delivered (30d)" value={stats.delivered_30d}
            tone="ok" />
          <StatCard label="Revenue (30d)" value={money(stats.revenue_30d)}
            tone="default" />
        </div>
      )}

      <div className="card">
        <div className="card-body filters-row">
          <div className="company-tabs" role="tablist">
            <button className={`tab-btn ${statusFilter === '' ? 'active' : ''}`}
              onClick={() => setStatusFilter('')}>All</button>
            {PIPELINE.map((s) => (
              <button key={s}
                className={`tab-btn ${statusFilter === s ? 'active' : ''}`}
                onClick={() => setStatusFilter(s)}>
                {LOAD_STATUS_META[s].label}
              </button>
            ))}
          </div>
          <span className="head-spacer" />
          <input className="cell-input" placeholder="Broker, ref#, driver, load#…"
            value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Loads</h2>
          <span className="sub">{filtered.length} shown</span>
        </div>
        <div className="card-body">
          {listQ.isPending ? (
            <div className="skel-rows">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} h={48} />)}
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty mini">
              <p>No loads{statusFilter ? ' in this status' : ' yet'}. Book
                the first one with “New load”.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="defects-table tms-table loads-table">
                <thead>
                  <tr>
                    <th>Load #</th>
                    <th>Bill to</th>
                    <th>Origin → Destination</th>
                    <th>Driver</th>
                    <th>Status</th>
                    <th className="num">Rate</th>
                    <th>Tags</th>
                    <th>Docs</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((l) => (
                    <tr key={l.id} onClick={() => setOpenLoad(l.id)}>
                      <td className="mono">#{l.id}</td>
                      <td>
                        <span className="nf-driver-text">
                          <strong>{l.broker}</strong>
                          {l.ref && <span className="nf-units">Ref {l.ref}</span>}
                        </span>
                      </td>
                      <td><RouteCell load={l} /></td>
                      <td>
                        <span className="nf-driver-text">
                          <strong>{l.driver || '—'}</strong>
                          {l.unit && <span className="nf-units">{l.unit}</span>}
                        </span>
                      </td>
                      <td><LoadStatusPill status={l.status} /></td>
                      <td className="num mono">
                        {money(l.total)}
                        {l.rate_per_mile != null && (
                          <span className="tms-permile">
                            ${l.rate_per_mile}/mi
                          </span>
                        )}
                      </td>
                      <td>
                        <span className="tms-tags">
                          {l.tags.map((t) => (
                            <span key={t}
                              className={`load-tag ${TAG_META[t]?.cls ?? ''}`}>
                              {TAG_META[t]?.label ?? t}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td><DocsDots docs={l.docs} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {creating && (
        <NewLoadModal onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); refresh(); setOpenLoad(id) }} />
      )}

      <LoadDrawer loadId={openLoad}
        onClose={() => { setOpenLoad(null); refresh() }} />
    </div>
  )
}

// ----- Entrada de cargas (lo más importante según el usuario) -------------
function NewLoadModal({ onClose, onCreated }: {
  onClose: () => void
  onCreated: (id: number) => void
}) {
  const driversQ = useQuery({
    queryKey: ['tms-drivers'], queryFn: listTmsDrivers })
  const drivers = driversQ.data ?? []

  const [broker, setBroker] = useState('')
  const [ref, setRef] = useState('')
  const [driver, setDriver] = useState('')
  const [hauling, setHauling] = useState('')
  const [accs, setAccs] = useState('')
  const [miles, setMiles] = useState('')
  const [stops, setStops] = useState<StopDraft[]>([
    { kind: 'pickup', name: '', city: '', state: '', appt: '' },
    { kind: 'delivery', name: '', city: '', state: '', appt: '' },
  ])
  const [saving, setSaving] = useState(false)

  const drv = drivers.find((d) => d.name === driver)
  const pct = drv?.pay_type === 'percentage' ? drv.pay_pct : 0
  const haulingN = Number(hauling) || 0
  const accsN = Number(accs) || 0
  const payout = haulingN * pct / 100 + accsN
  const milesN = Number(miles) || 0

  function setStop(i: number, patch: Partial<StopDraft>) {
    setStops((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  }

  async function submit() {
    if (!broker.trim()) {
      notifyErr('Missing broker', 'Bill To is required')
      return
    }
    setSaving(true)
    try {
      const ld = await createLoad({
        broker: broker.trim(), ref: ref.trim(), driver,
        unit: drv?.truck ?? '',
        hauling_rate: haulingN, accessorials: accsN,
        pay_pct: pct, miles: milesN || null,
        stops: stops.filter((s) => s.city.trim() || s.name.trim()),
      })
      notifyOk('Load created', `#${ld.id} · ${ld.broker}`)
      onCreated(ld.id)
    } catch (e) {
      notifyErr('Could not create load', e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="New load" width={680} onClose={onClose}>
      <div className="wo-form">
        <div className="load-form-grid">
          <label className="ud-field">
            <span>Bill to (broker)</span>
            <input className="cell-input" value={broker} autoFocus
              placeholder="US FREIGHT LLC"
              onChange={(e) => setBroker(e.target.value)} />
          </label>
          <label className="ud-field">
            <span>Reference # (rate con)</span>
            <input className="cell-input" value={ref} placeholder="81332"
              onChange={(e) => setRef(e.target.value)} />
          </label>
        </div>

        {/* Stops dinámicos */}
        <div className="load-stops-edit">
          <span className="ud-field"><span>Stops</span></span>
          {stops.map((s, i) => (
            <div className="load-stop-row" key={i}>
              <span className={`load-stop-n ${s.kind}`}>{i + 1}</span>
              <select className="cell-input" value={s.kind}
                onChange={(e) => setStop(i,
                  { kind: e.target.value as StopDraft['kind'] })}>
                <option value="pickup">Pickup</option>
                <option value="delivery">Delivery</option>
              </select>
              <input className="cell-input" placeholder="Shipper / receiver"
                value={s.name}
                onChange={(e) => setStop(i, { name: e.target.value })} />
              <input className="cell-input load-stop-city" placeholder="City"
                value={s.city}
                onChange={(e) => setStop(i, { city: e.target.value })} />
              <input className="cell-input load-stop-st" placeholder="ST"
                maxLength={2} value={s.state}
                onChange={(e) => setStop(i, { state: e.target.value })} />
              <input className="cell-input load-stop-appt"
                type="datetime-local" value={s.appt}
                onChange={(e) => setStop(i, { appt: e.target.value })} />
              {stops.length > 2 && (
                <button className="icon-x" title="Remove stop"
                  onClick={() => setStops(
                    (prev) => prev.filter((_, j) => j !== i))}>✕</button>
              )}
            </div>
          ))}
          <button className="btn btn-ghost btn-xs"
            onClick={() => setStops((prev) => [...prev,
              { kind: 'delivery', name: '', city: '', state: '', appt: '' }])}>
            + Add stop
          </button>
        </div>

        <div className="load-form-grid three">
          <label className="ud-field">
            <span>Hauling rate ($)</span>
            <input className="cell-input" type="number" value={hauling}
              placeholder="11700"
              onChange={(e) => setHauling(e.target.value)} />
          </label>
          <label className="ud-field">
            <span>Accessorials ($)</span>
            <input className="cell-input" type="number" value={accs}
              placeholder="224.25"
              onChange={(e) => setAccs(e.target.value)} />
          </label>
          <label className="ud-field">
            <span>Miles (optional)</span>
            <input className="cell-input" type="number" value={miles}
              placeholder="3166"
              onChange={(e) => setMiles(e.target.value)} />
          </label>
        </div>

        <label className="ud-field">
          <span>Assign driver</span>
          <select className="cell-input" value={driver}
            onChange={(e) => setDriver(e.target.value)}>
            <option value="">(unassigned)</option>
            {drivers.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
                {d.truck ? ` (${d.truck})` : ''}
                {d.pay_type === 'percentage' && d.pay_pct
                  ? ` · ${d.pay_pct}%` : ''}
              </option>
            ))}
          </select>
        </label>

        {/* Payout en vivo */}
        <div className="load-payout">
          <div>
            <span>Total quote</span>
            <strong>{money(haulingN + accsN)}</strong>
            {milesN > 0 && haulingN > 0 && (
              <em>${(haulingN / milesN).toFixed(2)}/mi</em>
            )}
          </div>
          <div className="load-payout-driver">
            <span>
              Driver payout{pct ? ` (${pct}% + accs)` : ''}
            </span>
            <strong className="load-payout-n">
              {driver ? money(payout) : '—'}
            </strong>
          </div>
        </div>

        <div className="settings-actions">
          <button className="btn btn-primary" onClick={submit}
            disabled={saving}>
            {saving ? 'Booking…' : 'Book load'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ----- Drawer de detalle de carga ----------------------------------------
function LoadDrawer({ loadId, onClose }: {
  loadId: number | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const open = loadId != null
  const loadQ = useQuery({
    queryKey: ['tms-load', loadId],
    queryFn: () => getLoad(loadId!),
    enabled: open,
  })
  const ld = loadQ.data ?? null
  const [busy, setBusy] = useState(false)

  function refreshLoad(updated: Load) {
    qc.setQueryData(['tms-load', updated.id], updated)
    qc.invalidateQueries({ queryKey: ['tms-loads'] })
  }

  async function patch(p: Record<string, unknown>) {
    if (!ld) return
    setBusy(true)
    try {
      refreshLoad(await patchLoad(ld.id, p))
    } catch (e) {
      notifyErr('Could not update', e)
    } finally {
      setBusy(false)
    }
  }

  function toggleTag(tag: string) {
    if (!ld) return
    const next = ld.tags.includes(tag)
      ? ld.tags.filter((t) => t !== tag)
      : [...ld.tags, tag]
    patch({ tags: next })
  }

  function toggleDoc(key: 'rc' | 'bol' | 'pod') {
    if (!ld) return
    patch({ docs: { ...ld.docs, [key]: !ld.docs[key] } })
  }

  const haulingShare = ld ? ld.hauling_rate * (ld.pay_pct || 0) / 100 : 0

  return (
    <Drawer.Root direction="right" open={open}
      onOpenChange={(o) => { if (!o) onClose() }}>
      <Drawer.Portal>
        <Drawer.Overlay className="ud-overlay" />
        <Drawer.Content className="ud-content wo-drawer">
          {ld && (
            <>
              <div className="ud-head">
                <div>
                  <Drawer.Title className="ud-title">
                    Load #{ld.id} · {ld.broker}
                  </Drawer.Title>
                  <span className="ud-chiprow">
                    <LoadStatusPill status={ld.status} />
                    {ld.ref && <span className="ud-chip">Ref {ld.ref}</span>}
                    {ld.driver && <span className="ud-chip">{ld.driver}</span>}
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
                Load {ld.id} details
              </Drawer.Description>

              <div className="ud-body">
                {/* Pipeline de 6 estados */}
                <div className="wo-pipeline load-pipeline">
                  {PIPELINE.map((s, i) => {
                    const idx = PIPELINE.indexOf(ld.status)
                    const state = i < idx ? 'past' : i === idx ? 'now' : ''
                    return (
                      <button key={s} className={`wo-step ${state}`}
                        disabled={busy || s === ld.status}
                        onClick={() => patch({ status: s })}>
                        {LOAD_STATUS_META[s].label}
                      </button>
                    )
                  })}
                </div>

                {/* Stops numerados */}
                <section className="ud-sec">
                  <h3>
                    Stops
                    <span className="ud-count">{ld.stops?.length ?? 0}</span>
                  </h3>
                  <ol className="load-stops">
                    {(ld.stops ?? []).map((s) => (
                      <li key={s.id}>
                        <span className={`load-stop-n ${s.kind}`}>{s.seq}</span>
                        <span className="load-stop-text">
                          <strong>
                            {s.name || (s.kind === 'pickup'
                              ? 'Pickup' : 'Delivery')}
                          </strong>
                          <span>
                            {s.city}{s.state ? `, ${s.state}` : ''}
                            {s.appt ? ` · ${fmtAppt(s.appt)}` : ''}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                </section>

                {/* Rates + payout */}
                <section className="ud-sec">
                  <h3>Rates &amp; payout</h3>
                  <div className="set-rows">
                    <div className="set-row">
                      <span className="set-row-label">Hauling</span>
                      <span className="set-row-value mono">
                        {money(ld.hauling_rate)}
                      </span>
                    </div>
                    <div className="set-row">
                      <span className="set-row-label">Accessorials</span>
                      <span className="set-row-value mono">
                        {money(ld.accessorials)}
                      </span>
                    </div>
                    <div className="set-row">
                      <span className="set-row-label">Invoice total</span>
                      <span className="set-row-value mono">
                        <strong>{money(ld.total)}</strong>
                        {ld.rate_per_mile != null
                          ? ` · $${ld.rate_per_mile}/mi` : ''}
                      </span>
                    </div>
                    <div className="set-row">
                      <span className="set-row-label">Driver payout</span>
                      <span className="set-row-value mono load-payout-n">
                        {money(ld.payout)}
                        {ld.pay_pct
                          ? ` (${money(haulingShare)} @ ${ld.pay_pct}% + accs)`
                          : ''}
                      </span>
                    </div>
                  </div>
                </section>

                {/* Docs + tags */}
                <section className="ud-sec">
                  <h3>Documents &amp; tags</h3>
                  <div className="load-doc-toggles">
                    {(['rc', 'bol', 'pod'] as const).map((k) => (
                      <button key={k}
                        className={`tms-docdot big ${ld.docs[k] ? 'on' : ''}`}
                        onClick={() => toggleDoc(k)}>
                        {k.toUpperCase()}
                      </button>
                    ))}
                  </div>
                  <div className="load-tag-toggles">
                    {Object.entries(TAG_META).map(([k, m]) => (
                      <button key={k}
                        className={`load-tag ${m.cls} ${ld.tags.includes(k) ? 'on' : 'off'}`}
                        onClick={() => toggleTag(k)}>
                        {m.label}
                      </button>
                    ))}
                  </div>
                </section>

                <section className="ud-sec">
                  <h3>Notes</h3>
                  <textarea className="cell-input ud-notes" rows={3}
                    defaultValue={ld.notes}
                    placeholder="Lumper paid by driver, broker contact…"
                    onBlur={(e) => {
                      if (e.target.value !== ld.notes) {
                        patch({ notes: e.target.value })
                      }
                    }} />
                </section>
              </div>
            </>
          )}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
