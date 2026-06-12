import { useMemo, useRef, useState } from 'react'
import { Drawer } from 'vaul'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addWoLine, createWorkOrder, deleteWoLine, deleteWorkOrder,
  getUnitOdometer, getWorkOrder, listFleet, listWorkOrders,
  patchWorkOrder, scanWoDocument,
  type WorkOrder, type WoPriority, type WoScanLine, type WoStatus,
} from '../api'
import { notifyOk, notifyErr } from '../toast'
import Modal from '../components/Modal'
import Skeleton from '../components/Skeleton'
import StatCard from '../components/StatCard'

export const STATUS_META: Record<WoStatus, { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'wo-open' },
  assigned: { label: 'Assigned', cls: 'wo-assigned' },
  in_progress: { label: 'In progress', cls: 'wo-progress' },
  completed: { label: 'Completed', cls: 'wo-done' },
  invoiced: { label: 'Invoiced', cls: 'wo-invoiced' },
}
// Pipeline secuencial H2 (estilo UNIQ TMS); H3: invoiced es terminal.
export const PIPELINE: WoStatus[] = [
  'open', 'assigned', 'in_progress', 'completed', 'invoiced',
]
const PRIORITY_META: Record<WoPriority, { label: string; cls: string }> = {
  low: { label: 'Low', cls: 'pr-low' },
  normal: { label: 'Normal', cls: 'pr-normal' },
  high: { label: 'High', cls: 'pr-high' },
}

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const dateOf = (iso: string | null) => (iso ? iso.slice(0, 10) : '—')

// Campañas de mantenimiento (H3b): nombres estilo Fullbay. Una orden
// con campaña actualiza Components & PMs del perfil al facturarse.
export const CAMPAIGN_OPTS: { key: string; label: string }[] = [
  { key: '', label: 'None' },
  { key: 'pm', label: 'Full Wet Service (PM)' },
  { key: 'dot', label: 'Federal Annual DOT Inspection' },
  { key: 'kingpins', label: 'Check kingpins' },
  { key: 'dpf', label: 'DPF replacement' },
  { key: 'clutch', label: 'Clutch replacement' },
]

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
          <StatCard label="Assigned" value={stats.assigned} tone="info" />
          <StatCard label="In progress" value={stats.in_progress} tone="info" />
          <StatCard label="To invoice" value={stats.completed}
            tone={stats.completed ? 'warn' : 'default'} />
          <StatCard label="Invoiced" value={stats.invoiced} tone="ok" />
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
                        {w.waiting_parts && (
                          <span className="wo-wait-tag"
                            title="Waiting for parts">parts</span>
                        )}
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

// ----- Modal de creación (el form del jefe: unit, mileage, date, issue) ---
function todayISO(): string {
  const t = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`
}

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
  const [campaign, setCampaign] = useState('')
  const [mileage, setMileage] = useState('')
  const [date, setDate] = useState(todayISO())
  const [saving, setSaving] = useState(false)
  const [fetchingMi, setFetchingMi] = useState(false)
  // Escáner de documentos (H2.5): el PDF/foto autollena el form y las
  // líneas extraídas (editables, H3b) se agregan al crear la orden.
  const [scanning, setScanning] = useState(false)
  const [scanName, setScanName] = useState('')
  const [scanLines, setScanLines] = useState<WoScanLine[]>([])
  const [dragOver, setDragOver] = useState(false)
  // Preview del documento al lado del form (H3b).
  const [preview, setPreview] = useState<{ url: string; pdf: boolean } | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  function setLine(i: number, patch: Partial<WoScanLine>) {
    setScanLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  }

  async function handleFile(f: File | undefined | null) {
    if (!f || scanning) return
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old.url)
      return { url: URL.createObjectURL(f),
               pdf: f.type === 'application/pdf' }
    })
    setScanning(true)
    setScanName(f.name)
    try {
      const r = await scanWoDocument(f)
      const x = r.extract
      if (x.unit) setUnit(x.unit)
      if (x.service_date) setDate(x.service_date)
      if (x.mileage != null) setMileage(String(x.mileage))
      if (x.title) setTitle(x.title)
      if (x.mechanic) setMechanic(x.mechanic)
      if (x.is_pm) setCampaign('pm')
      const extra = [
        x.vendor ? `Vendor: ${x.vendor}` : '',
        x.invoice_number ? `Invoice #${x.invoice_number}` : '',
      ].filter(Boolean).join(' · ')
      setComplaint([x.complaint || '', extra].filter(Boolean).join('\n'))
      setScanLines(x.lines)
      notifyOk('Document scanned',
        `${x.lines.length} line${x.lines.length === 1 ? '' : 's'} found · ${r.model}`)
    } catch (e) {
      setScanName('')
      notifyErr("Couldn't scan the document", e)
    } finally {
      setScanning(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function fillCurrent() {
    if (!unit.trim() || fetchingMi) return
    setFetchingMi(true)
    try {
      const o = await getUnitOdometer(unit.trim())
      if (o.miles != null) setMileage(String(o.miles))
      else notifyErr('No odometer', `Samsara has no reading for ${unit.trim()}`)
    } catch (e) {
      notifyErr("Couldn't fetch mileage", e)
    } finally {
      setFetchingMi(false)
    }
  }

  async function submit() {
    if (!unit.trim() || !title.trim()) {
      notifyErr('Missing fields', 'Unit and issue are required')
      return
    }
    setSaving(true)
    try {
      const lines = scanLines.filter((l) => l.description.trim())
      const wo = await createWorkOrder({
        unit: unit.trim(), title: title.trim(), complaint,
        mechanic, priority, campaign,
        mileage: mileage ? Number(mileage) : null,
        service_date: date,
        source: scanName ? 'scan' : 'manual',
      })
      // Las líneas (escaneadas o agregadas a mano) van en orden.
      for (const ln of lines) {
        await addWoLine(wo.id, {
          kind: ln.kind, description: ln.description.trim(),
          qty: Number(ln.qty) || 1, unit_cost: Number(ln.unit_cost) || 0,
        })
      }
      notifyOk('Work order created',
        `#${wo.id} · ${wo.unit}` +
        (scanLines.length ? ` · ${scanLines.length} lines` : ''))
      onCreated(wo.id)
    } catch (e) {
      notifyErr('Could not create', e)
    } finally {
      setSaving(false)
    }
  }

  const scanTotal = scanLines.reduce(
    (s, l) => s + l.qty * l.unit_cost, 0)

  return (
    <Modal title="New work order" width={1120} onClose={onClose}>
      <div className="wo-modal-grid">
      {/* Columna izquierda: escáner + preview del documento (H3b) */}
      <div className="wo-preview-pane">
        <div
          className={`wo-scan ${dragOver ? 'is-over' : ''} ${scanning ? 'is-busy' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => fileRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') fileRef.current?.click()
          }}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            handleFile(e.dataTransfer.files?.[0])
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
            className="wo-scan-ico">
            <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
            <path d="M14 3v5h5M9.5 13h6M9.5 16.5h6" />
          </svg>
          <span className="wo-scan-text">
            <strong>
              {scanning
                ? `Scanning ${scanName}…`
                : scanName
                  ? `Scanned ${scanName}`
                  : 'Scan an invoice or estimate'}
            </strong>
            <span>
              {scanning
                ? 'Reading the document with AI'
                : 'PDF or photo. The form fills itself.'}
            </span>
          </span>
          <input
            ref={fileRef} type="file" hidden
            accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/*"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
        </div>
        {preview ? (
          preview.pdf ? (
            <iframe className="wo-preview" src={preview.url}
              title="Document preview" />
          ) : (
            <img className="wo-preview" src={preview.url}
              alt="Document preview" />
          )
        ) : (
          <div className="wo-preview wo-preview-empty">
            <p>The document preview shows here.</p>
          </div>
        )}
      </div>

      {/* Columna derecha: el form */}
      <div className="wo-form">
        <label className="ud-field">
          <span>Unit</span>
          <input className="cell-input" list="wo-units" value={unit}
            placeholder="CF2254" onChange={(e) => setUnit(e.target.value)} />
          <datalist id="wo-units">
            {units.map((u) => <option key={u} value={u} />)}
          </datalist>
        </label>
        <div className="wo-form-row">
          <label className="ud-field">
            <span>Date</span>
            <input className="cell-input" type="date" value={date}
              onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="ud-field">
            <span>Mileage</span>
            <span className="mnt-miles-row">
              <input className="cell-input" type="number" value={mileage}
                placeholder="optional"
                onChange={(e) => setMileage(e.target.value)} />
              <button className="btn btn-ghost"
                disabled={!unit.trim() || fetchingMi}
                title="Fetch the current odometer from Samsara"
                onClick={fillCurrent}>
                {fetchingMi ? '…' : 'Current'}
              </button>
            </span>
          </label>
        </div>
        <label className="ud-field">
          <span>Issue</span>
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
        <label className="ud-field">
          <span>Maintenance campaign</span>
          <select className="cell-input" value={campaign}
            onChange={(e) => setCampaign(e.target.value)}>
            {CAMPAIGN_OPTS.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
          <span className="settings-sub">
            When this order is invoiced, the campaign updates in the
            unit profile (Components &amp; PMs).
          </span>
        </label>

        {/* Líneas (escaneadas o a mano): editables antes de crear */}
        <div className="wo-lines-edit">
          <div className="wo-lines-edit-head">
            <span>Parts &amp; labor</span>
            <button className="btn btn-ghost btn-xs"
              onClick={() => setScanLines([...scanLines, {
                kind: 'part', description: '', qty: 1, unit_cost: 0,
              }])}>
              + Add line
            </button>
          </div>
          {scanLines.map((ln, i) => (
            <div key={i} className="wo-line-row">
              <select className="cell-input" value={ln.kind}
                onChange={(e) => setLine(i, {
                  kind: e.target.value as 'part' | 'labor' })}>
                <option value="part">Part</option>
                <option value="labor">Labor</option>
              </select>
              <input className="cell-input" value={ln.description}
                placeholder="Description"
                onChange={(e) => setLine(i, { description: e.target.value })} />
              <input className="cell-input wo-line-n" type="number"
                title={ln.kind === 'part' ? 'Quantity' : 'Hours'}
                value={ln.qty}
                onChange={(e) => setLine(i, { qty: Number(e.target.value) })} />
              <input className="cell-input wo-line-n" type="number"
                title={ln.kind === 'part' ? 'Unit cost' : 'Hourly rate'}
                value={ln.unit_cost}
                onChange={(e) =>
                  setLine(i, { unit_cost: Number(e.target.value) })} />
              <button className="mnt-icon" title="Remove line"
                onClick={() => setScanLines(
                  scanLines.filter((_, j) => j !== i))}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.8" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          ))}
          {scanLines.length > 0 && (
            <span className="wo-scan-total">
              Will be added on create · {money(scanTotal)}
            </span>
          )}
        </div>

        <div className="settings-actions">
          <button className="btn btn-primary" onClick={submit}
            disabled={saving}>
            {saving ? 'Creating…' : 'Create work order'}
          </button>
        </div>
      </div>
      </div>
    </Modal>
  )
}

// ----- Drawer de detalle (pipeline + líneas) -----------------------------
// Exportado: el perfil de unidad (H3) lo reusa para abrir órdenes.
export function WoDrawer({ woId, mechanics, onClose }: {
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
      const crossesCompleted =
        PIPELINE.indexOf(s) >= PIPELINE.indexOf('completed')
      if (crossesCompleted && wo.is_pm && pmMiles.trim()) {
        patch.pm_miles = Number(pmMiles)
      }
      const updated = await patchWorkOrder(wo.id, patch)
      refreshWo(updated)
      if (crossesCompleted && updated.is_pm && updated.pm_miles) {
        qc.invalidateQueries({ queryKey: ['pm'] })
        qc.invalidateQueries({ queryKey: ['maint'] })
        notifyOk('PM updated', `${updated.unit} · last PM ${updated.pm_miles?.toLocaleString()} mi`)
      } else {
        notifyOk(`WO #${updated.id}: ${STATUS_META[s].label}`)
      }
      if (updated.telegram) {
        if (updated.telegram.simulated) {
          notifyOk('Telegram (dry run)', 'Simulated, nothing sent')
        } else if (updated.telegram.sent) {
          notifyOk('Telegram sent', 'Shop group notified')
        } else {
          notifyErr('Telegram failed', updated.telegram.detail)
        }
      }
    } catch (e) {
      // Los gates del pipeline llegan como 400 con el motivo exacto.
      notifyErr("Can't move there yet", e)
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
      notifyErr('Could not add line', e)
    } finally {
      setBusy(false)
    }
  }

  async function removeLine(lineId: number) {
    if (!wo) return
    try {
      refreshWo(await deleteWoLine(wo.id, lineId))
    } catch (e) {
      notifyErr('Could not delete line', e)
    }
  }

  async function saveField(patch: Partial<WorkOrder>) {
    if (!wo) return
    try {
      refreshWo(await patchWorkOrder(wo.id, patch))
    } catch (e) {
      notifyErr('Could not save', e)
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
                  aria-label="Close">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
              <Drawer.Description className="sr-only">
                Work order {wo.id} details
              </Drawer.Description>

              <div className="ud-body">
                {/* Barra de etapas secuencial (estilo UNIQ TMS): hover
                    previsualiza hasta dónde llega el clic; un clic puede
                    saltar varias etapas y los gates del backend avisan
                    qué falta. */}
                <StageBar wo={wo} busy={busy} onGo={setStatus} />

                <div className="wo-flags">
                  <button
                    className={`wo-wait-toggle ${wo.waiting_parts ? 'on' : ''}`}
                    onClick={() =>
                      saveField({ waiting_parts: !wo.waiting_parts })}
                  >
                    <span className="nf-dot" />
                    Waiting for parts
                  </button>
                  {wo.invoiced_at && (
                    <span className="ud-chip">
                      Invoiced {dateOf(wo.invoiced_at)}
                    </span>
                  )}
                </div>

                {wo.is_pm &&
                  PIPELINE.indexOf(wo.status) <
                    PIPELINE.indexOf('completed') && (
                  <label className="ud-field wo-pm-miles">
                    <span>Odometer at PM completion (mi)</span>
                    <input className="cell-input" type="number" value={pmMiles}
                      placeholder="431850"
                      onChange={(e) => setPmMiles(e.target.value)} />
                  </label>
                )}

                <section className="ud-sec" key={wo.id}>
                  {/* H3: issue y complaint editables inline */}
                  <input
                    className="wo-title-edit" defaultValue={wo.title}
                    title="Edit the issue title"
                    onBlur={(e) => {
                      if (e.target.value.trim()
                          && e.target.value !== wo.title) {
                        saveField({ title: e.target.value.trim() })
                      }
                    }}
                  />
                  <textarea
                    className="cell-input ud-notes wo-complaint-edit"
                    rows={2} defaultValue={wo.complaint}
                    placeholder="Complaint / detail"
                    onBlur={(e) => {
                      if (e.target.value !== wo.complaint) {
                        saveField({ complaint: e.target.value })
                      }
                    }}
                  />
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
                    <label className="ud-field">
                      <span>Campaign</span>
                      <select className="cell-input" value={wo.campaign}
                        onChange={(e) =>
                          saveField({ campaign: e.target.value })}>
                        {CAMPAIGN_OPTS.map((c) => (
                          <option key={c.key} value={c.key}>{c.label}</option>
                        ))}
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
                              <button className="icon-x" title="Remove line"
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
                      title={lineKind === 'part' ? 'Quantity' : 'Hours'}
                      placeholder={lineKind === 'part' ? 'qty' : 'hrs'}
                      value={lineQty}
                      onChange={(e) => setLineQty(e.target.value)} />
                    <input className="cell-input wo-line-add-n" type="number"
                      title={lineKind === 'part'
                        ? 'Unit cost' : 'Hourly rate'}
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
                    {wo.service_date ? ` · Service ${wo.service_date}` : ''}
                    {wo.mileage != null
                      ? ` · ${wo.mileage.toLocaleString('en-US')} mi`
                      : ''}
                    {wo.closed_at ? ` · Completed ${dateOf(wo.closed_at)}` : ''}
                  </p>
                  <button
                    className="btn btn-ghost btn-xs wo-delete"
                    onClick={async () => {
                      if (!window.confirm(
                        `Delete work order #${wo.id} (${wo.unit})? `
                        + 'This cannot be undone.')) return
                      try {
                        await deleteWorkOrder(wo.id)
                        qc.invalidateQueries({ queryKey: ['workorders'] })
                        notifyOk(`Work order #${wo.id} deleted`)
                        onClose()
                      } catch (e) {
                        notifyErr("Couldn't delete", e)
                      }
                    }}
                  >
                    Delete work order
                  </button>
                </section>
              </div>
            </>
          )}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

// ----- Barra de etapas secuencial (estilo UNIQ TMS) -----------------------
// Hover sobre una etapa futura previsualiza el camino completo (tinte en
// las intermedias); el clic salta directo y el backend valida los gates.
function StageBar({ wo, busy, onGo }: {
  wo: WorkOrder
  busy: boolean
  onGo: (s: WoStatus) => void
}) {
  const [hover, setHover] = useState<number | null>(null)
  const idx = PIPELINE.indexOf(wo.status)
  return (
    <div className="wo-stagebar" role="group"
      aria-label="Work order pipeline"
      onMouseLeave={() => setHover(null)}>
      {PIPELINE.map((s, i) => {
        const state = i < idx ? 'past' : i === idx ? 'now' : 'future'
        const preview = hover != null && i > idx && i <= hover
        return (
          <button
            key={s}
            className={`wo-stage ${state} ${preview ? 'preview' : ''}`}
            disabled={busy || i === idx}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onClick={() => onGo(s)}
            title={i < idx
              ? `Back to ${STATUS_META[s].label}`
              : i === idx ? 'Current stage' : `Move to ${STATUS_META[s].label}`}
          >
            {STATUS_META[s].label}
          </button>
        )
      })}
    </div>
  )
}
