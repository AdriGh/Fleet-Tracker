import {
  Fragment, useEffect, useMemo, useRef, useState, type DragEvent,
} from 'react'
import { Drawer } from 'vaul'
import {
  keepPreviousData, useQuery, useQueryClient, type QueryClient,
} from '@tanstack/react-query'
import {
  addWoLine, createPartsRequest, createWorkOrder, deleteWoInvoiceFile,
  deleteWoLine,
  deleteWorkOrder, downloadWoInvoiceFile, fetchWoInvoiceThumbUrl,
  getOrg, getUnitOdometer,
  getWorkOrder, listFleet, listParts, listWorkOrders, patchWorkOrder,
  scanWoDocument, sendWoInvoice, unlinkRequest, uploadWoInvoiceFile,
  viewWoInvoiceFile,
  type EvidencePhoto, type NotifyChannel, type Part, type SrSource,
  type WorkOrder, type WoPriority, type WoScanLine, type WoStatus,
} from '../api'
import EvidenceGallery, {
  useEvidenceList, useEvidencePhotoUrl,
} from '../components/EvidenceGallery'
import { notifyOk, notifyErr, notifyWarn } from '../toast'
import { useTerminals } from '../terminal'
import { usePerms } from '../perms'
import { Badge, Button, Tabs } from '../components/ds'
import Modal from '../components/Modal'
import Skeleton from '../components/Skeleton'
import StatCard from '../components/StatCard'
import UnitPicker from '../components/UnitPicker'
import { normUnit, useKnownUnits, useUnitMatcher } from '../unitMatch'
import { StatCluster } from '../components/ds'
import WorkOrderInvoice from '../components/WorkOrderInvoice'
import { CreatePoModal } from './PurchaseOrdersPage'

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
// Vistas de la misma data (v2, patrón de 3-vistas de Parts): planilla, grid
// de tarjetas, kanban por estado, e History (facturadas, separadas).
type WoView = 'list' | 'grid' | 'board' | 'history'
// Estados activos (invoiced vive en History): alimentan el filtro de status
// de List/Grid y las columnas del kanban (Board).
const ACTIVE_PIPELINE: WoStatus[] = [
  'open', 'assigned', 'in_progress', 'completed',
]
// Forma del cache de la lista (para updates optimistas del kanban).
type WoListData = Awaited<ReturnType<typeof listWorkOrders>>
const PRIORITY_META: Record<WoPriority, { label: string; cls: string }> = {
  low: { label: 'Low', cls: 'pr-low' },
  normal: { label: 'Normal', cls: 'pr-normal' },
  high: { label: 'High', cls: 'pr-high' },
}

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const dateOf = (iso: string | null) => (iso ? iso.slice(0, 10) : '—')

// Búsqueda libre de la página (List/Grid/Board/History): unidad, título,
// mecánico o nº de WO. El nº acepta el id interno o el display ("4", "4.1",
// con o sin "#"); "4" también trae las hijas 4.1, 4.2… del mismo invoice.
function matchesSearch(w: WorkOrder, s: string): boolean {
  if (!s) return true
  const no = s.replace(/^#/, '')
  const disp = (w.display_no ?? '').toLowerCase()
  return w.unit.toLowerCase().includes(s)
    || w.title.toLowerCase().includes(s)
    || w.mechanic.toLowerCase().includes(s)
    || String(w.id) === no
    || (!!no && (disp === no || disp.startsWith(`${no}.`)))
}

// ----- Cambio de estado compartido (drawer + kanban) ---------------------
// Mover una WO de estado desde el drawer (setStatus) o arrastrando en el
// Board (moveWo) usa el MISMO patch y los MISMOS efectos laterales.

// ¿El estado destino está en completed o más allá?
const reachesCompleted = (s: WoStatus) =>
  PIPELINE.indexOf(s) >= PIPELINE.indexOf('completed')

// Patch del cambio de estado. Una WO de PM que llega a completed manda el
// odómetro del cierre para que el PM tracker registre el servicio: el valor
// tipeado en el drawer o, si no hay, el millaje de la propia WO (el Board no
// tiene input). Si la WO ya tiene pm_miles, el backend lo reusa tal cual.
function statusPatch(
  wo: WorkOrder, s: WoStatus, typedMiles = '',
): Partial<WorkOrder> {
  const patch: Partial<WorkOrder> = { status: s }
  if (reachesCompleted(s) && wo.is_pm) {
    const typed = Number(typedMiles.trim())
    if (typedMiles.trim() && Number.isFinite(typed) && typed > 0) {
      patch.pm_miles = typed
    } else if (!wo.pm_miles && wo.mileage) {
      patch.pm_miles = wo.mileage
    }
  }
  return patch
}

// Funde la respuesta de un PATCH/línea en el detalle cacheado del drawer:
// {...prev, ...updated} conserva `links` (los arma getWorkOrder) aunque la
// respuesta no los traiga.
function mergeWoDetail(qc: QueryClient, updated: WorkOrder) {
  qc.setQueryData<WorkOrder>(['workorder', updated.id], (prev) =>
    (prev ? { ...prev, ...updated } : updated))
}

// Vistas que listan WOs fuera del detalle: board/lista, perfil de unidad y
// el backlog de service requests (una WO que cambia de estado los afecta).
function invalidateWoLists(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ['workorders'] })
  qc.invalidateQueries({ queryKey: ['unit-wos'] })
  qc.invalidateQueries({ queryKey: ['service-requests'] })
}

// Efectos tras un cambio de estado exitoso: PM tracker + toasts (PM y
// Telegram). `quiet` omite el toast genérico de estado (en el Board la
// tarjeta ya se ve moverse).
function afterStatusChange(qc: QueryClient, updated: WorkOrder, opts: {
  from: WoStatus; to: WoStatus; quiet?: boolean
}) {
  const { from, to, quiet } = opts
  if (reachesCompleted(to) && updated.is_pm && updated.pm_miles) {
    qc.invalidateQueries({ queryKey: ['pm'] })
    qc.invalidateQueries({ queryKey: ['maint'] })
    notifyOk('PM updated',
      `${updated.unit} · last PM ${updated.pm_miles.toLocaleString()} mi`)
  } else if (reachesCompleted(to) && !reachesCompleted(from)
             && updated.is_pm) {
    // Sin odómetro el hook PM del backend no corre: avisar en vez de callar.
    notifyWarn('PM tracker not updated',
      'This PM work order has no odometer. Open it and enter the mileage to record the PM.')
  } else if (!quiet) {
    notifyOk(`WO #${updated.display_no || updated.id}: ${STATUS_META[to].label}`)
  }
  if (updated.telegram) {
    if (updated.telegram.simulated) {
      notifyOk('Telegram (dry run)', 'Simulated, nothing sent')
    } else if (updated.telegram.sent) {
      notifyOk('Telegram sent', 'Shop group notified')
    } else {
      notifyErr('Telegram failed', updated.telegram.detail
        ? new Error(updated.telegram.detail) : undefined)
    }
  }
}

// Etiqueta de la fuente de un service request ligado (v2.20); las mismas que
// usa el backend en las viñetas del complaint.
const SR_SOURCE_LABEL: Record<SrSource, string> = {
  defect: 'DVIR defect', pm: 'PM due', dot: 'DOT due', manual: 'Request',
}

// Tarjeta de WO reutilizada por Grid y Board (kanban). `draggable` solo si el
// usuario puede editar (para arrastrar entre columnas del board).
function WoCard({ w, onOpen, draggable, onDragStart }: {
  w: WorkOrder
  onOpen: (id: number) => void
  draggable?: boolean
  onDragStart?: (e: DragEvent) => void
}) {
  return (
    <article
      className={`wo-card ${draggable ? 'is-draggable' : ''}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={() => onOpen(w.id)}
    >
      <div className="wo-card-top">
        <span className="mono wo-card-id">#{w.display_no}</span>
        <span className={`wo-status ${STATUS_META[w.status].cls}`}>
          {STATUS_META[w.status].label}
        </span>
      </div>
      <div className="wo-card-title" title={w.title}>{w.title}</div>
      <div className="wo-card-meta">
        <span className="unit-code">{w.unit}</span>
        {w.is_pm && <span className="wo-pm-tag">PM</span>}
        {w.waiting_parts && (
          <span className="wo-wait-tag" title="Waiting for parts">parts</span>
        )}
      </div>
      <div className="wo-card-foot">
        <span className={`wo-priority ${PRIORITY_META[w.priority].cls}`}>
          {PRIORITY_META[w.priority].label}
        </span>
        <span className="wo-card-mech" title={w.mechanic}>
          {w.mechanic || '—'}
        </span>
        <span className="mono wo-card-total">
          {w.total ? money(w.total) : '—'}
        </span>
      </div>
    </article>
  )
}
// Fecha + hora corta (MM-DD · HH:MM) para la línea de tiempo de actividad.
const stampOf = (iso: string | null) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} · `
    + `${p(d.getHours())}:${p(d.getMinutes())}`
}

// --- Increment C: diagnóstico de falla de reefer -------------------------
// El puente reefer→WO (backend core/reefer_wo.py) NO guarda telemetría en
// columnas: incrusta el snapshot capturado al disparar la alarma DENTRO del
// texto del complaint, en un formato estable:
//   "Code <X>: <desc>."
//   "Operator action: <act>."
//   "Snapshot: setpoint N°F, return N°F, mode <m>."
//   "[rf:<X>]"
// Esto parsea ESE texto real (sin inventar datos). Solo se usa para WOs con
// source==='reefer'; si un campo no está en el complaint, se omite la celda.
type FaultDiag = {
  code?: string
  desc?: string
  action?: string
  source?: string
  cells: { k: string; v: string; u?: string }[]
}
function parseReeferFault(complaint: string): FaultDiag | null {
  const text = complaint || ''
  const diag: FaultDiag = { cells: [] }
  const code = text.match(/\[rf:([^\]]+)\]/)
    || text.match(/\bCode\s+([^\s:]+)/i)
  if (code) diag.code = code[1].trim()
  const desc = text.match(/\bCode\s+[^\s:]+:\s*([^\n.]+)/i)
  if (desc) diag.desc = desc[1].trim()
  const action = text.match(/Operator action:\s*([^\n.]+)/i)
  if (action) diag.action = action[1].trim()
  const src = text.match(/\(([^)]+)\)\.?\s*\n/) // "...on UNIT (lynx)."
  if (src) diag.source = src[1].trim()
  // Celdas del snapshot: solo las realmente presentes en el texto.
  const setp = text.match(/setpoint\s+(-?[\d.]+)\s*°?F/i)
  if (setp) diag.cells.push({ k: 'Setpoint', v: setp[1], u: '°F' })
  const ret = text.match(/return\s+(-?[\d.]+)\s*°?F/i)
  if (ret) diag.cells.push({ k: 'Return air', v: ret[1], u: '°F' })
  const sup = text.match(/(?:supply|discharge)\s+(-?[\d.]+)\s*°?F/i)
  if (sup) diag.cells.push({ k: 'Supply', v: sup[1], u: '°F' })
  const mode = text.match(/mode\s+([A-Za-z0-9_-]+)/i)
  if (mode) diag.cells.push({ k: 'Run mode', v: mode[1] })
  // Solo vale la pena la tarjeta si hay código o al menos una celda real.
  return (diag.code || diag.cells.length) ? diag : null
}

// Línea de tiempo de actividad: SOLO hitos reales del ciclo de vida del WO
// (timestamps que el registro ya tiene). No hay tabla de eventos/auditoría
// por-WO en el backend, así que NO se fabrica un trail multi-actor.
type WoEvent = { when: string; label: string; sub?: string; tone: string }
function woTimeline(wo: WorkOrder): WoEvent[] {
  const ev: WoEvent[] = []
  if (wo.created_at) {
    ev.push({
      when: wo.created_at,
      label: wo.source === 'reefer' ? 'Opened from reefer fault'
        : wo.source === 'defect' ? 'Opened from defect'
          : wo.source === 'request' ? 'Opened from service request'
            : wo.source === 'scan' ? 'Opened from scanned invoice'
              : 'Work order opened',
      tone: wo.source === 'reefer' ? 'accent' : 'info',
    })
  }
  if (wo.service_date) {
    ev.push({ when: wo.service_date, label: 'Service date', tone: 'info' })
  }
  if (wo.closed_at) {
    ev.push({ when: wo.closed_at, label: 'Marked completed', tone: 'ok' })
  }
  if (wo.invoiced_at) {
    ev.push({
      when: wo.invoiced_at,
      label: 'Invoiced',
      sub: wo.invoice_number ? `#${wo.invoice_number}` : undefined,
      tone: 'accent',
    })
  }
  // Orden cronológico estable por fecha.
  return ev.sort((a, b) =>
    new Date(a.when).getTime() - new Date(b.when).getTime())
}

// Catálogo de partes (H3): busca una parte por número exacto.
function findPart(parts: Part[], pn: string): Part | undefined {
  const k = (pn || '').trim().toLowerCase()
  return k ? parts.find((p) => p.part_number.toLowerCase() === k) : undefined
}

// Mejor alternativa EN STOCK para el banner de decisión: misma categoría y
// con mayor solape de palabras significativas en la descripción. Solo sugiere
// si hay solape real — así no ofrece p. ej. un cartucho de secador como
// reemplazo de una cámara de freno solo por compartir categoría.
function bestAlternative(catalog: Part[], cp: Part): Part | null {
  const words = new Set(
    (cp.description || '').toLowerCase().split(/\W+/)
      .filter((w) => w.length > 3))
  let best: Part | null = null
  let bestScore = 0
  for (const p of catalog) {
    if (p.part_number === cp.part_number) continue
    if ((p.category || '') !== (cp.category || '')) continue
    if ((p.on_hand || 0) <= 0) continue
    const score = (p.description || '').toLowerCase().split(/\W+/)
      .filter((w) => words.has(w)).length
    if (score > bestScore) { best = p; bestScore = score }
  }
  return bestScore > 0 ? best : null
}

// Input numérico que admite decimales mientras se escribe (review v1.18).
// Bug previo: un <input type="number"> con onChange={Number(e.target.value)}
// reseteaba "238." a 238 y "." a 0, así que el punto no se podía teclear.
// Solución: el input es texto (inputMode="decimal"), se respalda con la
// cadena CRUDA durante la edición y solo se parsea a número en cada cambio
// válido; al perder foco se normaliza al número final.
function DecimalInput({
  value, onChange, className, title, placeholder,
}: {
  value: number
  onChange: (n: number) => void
  className?: string
  title?: string
  placeholder?: string
}) {
  // Cadena en edición: null = mostrar el número del padre (no se está editando).
  const [raw, setRaw] = useState<string | null>(null)
  const shown = raw ?? (value === 0 ? '' : String(value))
  return (
    <input
      className={className}
      type="text"
      inputMode="decimal"
      title={title}
      placeholder={placeholder}
      value={shown}
      onChange={(e) => {
        const t = e.target.value
        // Permitir vacío, dígitos y UN punto (estados intermedios "238." o ".").
        if (t !== '' && !/^\d*\.?\d*$/.test(t)) return
        setRaw(t)
        const n = parseFloat(t)
        onChange(Number.isFinite(n) ? n : 0)
      }}
      onBlur={() => setRaw(null)}
    />
  )
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
  const [view, setView] = useState<WoView>('list')
  const [statusFilter, setStatusFilter] = useState('')
  const [terminal, setTerminal] = useState('')
  const [q, setQ] = useState('')
  const [openWo, setOpenWo] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  // Columna del kanban resaltada mientras se arrastra una tarjeta sobre ella.
  const [dragCol, setDragCol] = useState<WoStatus | null>(null)

  // Un solo fetch (todas las WOs); las 4 vistas filtran client-side. Las
  // stats del backend son globales, así que no dependen del filtro.
  const listQ = useQuery({
    queryKey: ['workorders', ''],
    queryFn: () => listWorkOrders(''),
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

  const editable = can('maint.edit')

  // List/Grid: activos (invoiced vive en History), con filtro de status.
  const listShown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return wos.filter((w) =>
      w.status !== 'invoiced' &&
      (!statusFilter || w.status === statusFilter) &&
      (!terminal || terminalOf(w.unit, w.company) === terminal) &&
      matchesSearch(w, s))
  }, [wos, statusFilter, q, terminal, terminalOf])

  // History: solo facturadas.
  const historyShown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return wos.filter((w) =>
      w.status === 'invoiced' &&
      (!terminal || terminalOf(w.unit, w.company) === terminal) &&
      matchesSearch(w, s))
  }, [wos, q, terminal, terminalOf])

  // Board (kanban): todos los activos (sin filtro de status: las columnas SON
  // el status), agrupados luego por columna.
  const boardWos = useMemo(() => {
    const s = q.trim().toLowerCase()
    return wos.filter((w) =>
      w.status !== 'invoiced' &&
      (!terminal || terminalOf(w.unit, w.company) === terminal) &&
      matchesSearch(w, s))
  }, [wos, q, terminal, terminalOf])

  const shown = view === 'history' ? historyShown : listShown

  function refresh() {
    qc.invalidateQueries({ queryKey: ['workorders'] })
    // Prefijo: todos los detalles ['workorder', id] (el drawer los lee).
    qc.invalidateQueries({ queryKey: ['workorder'] })
  }

  // Mover una WO de columna (kanban): optimista + patch, con los mismos
  // efectos que setStatus del drawer (pm_miles, PM tracker, Telegram). El
  // optimista toca la lista Y el detalle ['workorder', id] para que el drawer
  // no muestre el estado viejo al reabrir. Si un gate del backend bloquea el
  // avance (p.ej. "assign a mechanic"), revierte ambos y muestra el motivo.
  async function moveWo(id: number, status: WoStatus) {
    setDragCol(null)
    const listKey = ['workorders', ''] as const
    const detailKey = ['workorder', id] as const
    // Cancelar fetches en vuelo para que no pisen el update optimista.
    await Promise.all([
      qc.cancelQueries({ queryKey: ['workorders'] }),
      qc.cancelQueries({ queryKey: detailKey }),
    ])
    const prevList = qc.getQueryData<WoListData>(listKey)
    const prevDetail = qc.getQueryData<WorkOrder>(detailKey)
    // La tarjeta de la lista es lo que el usuario ve (y trae pm_miles/mileage).
    const base = prevList?.workorders.find((w) => w.id === id) ?? prevDetail
    if (!base || base.status === status) return
    const from = base.status
    qc.setQueryData<WoListData>(listKey, (old) =>
      old ? { ...old, workorders: old.workorders.map((w) =>
        w.id === id ? { ...w, status } : w) } : old)
    qc.setQueryData<WorkOrder>(detailKey, (prev) =>
      (prev ? { ...prev, status } : prev))
    try {
      const updated = await patchWorkOrder(id, statusPatch(base, status))
      mergeWoDetail(qc, updated)
      invalidateWoLists(qc)
      qc.invalidateQueries({ queryKey: ['workorder'] })
      afterStatusChange(qc, updated, { from, to: status, quiet: true })
    } catch (e) {
      if (prevList) qc.setQueryData(listKey, prevList)
      if (prevDetail) qc.setQueryData(detailKey, prevDetail)
      notifyErr("Couldn't move this work order", e)
    }
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
            <Button variant="primary" onClick={() => setCreating(true)}
              icon={
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" width="17" height="17" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              }>
              New work order
            </Button>
          )}
        </div>
      </div>

      {listQ.error && (
        <div className="banner error"><span>{String(listQ.error)}</span></div>
      )}

      {listQ.isPending ? (
        <StatCluster className="kpi-row">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} h={86} />)}
        </StatCluster>
      ) : stats && (
        <StatCluster className="kpi-row">
          <StatCard label="Open" value={stats.open}
            tone={stats.open ? 'warn' : 'ok'} />
          <StatCard label="Assigned" value={stats.assigned} tone="info" />
          <StatCard label="In progress" value={stats.in_progress} tone="info" />
          <StatCard label="To invoice" value={stats.completed}
            tone={stats.completed ? 'warn' : 'default'} />
          <StatCard label="Invoiced" value={stats.invoiced} tone="ok" />
          <StatCard label="Cost (30d)" value={money(stats.cost_30d)}
            tone="accent" />
        </StatCluster>
      )}

      <div className="card">
        <div className="card-body filters-row">
          <Tabs
            aria-label="View"
            tabs={[
              { id: 'list', label: 'List' },
              { id: 'grid', label: 'Grid' },
              { id: 'board', label: 'Board' },
              { id: 'history', label: 'History' },
            ]}
            value={view}
            onChange={(id) => setView(id as WoView)}
          />
          {(view === 'list' || view === 'grid') && (
            <Tabs
              aria-label="Status"
              tabs={[{ id: '', label: 'All' },
                ...ACTIVE_PIPELINE.map((s) => ({ id: s, label: STATUS_META[s].label }))]}
              value={statusFilter}
              onChange={(id) => setStatusFilter(id as typeof statusFilter)}
            />
          )}
          {woTerminals.length > 1 && (
            <Tabs
              aria-label="Terminal"
              tabs={[{ id: '', label: 'All terminals' },
                ...woTerminals.map((t) => ({ id: t, label: labelOf(t) }))]}
              value={terminal}
              onChange={(id) => setTerminal(terminal === id ? '' : id)}
            />
          )}
          <span className="head-spacer" />
          <input className="cell-input" placeholder="Unit, title, mechanic, WO#…"
            value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {listQ.isPending ? (
        <section className="card"><div className="card-body">
          <div className="skel-rows">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} h={38} />)}
          </div>
        </div></section>
      ) : view === 'board' ? (
        /* ===== Board (kanban): arrastrar tarjetas entre estados ===== */
        <section className="wo-board-wrap">
          <div className="wo-board"
            onDragEnd={() => setDragCol(null)}>
            {ACTIVE_PIPELINE.map((col) => {
              const cards = boardWos.filter((w) => w.status === col)
              return (
                <div key={col}
                  className={`wo-col ${dragCol === col ? 'is-drop' : ''}`}
                  onDragOver={editable
                    ? (e) => {
                      // preventDefault + dropEffect: TODA la columna (también
                      // su espacio vacío) acepta el drop.
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      if (dragCol !== col) setDragCol(col)
                    }
                    : undefined}
                  onDragLeave={editable
                    ? (e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                        setDragCol((c) => (c === col ? null : c))
                      }
                    }
                    : undefined}
                  onDrop={editable
                    ? (e) => {
                      e.preventDefault()
                      const id = Number(e.dataTransfer.getData('text/plain'))
                      const card = wos.find((w) => w.id === id)
                      if (id && card && card.status !== col) moveWo(id, col)
                      else setDragCol(null)
                    }
                    : undefined}>
                  <div className="wo-col-head">
                    <span className={`wo-col-dot ${STATUS_META[col].cls}`} />
                    <span className="wo-col-label">{STATUS_META[col].label}</span>
                    <span className="wo-col-count">{cards.length}</span>
                  </div>
                  <div className="wo-col-body">
                    {cards.length === 0 ? (
                      <p className="wo-col-empty">—</p>
                    ) : cards.map((w) => (
                      <WoCard key={w.id} w={w} onOpen={setOpenWo}
                        draggable={editable}
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/plain', String(w.id))
                          e.dataTransfer.effectAllowed = 'move'
                        }} />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
          {editable && (
            <p className="wo-board-hint">
              Drag a card to another column to change its status.
            </p>
          )}
        </section>
      ) : (
        /* ===== List / Grid / History ===== */
        <section className="card">
          <div className="card-head">
            <h2>{view === 'history' ? 'Invoiced history' : 'Orders'}</h2>
            <span className="sub">{shown.length} shown</span>
          </div>
          <div className="card-body">
            {shown.length === 0 ? (
              <div className="empty mini">
                <p>
                  {view === 'history'
                    ? 'No invoiced work orders yet.'
                    : `No work orders${statusFilter ? ' in this status' : ' yet'}. `
                      + 'Create one here or from an open defect in Fleet.'}
                </p>
              </div>
            ) : view === 'grid' ? (
              <div className="wo-grid">
                {shown.map((w) => (
                  <WoCard key={w.id} w={w} onOpen={setOpenWo} />
                ))}
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
                      <th>{view === 'history' ? 'Invoiced' : 'Created'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((w) => (
                      <tr key={w.id} onClick={() => setOpenWo(w.id)}
                        className={w.parent_id ? 'wo-row-child' : ''}>
                        <td className="mono">#{w.display_no}</td>
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
                        <td className="muted">
                          {dateOf(view === 'history' ? w.invoiced_at : w.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}

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
  // Clave estable del complaint (no cambia al borrar otros): las líneas que
  // el escaneo ruteó a SU unidad la llevan en `cid` y la siguen cuando se
  // corrige la unidad del complaint (sin depender del texto de la unidad).
  cid: number
}
let complaintSeq = 0
const emptyComplaint = (): ComplaintDraft =>
  ({ unit: '', mileage: '', detail: '', is_pm: false, cid: ++complaintSeq })

type SharedInvoice = {
  vendor: string; city: string; state: string; invoice: string; date: string
}

// Línea en edición del modal (review v1.26): extiende la línea escaneada con
// la UNIDAD a la que pertenece. '' = la unidad primaria (la orden padre); un
// código de unidad la rutea a la orden HIJA de esa unidad. Así cada WO
// (padre + hijas) lleva SOLO sus líneas y la suma = total del invoice.
// `cid` = complaint al que el escaneo la ruteó (sigue a su unidad); elegir
// la unidad de la línea a mano la suelta del complaint.
type EditLine = WoScanLine & { unit: string; cid?: number }

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
  const partsQ = useQuery({ queryKey: ['parts'], queryFn: listParts })
  const orgQ = useQuery({ queryKey: ['org'], queryFn: getOrg })
  const laborRate = orgQ.data?.labor_rate ?? 0
  const catalog = partsQ.data?.parts ?? []
  // Unidades de la flota (v2.20 addendum): misma fuente que los UnitPicker
  // del form. La orden solo se crea con unidades de la lista (o texto libre
  // si la flota no está disponible). La lista suma las unidades que la app
  // ya muestra fuera de /api/fleet (backlog de Service Requests, boards de
  // PM/DOT): un camión solo del CSV de PM o un defecto del CSV de MCC
  // también puede tener su WO.
  const knownUnits = useKnownUnits()
  const fleetUnits = useUnitMatcher(undefined, knownUnits)
  // Nombre con el que se crea la orden: el canónico de la flota o, sin
  // flota, el texto en mayúsculas (comportamiento previo).
  const unitName = (s: string) =>
    fleetUnits.find(s)?.unit ?? s.trim().toUpperCase()
  const [unit, setUnit] = useState('')
  const [complaints, setComplaints] = useState<ComplaintDraft[]>(
    () => [emptyComplaint()])
  // Validez derivada (nunca desfasada): la unidad principal tiene que ser de
  // la flota; la de cada complaint, vacía (= la principal) o de la flota.
  // Lo escaneado que no coincide queda marcado hasta que el usuario elige.
  const unitOk = fleetUnits.isValid(unit)
  const badComplaint = complaints.findIndex(
    (c) => !!c.unit.trim() && !fleetUnits.isValid(c.unit))
  const unitsHint = !unitOk
    ? (fleetUnits.mode === 'loading' ? 'Loading the fleet list…'
      : 'Pick the unit for this work order from the list')
    : badComplaint >= 0
      ? `Complaint ${badComplaint + 1}: pick its unit from the list`
      : ''
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
  // Archivo escaneado original: se adjunta automáticamente a la WO al crearla
  // (review v1.18) reusando POST /workorders/{id}/invoice-file, para que la
  // sección "Source invoice" ya lo muestre sin subida manual.
  const [scanFile, setScanFile] = useState<File | null>(null)
  const [scanLines, setScanLines] = useState<EditLine[]>([])
  // Total impreso del invoice (amount due), del escaneo. Alimenta la
  // reconciliación: si la suma de líneas != esto, se avisa en el modal.
  const [grandTotal, setGrandTotal] = useState<number | null>(null)
  // Un escaneo corrió pero NO devolvió líneas: distingue el estado vacío
  // inicial (aún no se escaneó nada) del escaneo que no detectó ítems, para
  // mostrar la pista bajo el editor de Parts & Labor.
  const [scannedNoLines, setScannedNoLines] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  // Preview del documento al lado del form (H3b).
  const [preview, setPreview] = useState<{ url: string; pdf: boolean } | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  function setLine(i: number, patch: Partial<EditLine>) {
    setScanLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  }

  // Cambiar la unidad de un complaint arrastra las líneas que el escaneo
  // ruteó a ESE complaint (p. ej. una unidad escaneada que no estaba en la
  // flota y se corrige eligiéndola): si no, caerían calladas en la
  // primaria. Se sigue al complaint por `cid` (no por el texto: dos
  // complaints con prefijos parecidos no se mezclan) y SOLO con un valor
  // confirmado — una unidad válida de la lista —: mientras se escribe, o
  // con el campo vacío a mitad de la edición, las líneas no se mueven.
  function setComplaintUnit(i: number, next: string) {
    const c = complaints[i]
    setComplaint(i, { unit: next })
    if (!c || !next.trim() || !fleetUnits.isValid(next)) return
    const name = unitName(next)
    setScanLines((ls) => ls.map((l) =>
      (l.cid === c.cid && l.unit !== name ? { ...l, unit: name } : l)))
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
      const cs: ComplaintDraft[] = (x.complaints ?? []).map((c) => ({
        unit: c.unit ?? '',
        mileage: c.mileage != null ? String(c.mileage) : '',
        detail: c.detail ?? '',
        is_pm: !!c.is_pm,
        cid: ++complaintSeq,
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
      // Total impreso del invoice (para la reconciliación del modal).
      setGrandTotal(x.grand_total ?? null)
      // Auto-ruteo de líneas a su unidad (review v1.26): si el invoice cubre
      // varias unidades, las líneas de llanta/rueda se asignan a la unidad
      // del complaint con pinta de trailer; el resto cae en la primaria ('').
      const trailerC = cs.find((c) =>
        c.unit && /tire|wheel|trailer|llanta/i.test(c.detail))
      const tireRe = /\btires?\b|\bwheel\b|\brim\b|\btread\b|\bL[FR]|\bR[FR]/i
      const edit: EditLine[] = x.lines.map((ln) => (
        trailerC && tireRe.test(ln.description)
          ? { ...ln, unit: trailerC.unit, cid: trailerC.cid }
          : { ...ln, unit: '' }))
      setScanLines(edit)
      // Pista de empty-state: el escaneo terminó pero sin líneas.
      setScannedNoLines(x.lines.length === 0)
      // Guardar el File para adjuntarlo a la WO al crearla (FIX 2).
      setScanFile(f)
      notifyOk('Document scanned',
        `${cs.length} complaint${cs.length === 1 ? '' : 's'}, ` +
        `${x.lines.length} line${x.lines.length === 1 ? '' : 's'} · ${r.model}`)
    } catch (e) {
      setScanName('')
      setScanFile(null)
      setScannedNoLines(false)
      notifyErr("Couldn't scan the document", e)
    } finally {
      setScanning(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function fillCurrent() {
    if (!unitOk || fetchingMi) return
    setFetchingMi(true)
    const u = unitName(unit)
    try {
      const o = await getUnitOdometer(u)
      if (o.miles != null) setMileage(String(o.miles))
      else notifyErr('No odometer', `Samsara has no reading for ${u}`)
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
    if (unitsHint) {
      notifyErr('Unknown unit', unitsHint)
      return
    }
    const kept = complaints.filter((c) => c.detail.trim())
    if (!kept.length) {
      notifyErr('Missing complaint', 'Add at least one issue detail')
      return
    }
    // Agrupar complaints por unidad: la unidad PRIMARIA es la orden PADRE; cada
    // OTRA unidad es una orden HIJA del mismo invoice (review v1.26: #4 / #4.1).
    // Los complaints sin unidad caen en la primaria. Clave = unidad
    // normalizada ("MEM77" == "MEM 77"); la orden se crea con el canónico.
    const primaryU = unitName(unit)
    const primaryK = normUnit(unit)
    const groups = new Map<string, { unit: string; cs: ComplaintDraft[] }>()
    for (const c of kept) {
      const k = c.unit.trim() ? normUnit(c.unit) : primaryK
      const g = groups.get(k)
        ?? { unit: k === primaryK ? primaryU : unitName(c.unit), cs: [] }
      g.cs.push(c)
      groups.set(k, g)
    }
    const others = [...groups.keys()].filter((k) => k !== primaryK)
    if (others.length && !window.confirm(
      `This invoice covers ${groups.size} units. Create ${groups.size} linked `
      + `work orders — ${primaryU} (#parent) + `
      + `${others.map((k) => groups.get(k)!.unit).join(', ')} `
      + `(#parent.1, …)? Each unit keeps its own lines; the same invoice file `
      + `attaches to all of them.`)) {
      return
    }

    setSaving(true)
    try {
      const shared: SharedInvoice = {
        vendor, city: vendorCity, state: vendorState,
        invoice: invoiceNum, date,
      }
      const allLines = scanLines.filter((l) => l.description.trim())
      const shopInv = invoiceNum.trim()
      // Líneas por unidad (clave normalizada): la línea va a su unidad
      // asignada; '' (o una unidad que no tiene su propia orden) cae en la
      // PRIMARIA (la orden padre).
      const linesFor = (k: string) => allLines.filter((l) => {
        const lk = normUnit(l.unit || '')
        return k === primaryK
          ? (!lk || !groups.has(lk) || lk === primaryK)
          : lk === k
      })

      // Helper: crea una WO (padre si parentId=null, hija si trae parentId),
      // le carga SUS líneas y le adjunta el MISMO archivo de invoice.
      const created: WorkOrder[] = []
      async function makeWo(u: string, k: string, cs: ComplaintDraft[],
                            parentId: number | null): Promise<WorkOrder> {
        const camp = (parentId === null ? campaign : '')
          || (cs.some((c) => c.is_pm) ? 'pm' : '')
        const wo = await createWorkOrder({
          unit: u,
          title: titleFor(cs, camp),
          complaint: cs.map((c) => formatComplaint(c, shared)).join('\n\n'),
          mechanic, priority, campaign: camp, shop_invoice: shopInv,
          mileage: (parentId === null && mileage) ? Number(mileage)
            : (cs[0]?.mileage ? Number(cs[0].mileage) : null),
          service_date: date,
          source: scanName ? 'scan' : 'manual',
          parent_id: parentId,
        })
        for (const ln of linesFor(k)) {
          await addWoLine(wo.id, {
            kind: ln.kind, description: ln.description.trim(),
            qty: Number(ln.qty) || 1, unit_cost: Number(ln.unit_cost) || 0,
            part_number: ln.part_number ?? '',
          })
        }
        // FIX (v1.26): el documento original se adjunta a TODAS las órdenes del
        // invoice (antes solo a la primaria; las hijas quedaban sin factura).
        if (scanFile) {
          try {
            await uploadWoInvoiceFile(wo.id, scanFile)
          } catch (e) {
            notifyErr(`WO created, but couldn't attach the invoice to ${u}`, e)
          }
        }
        created.push(wo)
        return wo
      }

      // 1) Orden PADRE (unidad primaria).
      const primaryWo = await makeWo(
        primaryU, primaryK, groups.get(primaryK)?.cs ?? [], null)
      // 2) Una orden HIJA por cada otra unidad (parent_id = padre).
      for (const ok of others) {
        const g = groups.get(ok)!
        await makeWo(g.unit, ok, g.cs, primaryWo.id)
      }

      const n = created.length
      const nLines = allLines.length
      notifyOk(n > 1 ? `${n} linked work orders created` : 'Work order created',
        `#${primaryWo.id} ${primaryWo.unit}`
        + (others.length
          ? ` + ${others.map((_, i) => `#${primaryWo.id}.${i + 1}`).join(', ')}`
          : '')
        + (nLines ? ` · ${nLines} cost lines` : ''))
      onCreated(primaryWo.id)
    } catch (e) {
      notifyErr('Could not create', e)
    } finally {
      setSaving(false)
    }
  }

  const scanTotal = scanLines.reduce(
    (s, l) => s + l.qty * l.unit_cost, 0)
  // Reconciliación (review v1.26): si el invoice imprimió un grand total y la
  // suma de las líneas extraídas no coincide (tolerancia $0.50), se avisa —
  // NO se auto-escala; el usuario corrige las líneas. El scan local sobre-
  // extrae (sumó $1,748.79 con un invoice real de $1,019).
  const totalMismatch = grandTotal != null && scanLines.length > 0
    && Math.abs(scanTotal - grandTotal) > 0.5
  // Unidades disponibles para rutear una línea: la primaria + las unidades de
  // los complaints, como [clave normalizada, nombre]. '' en la línea = la
  // unidad primaria (orden padre).
  const lineUnits = new Map<string, string>()
  if (unit.trim()) lineUnits.set(normUnit(unit), unitName(unit))
  for (const c of complaints) {
    const k = normUnit(c.unit)
    if (k && !lineUnits.has(k)) lineUnits.set(k, unitName(c.unit))
  }
  const primaryK = normUnit(unit)

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
          <UnitPicker value={unit} onChange={setUnit}
            extraUnits={knownUnits} placeholder="Pick a unit" />
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
                disabled={!unitOk || fetchingMi}
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
              normUnit(c.unit) !== normUnit(unit)
            return (
              <div key={c.cid}
                className={`wo-complaint ${mismatch ? 'is-mismatch' : ''}`}>
                <div className="wo-complaint-head">
                  <UnitPicker className="wo-complaint-unit"
                    value={c.unit} placeholder="Unit #"
                    extraUnits={knownUnits}
                    aria-label={`Complaint ${i + 1} unit`}
                    title="Leave empty to use the work order's unit"
                    onChange={(v) => setComplaintUnit(i, v)} />
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
              onClick={() => {
                setScannedNoLines(false)
                setScanLines([...scanLines, {
                  kind: 'part', description: '', qty: 1, unit_cost: 0,
                  unit: '',
                }])
              }}>
              + Add line
            </button>
          </div>
          {scanLines.map((ln, i) => (
            <div key={i}
              className={`wo-line-row wo-line-row-cat${
                lineUnits.size > 1 ? ' wo-line-row-multi' : ''}`}>
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
              <DecimalInput className="cell-input wo-line-n"
                title={ln.kind === 'part' ? 'Quantity' : 'Hours'}
                value={ln.qty}
                onChange={(n) => setLine(i, { qty: n })} />
              <DecimalInput className="cell-input wo-line-n"
                title={ln.kind === 'part' ? 'Unit cost' : 'Hourly rate'}
                value={ln.unit_cost}
                onChange={(n) => setLine(i, { unit_cost: n })} />
              {/* Multi-unit (v1.26): rutea la línea a la orden de su unidad.
                  Solo aparece cuando el invoice cubre varias unidades. */}
              {lineUnits.size > 1 && (
                <select className="cell-input wo-line-unit"
                  title="Which unit's work order gets this line"
                  value={lineUnits.has(normUnit(ln.unit || ''))
                    ? normUnit(ln.unit) : primaryK}
                  onChange={(e) => setLine(i, {
                    unit: e.target.value === primaryK ? ''
                      : lineUnits.get(e.target.value) ?? '',
                    // Elegida a mano: ya no sigue al complaint.
                    cid: undefined,
                  })}>
                  {[...lineUnits].map(([k, name]) => (
                    <option key={k} value={k}>
                      {k === primaryK ? `${name} (primary)` : name}
                    </option>
                  ))}
                </select>
              )}
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
          {scannedNoLines && scanLines.length === 0 && (
            <p className="wo-scan-empty">
              No line items detected from the scan — add them manually below,
              or configure a stronger scan provider (Anthropic) in Settings.
            </p>
          )}
          <PartOptions id="wo-catalog-parts" parts={catalog} />
          {scanLines.length > 0 && (
            <span className="wo-scan-total">
              Will be added on create · {money(scanTotal)}
              {grandTotal != null && (
                <span className="wo-scan-grand">
                  {' '}· invoice total {money(grandTotal)}
                </span>
              )}
            </span>
          )}
          {/* Reconciliación (v1.26): la suma de líneas != total impreso del
              invoice. NO se auto-escala; se avisa para que el usuario corrija
              las líneas (el scan local sobre-extrae). */}
          {totalMismatch && (
            <div className="banner warn wo-recon-warn">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                strokeLinejoin="round">
                <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                <path d="M12 9v4M12 17h.01" />
              </svg>
              <span>
                Lines sum to <strong>{money(scanTotal)}</strong> but the invoice
                grand total is <strong>{money(grandTotal!)}</strong> (off by{' '}
                {money(Math.abs(scanTotal - grandTotal!))}). The scan may have
                over-read rows — fix the lines before creating so the work
                order totals match the invoice.
              </span>
            </div>
          )}
        </div>

        <div className="settings-actions wo-create-actions">
          <button className="btn btn-primary" onClick={submit}
            disabled={saving || !!unitsHint}>
            {saving ? 'Creating…' : 'Create work order'}
          </button>
          {/* Sin unidad válida (de la flota) no se crea: pista visible. */}
          {unitsHint && <span className="field-hint">{unitsHint}</span>}
        </div>
      </div>
      </div>
    </Modal>
  )
}

// ----- Banner de decisión de stock (Treatment A inline, handoff de Design) -
// Aparece bajo una línea de parte de la WO cuando el catálogo no tiene stock
// suficiente para cubrirla. Dos salidas reales: comprar (QuickBuy → PO) o
// hacer swap por una alternativa en stock de la misma categoría. El stock se
// consume recién al facturar, así que on_hand es fiable mientras la WO está
// activa.
function WoStockBanner({ part, alt, need, onSwap, onBought, onRequest }: {
  part: Part
  alt: Part | null
  need: number
  onSwap: (alt: Part) => Promise<void>
  onBought: () => void
  onRequest: () => Promise<void>
}) {
  const [buyOpen, setBuyOpen] = useState(false)
  const [ordered, setOrdered] = useState(false)
  const [requested, setRequested] = useState(false)
  const [swapping, setSwapping] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const oh = part.on_hand || 0

  if (ordered) {
    return (
      <div className="wo-stock-banner is-ordered">
        <div className="wsb-alert">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            strokeLinejoin="round"><path d="m20 6-11 11-5-5" /></svg>
          <span>
            <strong>Ordered.</strong> A purchase order was created for{' '}
            {part.part_number}. It restocks when the PO is received.
          </span>
        </div>
      </div>
    )
  }

  if (requested) {
    return (
      <div className="wo-stock-banner is-requested">
        <div className="wsb-alert">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            strokeLinejoin="round"><path d="m20 6-11 11-5-5" /></svg>
          <span>
            <strong>Queued as a parts request.</strong> Bundle it into a PO in{' '}
            <strong>Purchasing</strong>.
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="wo-stock-banner">
      <div className="wsb-head">
        <span className="wsb-thumb">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
            stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"
            strokeLinejoin="round">
            <path d="M12 2 3 7v10l9 5 9-5V7z" /><path d="M3 7l9 5 9-5M12 12v10" />
          </svg>
        </span>
        <span className="wsb-title">
          <strong>{part.description || part.part_number}</strong>
          <span className="wsb-sub mono">
            {part.part_number}{part.vendor_name ? ` · ${part.vendor_name}` : ''}
            {' · qty '}{need}
          </span>
        </span>
        <span className="wsb-price">
          <span className="mono">{money(part.cost)}</span>
          <span className="wsb-out">OUT</span>
        </span>
      </div>

      <div className="wsb-decide">
        <div className="wsb-alert">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            strokeLinejoin="round">
            <path d="M10.3 3.5 1.8 18a1.5 1.5 0 0 0 1.3 2.2h17.8A1.5 1.5 0 0 0 22.2 18L13.7 3.5a1.5 1.5 0 0 0-2.6 0z" />
            <path d="M12 9v4M12 17h.01" />
          </svg>
          <span>
            <strong>{oh} of {need} in stock.</strong>{' '}
            <span className="muted">How do you want to fill it?</span>
          </span>
        </div>

        <div className="wsb-tiles">
          <div className="wsb-tile">
            <span className="wsb-tile-label">Order new</span>
            <span className="wsb-tile-price mono">{money(part.cost)}</span>
            <span className="wsb-tile-meta mono">
              {part.vendor_name || 'vendor'} · restock
            </span>
            <button className="btn btn-primary btn-xs wsb-buy"
              onClick={() => setBuyOpen(true)}>QuickBuy</button>
          </div>

          {alt ? (
            <div className="wsb-tile is-alt">
              <span className="wsb-tile-label ok">In stock now</span>
              <span className="wsb-tile-price mono ok">{money(alt.cost)}</span>
              <span className="wsb-tile-meta mono">
                {alt.part_number} · {alt.on_hand} on hand
              </span>
              <button className="btn btn-ghost btn-xs" disabled={swapping}
                onClick={async () => {
                  setSwapping(true)
                  try { await onSwap(alt) } finally { setSwapping(false) }
                }}>
                {swapping ? 'Swapping…' : 'Swap'}
              </button>
            </div>
          ) : (
            <div className="wsb-tile is-empty">
              <span className="wsb-tile-meta mono">
                No in-stock alternative in {part.category || 'this category'}.
                Order it, or queue a request below.
              </span>
            </div>
          )}
        </div>
        <button className="wsb-fallback" disabled={requesting}
          onClick={async () => {
            setRequesting(true)
            try { await onRequest(); setRequested(true) }
            finally { setRequesting(false) }
          }}>
          {requesting ? 'Requesting…' : 'or create a parts request →'}
        </button>
      </div>

      {buyOpen && (
        <CreatePoModal quickPart={part}
          onClose={() => setBuyOpen(false)}
          onCreated={() => { setBuyOpen(false); setOrdered(true); onBought() }} />
      )}
    </div>
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
  // Navegación interna entre órdenes ligadas del mismo invoice (review v1.26):
  // al abrir un enlace #4.1 ↔ #4 el drawer cambia de WO sin cerrarse. Se
  // resetea a la WO con la que se abrió cada vez que cambia `woId`.
  const [navId, setNavId] = useState<number | null>(woId)
  useEffect(() => { setNavId(woId) }, [woId])
  const shownId = navId ?? woId
  const woQ = useQuery({
    queryKey: ['workorder', shownId],
    queryFn: () => getWorkOrder(shownId!),
    enabled: open && shownId != null,
    // Siempre revalidar al (re)abrir: el estado pudo cambiar desde el Board,
    // el perfil de unidad o service requests mientras el drawer estaba cerrado.
    staleTime: 0,
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
  // Increment C: diagnóstico de la falla del reefer parseado del complaint
  // real (solo WOs nacidas de un fault). Si no hay datos, queda null y la
  // tarjeta se omite — sin inventar telemetría.
  const faultDiag = useMemo(
    () => (wo?.source === 'reefer'
      ? parseReeferFault(wo.complaint) : null),
    [wo?.source, wo?.complaint])
  // Increment C: hitos reales del ciclo de vida (timestamps del WO).
  const timeline = useMemo(() => (wo ? woTimeline(wo) : []), [wo])
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
  // Factura original adjunta (review v1.17): subir/ver/descargar/quitar.
  const invFileRef = useRef<HTMLInputElement | null>(null)
  const [invBusy, setInvBusy] = useState(false)
  // Miniatura de la factura (1a pagina renderizada) para el drawer.
  const [invThumb, setInvThumb] = useState<string | null>(null)

  // Carga la miniatura de la factura (auth -> blob) cuando hay una adjunta.
  useEffect(() => {
    let alive = true
    let url: string | null = null
    if (wo?.has_invoice_file) {
      fetchWoInvoiceThumbUrl(wo.id)
        .then((u) => { if (alive) { url = u; setInvThumb(u) } })
        .catch(() => { if (alive) setInvThumb(null) })
    } else {
      setInvThumb(null)
    }
    return () => { alive = false; if (url) URL.revokeObjectURL(url) }
  }, [wo?.id, wo?.has_invoice_file, wo?.invoice_file_name])

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

  // Merge (no reemplazo): las respuestas de PATCH/líneas no traen `links`.
  function refreshWo(updated: WorkOrder) {
    mergeWoDetail(qc, updated)
    invalidateWoLists(qc)
  }

  async function setStatus(s: WoStatus) {
    if (!wo) return
    setBusy(true)
    try {
      const updated = await patchWorkOrder(wo.id, statusPatch(wo, s, pmMiles))
      refreshWo(updated)
      afterStatusChange(qc, updated, { from: wo.status, to: s })
    } catch (e) {
      // Los gates del pipeline llegan como 400 con el motivo exacto.
      notifyErr("Can't move there yet", e)
    } finally {
      setBusy(false)
    }
  }

  // WO de PM que ya llegó a completed sin odómetro (p.ej. arrastrada en el
  // Board): guardar pm_miles dispara el hook PM del backend igual que al
  // completar (corre en cada update con estado >= completed).
  async function recordPmMiles() {
    if (!wo) return
    const n = Number(pmMiles.trim())
    if (!pmMiles.trim() || !Number.isFinite(n) || n <= 0) return
    try {
      const updated = await patchWorkOrder(wo.id, { pm_miles: n })
      refreshWo(updated)
      afterStatusChange(qc, updated,
        { from: updated.status, to: updated.status, quiet: true })
      setPmMiles('')
    } catch (e) {
      notifyErr('Could not save', e)
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

  // Banner de stock: swap de una línea sin stock por una alternativa en stock
  // (borra la línea original + agrega la alternativa con la misma cantidad).
  async function swapLine(line: { id: number; qty: number }, alt: Part) {
    if (!wo) return
    try {
      await deleteWoLine(wo.id, line.id)
      const updated = await addWoLine(wo.id, {
        kind: 'part', description: alt.description || alt.part_number,
        qty: line.qty || 1, unit_cost: alt.cost || 0,
        part_number: alt.part_number,
      })
      refreshWo(updated)
      qc.invalidateQueries({ queryKey: ['parts'] })
      notifyOk('Swapped', `${alt.part_number} · in stock`)
    } catch (e) {
      notifyErr('Could not swap the part', e)
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

  // v2.20: sacar un service request de esta orden (vuelve al backlog
  // abierto). No toca el texto del complaint.
  const [unlinking, setUnlinking] = useState<number | null>(null)
  async function unlinkSr(id: number) {
    setUnlinking(id)
    try {
      await unlinkRequest(id)
      invalidateWoLists(qc)
      qc.invalidateQueries({ queryKey: ['workorder'] })
      notifyOk('Request unlinked', 'Back in the open service request backlog')
    } catch (e) {
      notifyErr("Couldn't unlink the request", e)
    } finally {
      setUnlinking(null)
    }
  }

  // Factura original adjunta (review v1.17, estilo SquareRigger): subir
  // reemplaza la existente; ver abre en pestaña; descargar baja con su
  // nombre original. Refresca el WO para reflejar has_invoice_file.
  async function uploadInvoiceFile(file: File | undefined) {
    if (!wo || !file) return
    setInvBusy(true)
    try {
      const r = await uploadWoInvoiceFile(wo.id, file)
      qc.setQueryData<WorkOrder>(['workorder', wo.id], (prev) =>
        prev ? { ...prev, has_invoice_file: true,
                 invoice_file_name: r.invoice_file_name } : prev)
      qc.invalidateQueries({ queryKey: ['workorders'] })
      notifyOk('Invoice attached', r.invoice_file_name)
    } catch (e) {
      notifyErr("Couldn't upload invoice", e)
    } finally {
      setInvBusy(false)
      if (invFileRef.current) invFileRef.current.value = ''
    }
  }

  async function removeInvoiceFile() {
    if (!wo) return
    if (!window.confirm('Remove the attached invoice?')) return
    setInvBusy(true)
    try {
      await deleteWoInvoiceFile(wo.id)
      qc.setQueryData<WorkOrder>(['workorder', wo.id], (prev) =>
        prev ? { ...prev, has_invoice_file: false,
                 invoice_file_name: null } : prev)
      qc.invalidateQueries({ queryKey: ['workorders'] })
      notifyOk('Invoice removed')
    } catch (e) {
      notifyErr("Couldn't remove invoice", e)
    } finally {
      setInvBusy(false)
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
    {/* B1/B2 (review v1.26): `handleOnly` hace que SOLO el handle arrastre el
        panel (vaul-drag), así el click-drag dentro del contenido selecciona
        texto normalmente. `dismissible` + el onOpenChange ya cierran con
        Escape y con clic en el overlay; el botón X llama onClose directo. */}
    <Drawer.Root direction="right" open={open} dismissible handleOnly
      onOpenChange={(o) => { if (!o) onClose() }}>
      <Drawer.Portal>
        <Drawer.Overlay className="ud-overlay" />
        <Drawer.Content className="ud-content wo-drawer">
          {/* Handle de arrastre (única zona que mueve el panel con vaul). */}
          <Drawer.Handle className="wo-drawer-handle" />
          {wo && (
            <>
              <div className="ud-head">
                <div>
                  <Drawer.Title className="ud-title">
                    WO #{wo.links?.display_no ?? wo.id} · {wo.unit}
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
                    {wo.source === 'reefer' && (
                      <span className="ud-chip">from reefer fault</span>
                    )}
                    {wo.source === 'request' && (
                      <span className="ud-chip">from service request</span>
                    )}
                  </span>
                  {/* Vínculos del invoice multi-unidad (review v1.26): "child
                      of #4" + enlaces a las otras unidades. Navega dentro del
                      drawer sin cerrarlo. */}
                  {wo.links && (wo.links.parent
                    || wo.links.children.length > 0) && (
                    <div className="wo-link-row">
                      {wo.links.parent && (
                        <button type="button" className="wo-link-chip"
                          title={`Open parent WO #${wo.links.parent.display_no}`}
                          onClick={() => setNavId(wo.links!.parent!.id)}>
                          <span className="wo-link-eyebrow">child of</span>
                          #{wo.links.parent.display_no} · {wo.links.parent.unit}
                        </button>
                      )}
                      {wo.links.children
                        .filter((k) => k.id !== wo.id)
                        .map((k) => (
                          <button type="button" key={k.id}
                            className="wo-link-chip"
                            title={`Open linked WO #${k.display_no}`}
                            onClick={() => setNavId(k.id)}>
                            <span className="wo-link-eyebrow">linked</span>
                            #{k.display_no} · {k.unit}
                          </button>
                        ))}
                    </div>
                  )}
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
                Work order {wo.links?.display_no ?? wo.id} details
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

                {/* Antes de completar: viaja con el cambio de estado. Ya
                    completada SIN odómetro (p.ej. movida en el Board): se
                    guarda al salir del campo y registra el PM. */}
                {wo.is_pm && (!reachesCompleted(wo.status)
                  || (wo.status === 'completed' && !wo.pm_miles)) && (
                  <label className="ud-field wo-pm-miles">
                    <span>Odometer at PM completion (mi)</span>
                    <input className="cell-input" type="number" value={pmMiles}
                      placeholder={wo.mileage ? String(wo.mileage) : '431850'}
                      onChange={(e) => setPmMiles(e.target.value)}
                      onBlur={() => {
                        if (reachesCompleted(wo.status)) recordPmMiles()
                      }} />
                  </label>
                )}

                {/* v2.20: service requests que esta orden resuelve. */}
                {wo.service_requests && wo.service_requests.length > 0 && (
                  <section className="ud-sec">
                    <h3>
                      Service requests
                      <span className="ud-count">
                        {wo.service_requests.length}
                      </span>
                    </h3>
                    <ul className="sr-wo-list">
                      {wo.service_requests.map((r) => (
                        <li key={r.id} className="sr-wo-item">
                          <span className={`sr-wo-src sr-s-${r.source}`}>
                            {SR_SOURCE_LABEL[r.source] ?? r.source}
                          </span>
                          <span className="sr-wo-title" title={r.title}>
                            {r.title}
                          </span>
                          {(r.priority === 'urgent'
                            || r.priority === 'emergency') && (
                            <Badge variant="solid"
                              style={{ background: `var(--sr-${r.priority})` }}>
                              {r.priority === 'urgent' ? 'Urgent' : 'Emergency'}
                            </Badge>
                          )}
                          {r.status === 'done' && (
                            <Badge tone="success">Done</Badge>
                          )}
                          {can('maint.edit') && r.status === 'on_wo' && (
                            <button className="btn btn-ghost btn-xs"
                              disabled={unlinking === r.id}
                              title="Take it off this work order and back to the backlog"
                              onClick={() => unlinkSr(r.id)}>
                              {unlinking === r.id ? 'Unlinking…' : 'Unlink'}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
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
                      Rigsmith invoice&nbsp;#:{' '}
                      <strong>{wo.invoice_number}</strong> · format in
                      Settings, Company
                    </p>
                  )}
                  {/* Factura original adjunta (review v1.17): el PDF/imagen
                      del taller que dio origen a la WO. Ver/Descargar/Quitar
                      o subir uno (reemplaza). Estilo SquareRigger. */}
                  <div className="wo-srcinv">
                    <span className="ud-field-label">Source invoice</span>
                    {wo.has_invoice_file ? (
                      <div className="wo-srcinv-card">
                        <button type="button" className="wo-srcinv-thumb"
                          title="View invoice" disabled={invBusy}
                          onClick={() => viewWoInvoiceFile(wo.id)
                            .catch((e) => notifyErr("Couldn't open", e))}>
                          {invThumb ? (
                            <img src={invThumb} alt="Invoice preview" />
                          ) : (
                            <span className="wo-srcinv-thumb-ph">
                              <svg viewBox="0 0 24 24" fill="none"
                                stroke="currentColor" strokeWidth="1.6"
                                strokeLinecap="round" strokeLinejoin="round">
                                <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                                <path d="M14 3v5h5M9 13h6M9 17h6" />
                              </svg>
                            </span>
                          )}
                          <span className="wo-srcinv-thumb-badge">
                            {(wo.invoice_file_name?.split('.').pop() || 'DOC')
                              .toUpperCase()}
                          </span>
                        </button>
                        <div className="wo-srcinv-body">
                          <span className="wo-srcinv-eyebrow">
                            Attached document
                          </span>
                          <span className="wo-srcinv-name" title={
                            wo.invoice_file_name ?? ''}>
                            {wo.invoice_file_name}
                          </span>
                          <div className="wo-srcinv-actions">
                            <Button variant="primary" size="sm"
                              disabled={invBusy}
                              onClick={() => viewWoInvoiceFile(wo.id)
                                .catch((e) => notifyErr("Couldn't open", e))}>
                              View
                            </Button>
                            <Button variant="ghost" size="sm" disabled={invBusy}
                              onClick={() => downloadWoInvoiceFile(
                                wo.id, wo.invoice_file_name ?? `invoice-${wo.id}`)
                                .catch((e) => notifyErr("Couldn't download", e))}>
                              Download
                            </Button>
                            <Button variant="ghost" size="sm" loading={invBusy}
                              className="up-danger" onClick={removeInvoiceFile}>
                              Remove
                            </Button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <button type="button" className="wo-srcinv-drop"
                        disabled={invBusy}
                        onClick={() => invFileRef.current?.click()}>
                        <svg viewBox="0 0 24 24" fill="none"
                          stroke="currentColor" strokeWidth="1.6"
                          strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 16V4M7 9l5-5 5 5" />
                          <path d="M5 20h14" />
                        </svg>
                        <span className="wo-srcinv-drop-t">Attach invoice</span>
                        <span className="wo-srcinv-drop-s">
                          PDF or photo of the original shop invoice
                        </span>
                      </button>
                    )}
                    <input ref={invFileRef} type="file" hidden
                      accept=".pdf,image/*"
                      onChange={(e) =>
                        uploadInvoiceFile(e.target.files?.[0])} />
                  </div>
                </section>

                {/* Increment C: diagnóstico de la falla (solo WOs de reefer
                    con telemetría real capturada en el complaint; si nada se
                    parsea, faultDiag es null y la sección no se renderiza —
                    sin datos inventados). */}
                {faultDiag && (
                  <section className="ud-sec">
                    <h3>
                      <svg viewBox="0 0 24 24" width="15" height="15"
                        fill="none" stroke="currentColor" strokeWidth="2"
                        strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                      </svg>
                      Fault diagnostics
                      {faultDiag.source && (
                        <span className="wo-diag-src">{faultDiag.source}</span>
                      )}
                    </h3>
                    {faultDiag.cells.length > 0 && (
                      <div className="wo-diag-grid">
                        {faultDiag.cells.map((c) => (
                          <div className="wo-diag-cell" key={c.k}>
                            <span className="wo-diag-k">{c.k}</span>
                            <span className="wo-diag-v mono">
                              {c.v}{c.u && <span className="wo-diag-u">{c.u}</span>}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {(faultDiag.code || faultDiag.desc) && (
                      <div className="wo-diag-foot">
                        <svg viewBox="0 0 24 24" width="15" height="15"
                          fill="none" stroke="currentColor" strokeWidth="2"
                          strokeLinecap="round" strokeLinejoin="round">
                          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                          <path d="M12 9v4M12 17h.01" />
                        </svg>
                        <span>
                          {faultDiag.code && (
                            <span className="wo-diag-code mono">
                              {faultDiag.code}
                            </span>
                          )}
                          {faultDiag.desc && (
                            <span className="wo-diag-desc">
                              {' '}{faultDiag.desc}
                            </span>
                          )}
                        </span>
                      </div>
                    )}
                    {faultDiag.action && (
                      <p className="ud-muted wo-diag-action">
                        Operator action: {faultDiag.action}
                      </p>
                    )}
                  </section>
                )}

                {/* Líneas: partes + labor */}
                <section className="ud-sec">
                  <h3>
                    Parts &amp; labor
                    <span className="ud-count">{wo.lines?.length ?? 0}</span>
                  </h3>
                  {(wo.lines ?? []).length > 0 && (
                    <table className="wo-lines">
                      <tbody>
                        {(wo.lines ?? []).map((ln) => {
                          // ¿Parte sin stock suficiente en el catálogo? (solo
                          // mientras la WO está activa: al facturar se consume).
                          const cp = ln.kind === 'part' && ln.part_number
                            ? findPart(catalog, ln.part_number) : undefined
                          const short = !!cp
                            && (cp.on_hand ?? 0) < (ln.qty || 1)
                            && !['completed', 'invoiced'].includes(wo.status)
                          const alt = short && cp
                            ? bestAlternative(catalog, cp) : null
                          return (
                            <Fragment key={ln.id}>
                              <tr className={short ? 'wo-line-short' : undefined}>
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
                              {short && cp && (
                                <tr className="wo-line-banner-row">
                                  <td colSpan={5}>
                                    <WoStockBanner part={cp} alt={alt}
                                      need={ln.qty || 1}
                                      onSwap={(a) => swapLine(ln, a)}
                                      onBought={() => {
                                        qc.invalidateQueries({ queryKey: ['parts'] })
                                        qc.invalidateQueries({ queryKey: ['purchase-orders'] })
                                      }}
                                      onRequest={async () => {
                                        await createPartsRequest({
                                          part_number: cp.part_number,
                                          description: cp.description || cp.part_number,
                                          qty: ln.qty || 1,
                                          unit_cost: cp.cost || 0,
                                          vendor: cp.vendor_name || '',
                                          source: 'wo',
                                          source_ref: `WO #${wo.id}`,
                                        })
                                        qc.invalidateQueries({ queryKey: ['parts-requests'] })
                                        notifyOk('Parts request queued',
                                          `${cp.part_number} · see Purchasing`)
                                      }} />
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          )
                        })}
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

                {/* Evidencia fotográfica (v2.14, elemento 01): Before = como
                    se encontró, After = trabajo terminado. Con ≥1 foto de
                    cada lado aparece el comparador arrastrable — la WO
                    cierra con prueba visual (warranty / disputas con el
                    shop externo), no con un checkbox. */}
                <WoPhotos woId={wo.id} />

                {/* Increment C: línea de tiempo de actividad. SOLO hitos
                    reales del ciclo de vida (timestamps que el WO ya tiene);
                    no hay tabla de auditoría por-WO, así que no se fabrica un
                    trail por-actor como en el mockup. */}
                {timeline.length > 0 && (
                  <section className="ud-sec">
                    <h3>
                      <svg viewBox="0 0 24 24" width="15" height="15"
                        fill="none" stroke="currentColor" strokeWidth="2"
                        strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 8v4l3 2" />
                        <circle cx="12" cy="12" r="9" />
                      </svg>
                      Activity
                      <span className="ud-count">{timeline.length}</span>
                    </h3>
                    <ol className="wo-timeline">
                      {timeline.map((e, i) => (
                        <li className="wo-tl-row" key={`${e.label}-${i}`}>
                          <span className={`wo-tl-dot t-${e.tone}`} />
                          <span className="wo-tl-when mono">
                            {stampOf(e.when)}
                          </span>
                          <span className="wo-tl-text">
                            {e.label}
                            {e.sub && (
                              <span className="wo-tl-sub mono">{e.sub}</span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </section>
                )}

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
                        // Incluye service requests: los ligados vuelven a open.
                        invalidateWoLists(qc)
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

// ----- Evidencia fotográfica (v2.14, elemento 01) -------------------------
// Sección "Photos" del drawer: dos galerías por fase (Before = como se
// encontró, After = trabajo terminado). Las galerías comparten la caché de
// react-query con el comparador (misma queryKey), así que no hay fetches
// duplicados.
function WoPhotos({ woId }: { woId: number }) {
  const listQ = useEvidenceList('wo', woId)
  const photos = listQ.data ?? []
  const before = photos.filter((p) => p.phase === 'before')
  const after = photos.filter((p) => p.phase === 'after')
  return (
    <section className="ud-sec">
      <h3>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round"
          strokeLinejoin="round" aria-hidden="true">
          <path d="M4 8h3l2-2h6l2 2h3v11H4z" />
          <circle cx="12" cy="13" r="3.2" />
        </svg>
        Photos
        <span className="ud-count">{photos.length}</span>
      </h3>
      <div className="wo-photos">
        <div className="wo-photos-col">
          <span className="ud-field-label">Before · as found</span>
          <EvidenceGallery parent="wo" parentId={woId} phase="before"
            addLabel="Add before" />
        </div>
        <div className="wo-photos-col">
          <span className="ud-field-label">After · work done</span>
          <EvidenceGallery parent="wo" parentId={woId} phase="after"
            addLabel="Add after" />
        </div>
      </div>
      {before.length > 0 && after.length > 0 && (
        <BeforeAfter before={before[before.length - 1]}
          after={after[after.length - 1]} />
      )}
    </section>
  )
}

// Comparador antes/después (portado del prototipo del board): dos imágenes
// superpuestas, la de arriba recortada con clip-path; el divisor lo mueve
// un <input type="range"> invisible que cubre todo el área (accesible con
// teclado gratis). Usa la última foto de cada fase.
function BeforeAfter({ before, after }: {
  before: EvidencePhoto
  after: EvidencePhoto
}) {
  const [pos, setPos] = useState(50)
  const beforeQ = useEvidencePhotoUrl(before.id)
  const afterQ = useEvidencePhotoUrl(after.id)
  if (!beforeQ.data || !afterQ.data) return null
  return (
    <div className="ev-ba">
      <img src={afterQ.data} alt="After" />
      <div className="ev-ba-clip"
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
        <img src={beforeQ.data} alt="Before" />
      </div>
      <span className="ev-ba-tag is-before">BEFORE</span>
      <span className="ev-ba-tag is-after">AFTER</span>
      <div className="ev-ba-bar" style={{ left: `${pos}%` }}
        aria-hidden="true">
        <span className="ev-ba-knob">⇔</span>
      </div>
      <input type="range" min={2} max={98} value={pos}
        onChange={(e) => setPos(Number(e.target.value))}
        aria-label="Compare before and after" />
    </div>
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
