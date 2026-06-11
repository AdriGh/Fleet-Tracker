import { useMemo, useState } from 'react'
import { Drawer } from 'vaul'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addWoLine, createWorkOrder, deleteWoLine, getWorkOrder, listFleet,
  listWorkOrders, patchWorkOrder,
  type WorkOrder, type WoPriority, type WoStatus,
} from '../api'
import { notifyOk, notifyErr } from '../toast'
import Modal from '../components/Modal'
import Skeleton from '../components/Skeleton'
import StatCard from '../components/StatCard'

const STATUS_META: Record<WoStatus, { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'wo-open' },
  in_progress: { label: 'In progress', cls: 'wo-progress' },
  waiting_parts: { label: 'Waiting parts', cls: 'wo-waiting' },
  completed: { label: 'Completed', cls: 'wo-done' },
}
const PIPELINE: WoStatus[] = [
  'open', 'in_progress', 'waiting_parts', 'completed',
]
const PRIORITY_META: Record<WoPriority, { label: string; cls: string }> = {
  low: { label: 'Low', cls: 'pr-low' },
  normal: { label: 'Normal', cls: 'pr-normal' },
  high: { label: 'High', cls: 'pr-high' },
}

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const dateOf = (iso: string | null) => (iso ? iso.slice(0, 10) : '—')

export default function WorkOrdersPage() {
  const qc = useQueryClient()
  const [statusFilter, setStatusFilter] = useState('')
  const [q, setQ] = useState('')
  const [openWo, setOpenWo] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)

  const listQ = useQuery({
    queryKey: ['workorders', statusFilter],
    queryFn: () => listWorkOrders(statusFilter),
  })
  const wos = listQ.data?.workorders ?? []
  const stats = listQ.data?.stats
  const mechanics = listQ.data?.mechanics ?? []

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return wos
    return wos.filter((w) =>
      w.unit.toLowerCase().includes(s) ||
      w.title.toLowerCase().includes(s) ||
      w.mechanic.toLowerCase().includes(s) ||
      String(w.id) === s)
  }, [wos, q])

  function refresh() {
    qc.invalidateQueries({ queryKey: ['workorders'] })
  }

  return (
    <div className="page page-wide">
      {listQ.isFetching && <div className="loadbar" aria-hidden="true" />}
      <div className="page-head">
        <div>
          <h1>Work Orders</h1>
          <p className="page-sub">
            Shop pipeline: defects to repairs to costs, with PM closeout.
          </p>
        </div>
        <div className="head-actions">
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" width="17" height="17" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New work order
          </button>
        </div>
      </div>

      {listQ.error && (
        <div className="banner error"><span>{String(listQ.error)}</span></div>
      )}

      {listQ.isPending ? (
        <div className="kpi-row">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} h={86} />)}
        </div>
      ) : stats && (
        <div className="kpi-row">
          <StatCard label="Open" value={stats.open}
            tone={stats.open ? 'warn' : 'ok'} />
          <StatCard label="In progress" value={stats.in_progress} tone="info" />
          <StatCard label="Waiting parts" value={stats.waiting_parts}
            tone={stats.waiting_parts ? 'warn' : 'default'} />
          <StatCard label="Completed (30d)" value={stats.completed_30d}
            tone="ok" />
          <StatCard label="Cost (30d)" value={money(stats.cost_30d)}
            tone="accent" />
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
                {STATUS_META[s].label}
              </button>
            ))}
          </div>
          <span className="head-spacer" />
          <input className="cell-input" placeholder="Unit, title, mechanic, WO#…"
            value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Orders</h2>
          <span className="sub">{filtered.length} shown</span>
        </div>
        <div className="card-body">
          {listQ.isPending ? (
            <div className="skel-rows">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} h={38} />)}
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty mini">
              <p>
                No work orders{statusFilter ? ' in this status' : ' yet'}.
                Create one here or from an open defect in Fleet.
              </p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="defects-table wo-table">
                <thead>
                  <tr>
                    <th>WO#</th>
                    <th>Unit</th>
                    <th>Title</th>
                    <th>Mechanic</th>
                    <th>Priority</th>
                    <th>Status</th>
                    <th className="num">Total</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((w) => (
                    <tr key={w.id} onClick={() => setOpenWo(w.id)}>
                      <td className="mono">#{w.id}</td>
                      <td><span className="unit-code">{w.unit}</span>
                        {w.is_pm && <span className="wo-pm-tag">PM</span>}
                      </td>
                      <td className="wo-title">{w.title}</td>
                      <td>{w.mechanic || <span className="muted">—</span>}</td>
                      <td>
                        <span className={`wo-priority ${PRIORITY_META[w.priority].cls}`}>
                          {PRIORITY_META[w.priority].label}
                        </span>
                      </td>
                      <td>
                        <span className={`wo-status ${STATUS_META[w.status].cls}`}>
                          {STATUS_META[w.status].label}
                        </span>
                      </td>
                      <td className="num mono">
                        {w.total ? money(w.total) : '—'}
                      </td>
                      <td className="muted">{dateOf(w.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {creating && (
        <CreateWoModal mechanics={mechanics}
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); refresh(); setOpenWo(id) }} />
      )}

      <WoDrawer woId={openWo} mechanics={mechanics}
        onClose={() => { setOpenWo(null); refresh() }} />
    </div>
  )
}

// ----- Modal de creación -------------------------------------------------
function CreateWoModal({ mechanics, onClose, onCreated }: {
  mechanics: string[]
  onClose: () => void
  onCreated: (id: number) => void
}) {
  const fleetQ = useQuery({ queryKey: ['fleet'], queryFn: listFleet })
  const units = useMemo(
    () => (fleetQ.data ?? []).filter((u) => !u.archived)
      .map((u) => u.unit).sort(),
    [fleetQ.data])
  const [unit, setUnit] = useState('')
  const [title, setTitle] = useState('')
  const [complaint, setComplaint] = useState('')
  const [mechanic, setMechanic] = useState('')
  const [priority, setPriority] = useState<WoPriority>('normal')
  const [isPm, setIsPm] = useState(false)
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (!unit.trim() || !title.trim()) {
      notifyErr('Faltan datos', 'Unit y título son obligatorios')
      return
    }
    setSaving(true)
    try {
      const wo = await createWorkOrder({
        unit: unit.trim(), title: title.trim(), complaint,
        mechanic, priority, is_pm: isPm,
      })
      notifyOk('Work order creada', `#${wo.id} · ${wo.unit}`)
      onCreated(wo.id)
    } catch (e) {
      notifyErr('No se pudo crear', e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="New work order" width={520} onClose={onClose}>
      <div className="wo-form">
        <label className="ud-field">
          <span>Unit</span>
          <input className="cell-input" list="wo-units" value={unit}
            placeholder="CF2254" onChange={(e) => setUnit(e.target.value)} />
          <datalist id="wo-units">
            {units.map((u) => <option key={u} value={u} />)}
          </datalist>
        </label>
        <label className="ud-field">
          <span>Title</span>
          <input className="cell-input" value={title}
            placeholder="Brake light out"
            onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="ud-field">
          <span>Complaint / detail</span>
          <textarea className="cell-input ud-notes" rows={3} value={complaint}
            placeholder="What was reported, by whom…"
            onChange={(e) => setComplaint(e.target.value)} />
        </label>
        <div className="wo-form-row">
          <label className="ud-field">
            <span>Mechanic</span>
            <input className="cell-input" list="wo-mechanics" value={mechanic}
              onChange={(e) => setMechanic(e.target.value)} />
            <datalist id="wo-mechanics">
              {mechanics.map((m) => <option key={m} value={m} />)}
            </datalist>
          </label>
          <label className="ud-field">
            <span>Priority</span>
            <select className="cell-input" value={priority}
              onChange={(e) => setPriority(e.target.value as WoPriority)}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </select>
          </label>
        </div>
        <label className="settings-toggle ud-toggle">
          <input type="checkbox" checked={isPm}
            onChange={(e) => setIsPm(e.target.checked)} />
          <span>
            <strong>PM service</strong>
            <span className="settings-sub">
              Completing this WO with a mileage updates the PM tracker.
            </span>
          </span>
        </label>
        <div className="settings-actions">
          <button className="btn btn-primary" onClick={submit}
            disabled={saving}>
            {saving ? 'Creating…' : 'Create work order'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ----- Drawer de detalle (pipeline + líneas) -----------------------------
function WoDrawer({ woId, mechanics, onClose }: {
  woId: number | null
  mechanics: string[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const open = woId != null
  const woQ = useQuery({
    queryKey: ['workorder', woId],
    queryFn: () => getWorkOrder(woId!),
    enabled: open,
  })
  const wo = woQ.data ?? null

  const [lineKind, setLineKind] = useState<'part' | 'labor'>('part')
  const [lineDesc, setLineDesc] = useState('')
  const [lineQty, setLineQty] = useState('1')
  const [lineCost, setLineCost] = useState('')
  const [pmMiles, setPmMiles] = useState('')
  const [busy, setBusy] = useState(false)

  function refreshWo(updated: WorkOrder) {
    qc.setQueryData(['workorder', updated.id], updated)
    qc.invalidateQueries({ queryKey: ['workorders'] })
  }

  async function setStatus(s: WoStatus) {
    if (!wo) return
    setBusy(true)
    try {
      const patch: Partial<WorkOrder> = { status: s }
      if (s === 'completed' && wo.is_pm && pmMiles.trim()) {
        patch.pm_miles = Number(pmMiles)
      }
      const updated = await patchWorkOrder(wo.id, patch)
      refreshWo(updated)
      if (s === 'completed' && updated.is_pm && updated.pm_miles) {
        qc.invalidateQueries({ queryKey: ['pm'] })
        notifyOk('PM actualizado', `${updated.unit} · last PM ${updated.pm_miles?.toLocaleString()} mi`)
      } else {
        notifyOk(`WO #${updated.id}: ${STATUS_META[s].label}`)
      }
    } catch (e) {
      notifyErr('No se pudo actualizar', e)
    } finally {
      setBusy(false)
    }
  }

  async function addLine() {
    if (!wo || !lineDesc.trim()) return
    setBusy(true)
    try {
      const updated = await addWoLine(wo.id, {
        kind: lineKind, description: lineDesc.trim(),
        qty: Number(lineQty) || 1, unit_cost: Number(lineCost) || 0,
      })
      refreshWo(updated)
      setLineDesc(''); setLineQty('1'); setLineCost('')
    } catch (e) {
      notifyErr('No se pudo agregar la línea', e)
    } finally {
      setBusy(false)
    }
  }

  async function removeLine(lineId: number) {
    if (!wo) return
    try {
      refreshWo(await deleteWoLine(wo.id, lineId))
    } catch (e) {
      notifyErr('No se pudo borrar la línea', e)
    }
  }

  async function saveField(patch: Partial<WorkOrder>) {
    if (!wo) return
    try {
      refreshWo(await patchWorkOrder(wo.id, patch))
    } catch (e) {
      notifyErr('No se pudo guardar', e)
    }
  }

  return (
    <Drawer.Root direction="right" open={open}
      onOpenChange={(o) => { if (!o) onClose() }}>
      <Drawer.Portal>
        <Drawer.Overlay className="ud-overlay" />
        <Drawer.Content className="ud-content wo-drawer">
          {wo && (
            <>
              <div className="ud-head">
                <div>
                  <Drawer.Title className="ud-title">
                    WO #{wo.id} · {wo.unit}
                  </Drawer.Title>
                  <span className="ud-chiprow">
                    <span className={`wo-status ${STATUS_META[wo.status].cls}`}>
                      {STATUS_META[wo.status].label}
                    </span>
                    <span className={`wo-priority ${PRIORITY_META[wo.priority].cls}`}>
                      {PRIORITY_META[wo.priority].label}
                    </span>
                    {wo.is_pm && <span className="wo-pm-tag">PM</span>}
                    {wo.source === 'defect' && (
                      <span className="ud-chip">from defect</span>
                    )}
                  </span>
                </div>
                <button className="icon-btn" onClick={onClose}
                  aria-label="Cerrar">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
              <Drawer.Description className="sr-only">
                Detalle de la work order {wo.id}
              </Drawer.Description>

              <div className="ud-body">
                {/* Pipeline de estados (estilo QuickManage) */}
                <div className="wo-pipeline">
                  {PIPELINE.map((s, i) => {
                    const idx = PIPELINE.indexOf(wo.status)
                    const state = i < idx ? 'past' : i === idx ? 'now' : ''
                    return (
                      <button key={s}
                        className={`wo-step ${state}`}
                        disabled={busy || s === wo.status}
                        onClick={() => setStatus(s)}>
                        {STATUS_META[s].label}
                      </button>
                    )
                  })}
                </div>

                {wo.is_pm && wo.status !== 'completed' && (
                  <label className="ud-field wo-pm-miles">
                    <span>Odometer at PM completion (mi)</span>
                    <input className="cell-input" type="number" value={pmMiles}
                      placeholder="431850"
                      onChange={(e) => setPmMiles(e.target.value)} />
                  </label>
                )}

                <section className="ud-sec">
                  <h3>{wo.title}</h3>
                  {wo.complaint && (
                    <p className="wo-complaint">{wo.complaint}</p>
                  )}
                  <div className="wo-meta-row">
                    <label className="ud-field">
                      <span>Mechanic</span>
                      <input className="cell-input" list="wo-mechanics-d"
                        defaultValue={wo.mechanic}
                        onBlur={(e) => {
                          if (e.target.value !== wo.mechanic) {
                            saveField({ mechanic: e.target.value })
                          }
                        }} />
                      <datalist id="wo-mechanics-d">
                        {mechanics.map((m) => <option key={m} value={m} />)}
                      </datalist>
                    </label>
                    <label className="ud-field">
                      <span>Priority</span>
                      <select className="cell-input" value={wo.priority}
                        onChange={(e) => saveField(
                          { priority: e.target.value as WoPriority })}>
                        <option value="low">Low</option>
                        <option value="normal">Normal</option>
                        <option value="high">High</option>
                      </select>
                    </label>
                  </div>
                </section>

                {/* Líneas: partes + labor */}
                <section className="ud-sec">
                  <h3>
                    Parts &amp; labor
                    <span className="ud-count">{wo.lines?.length ?? 0}</span>
                  </h3>
                  {(wo.lines ?? []).length > 0 && (
                    <table className="wo-lines">
                      <tbody>
                        {(wo.lines ?? []).map((ln) => (
                          <tr key={ln.id}>
                            <td>
                              <span className={`wo-line-kind k-${ln.kind}`}>
                                {ln.kind === 'part' ? 'Part' : 'Labor'}
                              </span>
                            </td>
                            <td className="wo-line-desc">{ln.description}</td>
                            <td className="num mono">
                              {ln.qty} × {money(ln.unit_cost)}
                            </td>
                            <td className="num mono">{money(ln.total)}</td>
                            <td>
                              <button className="icon-x" title="Quitar línea"
                                onClick={() => removeLine(ln.id)}>✕</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <div className="wo-line-add">
                    <select className="cell-input" value={lineKind}
                      onChange={(e) => setLineKind(
                        e.target.value as 'part' | 'labor')}>
                      <option value="part">Part</option>
                      <option value="labor">Labor</option>
                    </select>
                    <input className="cell-input wo-line-add-desc"
                      placeholder={lineKind === 'part'
                        ? 'LED brake lamp' : 'Replace + test'}
                      value={lineDesc}
                      onChange={(e) => setLineDesc(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') addLine() }} />
                    <input className="cell-input wo-line-add-n" type="number"
                      title={lineKind === 'part' ? 'Cantidad' : 'Horas'}
                      placeholder={lineKind === 'part' ? 'qty' : 'hrs'}
                      value={lineQty}
                      onChange={(e) => setLineQty(e.target.value)} />
                    <input className="cell-input wo-line-add-n" type="number"
                      title={lineKind === 'part'
                        ? 'Costo unitario' : 'Tarifa por hora'}
                      placeholder="$"
                      value={lineCost}
                      onChange={(e) => setLineCost(e.target.value)} />
                    <button className="btn btn-ghost btn-xs" onClick={addLine}
                      disabled={busy || !lineDesc.trim()}>
                      Add
                    </button>
                  </div>
                  <div className="wo-total">
                    <span>Total</span>
                    <strong>{money(wo.total)}</strong>
                  </div>
                </section>

                <section className="ud-sec">
                  <h3>Notes</h3>
                  <textarea className="cell-input ud-notes" rows={3}
                    defaultValue={wo.notes}
                    placeholder="Internal notes, vendor, PO…"
                    onBlur={(e) => {
                      if (e.target.value !== wo.notes) {
                        saveField({ notes: e.target.value })
                      }
                    }} />
                  <p className="ud-muted wo-dates">
                    Created {dateOf(wo.created_at)}
                    {wo.closed_at ? ` · Completed ${dateOf(wo.closed_at)}` : ''}
                  </p>
                </section>
              </div>
            </>
          )}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
