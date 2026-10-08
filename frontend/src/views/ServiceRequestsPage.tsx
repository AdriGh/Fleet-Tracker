// Service Requests (v2.20): backlog por unidad — defectos DVIR abiertos,
// PM/DOT por vencer y pedidos manuales — desde el que se despacha a work
// orders (Deny / Snooze / Add to WO / Create WO). Layout maestro-detalle
// estilo SquareRigger: unidades a la izquierda, sus requests a la derecha.
// El backend materializa las fuentes (sync con TTL en cada GET); acá solo
// se lee, se filtra client-side y se despacha.
import {
  useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent, type ReactNode,
} from 'react'
import {
  keepPreviousData, useQuery, useQueryClient, type QueryClient,
} from '@tanstack/react-query'
import {
  addRequestToWo, createServiceRequest, createWoFromRequests,
  deleteServiceRequests,
  denyServiceRequest, listFleet, listServiceRequests, listWorkOrders,
  patchServiceRequest, reopenServiceRequest, restoreServiceRequests,
  snoozeServiceRequest, syncServiceRequests, unlinkRequest,
  type FleetUnit, type ServiceRequest, type SrDeleteResult, type SrList,
  type SrListStatus, type SrPriority, type SrSource, type SrUnitSummary,
  type WoPriority, type WorkOrder,
} from '../api'
import { Badge, Button, Tabs } from '../components/ds'
import Modal from '../components/Modal'
import Skeleton from '../components/Skeleton'
import TechnicianPicker from '../components/TechnicianPicker'
import UnitPicker from '../components/UnitPicker'
import { notifyErr, notifyOk, notifyUndo, notifyWarn } from '../toast'
import { usePerms } from '../perms'
import { unitsFromNames, useUnitMatcher, type PickerUnit } from '../unitMatch'
import { STATUS_META, WoDrawer } from './WorkOrdersPage'

// ----- Metadatos de presentación ---------------------------------------------

const SOURCES: SrSource[] = ['defect', 'pm', 'dot', 'manual']

// label = etiqueta chica del card (va en mayúsculas por CSS); chip = filtro;
// one/many = resumen del encabezado ("2 DVIR defects · 1 scheduled PM").
const SOURCE_META: Record<SrSource, {
  label: string; chip: string; one: string; many: string
}> = {
  defect: { label: 'DVIR defect', chip: 'Defects', one: 'DVIR defect', many: 'DVIR defects' },
  pm: { label: 'Scheduled PM', chip: 'PM', one: 'scheduled PM', many: 'scheduled PMs' },
  dot: { label: 'DOT inspection', chip: 'DOT', one: 'DOT inspection', many: 'DOT inspections' },
  manual: { label: 'Service request', chip: 'Requests', one: 'request', many: 'requests' },
}

const STATUS_TABS: { id: SrListStatus; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'snoozed', label: 'Snoozed' },
  { id: 'on_wo', label: 'On WO' },
  { id: 'denied', label: 'Denied' },
  { id: 'done', label: 'Done' },
]

const PRIO_RANK: Record<SrPriority, number> = {
  emergency: 3, urgent: 2, normal: 1, low: 0,
}
const PRIO_LABEL: Record<SrPriority, string> = {
  emergency: 'Emergency', urgent: 'Urgent', normal: 'Normal', low: 'Low',
}

// ----- Helpers ---------------------------------------------------------------

const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, '')
const fmtNum = (n: number) => Math.round(n).toLocaleString('en-US')
const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function isoLocal(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}
const todayISO = () => isoLocal(new Date())
function addDaysISO(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return isoLocal(d)
}

// "2026-10-13" (o un ISO con hora) → "Oct 13" (con año si no es el actual).
function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return s
  const y = Number(m[1])
  const label = `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`
  return y === new Date().getFullYear() ? label : `${label}, ${y}`
}

// date_label del feed de defectos viene como "10.6" (mes.día).
function fmtDateLabel(s: string): string {
  const m = /^(\d{1,2})\.(\d{1,2})$/.exec(s.trim())
  return m ? `${MONTHS[Number(m[1]) - 1] ?? m[1]} ${Number(m[2])}` : s
}

// Hora local del último sync ("synced_at" sin zona → se toma como local).
function fmtTime(s: string | null): string {
  if (!s) return ''
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function fleetModel(u: FleetUnit | undefined): string {
  if (!u) return ''
  return [u.year, u.make, u.model].filter((x) => x && String(x).trim())
    .join(' ')
}

// Todas las vistas que muestran requests o WOs (contrato v2.20).
function invalidateSr(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ['service-requests'] })
  qc.invalidateQueries({ queryKey: ['workorders'] })
  qc.invalidateQueries({ queryKey: ['workorder'] })
  qc.invalidateQueries({ queryKey: ['unit-wos'] })
}

const metaNum = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

// Fila de la lista izquierda: una unidad con sus requests filtrados.
// Agrupada por unidad NORMALIZADA (`key`): "MEM77" y "MEM 77" son una
// sola fila; `unit` es el nombre canónico que se muestra.
interface UnitRow {
  key: string
  unit: string
  // Duplicados VISIBLES en esta pestaña (con los filtros aplicados): lo
  // mismo que borra "Remove N duplicates" — nunca uno de la otra pestaña.
  dups: number
  company: string
  model: string
  count: number
  bySource: Record<SrSource, number>
  top: SrPriority
  overMiles: number | null   // peor PM vencido (millas pasadas)
  overDays: number | null    // DOT vencido (días pasados)
}

// ----- Iconos ----------------------------------------------------------------

function SrIcon({ source }: { source: SrSource }) {
  const common = {
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 2, strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const, 'aria-hidden': true,
  }
  if (source === 'defect') {
    return (
      <svg {...common}>
        <path d="M10.3 3.5 1.8 18a1.5 1.5 0 0 0 1.3 2.2h17.8A1.5 1.5 0 0 0 22.2 18L13.7 3.5a1.5 1.5 0 0 0-2.6 0z" />
        <path d="M12 9v4M12 17h.01" />
      </svg>
    )
  }
  if (source === 'pm') {
    return (
      <svg {...common}>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M16 3v4M8 3v4M3 10h18" />
      </svg>
    )
  }
  if (source === 'dot') {
    return (
      <svg {...common}>
        <path d="M9 4h6M9 4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2M9 4v2h6V4" />
        <path d="m9.5 13 1.8 1.8 3.2-3.6" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L4 16.8 7.2 20l5.3-5.3a4 4 0 0 0 5.2-5.4l-2.5 2.5-2.3-.5-.5-2.3z" />
    </svg>
  )
}

const Chevron = () => (
  <svg className="sr-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
)

const TrashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    width="14" height="14">
    <path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2l1-12M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7" />
  </svg>
)

// Urgent (naranja) / Emergency (rojo) sólidos; Low solo en el card (sutil);
// Normal no lleva badge (el ruido visual se reserva para lo que apura).
function PriorityBadge({ p, showLow = false }: {
  p: SrPriority; showLow?: boolean
}) {
  if (p === 'emergency' || p === 'urgent') {
    return (
      <Badge variant="solid" style={{ background: `var(--sr-${p})` }}>
        {PRIO_LABEL[p]}
      </Badge>
    )
  }
  if (p === 'low' && showLow) {
    return <Badge variant="outline">Low</Badge>
  }
  return null
}

// ----- Menú desplegable chico (Snooze / Add to…) -----------------------------
// Popover anclado al botón; cierra con clic afuera o Escape. `hint` es el
// tooltip cuando está deshabilitado (va en el wrapper: un <button disabled>
// no recibe eventos de mouse en todos los navegadores).
function SrMenu({ label, icon, disabled, hint, align = 'left', children }: {
  label: ReactNode
  icon?: ReactNode
  disabled?: boolean
  hint?: string
  align?: 'left' | 'right'
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  // Corrimiento horizontal (px) para que el menú no se salga del viewport:
  // anclado al botón se pasaba del borde derecho ("Add to…" en un teléfono
  // de 375px llegaba a x≈535) y la página entera scrolleaba de costado. Se
  // mide antes de pintar (layout effect) y se corre lo justo.
  const [shift, setShift] = useState(0)
  const ref = useRef<HTMLSpanElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setShift(0)
      return
    }
    const el = menuRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const vw = document.documentElement.clientWidth
    const pad = 8
    let dx = 0
    if (r.right > vw - pad) dx = vw - pad - r.right
    if (r.left + dx < pad) dx = pad - r.left
    setShift(dx)
  }, [open])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <span className="sr-menu-wrap" ref={ref}
      title={disabled ? hint : undefined}>
      <button type="button" className={`sr-act ${open ? 'is-on' : ''}`}
        disabled={disabled} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}>
        {icon}{label}<Chevron />
      </button>
      {open && (
        <div className={`sr-menu ${align === 'right' ? 'is-right' : ''}`}
          role="menu" ref={menuRef}
          style={shift ? { translate: `${shift}px 0` } : undefined}>
          {children(() => setOpen(false))}
        </div>
      )}
    </span>
  )
}

// ----- Página ----------------------------------------------------------------

export default function ServiceRequestsPage() {
  const qc = useQueryClient()
  const { can } = usePerms()
  const editable = can('maint.edit')

  const [status, setStatus] = useState<SrListStatus>('open')
  const [source, setSource] = useState<SrSource | ''>('')
  const [prio, setPrio] = useState<SrPriority | ''>('')
  const [q, setQ] = useState('')
  // Clave normalizada (norm) de la unidad elegida.
  const [selUnit, setSelUnit] = useState('')
  // Móvil (<=760px): la lista y el detalle se alternan (botón "back").
  const [showDetail, setShowDetail] = useState(false)
  const [picked, setPicked] = useState<Set<number>>(() => new Set())
  const [mech, setMech] = useState('')
  const [woPrio, setWoPrio] = useState<WoPriority | ''>('')
  const [creatingWo, setCreatingWo] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  // Borrado en lote (selección o "Remove N duplicates") en curso.
  const [bulkBusy, setBulkBusy] = useState(false)
  // Tarjeta a resaltar ("Duplicate of #id" → scroll al keeper).
  const [flashId, setFlashId] = useState<number | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [openWo, setOpenWo] = useState<number | null>(null)
  // Modal de alta/edición: null = cerrado; {req} = editar; {unit} = alta.
  const [form, setForm] = useState<
    { req?: ServiceRequest; unit?: string } | null
  >(null)
  const [denying, setDenying] = useState<ServiceRequest | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  // Un fetch por status (sin unit/source: esos filtros son client-side para
  // poder contar por fuente). La key ['service-requests','open','',''] es la
  // misma que usa el badge del nav → comparten caché.
  const srQ = useQuery({
    queryKey: ['service-requests', status, '', ''],
    queryFn: () => listServiceRequests({ status }),
    placeholderData: keepPreviousData,
  })
  // Mismas key/queryFn que la página de Work Orders: caché compartida. De
  // acá salen las WOs abiertas por unidad (strip + "Add to…") y mecánicos.
  const wosQ = useQuery({
    queryKey: ['workorders', ''],
    queryFn: () => listWorkOrders(''),
    placeholderData: keepPreviousData,
  })
  const fleetQ = useQuery({ queryKey: ['fleet'], queryFn: listFleet })

  // Mientras llega otro status, la data previa (placeholder) solo sirve para
  // los conteos de las pestañas: las filas serían de otro status.
  const loading = srQ.isPending || srQ.isPlaceholderData
  const data: SrList | undefined = srQ.data
  const counts = data?.counts
  const requests = useMemo(
    () => (loading ? [] : data?.requests ?? []), [loading, data])

  const fleetByUnit = useMemo(() => {
    const m = new Map<string, FleetUnit>()
    for (const u of fleetQ.data ?? []) m.set(norm(u.unit), u)
    return m
  }, [fleetQ.data])
  // Resumen del backend por unidad normalizada: nombre canónico y modelo
  // (solo unidades con requests open).
  const summaryByKey = useMemo(() => {
    const m = new Map<string, SrUnitSummary>()
    for (const u of data?.units ?? []) m.set(norm(u.unit), u)
    return m
  }, [data?.units])
  // Unidades que el backlog ya muestra (también las que no están en
  // /api/fleet, p. ej. defectos del CSV de MCC): se pueden elegir en
  // "New request" / "+ Request" (el backend las acepta igual).
  const backlogUnits = useMemo<PickerUnit[]>(() => unitsFromNames([
    ...(data?.units ?? []).map((u) => u.unit),
    ...requests.map((r) => r.unit),
  ]), [data?.units, requests])
  // Duplicados solo tienen sentido en lo accionable (open / snoozed).
  const dupTab = status === 'open' || status === 'snoozed'

  // Filtro por texto + prioridad (la fuente se aplica después, así los chips
  // muestran cuántos hay de cada una dentro del resto de filtros).
  const textFiltered = useMemo(() => {
    const s = q.trim().toLowerCase()
    const sn = norm(q)
    return requests.filter((r) =>
      (!prio || r.priority === prio)
      && (!s || norm(r.unit).includes(sn)
        || r.title.toLowerCase().includes(s)
        || r.detail.toLowerCase().includes(s)))
  }, [requests, q, prio])
  const sourceCounts = useMemo(() => {
    const c: Record<SrSource, number> = { defect: 0, pm: 0, dot: 0, manual: 0 }
    for (const r of textFiltered) if (r.source in c) c[r.source] += 1
    return c
  }, [textFiltered])
  const filtered = useMemo(
    () => (source ? textFiltered.filter((r) => r.source === source)
      : textFiltered),
    [textFiltered, source])
  // Duplicados VISIBLES por unidad (esta pestaña + filtros). El chip "N dup"
  // y "Remove N duplicates" cuentan y borran exactamente estos: un
  // duplicado pospuesto no se cuenta (ni se borra) desde Open, ni al revés.
  const dupsByKey = useMemo(() => {
    const m = new Map<string, number>()
    if (!dupTab) return m
    for (const r of filtered) {
      if (r.duplicate_of == null || r.status === 'on_wo') continue
      const k = norm(r.unit)
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return m
  }, [filtered, dupTab])

  // Agrupado por unidad (mismo orden que el backend: emergency > urgent >
  // normal > low, después el peor vencido).
  const rows = useMemo<UnitRow[]>(() => {
    const by = new Map<string, UnitRow>()
    for (const r of filtered) {
      const key = norm(r.unit)
      let row = by.get(key)
      if (!row) {
        const fu = fleetByUnit.get(key)
        const sum = summaryByKey.get(key)
        row = {
          key,
          // Canónico: el del backend (flota), si no el de la flota local,
          // si no la grafía del primer request.
          unit: sum?.unit || fu?.unit || r.unit,
          dups: dupsByKey.get(key) ?? 0,
          company: r.company || fu?.company || '',
          model: fleetModel(fu) || sum?.model || String(r.meta?.model ?? ''),
          count: 0,
          bySource: { defect: 0, pm: 0, dot: 0, manual: 0 },
          top: r.priority,
          overMiles: null,
          overDays: null,
        }
        by.set(key, row)
      }
      row.count += 1
      if (r.source in row.bySource) row.bySource[r.source] += 1
      if ((PRIO_RANK[r.priority] ?? 1) > (PRIO_RANK[row.top] ?? 1)) {
        row.top = r.priority
      }
      if (!row.company && r.company) row.company = r.company
      const toDue = metaNum(r.meta?.to_due)
      if (toDue != null && toDue < 0) {
        if (r.source === 'pm') row.overMiles = Math.max(row.overMiles ?? 0, -toDue)
        if (r.source === 'dot') row.overDays = Math.max(row.overDays ?? 0, -toDue)
      }
    }
    return [...by.values()].sort((a, b) =>
      (PRIO_RANK[b.top] ?? 1) - (PRIO_RANK[a.top] ?? 1)
      || (b.overMiles ?? 0) - (a.overMiles ?? 0)
      || (b.overDays ?? 0) - (a.overDays ?? 0)
      || a.unit.localeCompare(b.unit, 'en', { numeric: true }))
  }, [filtered, fleetByUnit, summaryByKey, dupsByKey])

  // Selección derivada: si la unidad elegida ya no está (despachada,
  // filtrada) se muestra la primera; en móvil además se vuelve a la lista.
  const chosen = rows.find((r) => r.key === selUnit) ?? null
  const sel = chosen ?? rows[0] ?? null
  const detailOpen = showDetail && chosen != null
  const unitReqs = useMemo(
    () => (sel ? filtered.filter((r) => norm(r.unit) === sel.key) : []),
    [filtered, sel])
  // WOs abiertas de la unidad (no completed/invoiced): strip + "Add to…".
  const unitWos = useMemo<WorkOrder[]>(() => {
    if (!sel) return []
    return (wosQ.data?.workorders ?? []).filter((w) =>
      norm(w.unit) === sel.key && w.status !== 'completed'
      && w.status !== 'invoiced')
  }, [wosQ.data, sel])
  // Seleccionables: todo menos on_wo (se desliga de la WO primero), en
  // cualquier pestaña. Solo cuentan los ids visibles en esta unidad.
  const selectable = useMemo(
    () => unitReqs.filter((r) => r.status !== 'on_wo'), [unitReqs])
  const pickedReqs = useMemo(
    () => selectable.filter((r) => picked.has(r.id)), [selectable, picked])
  const pickedIds = pickedReqs.map((r) => r.id)
  // La WO solo admite requests accionables (open / snoozed).
  const pickedCanWo = pickedReqs.length > 0 && pickedReqs.every(
    (r) => r.status === 'open' || r.status === 'snoozed')
  const visibleDups = selectable.filter((r) => r.duplicate_of != null)
  const odometer = useMemo(() => {
    for (const r of unitReqs) {
      const n = metaNum(r.meta?.current_miles)
      if (n != null) return n
    }
    return null
  }, [unitReqs])

  const filtersOn = !!(q.trim() || source || prio)
  const totalShown = filtered.length

  function pick(id: number, on: boolean) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  // Cambiar de unidad limpia los requests elegidos para crear la WO.
  function selectUnit(key: string, openDetail = true) {
    if (key !== sel?.key) setPicked(new Set())
    setSelUnit(key)
    if (openDetail) setShowDetail(true)
  }

  // Flechas arriba/abajo recorren las unidades de la lista.
  function onListKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    if (!rows.length) return
    const i = rows.findIndex((r) => r.key === sel?.key)
    const j = Math.max(0, Math.min(rows.length - 1,
      i + (e.key === 'ArrowDown' ? 1 : -1)))
    selectUnit(rows[j].key, false)
    const btns = listRef.current?.querySelectorAll<HTMLButtonElement>(
      '.sr-urow')
    btns?.[j]?.focus()
  }

  // Acción sobre un request: busy por id, toast e invalidación del contrato.
  async function act(
    r: ServiceRequest, fn: () => Promise<unknown>,
    ok: string, okDetail?: string,
  ) {
    setBusyId(r.id)
    try {
      await fn()
      invalidateSr(qc)
      notifyOk(ok, okDetail)
    } catch (e) {
      notifyErr("Couldn't update the request", e)
    } finally {
      setBusyId(null)
    }
  }

  // ----- Borrado (suave) + Undo -----
  // Un clic, sin modal de confirmación: el toast trae "Undo" (restore). El
  // backend devuelve cada request al estado que tenía antes del borrado
  // (pospuesto, denegado, cerrado por su WO…), no al backlog abierto.
  async function undoDelete(ids: number[]) {
    try {
      const r = await restoreServiceRequests(ids)
      qc.invalidateQueries({ queryKey: ['service-requests'] })
      const n = r.restored.length
      notifyOk(n === 1 ? 'Request restored' : `${n} requests restored`,
        'Back the way it was before the delete')
    } catch (e) {
      notifyErr("Couldn't restore the requests", e)
    }
  }

  // Corre un borrado (uno, selección o duplicados): saca las tarjetas de la
  // caché del tab al instante, invalida ['service-requests'] (badge
  // incluido) y avisa con Undo. Los salteados (p. ej. pasaron a una WO en
  // el medio) se informan aparte con su motivo.
  async function runDelete(
    fn: () => Promise<SrDeleteResult>,
    msg: (n: number) => string,
    detail?: string,
    busy?: number,
  ) {
    if (busy != null) setBusyId(busy)
    else setBulkBusy(true)
    try {
      const res = await fn()
      const ids = res.deleted
      if (ids.length) {
        const gone = new Set(ids)
        qc.setQueryData<SrList>(['service-requests', status, '', ''],
          (old) => (old ? {
            ...old, requests: old.requests.filter((x) => !gone.has(x.id)),
          } : old))
        setPicked((prev) => new Set([...prev].filter((i) => !gone.has(i))))
        notifyUndo(msg(ids.length), () => { void undoDelete(ids) }, detail)
      }
      qc.invalidateQueries({ queryKey: ['service-requests'] })
      if (res.skipped.length) {
        notifyWarn(ids.length
          ? `${plural(res.skipped.length, 'request', 'requests')} not deleted`
          : "Couldn't delete",
          res.skipped.map((s) => `#${s.id}: ${s.reason}`).join(' · '))
      } else if (!ids.length) {
        notifyOk('Nothing to delete', 'Already removed')
      }
    } catch (e) {
      notifyErr("Couldn't delete", e)
    } finally {
      if (busy != null) setBusyId(null)
      else setBulkBusy(false)
    }
  }

  // "Duplicate of #id": lleva al keeper (misma unidad normalizada). Si está
  // oculto por filtros se limpian; si no está en esta pestaña está en la
  // otra accionable (open ↔ snoozed). El efecto de abajo hace el scroll.
  function showKeeper(r: ServiceRequest) {
    const keeperId = r.duplicate_of
    if (keeperId == null) return
    if (!requests.some((x) => x.id === keeperId)) {
      setStatus(status === 'open' ? 'snoozed' : 'open')
      setPicked(new Set())
      setQ(''); setSource(''); setPrio('')
    } else if (!filtered.some((x) => x.id === keeperId)) {
      setQ(''); setSource(''); setPrio('')
    }
    setSelUnit(norm(r.unit))
    setShowDetail(true)
    setFlashId(keeperId)
  }

  useEffect(() => {
    if (flashId == null || loading) return
    const el = document.getElementById(`sr-req-${flashId}`)
    const r = el?.getBoundingClientRect()
    // Solo se scrollea si el keeper no está entero a la vista.
    if (el && r && (r.top < 0 || r.bottom > window.innerHeight)) {
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      el.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' })
    }
    // El resaltado se apaga solo (también si el keeper ya no está).
    const t = window.setTimeout(() => setFlashId(null), 1800)
    return () => window.clearTimeout(t)
  }, [flashId, loading, unitReqs])

  async function createWo(ids: number[], opts: {
    mechanic?: string; priority?: WoPriority | ''
  } = {}) {
    if (!ids.length) return
    setCreatingWo(true)
    try {
      const r = await createWoFromRequests({
        ids,
        mechanic: opts.mechanic?.trim() || undefined,
        priority: opts.priority || undefined,
      })
      const wo = r.workorder
      // Sembrar el detalle: el drawer abre sin parpadeo (igual revalida).
      qc.setQueryData(['workorder', wo.id], wo)
      invalidateSr(qc)
      setPicked(new Set())
      notifyOk(`Work order #${wo.display_no || wo.id} created`,
        `${wo.unit} · ${plural(ids.length, 'request', 'requests')}`)
      setOpenWo(wo.id)
    } catch (e) {
      notifyErr("Couldn't create the work order", e)
    } finally {
      setCreatingWo(false)
    }
  }

  async function checkDue() {
    setSyncing(true)
    try {
      const r = await syncServiceRequests()
      qc.invalidateQueries({ queryKey: ['service-requests'] })
      notifyOk(`${r.created} new · ${r.resolved} cleared`,
        r.reopened ? `${r.reopened} back from snooze` : undefined)
    } catch (e) {
      notifyErr("Couldn't check for due items", e)
    } finally {
      setSyncing(false)
    }
  }

  const syncedAt = fmtTime(data?.synced_at ?? null)
  const statusLabel = STATUS_TABS.find((t) => t.id === status)?.label ?? ''

  return (
    <div className="page page-wide sr-page">
      {(srQ.isFetching || syncing) && (
        <div className="loadbar" aria-hidden="true" />
      )}
      <div className="page-head">
        <div>
          <h1>Service Requests</h1>
          <p className="page-sub">
            Everything each unit needs — defects, PMs due and requests —
            before it becomes a work order.
          </p>
        </div>
        <div className="head-actions">
          {syncedAt && (
            <span className="sr-synced" title={data?.synced_at ?? ''}>
              Checked {syncedAt}
            </span>
          )}
          {editable && (
            <Button variant="ghost" onClick={checkDue} disabled={syncing}
              icon={
                <svg className={syncing ? 'spin' : ''} viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" strokeWidth="2"
                  width="16" height="16" strokeLinecap="round"
                  strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                  <path d="M21 4v5h-5" />
                </svg>
              }>
              Check for due
            </Button>
          )}
          {editable && (
            <Button variant="primary"
              onClick={() => setForm({ unit: sel?.unit ?? '' })}
              icon={
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" width="17" height="17" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              }>
              New request
            </Button>
          )}
        </div>
      </div>

      {srQ.error && (
        <div className="banner error"><span>{String(srQ.error)}</span></div>
      )}

      {/* Filtros. Fila 1: status (conteos del backend) + texto y prioridad;
          fila 2: fuente (conteos dentro del resto de filtros). */}
      <div className="card">
        <div className="card-body sr-filters">
          <div className="filters-row sr-frow">
            <div className="sr-tabs-scroll">
              <Tabs
                aria-label="Status"
                tabs={STATUS_TABS.map((t) => ({
                  id: t.id,
                  label: (
                    <>
                      {t.label}
                      {counts && (
                        <span className="sr-tab-n">{counts[t.id] ?? 0}</span>
                      )}
                    </>
                  ),
                }))}
                value={status}
                onChange={(id) => {
                  setStatus(id as SrListStatus)
                  setPicked(new Set())
                }}
                style={{ flexWrap: 'nowrap' }}
              />
            </div>
            <span className="head-spacer" />
            <select className="cell-input sr-prio-filter" value={prio}
              aria-label="Priority"
              onChange={(e) => setPrio(e.target.value as SrPriority | '')}>
              <option value="">Any priority</option>
              <option value="emergency">Emergency</option>
              <option value="urgent">Urgent</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </select>
            <input className="cell-input sr-search" type="search"
              placeholder="Search unit or text…" value={q}
              aria-label="Search requests"
              onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="sr-chips" role="group" aria-label="Source">
            <button type="button"
              className={`sr-chip ${source === '' ? 'on' : ''}`}
              aria-pressed={source === ''}
              onClick={() => setSource('')}>
              All<i>{textFiltered.length}</i>
            </button>
            {SOURCES.map((s) => (
              <button type="button" key={s}
                className={`sr-chip sr-s-${s} ${source === s ? 'on' : ''}`}
                aria-pressed={source === s}
                onClick={() => setSource(source === s ? '' : s)}>
                <SrIcon source={s} />
                {SOURCE_META[s].chip}
                <i>{sourceCounts[s]}</i>
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="sr-layout">
          <aside className="sr-list">
            <div className="sr-list-body">
              {Array.from({ length: 7 }).map((_, i) => (
                <Skeleton key={i} h={50} r={10} />
              ))}
            </div>
          </aside>
          <section className="sr-detail sr-detail-skel">
            <Skeleton w="40%" h={22} />
            <Skeleton w="60%" h={14} />
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} h={110} r={12} />
            ))}
          </section>
        </div>
      ) : srQ.isError && !data ? (
        // Falló la PRIMERA carga (sin data previa): nunca mostrar "your
        // fleet is clear" — el despachador creería que no hay nada que hacer.
        <div className="sr-empty">
          <strong>Couldn't load service requests.</strong>
          <p>The backlog may not be empty — try again in a moment.</p>
          <button type="button" className="link-btn"
            onClick={() => { void srQ.refetch() }}>
            Retry
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="sr-empty">
          {status === 'open' && !filtersOn ? (
            <>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
                aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="m8 12.5 2.6 2.6L16 9.6" />
              </svg>
              <strong>No open service requests — your fleet is clear.</strong>
              <p>
                Open DVIR defects, PMs and DOT inspections coming due land
                here automatically.
                {editable ? ' Use Check for due to look again now.' : ''}
              </p>
            </>
          ) : filtersOn ? (
            <>
              <strong>No requests match these filters.</strong>
              <button type="button" className="link-btn"
                onClick={() => { setQ(''); setSource(''); setPrio('') }}>
                Clear filters
              </button>
            </>
          ) : (
            <strong>No {statusLabel.toLowerCase()} requests.</strong>
          )}
        </div>
      ) : (
        <div className={`sr-layout ${detailOpen ? 'show-detail' : ''}`}>
          {/* ===== Lista de unidades ===== */}
          <aside className="sr-list" aria-label="Units">
            <div className="sr-list-head">
              <span>{plural(rows.length, 'unit', 'units')}</span>
              <span title={data?.truncated
                ? 'History is capped: only the 1,000 most recent are shown'
                : undefined}>
                {plural(totalShown, 'request', 'requests')}
                {data?.truncated ? ' · latest 1,000' : ''}
              </span>
            </div>
            <div className="sr-list-body" ref={listRef} role="listbox"
              aria-label="Units with service requests"
              onKeyDown={onListKey}>
              {rows.map((row) => (
                <button type="button" key={row.key} role="option"
                  aria-selected={row.key === sel?.key}
                  className={`sr-urow ${row.key === sel?.key ? 'is-sel' : ''}`}
                  onClick={() => selectUnit(row.key)}>
                  <span className="sr-urow-top">
                    <strong className="sr-unum">{row.unit}</strong>
                    <span className="sr-umodel"
                      title={[row.model, row.company].filter(Boolean).join(' · ')}>
                      {[row.model, row.company].filter(Boolean).join(' · ')}
                    </span>
                    <PriorityBadge p={row.top} />
                  </span>
                  <span className="sr-urow-bot">
                    {SOURCES.map((s) => (row.bySource[s] ? (
                      <span key={s} className={`sr-ucount sr-s-${s}`}
                        title={plural(row.bySource[s], SOURCE_META[s].one,
                          SOURCE_META[s].many)}>
                        <SrIcon source={s} />{row.bySource[s]}
                      </span>
                    ) : null))}
                    {row.dups > 0 && (
                      <span className="sr-dupcount"
                        title={plural(row.dups, 'duplicate request',
                          'duplicate requests')}>
                        {row.dups} dup
                      </span>
                    )}
                    <span className="sr-urow-spacer" />
                    {row.overMiles ? (
                      <span className="sr-over">
                        {fmtNum(row.overMiles)} mi over
                      </span>
                    ) : row.overDays ? (
                      <span className="sr-over">
                        DOT {plural(row.overDays, 'day', 'days')} over
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          </aside>

          {/* ===== Detalle de la unidad elegida ===== */}
          {sel && (
            <section className="sr-detail" aria-label={`Unit ${sel.unit}`}>
              <header className="sr-dhead">
                <button type="button" className="sr-back"
                  onClick={() => setShowDetail(false)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2.2" strokeLinecap="round"
                    strokeLinejoin="round" aria-hidden="true">
                    <path d="m15 6-6 6 6 6" />
                  </svg>
                  Units
                </button>
                <div className="sr-dhead-main">
                  <span className="sr-eyebrow">Unit</span>
                  <h2 className="sr-dunit">{sel.unit}</h2>
                  <p className="sr-dsub">
                    {[sel.model, sel.company,
                      odometer != null ? `${fmtNum(odometer)} mi` : '']
                      .filter(Boolean).join(' · ') || '—'}
                  </p>
                  <p className="sr-dcounts">
                    {SOURCES.filter((s) => sel.bySource[s]).map((s) =>
                      plural(sel.bySource[s], SOURCE_META[s].one,
                        SOURCE_META[s].many)).join(' · ')}
                  </p>
                </div>
                {editable && (
                  <div className="sr-dhead-actions">
                    {visibleDups.length > 0 && (
                      // Borra exactamente las tarjetas marcadas "Duplicate
                      // of #…" de esta pestaña; se queda cada original.
                      <Button variant="ghost" size="sm" disabled={bulkBusy}
                        className="sr-dedupe"
                        style={{ color: 'var(--ui-danger)' }}
                        title="Delete the requests marked “Duplicate of #…” below and keep the request each one duplicates. You can undo it."
                        icon={<TrashIcon />}
                        onClick={() => runDelete(
                          () => deleteServiceRequests(
                            visibleDups.map((r) => r.id)),
                          (n) => (n === 1 ? 'Duplicate removed'
                            : `${n} duplicates removed`),
                          sel.unit)}>
                        Remove {plural(visibleDups.length, 'duplicate',
                          'duplicates')}
                      </Button>
                    )}
                    <Button variant="ghost" size="sm"
                      onClick={() => setForm({ unit: sel.unit })}>
                      + Request
                    </Button>
                  </div>
                )}
              </header>

              <div className="sr-wostrip">
                <span className="sr-eyebrow">Open work orders</span>
                {unitWos.length === 0 ? (
                  <span className="sr-muted">
                    None — create one from the requests below.
                  </span>
                ) : unitWos.map((w) => (
                  <button type="button" key={w.id} className="sr-wochip"
                    title={`Open WO #${w.display_no || w.id}`}
                    onClick={() => setOpenWo(w.id)}>
                    <span className="mono">#{w.display_no || w.id}</span>
                    <span className="sr-wochip-title">{w.title}</span>
                    <span className={`wo-status ${STATUS_META[w.status].cls}`}>
                      {STATUS_META[w.status].label}
                    </span>
                  </button>
                ))}
              </div>

              <div className="sr-dbody">
                <div className="sr-reqhead">
                  <span className="sr-eyebrow">
                    {statusLabel} · {unitReqs.length}
                  </span>
                  <span className="sr-reqhead-links">
                    {editable && visibleDups.length > 0 && (
                      <button type="button" className="link-btn"
                        title="Select the duplicates shown here"
                        onClick={() => setPicked(
                          new Set(visibleDups.map((r) => r.id)))}>
                        Select duplicates
                      </button>
                    )}
                    {editable && selectable.length > 1 && (
                      <button type="button" className="link-btn"
                        onClick={() => setPicked(
                          pickedIds.length === selectable.length
                            ? new Set()
                            : new Set(selectable.map((r) => r.id)))}>
                        {pickedIds.length === selectable.length
                          ? 'Clear selection' : 'Select all'}
                      </button>
                    )}
                  </span>
                </div>
                <ul className="sr-cards">
                  {unitReqs.map((r) => (
                    <RequestCard key={r.id} r={r}
                      editable={editable}
                      busy={busyId === r.id || creatingWo || bulkBusy}
                      picked={picked.has(r.id)}
                      flash={flashId === r.id}
                      onPick={(on) => pick(r.id, on)}
                      onDelete={() => runDelete(
                        () => deleteServiceRequests([r.id]),
                        () => 'Request deleted', `${r.unit} · ${r.title}`,
                        r.id)}
                      onShowKeeper={() => showKeeper(r)}
                      unitWos={unitWos}
                      onOpenWo={setOpenWo}
                      onDeny={() => setDenying(r)}
                      onEdit={() => setForm({ req: r })}
                      onSnooze={(until) => act(r,
                        () => snoozeServiceRequest(r.id, until),
                        'Request snoozed', `Back on ${fmtDate(until)}`)}
                      onReopen={() => act(r,
                        () => reopenServiceRequest(r.id),
                        'Request reopened', r.unit)}
                      onUnlink={() => act(r,
                        () => unlinkRequest(r.id),
                        'Request unlinked', 'Back in the open backlog')}
                      onAddTo={(w) => act(r,
                        () => addRequestToWo(r.id, w.id),
                        `Added to WO #${w.display_no || w.id}`, r.title)}
                      onCreateWo={() => createWo([r.id])}
                    />
                  ))}
                </ul>
              </div>

              {/* Barra de selección: aparece con ≥1 request elegido. Borrar
                  vale para todo lo seleccionable; la WO solo para open /
                  snoozed (si no, el botón queda deshabilitado con pista). */}
              {editable && pickedIds.length > 0 && (
                <div className="sr-dispatch" role="region"
                  aria-label="Selected requests">
                  <span className="sr-dispatch-n">
                    <strong>{pickedIds.length}</strong> selected
                  </span>
                  <button type="button" className="link-btn"
                    onClick={() => setPicked(new Set())}>
                    Clear
                  </button>
                  <Button variant="ghost" size="sm"
                    className="sr-dispatch-del" icon={<TrashIcon />}
                    disabled={bulkBusy || creatingWo}
                    style={{ color: 'var(--ui-danger)' }}
                    onClick={() => runDelete(
                      () => deleteServiceRequests(pickedIds),
                      (n) => (n === 1 ? 'Request deleted'
                        : `${n} requests deleted`),
                      sel.unit)}>
                    Delete
                  </Button>
                  <span className="head-spacer" />
                  {!pickedCanWo ? (
                    <span className="sr-dispatch-hint">
                      Only open or snoozed requests can go on a work order
                    </span>
                  ) : (
                    <>
                      {/* v2.21: roster de técnicos (TechnicianPicker). */}
                      <TechnicianPicker className="sr-dispatch-mech"
                        placeholder="Technician (optional)"
                        aria-label="Technician" value={mech}
                        onChange={setMech} />
                      <select className="cell-input sr-dispatch-prio"
                        aria-label="Work order priority" value={woPrio}
                        onChange={(e) =>
                          setWoPrio(e.target.value as WoPriority | '')}>
                        <option value="">Priority: auto</option>
                        <option value="high">High</option>
                        <option value="normal">Normal</option>
                        <option value="low">Low</option>
                      </select>
                    </>
                  )}
                  {/* El title va en el wrapper: un botón deshabilitado no
                      muestra tooltip en todos los navegadores. */}
                  <span className="sr-dispatch-go" title={pickedCanWo
                    ? undefined
                    : 'Only open or snoozed requests can go on a work order'}>
                    <Button variant="primary" size="sm" loading={creatingWo}
                      disabled={!pickedCanWo || bulkBusy}
                      onClick={() => createWo(pickedIds,
                        { mechanic: mech, priority: woPrio })}>
                      Create work order
                    </Button>
                  </span>
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {form && (
        <RequestModal
          req={form.req}
          unitDefault={form.unit ?? ''}
          extraUnits={backlogUnits}
          onClose={() => setForm(null)}
          onSaved={(saved, created) => {
            setForm(null)
            if (created) {
              // Insertarlo ya en la caché de "open": así la selección de su
              // unidad no se pierde mientras llega el refetch.
              qc.setQueryData<SrList>(['service-requests', 'open', '', ''],
                (old) => (old ? {
                  ...old,
                  requests: [saved, ...old.requests.filter(
                    (x) => x.id !== saved.id)],
                } : old))
              setStatus('open')
              setSource('')
              setPrio('')
              setQ('')
              setSelUnit(norm(saved.unit))
              setShowDetail(true)
            }
          }}
        />
      )}

      {denying && (
        <DenyModal req={denying}
          onClose={() => setDenying(null)}
          onDone={() => setDenying(null)} />
      )}

      <WoDrawer woId={openWo}
        onClose={() => { setOpenWo(null); invalidateSr(qc) }} />
    </div>
  )
}

// ----- Tarjeta de request ----------------------------------------------------

function RequestCard({
  r, editable, busy, picked, flash, onPick, onDelete, onShowKeeper,
  unitWos, onOpenWo, onDeny, onEdit, onSnooze, onReopen, onUnlink, onAddTo,
  onCreateWo,
}: {
  r: ServiceRequest
  editable: boolean
  busy: boolean
  picked: boolean
  flash: boolean
  onPick: (on: boolean) => void
  onDelete: () => void
  onShowKeeper: () => void
  unitWos: WorkOrder[]
  onOpenWo: (id: number) => void
  onDeny: () => void
  onEdit: () => void
  onSnooze: (until: string) => void
  onReopen: () => void
  onUnlink: () => void
  onAddTo: (w: WorkOrder) => void
  onCreateWo: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [pickDate, setPickDate] = useState('')
  const m = r.meta ?? {}
  // En defectos el título ES el detalle recortado: si el detalle solo lo
  // continúa, no se repite — "Show more" despliega el texto completo en el
  // lugar del título.
  const title = r.title.trim()
  const full = (r.detail ?? '').trim()
  const continues = full.length > title.length && full.startsWith(title)
  const detail = full && full !== title && !continues ? full : ''
  const longDetail = detail.length > 160 || detail.split('\n').length > 2
  const isOpen = r.status === 'open'

  // Línea de datos: fecha · quién · re-reportes · vencimiento.
  const bits: ReactNode[] = []
  if (r.source === 'defect') {
    bits.push(m.date_label
      ? `Reported ${fmtDateLabel(String(m.date_label))}`
      : fmtDate(r.created_at))
    if (m.dvir_type) bits.push(String(m.dvir_type))
    const reports = metaNum(m.reports) ?? 1
    if (reports > 1) bits.push(<strong key="rep">reported {reports}×</strong>)
  } else if (r.source === 'pm' || r.source === 'dot') {
    const toDue = metaNum(m.to_due)
    if (r.source === 'pm') {
      const nxt = metaNum(m.next_due_miles)
      if (nxt != null) bits.push(`Due ${fmtNum(nxt)} mi`)
      if (toDue != null) {
        bits.push(toDue < 0
          ? <span key="due" className="sr-over">{fmtNum(-toDue)} mi over</span>
          : `in ${fmtNum(toDue)} mi`)
      }
    } else {
      if (m.next_due_date) bits.push(`Due ${fmtDate(String(m.next_due_date))}`)
      if (toDue != null) {
        bits.push(toDue < 0
          ? <span key="due" className="sr-over">
              {plural(-toDue, 'day', 'days')} over
            </span>
          : toDue === 0 ? 'due today' : `in ${plural(toDue, 'day', 'days')}`)
      }
    }
  } else {
    bits.push(`${fmtDate(r.created_at)}${r.created_by ? ` by ${r.created_by}` : ''}`)
  }
  if (r.follow_up_date) {
    const late = isOpen && r.follow_up_date < todayISO()
    bits.push(
      <span key="fu" className={late ? 'sr-over' : ''}>
        Follow up {fmtDate(r.follow_up_date)}
      </span>)
  }

  const woNo = r.wo_display_no || (r.wo_id != null ? String(r.wo_id) : '')
  const woLink = r.wo_id != null && (
    <button type="button" className="sr-wolink"
      onClick={() => onOpenWo(r.wo_id!)}>
      WO #{woNo}
    </button>
  )

  // Estado cuando no está abierto.
  let state: ReactNode = null
  if (r.status === 'on_wo') {
    state = (
      <>
        <Badge tone="accent">On WO</Badge>
        {woLink}
        {r.wo_status && STATUS_META[r.wo_status] && (
          <span className={`wo-status ${STATUS_META[r.wo_status].cls}`}>
            {STATUS_META[r.wo_status].label}
          </span>
        )}
        {!r.source_active && r.source !== 'manual' && (
          <span className="sr-muted">
            {r.source === 'defect' ? 'no longer reported' : 'no longer due'}
          </span>
        )}
      </>
    )
  } else if (r.status === 'snoozed') {
    state = (
      <Badge tone="warn">Snoozed until {fmtDate(r.snooze_until)}</Badge>
    )
  } else if (r.status === 'denied') {
    state = (
      <>
        <Badge tone="danger">Denied</Badge>
        {r.deny_reason && <span className="sr-muted">{r.deny_reason}</span>}
        {r.resolved_at && (
          <span className="sr-muted">· {fmtDate(r.resolved_at)}</span>
        )}
      </>
    )
  } else if (r.status === 'done') {
    state = (
      <>
        <Badge tone="success">Done</Badge>
        {r.resolution === 'wo' ? (
          <span className="sr-muted">via {woLink}</span>
        ) : r.resolution === 'cleared' ? (
          <span className="sr-muted">
            cleared · {r.source === 'defect' ? 'no longer reported' : 'no longer due'}
          </span>
        ) : null}
        {r.resolved_at && (
          <span className="sr-muted">· {fmtDate(r.resolved_at)}</span>
        )}
      </>
    )
  }

  const canReopen = r.status === 'snoozed' || r.status === 'denied'
    || (r.status === 'done' && r.resolution !== 'wo')
  // Todo se puede borrar (y elegir) menos lo que está en una WO.
  const onWo = r.status === 'on_wo'

  return (
    <li id={`sr-req-${r.id}`}
      className={`sr-card p-${r.priority} ${picked && !onWo ? 'is-picked' : ''} ${
        flash ? 'is-flash' : ''}`}>
      <div className="sr-card-top">
        {editable && !onWo && (
          <input type="checkbox" className="sr-check" checked={picked}
            disabled={busy}
            aria-label={`Select "${r.title}"`}
            onChange={(e) => onPick(e.target.checked)} />
        )}
        <span className={`sr-src sr-s-${r.source}`}>
          <SrIcon source={r.source} />
          {SOURCE_META[r.source].label}
        </span>
        {r.duplicate_of != null && (
          <button type="button" className="sr-dup"
            title="Show the request this one duplicates"
            onClick={onShowKeeper}>
            Duplicate of #{r.duplicate_of}
          </button>
        )}
        <span className="sr-card-badges">
          <PriorityBadge p={r.priority} showLow />
          {editable && (
            // title en el wrapper: el botón deshabilitado no lo muestra
            // en todos los navegadores.
            <span className="sr-del-wrap"
              title={onWo ? `Unlink it from WO #${woNo} first` : 'Delete'}>
              <button type="button" className="sr-del"
                aria-label="Delete request"
                disabled={busy || onWo} onClick={onDelete}>
                <TrashIcon />
              </button>
            </span>
          )}
        </span>
      </div>

      <p className="sr-title">{continues && expanded ? full : r.title}</p>
      {continues && (
        <button type="button" className="sr-more"
          onClick={() => setExpanded((x) => !x)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
      {detail && (
        <>
          <p className={`sr-text ${longDetail && !expanded ? 'is-clamped' : ''}`}>
            {detail}
          </p>
          {longDetail && (
            <button type="button" className="sr-more"
              onClick={() => setExpanded((x) => !x)}>
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </>
      )}
      {bits.length > 0 && (
        <p className="sr-meta">
          {bits.map((b, i) => <span key={i}>{b}</span>)}
        </p>
      )}
      {state && <div className="sr-state">{state}</div>}

      {editable && (isOpen || canReopen || r.status === 'on_wo') && (
        <div className="sr-actions">
          {isOpen && (
            <>
              <button type="button" className="sr-act is-deny"
                disabled={busy} onClick={onDeny}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
                Deny
              </button>
              <SrMenu label="Snooze" disabled={busy}>
                {(close) => (
                  <>
                    {[7, 14, 30].map((n) => (
                      <button type="button" key={n} role="menuitem"
                        className="sr-menu-item"
                        onClick={() => { close(); onSnooze(addDaysISO(n)) }}>
                        {n} days
                        <small>{fmtDate(addDaysISO(n))}</small>
                      </button>
                    ))}
                    <div className="sr-menu-sep" />
                    <div className="sr-menu-date">
                      <input className="cell-input" type="date"
                        aria-label="Snooze until" min={addDaysISO(1)}
                        value={pickDate}
                        onChange={(e) => setPickDate(e.target.value)} />
                      <button type="button" className="btn btn-ghost btn-xs"
                        disabled={!pickDate || pickDate <= todayISO()}
                        onClick={() => { close(); onSnooze(pickDate) }}>
                        Snooze
                      </button>
                    </div>
                  </>
                )}
              </SrMenu>
              <SrMenu label="Add to…" disabled={busy || unitWos.length === 0}
                hint={unitWos.length === 0
                  ? 'This unit has no open work orders' : undefined}>
                {(close) => unitWos.map((w) => (
                  <button type="button" key={w.id} role="menuitem"
                    className="sr-menu-item"
                    onClick={() => { close(); onAddTo(w) }}>
                    <span className="sr-menu-wo">
                      <span className="mono">#{w.display_no || w.id}</span>
                      <span className="sr-menu-wo-title">{w.title}</span>
                    </span>
                    <small>{STATUS_META[w.status].label}</small>
                  </button>
                ))}
              </SrMenu>
              <span className="sr-act-spacer" />
              <button type="button" className="sr-act is-icon"
                title="Edit request" aria-label="Edit request"
                disabled={busy} onClick={onEdit}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  aria-hidden="true">
                  <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
                </svg>
              </button>
              <button type="button" className="sr-act is-go"
                disabled={busy} onClick={onCreateWo}
                title="Create a work order from this request only">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                Work order
              </button>
            </>
          )}
          {canReopen && (
            <>
              <button type="button" className="sr-act" disabled={busy}
                onClick={onReopen}>
                Reopen
              </button>
              {r.status === 'snoozed' && (
                <button type="button" className="sr-act is-icon"
                  title="Edit request" aria-label="Edit request"
                  disabled={busy} onClick={onEdit}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round"
                    strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
                  </svg>
                </button>
              )}
            </>
          )}
          {r.status === 'on_wo' && (
            <button type="button" className="sr-act" disabled={busy}
              onClick={onUnlink}
              title="Take it off the work order and back to the open backlog">
              Unlink
            </button>
          )}
        </div>
      )}
    </li>
  )
}

// ----- Modal: alta / edición de request --------------------------------------

function RequestModal({
  req, unitDefault, extraUnits, onClose, onSaved,
}: {
  req?: ServiceRequest
  unitDefault: string
  // Unidades del backlog (también fuera de /api/fleet): elegibles.
  extraUnits: PickerUnit[]
  onClose: () => void
  onSaved: (saved: ServiceRequest, created: boolean) => void
}) {
  const qc = useQueryClient()
  const editing = !!req
  // Misma fuente que el UnitPicker (query ['fleet'] + las del backlog):
  // solo se guarda con una unidad de la lista (o texto libre si la flota
  // no está disponible).
  const units = useUnitMatcher(undefined, extraUnits)
  const [unit, setUnit] = useState(req?.unit ?? unitDefault)
  const [title, setTitle] = useState(req?.title ?? '')
  const [detail, setDetail] = useState(req?.detail ?? '')
  const [priority, setPriority] = useState<SrPriority>(req?.priority ?? 'normal')
  const [followUp, setFollowUp] = useState(req?.follow_up_date ?? '')
  const [saving, setSaving] = useState(false)
  const unitOk = editing || units.isValid(unit)
  const canSave = unitOk && !!title.trim() && !saving

  async function save() {
    if (!canSave) return
    setSaving(true)
    try {
      let saved: ServiceRequest
      if (req) {
        saved = await patchServiceRequest(req.id, {
          title: title.trim(), detail: detail.trim(), priority,
          follow_up_date: followUp || '',
        })
      } else {
        saved = await createServiceRequest({
          unit: units.canonical(unit),
          title: title.trim(),
          detail: detail.trim(),
          priority,
          follow_up_date: followUp || null,
          company: units.find(unit)?.company ?? '',
        })
      }
      invalidateSr(qc)
      notifyOk(editing ? 'Request updated' : 'Request added',
        `${saved.unit} · ${saved.title}`)
      onSaved(saved, !editing)
    } catch (e) {
      notifyErr(editing ? "Couldn't update the request"
        : "Couldn't add the request", e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={editing ? 'Edit request' : 'New service request'}
      onClose={onClose} width={520}>
      <form className="sr-form"
        onSubmit={(e) => { e.preventDefault(); save() }}>
        {editing ? (
          <p className="sr-form-lead">
            <span className={`sr-src sr-s-${req!.source}`}>
              <SrIcon source={req!.source} />
              {SOURCE_META[req!.source].label}
            </span>
            <strong>{req!.unit}</strong>
          </p>
        ) : (
          <label className="ud-field">
            <span>Unit *</span>
            <UnitPicker value={unit} onChange={setUnit}
              extraUnits={extraUnits}
              placeholder="Pick a unit" autoFocus={!unit} />
          </label>
        )}
        <label className="ud-field">
          <span>Title *</span>
          <input className="cell-input" value={title} maxLength={160}
            autoFocus={editing || !!unit}
            placeholder="e.g. Water pump APU, A/C front and back"
            onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="ud-field">
          <span>Detail</span>
          <textarea className="cell-input ud-notes" rows={3} value={detail}
            placeholder="What the driver or shop reported…"
            onChange={(e) => setDetail(e.target.value)} />
        </label>
        <div className="sr-form-row">
          <label className="ud-field">
            <span>Priority</span>
            <select className="cell-input" value={priority}
              onChange={(e) => setPriority(e.target.value as SrPriority)}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="urgent">Urgent</option>
              <option value="emergency">Emergency</option>
            </select>
          </label>
          <label className="ud-field">
            <span>Follow-up date</span>
            <input className="cell-input" type="date" value={followUp}
              onChange={(e) => setFollowUp(e.target.value)} />
          </label>
        </div>
        <div className="sr-form-actions">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" loading={saving}
            disabled={!canSave}>
            {editing ? 'Save' : 'Add request'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

// ----- Modal: denegar (motivo opcional) --------------------------------------

function DenyModal({ req, onClose, onDone }: {
  req: ServiceRequest
  onClose: () => void
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  // Lo que pasa después según la fuente (el sync no reabre un denegado).
  const hint = req.source === 'defect'
    ? 'It stays closed even if drivers keep reporting it. You can reopen it from the Denied tab.'
    : req.source === 'pm' || req.source === 'dot'
      ? 'It won’t come back until the next service is recorded. You can reopen it from the Denied tab.'
      : 'You can reopen it later from the Denied tab.'

  async function deny() {
    setSaving(true)
    try {
      await denyServiceRequest(req.id, reason.trim())
      invalidateSr(qc)
      notifyOk('Request denied', `${req.unit} · ${req.title}`)
      onDone()
    } catch (e) {
      notifyErr("Couldn't deny the request", e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="Deny request" onClose={onClose} width={460}>
      <form className="sr-form"
        onSubmit={(e) => { e.preventDefault(); deny() }}>
        <p className="sr-form-lead">
          <strong>{req.unit}</strong>
          <span className="sr-form-lead-title">{req.title}</span>
        </p>
        <label className="ud-field">
          <span>Reason (optional)</span>
          <input className="cell-input" value={reason} maxLength={200}
            autoFocus placeholder="e.g. Duplicate, already fixed on the road"
            onChange={(e) => setReason(e.target.value)} />
        </label>
        <p className="sr-muted">{hint}</p>
        <div className="sr-form-actions">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" loading={saving}>
            Deny request
          </Button>
        </div>
      </form>
    </Modal>
  )
}
