import { Fragment, useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { listDefectStats, listOpenDefects, type Defect } from '../api'
import Skeleton from '../components/Skeleton'
import StatCard from '../components/StatCard'
import RankBars from '../components/RankBars'
import StatusDonut from '../components/StatusDonut'
import DefectsTrendChart from '../components/DefectsTrendChart'
import TruckDiagram from '../components/TruckDiagram'
import UnitReport from '../components/UnitReport'
import SummaryReport from '../components/SummaryReport'
import Modal from '../components/Modal'
import { type Kind } from '../truckZones'
import { analyzeUnit, items, categoryOf } from '../defectGroups'

const STATUSES = ['Unsafe', 'Resolved', 'Safe']

// --- helpers ---------------------------------------------------------------
function dayKey(l: string): number {
  const [mo, da] = l.split('.').map(Number)
  return (mo || 0) * 100 + (da || 0)
}
function topCounts(
  defs: Defect[],
  key: (d: Defect) => string,
  limit = 6,
): { label: string; value: number }[] {
  const m = new Map<string, number>()
  for (const d of defs) {
    const k = key(d)
    if (!k) continue
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return [...m.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
}
function statusTone(s: string) {
  return s === 'Safe' ? 'safe' : s === 'Resolved' ? 'resolved' : 'unsafe'
}
function statusSummary(st: Record<string, number>): string {
  if (st.Open) return `Open ${st.Open}`
  return ['Unsafe', 'Resolved', 'Safe']
    .filter((s) => st[s])
    .map((s) => `${s} ${st[s]}`)
    .join(' / ')
}

// Consolidación por unidad
interface UnitRow {
  unit: string
  kind: string
  company: string
  drivers: string[]
  status: Record<string, number>
  defects: string[]
  count: number
  records: Defect[]
}
function consolidate(defs: Defect[]): UnitRow[] {
  const m = new Map<string, {
    unit: string; kind: string; company: string
    drivers: Set<string>; status: Record<string, number>; items: Set<string>
    records: Defect[]
  }>()
  for (const d of defs) {
    const k = d.unit || '—'
    let e = m.get(k)
    if (!e) {
      e = { unit: k, kind: d.unit_kind, company: d.company,
        drivers: new Set(), status: {}, items: new Set(), records: [] }
      m.set(k, e)
    }
    if (d.driver) e.drivers.add(d.driver)
    e.status[d.status] = (e.status[d.status] ?? 0) + 1
    for (const it of items(d.detail)) e.items.add(it)
    e.records.push(d)
  }
  return [...m.values()].map((e) => ({
    unit: e.unit, kind: e.kind, company: e.company,
    drivers: [...e.drivers], status: e.status,
    defects: [...e.items], count: e.items.size, records: e.records,
  }))
}

type SortKey = 'count' | 'unit' | 'company'

// --- export ---------------------------------------------------------------
type Cell = string | number
async function copyMatrix(m: Cell[][]) {
  const tsv = m
    .map((r) => r.map((c) => String(c).replace(/[\t\n]/g, ' ')).join('\t'))
    .join('\n')
  await navigator.clipboard.writeText(tsv)
}
function downloadCSV(m: Cell[][], name = 'defects.csv') {
  const csv = m
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\n')
  const url = URL.createObjectURL(
    new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

// Panel ancho que se despliega al hacer clic en una unidad: defectos agrupados
// (con su frecuencia) a la izquierda y un diagrama del camión por zonas a la
// derecha (rojo = con defectos, verde = sin defectos).
function UnitPanel(
  { row, onDownload }: { row: UnitRow; onDownload: () => void },
) {
  const kind: Kind = row.kind === 'trailer' ? 'trailer' : 'truck'
  const { groups, zones } = useMemo(
    () => analyzeUnit(row.records, kind), [row.records, kind])
  const totalRep = groups.reduce((s, g) => s + g.count, 0)

  return (
    <div className="unit-panel">
      <div className="unit-panel-defects">
        <div className="up-head">
          <h3>Reported defects</h3>
          <span className="sub">
            {groups.length} distinct · {totalRep} reports
          </span>
          <span className="head-spacer" />
          <button className="btn btn-ghost up-pdf" onClick={onDownload}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="M7 10l5 5 5-5" /><path d="M12 15V3" />
            </svg>
            Download PDF
          </button>
        </div>
        {groups.length === 0 ? (
          <div className="empty mini">
            <p>No real defects (only unchanged re-inspections).</p>
          </div>
        ) : (
          <ul className="defect-groups">
            {groups.map((g, i) => (
              <li key={i} className="defect-group">
                <span
                  className={`dg-dot zone-${g.zone ?? 'other'}`}
                  title={g.zone ? undefined : 'No zone assigned'}
                />
                <span className="dg-text">
                  <span className="dg-cat">{g.category}</span>
                  {g.body && <span className="dg-body"> — {g.body}</span>}
                </span>
                <span className={`dg-count${g.count > 1 ? ' rep' : ''}`}>
                  ×{g.count}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="unit-panel-truck">
        <TruckDiagram zones={zones} kind={kind} />
        <span className="truck-kind-tag">
          {kind === 'trailer' ? 'Trailer' : 'Truck'} · {row.unit}
        </span>
      </div>
    </div>
  )
}

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
]

export default function DefectsPage() {
  const [rangeDays, setRangeDays] = useState(7)
  const [company, setCompany] = useState('')
  const [status, setStatus] = useState('')
  const [unit, setUnit] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('count')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState(false)
  const [reportRows, setReportRows] = useState<UnitRow[] | null>(null)
  const [listRows, setListRows] = useState<UnitRow[] | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())

  // Dashboard (por rango): mantiene los datos previos al cambiar el rango
  // (sin parpadeo) mientras llega la nueva ventana.
  const statsQuery = useQuery({
    queryKey: ['defect-stats', rangeDays],
    queryFn: () => listDefectStats(rangeDays),
    placeholderData: keepPreviousData,
  })
  // Backlog abierto (tabla): independiente del rango.
  const openQuery = useQuery({
    queryKey: ['open-defects'],
    queryFn: () => listOpenDefects(),
  })

  const stats = statsQuery.data ?? []
  const openDefs = openQuery.data ?? []
  const err = statsQuery.error ?? openQuery.error
  const error = err ? (err instanceof Error ? err.message : 'Error') : null
  const dashLoading = statsQuery.isPending           // primera carga, sin datos
  const boardLoading = openQuery.isPending
  const fetching = statsQuery.isFetching || openQuery.isFetching

  function refresh() {
    statsQuery.refetch()
    openQuery.refetch()
  }

  const filtered = useMemo(() => {
    const uq = unit.trim().toLowerCase()
    return stats.filter((d) =>
      (!company || d.company === company) &&
      (!status || d.status === status) &&
      (!uq || d.unit.toLowerCase().includes(uq)))
  }, [stats, company, status, unit])

  const issues = useMemo(
    () => filtered.filter((d) => d.status !== 'Safe'), [filtered])

  const kpis = useMemo(() => {
    const unsafe = filtered.filter((d) => d.status === 'Unsafe').length
    const resolved = filtered.filter((d) => d.status === 'Resolved').length
    const denom = unsafe + resolved
    const top = topCounts(issues, (d) => d.unit, 1)[0]
    return {
      total: filtered.length,
      unsafe,
      resolved,
      pct: denom ? Math.round((resolved / denom) * 100) : null,
      topUnit: top,
    }
  }, [filtered, issues])

  const byDay = useMemo(() => {
    const m = new Map<string, number>()
    for (const d of issues) m.set(d.date_label, (m.get(d.date_label) ?? 0) + 1)
    return [...m.entries()]
      .sort((a, b) => dayKey(a[0]) - dayKey(b[0]))
      .map(([label, count]) => ({ label, count }))
  }, [issues])

  const byCategory = useMemo(() => {
    const m = new Map<string, number>()
    for (const d of issues)
      for (const it of items(d.detail)) {
        const c = categoryOf(it)
        if (c === 'Other') continue
        m.set(c, (m.get(c) ?? 0) + 1)
      }
    return [...m.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 7)
  }, [issues])

  const statusSegments = useMemo(() => [
    { label: 'Unsafe', value: filtered.filter((d) => d.status === 'Unsafe').length, tone: 'danger' as const },
    { label: 'Resolved', value: filtered.filter((d) => d.status === 'Resolved').length, tone: 'info' as const },
  ], [filtered])

  const topUnits = useMemo(() => topCounts(issues, (d) => d.unit), [issues])
  // La API de defectos no trae conductor → en su lugar, camión vs trailer.
  const byKind = useMemo(() => {
    const trailers = issues.filter((d) => d.unit_kind === 'trailer').length
    const trucks = issues.length - trailers
    return [
      { label: 'Trailers', value: trailers },
      { label: 'Trucks', value: trucks },
    ].filter((x) => x.value > 0)
  }, [issues])

  // Tabla "Summary by unit": backlog de defectos ABIERTOS en vivo (Samsara +
  // CSV de empresas fuera del org). Independiente del rango del dashboard.
  const board = openDefs
  const boardFiltered = useMemo(() => {
    const uq = unit.trim().toLowerCase()
    return board.filter((d) =>
      (!company || d.company === company) &&
      (!uq || d.unit.toLowerCase().includes(uq)))
  }, [board, company, unit])
  const unitRows = useMemo(() => consolidate(boardFiltered), [boardFiltered])

  const sortedRows = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...unitRows].sort((a, b) => {
      if (sortKey === 'count') return (a.count - b.count) * dir || a.unit.localeCompare(b.unit)
      const av = sortKey === 'unit' ? a.unit : a.company
      const bv = sortKey === 'unit' ? b.unit : b.company
      return av.localeCompare(bv) * dir
    })
  }, [unitRows, sortKey, sortDir])

  const tableMatrix = useMemo((): Cell[][] => {
    const header = ['Unit', 'Type', 'Company', 'Status', 'Defects', 'Detail']
    const rows = sortedRows.map((r) => [
      r.unit, r.kind === 'trailer' ? 'trailer' : 'truck', r.company,
      statusSummary(r.status), r.count, r.defects.join(' | '),
    ])
    return [header, ...rows]
  }, [sortedRows])

  function setSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir(key === 'count' ? 'desc' : 'asc') }
  }
  function arrow(key: SortKey) {
    if (key !== sortKey) return ''
    return sortDir === 'asc' ? ' ▲' : ' ▼'
  }
  function toggle(unitKey: string) {
    setExpanded((prev) => {
      const n = new Set(prev)
      if (n.has(unitKey)) n.delete(unitKey)
      else n.add(unitKey)
      return n
    })
  }
  async function handleCopy() {
    await copyMatrix(tableMatrix)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  function clearFilters() {
    setCompany(''); setStatus(''); setUnit('')
  }
  const hasFilter = company || status || unit

  return (
    <div className="page page-wide">
      {fetching && <div className="loadbar" aria-hidden="true" />}
      <div className="page-head">
        <div>
          <h1>Defects</h1>
          <p className="page-sub">
            Defects reported in DVIRs (live from Samsara) — incidents, trend
            and types over the selected range.
          </p>
        </div>
        <div className="head-actions">
          <button className="btn btn-ghost" onClick={refresh}
            disabled={fetching} title="Refresh from Samsara">
            <svg className={fetching ? 'spin' : ''} viewBox="0 0 24 24"
              width="15" height="15" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
            </svg>
            {fetching ? 'Refreshing…' : 'Refresh'}
          </button>
          <button className="btn btn-ghost" onClick={handleCopy}>
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
          <button className="btn btn-primary"
            onClick={() => downloadCSV(tableMatrix)}>
            Export CSV
          </button>
        </div>
      </div>

      {error && <div className="banner error"><span>{error}</span></div>}

      {/* Rango + filtros */}
      <div className="card">
        <div className="card-body filters-row">
          <div className="company-tabs" role="tablist" aria-label="Date range">
            {RANGES.map((r) => (
              <button key={r.days}
                className={`tab-btn ${rangeDays === r.days ? 'active' : ''}`}
                onClick={() => setRangeDays(r.days)}>{r.label}</button>
            ))}
          </div>
          <span className="head-spacer" />
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="Unsafe">Open</option>
            <option value="Resolved">Resolved</option>
          </select>
          <input className="cell-input" placeholder="Unit…"
            value={unit} onChange={(e) => setUnit(e.target.value)} />
          {hasFilter && (
            <button className="btn btn-ghost" onClick={clearFilters}>
              Clear
            </button>
          )}
        </div>
      </div>

      {/* KPIs */}
      {dashLoading ? (
        <div className="kpi-row">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="skel-kpi" h={86} />
          ))}
        </div>
      ) : (
        <div className="kpi-row">
          <StatCard label="Records" value={kpis.total} tone="accent"
            sub={hasFilter ? 'filtered' : 'total'} />
          <StatCard label="Unsafe (open)" value={kpis.unsafe} tone="danger" />
          <StatCard label="Resolved" value={kpis.resolved} tone="info" />
          <StatCard label="% resolved"
            value={kpis.pct === null ? '—' : `${kpis.pct}%`} tone="warn"
            sub="of incidents" />
          <StatCard label="Most affected unit"
            value={kpis.topUnit?.label ?? '—'} tone="default"
            sub={kpis.topUnit ? `${kpis.topUnit.value} incidents` : ''} />
        </div>
      )}

      {/* Gráficos */}
      {dashLoading ? (
        <div className="defects-stack">
          <Skeleton className="skel-chart" h={150} />
          <Skeleton className="skel-chart" h={220} />
          <div className="defects-grid-3">
            <Skeleton className="skel-chart" h={200} />
            <Skeleton className="skel-chart" h={200} />
            <Skeleton className="skel-chart" h={200} />
          </div>
        </div>
      ) : (
      <div className="defects-stack">
        <section className="card">
          <div className="card-head"><h2>By status</h2></div>
          <div className="card-body">
            <StatusDonut segments={statusSegments} centerValue={kpis.total}
              centerLabel="records" />
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h2>Daily trend</h2></div>
          <div className="card-body">
            <DefectsTrendChart days={byDay} />
          </div>
        </section>

        <div className="defects-grid-3">
          <section className="card">
            <div className="card-head"><h2>By defect type</h2></div>
            <div className="card-body">
              <RankBars items={byCategory} tone="mix"
                emptyText="No classified types (excludes 'Other')." />
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Top units</h2>
              <span className="sub">click to filter</span>
            </div>
            <div className="card-body">
              <RankBars items={topUnits} tone="danger" onClick={setUnit}
                emptyText="No incidents." />
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>By unit type</h2>
            </div>
            <div className="card-body">
              <RankBars items={byKind} tone="accent"
                emptyText="No incidents." />
            </div>
          </section>
        </div>
      </div>
      )}

      {/* Resumen por unidad */}
      <section className="card">
        <div className="card-head">
          <h2>Summary by unit</h2>
          <span className="sub">{sortedRows.length} units</span>
          <span className="head-spacer" />
          <div className="company-tabs" role="tablist">
            <button
              className={`tab-btn ${company === 'CHASER' ? 'active' : ''}`}
              onClick={() => setCompany('CHASER')}>Chaser</button>
            <button
              className={`tab-btn ${company === 'MCC' ? 'active' : ''}`}
              onClick={() => setCompany('MCC')}>MCCI</button>
            <button
              className={`tab-btn ${company === '' ? 'active' : ''}`}
              onClick={() => setCompany('')}>All</button>
          </div>
          <button className="btn btn-ghost export-btn"
            disabled={sortedRows.length === 0}
            onClick={() => setListRows(sortedRows)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
            </svg>
            Export list
          </button>
          <button className="btn btn-ghost export-btn"
            disabled={sortedRows.length === 0}
            onClick={() => { setPicked(new Set()); setExportOpen(true) }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="M7 10l5 5 5-5" /><path d="M12 15V3" />
            </svg>
            Export report
          </button>
        </div>
        <div className="card-body">
          {boardLoading ? (
            <div className="skel-rows">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} h={34} />
              ))}
            </div>
          ) : sortedRows.length === 0 ? (
            <div className="empty mini"><p>No defects for these filters.</p></div>
          ) : (
            <div className="table-wrap">
              <table className="defects-table">
                <thead>
                  <tr>
                    <th className="sortable" onClick={() => setSort('unit')}>
                      Unit{arrow('unit')}
                    </th>
                    <th className="sortable" onClick={() => setSort('company')}>
                      Company{arrow('company')}
                    </th>
                    <th>Status</th>
                    <th className="num sortable" onClick={() => setSort('count')}>
                      Defects{arrow('count')}
                    </th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((r) => {
                    const open = expanded.has(r.unit)
                    const shown = r.defects.slice(0, 3)
                    return (
                      <Fragment key={r.unit}>
                        <tr
                          className={`unit-row${open ? ' open' : ''}`}
                          onClick={() => toggle(r.unit)}
                        >
                          <td>
                            <span className="unit-cell">
                              <svg className="row-chevron" viewBox="0 0 24 24"
                                fill="none" stroke="currentColor" strokeWidth="2.4"
                                strokeLinecap="round" strokeLinejoin="round">
                                <path d="m9 18 6-6-6-6" />
                              </svg>
                              <span>
                                <span className="unit-code">{r.unit}</span>
                                <span className="unit-kind">
                                  {r.kind === 'trailer' ? 'trailer' : 'truck'}
                                </span>
                              </span>
                            </span>
                          </td>
                          <td>{r.company}</td>
                          <td>
                            <span className="status-cell">
                              {r.status.Open ? (
                                <span className="status-pill open">
                                  Open <em>{r.status.Open}</em>
                                </span>
                              ) : (
                                STATUSES.map((s) => (r.status[s] ? (
                                  <span key={s}
                                    className={`status-pill ${statusTone(s)}`}>
                                    {s} <em>{r.status[s]}</em>
                                  </span>
                                ) : null))
                              )}
                            </span>
                          </td>
                          <td className="num strong">{r.count}</td>
                          <td className="defect-detail">
                            <ul className="defect-items">
                              {shown.map((it, k) => <li key={k}>{it}</li>)}
                            </ul>
                            {r.defects.length > 3 && (
                              <span className="more-hint">
                                +{r.defects.length - 3} more · click to view
                              </span>
                            )}
                          </td>
                        </tr>
                        {open && (
                          <tr className="unit-detail-row">
                            <td colSpan={5}>
                              <UnitPanel row={r}
                                onDownload={() => setReportRows([r])} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {exportOpen && (
        <Modal title="Export defect reports (PDF)"
          width={560} onClose={() => setExportOpen(false)}>
          <ExportPicker
            rows={sortedRows}
            picked={picked}
            setPicked={setPicked}
            onExport={(rows) => {
              setExportOpen(false)
              setReportRows(rows)
            }}
          />
        </Modal>
      )}

      {reportRows && (
        <UnitReport rows={reportRows} onClose={() => setReportRows(null)} />
      )}

      {listRows && (
        <SummaryReport
          rows={listRows}
          scope={company === 'MCC' ? 'MCCI'
            : company === 'CHASER' ? 'Chaser' : 'All companies'}
          onClose={() => setListRows(null)}
        />
      )}
    </div>
  )
}

function ExportPicker({ rows, picked, setPicked, onExport }: {
  rows: UnitRow[]
  picked: Set<string>
  setPicked: (s: Set<string>) => void
  onExport: (rows: UnitRow[]) => void
}) {
  const allOn = rows.length > 0 && rows.every((r) => picked.has(r.unit))
  function toggle(unit: string) {
    const n = new Set(picked)
    if (n.has(unit)) n.delete(unit)
    else n.add(unit)
    setPicked(n)
  }
  function toggleAll() {
    setPicked(allOn ? new Set() : new Set(rows.map((r) => r.unit)))
  }
  const chosen = rows.filter((r) => picked.has(r.unit))

  return (
    <div className="export-picker">
      <div className="ep-head">
        <label className="ep-all">
          <input type="checkbox" checked={allOn} onChange={toggleAll} />
          <span>{allOn ? 'Deselect all' : 'Select all'}</span>
        </label>
        <span className="ep-count">{chosen.length} selected</span>
      </div>
      <ul className="ep-list">
        {rows.map((r) => (
          <li key={r.unit}>
            <label className="ep-item">
              <input type="checkbox" checked={picked.has(r.unit)}
                onChange={() => toggle(r.unit)} />
              <span className="ep-unit">{r.unit}</span>
              <span className="ep-kind">
                {r.kind === 'trailer' ? 'trailer' : 'truck'}
              </span>
              <span className="ep-co">{r.company}</span>
              <span className="ep-defs">{r.count} defects</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="ep-foot">
        <button className="btn btn-primary" disabled={chosen.length === 0}
          onClick={() => onExport(chosen)}>
          Download PDF ({chosen.length})
        </button>
      </div>
    </div>
  )
}
