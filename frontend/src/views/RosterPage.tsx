import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listRoster } from '../api'
import Skeleton from '../components/Skeleton'
import StatCard from '../components/StatCard'

type Cell = string | number

function downloadCSV(m: Cell[][], name = 'roster.csv') {
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

function fmtPhone(p: string): string {
  const d = p.replace(/\D/g, '')
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
  return p || '—'
}

export default function RosterPage() {
  const [company, setCompany] = useState('')
  const [q, setQ] = useState('')

  const rosterQuery = useQuery({ queryKey: ['roster'], queryFn: listRoster })
  const drivers = rosterQuery.data ?? []
  const loading = rosterQuery.isPending
  const fetching = rosterQuery.isFetching
  const error = rosterQuery.error
    ? (rosterQuery.error instanceof Error ? rosterQuery.error.message : 'Error')
    : null

  const kpis = useMemo(() => ({
    total: drivers.length,
    chaser: drivers.filter((d) => d.company === 'CHASER').length,
    mcc: drivers.filter((d) => d.company === 'MCC').length,
  }), [drivers])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    return drivers.filter((d) =>
      (!company || d.company === company) &&
      (!s ||
        d.name.toLowerCase().includes(s) ||
        d.phone.includes(s) ||
        d.username.toLowerCase().includes(s) ||
        d.license_number.toLowerCase().includes(s)))
  }, [drivers, company, q])

  const matrix = useMemo((): Cell[][] => {
    const header = ['Driver', 'Company', 'Phone', 'License', 'State', 'Username']
    const rows = filtered.map((d) => [
      d.name, d.company, d.phone, d.license_number, d.license_state, d.username,
    ])
    return [header, ...rows]
  }, [filtered])

  return (
    <div className="page page-wide">
      {fetching && <div className="loadbar" aria-hidden="true" />}
      <div className="page-head">
        <div>
          <h1>Roster</h1>
          <p className="page-sub">
            Active drivers across Chaser and MCC (live from Samsara).
          </p>
        </div>
        <div className="head-actions">
          <button className="btn btn-ghost" onClick={() => rosterQuery.refetch()}
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

      {loading ? (
        <div className="kpi-row">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="skel-kpi" h={86} />
          ))}
        </div>
      ) : (
        <div className="kpi-row">
          <StatCard label="Active drivers" value={kpis.total} tone="accent" />
          <StatCard label="Chaser" value={kpis.chaser} tone="info" />
          <StatCard label="MCC" value={kpis.mcc} tone="default" />
        </div>
      )}

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
          <span className="head-spacer" />
          <input className="cell-input" placeholder="Name, phone, license…"
            value={q} onChange={(e) => setQ(e.target.value)} />
          {(company || q) && (
            <button className="btn btn-ghost"
              onClick={() => { setCompany(''); setQ('') }}>Clear</button>
          )}
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Drivers</h2>
          <span className="sub">{filtered.length} of {drivers.length}</span>
        </div>
        <div className="card-body">
          {loading ? (
            <div className="skel-rows">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} h={32} />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty mini"><p>No drivers for these filters.</p></div>
          ) : (
            <div className="table-wrap">
              <table className="defects-table fleet-table">
                <thead>
                  <tr>
                    <th>Driver</th>
                    <th>Company</th>
                    <th>Phone</th>
                    <th>License</th>
                    <th>State</th>
                    <th>Username</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((d) => (
                    <tr key={d.id}>
                      <td className="unit-code">{d.name}</td>
                      <td>{d.company}</td>
                      <td>{fmtPhone(d.phone)}</td>
                      <td className="mono vin">{d.license_number || '—'}</td>
                      <td>{d.license_state || '—'}</td>
                      <td className="mono">{d.username || '—'}</td>
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
