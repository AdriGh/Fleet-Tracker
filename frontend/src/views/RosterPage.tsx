import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listRoster, setDriverEmail, syncDriverContacts } from '../api'
import { notifyOk, notifyErr } from '../toast'
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

// --- Enmascarado de datos sensibles (PII) ------------------------------
// Por defecto el Roster muestra los datos enmascarados; el botón "Reveal"
// los destapa solo para la sesión. El default se configura en Settings
// (localStorage 'ft-roster-mask').

function maskEmail(e: string): string {
  if (!e) return '—'
  const at = e.indexOf('@')
  if (at < 1) return `${e[0] ?? ''}•••`
  const dom = e.slice(at + 1)
  const dot = dom.lastIndexOf('.')
  const tld = dot > 0 ? dom.slice(dot) : ''
  return `${e[0]}•••@${dom[0] ?? ''}•••${tld}`
}

function maskPhone(p: string): string {
  const d = p.replace(/\D/g, '')
  if (!d) return '—'
  return `(•••) •••-${d.slice(-4)}`
}

function maskTail(s: string): string {
  if (!s) return '—'
  return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`
}

export function maskDefault(): boolean {
  return localStorage.getItem('ft-roster-mask') !== '0'
}

type Props = {
  /** Render compacto para incrustar dentro de Settings (sin page chrome). */
  embedded?: boolean
}

export default function RosterPage({ embedded = false }: Props) {
  const [company, setCompany] = useState('')
  const [q, setQ] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [editVal, setEditVal] = useState('')
  const [savingEmail, setSavingEmail] = useState(false)
  const [masked, setMasked] = useState(maskDefault)

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
        d.email.toLowerCase().includes(s) ||
        d.username.toLowerCase().includes(s) ||
        d.license_number.toLowerCase().includes(s)))
  }, [drivers, company, q])

  const matrix = useMemo((): Cell[][] => {
    const header = ['Driver', 'Company', 'Email', 'Phone', 'License', 'State',
      'Username']
    const rows = filtered.map((d) => [
      d.name, d.company, d.email, d.phone, d.license_number, d.license_state,
      d.username,
    ])
    return [header, ...rows]
  }, [filtered])

  async function saveEmail(name: string) {
    setSavingEmail(true)
    try {
      await setDriverEmail(name, editVal.trim())
      await rosterQuery.refetch()
      setEditId(null)
      notifyOk('Email saved', name)
    } catch (e) {
      notifyErr('Couldn\'t save the email', e)
    } finally {
      setSavingEmail(false)
    }
  }

  async function sync() {
    setSyncing(true)
    setSyncMsg('')
    try {
      const r = await syncDriverContacts()
      await rosterQuery.refetch()
      setSyncMsg(`Synced ${r.with_email} emails`)
      setTimeout(() => setSyncMsg(''), 3000)
      notifyOk('Emails synced', `${r.with_email} with email`)
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : 'Sync failed')
      notifyErr('Sync failed', e)
    } finally {
      setSyncing(false)
    }
  }

  const actions = (
    <div className="head-actions">
      {syncMsg && <span className="sync-msg">{syncMsg}</span>}
      <button
        className={`btn btn-ghost ${masked ? '' : 'revealed'}`}
        onClick={() => setMasked((m) => !m)}
        title={masked
          ? 'Reveal emails, phones and licenses'
          : 'Mask sensitive data'}
      >
        {masked ? (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            strokeLinejoin="round">
            <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            strokeLinejoin="round">
            <path d="M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2" />
            <path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c6 0 10 7 10 7a18 18 0 0 1-2.2 3.2M6.1 6.1A17.9 17.9 0 0 0 2 11s4 7 10 7a10.7 10.7 0 0 0 4-.8" />
          </svg>
        )}
        {masked ? 'Reveal' : 'Mask'}
      </button>
      <button className="btn btn-ghost" onClick={sync} disabled={syncing}
        title="Pull driver emails from the Driver info sheet">
        <svg className={syncing ? 'spin' : ''} viewBox="0 0 24 24"
          width="15" height="15" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
        </svg>
        {syncing ? 'Syncing…' : 'Sync emails'}
      </button>
      <button className="btn btn-ghost" onClick={() => rosterQuery.refetch()}
        disabled={fetching} title="Refresh">
        <svg className={fetching ? 'spin' : ''} viewBox="0 0 24 24"
          width="15" height="15" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
        </svg>
        {fetching ? 'Refreshing…' : 'Refresh'}
      </button>
      <button className="btn btn-primary"
        disabled={filtered.length === 0 || masked}
        title={masked ? 'Reveal first to export personal data' : undefined}
        onClick={() => downloadCSV(matrix)}>
        Export CSV
      </button>
    </div>
  )

  const kpiBlock = loading ? (
    <div className="kpi-row">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="skel-kpi" h={86} />
      ))}
    </div>
  ) : (
    <div className="kpi-row">
      <StatCard label="Active drivers" value={kpis.total} tone="accent" />
      <StatCard label="Company A" value={kpis.chaser} tone="info" />
      <StatCard label="Company B" value={kpis.mcc} tone="default" />
    </div>
  )

  const filterBlock = (
    <div className="filters-row">
      <div className="company-tabs" role="tablist">
        <button className={`tab-btn ${company === 'CHASER' ? 'active' : ''}`}
          onClick={() => setCompany('CHASER')}>Company A</button>
        <button className={`tab-btn ${company === 'MCC' ? 'active' : ''}`}
          onClick={() => setCompany('MCC')}>Company B</button>
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
  )

  const tableBlock = loading ? (
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
            <th>Email</th>
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
              <td className="mono email-cell">
                {masked ? (
                  <span className="pii-masked" title="Reveal first to edit">
                    {maskEmail(d.email)}
                  </span>
                ) : editId === d.id ? (
                  <span className="email-edit">
                    <input className="cell-input" autoFocus
                      value={editVal} placeholder="email@…"
                      onChange={(e) => setEditVal(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveEmail(d.name)
                        if (e.key === 'Escape') setEditId(null)
                      }} />
                    <button className="btn btn-ghost btn-xs"
                      disabled={savingEmail}
                      onClick={() => saveEmail(d.name)}>Save</button>
                    <button className="btn btn-ghost btn-xs"
                      onClick={() => setEditId(null)}>✕</button>
                  </span>
                ) : (
                  <button className="email-show"
                    title="Click to edit"
                    onClick={() => { setEditId(d.id); setEditVal(d.email) }}>
                    {d.email || <span className="muted">+ add</span>}
                  </button>
                )}
              </td>
              <td>
                {masked
                  ? <span className="pii-masked">{maskPhone(d.phone)}</span>
                  : fmtPhone(d.phone)}
              </td>
              <td className="mono vin">
                {masked
                  ? <span className="pii-masked">{maskTail(d.license_number)}</span>
                  : (d.license_number || '—')}
              </td>
              <td>{d.license_state || '—'}</td>
              <td className="mono">
                {masked
                  ? <span className="pii-masked">{maskTail(d.username)}</span>
                  : (d.username || '—')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  // ----- Incrustado en Settings (sin page chrome ni cards anidadas) -----
  if (embedded) {
    return (
      <div className="roster-embed">
        {fetching && <div className="loadbar" aria-hidden="true" />}
        {error && <div className="banner error"><span>{error}</span></div>}
        <div className="roster-embed-bar">{actions}</div>
        {kpiBlock}
        {filterBlock}
        <div className="archive-listhead">
          <h3 className="settings-sub-h">
            Drivers ({filtered.length} of {drivers.length})
          </h3>
        </div>
        {tableBlock}
      </div>
    )
  }

  // ----- Página completa (standalone) -----
  return (
    <div className="page page-wide">
      {fetching && <div className="loadbar" aria-hidden="true" />}
      <div className="page-head">
        <div>
          <h1>Roster</h1>
          <p className="page-sub">
            Active drivers across all companies.
            {masked && ' Sensitive data is masked.'}
          </p>
        </div>
        {actions}
      </div>

      {error && <div className="banner error"><span>{error}</span></div>}

      {kpiBlock}

      <div className="card">
        <div className="card-body">{filterBlock}</div>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Drivers</h2>
          <span className="sub">{filtered.length} of {drivers.length}</span>
        </div>
        <div className="card-body">{tableBlock}</div>
      </section>
    </div>
  )
}
