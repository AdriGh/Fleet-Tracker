// Reports & Analytics (fase H8): tablero de GASTO del taller. Lee
// /api/reports/spend (WOs completed/invoiced) y lo presenta como un
// cockpit denso: KPIs (total, parts vs labor, # WOs, avg/WO), gasto por
// categoría (donut + barras), tendencia mensual (SVG inline) y tablas de
// top unidades + top partes. Filtros: rango de fechas (presets + custom)
// y terminal (mismo helper que el resto de la app). Export CSV incluido.
import { useMemo, useState } from 'react'
import {
  keepPreviousData, useQuery, useQueryClient,
} from '@tanstack/react-query'
import {
  getSpendReport,
  type SpendBar, type SpendPart, type SpendReport,
} from '../api'
import { notifyErr } from '../toast'
import { useTerminals } from '../terminal'
import { Button, Tabs } from '../components/ds'
import CountUp from '../components/CountUp'
import Skeleton from '../components/Skeleton'

type Cell = string | number

// Fila ya enriquecida del desglose por categoría: color de identidad, % del
// total (para la barra apilada) y % relativo al máximo (para la mini-barra de
// cada fila). value = monto en $.
interface CatDatum {
  key: string
  label: string
  value: number
  color: string
  pct: number   // % del gasto total
  rel: number   // % respecto a la categoría más alta (escala de la barra)
}

// Trazo compartido de los iconos (mismo estándar que las demás páginas).
const STROKE = {
  fill: 'none' as const, stroke: 'currentColor', strokeWidth: 1.8,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
}

// Paleta de categorías: una key estable del backend = un color fijo, para
// que el donut y las barras coincidan en todas las pantallas. Se usa el
// token de status/UI más cercano a cada categoría (acento para "otros").
const CAT_COLOR: Record<string, string> = {
  tires: '#0891b2',          // celeste — neumáticos
  brakes: 'var(--st-overdue)',
  engine: '#f97316',         // naranja — motor
  oil_fluids: '#d99a00',     // ámbar pato — aceite/fluidos
  electrical: '#6366f1',     // índigo — eléctrico
  suspension: '#14b8a6',     // teal — suspensión
  shop_supplies: '#a1a1aa',  // gris — insumos
  labor: 'var(--st-on-track)',
  other: 'var(--accent)',
}

const PRESETS = [
  { id: 'mtd', label: 'This month' },
  { id: 'qtd', label: 'This quarter' },
  { id: 'ytd', label: 'Year to date' },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Custom' },
] as const
type PresetId = (typeof PRESETS)[number]['id']

// Dinero con 2 decimales y separador de miles (tabular-nums en el CSS).
function money(n: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })
}

function todayISO(): string {
  const t = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`
}

function isoOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 'YYYY-MM' (etiqueta del backend) -> 'MMM ’YY' para los ejes del chart.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function monthLabel(ym: string): string {
  const [y, m] = ym.split('-')
  const idx = Number(m) - 1
  return `${MONTHS[idx] ?? m} ’${(y ?? '').slice(2)}`
}

// Resuelve un preset a [from, to] en ISO. 'all' = sin límites; 'custom'
// usa los inputs del usuario (se manejan aparte).
function presetRange(id: PresetId): { from: string; to: string } {
  const now = new Date()
  const y = now.getFullYear()
  const to = todayISO()
  if (id === 'mtd') {
    return { from: isoOf(new Date(y, now.getMonth(), 1)), to }
  }
  if (id === 'qtd') {
    const q = Math.floor(now.getMonth() / 3)
    return { from: isoOf(new Date(y, q * 3, 1)), to }
  }
  if (id === 'ytd') {
    return { from: isoOf(new Date(y, 0, 1)), to }
  }
  return { from: '', to: '' }   // all
}

function downloadCSV(m: Cell[][], name: string) {
  const csv = m
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\n')
  // BOM para que Excel respete UTF-8.
  const url = URL.createObjectURL(
    new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

export default function ReportsPage() {
  const { terminals, labelOf } = useTerminals()
  const queryClient = useQueryClient()

  const [preset, setPreset] = useState<PresetId>('ytd')
  const [terminal, setTerminal] = useState('')
  // Inputs del rango custom (solo activos con preset === 'custom').
  const [cFrom, setCFrom] = useState('')
  const [cTo, setCTo] = useState(todayISO())

  // Rango efectivo que viaja al backend.
  const range = useMemo(() => {
    if (preset === 'custom') return { from: cFrom, to: cTo }
    return presetRange(preset)
  }, [preset, cFrom, cTo])

  const query = useQuery({
    queryKey: ['spend-report', range.from, range.to, terminal],
    queryFn: () => getSpendReport({
      from: range.from, to: range.to, terminal,
      topUnits: 12, topParts: 12,
    }),
    placeholderData: keepPreviousData,
  })
  const data: SpendReport | undefined = query.data
  const t = data?.totals

  // Reparto parts/labor en % para el sub del KPI.
  const partsPct = t && t.total_spend > 0
    ? Math.round((t.parts_spend / t.total_spend) * 100) : 0

  // Desglose por categoría: una fila por categoría con gasto (>0), ya filtrado
  // y ordenado por el backend. Se le agrega color de identidad, % del total y
  // el % relativo al máximo (para la barra mini de cada fila). Alimenta el
  // chart segmentado custom (reemplaza al donut genérico).
  const catData = useMemo<CatDatum[]>(() => {
    const cats = data?.by_category ?? []
    const total = cats.reduce((s, c) => s + c.value, 0)
    const max = Math.max(1, ...cats.map((c) => c.value))
    return cats.map((c) => ({
      key: c.key,
      label: c.label,
      value: c.value,
      color: CAT_COLOR[c.key] ?? 'var(--accent)',
      pct: total > 0 ? (c.value / total) * 100 : 0,
      rel: (c.value / max) * 100,
    }))
  }, [data])

  const hasData = !!t && t.wo_count > 0

  // Refresh REAL: invalida TODO el namespace 'spend-report' en la caché (no
  // solo el rango activo) y fuerza un refetch ignorando el staleTime. Así, si
  // el jefe creó WOs en otra pantalla, el número se mueve al volver y tocar
  // Refresh — antes refetch() podía servir la copia cacheada sin pedir red.
  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['spend-report'] })
    await query.refetch({ cancelRefetch: true })
  }

  function exportCSV() {
    if (!data) return
    try {
      const rows: Cell[][] = []
      const scope = terminal ? labelOf(terminal) : 'All terminals'
      const rangeLabel =
        `${data.range.from ?? 'start'} to ${data.range.to ?? 'today'}`
      rows.push(['Fleet Tracker — Spend report'])
      rows.push(['Scope', scope])
      rows.push(['Range', rangeLabel])
      rows.push([])
      rows.push(['Totals'])
      rows.push(['Total spend', t!.total_spend])
      rows.push(['Parts', t!.parts_spend])
      rows.push(['Labor', t!.labor_spend])
      rows.push(['Work orders', t!.wo_count])
      rows.push(['Avg per WO', t!.avg_per_wo])
      rows.push([])
      rows.push(['By category', 'Spend'])
      for (const c of data.by_category) rows.push([c.label, c.value])
      rows.push([])
      rows.push(['By unit', 'Spend'])
      for (const u of data.by_unit) rows.push([u.label, u.value])
      rows.push([])
      rows.push(['By month', 'Spend'])
      for (const mo of data.by_month) rows.push([mo.label, mo.value])
      rows.push([])
      rows.push(['Top parts', 'Description', 'Qty', 'Spend'])
      for (const p of data.top_parts) {
        rows.push([p.part_number, p.description, p.qty, p.value])
      }
      downloadCSV(rows, 'spend-report.csv')
    } catch (e) {
      notifyErr("Couldn't export CSV", e)
    }
  }

  return (
    <div className="page page-wide rp">
      {query.isFetching && <div className="loadbar" aria-hidden="true" />}
      <div className="page-head">
        <div>
          <h1>Reports &amp; Analytics</h1>
          <p className="page-sub">
            Committed shop spend across all work orders with line items
            (incl. open) — by category, unit, month and part. Internal cost,
            no markup.
          </p>
        </div>
        <div className="head-actions">
          <Button variant="ghost" onClick={refresh}
            loading={query.isFetching}
            icon={
              <svg viewBox="0 0 24 24" {...STROKE}>
                <path d="M20 11a8 8 0 1 0-2.3 6.3M20 5v6h-6" />
              </svg>
            }>
            Refresh
          </Button>
          <Button variant="ghost" disabled={!hasData} onClick={exportCSV}
            title="Download the full report as CSV"
            icon={
              <svg viewBox="0 0 24 24" {...STROKE}>
                <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
              </svg>
            }>
            Export CSV
          </Button>
        </div>
      </div>

      {/* ----- Filtros: rango + (terminales) + custom ----- */}
      <div className="card">
        <div className="card-body rp-filters">
          <div className="rp-filter">
            <span className="rp-filter-lbl">Range</span>
            <Tabs
              tabs={PRESETS.map((p) => ({ id: p.id, label: p.label }))}
              value={preset}
              onChange={(id) => setPreset(id as PresetId)}
            />
          </div>

          {preset === 'custom' && (
            <div className="rp-filter rp-custom">
              <label>
                <span className="rp-filter-lbl">From</span>
                <input type="date" className="cell-input" value={cFrom}
                  max={cTo || undefined}
                  onChange={(e) => setCFrom(e.target.value)} />
              </label>
              <label>
                <span className="rp-filter-lbl">To</span>
                <input type="date" className="cell-input" value={cTo}
                  min={cFrom || undefined}
                  onChange={(e) => setCTo(e.target.value)} />
              </label>
            </div>
          )}

          {terminals.length > 1 && (
            <div className="rp-filter">
              <span className="rp-filter-lbl">Terminal</span>
              <Tabs
                tabs={[{ id: '', label: 'All' },
                  ...terminals.map((tt) => ({ id: tt.key, label: tt.label }))]}
                value={terminal}
                onChange={(id) => setTerminal(terminal === id ? '' : id)}
              />
            </div>
          )}
        </div>
      </div>

      {query.isPending ? (
        <>
          <div className="kpi-row">
            {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} h={92} />)}
          </div>
          <div className="card"><div className="card-body skel-rows">
            {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} h={34} />)}
          </div></div>
        </>
      ) : !hasData ? (
        <div className="card"><div className="card-body rp-empty">
          <svg viewBox="0 0 24 24" {...STROKE}>
            <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
          </svg>
          <h2>No spend in this range</h2>
          <p>
            Add parts &amp; labor to a work order and its spend rolls up here —
            no need to close it out first. Try widening the date range.
          </p>
        </div></div>
      ) : (
        <>
          {/* ----- KPIs ----- */}
          <div className="kpi-row">
            <div className="stat-card tone-accent">
              <span className="stat-label">Total spend</span>
              <span className="stat-value rp-money">
                <i>$</i>
                <CountUp value={t!.total_spend} format={money} />
              </span>
              <span className="stat-sub">
                {t!.wo_count} work {t!.wo_count === 1 ? 'order' : 'orders'}
              </span>
            </div>
            <div className="stat-card tone-info">
              <span className="stat-label">Parts vs labor</span>
              <span className="stat-value rp-split">
                <span className="rp-money"><i>$</i>{money(t!.parts_spend)}</span>
                <span className="rp-split-sep">/</span>
                <span className="rp-money rp-labor">
                  <i>$</i>{money(t!.labor_spend)}
                </span>
              </span>
              <span className="stat-sub">
                {partsPct}% parts · {100 - partsPct}% labor
              </span>
              <span className="rp-split-bar" aria-hidden="true">
                <i style={{ width: `${partsPct}%`, background: 'var(--ui-info)' }} />
                <i style={{ width: `${100 - partsPct}%`,
                  background: 'var(--st-on-track)' }} />
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Work orders</span>
              <span className="stat-value">
                <CountUp value={t!.wo_count} />
              </span>
              <span className="stat-sub">with billable lines</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Avg per WO</span>
              <span className="stat-value rp-money">
                <i>$</i>
                <CountUp value={t!.avg_per_wo} format={money} />
              </span>
              <span className="stat-sub">cost per closed order</span>
            </div>
          </div>

          {/* ----- Gasto por categoría (chart segmentado, hero a ancho
                   completo: la barra apilada + el desglose llenan el panel sin
                   el hueco que dejaba el donut) ----- */}
          <section className="card rp-cats">
            <div className="card-head">
              <h2>Spend by category</h2>
              <span className="sub rp-money">
                parts &amp; labor · <i>$</i>{money(t!.total_spend)} total
              </span>
            </div>
            <div className="card-body">
              <CategoryBreakdown cats={catData} total={t!.total_spend} />
            </div>
          </section>

          {/* ----- Tendencia mensual a ancho completo (el SVG está pensado
                   para 680px; a media columna quedaba apretado y con hueco) -- */}
          <section className="card rp-trend">
            <div className="card-head">
              <h2>Monthly trend</h2>
              <span className="sub">spend per month</span>
            </div>
            <div className="card-body">
              <MonthTrend points={data!.by_month} />
            </div>
          </section>

          {/* ----- Top unidades + top partes ----- */}
          <div className="rp-grid">
            <section className="card">
              <div className="card-head rp-table-head">
                <h2>Top units by spend
                  <span className="mnt-count">{data!.by_unit.length}</span>
                </h2>
              </div>
              <div className="card-body">
                <UnitBars units={data!.by_unit} />
              </div>
            </section>

            <section className="card">
              <div className="card-head rp-table-head">
                <h2>Top parts by spend
                  <span className="mnt-count">{data!.top_parts.length}</span>
                </h2>
              </div>
              <div className="table-wrap">
                <table className="mnt-table rp-parts-table">
                  <thead>
                    <tr>
                      <th className="rp-left">Part</th>
                      <th className="num">Qty</th>
                      <th className="num">Spend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data!.top_parts.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="rp-parts-empty">
                          No catalog parts in this range.
                        </td>
                      </tr>
                    ) : (
                      data!.top_parts.map((p) => <PartRow key={p.part_number + p.description} part={p} />)
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Spend by category — chart segmentado custom (reemplaza al donut genérico).
// Dos partes que comparten la identidad de color de cada categoría:
//   1) Una barra apilada a ancho completo (la "asignación" del gasto): cada
//      categoría ocupa su % del total, con divisores finos. Es el hero visual.
//   2) Un desglose en grilla (auto-fit) debajo: por categoría, chip de color +
//      etiqueta + mini-barra (escala al máximo) + monto en $ (tabular-nums) +
//      %. Llena el panel a lo ancho, sin los huecos del donut.
// Hover sincronizado: resaltar un segmento atenúa los demás y viceversa.
// ---------------------------------------------------------------------------
function CategoryBreakdown(
  { cats, total }: { cats: CatDatum[]; total: number },
) {
  const [hover, setHover] = useState<string | null>(null)
  if (cats.length === 0 || total <= 0) {
    return (
      <div className="empty mini">
        <p>No categorized spend in this range.</p>
      </div>
    )
  }
  const dim = (key: string) => hover != null && hover !== key

  return (
    <div className="rp-cat">
      {/* Barra apilada: una asignación del 100% del gasto por categoría. */}
      <div className="rp-cat-stack" role="img"
        aria-label="Spend allocation by category">
        {cats.map((c) => (
          <span
            key={c.key}
            className="rp-cat-seg"
            title={`${c.label} · $${money(c.value)} · ${Math.round(c.pct)}%`}
            style={{
              width: `${c.pct}%`,
              background: c.color,
              opacity: dim(c.key) ? 0.32 : 1,
            }}
            onMouseEnter={() => setHover(c.key)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </div>

      {/* Desglose: una fila por categoría, en grilla que llena el ancho. */}
      <ul className="rp-cat-list">
        {cats.map((c) => (
          <li
            key={c.key}
            className={`rp-cat-row${hover === c.key ? ' on' : ''}`}
            style={{ opacity: dim(c.key) ? 0.5 : 1 }}
            onMouseEnter={() => setHover(c.key)}
            onMouseLeave={() => setHover(null)}
          >
            <span className="rp-cat-top">
              <span className="rp-cat-chip" style={{ background: c.color }} />
              <span className="rp-cat-lbl" title={c.label}>{c.label}</span>
              <span className="rp-cat-pct">{Math.round(c.pct)}%</span>
            </span>
            <span className="rp-cat-track">
              <span className="rp-cat-fill"
                style={{ width: `${Math.max(c.rel, 2)}%`,
                  background: c.color }} />
            </span>
            <span className="rp-cat-amt rp-money">
              <i>$</i>{money(c.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// Barras horizontales de gasto por unidad (estilo RankBars pero con $ y
// tabular-nums; la barra usa el acento, escala al máximo del set).
function UnitBars({ units }: { units: SpendBar[] }) {
  if (units.length === 0) {
    return <div className="empty mini"><p>No unit spend in this range.</p></div>
  }
  const max = Math.max(1, ...units.map((u) => u.value))
  return (
    <ul className="rp-bars">
      {units.map((u) => (
        <li key={u.label}>
          <span className="rp-bar-label" title={u.label}>
            {u.label || '—'}
          </span>
          <span className="rp-bar-track">
            <span className="rp-bar-fill"
              style={{ width: `${(u.value / max) * 100}%` }} />
          </span>
          <span className="rp-bar-value"><i>$</i>{money(u.value)}</span>
        </li>
      ))}
    </ul>
  )
}

function PartRow({ part }: { part: SpendPart }) {
  return (
    <tr>
      <td className="rp-left">
        <strong className="rp-pn">{part.part_number}</strong>
        {part.description && <em className="rp-pd">{part.description}</em>}
      </td>
      <td className="num">{part.qty.toLocaleString('en-US')}</td>
      <td className="num rp-cell-money"><i>$</i>{money(part.value)}</td>
    </tr>
  )
}

// Tendencia mensual: barras SVG con etiqueta de valor encima y mes abajo.
// Mismo lenguaje visual que TrendsChart, pero en $ y con eje propio.
const W = 680
const H = 220
const ML = 16
const MR = 12
const MT = 26
const MB = 30
const PLOT_W = W - ML - MR
const PLOT_H = H - MT - MB

function MonthTrend({ points }: { points: SpendBar[] }) {
  if (points.length === 0) {
    return (
      <div className="empty mini">
        <p>Close work orders and the monthly trend shows up here.</p>
      </div>
    )
  }
  const n = points.length
  const colW = PLOT_W / n
  const maxV = Math.max(1, ...points.map((p) => p.value))
  const baseY = MT + PLOT_H
  const bw = Math.min(46, colW * 0.6)
  const x = (i: number) => ML + colW * (i + 0.5)
  // Etiqueta de valor compacta ($1.2k) para no apretujar el chart.
  const compact = (v: number) =>
    v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.round(v)}`

  return (
    <div className="rp-trend-chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="trends-svg" role="img"
        aria-label="Monthly spend trend">
        <line x1={ML} y1={baseY} x2={W - MR} y2={baseY} className="trends-grid" />
        {points.map((d, i) => {
          const h = (d.value / maxV) * PLOT_H
          const showLabel = n <= 14 || i % 2 === 0
          return (
            <g key={d.label}>
              <rect
                x={x(i) - bw / 2}
                y={baseY - h}
                width={bw}
                height={Math.max(h, d.value > 0 ? 2 : 0)}
                rx={4}
                className="rp-trend-bar"
              />
              {d.value > 0 && (
                <text x={x(i)} y={baseY - h - 7} className="rp-trend-val">
                  {compact(d.value)}
                </text>
              )}
              {showLabel && (
                <text x={x(i)} y={H - 9} className="trends-xlabel">
                  {monthLabel(d.label)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
