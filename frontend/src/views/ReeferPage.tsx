import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getReefer, getReeferHistory, reeferCommand, setReeferSetpoint,
  type ReeferPoint, type ReeferUnit,
} from '../api'
import { usePerms } from '../perms'
import { notifyErr, notifyOk } from '../toast'
import { Button } from '../components/ds'
import Skeleton from '../components/Skeleton'
import StatCard from '../components/StatCard'

const STROKE = {
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

// Desviación return vs setpoint -> tono del valor.
function devTone(u: ReeferUnit): string {
  if (u.setpoint_f == null || u.return_f == null) return ''
  const d = Math.abs(u.return_f - u.setpoint_f)
  if (d <= 2) return 'ok'
  if (d <= 5) return 'warn'
  return 'danger'
}

function fmtT(v: number | null): string {
  return v == null ? '—' : `${v.toFixed(1)}°F`
}

function agoOf(iso: string): string {
  if (!iso) return ''
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

function exportCsv(units: ReeferUnit[]) {
  const header = ['Unit', 'Company', 'Setpoint F', 'Return F', 'Supply F',
    'Ambient F', 'Run mode', 'State', 'Fuel %', 'Door', 'Alarms', 'Updated']
  const rows = units.map((u) => [
    u.unit, u.company, u.setpoint_f ?? '', u.return_f ?? '',
    u.supply_f ?? '', u.ambient_f ?? '', u.run_mode, u.state,
    u.fuel_pct ?? '', u.door,
    u.alarms.map((a) => `${a.code} ${a.description}`).join(' | '),
    u.updated,
  ])
  const csv = [header, ...rows]
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\n')
  const url = URL.createObjectURL(
    new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'cold-chain.csv'
  a.click()
  URL.revokeObjectURL(url)
}

// ----- Chart SVG 24 h (setpoint, return, supply) -------------------------
function ReeferChart({ points }: { points: ReeferPoint[] }) {
  const W = 660
  const H = 170
  const ML = 38
  const MB = 22
  const MT = 12

  const vals = points.flatMap((p) =>
    [p.setpoint_f, p.return_f, p.supply_f].filter(
      (v): v is number => v != null))
  if (!vals.length) {
    return <p className="ud-muted">No temperature data in this window.</p>
  }
  const min = Math.floor(Math.min(...vals) - 2)
  const max = Math.ceil(Math.max(...vals) + 2)
  const x = (i: number) =>
    ML + (i / Math.max(1, points.length - 1)) * (W - ML - 8)
  const y = (v: number) =>
    MT + (1 - (v - min) / Math.max(1, max - min)) * (H - MT - MB)
  const line = (key: 'setpoint_f' | 'return_f' | 'supply_f') =>
    points
      .map((p, i) => (p[key] == null ? null : `${x(i)},${y(p[key]!)}`))
      .filter(Boolean)
      .join(' ')
  const first = points[0]?.time
  const last = points[points.length - 1]?.time
  const hhmm = (iso?: string) =>
    iso ? new Date(iso).toLocaleTimeString('en-US',
      { hour: 'numeric', minute: '2-digit' }) : ''

  return (
    <div className="reefer-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label="Reefer temperature, last 24 hours">
        {[min, (min + max) / 2, max].map((v) => (
          <g key={v}>
            <line x1={ML} x2={W - 8} y1={y(v)} y2={y(v)}
              className="rc-grid" />
            <text x={ML - 6} y={y(v) + 3} className="rc-axis">
              {Math.round(v)}°
            </text>
          </g>
        ))}
        <polyline points={line('setpoint_f')} className="rc-set" />
        <polyline points={line('supply_f')} className="rc-supply" />
        <polyline points={line('return_f')} className="rc-return" />
        <text x={ML} y={H - 6} className="rc-axis">{hhmm(first)}</text>
        <text x={W - 8} y={H - 6} className="rc-axis" textAnchor="end">
          {hhmm(last)}
        </text>
      </svg>
      <div className="rc-legend">
        <span><i className="rc-dot rc-d-return" /> Return air</span>
        <span><i className="rc-dot rc-d-supply" /> Supply air</span>
        <span><i className="rc-dot rc-d-set" /> Setpoint</span>
      </div>
    </div>
  )
}

function HistoryRow({ unitId }: { unitId: string }) {
  const q = useQuery({
    queryKey: ['reefer-history', unitId],
    queryFn: () => getReeferHistory(unitId, 24),
  })
  if (q.isPending) return <Skeleton h={150} />
  if (q.error || !q.data) {
    return <p className="ud-muted">Could not load history.</p>
  }
  return <ReeferChart points={q.data.points} />
}

// ----- Control remoto OEM (Carrier Lynx, two-way) ------------------------
// Solo se renderiza para unidades 'lynx-' con tier >= Monitor and Control
// (u.can_control) y rol con scope fleet.edit. El backend re-gatea ambos.
function ReeferControl({ unit }: { unit: ReeferUnit }) {
  const qc = useQueryClient()
  const [sp, setSp] = useState(
    unit.setpoint_f != null ? String(unit.setpoint_f) : '')
  const refresh = () => qc.invalidateQueries({ queryKey: ['reefer'] })

  const setpointM = useMutation({
    mutationFn: () => setReeferSetpoint(unit.id, Number(sp)),
    onSuccess: (r) => { notifyOk('Setpoint sent', r.detail); refresh() },
    onError: (e) => notifyErr('Could not set setpoint', e),
  })
  const cmdM = useMutation({
    mutationFn: (b: Parameters<typeof reeferCommand>[1]) =>
      reeferCommand(unit.id, b),
    onSuccess: (r) => { notifyOk('Command sent', r.detail); refresh() },
    onError: (e) => notifyErr('Command failed', e),
  })

  const busy = setpointM.isPending || cmdM.isPending
  const spNum = Number(sp)
  const spInvalid = sp === '' || Number.isNaN(spNum)
    || spNum < -30 || spNum > 90
  const oem = unit.source === 'thermoking' ? 'THERMO KING' : 'LYNX'

  return (
    <div className="reefer-control" onClick={(e) => e.stopPropagation()}>
      <div className="rctl-head">
        <span className="rctl-badge">REMOTE CONTROL · {oem}</span>
        <span className="rctl-sub">
          Two-way OEM commands change the real reefer, not just an alert.
        </span>
      </div>
      <div className="rctl-row">
        <label className="rctl-field">
          <span>Setpoint °F</span>
          <input type="number" step={1} value={sp} disabled={busy}
            onChange={(e) => setSp(e.target.value)} />
        </label>
        <button className="btn btn-primary rctl-btn"
          disabled={busy || spInvalid} onClick={() => setpointM.mutate()}>
          {setpointM.isPending ? 'Sending…' : 'Set setpoint'}
        </button>
        <span className="rctl-spacer" />
        <button className="btn btn-ghost rctl-btn" disabled={busy}
          onClick={() => cmdM.mutate({ command: 'mode', mode: 'Continuous' })}>
          Continuous
        </button>
        <button className="btn btn-ghost rctl-btn" disabled={busy}
          onClick={() => cmdM.mutate({ command: 'mode', mode: 'Start-Stop' })}>
          Start-Stop
        </button>
        <button className="btn btn-ghost rctl-btn" disabled={busy}
          onClick={() => cmdM.mutate({ command: 'defrost' })}>
          Defrost
        </button>
      </div>
    </div>
  )
}

export default function ReeferPage() {
  const { can } = usePerms()
  const q = useQuery({
    queryKey: ['reefer'],
    queryFn: getReefer,
    refetchInterval: 60_000,
  })
  const [expanded, setExpanded] = useState<string | null>(null)
  const data = q.data
  const units = useMemo(() => data?.units ?? [], [data])

  const kpis = useMemo(() => {
    const alarms = units.reduce((n, u) => n + u.alarms.length, 0)
    const cooling = units.filter((u) => u.state === 'On').length
    const fuels = units.map((u) => u.fuel_pct)
      .filter((v): v is number => v != null)
    const avgFuel = fuels.length
      ? Math.round(fuels.reduce((a, b) => a + b, 0) / fuels.length) : null
    return { reporting: units.length, alarms, cooling, avgFuel }
  }, [units])

  // ----- Empty state: falta el scope -----
  if (data && !data.available) {
    return (
      <div className="page page-wide">
        <div className="page-head">
          <div>
            <h1>Cold Chain</h1>
            <p className="page-sub">Reefer temperatures, alarms and history.</p>
          </div>
        </div>
        <div className="card">
          <div className="card-body map-setup">
            <span className="map-setup-ico">
              <svg viewBox="0 0 24 24" {...STROKE}>
                <path d="M12 3s6 6.3 6 11a6 6 0 0 1-12 0c0-4.7 6-11 6-11z" />
              </svg>
            </span>
            <h2>Connect trailer telemetry</h2>
            <p>
              The Samsara token needs the scope below to read reefer data.
              Edit the API token in the Samsara dashboard and enable:
            </p>
            <div className="map-setup-scopes">
              {(data.missing_scopes.length
                ? data.missing_scopes
                : ['Read Trailer Statistics']).map((s) => (
                <code key={s}>{s}</code>
              ))}
            </div>
            <Button variant="primary" onClick={() => q.refetch()}>
              Check again
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page page-wide">
      {q.isFetching && <div className="loadbar" aria-hidden="true" />}
      <div className="page-head">
        <div>
          <h1>Cold Chain</h1>
          <p className="page-sub">
            Reefer setpoints, temperatures, alarms and 24h history.
          </p>
        </div>
        <div className="head-actions">
          {data?.demo && (
            <span className="nf-pill is-real" title={'No live reefer source '
              + 'connected yet: simulated data to evaluate the dashboard'}>
              DEMO DATA
            </span>
          )}
          {data?.source === 'lynx' && (
            <span className="nf-pill"
              title="Live OEM reefer telemetry + control via Carrier Lynx">
              LIVE · LYNX
            </span>
          )}
          {data?.source === 'thermoking' && (
            <span className="nf-pill"
              title="Live OEM reefer telemetry + control via Thermo King TracKing">
              LIVE · THERMO KING
            </span>
          )}
          {data?.source === 'traccar' && (
            <span className="nf-pill"
              title="Live reefer telemetry from your Traccar server">
              LIVE · TRACCAR
            </span>
          )}
          <Button variant="ghost" onClick={() => q.refetch()}
            loading={q.isFetching}>
            {q.isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button variant="primary" disabled={!units.length}
            onClick={() => exportCsv(units)}>
            Export CSV
          </Button>
        </div>
      </div>

      {data?.demo && (
        <div className="banner warn">
          <span>
            <strong>Demo data.</strong> No live reefer source is
            connected yet. Go direct with your OWN integration — never
            through Samsara: the OEM cloud for real remote setpoint
            control (<strong>Carrier Lynx</strong> or{' '}
            <strong>Thermo King TracKing</strong>, via your dealer), or
            aftermarket hardware (a tracker + temp probe like Teltonika
            FMC130 + DS18B20) reporting to a self-hosted{' '}
            <strong>Traccar</strong>. Set it in{' '}
            <strong>Settings → Connectivity → Cold chain</strong> (guides:
            backend/LYNX_SETUP.md, THERMOKING_SETUP.md, REEFER_SETUP.md).
            The dashboard, alerts and exports are already wired.
          </span>
        </div>
      )}

      {q.isPending ? (
        <div className="kpi-row">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} h={86} />
          ))}
        </div>
      ) : (
        <div className="kpi-row">
          <StatCard label="Reefers reporting" value={kpis.reporting}
            tone="info" />
          <StatCard label="Active alarms" value={kpis.alarms}
            tone={kpis.alarms ? 'danger' : 'ok'} />
          <StatCard label="Cooling units on" value={kpis.cooling}
            sub={`of ${kpis.reporting}`} tone="ok" />
          <StatCard label="Avg reefer fuel"
            value={kpis.avgFuel != null ? `${kpis.avgFuel}%` : '—'}
            tone={kpis.avgFuel != null && kpis.avgFuel < 25
              ? 'warn' : 'default'} />
        </div>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Reefers</h2>
          <span className="sub">
            click a row for the 24h temperature chart
          </span>
        </div>
        <div className="card-body">
          {q.isPending ? (
            <div className="skel-rows">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} h={38} />
              ))}
            </div>
          ) : units.length === 0 ? (
            <div className="empty mini"><p>No reefers reporting.</p></div>
          ) : (
            <div className="table-wrap">
              <table className="defects-table reefer-table">
                <thead>
                  <tr>
                    <th>Unit</th>
                    <th className="num">Setpoint</th>
                    <th className="num">Return</th>
                    <th className="num">Supply</th>
                    <th className="num">Ambient</th>
                    <th>Mode</th>
                    <th className="num">Fuel</th>
                    <th>Door</th>
                    <th>Alarms</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {units.map((u) => (
                    <>
                      <tr key={u.id}
                        className={expanded === u.id ? 'focused' : ''}
                        onClick={() => setExpanded(
                          expanded === u.id ? null : u.id)}>
                        <td>
                          <span className="reefer-unit">
                            <span className={`reefer-state st-${u.state.toLowerCase() || 'na'}`} />
                            <strong>{u.unit}</strong>
                            {u.can_control && (
                              <span className="reefer-ctrl-tag"
                                title="Remote control available (Carrier Lynx)">
                                CTRL
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="num mono">{fmtT(u.setpoint_f)}</td>
                        <td className={`num mono rt-${devTone(u)}`}>
                          {fmtT(u.return_f)}
                        </td>
                        <td className="num mono">{fmtT(u.supply_f)}</td>
                        <td className="num mono">{fmtT(u.ambient_f)}</td>
                        <td>{u.run_mode || '—'}</td>
                        <td className={`num mono ${u.fuel_pct != null && u.fuel_pct < 25 ? 'rt-warn' : ''}`}>
                          {u.fuel_pct != null ? `${u.fuel_pct}%` : '—'}
                        </td>
                        <td>
                          <span className={`reefer-door ${u.door === 'Open' ? 'open' : ''}`}>
                            {u.door || '—'}
                          </span>
                        </td>
                        <td>
                          {u.alarms.length === 0 ? (
                            <span className="muted">—</span>
                          ) : (
                            <span className="reefer-alarms">
                              {u.alarms.map((a, i) => (
                                <span key={i}
                                  className={`reefer-alarm sev-${a.severity}`}
                                  title={`${a.description}${a.operator_action ? ` · ${a.operator_action}` : ''}`}>
                                  {a.code || '!'}
                                </span>
                              ))}
                            </span>
                          )}
                        </td>
                        <td className="muted">{agoOf(u.updated)}</td>
                      </tr>
                      {expanded === u.id && (
                        <tr key={`${u.id}-chart`} className="reefer-chart-row">
                          <td colSpan={10}>
                            {u.can_control && can('fleet.edit') && (
                              <ReeferControl unit={u} />
                            )}
                            <HistoryRow unitId={u.id} />
                          </td>
                        </tr>
                      )}
                    </>
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
