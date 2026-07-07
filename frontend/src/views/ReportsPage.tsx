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
  getCpmReport, getSpendReport, refreshCpm,
  type CpmReport, type CpmUnitRow,
  type SpendBar, type SpendPart, type SpendReport, type SpendTotals,
} from '../api'
import { notifyErr, notifyOk } from '../toast'
import { useTerminals } from '../terminal'
import { Button, Tabs, StatCard, StatCluster } from '../components/ds'
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

  // Cost per mile: mismo rango/terminal. Query aparte (une gasto con millas
  // del odómetro persistido). Puede tardar más que spend, no bloquea el resto.
  const cpmQuery = useQuery({
    queryKey: ['cpm-report', range.from, range.to, terminal],
    queryFn: () => getCpmReport({ from: range.from, to: range.to, terminal }),
    placeholderData: keepPreviousData,
  })

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

  // Materializa la base de millas (backfill de WO/PM + snapshot Samsara) y
  // refresca el CPM. Útil tras cargar millaje a mano a una WO.
  const [cpmBusy, setCpmBusy] = useState(false)
  async function updateCpm() {
    setCpmBusy(true)
    try {
      const r = await refreshCpm()
      const added = r.backfilled + r.snapshot
      notifyOk(added
        ? `Mileage updated — ${added} new odometer reading${added === 1 ? '' : 's'}`
        : 'Mileage is already up to date')
      await queryClient.invalidateQueries({ queryKey: ['cpm-report'] })
    } catch (e) {
      notifyErr("Couldn't update mileage data", e)
    } finally {
      setCpmBusy(false)
    }
  }

  function exportCSV() {
    if (!data) return
    try {
      const rows: Cell[][] = []
      const scope = terminal ? labelOf(terminal) : 'All terminals'
      const rangeLabel =
        `${data.range.from ?? 'start'} to ${data.range.to ?? 'today'}`
      rows.push(['Rigsmith — Spend report'])
      rows.push(['Scope', scope])
      rows.push(['Range', rangeLabel])
      rows.push([])
      rows.push(['Totals'])
      rows.push(['Total spend', t!.total_spend])
      rows.push(['Parts', t!.parts_spend])
      rows.push(['Labor', t!.labor_spend])
      rows.push(['Preventive (planned)', t!.pm_spend])
      rows.push(['Reactive (breakdown)', t!.reactive_spend])
      rows.push(['Preventive %', t!.pm_pct])
      rows.push(['Work orders', t!.wo_count])
      rows.push(['Avg per WO', t!.avg_per_wo])
      rows.push(['Median per WO', t!.median_per_wo])
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
          <StatCluster className="kpi-row">
            {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} h={92} />)}
          </StatCluster>
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
          {/* ----- KPIs (gauges del DS; parts vs labor usa el riel split) ----- */}
          <StatCluster className="kpi-row">
            <StatCard
              label="Total spend"
              tone="accent"
              value={<>$<CountUp value={t!.total_spend} format={money} /></>}
              sub={`${t!.wo_count} work ${t!.wo_count === 1 ? 'order' : 'orders'}`}
            />
            <StatCard
              label="Parts vs labor"
              tone="info"
              splitTone="ok"
              progress={partsPct / 100}
              value={
                <span style={{ fontSize: '1.15rem' }}>
                  <span style={{ color: '#38bdf8' }}>${money(t!.parts_spend)}</span>
                  <span style={{ color: '#6b6b76' }}> / </span>
                  <span style={{ color: '#34d399' }}>${money(t!.labor_spend)}</span>
                </span>
              }
              sub={`${partsPct}% parts · ${100 - partsPct}% labor`}
            />
            <StatCard
              label="Work orders"
              value={<CountUp value={t!.wo_count} />}
              sub="with billable lines"
            />
            <StatCard
              label="Avg per WO"
              value={<>$<CountUp value={t!.avg_per_wo} format={money} /></>}
              sub={`median $${money(t!.median_per_wo)} · per order`}
            />
          </StatCluster>

          {/* ----- Cost per mile (el número de Dario): gasto / millas del
                   odómetro persistido. Solo cuenta unidades con millas; honesto
                   sobre la cobertura. ----- */}
          <section className="card rp-cpm">
            <div className="card-head">
              <h2>Cost per mile</h2>
              <span className="sub">maintenance $ ÷ miles driven</span>
              <span className="head-spacer" />
              <Button variant="ghost" onClick={updateCpm} loading={cpmBusy}
                title="Backfill odometer from work-order mileage + pull the latest ELD reading"
                icon={
                  <svg viewBox="0 0 24 24" {...STROKE}>
                    <path d="M20 11a8 8 0 1 0-2.3 6.3M20 5v6h-6" />
                  </svg>
                }>
                Update mileage
              </Button>
            </div>
            <div className="card-body">
              <CpmView data={cpmQuery.data} loading={cpmQuery.isPending} />
            </div>
          </section>

          {/* ----- Preventive vs reactive (el "CPM story" honesto: prevengo o
                   apago incendios). Split del gasto por WO planificada vs de
                   falla. No necesita millas — es 100% de nuestros datos. ----- */}
          <section className="card rp-prev">
            <div className="card-head">
              <h2>Preventive vs reactive</h2>
              <span className="sub">planned maintenance as a share of shop $</span>
            </div>
            <div className="card-body">
              <PreventionSplit totals={t!} />
            </div>
          </section>

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

// ---------------------------------------------------------------------------
// Preventive vs reactive — el ratio más honesto del "cost story" (sin millas).
// Cada WO facturada es planificada (PM/campaña) o reactiva (falla). Muestra el
// % de prevención grande, una barra split verde/rojo con $ y %, y una lectura
// en lenguaje claro con su benchmark. Más prevención = menos breakdowns que
// pagás. La señal real está en la TENDENCIA mes a mes, no en el absoluto.
// ---------------------------------------------------------------------------
function PreventionSplit({ totals }: { totals: SpendTotals }) {
  const pm = totals.pm_spend
  const re = totals.reactive_spend
  const total = pm + re
  const pmPct = total > 0 ? (pm / total) * 100 : 0
  const rePct = 100 - pmPct

  // Lectura + tono según cuánto del gasto es preventivo. El estándar de oro
  // de mantenimiento es ~80/20 planificado/reactivo; casi ninguna flota llega,
  // así que los umbrales son realistas, no idealizados.
  const read =
    total <= 0
      ? { cls: 'muted', text: 'No spend to split yet in this range.' }
      : pmPct >= 60
        ? { cls: 'ok', text: 'Strongly preventive — you’re ahead of breakdowns, not chasing them.' }
        : pmPct >= 35
          ? { cls: 'info', text: 'Balanced — solid prevention, with room to shift more dollars to planned work.' }
          : { cls: 'warn', text: 'Reactive-heavy — most dollars go to breakdowns. Every point you move to PM is a breakdown you didn’t pay for.' }

  return (
    <div className="rp-prev-wrap">
      <div className="rp-prev-lede">
        <div className={`rp-prev-big rp-prev-${read.cls}`}>
          <CountUp value={Math.round(pmPct)} />
          <span className="rp-prev-unit">% preventive</span>
        </div>
        <p className={`rp-prev-read rp-prev-${read.cls}`}>{read.text}</p>
      </div>

      {/* Barra split: verde = planificado, rojo = reactivo. */}
      <div className="rp-prev-stack" role="img"
        aria-label={`${Math.round(pmPct)} percent preventive, ${Math.round(rePct)} percent reactive`}>
        <span className="rp-prev-seg rp-prev-seg-pm"
          style={{ width: `${pmPct}%` }}
          title={`Preventive · $${money(pm)} · ${Math.round(pmPct)}%`} />
        <span className="rp-prev-seg rp-prev-seg-re"
          style={{ width: `${rePct}%` }}
          title={`Reactive · $${money(re)} · ${Math.round(rePct)}%`} />
      </div>

      <div className="rp-prev-legend">
        <div className="rp-prev-leg">
          <span className="rp-prev-chip rp-prev-chip-pm" />
          <span className="rp-prev-leg-lbl">Planned / PM</span>
          <span className="rp-prev-leg-amt rp-money"><i>$</i>{money(pm)}</span>
          <span className="rp-prev-leg-pct">{Math.round(pmPct)}%</span>
        </div>
        <div className="rp-prev-leg">
          <span className="rp-prev-chip rp-prev-chip-re" />
          <span className="rp-prev-leg-lbl">Reactive / breakdown</span>
          <span className="rp-prev-leg-amt rp-money"><i>$</i>{money(re)}</span>
          <span className="rp-prev-leg-pct">{Math.round(rePct)}%</span>
        </div>
      </div>

      <p className="rp-prev-bench">
        Maintenance gold standard is roughly <strong>80% planned / 20% reactive</strong>;
        most fleets run well below it. Watch the month-over-month trend more than
        the absolute — the direction is the signal.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cost per mile — el número ancla. Fleet CPM grande (coloreado por benchmark)
// + cobertura honesta + tabla por unidad (peores $/mi primero). Solo cuenta
// unidades CON millas del odómetro; las que tienen gasto pero sin odómetro se
// declaran aparte para no inflar el número.
// ---------------------------------------------------------------------------
const cpmFmt = (n: number) => `$${n.toFixed(2)}`
// Tono según benchmark R&M heavy-duty ($0.15–0.20 típico; >0.25 bandera roja).
const cpmTone = (n: number) => (n <= 0.20 ? 'ok' : n <= 0.25 ? 'warn' : 'danger')
const plural = (n: number) => (n === 1 ? '' : 's')

function CpmView({ data, loading }: { data?: CpmReport; loading: boolean }) {
  if (loading && !data) {
    return (
      <div className="skel-rows">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} h={32} />)}
      </div>
    )
  }
  if (!data) return null

  // Sin Fleet CPM todavía: hace falta ≥2 lecturas de odómetro por unidad.
  if (data.fleet_cpm == null) {
    return (
      <div className="rp-cpm-empty">
        <svg viewBox="0 0 24 24" {...STROKE} className="rp-cpm-empty-ic">
          <path d="M3 12h4l2-7 4 14 2-7h6" />
        </svg>
        <h3>Cost per mile is warming up</h3>
        <p>
          It needs at least two odometer readings per unit to measure the miles
          driven in a period. Readings come from{' '}
          <strong>work-order mileage</strong> and the{' '}
          <strong>daily ELD sync</strong> — there’s no backfill before the first
          reading, so the number grows as data accrues.
          {data.units_without_miles > 0 && (
            <> Right now {data.units_without_miles} unit
              {plural(data.units_without_miles)} ha
              {data.units_without_miles === 1 ? 's' : 've'} spend but no mileage.</>
          )}
          {' '}Add a meter reading to a work order, then hit{' '}
          <strong>Update mileage</strong>.
        </p>
      </div>
    )
  }

  const rows = data.by_unit.filter((u) => u.cpm != null)
  const tone = cpmTone(data.fleet_cpm)

  return (
    <div className="rp-cpm-wrap">
      <div className="rp-cpm-lede">
        <div className={`rp-cpm-big rp-cpm-${tone}`}>
          {cpmFmt(data.fleet_cpm)}<span className="rp-cpm-unit">/mi</span>
        </div>
        <div className="rp-cpm-side">
          <p className="rp-cpm-sub">
            Fleet maintenance cost per mile across{' '}
            <strong>{data.units_with_miles}</strong> unit
            {plural(data.units_with_miles)} with odometer data —{' '}
            <strong>{data.fleet_miles.toLocaleString('en-US')}</strong> mi ·{' '}
            <strong>${money(data.fleet_spend)}</strong> spend.
          </p>
          <p className="rp-cpm-bench">
            Heavy-duty benchmark <strong>$0.15–0.20/mi</strong>; a red flag above{' '}
            <strong>$0.25</strong> sustained.
            {data.coverage.since && <> Data since {data.coverage.since}.</>}
          </p>
        </div>
      </div>

      {data.units_without_miles > 0 && (
        <p className="rp-cpm-note">
          {data.units_without_miles} unit{plural(data.units_without_miles)}{' '}
          (${money(data.spend_without_miles)} spend) ha
          {data.units_without_miles === 1 ? 's' : 've'} no odometer data yet and
          {' '}are excluded from the fleet number. Trailers don’t have odometers.
        </p>
      )}

      <div className="table-wrap">
        <table className="mnt-table rp-cpm-table">
          <thead>
            <tr>
              <th className="rp-left">Unit</th>
              <th className="num">Spend</th>
              <th className="num">Miles</th>
              <th className="num">$ / mi</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u: CpmUnitRow) => (
              <tr key={u.unit}>
                <td className="rp-left"><strong>{u.unit}</strong></td>
                <td className="num rp-cell-money"><i>$</i>{money(u.spend)}</td>
                <td className="num">{u.miles.toLocaleString('en-US')}</td>
                <td className={`num rp-cpm-cell rp-cpm-${cpmTone(u.cpm as number)}`}>
                  {cpmFmt(u.cpm as number)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
