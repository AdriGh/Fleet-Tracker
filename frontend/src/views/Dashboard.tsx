import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ackAlertEvents,
  generateLowStockRequests,
  getReefer,
  getTrends,
  listAlertEvents,
  listFleet,
  listLowStock,
  listOpenDefects,
  listPM,
  listPurchaseOrders,
  listWorkOrders,
  missingDrivers,
  monthSummary,
  recentBlocks,
  type FleetUnit,
  type LowStockPart,
  type PMUnit,
  type WorkOrder,
} from '../api'
import { notifyOk, notifyErr } from '../toast'
import SafeDonut from '../components/SafeDonut'
import Skeleton from '../components/Skeleton'
import CountUp from '../components/CountUp'
import TrendsChart from '../components/TrendsChart'
import HelpCenter from '../components/HelpCenter'
import InfoTip from '../components/InfoTip'
import { getSetupStatus } from '../api'
import { Button, StatCard, StatCluster } from '../components/ds'

const UPCOMING_MILES = 5500

// Etiquetas de estado de WO en el mini-tablero del dashboard. Mismo léxico
// que WorkOrdersPage (STATUS_META) para no divergir.
const WO_STATUS_META: Record<string, { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'is-open' },
  assigned: { label: 'Assigned', cls: 'is-open' },
  in_progress: { label: 'In progress', cls: 'is-prog' },
  completed: { label: 'Completed', cls: 'is-done' },
  invoiced: { label: 'Invoiced', cls: 'is-done' },
}

function money(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  })
}

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
  reefer_fault_wo: 'is-warn',
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
  // Reusa la MISMA caché que WorkOrdersPage (['workorders', status]) y
  // ReeferPage (['reefer']): no son fuentes nuevas, solo lecturas extra.
  const woQ = useQuery({
    queryKey: ['workorders', 'open'],
    queryFn: () => listWorkOrders('open'),
  })
  const reeferQ = useQuery({ queryKey: ['reefer'], queryFn: getReefer })

  // --- Cockpit de taller (Shop operations) ---
  // Todas las WOs (no solo 'open'): "Needs parts" incluye assigned/in_progress
  // que esperan partes, no solo abiertas. Las stats del backend son globales.
  const woAllQ = useQuery({
    queryKey: ['workorders', ''],
    queryFn: () => listWorkOrders(''),
  })
  const lowStockQ = useQuery({ queryKey: ['low-stock'], queryFn: listLowStock })
  const poQ = useQuery({
    queryKey: ['purchase-orders', ''],
    queryFn: () => listPurchaseOrders(''),
  })
  const [generating, setGenerating] = useState(false)

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
    fleetQ.isFetching || trendsQ.isFetching ||
    woQ.isFetching || reeferQ.isFetching ||
    woAllQ.isFetching || lowStockQ.isFetching || poQ.isFetching

  async function generateReorders() {
    setGenerating(true)
    try {
      const { created } = await generateLowStockRequests()
      qc.invalidateQueries({ queryKey: ['parts-requests'] })
      if (created > 0) {
        notifyOk('Reorder requests created',
          `${created} part${created === 1 ? '' : 's'} queued for purchasing`)
        onNavigate('purchasing')
      } else {
        notifyOk('Nothing to reorder',
          'Every low-stock part already has a pending request')
      }
    } catch (e) {
      notifyErr('Could not generate requests', e)
    } finally {
      setGenerating(false)
    }
  }

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

  // --- Work orders abiertas (mini-tablero) ---
  // Top 6 por antigüedad (más viejas primero). El badge "from reefer fault"
  // es real: lo marca el backend con source='reefer' al auto-abrir la WO.
  const openWorkOrders: WorkOrder[] = useMemo(() => {
    const list = woQ.data?.workorders ?? []
    return [...list]
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
      .slice(0, 6)
  }, [woQ.data])
  const woStats = woQ.data?.stats

  // --- Shop operations (cockpit) ---
  // Stats globales del backend (no dependen del filtro). "Needs parts" =
  // WOs con flag de espera de partes que aún no están facturadas.
  const shopStats = woAllQ.data?.stats
  const needsParts: WorkOrder[] = useMemo(() => {
    const list = woAllQ.data?.workorders ?? []
    return list
      .filter((w) => w.waiting_parts && w.status !== 'invoiced')
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
  }, [woAllQ.data])
  const lowStock: LowStockPart[] = lowStockQ.data ?? []
  const poStats = poQ.data?.stats
  const openPoCount = poStats ? poStats.draft + poStats.ordered : 0
  const shopKpiLoading =
    woAllQ.isPending || lowStockQ.isPending || poQ.isPending

  // --- Cold chain (reefers en vivo) ---
  // SOLO datos en vivo: si la respuesta es demo o no hay fuente real, se
  // omite el panel (no se inyectan reefers ficticios en la app real).
  // El panel se muestra con datos reales o con el SIMULADOR pedido a
  // propósito (FLEET_DEMO=1). Nunca con el demo de fallback por falta de
  // credenciales: ahí no hay que pintar datos falsos en el dashboard.
  const reeferLive = !!reeferQ.data?.available
    && (!reeferQ.data?.demo || !!reeferQ.data?.demo_explicit)
  const reeferUnits = useMemo(() => {
    if (!reeferLive) return []
    const units = reeferQ.data?.units ?? []
    // Alarmas primero (severidad alta), luego el resto; máximo 4 chips.
    return [...units]
      .sort((a, b) => {
        const sa = Math.max(0, ...a.alarms.map((x) => Number(x.severity) || 0))
        const sb = Math.max(0, ...b.alarms.map((x) => Number(x.severity) || 0))
        return sb - sa
      })
      .slice(0, 4)
  }, [reeferLive, reeferQ.data])

  const summary = summaryQ.data
  const missing = missingQ.data?.drivers ?? []
  const recent = recentQ.data ?? []
  const trends = trendsQ.data?.points ?? []

  const kpiLoading = summaryQ.isPending || openQ.isPending || pmQ.isPending || fleetQ.isPending

  // --- Centro de guías (v2.13, elemento 04 — permanente, vive ACÁ y no en
  // el sidebar por decisión del founder). El strip muestra el progreso real
  // de "Get set up"; completado, queda como acceso compacto a las guías.
  const [guidesOpen, setGuidesOpen] = useState(false)
  const setupQ = useQuery({ queryKey: ['setup-status'], queryFn: getSetupStatus })
  const setup = setupQ.data
  const setupNext = setup?.steps.find((s) => !s.done)

  return (
    <div className="page page-wide">
      {fetching && <div className="loadbar" aria-hidden="true" />}

      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="page-sub">
            Shop operations and fleet compliance at a glance: parts, work
            orders, purchasing, DVIR and maintenance.
          </p>
        </div>
        <div className="head-actions">
          <Button
            variant="ghost"
            onClick={() => {
              summaryQ.refetch(); openQ.refetch(); pmQ.refetch()
              fleetQ.refetch(); trendsQ.refetch(); missingQ.refetch()
              woQ.refetch(); reeferQ.refetch()
              woAllQ.refetch(); lowStockQ.refetch(); poQ.refetch()
            }}
            loading={fetching}
            disabled={fetching}
            title="Refresh"
            icon={
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                strokeLinejoin="round">
                <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
              </svg>
            }
          >
            {fetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>

      {/* Guías y setup (v2.13): progreso real mientras falte onboarding;
          completado, acceso compacto y permanente a todos los tutoriales. */}
      {setup && (
        <section className={`card guides-strip ${setup.done >= setup.total ? 'is-done' : ''}`}>
          <span className="guides-ico" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
              width="17" height="17">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13z" />
              <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-2.5" />
            </svg>
          </span>
          {setup.done < setup.total ? (
            <>
              <div className="guides-strip-main">
                <strong>Get set up · {setup.done} of {setup.total}</strong>
                <div className="hc-prog">
                  <i style={{ width: `${(setup.done / setup.total) * 100}%` }} />
                </div>
              </div>
              {setupNext && (
                <button className="btn-link guides-next"
                  onClick={() => onNavigate(setupNext.section)}>
                  Next: {setupNext.label} →
                </button>
              )}
            </>
          ) : (
            <div className="guides-strip-main">
              <strong>Guides & tutorials</strong>
              <span className="guides-sub">
                Step-by-step walkthroughs of every flow, whenever you need them.
              </span>
            </div>
          )}
          <Button variant="ghost" onClick={() => setGuidesOpen(true)}>
            All guides
          </Button>
        </section>
      )}

      {/* ===== Cockpit de taller (Shop operations) ===== */}
      <div className="dash-band-label">
        <span>Shop operations</span>
        <span className="dash-band-rule" />
        <button className="btn-link" onClick={() => onNavigate('workorders')}>
          Work orders →
        </button>
      </div>

      {shopKpiLoading ? (
        <StatCluster className="kpi-row">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} h={86} />)}
        </StatCluster>
      ) : (
        <StatCluster className="kpi-row">
          <StatCard
            label={<>Parts blocking WOs <InfoTip
              text="Work orders that can't move because a part isn't in stock. Ordering it (Purchasing) unblocks them." /></>}
            value={<CountUp value={shopStats?.waiting_parts ?? 0} />}
            sub="work orders waiting"
            tone={shopStats?.waiting_parts ? 'danger' : 'ok'}
          />
          <StatCard
            label="Low stock parts"
            value={<CountUp value={lowStock.length} />}
            sub="at or below min"
            tone={lowStock.length ? 'warn' : 'ok'}
          />
          <StatCard
            label="Open POs"
            value={<CountUp value={openPoCount} />}
            sub={poStats ? `${money(poStats.open_value)} in flight` : '—'}
            tone="info"
          />
          <StatCard
            label="Shop spend (30d)"
            value={shopStats ? money(shopStats.cost_30d) : '—'}
            sub={shopStats ? `${shopStats.completed_30d} WOs completed` : ''}
            tone="info"
          />
        </StatCluster>
      )}

      <div className="shop-actions">
        {/* Needs parts — WOs bloqueadas esperando repuestos */}
        <section className="card action-card is-danger">
          <div className="card-head">
            <h2>Needs parts</h2>
            <span className="dash-count">{needsParts.length}</span>
            <button className="btn-link" onClick={() => onNavigate('workorders')}>
              View all →
            </button>
          </div>
          <div className="card-body">
            {woAllQ.isPending ? (
              <div className="skel-rows">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} h={34} />)}
              </div>
            ) : needsParts.length === 0 ? (
              <div className="empty mini"><p>No work orders are waiting on parts.</p></div>
            ) : (
              <ul className="dash-list action-list">
                {needsParts.slice(0, 6).map((w) => {
                  const st = WO_STATUS_META[w.status] ?? WO_STATUS_META.open
                  return (
                    <li key={w.id} className="dash-list-item"
                      onClick={() => onNavigate('workorders')}>
                      <span className="dash-wo-id">#{w.display_no}</span>
                      <span className="dash-list-code">{w.unit}</span>
                      <span className="dash-list-name" title={w.title}>{w.title}</span>
                      <span className={`dash-wo-pill ${st.cls}`}>{st.label}</span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </section>

        {/* Reorder now — partes en/bajo su mínimo → cola de compras */}
        <section className="card action-card is-warn">
          <div className="card-head">
            <h2>Reorder now</h2>
            <span className="dash-count">{lowStock.length}</span>
            {lowStock.length > 0 && (
              <button className="btn-link" onClick={generateReorders}
                disabled={generating}>
                {generating ? 'Generating…' : 'Generate requests →'}
              </button>
            )}
          </div>
          <div className="card-body">
            {lowStockQ.isPending ? (
              <div className="skel-rows">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} h={34} />)}
              </div>
            ) : lowStock.length === 0 ? (
              <div className="empty mini"><p>Every part is above its reorder point.</p></div>
            ) : (
              <ul className="dash-list action-list">
                {lowStock.slice(0, 6).map((p) => {
                  const short = Math.max(0, p.reorder_point - p.on_hand)
                  return (
                    <li key={p.id} className="dash-list-item"
                      onClick={() => onNavigate('parts')}>
                      <span className="dash-list-code">{p.part_number}</span>
                      <span className="dash-list-name" title={p.description}>
                        {p.description || '—'}
                      </span>
                      <span className="reorder-qty">{p.on_hand}/{p.reorder_point}</span>
                      <span className="dash-tag is-warn">
                        {short > 0 ? `short ${short}` : 'at min'}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </section>
      </div>

      {/* ===== Flota & compliance ===== */}
      <div className="dash-band-label">
        <span>Fleet &amp; compliance</span>
        <span className="dash-band-rule" />
      </div>

      {/* KPIs */}
      {kpiLoading ? (
        <StatCluster className="kpi-row">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} h={86} />)}
        </StatCluster>
      ) : (
        <StatCluster className="kpi-row">
          <StatCard
            label={<>Fleet SAFE (month) <InfoTip
              text="Share of this month's DVIRs with no defects reported. The donut below breaks it down." /></>}
            value={summary?.fleet_safe_pct != null
              ? <CountUp value={summary.fleet_safe_pct} format={(n) => `${n.toFixed(1)}%`} />
              : '—'}
            sub={summary?.n_blocks ? `${summary.n_blocks} days` : 'no data'}
            tone={summary?.fleet_safe_pct != null && summary.fleet_safe_pct < 90 ? 'warn' : 'ok'}
            progress={summary?.fleet_safe_pct != null ? summary.fleet_safe_pct / 100 : undefined}
          />
          <StatCard
            label="Open defects"
            value={<CountUp value={openDefects.length} />}
            sub={`${unitsAffected} units`}
            tone={openDefects.length ? 'danger' : 'ok'}
          />
          <StatCard
            label="Overdue PMs"
            value={<CountUp value={pmStats.overdue} />}
            sub={`${pmStats.upcoming} upcoming`}
            tone={pmStats.overdue ? 'danger' : 'ok'}
          />
          <StatCard
            label="Active units"
            value={<CountUp value={fleetStats.active} />}
            sub={`${fleetStats.truck} trk · ${fleetStats.trailer} trl · ${fleetStats.chassis} chs`}
            tone="info"
          />
          <StatCard
            label="Missing DVIRs"
            value={<CountUp value={missing.length} />}
            sub="drivers this month"
            tone={missing.length ? 'warn' : 'ok'}
          />
        </StatCluster>
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

      {/* Tablero inferior: WO abiertas (+ cold chain en vivo si lo hay).
          Llena la banda vacía bajo el grid sin datos inventados. */}
      <div className={`dash-ops ${reeferLive && reeferUnits.length ? 'has-cc' : ''}`}>
        {/* Work orders abiertas */}
        <section className="card dash-wo">
          <div className="card-head">
            <h2>Open work orders</h2>
            {woStats ? (
              <span className="dash-count">{woStats.open} open</span>
            ) : null}
            <button className="btn-link" onClick={() => onNavigate('workorders')}>
              View all →
            </button>
          </div>
          <div className="card-body">
            {woQ.isPending ? (
              <div className="skel-rows">
                {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} h={34} />)}
              </div>
            ) : openWorkOrders.length === 0 ? (
              <div className="empty mini"><p>No open work orders.</p></div>
            ) : (
              <table className="dash-wo-table">
                <thead>
                  <tr>
                    <th>WO</th>
                    <th>Unit</th>
                    <th>Title</th>
                    <th>Status</th>
                    <th className="r">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {openWorkOrders.map((w) => {
                    const st = WO_STATUS_META[w.status] ?? WO_STATUS_META.open
                    return (
                      <tr key={w.id} onClick={() => onNavigate('workorders')}>
                        <td><span className="dash-wo-id">#{w.id}</span></td>
                        <td><span className="dash-list-code">{w.unit}</span></td>
                        <td className="dash-wo-title">
                          <span className="dash-wo-title-txt" title={w.title}>
                            {w.title}
                          </span>
                          {w.is_pm && <span className="dash-src-badge is-pm">PM</span>}
                          {w.source === 'reefer' && (
                            <span className="dash-src-badge">from reefer fault</span>
                          )}
                          {w.source === 'defect' && (
                            <span className="dash-src-badge is-defect">from defect</span>
                          )}
                        </td>
                        <td>
                          <span className={`dash-wo-pill ${st.cls}`}>
                            {st.label}
                          </span>
                          {w.waiting_parts && (
                            <span className="dash-wo-pill is-parts" title="Waiting for parts">
                              parts
                            </span>
                          )}
                        </td>
                        <td className="dash-wo-total">
                          {w.total ? money(w.total) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {/* Cold chain (solo con fuente de reefer EN VIVO) */}
        {reeferLive && reeferUnits.length > 0 && (
          <section className="card dash-cc">
            <div className="card-head">
              <h2>Cold chain</h2>
              <span className="dash-count">{reeferUnits.length} live</span>
              <button className="btn-link" onClick={() => onNavigate('coldchain')}>
                Monitor →
              </button>
            </div>
            <div className="card-body">
              <div className="dash-cc-grid">
                {reeferUnits.map((u) => {
                  const sev = Math.max(0, ...u.alarms.map((x) => Number(x.severity) || 0))
                  const alarm = sev >= 2
                  return (
                    <div key={u.id}
                      className={`dash-cc-chip ${alarm ? 'is-alarm' : ''}`}
                      onClick={() => onNavigate('coldchain')}>
                      <div className="dash-cc-top">
                        <span className="dash-list-code">{u.unit}</span>
                        <span className="dash-cc-mode">
                          {alarm ? 'Alarm' : (u.run_mode || u.state || 'Cool')}
                        </span>
                      </div>
                      <div className="dash-cc-temps">
                        <span className="dash-cc-temp">
                          <span className="lab">Setpoint</span>
                          <span className="val">
                            {u.setpoint_f != null ? `${Math.round(u.setpoint_f)}°F` : '—'}
                          </span>
                        </span>
                        <span className="dash-cc-temp">
                          <span className="lab">Return</span>
                          <span className={`val ${alarm ? 'ret' : ''}`}>
                            {u.return_f != null ? `${Math.round(u.return_f)}°F` : '—'}
                          </span>
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </section>
        )}
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

      <HelpCenter open={guidesOpen} onClose={() => setGuidesOpen(false)}
        onNavigate={onNavigate} />
    </div>
  )
}
