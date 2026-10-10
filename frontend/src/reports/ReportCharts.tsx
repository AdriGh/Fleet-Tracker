// Vista "Charts" de un reporte (v2.22 [G]): KPI tiles + un gráfico (barras
// horizontales / línea / donut) hecho a mano en SVG, como el resto de los
// charts de la app (sin librerías). Reglas de dataviz: marcas finas (barras
// ≤ 24 px con punta redondeada de 4 px y base recta, líneas de 2 px), grilla
// de un pelo, una sola escala, paleta categórica validada en orden fijo
// (--viz-1…8 en reports.css, claro y oscuro), leyenda con ≥ 2 series,
// tooltip por marca (hover y foco de teclado) y crosshair en la línea. La
// tabla (vista Data) es siempre el respaldo accesible de cada valor.
import {
  useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent,
  type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject,
} from 'react'
import type {
  ReportCell, ReportChartSpec, ReportDataRow, ReportRunColumn,
} from '../api'
import {
  cellText, compareCells, fmtCompact, fmtMoney, fmtNumber,
} from './model'
import {
  COUNT_KEY, computeKpis, defaultChartView, xCandidates, yCandidates,
  type ChartKind, type ChartView, type Kpi,
} from './chartModel'

const MAX_BARS = 12
const MAX_SLICES = 7

// ---------------------------------------------------------------------------
// Agregación por X (suma; promedio/min/max para columnas con esa agregación)
// ---------------------------------------------------------------------------
interface Cat { key: string; label: string; raw: ReportCell; vals: number[] }
interface Series { key: string; label: string; money: boolean }

function seriesOf(cols: ReportRunColumn[], y: string[]): Series[] {
  return y.map((k) => {
    if (k === COUNT_KEY) return { key: k, label: 'Rows', money: false }
    const c = cols.find((cc) => cc.key === k)
    return { key: k, label: c?.label ?? k, money: c?.type === 'money' }
  })
}

function aggregate(
  rows: ReportDataRow[], cols: ReportRunColumn[], view: ChartView,
): Cat[] {
  const xc = cols.find((c) => c.key === view.x)
  if (!xc) return []
  const ycols = view.y.map((k) => cols.find((c) => c.key === k))
  const map = new Map<string, { raw: ReportCell; sums: number[]; n: number[]; min: number[]; max: number[] }>()
  for (const r of rows) {
    const raw = r[xc.key] ?? null
    const k = raw == null || raw === '' ? '' : String(raw)
    let e = map.get(k)
    if (!e) {
      e = { raw, sums: view.y.map(() => 0), n: view.y.map(() => 0),
        min: view.y.map(() => Infinity), max: view.y.map(() => -Infinity) }
      map.set(k, e)
    }
    view.y.forEach((yk, i) => {
      if (yk === COUNT_KEY) { e!.sums[i] += 1; e!.n[i] += 1; return }
      const v = r[yk]
      if (typeof v !== 'number') return
      e!.sums[i] += v
      e!.n[i] += 1
      e!.min[i] = Math.min(e!.min[i], v)
      e!.max[i] = Math.max(e!.max[i], v)
    })
  }
  return Array.from(map.entries()).map(([k, e]) => ({
    key: k,
    raw: e.raw,
    label: k === '' ? '(blank)' : cellText(xc, e.raw),
    vals: view.y.map((_, i) => {
      const agg = ycols[i]?.agg
      if (agg === 'avg') return e.n[i] ? e.sums[i] / e.n[i] : 0
      if (agg === 'min') return Number.isFinite(e.min[i]) ? e.min[i] : 0
      if (agg === 'max') return Number.isFinite(e.max[i]) ? e.max[i] : 0
      return e.sums[i]
    }),
  }))
}

// ---------------------------------------------------------------------------
// Utilidades de dibujo
// ---------------------------------------------------------------------------
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null)
  const [w, setW] = useState(640)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(Math.max(240, el.clientWidth)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (lo === hi) { hi = lo === 0 ? 1 : lo * 1.2; if (lo > 0) lo = 0 }
  const span = hi - lo
  const raw = span / Math.max(1, count)
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag
  const start = Math.floor(lo / step) * step
  const end = Math.ceil(hi / step) * step
  const out: number[] = []
  for (let v = start; v <= end + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6)
  return out
}

function trunc(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s
}

function fmtVal(v: number, money: boolean): string {
  return money ? fmtMoney(v) : fmtNumber(v)
}

const vizColor = (i: number) => `var(--viz-${(i % 8) + 1})`

// Barra con punta redondeada (4 px) y base recta sobre la línea base.
function barPath(x0: number, x1: number, y: number, h: number): string {
  const len = Math.abs(x1 - x0)
  const r = Math.min(4, h / 2, len)
  if (len < 0.5) return ''
  if (x1 >= x0) {
    return `M${x0},${y}H${x1 - r}A${r},${r} 0 0 1 ${x1},${y + r}`
      + `V${y + h - r}A${r},${r} 0 0 1 ${x1 - r},${y + h}H${x0}Z`
  }
  return `M${x0},${y}H${x1 + r}A${r},${r} 0 0 0 ${x1},${y + r}`
    + `V${y + h - r}A${r},${r} 0 0 0 ${x1 + r},${y + h}H${x0}Z`
}

interface Tip { x: number; y: number; title: string; rows: { color: string; label: string; value: string; line?: boolean }[] }

function TipBox({ tip }: { tip: Tip | null }) {
  if (!tip) return null
  return (
    <div className="rpc-tip" style={{ left: tip.x, top: tip.y }} role="status">
      <div className="rpc-tip-title">{tip.title}</div>
      {tip.rows.map((r) => (
        <div className="rpc-tip-row" key={r.label}>
          <i className={r.line ? 'is-line' : ''} style={{ background: r.color }} />
          <strong>{r.value}</strong>
          <span>{r.label}</span>
        </div>
      ))}
    </div>
  )
}

function Legend({ series, line }: { series: Series[]; line?: boolean }) {
  if (series.length < 2) return null
  return (
    <ul className="rpc-legend" aria-label="Legend">
      {series.map((s, i) => (
        <li key={s.key}>
          <i className={line ? 'is-line' : ''} style={{ background: vizColor(i) }} />
          {s.label}
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Barras horizontales (categorías largas: unidades, partes, vendors)
// ---------------------------------------------------------------------------
function BarChart({ cats, series, width }: { cats: Cat[]; series: Series[]; width: number }) {
  const [tip, setTip] = useState<Tip | null>(null)
  const [hot, setHot] = useState<number | null>(null)
  const s = series.length
  const thick = s === 1 ? 18 : Math.max(8, Math.min(12, Math.floor(26 / s)))
  const band = s === 1 ? 32 : s * (thick + 2) + 14
  const labelW = Math.round(Math.min(200, Math.max(84, width * 0.28)))
  const single = s === 1
  const valueW = single ? (width < 420 ? 60 : 84) : 12
  const plotW = Math.max(60, width - labelW - valueW - 12)
  const top = 22
  const h = top + cats.length * band + 6
  const all = cats.flatMap((c) => c.vals)
  const lo = Math.min(0, ...all)
  const hi = Math.max(0, ...all)
  const ticks = niceTicks(lo, hi, plotW > 360 ? 4 : 2)
  const t0 = ticks[0]
  const t1 = ticks[ticks.length - 1]
  const sx = (v: number) => labelW + ((v - t0) / (t1 - t0 || 1)) * plotW
  const base = sx(0)
  const maxChars = Math.max(6, Math.floor((labelW - 12) / 6.6))
  const money = series[0]?.money ?? false

  function show(i: number, e?: ReactPointerEvent) {
    const c = cats[i]
    const box = (e?.currentTarget as SVGElement | undefined)?.ownerSVGElement
      ?.getBoundingClientRect()
    const x = e && box ? e.clientX - box.left : sx(c.vals[0])
    const y = e && box ? e.clientY - box.top : top + i * band
    setHot(i)
    setTip({ x, y, title: c.label, rows: series.map((se, j) => ({
      color: vizColor(single ? 0 : j), label: se.label, value: fmtVal(c.vals[j], se.money),
    })) })
  }

  return (
    <div className="rpc-plot">
      <svg width={width} height={h} role="img"
        aria-label={`Bar chart: ${series.map((x) => x.label).join(', ')} by category`}
        onPointerLeave={() => { setTip(null); setHot(null) }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={sx(t)} x2={sx(t)} y1={top - 4} y2={h - 4} className="rpc-grid" />
            <text x={sx(t)} y={12} className="rpc-tick" textAnchor="middle">
              {fmtCompact(t, money)}
            </text>
          </g>
        ))}
        <line x1={base} x2={base} y1={top - 4} y2={h - 4} className="rpc-axis" />
        {cats.map((c, i) => {
          const y0 = top + i * band
          const inner = s * thick + (s - 1) * 2
          return (
            <g key={c.key} className={hot != null && hot !== i ? 'is-dim' : undefined}>
              <text x={labelW - 8} y={y0 + band / 2} className="rpc-cat"
                textAnchor="end" dominantBaseline="middle">
                {trunc(c.label, maxChars)}
              </text>
              {c.vals.map((v, j) => {
                const by = y0 + (band - inner) / 2 + j * (thick + 2)
                return (
                  <path key={j} d={barPath(base, sx(v), by, thick)}
                    fill={vizColor(single ? 0 : j)} />
                )
              })}
              {single && (
                <text x={c.vals[0] >= 0 ? sx(c.vals[0]) + 6 : sx(c.vals[0]) - 6}
                  y={y0 + band / 2} className="rpc-val" dominantBaseline="middle"
                  textAnchor={c.vals[0] >= 0 ? 'start' : 'end'}>
                  {fmtCompact(c.vals[0], money)}
                </text>
              )}
              <rect x={0} y={y0} width={width} height={band} fill="transparent"
                tabIndex={0} role="graphics-symbol" className="rpc-hit"
                aria-label={`${c.label}: ${series.map((se, j) => `${se.label} ${fmtVal(c.vals[j], se.money)}`).join(', ')}`}
                onPointerMove={(e) => show(i, e)}
                onFocus={() => show(i)}
                onBlur={() => { setTip(null); setHot(null) }} />
            </g>
          )
        })}
      </svg>
      <TipBox tip={tip} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Línea (tendencias por mes / fecha) con crosshair
// ---------------------------------------------------------------------------
function LineChart({ cats, series, width }: { cats: Cat[]; series: Series[]; width: number }) {
  const [idx, setIdx] = useState<number | null>(null)
  const money = series[0]?.money ?? false
  const all = cats.flatMap((c) => c.vals)
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all), 4)
  const t0 = ticks[0]
  const t1 = ticks[ticks.length - 1]
  const tickW = Math.max(...ticks.map((t) => fmtCompact(t, money).length)) * 6.6 + 12
  const padL = Math.round(tickW)
  const padR = 18
  const padT = 14
  const h = 260
  const padB = 30
  const plotW = Math.max(60, width - padL - padR)
  const plotH = h - padT - padB
  const n = cats.length
  const sx = (i: number) => (n <= 1 ? padL + plotW / 2 : padL + (i * plotW) / (n - 1))
  const sy = (v: number) => padT + plotH - ((v - t0) / (t1 - t0 || 1)) * plotH
  const step = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 74))))
  const dots = n <= 36
  // Etiquetas del eje X sin chocar: una cada `step`, y la última solo si
  // queda lejos de la anterior.
  const showX = (i: number) => i % step === 0
    || (i === n - 1 && (n - 1) % step >= Math.ceil(step / 2))

  function onMove(e: ReactPointerEvent<SVGRectElement>) {
    const box = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - box.left
    const i = n <= 1 ? 0 : Math.round((px / box.width) * (n - 1))
    setIdx(Math.max(0, Math.min(n - 1, i)))
  }
  function onKey(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === 'ArrowRight') { e.preventDefault(); setIdx((i) => Math.min(n - 1, (i ?? -1) + 1)) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setIdx((i) => Math.max(0, (i ?? n) - 1)) }
    else if (e.key === 'Home') { e.preventDefault(); setIdx(0) }
    else if (e.key === 'End') { e.preventDefault(); setIdx(n - 1) }
  }

  const tip: Tip | null = idx == null ? null : {
    x: sx(idx), y: Math.min(...cats[idx].vals.map(sy)),
    title: cats[idx].label,
    rows: series.map((se, j) => ({
      color: vizColor(j), label: se.label, value: fmtVal(cats[idx].vals[j], se.money), line: true,
    })),
  }

  return (
    <div className="rpc-plot">
      <svg width={width} height={h} role="img" tabIndex={0}
        aria-label={`Line chart: ${series.map((x) => x.label).join(', ')} over ${n} points. Use the arrow keys to read values.`}
        onKeyDown={onKey} onBlur={() => setIdx(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={width - padR} y1={sy(t)} y2={sy(t)}
              className={t === 0 ? 'rpc-axis' : 'rpc-grid'} />
            <text x={padL - 8} y={sy(t)} className="rpc-tick" textAnchor="end"
              dominantBaseline="middle">{fmtCompact(t, money)}</text>
          </g>
        ))}
        {cats.map((c, i) => showX(i) && (
          <text key={c.key} x={sx(i)} y={h - 9} className="rpc-tick" textAnchor="middle">
            {trunc(c.label, 12)}
          </text>
        ))}
        {series.length === 1 && n > 1 && (
          <path className="rpc-area" fill={vizColor(0)}
            d={`M${sx(0)},${sy(Math.max(0, t0))}`
              + cats.map((c, i) => `L${sx(i)},${sy(c.vals[0])}`).join('')
              + `L${sx(n - 1)},${sy(Math.max(0, t0))}Z`} />
        )}
        {series.map((se, j) => (
          <path key={se.key} fill="none" stroke={vizColor(j)} strokeWidth={2}
            strokeLinejoin="round" strokeLinecap="round"
            d={cats.map((c, i) => `${i ? 'L' : 'M'}${sx(i)},${sy(c.vals[j])}`).join('')} />
        ))}
        {idx != null && (
          <line x1={sx(idx)} x2={sx(idx)} y1={padT} y2={padT + plotH} className="rpc-cross" />
        )}
        {series.map((se, j) => cats.map((c, i) => (
          (dots || i === n - 1 || i === idx) && (
            <circle key={`${se.key}-${c.key}`} cx={sx(i)} cy={sy(c.vals[j])}
              r={i === idx ? 5 : 4} fill={vizColor(j)} className="rpc-dot" />
          )
        )))}
        <rect x={padL} y={padT} width={plotW} height={plotH} fill="transparent"
          onPointerMove={onMove} onPointerLeave={() => setIdx(null)} />
      </svg>
      <TipBox tip={tip} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Donut (partes de un total: estado, categoría, tipo)
// ---------------------------------------------------------------------------
function DonutChart({ cats, series, width, xcol }: {
  cats: Cat[]; series: Series[]; width: number; xcol?: ReportRunColumn
}) {
  const [hot, setHot] = useState<number | null>(null)
  const se = series[0]
  const pos = cats.filter((c) => c.vals[0] > 0)
  const top = pos.slice(0, MAX_SLICES)
  const rest = pos.slice(MAX_SLICES)
  const restSum = rest.reduce((s, c) => s + c.vals[0], 0)
  // Color = entidad, nunca el ranking: orden del enum (estados) o
  // alfabético entre las porciones mostradas.
  const order = [...top].sort((a, b) => {
    if (xcol?.enum) {
      const ia = xcol.enum.findIndex((o) => o.value === a.key)
      const ib = xcol.enum.findIndex((o) => o.value === b.key)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    }
    return a.label.localeCompare(b.label)
  })
  const colorOf = new Map(order.map((c, i) => [c.key, vizColor(i)]))
  const slices = [
    ...top.map((c) => ({ key: c.key, label: c.label, v: c.vals[0], color: colorOf.get(c.key)! })),
    ...(restSum > 0 ? [{ key: '__other', label: `Other (${rest.length})`, v: restSum, color: 'var(--viz-other)' }] : []),
  ]
  const total = slices.reduce((s, x) => s + x.v, 0)
  const size = Math.round(Math.min(220, Math.max(150, width * 0.36)))
  const stroke = Math.round(size * 0.16)
  const r = (size - stroke) / 2 - 3
  const C = 2 * Math.PI * r
  const cc = size / 2
  const GAP = slices.length > 1 ? 2 : 0
  let acc = 0
  const arcs = slices.map((s) => {
    const len = total ? (s.v / total) * C : 0
    const a = { ...s, len, off: acc }
    acc += len
    return a
  })
  const center = hot != null ? slices[hot] : null
  const negatives = cats.some((c) => c.vals[0] < 0)

  return (
    <div className={`rpc-donut ${width < 520 ? 'is-stacked' : ''}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
        aria-label={`Donut chart: ${se.label} by category`}>
        <g transform={`rotate(-90 ${cc} ${cc})`}>
          <circle cx={cc} cy={cc} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
          {arcs.map((a, i) => (
            <circle key={a.key} cx={cc} cy={cc} r={r} fill="none" stroke={a.color}
              strokeWidth={hot === i ? stroke + 4 : stroke}
              strokeDasharray={`${Math.max(0.1, a.len - GAP)} ${C - Math.max(0.1, a.len - GAP)}`}
              strokeDashoffset={-a.off}
              style={{ opacity: hot != null && hot !== i ? 0.3 : 1, transition: 'opacity .15s, stroke-width .15s' }}
              onPointerEnter={() => setHot(i)} onPointerLeave={() => setHot(null)} />
          ))}
        </g>
        <text x={cc} y={cc - 6} textAnchor="middle" className="rpc-donut-v">
          {fmtCompact(center ? center.v : total, se.money)}
        </text>
        <text x={cc} y={cc + 14} textAnchor="middle" className="rpc-donut-l">
          {center ? `${Math.round((center.v / (total || 1)) * 100)}%` : 'Total'}
        </text>
      </svg>
      <ul className="rpc-dlegend" aria-label={`${se.label} by category`}>
        {slices.map((s, i) => (
          <li key={s.key}>
            <button type="button" className={hot === i ? 'is-on' : undefined}
              onPointerEnter={() => setHot(i)} onPointerLeave={() => setHot(null)}
              onFocus={() => setHot(i)} onBlur={() => setHot(null)}>
              <i style={{ background: s.color }} />
              <span className="rpc-dl-lbl" title={s.label}>{s.label}</span>
              <strong>{fmtVal(s.v, se.money)}</strong>
              <em>{Math.round((s.v / (total || 1)) * 100)}%</em>
            </button>
          </li>
        ))}
      </ul>
      {negatives && (
        <p className="rpc-note">Negative values aren't shown in a donut — switch to bars.</p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// KPI tiles
// ---------------------------------------------------------------------------
export function KpiTiles({ kpis }: { kpis: Kpi[] }) {
  if (!kpis.length) return null
  return (
    <div className="rpc-kpis">
      {kpis.map((k) => (
        <div className="rpc-kpi" key={k.key}>
          <span className="rpc-kpi-l" title={k.label}>{k.label}</span>
          <span className="rpc-kpi-v">{k.value}</span>
          {k.sub && <span className="rpc-kpi-s">{k.sub}</span>}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Vista completa
// ---------------------------------------------------------------------------
export interface ReportChartsProps {
  columns: ReportRunColumn[]
  rows: ReportDataRow[]
  totals: Record<string, ReportCell | number | null> | null
  nosum: Set<string>
  chart: ReportChartSpec | null
  isAgg?: boolean
  // Builder: el gráfico se guarda en la spec. Viewer: estado local.
  onChartChange?: (c: ChartView) => void
  extra?: ReactNode
}

export default function ReportCharts({
  columns, rows, totals, nosum, chart, isAgg = false, onChartChange, extra,
}: ReportChartsProps) {
  const [wrapRef, width] = useWidth<HTMLDivElement>()
  const base = useMemo(() => defaultChartView(columns, chart, nosum), [columns, chart, nosum])
  const [local, setLocal] = useState<ChartView | null>(null)
  // El estado local solo vale para el set de columnas con el que se eligió.
  const colSig = columns.map((c) => c.key).join(',')
  const [sig, setSig] = useState(colSig)
  if (sig !== colSig) { setSig(colSig); setLocal(null) }
  const view = onChartChange ? base : (local ?? base)

  const kpiOnly = chart?.type === 'kpi'
  const kpis = computeKpis(columns, rows, totals, nosum,
    kpiOnly && chart?.y?.length ? chart.y : null, isAgg)

  const cats = useMemo(() => (view ? aggregate(rows, columns, view) : []), [rows, columns, view])
  const sorted = useMemo(() => {
    if (!view) return []
    if (view.type === 'line') return [...cats].sort((a, b) => compareCells(a.raw, b.raw))
    return [...cats].sort((a, b) => b.vals[0] - a.vals[0])
  }, [cats, view])
  const shown = view?.type === 'bar' ? sorted.slice(0, MAX_BARS) : sorted
  const series = view ? seriesOf(columns, view.y) : []
  const xcol = columns.find((c) => c.key === view?.x)

  function set(patch: Partial<ChartView>) {
    if (!view) return
    const next = { ...view, ...patch }
    if (onChartChange) onChartChange(next)
    else setLocal(next)
  }

  const xs = xCandidates(columns)
  const ys = yCandidates(columns)

  return (
    <div className="rpc" ref={wrapRef}>
      <KpiTiles kpis={kpis} />
      {extra}
      {(
        view ? (
          <section className="rpc-card" aria-label="Chart">
            <div className="rpc-head">
              <h3>
                {series.map((s) => s.label).join(' · ')}
                <span> by {xcol?.label ?? ''}</span>
              </h3>
              <div className="rpc-ctrls">
                <div className="rpx-seg" role="group" aria-label="Chart type">
                  {(['bar', 'line', 'donut'] as ChartKind[]).map((t) => (
                    <button key={t} type="button" aria-pressed={view.type === t}
                      className={view.type === t ? 'is-on' : undefined}
                      onClick={() => set({ type: t })}>
                      {t === 'bar' ? 'Bars' : t === 'line' ? 'Line' : 'Donut'}
                    </button>
                  ))}
                </div>
                <label className="rpc-sel">
                  <span>X</span>
                  <select className="cell-input" value={view.x}
                    onChange={(e) => set({ x: e.target.value })}>
                    {xs.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                </label>
                <label className="rpc-sel">
                  <span>Y</span>
                  <select className="cell-input" value={view.y[0]}
                    onChange={(e) => set({ y: [e.target.value] })}>
                    {ys.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                    <option value={COUNT_KEY}>Number of rows</option>
                  </select>
                </label>
              </div>
            </div>
            {shown.length === 0 ? (
              <div className="rpc-empty">No data to chart.</div>
            ) : view.type === 'bar' ? (
              <>
                <Legend series={series} />
                <BarChart cats={shown} series={series} width={Math.max(240, width - 34)} />
                {sorted.length > shown.length && (
                  <p className="rpc-note">
                    Top {shown.length} of {sorted.length} by {series[0]?.label}. The table has every row.
                  </p>
                )}
              </>
            ) : view.type === 'line' ? (
              <>
                <Legend series={series} line />
                <LineChart cats={shown} series={series} width={Math.max(240, width - 34)} />
              </>
            ) : (
              <DonutChart cats={shown} series={series.slice(0, 1)} xcol={xcol}
                width={Math.max(240, width - 34)} />
            )}
          </section>
        ) : (
          <div className="rpc-card rpc-empty">
            Add a text or date column to chart this report.
          </div>
        )
      )}
    </div>
  )
}
