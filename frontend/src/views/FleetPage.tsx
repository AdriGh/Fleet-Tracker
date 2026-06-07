import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fleetArchive, listFleet } from '../api'
import Skeleton from '../components/Skeleton'
import StatCard from '../components/StatCard'

type SortKey = 'unit' | 'open'
type Cell = string | number

function downloadCSV(m: Cell[][], name = 'fleet.csv') {
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

export default function FleetPage() {
  const qc = useQueryClient()
  const [company, setCompany] = useState('')
  const [kind, setKind] = useState('')
  const [q, setQ] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('unit')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [busyId, setBusyId] = useState<string | null>(null)

  const fleetQuery = useQuery({ queryKey: ['fleet'], queryFn: listFleet })
  const units = fleetQuery.data ?? []
  const loading = fleetQuery.isPending
  const fetching = fleetQuery.isFetching
  const error = fleetQuery.error
    ? (fleetQuery.error instanceof Error ? fleetQuery.error.message : 'Error')
    : null
  async function archive(id: string) {
    setBusyId(id)
    try {
      await fleetArchive(id, 'archive')
      await qc.invalidateQueries({ queryKey: ['fleet'] })
    } finally {
      setBusyId(null)
    }
  }

  const kpis = useMemo(() => {
    const trucks = units.filter((u) => u.kind === 'truck').length
    return {
      total: units.length,
      trucks,
      trailers: units.length - trucks,
      withDefects: units.filter((u) => u.open_defects > 0).length,
    }
  }, [units])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    return units.filter((u) =>
      !u.archived &&
      (!company || u.company === company) &&
      (!kind || u.kind === kind) &&
      (!s ||
        u.unit.toLowerCase().includes(s) ||
        u.vin.toLowerCase().includes(s) ||
        u.plate.toLowerCase().includes(s) ||
        `${u.make} ${u.model}`.toLowerCase().includes(s)))
  }, [units, company, kind, q])

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      if (sortKey === 'open') {
        return (a.open_defects - b.open_defects) * dir
          || a.unit.localeCompare(b.unit)
      }
      return a.unit.localeCompare(b.unit) * dir
    })
  }, [filtered, sortKey, sortDir])

  function setSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir(key === 'open' ? 'desc' : 'asc') }
  }
  function arrow(key: SortKey) {
    if (key !== sortKey) return ''
    return sortDir === 'asc' ? ' ▲' : ' ▼'
  }

  const matrix = useMemo((): Cell[][] => {
    const header = ['Unit', 'Type', 'Company', 'Make', 'Model', 'Year',
      'VIN', 'Plate', 'Open defects']
    const rows = sorted.map((u) => [
      u.unit, u.kind, u.company, u.make, u.model, u.year, u.vin, u.plate,
      u.open_defects,
    ])
    return [header, ...rows]
  }, [sorted])

  const hasFilter = company || kind || q

  return (
    <div className="page page-wide">
      {fetching && <div className="loadbar" aria-hidden="true" />}
      <div className="page-head">
        <div>
          <h1>Fleet</h1>
          <p className="page-sub">
            Every unit across Chaser and MCC (live from Samsara) — type,
            details and open defects.
          </p>
        </div>
        <div className="head-actions">
          <button className="btn btn-ghost" onClick={() => fleetQuery.refetch()}
            disabled={fetching} title="Refresh">
            <svg className={fetching ? 'spin' : ''} viewBox="0 0 24 24"
              width="15" height="15" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
            </svg>
            {fetching ? 'Refreshing…' : 'Refresh'}
          </button>
          <button className="btn btn-primary" disabled={sorted.length === 0}
            onClick={() => downloadCSV(matrix)}>
            Export CSV
          </button>
        </div>
      </div>

      {error && <div className="banner error"><span>{error}</span></div>}

      {/* KPIs */}
      {loading ? (
        <div className="kpi-row">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="skel-kpi" h={86} />
          ))}
        </div>
      ) : (
        <div className="kpi-row">
          <StatCard label="Total units" value={kpis.total} tone="accent" />
          <StatCard label="Trucks" value={kpis.trucks} tone="info" />
          <StatCard label="Trailers" value={kpis.trailers} tone="default" />
          <StatCard label="With open defects" value={kpis.withDefects}
            tone="danger" />
        </div>
      )}

      {/* Filtros */}
      <div className="card">
        <div className="card-body filters-row">
          <div className="company-tabs" role="tablist">
            <button className={`tab-btn ${company === 'CHASER' ? 'active' : ''}`}
              onClick={() => setCompany('CHASER')}>Chaser</button>
            <button className={`tab-btn ${company === 'MCC' ? 'active' : ''}`}
              onClick={() => setCompany('MCC')}>MCCI</button>
            <button className={`tab-btn ${company === '' ? 'active' : ''}`}
              onClick={() => setCompany('')}>All</button>
          </div>
          <div className="company-tabs" role="tablist">
            <button className={`tab-btn ${kind === '' ? 'active' : ''}`}
              onClick={() => setKind('')}>All</button>
            <button className={`tab-btn ${kind === 'truck' ? 'active' : ''}`}
              onClick={() => setKind('truck')}>Trucks</button>
            <button className={`tab-btn ${kind === 'trailer' ? 'active' : ''}`}
              onClick={() => setKind('trailer')}>Trailers</button>
          </div>
          <span className="head-spacer" />
          <input className="cell-input" placeholder="Unit, VIN, plate, make…"
            value={q} onChange={(e) => setQ(e.target.value)} />
          {hasFilter && (
            <button className="btn btn-ghost"
              onClick={() => { setCompany(''); setKind(''); setQ('') }}>
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Tabla */}
      <section className="card">
        <div className="card-head">
          <h2>Units</h2>
          <span className="sub">{sorted.length} of {units.length}</span>
        </div>
        <div className="card-body">
          {loading ? (
            <div className="skel-rows">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} h={32} />
              ))}
            </div>
          ) : sorted.length === 0 ? (
            <div className="empty mini"><p>No units for these filters.</p></div>
          ) : (
            <div className="table-wrap">
              <table className="defects-table fleet-table">
                <thead>
                  <tr>
                    <th className="sortable" onClick={() => setSort('unit')}>
                      Unit{arrow('unit')}
                    </th>
                    <th>Company</th>
                    <th>Make / Model</th>
                    <th>Year</th>
                    <th>VIN</th>
                    <th>Plate</th>
                    <th className="num sortable" onClick={() => setSort('open')}>
                      Open{arrow('open')}
                    </th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <span className="unit-cell">
                          <span>
                            <span className="unit-code">{u.unit}</span>
                            <span className="unit-kind">
                              {u.asset_type === 'unpowered'
                                ? 'trailer (unpowered)' : u.kind}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td>{u.company}</td>
                      <td>{[u.make, u.model].filter(Boolean).join(' ') || '—'}</td>
                      <td>{u.year || '—'}</td>
                      <td className="mono vin">{u.vin || '—'}</td>
                      <td>{u.plate || '—'}</td>
                      <td className="num">
                        {u.open_defects > 0 ? (
                          <span className="status-pill open">
                            {u.open_defects}
                          </span>
                        ) : (
                          <span className="muted">0</span>
                        )}
                      </td>
                      <td className="num">
                        {busyId === u.id ? (
                          <span className="muted">…</span>
                        ) : (
                          <button className="btn btn-ghost btn-xs"
                            onClick={() => archive(u.id)}>
                            Archive
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
