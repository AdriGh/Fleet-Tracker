import { useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ackAlertEvents,
  getTrends,
  listAlertEvents,
  listFleet,
  listOpenDefects,
  listPM,
  missingDrivers,
  monthSummary,
  recentBlocks,
  type FleetUnit,
  type PMUnit,
} from '../api'
import { notifyOk, notifyErr } from '../toast'
import SafeDonut from '../components/SafeDonut'
import Skeleton from '../components/Skeleton'
import StatCard from '../components/StatCard'
import TrendsChart from '../components/TrendsChart'

const UPCOMING_MILES = 5500

type Props = {
  onNavigate: (section: string) => void
}

const SHORTCUTS = [
  {
    id: 'dvir',
    label: 'DVIR Reports',
    desc: 'Build the daily inspection report.',
    icon: (
      <path d="M9 4h6a1 1 0 0 1 1 1v1h2a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h2V5a1 1 0 0 1 1-1zm0 9 2 2 4-4" />
    ),
  },
  {
    id: 'defectos',
    label: 'Defects',
    desc: 'Backlog of open defects by unit.',
    icon: (
      <path d="M10.3 3.5 1.8 18a1.5 1.5 0 0 0 1.3 2.2h17.8A1.5 1.5 0 0 0 22.2 18L13.7 3.5a1.5 1.5 0 0 0-2.6 0zM12 9v4m0 4h.01" />
    ),
  },
  {
    id: 'avisos',
    label: 'Notices',
    desc: 'Notify drivers by SMS or email.',
    icon: <path d="M3 5h18v14H3zm1 2 8 6 8-6" />,
  },
  {
    id: 'flota',
    label: 'Fleet',
    desc: 'Live unit inventory.',
    icon: (
      <path d="M2 6h11v9H2zM13 9h4l3 3v3h-7zM6.5 17.5h.01M17.5 17.5h.01" />
    ),
  },
  {
    id: 'pm',
    label: 'PM Tracker',
    desc: 'Preventive maintenance by mileage.',
    icon: (
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L4 16.8 7.2 20l5.3-5.3a4 4 0 0 0 5.2-5.4l-2.5 2.5-2.3-.5-.5-2.3z" />
    ),
  },
]

const RULE_TONE: Record<string, string> = {
  speeding: 'is-danger',
  idle: 'is-warn',
  low_fuel: 'is-warn',
  low_def: 'is-warn',
  no_gps: 'is-danger',
  reefer_temp: 'is-danger',
}

function alertAgo(iso: string): string {
  const diff = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  return `${Math.floor(diff / 86400)}d`
}

export default function Dashboard({ onNavigate }: Props) {
  const qc = useQueryClient()
  const summaryQ = useQuery({ queryKey: ['month-summary'], queryFn: monthSummary })
  const openQ = useQuery({ queryKey: ['open-defects'], queryFn: listOpenDefects })
  const pmQ = useQuery({ queryKey: ['pm'], queryFn: listPM })
  const fleetQ = useQuery({ queryKey: ['fleet'], queryFn: listFleet })
  const trendsQ = useQuery({ queryKey: ['trends'], queryFn: getTrends })
  const missingQ = useQuery({ queryKey: ['missing-drivers'], queryFn: missingDrivers })
  const recentQ = useQuery({
    queryKey: ['recent-blocks', 'created_at'],
    queryFn: () => recentBlocks('created_at', 5),
  })
  const alertsQ = useQuery({
    queryKey: ['alert-events'],
    queryFn: () => listAlertEvents(8),
    refetchInterval: 60_000,
  })

  const alertEvents = alertsQ.data ?? []
  const unacked = alertEvents.filter((e) => !e.acked).length

  async function ackAll() {
    try {
      const n = await ackAlertEvents()
      qc.invalidateQueries({ queryKey: ['alert-events'] })
      notifyOk('Alerts acknowledged', `${n} event${n === 1 ? '' : 's'}`)
    } catch (e) {
      notifyErr('Could not acknowledge', e)
    }
  }

  const fetching =
    summaryQ.isFetching || openQ.isFetching || pmQ.isFetching ||
    fleetQ.isFetching || trendsQ.isFetching

  // --- Defectos abiertos ---
  const openDefects = openQ.data ?? []
  const unitsAffected = useMemo(
    () => new Set(openDefects.map((d) => d.unit)).size,
    [openDefects],
  )

  // --- PM ---
  const pmUnits: PMUnit[] = pmQ.data?.units ?? []
  const pmStats = useMemo(() => {
    let overdue = 0
    let upcoming = 0
    const attention: { unit: string; remaining: number }[] = []
    for (const u of pmUnits) {
      if (u.remaining == null) continue
      if (u.remaining < 0) {
        overdue++
        attention.push({ unit: u.unit, remaining: u.remaining })
      } else if (u.remaining < UPCOMING_MILES) {
        upcoming++
        attention.push({ unit: u.unit, remaining: u.remaining })
      }
    }
    attention.sort((a, b) => a.remaining - b.remaining)
    return { overdue, upcoming, attention: attention.slice(0, 6) }
  }, [pmUnits])

  // --- Flota ---
  const fleet: FleetUnit[] = fleetQ.data ?? []
  const fleetStats = useMemo(() => {
    const active = fleet.filter((u) => !u.archived)
    const by = { truck: 0, trailer: 0, chassis: 0 }
    for (const u of active) {
      if (u.unit_type === 'truck') by.truck++
      else if (u.unit_type === 'chassis') by.chassis++
      else by.trailer++
    }
    return { active: active.length, ...by }
  }, [fleet])

  const summary = summaryQ.data
  const missing = missingQ.data?.drivers ?? []
  const recent = recentQ.data ?? []
  const trends = trendsQ.data?.points ?? []

  const kpiLoading = summaryQ.isPending || openQ.isPending || pmQ.isPending || fleetQ.isPending

  return (
    <div className="page page-wide">
      {fetching && <div className="loadbar" aria-hidden="true" />}

      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="page-sub">
            Fleet compliance status at a glance: DVIR, defects,
            maintenance and inventory.
          </p>
        </div>
        <div className="head-actions">
          <button
            className="btn btn-ghost"
            onClick={() => {
              summaryQ.refetch(); openQ.refetch(); pmQ.refetch()
              fleetQ.refetch(); trendsQ.refetch(); missingQ.refetch()
            }}
            disabled={fetching}
            title="Refresh"
          >
            <svg className={fetching ? 'spin' : ''} viewBox="0 0 24 24"
              width="15" height="15" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
            </svg>
            {fetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* KPIs */}
      {kpiLoading ? (
        <div className="kpi-row">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} h={86} />)}
        </div>
      ) : (
        <div className="kpi-row">
          <StatCard
            label="Fleet SAFE (month)"
            value={summary?.fleet_safe_pct != null ? `${summary.fleet_safe_pct.toFixed(1)}%` : '—'}
            sub={summary?.n_blocks ? `${summary.n_blocks} days` : 'no data'}
            tone={summary?.fleet_safe_pct != null && summary.fleet_safe_pct < 90 ? 'warn' : 'ok'}
          />
          <StatCard
            label="Open defects"
            value={openDefects.length}
            sub={`${unitsAffected} units`}
            tone={openDefects.length ? 'danger' : 'ok'}
          />
          <StatCard
            label="Overdue PMs"
            value={pmStats.overdue}
            sub={`${pmStats.upcoming} upcoming`}
            tone={pmStats.overdue ? 'danger' : 'ok'}
          />
          <StatCard
            label="Active units"
            value={fleetStats.active}
            sub={`${fleetStats.truck} trk · ${fleetStats.trailer} trl · ${fleetStats.chassis} chs`}
            tone="info"
          />
          <StatCard
            label="Missing DVIRs"
            value={missing.length}
            sub="drivers this month"
            tone={missing.length ? 'warn' : 'ok'}
          />
        </div>
      )}

      <div className="dash-grid">
        {/* Tendencia */}
        <section className="card dash-trend">
          <div className="card-head">
            <h2>Monthly trend</h2>
            <span className="sub">incidents per day (NO DVIR + Unsafe)</span>
          </div>
          <div className="card-body">
            {trendsQ.isPending ? (
              <Skeleton className="skel-chart" h={200} />
            ) : (
              <TrendsChart points={trends} />
            )}
          </div>
        </section>

        {/* Donut SAFE */}
        <section className="card dash-donut">
          <div className="card-head">
            <h2>Fleet SAFE this month</h2>
          </div>
          <div className="card-body">
            {summaryQ.isPending ? (
              <Skeleton className="skel-chart" h={180} />
            ) : (
              <SafeDonut
                pct={summary?.fleet_safe_pct ?? null}
                caption={summary?.month
                  ? `${summary.n_blocks}-day average`
                  : ''}
              />
            )}
          </div>
        </section>

        {/* Requiere atención */}
        <section className="card dash-attention">
          <div className="card-head">
            <h2>Needs attention</h2>
            <button className="btn-link" onClick={() => onNavigate('pm')}>View PM →</button>
          </div>
          <div className="card-body">
            {pmQ.isPending ? (
              <div className="skel-rows">
                {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} h={30} />)}
              </div>
            ) : pmStats.attention.length === 0 ? (
              <div className="empty mini"><p>No overdue or upcoming PMs.</p></div>
            ) : (
              <ul className="dash-list">
                {pmStats.attention.map((a) => (
                  <li key={a.unit} className="dash-list-item" onClick={() => onNavigate('pm')}>
                    <span className="dash-list-code">{a.unit}</span>
                    <span className={`dash-tag ${a.remaining < 0 ? 'is-danger' : 'is-warn'}`}>
                      {a.remaining < 0
                        ? `${Math.abs(Math.round(a.remaining)).toLocaleString()} mi overdue`
                        : `${Math.round(a.remaining).toLocaleString()} mi left`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* DVIR pendientes */}
        <section className="card dash-missing">
          <div className="card-head">
            <h2>Top missing DVIRs</h2>
            <button className="btn-link" onClick={() => onNavigate('dvir')}>View DVIR →</button>
          </div>
          <div className="card-body">
            {missingQ.isPending ? (
              <div className="skel-rows">
                {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} h={30} />)}
              </div>
            ) : missing.length === 0 ? (
              <div className="empty mini"><p>Nobody missing this month.</p></div>
            ) : (
              <ul className="dash-list">
                {missing.slice(0, 6).map((d) => (
                  <li key={d.driver} className="dash-list-item">
                    <span className="dash-list-name">{d.driver}</span>
                    <span className="dash-tag is-warn">{d.misses} {d.misses === 1 ? 'miss' : 'misses'}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Alertas de flota (G3) */}
        <section className="card dash-alerts">
          <div className="card-head">
            <h2>Fleet alerts</h2>
            {unacked > 0 ? (
              <button className="btn-link" onClick={ackAll}>
                Ack all ({unacked})
              </button>
            ) : (
              <button className="btn-link"
                onClick={() => onNavigate('settings')}>
                Rules →
              </button>
            )}
          </div>
          <div className="card-body">
            {alertsQ.isPending ? (
              <div className="skel-rows">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} h={30} />
                ))}
              </div>
            ) : alertEvents.length === 0 ? (
              <div className="empty mini">
                <p>
                  No alerts. Enable speeding, idle, fuel, DEF or GPS rules
                  in Settings.
                </p>
              </div>
            ) : (
              <ul className="dash-list">
                {alertEvents.map((e) => (
                  <li key={e.id}
                    className={`dash-list-item ${e.acked ? 'is-acked' : ''}`}>
                    <span className={`dash-tag ${RULE_TONE[e.rule] ?? 'is-warn'}`}>
                      {e.rule_label}
                    </span>
                    <span className="dash-list-name" title={e.message}>
                      <strong>{e.unit}</strong> · {e.message}
                    </span>
                    <span className="dash-list-meta">{alertAgo(e.ts)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Actividad reciente */}
        <section className="card dash-recent">
          <div className="card-head">
            <h2>Recent activity</h2>
            <button className="btn-link" onClick={() => onNavigate('dvir')}>View all →</button>
          </div>
          <div className="card-body">
            {recentQ.isPending ? (
              <div className="skel-rows">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} h={34} />)}
              </div>
            ) : recent.length === 0 ? (
              <div className="empty mini"><p>No reports generated yet.</p></div>
            ) : (
              <ul className="dash-list">
                {recent.map((b) => (
                  <li key={b.id} className="dash-list-item" onClick={() => onNavigate('dvir')}>
                    <span className="dash-list-name">
                      <strong>{b.company}</strong> · {b.date_label}
                    </span>
                    <span className="dash-list-meta">
                      {b.n_reports} rep · {b.fleet_safe_pct.toFixed(0)}% safe
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      {/* Accesos rápidos */}
      <div className="dash-shortcuts">
        {SHORTCUTS.map((s) => (
          <button key={s.id} className="dash-shortcut" onClick={() => onNavigate(s.id)}>
            <span className="dash-shortcut-ico">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                {s.icon}
              </svg>
            </span>
            <span className="dash-shortcut-text">
              <strong>{s.label}</strong>
              <span>{s.desc}</span>
            </span>
            <svg className="dash-shortcut-arrow" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
        ))}
      </div>
    </div>
  )
}
