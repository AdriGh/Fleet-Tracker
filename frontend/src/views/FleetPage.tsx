import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fleetArchive, listFleet, type FleetUnit } from '../api'
import Skeleton from '../components/Skeleton'
import StatCard from '../components/StatCard'
import UnitDrawer from '../components/UnitDrawer'
import IconButton from '../components/IconButton'
import AddUnitModal from '../components/AddUnitModal'
import { useTerminals } from '../terminal'

type SortKey = 'unit' | 'open'
type Cell = string | number

const TYPE_LABEL: Record<string, string> = {
  truck: 'Truck', trailer: 'Trailer', chassis: 'Chassis',
}

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

export default function FleetPage({ onOpenUnit }: {
  // H3: clic en la fila abre el perfil completo de la unidad.
  onOpenUnit?: (unit: string) => void
}) {
  const qc = useQueryClient()
  const [company, setCompany] = useState('')
  const [type, setType] = useState('')
  const [terminal, setTerminal] = useState('')
  const [q, setQ] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('unit')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [selected, setSelected] = useState<FleetUnit | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  const fleetQuery = useQuery({ queryKey: ['fleet'], queryFn: listFleet })
  const { terminalOf, labelOf, present } = useTerminals()
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

  const active = useMemo(() => units.filter((u) => !u.archived), [units])

  const kpis = useMemo(() => {
    const by = (t: string) => active.filter((u) => u.unit_type === t).length
    return {
      total: active.length,
      trucks: by('truck'),
      trailers: by('trailer'),
      chassis: by('chassis'),
      withDefects: active.filter((u) => u.open_defects > 0).length,
    }
  }, [active])

  // Terminales presentes en la empresa seleccionada (para los chips de filtro).
  const terminals = useMemo(
    () => present(active.filter((u) => !company || u.company === company)),
    [active, company, present])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    return active.filter((u) =>
      (!company || u.company === company) &&
      (!type || u.unit_type === type) &&
      (!terminal || terminalOf(u.unit, u.company) === terminal) &&
      (!s ||
        u.unit.toLowerCase().includes(s) ||
        u.vin.toLowerCase().includes(s) ||
        u.plate.toLowerCase().includes(s) ||
        `${u.make} ${u.model}`.toLowerCase().includes(s)))
  }, [active, company, type, terminal, q, terminalOf])

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
    const header = ['Unit', 'Type', 'Terminal', 'Company', 'Make', 'Model',
      'Year', 'VIN', 'Plate', 'Open defects']
    const rows = sorted.map((u) => [
      u.unit, u.unit_type, labelOf(terminalOf(u.unit, u.company)),
      u.company, u.make, u.model, u.year, u.vin, u.plate, u.open_defects,
    ])
    return [header, ...rows]
  }, [sorted, terminalOf, labelOf])

  const hasFilter = company || type || terminal || q

  return (
    <div className="page page-wide">
      {fetching && <div className="loadbar" aria-hidden="true" />}
      <div className="page-head">
        <div>
          <h1>Fleet</h1>
          <p className="page-sub">
            Every unit across all companies: type, details and open
            defects.
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
          <button className="btn btn-ghost" disabled={sorted.length === 0}
            onClick={() => downloadCSV(matrix)}>
            Export CSV
          </button>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            + Add Unit
          </button>
        </div>
      </div>

      {showAdd && (
        <AddUnitModal
          onClose={() => setShowAdd(false)}
          onSaved={async () => {
            setShowAdd(false)
            await qc.invalidateQueries({ queryKey: ['fleet'] })
          }}
        />
      )}

      {error && <div className="banner error"><span>{error}</span></div>}

      {/* KPIs */}
      {loading ? (
        <div className="kpi-row">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="skel-kpi" h={86} />
          ))}
        </div>
      ) : (
        <div className="kpi-row">
          <StatCard label="Total units" value={kpis.total} tone="accent" />
          <StatCard label="Trucks" value={kpis.trucks} tone="info" />
          <StatCard label="Trailers" value={kpis.trailers} tone="default" />
          <StatCard label="Chassis" value={kpis.chassis} tone="default" />
          <StatCard label="With open defects" value={kpis.withDefects}
            tone="danger" />
        </div>
      )}

      {/* Filtros */}
      <div className="card">
        <div className="card-body filters-row">
          <div className="company-tabs" role="tablist">
            <button className={`tab-btn ${type === '' ? 'active' : ''}`}
              onClick={() => setType('')}>All</button>
            <button className={`tab-btn ${type === 'truck' ? 'active' : ''}`}
              onClick={() => setType('truck')}>Trucks</button>
            <button className={`tab-btn ${type === 'trailer' ? 'active' : ''}`}
              onClick={() => setType('trailer')}>Trailers</button>
            <button className={`tab-btn ${type === 'chassis' ? 'active' : ''}`}
              onClick={() => setType('chassis')}>Chassis</button>
          </div>
          {terminals.length > 1 && (
            <div className="company-tabs" role="tablist">
              <button className={`tab-btn ${terminal === '' ? 'active' : ''}`}
                onClick={() => setTerminal('')}>All terminals</button>
              {terminals.map((t) => (
                <button key={t}
                  className={`tab-btn ${terminal === t ? 'active' : ''}`}
                  onClick={() => setTerminal(t)}>{labelOf(t)}</button>
              ))}
            </div>
          )}
          <span className="head-spacer" />
          <input className="cell-input" placeholder="Unit, VIN, plate, make…"
            value={q} onChange={(e) => setQ(e.target.value)} />
          {hasFilter && (
            <button className="btn btn-ghost"
              onClick={() => {
                setCompany(''); setType(''); setTerminal(''); setQ('')
              }}>
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Tabla */}
      <section className="card">
        <div className="card-head">
          <h2>Units</h2>
          <span className="sub">{sorted.length} of {active.length}</span>
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
                    <th>Type</th>
                    <th>Terminal</th>
                    <th>Make / Model</th>
                    <th className="num sortable" onClick={() => setSort('open')}>
                      Open{arrow('open')}
                    </th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((u) => {
                    const sub = u.vin || u.plate
                    const vehicle = [u.make, u.model, u.year]
                      .filter(Boolean).join(' ')
                    return (
                      <tr key={u.id} className="row-click"
                        onClick={() => (onOpenUnit
                          ? onOpenUnit(u.unit)
                          : setSelected(u))}>
                        <td>
                          <span className="unit-cell">
                            <span>
                              <span className="unit-code">{u.unit}</span>
                              {sub && (
                                <span className="unit-sub mono">{sub}</span>
                              )}
                            </span>
                          </span>
                        </td>
                        <td>
                          <span className={`type-badge t-${u.unit_type}`}>
                            {TYPE_LABEL[u.unit_type] ?? u.unit_type}
                          </span>
                        </td>
                        <td>{labelOf(terminalOf(u.unit, u.company))}</td>
                        <td>{vehicle || <span className="muted">—</span>}</td>
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
                            <IconButton name="archive" title="Archive unit"
                              onClick={(e) => {
                                e.stopPropagation(); archive(u.id)
                              }} />
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <UnitDrawer unit={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
