import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  listPM, setPMExcluded, setPMOverride, type PMUnit,
} from '../api'
import Skeleton from '../components/Skeleton'
import StatCard from '../components/StatCard'
import PieChart from '../components/PieChart'
import IconButton from '../components/IconButton'
import { terminalOf, terminalsPresent, TERMINAL_LABEL } from '../terminal'

// Marca discreta para valores ajustados a mano (ícono lápiz con tooltip).
function EditedFlag({ title }: { title: string }) {
  return (
    <span className="pm-flag" title={title} aria-label={title}>
      <svg viewBox="0 0 24 24" width="11" height="11" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        strokeLinejoin="round">
        <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
    </span>
  )
}

type Cell = string | number

function downloadCSV(m: Cell[][], name = 'pm-tracker.csv') {
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

const nf = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US')

// Umbral fallback (millas restantes) para considerar un PM "próximo".
// El valor real viene del API (configurable por empresa, fase G7).
const UPCOMING_MILES = 5500

type Tone = 'danger' | 'warn' | 'ok' | 'muted'
function pmStatus(u: PMUnit,
                  upcoming: number): { label: string; tone: Tone } {
  if (u.last_pm_miles == null) return { label: 'Never Performed', tone: 'muted' }
  if (u.remaining == null) return { label: 'No Odometer', tone: 'muted' }
  if (u.remaining < 0) return { label: 'Overdue', tone: 'danger' }
  if (u.remaining < upcoming) return { label: 'Upcoming', tone: 'warn' }
  return { label: 'On Track', tone: 'ok' }
}

export default function PMPage() {
  const [q, setQ] = useState('')
  const [terminal, setTerminal] = useState('')
  const [editUnit, setEditUnit] = useState<string | null>(null)
  const [editCurrent, setEditCurrent] = useState('')
  const [editLastPM, setEditLastPM] = useState('')
  const [busy, setBusy] = useState(false)
  const [showExcluded, setShowExcluded] = useState(false)
  const pmQuery = useQuery({ queryKey: ['pm'], queryFn: listPM })
  const data = pmQuery.data
  const units = data?.units ?? []
  const excludedUnits = data?.excluded ?? []
  const interval = data?.interval ?? 20000
  const upcoming = data?.upcoming_miles ?? UPCOMING_MILES

  function startEdit(u: PMUnit) {
    setEditUnit(u.unit)
    setEditCurrent(u.current_overridden ? String(u.current_miles ?? '') : '')
    setEditLastPM(u.last_pm_overridden ? String(u.last_pm_miles ?? '') : '')
  }

  async function saveEdit(u: PMUnit) {
    setBusy(true)
    try {
      const cur = editCurrent.trim()
      const lp = editLastPM.trim()
      await setPMOverride(u.unit, 'current_miles', cur === '' ? null : Number(cur))
      await setPMOverride(u.unit, 'last_pm_miles', lp === '' ? null : Number(lp))
      await pmQuery.refetch()
      setEditUnit(null)
    } finally {
      setBusy(false)
    }
  }

  async function exclude(unit: string, excluded: boolean) {
    setBusy(true)
    try {
      await setPMExcluded(unit, excluded)
      await pmQuery.refetch()
    } finally {
      setBusy(false)
    }
  }
  const loading = pmQuery.isPending
  const fetching = pmQuery.isFetching
  const error = pmQuery.error
    ? (pmQuery.error instanceof Error ? pmQuery.error.message : 'Error')
    : null

  const kpis = useMemo(() => ({
    tracked: units.length,
    overdue: units.filter((u) => u.remaining != null && u.remaining < 0).length,
    dueSoon: units.filter((u) =>
      u.remaining != null && u.remaining >= 0
      && u.remaining < upcoming).length,
  }), [units, upcoming])

  const dist = useMemo(() => {
    let onTrack = 0, overdue = 0, upcomingN = 0, never = 0, unknown = 0
    for (const u of units) {
      if (u.last_pm_miles == null) never++
      else if (u.remaining == null) unknown++
      else if (u.remaining < 0) overdue++
      else if (u.remaining < upcoming) upcomingN++
      else onTrack++
    }
    const out = [
      { label: 'On Track', value: onTrack, color: '#22c55e' },
      { label: 'Overdue', value: overdue, color: '#dc2626' },
      { label: 'Upcoming', value: upcomingN, color: '#f59e0b' },
      { label: 'Never Performed', value: never, color: '#94a3b8' },
    ]
    if (unknown) out.push({ label: 'No Odometer', value: unknown, color: '#cbd5e1' })
    return out
  }, [units, upcoming])

  const terminals = useMemo(() => terminalsPresent(units), [units])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    return units.filter((u) =>
      (!terminal || terminalOf(u.unit) === terminal) &&
      (!s || u.unit.toLowerCase().includes(s)
        || u.model.toLowerCase().includes(s)))
  }, [units, q, terminal])

  const matrix = useMemo((): Cell[][] => {
    const header = ['Unit', 'Model', 'Last PM', 'Last PM miles',
      'Current miles', 'Source', 'Next due', 'Remaining', 'Status']
    const rows = filtered.map((u) => [
      u.unit, u.model, u.last_pm_date ?? '', u.last_pm_miles ?? '',
      u.current_miles ?? '', u.current_source ?? '', u.next_due_miles ?? '',
      u.remaining ?? '', pmStatus(u, upcoming).label,
    ])
    return [header, ...rows]
  }, [filtered, upcoming])

  function bar(u: PMUnit) {
    if (u.last_pm_miles == null || u.current_miles == null) return null
    const used = u.current_miles - u.last_pm_miles
    const pct = Math.max(0, Math.min(used / interval, 1)) * 100
    const tone = pmStatus(u, upcoming).tone
    return (
      <div className="pm-bar" title={`${nf(used)} / ${nf(interval)} mi`}>
        <span className={`pm-bar-fill tone-${tone}`} style={{ width: `${pct}%` }} />
      </div>
    )
  }

  return (
    <div className="page page-wide">
      {fetching && <div className="loadbar" aria-hidden="true" />}
      <div className="page-head">
        <div>
          <h1>PM Tracker</h1>
          <p className="page-sub">
            Preventive maintenance every {nf(interval)} miles. Last PM from
            Fullbay, current odometer live from Samsara.
          </p>
        </div>
        <div className="head-actions">
          <button className="btn btn-ghost" onClick={() => pmQuery.refetch()}
            disabled={fetching} title="Refresh">
            <svg className={fetching ? 'spin' : ''} viewBox="0 0 24 24"
              width="15" height="15" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
            </svg>
            {fetching ? 'Refreshing…' : 'Refresh'}
          </button>
          <button className="btn btn-primary" disabled={filtered.length === 0}
            onClick={() => downloadCSV(matrix)}>
            Export CSV
          </button>
        </div>
      </div>

      {error && <div className="banner error"><span>{error}</span></div>}
      {data && !data.available && (
        <div className="banner warn">
          <span>No PM data. Drop the Fullbay report at
            {' '}<code>backend/pm.local.csv</code>.</span>
        </div>
      )}

      {loading ? (
        <div className="kpi-row">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="skel-kpi" h={86} />
          ))}
        </div>
      ) : (
        <div className="kpi-row">
          <StatCard label="Trucks tracked" value={kpis.tracked} tone="accent" />
          <StatCard label="Overdue" value={kpis.overdue} tone="danger" />
          <StatCard
            label={`Upcoming (<${(upcoming / 1000).toLocaleString('en-US')}k mi)`}
            value={kpis.dueSoon} tone="warn" />
        </div>
      )}

      {!loading && units.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>PM status</h2>
            <span className="sub">{units.length} trucks</span>
          </div>
          <div className="card-body">
            <PieChart data={dist} />
          </div>
        </section>
      )}

      <div className="card">
        <div className="card-body filters-row">
          {terminals.length > 1 && (
            <div className="company-tabs" role="tablist">
              <button className={`tab-btn ${terminal === '' ? 'active' : ''}`}
                onClick={() => setTerminal('')}>All terminals</button>
              {terminals.map((t) => (
                <button key={t}
                  className={`tab-btn ${terminal === t ? 'active' : ''}`}
                  onClick={() => setTerminal(t)}>{TERMINAL_LABEL[t]}</button>
              ))}
            </div>
          )}
          <span className="head-spacer" />
          <input className="cell-input" placeholder="Unit or model…"
            value={q} onChange={(e) => setQ(e.target.value)} />
          {(q || terminal) && (
            <button className="btn btn-ghost"
              onClick={() => { setQ(''); setTerminal('') }}>Clear</button>
          )}
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Preventive maintenance</h2>
          <span className="sub">{filtered.length} of {units.length}</span>
        </div>
        <div className="card-body">
          {loading ? (
            <div className="skel-rows">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} h={34} />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty mini"><p>No trucks for this search.</p></div>
          ) : (
            <div className="table-wrap">
              <table className="defects-table fleet-table pm-table">
                <thead>
                  <tr>
                    <th>Unit</th>
                    <th>Last PM</th>
                    <th className="num">Current</th>
                    <th className="num">Next due</th>
                    <th className="num">Remaining</th>
                    <th>Progress</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((u) => {
                    const st = pmStatus(u, upcoming)
                    return (
                      <tr key={u.unit}>
                        <td>
                          <span className="unit-cell">
                            <span>
                              <span className="unit-code">{u.unit}</span>
                              <span className="unit-kind">{u.model}</span>
                            </span>
                          </span>
                        </td>
                        <td>
                          {editUnit === u.unit ? (
                            <span className="pm-edit">
                              <span className="pm-sub">{u.last_pm_date || '—'} ·</span>
                              <input className="cell-input pm-input"
                                value={editLastPM} placeholder="last PM mi"
                                onChange={(e) => setEditLastPM(e.target.value)} />
                            </span>
                          ) : u.last_pm_date ? (
                            <>
                              {u.last_pm_date}
                              <span className="pm-sub"> · {nf(u.last_pm_miles)} mi</span>
                              {u.last_pm_overridden && (
                                <EditedFlag title="Último PM ajustado manualmente" />
                              )}
                            </>
                          ) : <span className="muted">—</span>}
                        </td>
                        <td className="num">
                          {editUnit === u.unit ? (
                            <input className="cell-input pm-input"
                              value={editCurrent}
                              placeholder={String(u.current_miles ?? '')}
                              onChange={(e) => setEditCurrent(e.target.value)} />
                          ) : (
                            <>
                              {nf(u.current_miles)}
                              {u.current_source === 'manual' ? (
                                <EditedFlag title="Millaje actual ajustado manualmente" />
                              ) : u.current_source && u.current_source !== 'obd' ? (
                                <span className="pm-src">{' '}{u.current_source}</span>
                              ) : null}
                            </>
                          )}
                        </td>
                        <td className="num">{nf(u.next_due_miles)}</td>
                        <td className={`num pm-remain tone-${st.tone}`}>
                          {u.remaining == null ? '—'
                            : u.remaining < 0 ? `${nf(u.remaining)}`
                              : `+${nf(u.remaining)}`}
                        </td>
                        <td className="pm-bar-cell">{bar(u)}</td>
                        <td>
                          <span className={`pm-pill tone-${st.tone}`}>
                            {st.label}
                          </span>
                        </td>
                        <td className="num pm-actions">
                          <span className="row-actions">
                            {editUnit === u.unit ? (
                              <>
                                <IconButton name="save" title="Guardar"
                                  disabled={busy} onClick={() => saveEdit(u)} />
                                <IconButton name="cancel" title="Cancelar"
                                  onClick={() => setEditUnit(null)} />
                              </>
                            ) : (
                              <>
                                <IconButton name="edit" title="Editar millaje"
                                  onClick={() => startEdit(u)} />
                                <IconButton name="exclude" title="Excluir del PM"
                                  danger disabled={busy}
                                  onClick={() => exclude(u.unit, true)} />
                              </>
                            )}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {excludedUnits.length > 0 && (
            <div className="pm-excluded">
              <button className="pm-excluded-head"
                onClick={() => setShowExcluded((s) => !s)}>
                <svg className={`collapse-chevron ${showExcluded ? 'open' : ''}`}
                  viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m9 18 6-6-6-6" />
                </svg>
                Excluded units ({excludedUnits.length})
              </button>
              {showExcluded && (
                <ul className="pm-excluded-list">
                  {excludedUnits.map((e) => (
                    <li key={e.unit}>
                      <span className="unit-code">{e.unit}</span>
                      <span className="pm-sub">{e.model}</span>
                      <IconButton name="include" title="Volver a incluir"
                        disabled={busy} onClick={() => exclude(e.unit, false)} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
