import { Fragment, useEffect, useMemo, useState } from 'react'
import { listDefects, listOpenDefects, type Defect } from '../api'
import StatCard from '../components/StatCard'
import RankBars from '../components/RankBars'
import StatusDonut from '../components/StatusDonut'
import DefectsTrendChart from '../components/DefectsTrendChart'
import TruckDiagram from '../components/TruckDiagram'
import { zoneOfCategory, type Kind, type ZoneId } from '../truckZones'

const STATUSES = ['Unsafe', 'Resolved', 'Safe']

// --- helpers ---------------------------------------------------------------
function items(detail: string): string[] {
  return (detail || '').split(';').map((s) => s.trim()).filter(Boolean)
}
function categoryOf(item: string): string {
  const i = item.indexOf(' - ')
  return (i > 0 ? item.slice(0, i) : 'Other').trim()
}
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

// Ruido del DVIR que no es un defecto real (re-reportes sin cambios).
const NOISE =
  /^(previous inspection|nothing\s*(has\s*)?chang|same(\s|$|,|\.)|no\s*chang|still the same|everything still|all (still )?the same|same as before|same issues|same status)/i
function bodyOf(item: string): string {
  const i = item.indexOf(' - ')
  return (i > 0 ? item.slice(i + 3) : item).trim()
}
function isNoise(item: string): boolean {
  return NOISE.test(bodyOf(item))
}
function normKey(item: string): string {
  return item.toLowerCase().replace(/\s+/g, ' ').replace(/[.,;]+$/, '').trim()
}

// Agrupa los defectos repetidos de una unidad y cuenta cuántas veces se reportó
// cada uno; además acumula la cantidad por zona del camión.
interface DefectGroup {
  text: string
  body: string
  category: string
  zone: ZoneId | null
  count: number
}
function analyzeUnit(records: Defect[], kind: Kind): {
  groups: DefectGroup[]
  zones: Record<string, number>
} {
  const map = new Map<string, DefectGroup>()
  const zones: Record<string, number> = {}
  for (const d of records)
    for (const raw of items(d.detail)) {
      if (isNoise(raw)) continue
      const cat = categoryOf(raw)
      const zone = zoneOfCategory(cat, kind)
      const key = normKey(raw)
      let g = map.get(key)
      if (!g) {
        g = { text: raw, body: bodyOf(raw), category: cat, zone, count: 0 }
        map.set(key, g)
      }
      g.count++
      if (zone) zones[zone] = (zones[zone] ?? 0) + 1
    }
  const groups = [...map.values()].sort(
    (a, b) => b.count - a.count || a.text.localeCompare(b.text),
  )
  return { groups, zones }
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
function UnitPanel({ row }: { row: UnitRow }) {
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

export default function DefectsPage() {
  const [all, setAll] = useState<Defect[]>([])
  const [openDefs, setOpenDefs] = useState<Defect[]>([])
  const [company, setCompany] = useState('')
  const [status, setStatus] = useState('')
  const [driver, setDriver] = useState('')
  const [unit, setUnit] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('count')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listDefects({})
      .then(setAll)
      .catch((e) => setError(e instanceof Error ? e.message : 'Error'))
    listOpenDefects().then(setOpenDefs).catch(() => {})
  }, [])

  const filtered = useMemo(() => {
    const dq = driver.trim().toLowerCase()
    const uq = unit.trim().toLowerCase()
    return all.filter((d) =>
      (!company || d.company === company) &&
      (!status || d.status === status) &&
      (!dq || d.driver.toLowerCase().includes(dq)) &&
      (!uq || d.unit.toLowerCase().includes(uq)))
  }, [all, company, status, driver, unit])

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
    { label: 'Safe', value: filtered.filter((d) => d.status === 'Safe').length, tone: 'ok' as const },
  ], [filtered])

  const topUnits = useMemo(() => topCounts(issues, (d) => d.unit), [issues])
  const topDrivers = useMemo(
    () => topCounts(issues, (d) => d.driver), [issues])

  // Tabla "defectos abiertos": CHASER del histórico (DB) + MCC abiertos (CSV).
  // Los MCC reemplazan al histórico; el resto queda como está.
  const board = useMemo(
    () => [...all.filter((d) => d.company !== 'MCC'), ...openDefs],
    [all, openDefs])
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
    setCompany(''); setStatus(''); setDriver(''); setUnit('')
  }
  const hasFilter = company || status || driver || unit

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Defects</h1>
          <p className="page-sub">
            Defects reported in DVIRs — incidents, trend and types.
          </p>
        </div>
        <div className="head-actions">
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

      {/* Filtros */}
      <div className="card">
        <div className="card-body filters-row">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <input className="cell-input" placeholder="Driver…"
            value={driver} onChange={(e) => setDriver(e.target.value)} />
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

      {/* Gráficos */}
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
              <h2>Top drivers</h2>
              <span className="sub">click to filter</span>
            </div>
            <div className="card-body">
              <RankBars items={topDrivers} tone="accent" onClick={setDriver}
                emptyText="No incidents." />
            </div>
          </section>
        </div>
      </div>

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
        </div>
        <div className="card-body">
          {sortedRows.length === 0 ? (
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
                              <UnitPanel row={r} />
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
    </div>
  )
}
