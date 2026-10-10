// Modelo de la vista Charts (v2.22 [G]): configuración por defecto del
// gráfico y KPI tiles. Separado de ReportCharts.tsx para que ese archivo
// exporte solo componentes (fast refresh).
import type {
  ReportCell, ReportChartSpec, ReportDataRow, ReportRunColumn,
} from '../api'
import { fmtMoney, fmtNumber, isNumericCol } from './model'

export type ChartKind = 'bar' | 'line' | 'donut'
export interface ChartView { type: ChartKind; x: string; y: string[] }

export const COUNT_KEY = '__count'

// ---------------------------------------------------------------------------
// Configuración por defecto (spec.chart si sirve; si no, la primera columna
// de texto/fecha como X y la primera de dinero/número como Y).
// ---------------------------------------------------------------------------
export function xCandidates(cols: ReportRunColumn[]) {
  return cols.filter((c) => !isNumericCol(c))
}
export function yCandidates(cols: ReportRunColumn[]) {
  return cols.filter((c) => isNumericCol(c))
}

export function defaultChartView(
  cols: ReportRunColumn[], spec?: ReportChartSpec | null,
  nosum?: Set<string>,
): ChartView | null {
  const xs = xCandidates(cols)
  const ys = yCandidates(cols)
  if (!xs.length) return null
  const keys = new Set(cols.map((c) => c.key))
  let type: ChartKind = 'bar'
  if (spec && (spec.type === 'bar' || spec.type === 'line' || spec.type === 'donut')) {
    type = spec.type
  }
  // X por defecto: la del spec; si no, una fecha/mes para la línea, un
  // estado (enum) o la primera columna de texto.
  const timeCol = xs.find((c) => c.type === 'date' || /month/i.test(c.field))
  const x = spec?.x && keys.has(spec.x) && xs.some((c) => c.key === spec.x)
    ? spec.x
    : type === 'line' && timeCol ? timeCol.key
      : (xs.find((c) => c.enum) ?? xs.find((c) => c.type === 'text') ?? xs[0]).key
  let y = (spec?.y ?? []).filter((k) => ys.some((c) => c.key === k))
  if (!y.length) {
    // Montos por unidad (costo unitario, promedio…) no son una buena Y por
    // defecto: se prefiere un total de dinero, luego cualquier número.
    const summable = ys.filter((c) => c.agg || !nosum?.has(c.field))
    const money = summable.find((c) => c.type === 'money')
    y = [money?.key ?? summable[0]?.key ?? COUNT_KEY]
  }
  // Una sola escala: las series extra solo si son del mismo tipo.
  const t0 = cols.find((c) => c.key === y[0])?.type
  y = y.filter((k, i) => i === 0 || cols.find((c) => c.key === k)?.type === t0).slice(0, 3)
  return { type, x, y }
}

export interface Kpi { key: string; label: string; value: string; sub?: string }

export function computeKpis(
  cols: ReportRunColumn[], rows: ReportDataRow[],
  totals: Record<string, ReportCell | number | null> | null, nosum: Set<string>,
  only?: string[] | null, isAgg = false,
): Kpi[] {
  const out: Kpi[] = []
  if (!only) {
    out.push({ key: '__rows', label: isAgg ? 'Groups' : 'Rows', value: rows.length.toLocaleString('en-US') })
  }
  const nums = cols.filter((c) => isNumericCol(c)
    && (only ? only.includes(c.key) : (c.agg ? c.agg !== 'count_distinct' : !nosum.has(c.field))))
  for (const c of nums) {
    if (out.length >= (only ? 8 : 6)) break
    const t = totals?.[c.key]
    if (typeof t !== 'number') continue
    const sub = c.agg === 'avg' ? 'average' : c.agg === 'min' ? 'lowest'
      : c.agg === 'max' ? 'highest' : undefined
    out.push({ key: c.key, label: c.label, sub,
      value: c.type === 'money' ? fmtMoney(t) : fmtNumber(t) })
  }
  return out
}

