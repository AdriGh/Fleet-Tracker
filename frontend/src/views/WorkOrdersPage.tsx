// Work Orders (v2.21): layout maestro-detalle estilo SquareRigger.
//
//  - Vistas: List (lista a la izquierda + panel de detalle a la derecha,
//    la nueva por defecto), Table (la planilla densa), Board (kanban con
//    drag & drop, fixes v2.20 intactos) e History (facturadas).
//  - Un solo set de filtros (FiltersPanel) + búsqueda + terminal que aplican
//    a TODAS las vistas: `shown` es el único array filtrado.
//  - La tira de métricas (PipelineStrip) reemplaza a las 6 tarjetas negras;
//    clic en un segmento aplica ese filtro de status.
//  - El detalle (WoDetail, views/WoDetail.tsx) se monta en el panel derecho
//    en List y en el drawer (WoDrawer) en las demás vistas. Deep link local:
//    ?wo=<id> (sin router; history.replaceState).
import {
  useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties,
  type DragEvent,
  type KeyboardEvent, type ReactNode,
} from 'react'
import {
  keepPreviousData, useQuery, useQueryClient,
} from '@tanstack/react-query'
import {
  addWoLinesBulk, createWorkOrder, getOrg, getUnitOdometer, listFleet,
  listParts, listWorkOrders, matchVendor, patchWorkOrder, saveVendor,
  scanWoDocument,
  uploadWoInvoiceFile,
  type Vendor, type VendorCandidate,
  type WorkOrder, type WoPriority, type WoScanLine, type WoStatus, type WoType,
} from '../api'
import { notifyOk, notifyErr } from '../toast'
import { useTerminals } from '../terminal'
import { usePerms } from '../perms'
import type { NavIntent, WoFilterIntent } from '../shell'
import { Button, Tabs } from '../components/ds'
import Modal from '../components/Modal'
import Skeleton from '../components/Skeleton'
import UnitPicker from '../components/UnitPicker'
import VendorPicker from '../components/VendorPicker'
import TechnicianPicker from '../components/TechnicianPicker'
import { WoTypeBadge, WoTypeSwitch } from '../components/WoTypeBadge'
import PipelineStrip from '../components/PipelineStrip'
import FiltersPanel, {
  type FilterGroup, type FilterOption, type FilterRange,
} from '../components/FiltersPanel'
import { normUnit, useKnownUnits, useUnitMatcher } from '../unitMatch'
import { vendorLabel, vendorLoc } from '../vendors'
import BillToField, { type BillMode } from '../components/BillToField'
import type { PickedCustomer } from '../components/CustomerPicker'
import { useUnitOwners } from '../customers'
import { PartOptions, WoDetail, WoDrawer } from './WoDetail'
import {
  ACTIVE_PIPELINE, afterStatusChange, CAMPAIGN_OPTS, dateOf, findPart,
  invalidateWoLists, matchesSearch, mergeWoDetail, money, partUnitCost,
  PIPELINE, PRIORITY_META, STATUS_META, statusPatch, type WoListData,
} from './woShared'

// Re-exports de compatibilidad: el perfil de unidad y Service Requests
// importan estos nombres desde esta página desde v2.19/v2.20.
export { STATUS_META, PIPELINE, CAMPAIGN_OPTS } from './woShared'
export { WoDrawer } from './WoDetail'

// Vistas de la misma data: maestro-detalle, planilla, kanban por estado e
// History (facturadas, separadas).
type WoView = 'list' | 'table' | 'board' | 'history'

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
        {/* v2.21: trabajo tercerizado → chip con el vendor. */}
        <WoTypeBadge wo={w} compact />
      </div>
      <div className="wo-card-foot">
        <span className={`wo-priority ${PRIORITY_META[w.priority].cls}`}>
          {PRIORITY_META[w.priority].label}
        </span>
        <span className="wo-card-mech"
          title={w.wo_type === 'outside' ? w.vendor_name : w.mechanic}>
          {w.wo_type === 'outside'
            ? (vendorLoc({ city: w.vendor_city, state: w.vendor_state })
              || 'Third-party shop')
            : (w.mechanic || '—')}
        </span>
        <span className="mono wo-card-total">
          {w.total ? money(w.total) : '—'}
        </span>
      </div>
    </article>
  )
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



// ----- Filtros (v2.21) -------------------------------------------------------
// Un solo objeto de filtros que aplican TODAS las vistas. Los grupos de
// checkboxes son Sets de valores (vacío = sin filtro); las fechas son rangos.
type SetGroup =
  'status' | 'type' | 'vendor' | 'tech' | 'priority' | 'campaign' | 'unit'
  | 'waiting'
const SET_GROUPS: SetGroup[] = [
  'status', 'type', 'vendor', 'tech', 'priority', 'campaign', 'unit', 'waiting',
]
type DateRange = { from: string; to: string }
type WoFilters = Record<SetGroup, Set<string>> & {
  created: DateRange
  service: DateRange
  // v2.22: fecha de cierre y fecha efectiva ("work date": service ->
  // closed -> created), ambas en la TZ de la org (drill-downs de Home).
  closed: DateRange
  worked: DateRange
}
type RangeId = 'created' | 'service' | 'closed' | 'worked'
const RANGE_IDS: RangeId[] = ['created', 'service', 'closed', 'worked']
const emptyFilters = (): WoFilters => ({
  status: new Set(), type: new Set(), vendor: new Set(), tech: new Set(),
  priority: new Set(), campaign: new Set(), unit: new Set(),
  waiting: new Set(),
  created: { from: '', to: '' }, service: { from: '', to: '' },
  closed: { from: '', to: '' }, worked: { from: '', to: '' },
})
// Fecha de la WO para cada rango.
function rangeDate(w: WorkOrder, id: RangeId): string | null {
  switch (id) {
    case 'created': return w.created_at
    case 'service': return w.service_date
    case 'closed': return w.closed_date ?? w.closed_at
    case 'worked':
      return w.effective_date ?? w.service_date ?? w.closed_at ?? w.created_at
  }
}
// Valor "sin asignar" (técnico vacío / sin vendor).
const NONE = '__none__'
// Valor del grupo Technician para una WO outside (sin técnico propio).
const OUTSIDE = '__outside__'

// Valor de una WO en cada grupo de filtro.
function groupValue(w: WorkOrder, g: SetGroup): string {
  switch (g) {
    case 'status': return w.status
    case 'type': return w.wo_type
    case 'vendor': return w.vendor_id != null ? String(w.vendor_id) : NONE
    // Outside work no tiene técnico propio: valor aparte (nunca se ofrece
    // como opción) para que "Unassigned" cuente SOLO inside sin asignar y el
    // conteo coincida con el resultado al marcarlo.
    case 'tech': return w.wo_type === 'outside' ? OUTSIDE
      : (w.mechanic.trim() || NONE)
    case 'priority': return w.priority
    case 'campaign': return w.campaign || (w.is_pm ? 'pm' : '')
    case 'unit': return w.unit
    case 'waiting': return w.waiting_parts ? 'yes' : 'no'
  }
}

function inRange(iso: string | null, r: DateRange): boolean {
  if (!r.from && !r.to) return true
  if (!iso) return false
  const d = iso.slice(0, 10)
  return (!r.from || d >= r.from) && (!r.to || d <= r.to)
}

// ¿La WO pasa los filtros? `except` ignora UN grupo: así cada grupo del
// panel cuenta sus opciones contra los demás filtros (conteos facetados).
function passes(
  w: WorkOrder, f: WoFilters, except?: SetGroup | RangeId,
): boolean {
  for (const g of SET_GROUPS) {
    if (g === except) continue
    if (f[g].size && !f[g].has(groupValue(w, g))) return false
  }
  for (const r of RANGE_IDS) {
    if (except !== r && !inRange(rangeDate(w, r), f[r])) return false
  }
  return true
}

function activeFilterCount(f: WoFilters): number {
  return SET_GROUPS.filter((g) => f[g].size > 0).length
    + RANGE_IDS.filter((r) => f[r].from || f[r].to).length
}

// Opciones de un grupo: los valores presentes en `base` con el conteo de las
// WOs que pasan los DEMÁS filtros. `skip` deja afuera valores que no tiene
// sentido ofrecer (p. ej. "sin vendor" en el grupo Vendor).
function buildOptions(
  base: WorkOrder[], f: WoFilters, g: SetGroup,
  labelOf: (v: string) => ReactNode,
  opts: { order?: string[]; skip?: (w: WorkOrder) => boolean;
          search?: (v: string) => string } = {},
): FilterOption[] {
  const present = new Set<string>()
  const counts = new Map<string, number>()
  for (const w of base) {
    if (opts.skip?.(w)) continue
    const v = groupValue(w, g)
    present.add(v)
    if (passes(w, f, g)) counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  const out = [...present].map((v) => ({
    value: v, label: labelOf(v), count: counts.get(v) ?? 0,
    search: opts.search?.(v),
  }))
  if (opts.order) {
    const ord = opts.order
    out.sort((a, b) => ord.indexOf(a.value) - ord.indexOf(b.value))
  } else {
    out.sort((a, b) => b.count - a.count
      || String(a.search ?? a.value).localeCompare(String(b.search ?? b.value)))
  }
  return out
}

// Orden "árbol" de la lista maestra (estilo SquareRigger): cada orden hija
// (#4.1) va justo debajo de su padre si el padre también está en la lista;
// si no, queda donde el orden original la trajo.
function treeOrder(list: WorkOrder[]): WorkOrder[] {
  const ids = new Set(list.map((w) => w.id))
  const kids = new Map<number, WorkOrder[]>()
  for (const w of list) {
    if (w.parent_id != null && ids.has(w.parent_id)) {
      const arr = kids.get(w.parent_id) ?? []
      arr.push(w)
      kids.set(w.parent_id, arr)
    }
  }
  const out: WorkOrder[] = []
  for (const w of list) {
    if (w.parent_id != null && ids.has(w.parent_id)) continue
    out.push(w)
    const ks = kids.get(w.id)
    if (ks) out.push(...ks.sort((a, b) => a.child_seq - b.child_seq))
  }
  return out
}

// Deep link local: ?wo=<id> al montar.
function woFromUrl(): number | null {
  const p = new URLSearchParams(window.location.search).get('wo')
  const n = p ? Number(p) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

// Pestañas de vista (icono + etiqueta compactos).
function VTab({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <span className="wo-vtab">{icon}{children}</span>
}
const I = {
  list: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="7" height="16" rx="1.5" />
      <rect x="13" y="4" width="8" height="16" rx="1.5" />
    </svg>
  ),
  table: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  ),
  board: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="5" height="16" rx="1.2" />
      <rect x="10" y="4" width="5" height="11" rx="1.2" />
      <rect x="17" y="4" width="4" height="8" rx="1.2" />
    </svg>
  ),
  history: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 8v4l3 2" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  ),
  funnel: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 5h18l-7 8v6l-4 2v-8z" />
    </svg>
  ),
}

// Filtros iniciales desde un intent del shell (KPIs de Home, palette): status,
// tipo inside/outside, "waiting for parts" y rangos de cierre / fecha
// efectiva (mismo criterio que el KPI que se clickeó).
function filtersFromIntent(fi?: WoFilterIntent): WoFilters {
  const f = emptyFilters()
  if (!fi) return f
  const st = Array.isArray(fi.status) ? fi.status : fi.status ? [fi.status] : []
  for (const s of st) f.status.add(String(s))
  if (fi.wo_type) f.type.add(fi.wo_type)
  if (fi.waiting_parts != null) f.waiting.add(fi.waiting_parts ? 'yes' : 'no')
  if (fi.closed_from || fi.closed_to) {
    f.closed = { from: fi.closed_from ?? '', to: fi.closed_to ?? '' }
  }
  if (fi.worked_from || fi.worked_to) {
    f.worked = { from: fi.worked_from ?? '', to: fi.worked_to ?? '' }
  }
  return f
}

// v2.22: `intent` del shell ({wo} abre la orden; {filter} filtra la lista).
// App re-monta la página con cada intent nuevo, así que basta con leerlo en
// los inicializadores de estado.
export default function WorkOrdersPage(
  { intent }: { intent?: NavIntent } = {},
) {
  const qc = useQueryClient()
  const { can } = usePerms()
  const { terminalOf, labelOf, present } = useTerminals()
  const [view, setView] = useState<WoView>('list')
  const [terminal, setTerminal] = useState('')
  const [q, setQ] = useState('')
  const [filters, setFilters] = useState<WoFilters>(
    () => filtersFromIntent(intent?.filter))
  // Incluir facturadas en List/Table (los KPIs de Home cuentan las cerradas
  // hoy aunque ya se hayan facturado). Se apaga con "Clear filters".
  const [withInvoiced, setWithInvoiced] = useState(
    () => !!intent?.filter?.include_invoiced)
  const [fltOpen, setFltOpen] = useState(false)
  const fltBtnRef = useRef<HTMLButtonElement | null>(null)
  // List: WO seleccionada en el panel derecho (deep link ?wo=). Table /
  // Board / History abren el drawer (openWo), como antes.
  const [sel, setSel] = useState<number | null>(
    () => intent?.wo ?? woFromUrl())
  const [showDetail, setShowDetail] = useState(
    () => (intent?.wo ?? woFromUrl()) != null)
  const [expanded, setExpanded] = useState(false)
  const [openWo, setOpenWo] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  // Columna del kanban resaltada mientras se arrastra una tarjeta sobre ella.
  const [dragCol, setDragCol] = useState<WoStatus | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const splitRef = useRef<HTMLDivElement | null>(null)

  // Un solo fetch (todas las WOs); las 4 vistas filtran client-side. Las
  // stats del backend son globales, así que no dependen del filtro.
  const listQ = useQuery({
    queryKey: ['workorders', ''],
    queryFn: () => listWorkOrders(''),
    placeholderData: keepPreviousData,
  })
  const wos = useMemo(() => listQ.data?.workorders ?? [], [listQ.data])
  const stats = listQ.data?.stats

  // List: lista y detalle llenan el alto que queda bajo la cabecera (scroll
  // interno, como SquareRigger). Se mide el offset del split en el documento
  // (offsetTop acumulado: ignora la animación de entrada de .page) y el CSS
  // calcula `100vh - offset`. En móvil el CSS lo ignora. El split solo
  // existe en List ya cargada; se re-mide cuando cambia el alto de lo que
  // hay arriba (banner, tira) vía ResizeObserver, no en cada render.
  useLayoutEffect(() => {
    const el = splitRef.current
    if (!el) return
    const measure = () => {
      let top = 0
      for (let n: HTMLElement | null = el; n;
           n = n.offsetParent as HTMLElement | null) {
        top += n.offsetTop
      }
      el.style.setProperty('--wo-split-top', `${Math.round(top)}px`)
    }
    measure()
    window.addEventListener('resize', measure)
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(measure) : null
    ro?.observe(document.body)
    if (el.parentElement) ro?.observe(el.parentElement)
    return () => {
      window.removeEventListener('resize', measure)
      ro?.disconnect()
    }
  }, [view, listQ.isPending])
  // Año / marca / modelo de la unidad para la lista maestra (caché ['fleet']
  // compartida con Fleet y el detalle; si no está, solo la unidad).
  const fleetQ = useQuery({ queryKey: ['fleet'], queryFn: listFleet })
  const ymmOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const u of fleetQ.data ?? []) {
      m.set(u.unit, [u.year, u.make, u.model].filter(Boolean).join(' '))
    }
    return (unit: string) => m.get(unit) ?? ''
  }, [fleetQ.data])

  // Deep link: escribir ?wo= al cambiar la selección (sin router); al salir
  // de la página se limpia.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (sel != null) url.searchParams.set('wo', String(sel))
    else url.searchParams.delete('wo')
    window.history.replaceState(window.history.state, '', url)
  }, [sel])
  useEffect(() => () => {
    const url = new URL(window.location.href)
    if (url.searchParams.has('wo')) {
      url.searchParams.delete('wo')
      window.history.replaceState(window.history.state, '', url)
    }
  }, [])

  // Chips de terminal (Settings → Terminals); solo si hay más de una.
  const woTerminals = useMemo(
    () => present(wos.map((w) => ({ unit: w.unit, company: w.company }))),
    [wos, present])
  useEffect(() => {
    if (terminal && !woTerminals.includes(terminal)) setTerminal('')
  }, [terminal, woTerminals])

  const editable = can('maint.edit')

  // Alcance de la vista (activas vs facturadas) + búsqueda + terminal: la
  // base sobre la que el panel cuenta sus opciones.
  const viewBase = useMemo(() => {
    const s = q.trim().toLowerCase()
    return wos.filter((w) =>
      (view === 'history' ? w.status === 'invoiced'
        : withInvoiced || w.status !== 'invoiced')
      && (!terminal || terminalOf(w.unit, w.company) === terminal)
      && matchesSearch(w, s))
  }, [wos, view, q, terminal, terminalOf, withInvoiced])
  // EL array filtrado: lo usan List, Table, Board e History. En History el
  // grupo Status no existe (todo es invoiced) y el panel no lo muestra, así
  // que un status elegido en List se IGNORA ahí (y no cuenta como activo):
  // si no, la lista quedaba vacía sin ningún filtro visible que quitar.
  const skipGroup = view === 'history' ? 'status' : undefined
  const shown = useMemo(
    () => viewBase.filter((w) => passes(w, filters, skipGroup)),
    [viewBase, filters, skipGroup])
  const rows = useMemo(() => treeOrder(shown), [shown])
  const activeCount = activeFilterCount(filters)
    - (skipGroup && filters.status.size ? 1 : 0)

  // Grupos del panel de filtros con conteos facetados.
  const vendorNames = useMemo(() => {
    const m = new Map<string, string>()
    for (const w of wos) {
      if (w.vendor_id != null) m.set(String(w.vendor_id), w.vendor_name)
    }
    return m
  }, [wos])
  const groups: FilterGroup[] = useMemo(() => {
    const gs: FilterGroup[] = []
    if (view !== 'history') {
      gs.push({
        id: 'status', label: 'Status', defaultOpen: true,
        selected: filters.status,
        options: buildOptions(viewBase, filters, 'status',
          (v) => STATUS_META[v as WoStatus]?.label ?? v,
          { order: PIPELINE }),
      })
    }
    gs.push({
      id: 'type', label: 'Type', defaultOpen: true, selected: filters.type,
      options: buildOptions(viewBase, filters, 'type',
        (v) => (v === 'outside' ? 'Outside work' : 'Inside work'),
        { order: ['inside', 'outside'] }),
    })
    gs.push({
      id: 'vendor', label: 'Vendor', selected: filters.vendor,
      options: buildOptions(viewBase, filters, 'vendor',
        (v) => vendorNames.get(v) || `Vendor #${v}`,
        { skip: (w) => w.vendor_id == null,
          search: (v) => vendorNames.get(v) || v }),
    })
    gs.push({
      id: 'tech', label: 'Technician', selected: filters.tech,
      options: buildOptions(viewBase, filters, 'tech',
        (v) => (v === NONE ? <em>Unassigned</em> : v),
        { skip: (w) => w.wo_type === 'outside',
          search: (v) => (v === NONE ? 'unassigned' : v) }),
    })
    gs.push({
      id: 'priority', label: 'Priority', selected: filters.priority,
      options: buildOptions(viewBase, filters, 'priority',
        (v) => PRIORITY_META[v as WoPriority]?.label ?? v,
        { order: ['high', 'normal', 'low'] }),
    })
    gs.push({
      id: 'campaign', label: 'Campaign / PM', selected: filters.campaign,
      options: buildOptions(viewBase, filters, 'campaign',
        (v) => (v === '' ? <em>No campaign</em>
          : CAMPAIGN_OPTS.find((c) => c.key === v)?.label ?? v),
        { search: (v) => (v === '' ? 'none'
          : CAMPAIGN_OPTS.find((c) => c.key === v)?.label ?? v) }),
    })
    gs.push({
      id: 'unit', label: 'Unit', selected: filters.unit, searchable: true,
      limit: 8,
      options: buildOptions(viewBase, filters, 'unit',
        (v) => {
          const y = ymmOf(v)
          return y ? <><strong>{v}</strong> <span className="muted">{y}</span></> : v
        },
        { search: (v) => `${v} ${ymmOf(v)}` }),
    })
    gs.push({
      id: 'waiting', label: 'Waiting for parts', selected: filters.waiting,
      options: buildOptions(viewBase, filters, 'waiting',
        (v) => (v === 'yes' ? 'Waiting for parts' : 'Not waiting'),
        { order: ['yes', 'no'] }),
    })
    return gs
  }, [view, viewBase, filters, vendorNames, ymmOf])
  const ranges: FilterRange[] = [
    { id: 'created', label: 'Created date', ...filters.created },
    { id: 'service', label: 'Service date', ...filters.service },
    { id: 'closed', label: 'Closed date', ...filters.closed },
    { id: 'worked', label: 'Work date', ...filters.worked },
  ]

  function toggleFilter(groupId: string, value: string) {
    setFilters((f) => {
      const g = groupId as SetGroup
      const next = new Set(f[g])
      if (next.has(value)) next.delete(value); else next.add(value)
      return { ...f, [g]: next }
    })
  }
  function clearGroup(groupId: string) {
    setFilters((f) => ({ ...f, [groupId as SetGroup]: new Set<string>() }))
  }
  function setRange(id: string, from: string, to: string) {
    setFilters((f) => ({ ...f, [id as RangeId]: { from, to } }))
  }
  // Tira de métricas: un segmento = filtro de ese status (toggle). En
  // History el status no filtra, así que no se resalta ninguno.
  const stripActive = view !== 'history' && filters.status.size === 1
    ? [...filters.status][0] : null
  function pickStatus(key: string) {
    setFilters((f) => ({
      ...f,
      status: (f.status.size === 1 && f.status.has(key))
        ? new Set<string>() : new Set([key]),
    }))
    if (view === 'history') setView('list')
  }

  function refresh() {
    qc.invalidateQueries({ queryKey: ['workorders'] })
    // Prefijo: todos los detalles ['workorder', id] (el drawer los lee).
    qc.invalidateQueries({ queryKey: ['workorder'] })
  }

  // List: elegir una WO (y en móvil pasar al detalle).
  function select(id: number) {
    setSel(id)
    setShowDetail(true)
  }
  // ↑/↓ en la lista maestra mueven la selección (y el foco).
  function onListKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    if (!rows.length) return
    const i = rows.findIndex((w) => w.id === sel)
    const j = i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1,
      i + (e.key === 'ArrowDown' ? 1 : -1)))
    setSel(rows[j].id)
    listRef.current?.querySelectorAll<HTMLButtonElement>('.wom-row')[j]
      ?.focus()
  }

  // Mover una WO de columna (kanban): optimista + patch, con los mismos
  // efectos que el cambio de estado del detalle (pm_miles, PM tracker,
  // Telegram). El optimista toca la lista Y el detalle ['workorder', id]
  // para que el panel no muestre el estado viejo al reabrir. Si un gate del
  // backend bloquea el avance (p.ej. "assign a mechanic"), revierte ambos y
  // muestra el motivo.
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

  // Columnas del board: con filtro de status, solo las elegidas.
  const boardCols = filters.status.size
    ? ACTIVE_PIPELINE.filter((s) => filters.status.has(s)) : ACTIVE_PIPELINE

  const filtersButton = (
    <button ref={fltBtnRef} type="button"
      className={`btn btn-ghost btn-xs wo-fltbtn ${activeCount ? 'is-on' : ''}`}
      aria-haspopup="dialog" aria-expanded={fltOpen}
      onClick={() => setFltOpen((o) => !o)}>
      {I.funnel}
      Filters
      {activeCount > 0 && (
        <span className="wo-fltbadge">{activeCount} active</span>
      )}
    </button>
  )
  const searchBox = (cls: string) => (
    <input className={`cell-input ${cls}`}
      placeholder="Search WO#, unit, title, technician, vendor…"
      aria-label="Search work orders"
      value={q} onChange={(e) => setQ(e.target.value)} />
  )

  // Empty state compartido (lista maestra / tabla / history).
  const emptyText = view === 'history'
    ? 'No invoiced work orders match.'
    : activeCount || q.trim()
      ? 'No work orders match these filters.'
      : 'No work orders yet. Create one here or from an open defect in Fleet.'

  return (
    <div className="page page-wide wo-page">
      {listQ.isFetching && <div className="loadbar" aria-hidden="true" />}
      <div className="page-head">
        <div>
          <h1>Work Orders</h1>
          <p className="page-sub">
            Shop pipeline: defects to repairs to costs, with PM closeout.
          </p>
        </div>
        <div className="head-actions">
          {editable && (
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

      {/* Tira del pipeline (reemplaza a las tarjetas negras). */}
      <PipelineStrip
        loading={listQ.isPending}
        active={stripActive}
        onSelect={pickStatus}
        segments={[
          { key: 'open', label: 'Open', count: stats?.open ?? 0,
            tone: stats?.open ? 'warn' : 'neutral' },
          { key: 'assigned', label: 'Assigned', count: stats?.assigned ?? 0,
            tone: 'info' },
          { key: 'in_progress', label: 'In progress',
            count: stats?.in_progress ?? 0, tone: 'info' },
          { key: 'completed', label: 'To invoice',
            count: stats?.completed ?? 0,
            tone: stats?.completed ? 'ok' : 'neutral' },
        ]}
        kpis={[
          { key: 'waiting', label: 'Parts blocking',
            value: stats?.waiting_parts ?? 0,
            tone: stats?.waiting_parts ? 'warn' : 'neutral',
            title: 'Active work orders waiting for parts' },
          // v2.21: trabajo en talleres externos todavía sin facturar.
          { key: 'outside', label: 'At vendors',
            value: stats?.outside_open ?? 0,
            tone: stats?.outside_open ? 'accent' : 'neutral',
            title: 'Outside work orders not yet invoiced' },
          { key: 'cost', label: 'Cost 30d', value: money(stats?.cost_30d ?? 0),
            tone: 'accent', title: 'Invoiced in the last 30 days' },
        ]} />

      {/* Barra de vistas + terminal (+ búsqueda y filtros fuera de List,
          donde viven en la cabecera de la lista maestra). */}
      <div className="wo-toolbar">
        <Tabs
          aria-label="View"
          className="wo-vtabs"
          tabs={[
            { id: 'list', label: <VTab icon={I.list}>List</VTab> },
            { id: 'table', label: <VTab icon={I.table}>Table</VTab> },
            { id: 'board', label: <VTab icon={I.board}>Board</VTab> },
            { id: 'history', label: <VTab icon={I.history}>History</VTab> },
          ]}
          value={view}
          onChange={(id) => setView(id as WoView)}
        />
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
        {view !== 'list' && (
          <>
            {searchBox('wo-search')}
            {filtersButton}
          </>
        )}
      </div>

      {listQ.isPending ? (
        <section className="card"><div className="card-body">
          <div className="skel-rows">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} h={38} />)}
          </div>
        </div></section>
      ) : view === 'list' ? (
        /* ===== List: lista maestra + panel de detalle ===== */
        <div ref={splitRef}
          className={`wo-split ${showDetail ? 'show-detail' : ''} ${expanded ? 'is-expanded' : ''}`}>
          <aside className="wo-master" aria-label="Work orders">
            <div className="wom-head">
              {searchBox('wom-search')}
              {filtersButton}
            </div>
            <div className="wom-sub">
              <span>{rows.length} work order{rows.length === 1 ? '' : 's'}</span>
              {withInvoiced && (
                <button type="button" className="wom-clear"
                  title="Invoiced work orders are listed too — click to hide them"
                  onClick={() => setWithInvoiced(false)}>
                  Incl. invoiced ✕
                </button>
              )}
              {activeCount > 0 && (
                <button type="button" className="wom-clear"
                  onClick={() => { setFilters(emptyFilters()); setWithInvoiced(false) }}>
                  Clear filters
                </button>
              )}
            </div>
            <div className="wom-list" ref={listRef} role="listbox"
              aria-label="Work orders" onKeyDown={onListKey}>
              {rows.length === 0 ? (
                <div className="empty mini wom-empty"><p>{emptyText}</p></div>
              ) : rows.map((w) => {
                const child = w.parent_id != null
                  && rows.some((p) => p.id === w.parent_id)
                const isSel = w.id === sel
                const ymm = ymmOf(w.unit)
                return (
                  <button type="button" key={w.id} role="option"
                    aria-selected={isSel}
                    className={`wom-row ${isSel ? 'is-sel' : ''} ${child ? 'is-child' : ''}`}
                    onClick={() => select(w.id)}>
                    <span className="wom-l1">
                      <span className="wom-no mono">#{w.display_no}</span>
                      <WoTypeBadge wo={w} compact className="wom-type" />
                      <span className="head-spacer" />
                      <span className={`wo-status ${STATUS_META[w.status].cls}`}>
                        {STATUS_META[w.status].label}
                      </span>
                    </span>
                    <span className="wom-l2">
                      <strong className="wom-unit">{w.unit}</strong>
                      {ymm && <span className="wom-ymm" title={ymm}>{ymm}</span>}
                    </span>
                    <span className="wom-l3">
                      <span className="wom-title" title={w.title}>{w.title}</span>
                      <span className="wom-meta">
                        {w.wo_type === 'inside' && w.mechanic && (
                          <span className="wom-mech" title="Technician">
                            {w.mechanic}
                          </span>
                        )}
                        {w.priority !== 'normal' && (
                          <span className={`wo-priority ${PRIORITY_META[w.priority].cls}`}>
                            {PRIORITY_META[w.priority].label}
                          </span>
                        )}
                        {w.is_pm && <span className="wo-pm-tag">PM</span>}
                        {!w.is_pm && w.campaign && (
                          <span className="wo-pm-tag" title="Campaign">
                            {w.campaign.toUpperCase()}
                          </span>
                        )}
                        {w.waiting_parts && (
                          <span className="wom-wait" title="Waiting for parts">
                            <i />parts
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </aside>
          <section className="wo-detail-pane" aria-label="Work order detail">
            {sel != null ? (
              <WoDetail key={sel} woId={sel} variant="pane"
                onClose={() => { setSel(null); setShowDetail(false); refresh() }}
                onNavigate={(id) => setSel(id)}
                onBack={() => setShowDetail(false)}
                expanded={expanded}
                onToggleExpand={() => setExpanded((e) => !e)} />
            ) : (
              <div className="wod-empty">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
                  aria-hidden="true">
                  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                  <path d="M14 3v5h5M9 13h6M9 17h4" />
                </svg>
                <strong>Select a work order</strong>
                <span>
                  Pick one from the list, or use <kbd>↑</kbd> <kbd>↓</kbd> to
                  move between orders.
                </span>
              </div>
            )}
          </section>
        </div>
      ) : view === 'board' ? (
        /* ===== Board (kanban): arrastrar tarjetas entre estados ===== */
        <section className="wo-board-wrap">
          <div className="wo-board"
            style={{ '--wo-cols': boardCols.length } as CSSProperties}
            onDragEnd={() => setDragCol(null)}>
            {boardCols.map((col) => {
              const cards = shown.filter((w) => w.status === col)
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
        /* ===== Table / History ===== */
        <section className="card">
          <div className="card-head">
            <h2>{view === 'history' ? 'Invoiced history' : 'Orders'}</h2>
            <span className="sub">{shown.length} shown</span>
          </div>
          <div className="card-body">
            {shown.length === 0 ? (
              <div className="empty mini"><p>{emptyText}</p></div>
            ) : (
              <div className="table-wrap">
                <table className="defects-table wo-table">
                  <thead>
                    <tr>
                      <th>WO#</th>
                      <th>Unit</th>
                      <th>Title</th>
                      <th>Technician</th>
                      <th>Priority</th>
                      <th>Status</th>
                      <th className="num">Total</th>
                      <th>{view === 'history' ? 'Invoiced' : 'Created'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((w) => (
                      <tr key={w.id} onClick={() => setOpenWo(w.id)}
                        className={w.parent_id ? 'wo-row-child' : ''}>
                        <td className="mono">#{w.display_no}</td>
                        <td><span className="unit-code">{w.unit}</span>
                          {w.is_pm && <span className="wo-pm-tag">PM</span>}
                        </td>
                        <td className="wo-title">{w.title}</td>
                        <td>
                          {w.wo_type === 'outside'
                            ? <WoTypeBadge wo={w} compact />
                            : (w.mechanic || <span className="muted">—</span>)}
                        </td>
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

      {fltOpen && (
        <FiltersPanel anchor={fltBtnRef} onClose={() => setFltOpen(false)}
          groups={groups} ranges={ranges}
          onToggle={toggleFilter} onClearGroup={clearGroup} onRange={setRange}
          onClearAll={() => { setFilters(emptyFilters()); setWithInvoiced(false) }}
          activeCount={activeCount} resultCount={shown.length} />
      )}

      {creating && (
        <CreateWoModal
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false)
            refresh()
            if (view === 'list') select(id)
            else setOpenWo(id)
          }} />
      )}

      {/* Table / Board / History abren el drawer; List usa el panel. */}
      <WoDrawer woId={openWo}
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

// Vendor elegido para una orden outside: alcanza con id + nombre/ciudad/
// estado (un candidato del match también sirve, no solo el Vendor completo).
type VendorRef = Pick<Vendor, 'id' | 'name' | 'city' | 'state'>
// Vendor leído del escaneo que NO existe todavía: se crea al enviar.
type VendorDraft = { name: string; city: string; state: string }

// Exportado (v2.22): el menú "+" Add New del shell lo abre (Work Order /
// Outside Work vía initialType).
export function CreateWoModal({ onClose, onCreated, initialType }: {
  onClose: () => void
  onCreated: (id: number) => void
  initialType?: WoType
}) {
  const qc = useQueryClient()
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
  // v2.21: inside (taller propio, técnico) / outside (taller externo =
  // Vendor). Outside exige un vendor elegido — o uno nuevo leído del
  // escaneo, que se crea al enviar (vendorNew).
  const [woType, setWoType] = useState<WoType>(initialType ?? 'inside')
  const [vendorSel, setVendorSel] = useState<VendorRef | null>(null)
  const [vendorNew, setVendorNew] = useState<VendorDraft | null>(null)
  // "Matched vendor X" tras el escaneo; candidatos cercanos sin match.
  const [vendorNotice, setVendorNotice] = useState('')
  const [vendorCands, setVendorCands] = useState<VendorCandidate[]>([])
  // Taller tal como lo leyó el escaneo (texto): alimenta el chip "Create
  // vendor…" y el formato del complaint mientras no hay vendor elegido.
  const [vendor, setVendor] = useState('')
  const [vendorCity, setVendorCity] = useState('')
  const [vendorState, setVendorState] = useState('')
  const [invoiceNum, setInvoiceNum] = useState('')
  const [mechanic, setMechanic] = useState('')
  const [priority, setPriority] = useState<WoPriority>('normal')
  const [campaign, setCampaign] = useState('')
  const [mileage, setMileage] = useState('')
  // v2.22: horómetro del reefer (solo campaña 'reefer'; nunca el odómetro).
  const [engineHours, setEngineHours] = useState('')
  const [date, setDate] = useState(todayISO())
  const vendorHint = woType === 'outside' && !vendorSel && !vendorNew
    ? 'Outside work needs the vendor (third-party shop)' : ''
  // v2.22 [C] Bill to: Self | Customer. Hasta que el usuario lo toque, el
  // default sale del DUEÑO de la unidad (owner-operator) — derivado, sin
  // efectos. `bill` = elección explícita.
  const owners = useUnitOwners()
  const unitOwner = unitOk && unit.trim() ? owners.ownerOf(unitName(unit)) : null
  const [bill, setBill] = useState<
    { mode: BillMode; customer: PickedCustomer | null } | null>(null)
  const billMode: BillMode = bill?.mode ?? (unitOwner ? 'customer' : 'self')
  const billCustomer = bill ? bill.customer : unitOwner
  const billHint = billMode === 'customer' && !billCustomer
    ? 'Pick the customer to bill (or switch to Self)' : ''
  // El campo Vendor se marca inválido (rojo + aria-invalid) cuando el usuario
  // ya interactuó con él (lo vació) o el escaneo trajo un taller sin match;
  // recién abierto / al pasar a Outside a mano solo queda la pista del pie.
  const [vendorTouched, setVendorTouched] = useState(false)

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
      // v2.22: costo promedio real (si hay); si no, el costo de catálogo.
      ...(hit ? { description: l.description || hit.description,
                  unit_cost: partUnitCost(hit) } : {}),
    } : l)))
  }

  // Elegir un vendor (del picker, de un candidato o del match del escaneo).
  function chooseVendor(v: VendorRef | null, notice = '') {
    setVendorSel(v)
    setVendorNew(null)
    setVendorNotice(notice)
    if (v) setVendorCands([])
    else setVendorTouched(true)
  }

  // v2.21: el escaneo trajo un nombre de taller → la orden es outside; se
  // busca el vendor (matchVendor es best-effort: si falla, queda el chip
  // "Create vendor…" y los candidatos vacíos).
  async function resolveScannedVendor(
    name: string, city: string, state: string,
  ) {
    setVendor(name)
    setVendorCity(city)
    setVendorState(state)
    setWoType('outside')
    try {
      const m = await matchVendor({ name, city, state })
      if (m.vendor) {
        chooseVendor(m.vendor, `Matched vendor ${m.vendor.name}`)
      } else {
        setVendorSel(null)
        setVendorNew(null)
        setVendorNotice('')
        setVendorCands(m.candidates.slice(0, 3))
        setVendorTouched(true)
      }
    } catch {
      setVendorCands([])
      setVendorTouched(true)
    }
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
      // Taller en el invoice → outside work + match del vendor (v2.21).
      if (x.vendor?.trim()) {
        await resolveScannedVendor(
          x.vendor.trim(), x.vendor_city ?? '', x.vendor_state ?? '')
      }
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
    if (vendorHint) {
      notifyErr('Missing vendor', vendorHint)
      return
    }
    if (billHint) {
      notifyErr('Missing customer', billHint)
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
      // v2.21: vendor nuevo leído del escaneo → se crea primero (kind shop).
      let vendorId: number | null = vendorSel?.id ?? null
      let shop = vendorSel
      if (woType === 'outside' && !vendorId && vendorNew) {
        const v = await saveVendor({
          name: vendorNew.name, city: vendorNew.city,
          state: vendorNew.state.toUpperCase(), kind: 'shop',
        })
        qc.invalidateQueries({ queryKey: ['vendors'] })
        vendorId = v.id
        shop = v
        setVendorSel(v)
        setVendorNew(null)
      }
      // Taller para el formato del complaint: el vendor elegido (outside) o
      // nada (inside: trabajo propio).
      const shared: SharedInvoice = woType === 'outside'
        ? { vendor: shop?.name ?? vendor, city: shop?.city ?? vendorCity,
            state: shop?.state ?? vendorState, invoice: invoiceNum, date }
        : { vendor: '', city: '', state: '', invoice: '', date }
      const allLines = scanLines.filter((l) => l.description.trim())
      const shopInv = woType === 'outside' ? invoiceNum.trim() : ''
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
      // le carga SUS líneas (una llamada, v2.21) y le adjunta el MISMO archivo
      // de invoice.
      const created: WorkOrder[] = []
      async function makeWo(u: string, k: string, cs: ComplaintDraft[],
                            parentId: number | null): Promise<WorkOrder> {
        const camp = (parentId === null ? campaign : '')
          || (cs.some((c) => c.is_pm) ? 'pm' : '')
        // Bill to: la orden padre lleva la elección; las hijas (otras
        // unidades del invoice) toman el dueño de SU unidad en el backend,
        // salvo Self explícito (0 para todas: el backend toma null/ausente
        // como "no vino" => dueño de la unidad, y 0 como Self).
        const billTo = billMode === 'self'
          ? (bill ? { customer_id: 0 } : {})
          : parentId === null ? { customer_id: billCustomer?.id ?? 0 } : {}
        const wo0 = await createWorkOrder({
          ...billTo,
          unit: u,
          title: titleFor(cs, camp),
          complaint: cs.map((c) => formatComplaint(c, shared)).join('\n\n'),
          mechanic: woType === 'inside' ? mechanic.trim() : '',
          priority, campaign: camp, shop_invoice: shopInv,
          mileage: (parentId === null && mileage) ? Number(mileage)
            : (cs[0]?.mileage ? Number(cs[0].mileage) : null),
          service_date: date,
          source: scanName ? 'scan' : 'manual',
          parent_id: parentId,
          wo_type: woType,
          vendor_id: woType === 'outside' ? vendorId : null,
          ...(camp === 'reefer' && engineHours.trim()
            && Number.isFinite(Number(engineHours))
            ? { engine_hours: Number(engineHours) } : {}),
        })
        // Self explícito: red de seguridad si el backend igual tomó al dueño
        // de la unidad (0 = Self también en el PATCH; null se ignora ahí).
        const wo = billMode === 'self' && bill && wo0.customer_id != null
          ? await patchWorkOrder(wo0.id, { customer_id: 0 })
          : wo0
        const ls = linesFor(k)
        if (ls.length) {
          await addWoLinesBulk(wo.id, ls.map((ln) => ({
            kind: ln.kind, description: ln.description.trim(),
            qty: Number(ln.qty) || 1, unit_cost: Number(ln.unit_cost) || 0,
            part_number: ln.part_number ?? '',
          })))
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
        + (nLines ? ` · ${nLines} cost lines` : '')
        + (woType === 'outside' && shop ? ` · ${shop.name}` : ''))
      qc.invalidateQueries({ queryKey: ['technicians'] })
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
  // Chip "Create vendor…" (vendor del escaneo sin match ni elección).
  const scannedDraft: VendorDraft | null = vendor.trim()
    ? { name: vendor.trim(), city: vendorCity.trim(), state: vendorState.trim() }
    : null

  return (
    <Modal title="New work order" width={1360} fullHeight onClose={onClose}>
      <div className="wo-modal-grid">
      {/* Columna izquierda: escáner + preview del documento (H3b). Smart
          Fill sirve para inside y outside: un invoice de taller externo
          pasa la orden a outside y busca el vendor. */}
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
                  : 'Smart Fill: scan an invoice or estimate'}
            </strong>
            <span>
              {scanning
                ? 'Reading the document with AI'
                : 'PDF or photo. The form fills itself — inside or outside work.'}
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
        {/* v2.21: Inside work (taller propio) · Outside work (vendor). */}
        <WoTypeSwitch value={woType} onChange={setWoType}
          className="wo-type-switch" />
        <label className="ud-field">
          <span>Unit</span>
          <UnitPicker value={unit} onChange={setUnit}
            extraUnits={knownUnits} placeholder="Pick a unit" />
        </label>
        {/* v2.22 [C]: a quién se le factura. Default = dueño de la unidad. */}
        <BillToField
          mode={billMode}
          customer={billCustomer}
          onMode={(m) => setBill({ mode: m, customer: billCustomer })}
          onCustomer={(c) => setBill({ mode: 'customer', customer: c })}
          invalid={!!billHint && !!bill}
          hint={billMode === 'customer' && billCustomer && !bill
            && unitOwner?.id === billCustomer.id
            ? `${billCustomer.name} owns ${unitName(unit)} — billed with their markup`
            : billMode === 'customer'
              ? 'Parts and labor are billed to this customer with their markup'
              : undefined} />
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
        {/* Outside work: vendor (requerido) + nº de invoice del taller.
            Alimenta el formato de cada complaint (SHOP, CITY, ST). */}
        {woType === 'outside' && (
          <div className="wo-form-row wo-shop-row wo-vendor-row">
            <div className="ud-field wo-vendor-field">
              <span>Vendor · third-party shop</span>
              {vendorNew ? (
                <span className="wot-newchip" title="Created when you submit">
                  <span className="wot-eyebrow">New vendor</span>
                  <strong>{vendorLabel(vendorNew)}</strong>
                  <button type="button" className="icon-x"
                    aria-label="Discard new vendor"
                    onClick={() => setVendorNew(null)}>✕</button>
                </span>
              ) : (
                <VendorPicker value={vendorSel?.id ?? null}
                  aria-label="Vendor"
                  placeholder="Pick the shop that did the work"
                  createDefaults={{ city: vendorCity, state: vendorState }}
                  invalid={!!vendorHint && vendorTouched}
                  errorText={vendorHint}
                  onChange={(v) => chooseVendor(v)} />
              )}
              {vendorNotice && (
                <span className="field-hint wot-hint is-ok">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none"
                    stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"
                    strokeLinejoin="round" aria-hidden="true">
                    <path d="m20 6-11 11-5-5" />
                  </svg>
                  {vendorNotice}
                </span>
              )}
              {!vendorSel && !vendorNew && scannedDraft && (
                <span className="wot-chips">
                  <button type="button" className="wot-chip"
                    title="Create this vendor as a service shop when you submit"
                    onClick={() => setVendorNew(scannedDraft)}>
                    + Create vendor “{vendorLabel(scannedDraft)}”
                  </button>
                  {vendorCands.map((c) => (
                    <button type="button" key={c.id} className="wot-chip is-cand"
                      title={`${Math.round(c.score * 100)}% name match`}
                      onClick={() => chooseVendor(c)}>
                      Use “{vendorLabel(c)}”
                    </button>
                  ))}
                </span>
              )}
            </div>
            <label className="ud-field wo-invoice-field">
              <span>Vendor invoice #</span>
              <input className="cell-input" value={invoiceNum}
                onChange={(e) => setInvoiceNum(e.target.value)} />
            </label>
          </div>
        )}

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
          {/* Inside work: técnico del roster (texto libre también vale;
              el backend lo suma al roster). Outside no tiene técnico propio. */}
          {woType === 'inside' && (
            <label className="ud-field">
              <span>Technician</span>
              <TechnicianPicker value={mechanic} onChange={setMechanic}
                aria-label="Technician" placeholder="Assign a technician" />
            </label>
          )}
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
        {campaign === 'reefer' && (
          <label className="ud-field">
            <span>Reefer engine hours</span>
            <input className="cell-input" type="number" min={0} step="0.1"
              value={engineHours} placeholder="hour meter at the service"
              onChange={(e) => setEngineHours(e.target.value)} />
            <span className="settings-sub">
              Reefer PM is tracked on the unit's hour meter, never on the
              odometer. Logged when the order is invoiced.
            </span>
          </label>
        )}

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
            disabled={saving || !!unitsHint || !!vendorHint || !!billHint}>
            {saving ? 'Creating…'
              : woType === 'outside' ? 'Create outside work order'
                : 'Create work order'}
          </button>
          {/* Sin unidad válida (de la flota) o sin vendor (outside) no se
              crea: pista visible (la del vendor, solo mientras el campo no
              esté ya marcado en rojo). */}
          {(unitsHint || (vendorHint && !vendorTouched) || billHint) && (
            <span className="field-hint">
              {unitsHint || (vendorHint && !vendorTouched ? vendorHint : '')
                || billHint}
            </span>
          )}
        </div>
      </div>
      </div>
    </Modal>
  )
}

