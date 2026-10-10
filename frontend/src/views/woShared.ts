// Constantes y helpers compartidos de Work Orders (v2.21): los usan la
// página (lista / tabla / board / history), el panel de detalle (WoDetail,
// también montado en el drawer que reusan el perfil de unidad y Service
// Requests) y el modal de creación. Sin JSX: solo datos y lógica.
import { type QueryClient } from '@tanstack/react-query'
import {
  type listWorkOrders, type Part, type SrSource, type WorkOrder,
  type WoPriority, type WoStatus,
} from '../api'
import { notifyOk, notifyErr, notifyWarn } from '../toast'

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
// Estados activos (invoiced vive en History): alimentan el filtro de status
// de List/Grid y las columnas del kanban (Board).
export const ACTIVE_PIPELINE: WoStatus[] = [
  'open', 'assigned', 'in_progress', 'completed',
]
// Forma del cache de la lista (para updates optimistas del kanban).
export type WoListData = Awaited<ReturnType<typeof listWorkOrders>>
export const PRIORITY_META: Record<WoPriority, { label: string; cls: string }> = {
  low: { label: 'Low', cls: 'pr-low' },
  normal: { label: 'Normal', cls: 'pr-normal' },
  high: { label: 'High', cls: 'pr-high' },
}

export const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
export const dateOf = (iso: string | null) => (iso ? iso.slice(0, 10) : '—')

// Búsqueda libre de la página (List/Grid/Board/History): unidad, título,
// mecánico o nº de WO. El nº acepta el id interno o el display ("4", "4.1",
// con o sin "#"); "4" también trae las hijas 4.1, 4.2… del mismo invoice.
export function matchesSearch(w: WorkOrder, s: string): boolean {
  if (!s) return true
  const no = s.replace(/^#/, '')
  const disp = (w.display_no ?? '').toLowerCase()
  return w.unit.toLowerCase().includes(s)
    || w.title.toLowerCase().includes(s)
    || w.mechanic.toLowerCase().includes(s)
    || (w.vendor_name ?? '').toLowerCase().includes(s)
    || String(w.id) === no
    || (!!no && (disp === no || disp.startsWith(`${no}.`)))
}

// ----- Cambio de estado compartido (drawer + kanban) ---------------------
// Mover una WO de estado desde el drawer (setStatus) o arrastrando en el
// Board (moveWo) usa el MISMO patch y los MISMOS efectos laterales.

// ¿El estado destino está en completed o más allá?
export const reachesCompleted = (s: WoStatus) =>
  PIPELINE.indexOf(s) >= PIPELINE.indexOf('completed')

// Patch del cambio de estado. Una WO de PM que llega a completed manda el
// odómetro del cierre para que el PM tracker registre el servicio: el valor
// tipeado en el drawer o, si no hay, el millaje de la propia WO (el Board no
// tiene input). Si la WO ya tiene pm_miles, el backend lo reusa tal cual.
export function statusPatch(
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
export function mergeWoDetail(qc: QueryClient, updated: WorkOrder) {
  qc.setQueryData<WorkOrder>(['workorder', updated.id], (prev) =>
    (prev ? { ...prev, ...updated } : updated))
}

// Vistas que listan WOs fuera del detalle: board/lista, perfil de unidad y
// el backlog de service requests (una WO que cambia de estado los afecta).
export function invalidateWoLists(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ['workorders'] })
  qc.invalidateQueries({ queryKey: ['unit-wos'] })
  qc.invalidateQueries({ queryKey: ['service-requests'] })
}

// Efectos tras un cambio de estado exitoso: PM tracker + toasts (PM y
// Telegram). `quiet` omite el toast genérico de estado (en el Board la
// tarjeta ya se ve moverse).
export function afterStatusChange(qc: QueryClient, updated: WorkOrder, opts: {
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
export const SR_SOURCE_LABEL: Record<SrSource, string> = {
  defect: 'DVIR defect', pm: 'PM due', dot: 'DOT due',
  reefer: 'Reefer PM due', manual: 'Request',
}


// Fecha + hora corta (MM-DD · HH:MM) para la línea de tiempo de actividad.
export const stampOf = (iso: string | null) => {
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
export type FaultDiag = {
  code?: string
  desc?: string
  action?: string
  source?: string
  cells: { k: string; v: string; u?: string }[]
}
export function parseReeferFault(complaint: string): FaultDiag | null {
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
export type WoEvent = { when: string; label: string; sub?: string; tone: string }
export function woTimeline(wo: WorkOrder): WoEvent[] {
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
export function findPart(parts: Part[], pn: string): Part | undefined {
  const k = (pn || '').trim().toLowerCase()
  return k ? parts.find((p) => p.part_number.toLowerCase() === k) : undefined
}

// v2.22: costo por defecto de una parte en una línea de WO = promedio
// ponderado real (lo mantiene cada recepción de PO); sin promedio, el costo
// estándar del catálogo.
export function partUnitCost(p: Pick<Part, 'avg_cost' | 'cost'>): number {
  return p.avg_cost > 0 ? p.avg_cost : (p.cost || 0)
}

// Mejor alternativa EN STOCK para el banner de decisión: misma categoría y
// con mayor solape de palabras significativas en la descripción. Solo sugiere
// si hay solape real — así no ofrece p. ej. un cartucho de secador como
// reemplazo de una cámara de freno solo por compartir categoría.
export function bestAlternative(catalog: Part[], cp: Part): Part | null {
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

// Campañas de mantenimiento (H3b): nombres estilo Fullbay. Una orden
// con campaña actualiza Components & PMs del perfil al facturarse.
export const CAMPAIGN_OPTS: { key: string; label: string }[] = [
  { key: '', label: 'None' },
  { key: 'pm', label: 'Full Wet Service (PM)' },
  { key: 'dot', label: 'Federal Annual DOT Inspection' },
  // v2.22: PM del reefer por horas de motor. Al facturar, las horas de la WO
  // (engine_hours) quedan como último servicio y lectura del horómetro.
  { key: 'reefer', label: 'Reefer PM (engine hours)' },
  { key: 'kingpins', label: 'Check kingpins' },
  { key: 'dpf', label: 'DPF replacement' },
  { key: 'clutch', label: 'Clutch replacement' },
]
