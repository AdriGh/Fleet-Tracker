import { useEffect, useMemo, useRef, useState } from 'react'
import { Drawer } from 'vaul'
import {
  keepPreviousData, useQuery, useQueryClient,
} from '@tanstack/react-query'
import {
  addWoLine, createWorkOrder, deleteWoLine, deleteWorkOrder,
  getOrg, getUnitOdometer, getWorkOrder, listFleet, listParts,
  listWorkOrders, patchWorkOrder, scanWoDocument, sendWoInvoice,
  type NotifyChannel, type Part, type WorkOrder, type WoPriority,
  type WoScanLine, type WoStatus,
} from '../api'
import { notifyOk, notifyErr } from '../toast'
import { useTerminals } from '../terminal'
import { usePerms } from '../perms'
import Modal from '../components/Modal'
import Skeleton from '../components/Skeleton'
import StatCard from '../components/StatCard'
import WorkOrderInvoice from '../components/WorkOrderInvoice'

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

// Catálogo de partes (H3): busca una parte por número exacto.
function findPart(parts: Part[], pn: string): Part | undefined {
  const k = (pn || '').trim().toLowerCase()
  return k ? parts.find((p) => p.part_number.toLowerCase() === k) : undefined
}

// Datalist compartido de part numbers (el option muestra la descripción).
function PartOptions({ id, parts }: { id: string; parts: Part[] }) {
  return (
    <datalist id={id}>
      {parts.map((p) => (
        <option key={p.id} value={p.part_number}>{p.description}</option>
      ))}
    </datalist>
  )
}

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
  const { can } = usePerms()
  const { terminalOf, labelOf, present } = useTerminals()
  const [statusFilter, setStatusFilter] = useState('')
  const [terminal, setTerminal] = useState('')
  const [q, setQ] = useState('')
  const [openWo, setOpenWo] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)

  const listQ = useQuery({
    queryKey: ['workorders', statusFilter],
    queryFn: () => listWorkOrders(statusFilter),
    // Conserva la tabla previa al cambiar de status: sin esto `wos`
    // queda [] durante el refetch y los chips parpadean (se desmontan).
    placeholderData: keepPreviousData,
  })
  const wos = listQ.data?.workorders ?? []
  const stats = listQ.data?.stats
  const mechanics = listQ.data?.mechanics ?? []

  // Chips de terminal (Settings → Terminals); solo si hay más de una.
  // Pasar company para que las unidades MCC sin prefijo caigan en 'MCC'
  // (sin chip) y no bajo Chaser.
  const woTerminals = useMemo(
    () => present(wos.map((w) => ({ unit: w.unit, company: w.company }))),
    [wos, present])

  // Si el terminal elegido ya no está presente (p.ej. al cambiar de
  // status sus WOs son de otra terminal), los chips colapsan y el filtro
  // quedaría aplicado e invisible -> limpiarlo para no esconder filas.
  useEffect(() => {
    if (terminal && !woTerminals.includes(terminal)) setTerminal('')
  }, [terminal, woTerminals])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    return wos.filter((w) =>
      (!terminal || terminalOf(w.unit, w.company) === terminal) &&
      (!s ||
        w.unit.toLowerCase().includes(s) ||
        w.title.toLowerCase().includes(s) ||
        w.mechanic.toLowerCase().includes(s) ||
        String(w.id) === s))
  }, [wos, q, terminal, terminalOf])

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
          {can('maint.edit') && (
            <button className="btn btn-primary"
              onClick={() => setCreating(true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" width="17" height="17" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              New work order
            </button>
          )}
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
          {woTerminals.length > 1 && (
            <div className="company-tabs" role="tablist"
              aria-label="Terminal">
              <button
                className={`tab-btn ${terminal === '' ? 'active' : ''}`}
                onClick={() => setTerminal('')}>All terminals</button>
              {woTerminals.map((t) => (
                <button key={t}
                  className={`tab-btn ${terminal === t ? 'active' : ''}`}
                  onClick={() => setTerminal(terminal === t ? '' : t)}>
                  {labelOf(t)}
                </button>
              ))}
            </div>
          )}
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

// Un complaint en edición: un invoice puede traer varios (un PM al camión
// y una llanta al trailer), cada uno con su unidad y millaje.
type ComplaintDraft = {
  unit: string; mileage: string; detail: string; is_pm: boolean
}
const emptyComplaint = (): ComplaintDraft =>
  ({ unit: '', mileage: '', detail: '', is_pm: false })

type SharedInvoice = {
  vendor: string; city: string; state: string; invoice: string; date: string
}

// Formato del complaint pedido por el usuario:
//   ISSUE DESCRIPTION (≤4 líneas)
//   SHOP NAME, CITY, STATE
//   <blank>
//    Shop Invoice # NUM | DATE
//   UNIT # - MILEAGE
function formatComplaint(c: ComplaintDraft, s: SharedInvoice): string {
  // Cabecera: descripción + shop. Pie: invoice + unidad/millaje.
  const head: string[] = []
  if (c.detail.trim()) head.push(c.detail.trim())
  const loc = [s.vendor, s.city, s.state]
    .map((x) => x.trim()).filter(Boolean).join(', ')
  if (loc) head.push(loc)
  const foot: string[] = []
  const inv = [
    s.invoice.trim() ? `Shop Invoice # ${s.invoice.trim()}` : '',
    s.date.trim(),
  ].filter(Boolean).join(' | ')
  if (inv) foot.push(' ' + inv)
  const um = [c.unit.trim(), c.mileage.trim()].filter(Boolean).join(' - ')
  if (um) foot.push(um)
  // Línea en blanco SOLO si hay cabecera y pie (sin ella si falta uno).
  const parts = [...head]
  if (head.length && foot.length) parts.push('')
  parts.push(...foot)
  return parts.join('\n')
}

function CreateWoModal({ mechanics, onClose, onCreated }: {
  mechanics: string[]
  onClose: () => void
  onCreated: (id: number) => void
}) {
  const fleetQ = useQuery({ queryKey: ['fleet'], queryFn: listFleet })
  const partsQ = useQuery({ queryKey: ['parts'], queryFn: listParts })
  const orgQ = useQuery({ queryKey: ['org'], queryFn: getOrg })
  const laborRate = orgQ.data?.labor_rate ?? 0
  const catalog = partsQ.data?.parts ?? []
  const units = useMemo(
    () => (fleetQ.data ?? []).filter((u) => !u.archived)
      .map((u) => u.unit).sort(),
    [fleetQ.data])
  const [unit, setUnit] = useState('')
  const [complaints, setComplaints] = useState<ComplaintDraft[]>(
    () => [emptyComplaint()])
  const [vendor, setVendor] = useState('')
  const [vendorCity, setVendorCity] = useState('')
  const [vendorState, setVendorState] = useState('')
  const [invoiceNum, setInvoiceNum] = useState('')
  const [mechanic, setMechanic] = useState('')
  const [priority, setPriority] = useState<WoPriority>('normal')
  const [campaign, setCampaign] = useState('')
  const [mileage, setMileage] = useState('')
  const [date, setDate] = useState(todayISO())

  function setComplaint(i: number, patch: Partial<ComplaintDraft>) {
    setComplaints((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  }
  function addComplaint() {
    setComplaints((cs) => [...cs, emptyComplaint()])
  }
  function removeComplaint(i: number) {
    setComplaints((cs) => cs.filter((_, j) => j !== i))
  }
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

  // Cambiar a labor con costo en 0 -> prefijar con la tarifa del taller.
  function setLineKind(i: number, kind: 'part' | 'labor') {
    setScanLines((ls) => ls.map((l, j) => (j === i ? {
      ...l, kind,
      unit_cost: (kind === 'labor' && !l.unit_cost && laborRate)
        ? laborRate : l.unit_cost,
      part_number: kind === 'labor' ? '' : l.part_number,
    } : l)))
  }

  // Al escribir/elegir un part# del catálogo, autollenar desc + costo.
  function setLinePart(i: number, pn: string) {
    const hit = findPart(catalog, pn)
    setScanLines((ls) => ls.map((l, j) => (j === i ? {
      ...l, part_number: pn,
      ...(hit ? { description: l.description || hit.description,
                  unit_cost: hit.cost } : {}),
    } : l)))
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
      const cs = (x.complaints ?? []).map((c) => ({
        unit: c.unit ?? '',
        mileage: c.mileage != null ? String(c.mileage) : '',
        detail: c.detail ?? '',
        is_pm: !!c.is_pm,
      }))
      if (cs.length) {
        setComplaints(cs)
        const first = cs[0]
        if (first.unit) setUnit(first.unit)
        if (first.mileage) setMileage(first.mileage)
        if (cs.some((c) => c.is_pm)) setCampaign('pm')
      }
      if (x.service_date) setDate(x.service_date)
      if (x.vendor) setVendor(x.vendor)
      if (x.vendor_city) setVendorCity(x.vendor_city)
      if (x.vendor_state) setVendorState(x.vendor_state)
      if (x.invoice_number) setInvoiceNum(x.invoice_number)
      if (x.mechanic) setMechanic(x.mechanic)
      setScanLines(x.lines)
      notifyOk('Document scanned',
        `${cs.length} complaint${cs.length === 1 ? '' : 's'}, ` +
        `${x.lines.length} line${x.lines.length === 1 ? '' : 's'} · ${r.model}`)
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

  // Title de un WO: si tiene campaña, el NOMBRE de la campaña (p.ej.
  // "Full Wet Service (PM)"); si no, la 1ª línea del complaint.
  const labelOfCampaign = (camp: string) =>
    CAMPAIGN_OPTS.find((c) => c.key === camp)?.label
  const titleFor = (cs: ComplaintDraft[], camp: string) => {
    const lbl = camp ? labelOfCampaign(camp) : ''
    const first = cs[0]?.detail.trim().split('\n')[0] || 'Work order'
    return (lbl || first).slice(0, 80)
  }

  async function submit() {
    if (!unit.trim()) {
      notifyErr('Missing unit', 'Pick the unit for this work order')
      return
    }
    const kept = complaints.filter((c) => c.detail.trim())
    if (!kept.length) {
      notifyErr('Missing complaint', 'Add at least one issue detail')
      return
    }
    // Agrupar complaints por unidad: cada unidad distinta genera su PROPIO
    // work order (un PM al tractor + una llanta al trailer => WO#1 y WO#2).
    // Los complaints sin unidad caen en la unidad seleccionada (primaria).
    const primaryU = unit.trim().toUpperCase()
    const groups = new Map<string, ComplaintDraft[]>()
    for (const c of kept) {
      const u = c.unit.trim().toUpperCase() || primaryU
      groups.set(u, [...(groups.get(u) ?? []), c])
    }
    const others = [...groups.keys()].filter((u) => u !== primaryU)
    if (others.length && !window.confirm(
      `This invoice covers ${groups.size} units. Create ${groups.size} work `
      + `orders — ${unit.trim()} + ${others.join(', ')}? The cost lines go on `
      + `the ${unit.trim()} order; the others are created so each unit has its `
      + `own service record.`)) {
      return
    }

    setSaving(true)
    try {
      const shared: SharedInvoice = {
        vendor, city: vendorCity, state: vendorState,
        invoice: invoiceNum, date,
      }
      const lines = scanLines.filter((l) => l.description.trim())
      const shopInv = invoiceNum.trim()

      // 1) Orden PRIMARIA (la unidad seleccionada): lleva las líneas/costos.
      const primaryCs = groups.get(primaryU) ?? []
      const primaryCamp = campaign
        || (primaryCs.some((c) => c.is_pm) ? 'pm' : '')
      const primaryWo = await createWorkOrder({
        unit: unit.trim(),
        title: titleFor(primaryCs, primaryCamp),
        complaint: primaryCs.map((c) => formatComplaint(c, shared)).join('\n\n'),
        mechanic, priority, campaign: primaryCamp, shop_invoice: shopInv,
        mileage: mileage ? Number(mileage)
          : (primaryCs[0]?.mileage ? Number(primaryCs[0].mileage) : null),
        service_date: date,
        source: scanName ? 'scan' : 'manual',
      })
      for (const ln of lines) {
        await addWoLine(primaryWo.id, {
          kind: ln.kind, description: ln.description.trim(),
          qty: Number(ln.qty) || 1, unit_cost: Number(ln.unit_cost) || 0,
          part_number: ln.part_number ?? '',
        })
      }

      // 2) Una orden por cada OTRA unidad (stub: complaint sin líneas, para
      // que aparezca en el perfil de esa unidad y se le carguen costos luego).
      for (const ou of others) {
        const cs = groups.get(ou)!
        const camp = cs.some((c) => c.is_pm) ? 'pm' : ''
        await createWorkOrder({
          unit: ou,
          title: titleFor(cs, camp),
          complaint: cs.map((c) => formatComplaint(c, shared)).join('\n\n'),
          mechanic, priority, campaign: camp, shop_invoice: shopInv,
          mileage: cs[0]?.mileage ? Number(cs[0].mileage) : null,
          service_date: date,
          source: scanName ? 'scan' : 'manual',
        })
      }

      const n = groups.size
      notifyOk(n > 1 ? `${n} work orders created` : 'Work order created',
        `#${primaryWo.id} ${primaryWo.unit}`
        + (others.length ? ` + ${others.join(', ')}` : '')
        + (lines.length ? ` · ${lines.length} cost lines` : ''))
      onCreated(primaryWo.id)
    } catch (e) {
      notifyErr('Could not create', e)
    } finally {
      setSaving(false)
    }
  }

  const scanTotal = scanLines.reduce(
    (s, l) => s + l.qty * l.unit_cost, 0)

  return (
    <Modal title="New work order" width={1360} fullHeight onClose={onClose}>
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
        {/* Invoice compartido: alimenta el formato de cada complaint */}
        <div className="wo-form-row wo-shop-row">
          <label className="ud-field">
            <span>Shop</span>
            <input className="cell-input" value={vendor}
              placeholder="Love's Truck Care"
              onChange={(e) => setVendor(e.target.value)} />
          </label>
          <label className="ud-field wo-city-field">
            <span>City</span>
            <input className="cell-input" value={vendorCity}
              onChange={(e) => setVendorCity(e.target.value)} />
          </label>
          <label className="ud-field wo-state-field">
            <span>St</span>
            <input className="cell-input" value={vendorState} maxLength={2}
              onChange={(e) =>
                setVendorState(e.target.value.toUpperCase())} />
          </label>
          <label className="ud-field">
            <span>Invoice #</span>
            <input className="cell-input" value={invoiceNum}
              onChange={(e) => setInvoiceNum(e.target.value)} />
          </label>
        </div>

        {/* Complaints: uno por job. El que no corresponde a la unidad
            seleccionada se marca y se puede borrar. */}
        <div className="wo-complaints">
          <div className="wo-lines-edit-head">
            <span>Complaints</span>
            <button className="btn btn-ghost btn-xs" onClick={addComplaint}>
              + Add complaint
            </button>
          </div>
          {complaints.map((c, i) => {
            const mismatch = !!unit.trim() && !!c.unit.trim() &&
              c.unit.trim().toUpperCase() !== unit.trim().toUpperCase()
            return (
              <div key={i}
                className={`wo-complaint ${mismatch ? 'is-mismatch' : ''}`}>
                <div className="wo-complaint-head">
                  <input className="cell-input wo-complaint-unit"
                    value={c.unit} placeholder="Unit #"
                    onChange={(e) =>
                      setComplaint(i, { unit: e.target.value })} />
                  <input className="cell-input wo-complaint-mi" type="number"
                    value={c.mileage} placeholder="mi"
                    onChange={(e) =>
                      setComplaint(i, { mileage: e.target.value })} />
                  {mismatch && (
                    <span className="wo-complaint-warn"
                      title="This complaint is for a different unit than the work order">
                      different unit
                    </span>
                  )}
                  <span className="head-spacer" />
                  {complaints.length > 1 && (
                    <button className="mnt-icon" title="Remove complaint"
                      onClick={() => removeComplaint(i)}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth="1.8" strokeLinecap="round">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  )}
                </div>
                <textarea className="cell-input ud-notes" rows={3}
                  value={c.detail}
                  placeholder="Issue description, short and clear (max 4 lines)"
                  onChange={(e) =>
                    setComplaint(i, { detail: e.target.value })} />
              </div>
            )
          })}
        </div>
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
            <div key={i} className="wo-line-row wo-line-row-cat">
              <select className="cell-input" value={ln.kind}
                onChange={(e) => setLineKind(i,
                  e.target.value as 'part' | 'labor')}>
                <option value="part">Part</option>
                <option value="labor">Labor</option>
              </select>
              <input className="cell-input" list="wo-catalog-parts"
                title="Part number (catalog)"
                placeholder={ln.kind === 'part' ? 'Part #' : '—'}
                disabled={ln.kind === 'labor'}
                value={ln.part_number ?? ''}
                onChange={(e) => setLinePart(i, e.target.value)} />
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
          <PartOptions id="wo-catalog-parts" parts={catalog} />
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
  const { can } = usePerms()
  const open = woId != null
  const woQ = useQuery({
    queryKey: ['workorder', woId],
    queryFn: () => getWorkOrder(woId!),
    enabled: open,
  })
  const wo = woQ.data ?? null

  const partsQ = useQuery({ queryKey: ['parts'], queryFn: listParts })
  const orgQ = useQuery({ queryKey: ['org'], queryFn: getOrg })
  const fleetQ = useQuery({ queryKey: ['fleet'], queryFn: listFleet })
  const laborRate = orgQ.data?.labor_rate ?? 0
  const catalog = partsQ.data?.parts ?? []
  const org = orgQ.data
  // Datos de la unidad (VIN/año/marca/modelo) para el documento, de la
  // caché de /fleet (no se le pega a Samsara al imprimir/enviar).
  const unitInfo = useMemo(
    () => (fleetQ.data ?? []).find((u) => u.unit === wo?.unit),
    [fleetQ.data, wo?.unit])
  const [lineKind, setLineKind] = useState<'part' | 'labor'>('part')
  const [linePart, setLinePart] = useState('')
  const [lineDesc, setLineDesc] = useState('')
  const [lineQty, setLineQty] = useState('1')
  const [lineCost, setLineCost] = useState('')
  const [pmMiles, setPmMiles] = useState('')
  const [busy, setBusy] = useState(false)
  // H3-C: documento imprimible + panel de envío.
  const [showDoc, setShowDoc] = useState(false)
  const [sendOpen, setSendOpen] = useState(false)
  const [toEmail, setToEmail] = useState('')
  const [toPhone, setToPhone] = useState('')
  const [chEmail, setChEmail] = useState(true)
  const [chSms, setChSms] = useState(false)
  const [sending, setSending] = useState(false)

  // Prefill del destinatario con el email de Bill-To de la empresa.
  useEffect(() => {
    if (wo && org) setToEmail(org.billing?.[wo.company]?.email ?? '')
  }, [wo?.id, org])

  // Elegir un part# del catálogo autollena descripción + costo.
  function pickPart(pn: string) {
    setLinePart(pn)
    const hit = findPart(catalog, pn)
    if (hit) {
      if (!lineDesc.trim()) setLineDesc(hit.description)
      setLineCost(String(hit.cost))
    }
  }

  // Cambiar el tipo de línea; al pasar a labor sin costo, traer la tarifa.
  function changeKind(kind: 'part' | 'labor') {
    setLineKind(kind)
    if (kind === 'labor') {
      setLinePart('')
      if (!lineCost.trim() && laborRate) setLineCost(String(laborRate))
    }
  }

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
        part_number: lineKind === 'part' ? linePart.trim() : '',
      })
      refreshWo(updated)
      setLinePart(''); setLineDesc(''); setLineQty('1'); setLineCost('')
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

  // H3-C: enviar el estimate/invoice por email (real) y/o SMS.
  async function sendDoc() {
    if (!wo) return
    const channels: NotifyChannel[] = []
    if (chEmail) channels.push('email')
    if (chSms) channels.push('sms')
    if (!channels.length) {
      notifyErr('Pick a channel', 'Email or SMS')
      return
    }
    setSending(true)
    try {
      const r = await sendWoInvoice(wo.id, {
        channels, email: toEmail.trim(), phone: toPhone.trim(),
        unit_info: unitInfo
          ? { vin: unitInfo.vin, year: unitInfo.year,
              make: unitInfo.make, model: unitInfo.model }
          : {},
      })
      const parts: string[] = []
      const fmt = (c: { ok: boolean; simulated: boolean; to: string;
                        error: string } | undefined, label: string) => {
        if (!c) return
        parts.push(c.ok
          ? (c.simulated ? `${label} simulated (dry run)`
                         : `${label} sent to ${c.to}`)
          : `${label} failed: ${c.error}`)
      }
      fmt(r.results.email, 'Email')
      fmt(r.results.sms, 'SMS')
      const anyFail = (r.results.email && !r.results.email.ok)
        || (r.results.sms && !r.results.sms.ok)
      if (anyFail) notifyErr('Send issue', parts.join(' · '))
      else { notifyOk('Document sent', parts.join(' · ')); setSendOpen(false) }
    } catch (e) {
      notifyErr('Could not send', e)
    } finally {
      setSending(false)
    }
  }

  return (
    <>
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
                <StageBar wo={wo} busy={busy} onGo={setStatus}
                  canInvoice={can('wo.invoice')} />

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

                {/* H3-C: documento imprimible + envío */}
                <div className="wo-doc-actions">
                  <button className="btn btn-ghost btn-xs" disabled={!org}
                    onClick={() => setShowDoc(true)}>
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
                      stroke="currentColor" strokeWidth="1.8"
                      strokeLinecap="round" strokeLinejoin="round">
                      <path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M6 14h12v7H6z" />
                    </svg>
                    Print {wo.status === 'invoiced' ? 'invoice' : 'estimate'}
                  </button>
                  {can('wo.invoice') && (
                    <button
                      className={`btn btn-ghost btn-xs ${sendOpen ? 'is-on' : ''}`}
                      onClick={() => setSendOpen((o) => !o)}>
                      Email / SMS
                    </button>
                  )}
                </div>
                {sendOpen && (
                  <div className="wo-send-panel">
                    <div className="wo-send-channels">
                      <label className="wo-check">
                        <input type="checkbox" checked={chEmail}
                          onChange={(e) => setChEmail(e.target.checked)} />
                        Email
                      </label>
                      <label className="wo-check">
                        <input type="checkbox" checked={chSms}
                          onChange={(e) => setChSms(e.target.checked)} />
                        SMS
                      </label>
                    </div>
                    {chEmail && (
                      <label className="ud-field">
                        <span>Recipient email</span>
                        <input className="cell-input" type="email" value={toEmail}
                          placeholder="customer@example.com"
                          onChange={(e) => setToEmail(e.target.value)} />
                      </label>
                    )}
                    {chSms && (
                      <label className="ud-field">
                        <span>Recipient phone</span>
                        <input className="cell-input" type="tel" value={toPhone}
                          placeholder="+1 901 555 0142"
                          onChange={(e) => setToPhone(e.target.value)} />
                      </label>
                    )}
                    <div className="settings-actions">
                      <button className="btn btn-primary btn-xs" onClick={sendDoc}
                        disabled={sending}>
                        {sending ? 'Sending…' : 'Send'}
                      </button>
                    </div>
                    <p className="ud-muted wo-send-note">
                      Email sends the full document; SMS sends a short summary.
                      Live or dry run status shows after sending.
                    </p>
                  </div>
                )}

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
                  {/* H3-C: datos del invoice (van al documento imprimible) */}
                  <div className="wo-meta-row">
                    <label className="ud-field">
                      <span>Shop invoice #</span>
                      <input className="cell-input" defaultValue={wo.shop_invoice}
                        placeholder="external shop"
                        onBlur={(e) => {
                          if (e.target.value !== wo.shop_invoice) {
                            saveField({ shop_invoice: e.target.value })
                          }
                        }} />
                    </label>
                    <label className="ud-field">
                      <span>Customer PO #</span>
                      <input className="cell-input" defaultValue={wo.po_number}
                        placeholder="optional"
                        onBlur={(e) => {
                          if (e.target.value !== wo.po_number) {
                            saveField({ po_number: e.target.value })
                          }
                        }} />
                    </label>
                    <label className="ud-field">
                      <span>Authorizer</span>
                      <input className="cell-input" defaultValue={wo.authorizer}
                        placeholder="optional"
                        onBlur={(e) => {
                          if (e.target.value !== wo.authorizer) {
                            saveField({ authorizer: e.target.value })
                          }
                        }} />
                    </label>
                  </div>
                  {wo.invoice_number && (
                    <p className="ud-muted wo-invnum">
                      Fleet Tracker invoice&nbsp;#:{' '}
                      <strong>{wo.invoice_number}</strong> · format in
                      Settings, Company
                    </p>
                  )}
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
                            <td className="wo-line-desc">
                              {ln.part_number && (
                                <span className="wo-line-pn">{ln.part_number}</span>
                              )}
                              {ln.description}
                            </td>
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
                      onChange={(e) => changeKind(
                        e.target.value as 'part' | 'labor')}>
                      <option value="part">Part</option>
                      <option value="labor">Labor</option>
                    </select>
                    {lineKind === 'part' && (
                      <input className="cell-input wo-line-add-pn"
                        list="wo-drawer-parts" title="Part number (catalog)"
                        placeholder="Part #" value={linePart}
                        onChange={(e) => pickPart(e.target.value)} />
                    )}
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
                    <PartOptions id="wo-drawer-parts" parts={catalog} />
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
    {showDoc && wo && org && (
      <WorkOrderInvoice wo={wo} org={org} unit={unitInfo}
        onClose={() => setShowDoc(false)} />
    )}
    </>
  )
}

// ----- Barra de etapas secuencial (estilo UNIQ TMS) -----------------------
// Hover sobre una etapa futura previsualiza el camino completo (tinte en
// las intermedias); el clic salta directo y el backend valida los gates.
function StageBar({ wo, busy, onGo, canInvoice }: {
  wo: WorkOrder
  busy: boolean
  onGo: (s: WoStatus) => void
  canInvoice: boolean
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
            disabled={busy || i === idx
              || (s === 'invoiced' && !canInvoice)}
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
