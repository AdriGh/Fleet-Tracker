// Reports v2.22 [G]: utilidades puras del hub de reportes (viewer, builder,
// gráficos y exports). Sin React: formateo tipado de celdas, filtros y orden
// del lado del cliente (el viewer filtra/ordena las filas ya traídas, como
// SquareRigger), totales, CSV/XLSX locales y helpers de la ReportSpec.
import type {
  ReportAgg, ReportCell, ReportChartSpec, ReportColumnSpec, ReportCond,
  ReportCondGroup, ReportDataRow, ReportField, ReportFieldType, ReportFilters,
  ReportOp, ReportPreset, ReportRunColumn, ReportSource, ReportSpec,
} from '../api'
import { isCondGroup } from '../api'

// ---------------------------------------------------------------------------
// Almacenamiento local (solo comodidades por usuario; puede fallar en modo
// privado — nunca rompe la página).
// ---------------------------------------------------------------------------
export function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw == null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function lsSet(key: string, value: unknown) {
  try {
    if (value === undefined || value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch { /* storage bloqueado: se ignora */ }
}

// ---------------------------------------------------------------------------
// Formateo
// ---------------------------------------------------------------------------
const MONEY = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug',
  'Sep', 'Oct', 'Nov', 'Dec']

export function fmtMoney(n: number): string {
  return MONEY.format(n)
}

export function fmtNumber(n: number, digits = 2): string {
  if (Number.isInteger(n)) return n.toLocaleString('en-US')
  return n.toLocaleString('en-US', { maximumFractionDigits: digits })
}

// Compacto para ejes, KPIs y etiquetas de barra: 1,284 / 12.9K / $4.2M.
export function fmtCompact(n: number, money = false): string {
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  const pre = money ? '$' : ''
  if (abs >= 1e9) return `${sign}${pre}${(abs / 1e9).toFixed(1).replace(/\.0$/, '')}B`
  if (abs >= 1e6) return `${sign}${pre}${(abs / 1e6).toFixed(1).replace(/\.0$/, '')}M`
  if (abs >= 1e4) return `${sign}${pre}${(abs / 1e3).toFixed(1).replace(/\.0$/, '')}K`
  if (money) return `${sign}$${abs.toLocaleString('en-US', { maximumFractionDigits: abs < 100 ? 2 : 0 })}`
  return `${sign}${abs.toLocaleString('en-US', { maximumFractionDigits: 1 })}`
}

// 'YYYY-MM-DD' como fecha LOCAL (new Date('2026-10-09') sería UTC y se
// corre un día al oeste de Greenwich).
export function parseDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

export function fmtDate(s: string): string {
  const d = parseDay(s)
  if (!d) return s
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}

export function fmtDateTime(s: string): string {
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  const h = d.getHours()
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ap = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${h12}:${mm} ${ap}`
}

// 'YYYY-MM' -> 'Oct 2026' (campos "month" de los reportes de gasto).
export function fmtMonth(s: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(s)
  if (!m) return s
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`
}

export function enumLabel(col: Pick<ReportRunColumn, 'enum'>, v: ReportCell): string | null {
  if (v == null || !col.enum) return null
  const hit = col.enum.find((o) => o.value === String(v))
  return hit ? hit.label : null
}

/** Texto plano de una celda (tabla, CSV local, tooltips, PDF). */
export function cellText(col: ReportRunColumn, v: ReportCell): string {
  if (v == null || v === '') return ''
  const lbl = enumLabel(col, v)
  if (lbl != null) return lbl
  switch (col.type) {
    case 'money': return typeof v === 'number' ? fmtMoney(v) : String(v)
    case 'number': return typeof v === 'number' ? fmtNumber(v) : String(v)
    case 'date': return typeof v === 'string' ? fmtDate(v) : String(v)
    case 'datetime': return typeof v === 'string' ? fmtDateTime(v) : String(v)
    case 'bool': return v === true || v === 'true' ? 'Yes' : 'No'
    default:
      if (typeof v === 'string' && /^\d{4}-\d{2}$/.test(v)
          && /month/i.test(col.field)) return fmtMonth(v)
      return String(v)
  }
}

// Tono de los chips de estado (un valor = un tono en todo el viewer).
export type ChipTone = 'danger' | 'warn' | 'ok' | 'info' | 'neutral'
const TONES: Record<string, ChipTone> = {
  overdue: 'danger', expired: 'danger', urgent: 'danger', error: 'danger',
  out_of_service: 'danger', critical: 'danger', failed: 'danger',
  rejected: 'danger', denied: 'danger', never: 'danger',
  upcoming: 'warn', soon: 'warn', waiting: 'warn', waiting_parts: 'warn',
  pending: 'warn', snoozed: 'warn', unpaid: 'warn', high: 'warn',
  in_shop: 'warn', draft: 'warn', missing: 'warn', no_meter: 'warn',
  on_track: 'ok', ok: 'ok', valid: 'ok', completed: 'ok', invoiced: 'ok',
  paid: 'ok', received: 'ok', returned: 'ok', done: 'ok', closed: 'ok',
  approved: 'ok', sent: 'ok', active: 'ok', resolved: 'ok',
  open: 'info', in_progress: 'info', assigned: 'info', ordered: 'info',
  on_wo: 'info', submitted: 'info', partial: 'info',
}
export function chipTone(v: ReportCell): ChipTone {
  if (v == null) return 'neutral'
  return TONES[String(v).toLowerCase()] ?? 'neutral'
}

// ---------------------------------------------------------------------------
// Comparación / orden
// ---------------------------------------------------------------------------
export function compareCells(a: ReportCell, b: ReportCell): number {
  const an = a == null || a === ''
  const bn = b == null || b === ''
  if (an && bn) return 0
  if (an) return 1              // vacíos siempre al final
  if (bn) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b ? 0 : a ? -1 : 1
  }
  return String(a).localeCompare(String(b), 'en-US', {
    numeric: true, sensitivity: 'base',
  })
}

export interface ViewSort { key: string; dir: 'asc' | 'desc' }

export function sortRows(rows: ReportDataRow[], sort: ViewSort | null): ReportDataRow[] {
  if (!sort) return rows
  const k = sort.key
  const mul = sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((r1, r2) => {
    const c = compareCells(r1[k] ?? null, r2[k] ?? null)
    // Los vacíos quedan al final en ambos sentidos.
    if ((r1[k] == null || r1[k] === '') !== (r2[k] == null || r2[k] === '')) return c
    return c * mul
  })
}

// ---------------------------------------------------------------------------
// Filtros del viewer (sobre las filas del resultado, del lado del cliente)
// ---------------------------------------------------------------------------
export type ViewOp =
  | 'contains' | 'eq' | 'ne' | 'in' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'between' | 'empty' | 'not_empty' | 'yes' | 'no'

export interface ViewFilter {
  id: string
  key: string                  // columna del resultado
  op: ViewOp
  value?: string | string[]
}

export const VIEW_OP_LABEL: Record<ViewOp, string> = {
  contains: 'contains', eq: 'is', ne: 'is not', in: 'is any of',
  gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'between',
  empty: 'is empty', not_empty: 'is not empty', yes: 'is yes', no: 'is no',
}

export function viewOpsFor(col: ReportRunColumn): ViewOp[] {
  if (col.enum) return ['in', 'ne', 'empty', 'not_empty']
  switch (col.type) {
    case 'number': case 'money':
      return ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'not_empty']
    case 'date': case 'datetime':
      return ['eq', 'gte', 'lte', 'between', 'empty', 'not_empty']
    case 'bool':
      return ['yes', 'no']
    default:
      return ['contains', 'eq', 'ne', 'in', 'empty', 'not_empty']
  }
}

export const DATE_OP_LABEL: Partial<Record<ViewOp, string>> = {
  eq: 'on', gte: 'on or after', lte: 'on or before',
}

function dayOf(v: ReportCell): string {
  return v == null ? '' : String(v).slice(0, 10)
}

function matchOne(col: ReportRunColumn, row: ReportDataRow, f: ViewFilter): boolean {
  const v = row[col.key] ?? null
  const empty = v == null || v === ''
  if (f.op === 'empty') return empty
  if (f.op === 'not_empty') return !empty
  if (f.op === 'yes') return v === true
  if (f.op === 'no') return v !== true
  const vals = Array.isArray(f.value) ? f.value : [f.value ?? '']
  if (col.enum || f.op === 'in') {
    const s = empty ? '' : String(v).toLowerCase()
    const set = vals.map((x) => String(x).toLowerCase())
    if (f.op === 'ne') return !set.includes(s)
    return set.includes(s)
  }
  if (col.type === 'number' || col.type === 'money') {
    if (empty || typeof v !== 'number') return false
    const a = Number(vals[0])
    const b = Number(vals[1])
    switch (f.op) {
      case 'eq': return v === a
      case 'ne': return v !== a
      case 'gt': return v > a
      case 'gte': return v >= a
      case 'lt': return v < a
      case 'lte': return v <= a
      case 'between': return v >= Math.min(a, b) && v <= Math.max(a, b)
      default: return true
    }
  }
  if (col.type === 'date' || col.type === 'datetime') {
    if (empty) return false
    const d = dayOf(v)
    const a = String(vals[0] ?? '')
    const b = String(vals[1] ?? '')
    switch (f.op) {
      case 'eq': return d === a
      case 'gte': return d >= a
      case 'lte': return d <= a
      case 'between': return d >= (a < b ? a : b) && d <= (a < b ? b : a)
      default: return true
    }
  }
  const s = empty ? '' : cellText(col, v).toLowerCase()
  const q = String(vals[0] ?? '').toLowerCase()
  switch (f.op) {
    case 'contains': return s.includes(q)
    case 'eq': return s === q
    case 'ne': return s !== q
    default: return true
  }
}

export function applyViewFilters(
  rows: ReportDataRow[], filters: ViewFilter[], columns: ReportRunColumn[],
): ReportDataRow[] {
  const active = filters
    .map((f) => ({ f, col: columns.find((c) => c.key === f.key) }))
    .filter((x): x is { f: ViewFilter; col: ReportRunColumn } => !!x.col)
  if (!active.length) return rows
  return rows.filter((r) => active.every(({ f, col }) => matchOne(col, r, f)))
}

export function describeViewFilter(f: ViewFilter, col?: ReportRunColumn): string {
  if (!col) return ''
  const isDate = col.type === 'date' || col.type === 'datetime'
  const op = (isDate && DATE_OP_LABEL[f.op]) || VIEW_OP_LABEL[f.op]
  if (f.op === 'empty' || f.op === 'not_empty' || f.op === 'yes' || f.op === 'no') {
    return `${col.label} ${op}`
  }
  const vals = Array.isArray(f.value) ? f.value : [f.value ?? '']
  const show = (x: string) => {
    if (col.enum) return enumLabel(col, x) ?? x
    if (isDate) return fmtDate(x)
    if (col.type === 'money' && x !== '') return fmtMoney(Number(x))
    return x
  }
  if (f.op === 'between') return `${col.label} between ${show(vals[0] ?? '')} and ${show(vals[1] ?? '')}`
  if (vals.length > 2) return `${col.label} ${op} ${show(vals[0])}, ${show(vals[1])} +${vals.length - 2}`
  return `${col.label} ${op} ${vals.map(show).join(', ')}`
}

// ---------------------------------------------------------------------------
// Totales (Σ): los del server si no hay filtros locales; si no, recalculados
// sobre las filas visibles con la misma regla del motor.
// ---------------------------------------------------------------------------
export function isNumericCol(c: Pick<ReportRunColumn, 'type'>): boolean {
  return c.type === 'money' || c.type === 'number'
}

// Montos POR UNIDAD (costo/precio unitario, costo promedio o último, tasas,
// porcentajes, markups): sumarlos no significa nada aunque el registro no
// los marque `nosum` (p. ej. wo_lines.unit_cost). Se tratan igual que nosum
// en el total Σ, los KPI tiles y el eje Y por defecto del gráfico.
const PER_UNIT_RE = /(^|_)(unit_cost|unit_price|landed_unit_cost|avg_cost|last_cost|rate|pct|markup)$|^avg_/

export function nosumFields(src?: Pick<ReportSource, 'fields'> | null): Set<string> {
  return new Set((src?.fields ?? [])
    .filter((f) => f.nosum || (isNumericCol(f) && PER_UNIT_RE.test(f.name)))
    .map((f) => f.name))
}

/** Saca de los totales (del server o locales) las columnas sin agregación
 * que no se suman. */
export function stripNosum<T>(
  totals: Record<string, T> | null | undefined, columns: ReportRunColumn[],
  nosum: Set<string>,
): Record<string, T> | null {
  if (!totals) return null
  const out = { ...totals }
  for (const c of columns) {
    if (!c.agg && nosum.has(c.field)) delete out[c.key]
  }
  return out
}

export function computeTotals(
  rows: ReportDataRow[], columns: ReportRunColumn[], nosum: Set<string>,
): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  for (const c of columns) {
    if (!isNumericCol(c)) continue
    if (!c.agg && nosum.has(c.field)) continue
    if (c.agg === 'count_distinct') continue
    const vals = rows.map((r) => r[c.key]).filter((v): v is number => typeof v === 'number')
    if (!vals.length) { out[c.key] = c.agg === 'count' || !c.agg || c.agg === 'sum' ? 0 : null; continue }
    if (c.agg === 'avg') out[c.key] = vals.reduce((s, v) => s + v, 0) / vals.length
    else if (c.agg === 'min') out[c.key] = Math.min(...vals)
    else if (c.agg === 'max') out[c.key] = Math.max(...vals)
    else out[c.key] = vals.reduce((s, v) => s + v, 0)
  }
  return out
}

// ---------------------------------------------------------------------------
// Export local (lo que se VE: filtros, columnas y orden del viewer)
// ---------------------------------------------------------------------------
function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function rawForExport(col: ReportRunColumn, v: ReportCell): string | number {
  if (v == null) return ''
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return enumLabel(col, v) ?? v
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function fileSlug(name: string): string {
  return (name || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60) || 'report'
}

export function exportCsvLocal(
  name: string, columns: ReportRunColumn[], rows: ReportDataRow[],
  totals?: Record<string, ReportCell> | null,
) {
  const lines = [columns.map((c) => csvCell(c.label)).join(',')]
  for (const r of rows) {
    lines.push(columns.map((c) => csvCell(rawForExport(c, r[c.key] ?? null))).join(','))
  }
  if (totals) {
    lines.push(columns.map((c, i) => {
      const t = totals[c.key]
      if (typeof t === 'number') return csvCell(Math.round(t * 100) / 100)
      return i === 0 ? 'Total' : ''
    }).join(','))
  }
  // BOM para que Excel respete UTF-8.
  downloadBlob(new Blob(['﻿' + lines.join('\r\n')],
    { type: 'text/csv;charset=utf-8' }), `${fileSlug(name)}.csv`)
}

export async function exportXlsxLocal(
  name: string, subtitle: string, columns: ReportRunColumn[],
  rows: ReportDataRow[], totals?: Record<string, ReportCell> | null,
) {
  // exceljs ya es dependencia (PM compliance); se carga solo al exportar.
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Rigsmith'
  const ws = wb.addWorksheet((name || 'Report').slice(0, 31).replace(/[\\/?*[\]:]/g, ' '))
  ws.addRow([name])
  ws.getRow(1).font = { bold: true, size: 14 }
  if (subtitle) ws.addRow([subtitle]).font = { color: { argb: 'FF6B6B76' } }
  ws.addRow([])
  const head = ws.addRow(columns.map((c) => c.label))
  head.font = { bold: true }
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F1F3' } }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFDCDCE0' } } }
  })
  const firstData = head.number + 1
  for (const r of rows) {
    ws.addRow(columns.map((c) => {
      const v = r[c.key] ?? null
      if (v == null) return null
      if ((c.type === 'date') && typeof v === 'string') return parseDay(v) ?? v
      if (c.type === 'datetime' && typeof v === 'string') {
        const d = new Date(v)
        return Number.isNaN(d.getTime()) ? v : d
      }
      return rawForExport(c, v)
    }))
  }
  if (totals) {
    const tr = ws.addRow(columns.map((c, i) => {
      const t = totals[c.key]
      return typeof t === 'number' ? t : i === 0 ? 'Total' : null
    }))
    tr.font = { bold: true }
  }
  columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1)
    if (c.type === 'money') col.numFmt = '"$"#,##0.00'
    else if (c.type === 'date') col.numFmt = 'mmm d, yyyy'
    else if (c.type === 'datetime') col.numFmt = 'mmm d, yyyy h:mm AM/PM'
    else if (c.type === 'number') col.numFmt = '#,##0.##'
    const longest = Math.max(c.label.length,
      ...rows.slice(0, 200).map((r) => cellText(c, r[c.key] ?? null).length))
    col.width = Math.min(48, Math.max(10, longest + 2))
  })
  ws.views = [{ state: 'frozen', ySplit: firstData - 1 }]
  const buf = await wb.xlsx.writeBuffer()
  downloadBlob(new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }), `${fileSlug(name)}.xlsx`)
}

// ---------------------------------------------------------------------------
// ReportSpec (builder)
// ---------------------------------------------------------------------------
export function outKey(c: ReportColumnSpec): string {
  return c.agg ? `${c.agg}_${c.field}` : c.field
}

export const AGG_LABEL: Record<ReportAgg, string> = {
  count: 'Count', count_distinct: 'Unique', sum: 'Total', avg: 'Average',
  min: 'Min', max: 'Max',
}

export function aggsFor(type: ReportFieldType): ReportAgg[] {
  if (type === 'money' || type === 'number') {
    return ['sum', 'avg', 'min', 'max', 'count', 'count_distinct']
  }
  if (type === 'date' || type === 'datetime') {
    return ['min', 'max', 'count', 'count_distinct']
  }
  if (type === 'bool') return ['count', 'count_distinct']
  return ['count', 'count_distinct', 'min', 'max']
}

export function opsFor(f: ReportField): ReportOp[] {
  if (f.enum) return ['in', 'not_in', 'eq', 'ne', 'empty', 'not_empty']
  switch (f.type) {
    case 'number': case 'money':
      return ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'not_empty']
    case 'date': case 'datetime':
      return ['eq', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'not_empty']
    case 'bool':
      return ['eq']
    default:
      return ['contains', 'eq', 'ne', 'in', 'not_in', 'empty', 'not_empty']
  }
}

export const OP_LABEL: Record<ReportOp, string> = {
  eq: 'is', ne: 'is not', in: 'is any of', not_in: 'is none of',
  gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'between',
  contains: 'contains', empty: 'is empty', not_empty: 'is not empty',
}
export const DATE_OP: Partial<Record<ReportOp, string>> = {
  eq: 'on', gt: 'after', gte: 'on or after', lt: 'before',
  lte: 'on or before',
}

export const PRESET_LABEL: Record<ReportPreset, string> = {
  today: 'Today', yesterday: 'Yesterday', this_week: 'This week',
  prev_week: 'Previous week', mtd: 'Month to date',
  prev_month: 'Previous month', last_30d: 'Last 30 days',
  last_90d: 'Last 90 days', qtd: 'Quarter to date', ytd: 'Year to date',
  last_12m: 'Last 12 months', all: 'All time', custom: 'Custom range',
}

export function fieldMap(src?: ReportSource | null): Map<string, ReportField> {
  return new Map((src?.fields ?? []).map((f) => [f.name, f]))
}

// Fuentes "foto" (catálogos y estado actual: partes, unidades, customers,
// vencimientos…): el reporte natural es la lista completa, no "los creados
// en los últimos 90 días". Arrancan sin filtro de fecha y sin el aviso de
// "reporte lento" (son listas acotadas por naturaleza).
const SNAPSHOT_SOURCES = new Set([
  'parts', 'vendors', 'units', 'customers', 'technicians', 'drivers',
  'driver_docs', 'pm_due', 'maint_board', 'pm_compliance',
])

export function isSnapshotSource(src?: Pick<ReportSource, 'key'> | null): boolean {
  return !!src && SNAPSHOT_SOURCES.has(src.key)
}

export function blankSpec(src: ReportSource): ReportSpec {
  const tf = src.default_time_field
  const preset: ReportPreset = src.time_is_period ? 'mtd'
    : isSnapshotSource(src) ? 'all' : 'last_90d'
  return {
    source: src.key,
    columns: [],
    filters: { match: 'all', items: [] },
    time: tf ? { field: tf, preset } : null,
    sort: [],
    totals: true,
    chart: null,
  }
}

export function isAggSpec(spec: ReportSpec): boolean {
  return spec.columns.some((c) => !!c.agg)
}

// group_by derivado: en modo resumen se agrupa por TODAS las columnas sin
// agregación (como "Group & summarize" de SR), en su orden.
export function normalizeSpec(spec: ReportSpec): ReportSpec {
  const agg = isAggSpec(spec)
  const plain = spec.columns.filter((c) => !c.agg).map((c) => c.field)
  const keys = new Set(spec.columns.map(outKey))
  const out: ReportSpec = {
    ...spec,
    group_by: agg ? Array.from(new Set(plain)) : [],
    filters: spec.filters ?? { match: 'all', items: [] },
  }
  // En modo resumen el orden y el gráfico solo pueden usar columnas de salida.
  if (agg) {
    out.sort = (spec.sort ?? []).filter((s) => keys.has(s.field))
  }
  if (spec.chart && spec.chart.type !== 'none') {
    const x = spec.chart.x && keys.has(spec.chart.x) ? spec.chart.x : null
    const y = (spec.chart.y ?? []).filter((k) => keys.has(k))
    out.chart = { type: spec.chart.type, ...(x ? { x } : {}), y }
  }
  return out
}

function condReady(c: ReportCond): boolean {
  if (c.op === 'empty' || c.op === 'not_empty') return true
  const v = c.value
  if (c.op === 'between') {
    return Array.isArray(v) && v.length === 2 && v.every((x) => x !== '' && x != null)
  }
  if (c.op === 'in' || c.op === 'not_in') return Array.isArray(v) && v.length > 0
  return v !== undefined && v !== null && v !== ''
}

// Saca las condiciones a medio cargar (sin valor) antes de correr la spec:
// la vista previa no debe fallar mientras el usuario está escribiendo.
export function runnableSpec(spec: ReportSpec): ReportSpec {
  const items = (spec.filters?.items ?? []).map((it) => {
    if (isCondGroup(it)) {
      const g: ReportCondGroup = { match: it.match, items: it.items.filter(condReady) }
      return g.items.length ? g : null
    }
    return condReady(it) ? it : null
  }).filter((x): x is ReportCond | ReportCondGroup => x != null)
  const time = spec.time && spec.time.preset === 'custom'
    && !(spec.time.from || spec.time.to) ? { ...spec.time, preset: 'all' as const } : spec.time
  const n = normalizeSpec({ ...spec, filters: { match: spec.filters?.match ?? 'all', items }, time })
  const clean: ReportSpec = { source: n.source, columns: n.columns.map((c) => ({
    field: c.field, ...(c.agg ? { agg: c.agg } : {}), ...(c.label ? { label: c.label } : {}),
  })) }
  if (n.filters && n.filters.items.length) clean.filters = n.filters
  if (n.time) {
    clean.time = { field: n.time.field, preset: n.time.preset }
    if (n.time.preset === 'custom') {
      if (n.time.from) clean.time.from = n.time.from
      if (n.time.to) clean.time.to = n.time.to
    }
  }
  if (n.group_by && n.group_by.length) clean.group_by = n.group_by
  if (n.sort && n.sort.length) clean.sort = n.sort
  if (n.limit) clean.limit = n.limit
  if (n.totals) clean.totals = true
  if (n.chart && n.chart.type !== 'none') clean.chart = n.chart
  return clean
}

/** Por qué la spec todavía no se puede correr (null = lista). */
export function specProblem(spec: ReportSpec, src?: ReportSource | null): string | null {
  if (!src) return 'Pick a data source.'
  if (!spec.columns.length) return 'Add a column or metric to see a preview.'
  const fm = fieldMap(src)
  for (const c of spec.columns) {
    const f = fm.get(c.field)
    if (!f) return `Unknown field "${c.field}" for ${src.label}.`
    if ((c.agg === 'sum' || c.agg === 'avg') && !isNumericCol(f)) {
      return `"${AGG_LABEL[c.agg]}" needs a number field (${f.label}).`
    }
  }
  const keys = spec.columns.map(outKey)
  const dup = keys.find((k, i) => keys.indexOf(k) !== i)
  if (dup) return 'The same column appears twice — change its summary or remove one.'
  // Detalle: el orden va por campos de la fuente (en resumen normalizeSpec
  // ya lo acota a las columnas de salida).
  if (!isAggSpec(spec)) {
    const bad = (spec.sort ?? []).find((s) => !fm.has(s.field))
    if (bad) return `Can’t sort by “${bad.field}” without Group & summarize — pick another sort.`
  }
  return null
}

// Al pasar de resumen a detalle, un orden por una métrica ("sum_amount")
// vuelve a su campo ("amount"); el resto queda igual. `prev` = la spec antes
// del cambio (de ahí salen las métricas que existían).
export function sortAfterUnsummarize(prev: ReportSpec, next: ReportSpec): ReportSpec['sort'] {
  if (isAggSpec(next)) return next.sort
  const was = new Map(prev.columns.filter((c) => c.agg).map((c) => [outKey(c), c.field]))
  return (next.sort ?? []).map((s) => ({ ...s, field: was.get(s.field) ?? s.field }))
}

// group_by explícito con campos que NO son columnas (respuesta del asistente
// o una spec vieja): el motor lo acepta, pero el builder deriva el agrupado
// de las columnas — se agregan como columnas visibles (antes de la primera
// métrica) para que el preview agrupe igual que lo que validó el server.
export function withGroupColumns(spec: ReportSpec): ReportSpec {
  const cols = spec.columns ?? []
  if (!cols.some((c) => c.agg)) return spec
  const plain = new Set(cols.filter((c) => !c.agg).map((c) => c.field))
  const extra = (spec.group_by ?? []).filter((f) => !plain.has(f))
    .filter((f, i, a) => a.indexOf(f) === i).map((f) => ({ field: f }))
  if (!extra.length) return spec
  const at = cols.findIndex((c) => !!c.agg)
  return { ...spec, columns: [...cols.slice(0, at), ...extra, ...cols.slice(at)] }
}

// Gráfico acotado a las columnas de salida (x / y que ya no existen se
// sacan; sin y utilizable, sin gráfico). Mismo criterio que normalizeSpec.
export function pruneChart(spec: ReportSpec): ReportSpec {
  const c = spec.chart
  if (!c || c.type === 'none') return spec
  const keys = new Set(spec.columns.map(outKey))
  const x = c.x && keys.has(c.x) ? c.x : null
  const y = (c.y ?? []).filter((k) => keys.has(k))
  const needsX = c.type !== 'kpi'
  if (!y.length || (needsX && !x)) return { ...spec, chart: null }
  return { ...spec, chart: { type: c.type, ...(x ? { x } : {}), y } }
}

export function chartOrNull(c?: ReportChartSpec | null): ReportChartSpec | null {
  return c && c.type !== 'none' ? c : null
}

// Igualdad estructural barata (specs chicas).
export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// ---------------------------------------------------------------------------
// "Save as mine" captura lo que se VE: columnas visibles/orden, orden y los
// filtros del viewer se traducen a la spec cuando se puede (columnas sin
// agregación = campos de la fuente). Lo que no se puede traducir se avisa.
// ---------------------------------------------------------------------------
// Texto mostrado -> valor guardado de una columna de texto cuyo formato
// difiere del crudo (p.ej. 'Oct 2026' <- '2026-10'): el filtro del viewer
// compara lo que se VE y el motor el valor guardado. null = se muestran igual.
function shownToRaw(col: ReportRunColumn, rows: ReportDataRow[]): Map<string, string> | null {
  const m = new Map<string, string>()
  let differs = false
  for (const r of rows) {
    const v = r[col.key]
    if (v == null || v === '') continue
    const shown = cellText(col, v)
    if (shown !== String(v)) differs = true
    m.set(shown.toLowerCase(), String(v))
  }
  return differs ? m : null
}

// Filtro del viewer -> condiciones del motor con la MISMA semántica que
// matchOne (null = no se puede traducir: queda solo en la vista).
function viewFilterToConds(
  f: ViewFilter, col: ReportRunColumn, rows: ReportDataRow[],
): ReportCond[] | null {
  if (col.agg) return null
  const vals = Array.isArray(f.value) ? f.value : [f.value ?? '']
  const num = col.type === 'money' || col.type === 'number'
  const text = !num && !col.enum && col.type !== 'date' && col.type !== 'datetime'
    && col.type !== 'bool'
  const raw = text ? shownToRaw(col, rows) : null
  const toRaw = (x: string) => raw?.get(String(x).toLowerCase()) ?? x
  const cast = (x: string) => (num ? Number(x) : text ? toRaw(x) : x)
  const one = (c: ReportCond): ReportCond[] => [c]
  switch (f.op) {
    case 'empty': case 'not_empty': return one({ field: col.field, op: f.op })
    case 'yes': return one({ field: col.field, op: 'eq', value: true })
    case 'no': return one({ field: col.field, op: 'eq', value: false })
    case 'between': return one({ field: col.field, op: 'between', value: [cast(vals[0]), cast(vals[1])] })
    case 'in': return one({ field: col.field, op: 'in', value: vals.map(cast) })
    case 'ne':
      if (col.enum) return one({ field: col.field, op: 'not_in', value: vals })
      // El viewer deja afuera las celdas vacías en "is not" numérico; el
      // motor las conserva: se agrega "not empty" para que coincidan.
      return num
        ? [{ field: col.field, op: 'ne', value: cast(vals[0]) },
          { field: col.field, op: 'not_empty' }]
        : one({ field: col.field, op: 'ne', value: cast(vals[0]) })
    case 'contains':
      // "contiene" sobre el texto MOSTRADO no se traduce al valor guardado.
      return raw ? null : one({ field: col.field, op: 'contains', value: vals[0] })
    default: return one({ field: col.field, op: f.op, value: cast(vals[0]) })
  }
}

// Filtros del viewer: los que el motor puede aplicar (conds) y los que
// quedan solo en la vista (rest: métricas, "contiene" sobre texto formateado).
export function splitViewFilters(
  filters: ViewFilter[], allColumns: ReportRunColumn[], rows: ReportDataRow[],
): { conds: ReportCond[]; rest: ViewFilter[] } {
  const conds: ReportCond[] = []
  const rest: ViewFilter[] = []
  for (const f of filters) {
    const col = allColumns.find((c) => c.key === f.key)
    const c = col ? viewFilterToConds(f, col, rows) : null
    if (c) conds.push(...c)
    else rest.push(f)
  }
  return { conds, rest }
}

// Suma condiciones (AND) a los filtros de una spec. null = no se puede sin
// anidar más de un nivel (spec "any" que ya tiene grupos).
export function mergeConds(
  base: ReportFilters | undefined, conds: ReportCond[],
): ReportFilters | null {
  const b = base ?? { match: 'all', items: [] }
  if (!conds.length) return b
  if (b.match === 'all' || b.items.length === 0) {
    return { match: 'all', items: [...b.items, ...conds] }
  }
  if (b.items.every((it) => !isCondGroup(it))) {
    return { match: 'all', items: [{ match: 'any', items: b.items as ReportCond[] }, ...conds] }
  }
  return null
}

export function viewToSpec(
  spec: ReportSpec, opts: {
    columns: ReportRunColumn[]        // visibles, en orden
    allColumns: ReportRunColumn[]
    filters: ViewFilter[]
    sort: ViewSort | null
    rows?: ReportDataRow[]            // para traducir texto mostrado -> crudo
  },
): { spec: ReportSpec; skipped: number } {
  let out: ReportSpec = JSON.parse(JSON.stringify(spec))
  let skipped = 0
  const agg = isAggSpec(spec)
  // Columnas: en modo resumen sacar una columna de texto cambia el agrupado,
  // así que solo se reordena/oculta en reportes de detalle.
  if (!agg && opts.columns.length && opts.columns.length <= opts.allColumns.length) {
    const byKey = new Map(spec.columns.map((c) => [outKey(c), c]))
    const cols = opts.columns.map((c) => byKey.get(c.key)).filter((c): c is ReportColumnSpec => !!c)
    if (cols.length) out.columns = cols
    // El gráfico solo puede usar columnas que siguen en el reporte (el motor
    // rechaza un x / y oculto: "chart field … must be one of the columns").
    out = pruneChart(out)
  }
  if (opts.sort) {
    out.sort = [{ field: opts.sort.key, dir: opts.sort.dir }]
  }
  const { conds, rest } = splitViewFilters(opts.filters, opts.allColumns, opts.rows ?? [])
  skipped += rest.length
  if (conds.length) {
    const merged = mergeConds(out.filters, conds)
    if (merged) out.filters = merged
    else skipped += opts.filters.length - rest.length
  }
  return { spec: out, skipped }
}

export const TYPE_NAME: Record<ReportFieldType, string> = {
  text: 'Text', number: 'Number', money: 'Money', date: 'Date',
  datetime: 'Date & time', bool: 'Yes / no',
}

// ---------------------------------------------------------------------------
// Entradas de la biblioteca y arranque del builder
// ---------------------------------------------------------------------------
export type LibEntry =
  | { kind: 'system'; ref: string; sys: import('../api').SystemReport }
  | { kind: 'saved'; ref: string; saved: import('../api').SavedReport }

export interface BuilderInit {
  spec: ReportSpec | null
  name?: string
  description?: string
  visibility?: 'mine' | 'org'
  // Guardado propio que se edita (Save = PATCH); null = uno nuevo.
  savedId?: number | null
  basedOn?: string
  // Respuesta del asistente que originó la spec.
  explanation?: string
  warnings?: string[]
  prompt?: string
}

export interface ColPrefs { hidden: string[]; order: string[] }

export function applyColPrefs<T extends { key: string }>(cols: T[], prefs: ColPrefs): T[] {
  const keys = cols.map((c) => c.key)
  const order = prefs.order.filter((k) => keys.includes(k))
  const all = [...order, ...keys.filter((k) => !order.includes(k))]
  return all.map((k) => cols.find((c) => c.key === k)!)
    .filter((c) => !prefs.hidden.includes(c.key))
}
