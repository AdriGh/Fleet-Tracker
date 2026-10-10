// Home v2.22 (sección 'dashboard'): estructura del Home de SquareRigger con
// el look de Rigsmith — saludo, 4 KPIs clickeables (→ Work Orders filtradas),
// Quick Navigation 2×3 con conteos en vivo, y abajo una tarjeta ANCHA de Work
// Orders (donut por estado + semana pasada vs esta + top unidades) junto a
// "PMs due & overdue" (PM en millas, DOT en días, Reefer en HORAS de motor;
// orden por Days | Readings). Datos: /api/home/summary (TZ de la org) y
// /api/maint/due. El strip de guías/setup + HelpCenter viven acá (decisión
// del founder: las guías se abren desde el Home, no desde el sidebar).
import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  getHomeSummary, getMaintDue, getSetupStatus, listFleet, listLowStock,
  listPartsRequests, type HomeWeek, type MaintDueItem,
} from '../api'
import { useShell } from '../shell'
import { ICONS, UI_ICONS } from '../navModel'
import { Button, Tabs } from '../components/ds'
import CountUp from '../components/CountUp'
import Skeleton from '../components/Skeleton'
import StatusDonut from '../components/StatusDonut'
import HelpCenter from '../components/HelpCenter'

// ----- Formato -----------------------------------------------------------------
const money0 = (n: number) => n.toLocaleString('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
})
const int = (n: number) => Math.round(n).toLocaleString('en-US')
const hours = (n: number) =>
  `${n.toLocaleString('en-US', { maximumFractionDigits: 1 })}h`

function todayLabel(): string {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  })
}

function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return 'Working late'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

// Filas de la comparación semanal. `better` decide el color del delta.
type WeekKey = keyof HomeWeek
const WEEK_ROWS: {
  key: WeekKey; label: string; fmt: (n: number) => string
  better?: 'up' | 'down'
}[] = [
  { key: 'closed_wos', label: 'Closed work orders', fmt: int, better: 'up' },
  { key: 'closed_value', label: 'Closed value', fmt: money0, better: 'up' },
  { key: 'inside', label: 'Inside work', fmt: int },
  { key: 'outside', label: 'Outside work', fmt: int },
  { key: 'new_pm', label: 'New PM', fmt: int },
  { key: 'service_requests', label: 'Service requests', fmt: int },
  { key: 'avg_days_to_close', label: 'Avg days to close',
    fmt: (n) => n.toLocaleString('en-US', { maximumFractionDigits: 1 }),
    better: 'down' },
  { key: 'parts_spend', label: 'Parts spend', fmt: money0 },
  { key: 'labor_spend', label: 'Labor spend', fmt: money0 },
  { key: 'invoiced_value', label: 'Invoiced value', fmt: money0, better: 'up' },
]

function Delta({ last, cur, better }: {
  last: number | null; cur: number | null; better?: 'up' | 'down'
}) {
  if (last == null || cur == null) return <span className="hw-delta">—</span>
  const d = cur - last
  if (Math.abs(d) < 1e-9) return <span className="hw-delta is-flat">—</span>
  const pct = last ? Math.round((d / Math.abs(last)) * 100) : null
  const up = d > 0
  const tone = !better ? '' : (better === 'up') === up ? ' is-good' : ' is-bad'
  return (
    <span className={`hw-delta${tone}`}
      aria-label={`${up ? 'up' : 'down'}${pct != null ? ` ${Math.abs(pct)}%` : ''}`}>
      <span aria-hidden="true">{up ? '▲' : '▼'}</span>
      {pct != null ? `${Math.abs(pct)}%` : 'new'}
    </span>
  )
}

// ----- PMs ---------------------------------------------------------------------
type PmSort = 'days' | 'readings'

// Vencidos SIEMPRE arriba (en ambos modos); el backend ya manda los ítems
// por urgencia y Array.sort es estable, así que ese orden desempata.
function sortDue(items: MaintDueItem[], by: PmSort): MaintDueItem[] {
  const st = (i: MaintDueItem) => (i.status === 'overdue' ? 0 : 1)
  const out = [...items]
  if (by === 'days') {
    // Solo lo que vence POR FECHA tiene días que ordenar; lo que vence por
    // lectura (mi / hrs — un PM por millas no tiene días, un reefer vencido
    // por horas no se ordena por su respaldo de fecha) va después dentro de
    // su estado, en el orden de urgencia del backend.
    const key = (i: MaintDueItem) => (i.due_by === 'days'
      ? (i.to_due_days ?? i.to_due) : null)
    out.sort((a, b) => {
      const s = st(a) - st(b)
      if (s) return s
      const ka = key(a)
      const kb = key(b)
      if (ka == null || kb == null) return ka == null ? (kb == null ? 0 : 1) : -1
      return ka - kb
    })
  } else {
    // Lecturas agrupadas por unidad (mi, luego hrs: nunca se comparan millas
    // con horas) y por lo que falta; las de fecha (DOT) al final.
    const grp = (i: MaintDueItem) => (i.due_by === 'miles' ? 0
      : i.due_by === 'hours' ? 1 : 2)
    out.sort((a, b) => st(a) - st(b) || grp(a) - grp(b) || a.to_due - b.to_due)
  }
  return out
}

// Filas visibles de la tarjeta: TODOS los vencidos + hasta completar 12.
const PM_ROWS = 12

function dueLabel(it: MaintDueItem): string {
  const n = int(Math.abs(it.to_due))
  return it.to_due < 0 ? `${n} ${it.unit_label} over` : `in ${n} ${it.unit_label}`
}

const CAMPAIGN_ICON: Record<MaintDueItem['campaign'], ReactNode> = {
  pm: ICONS.pm, dot: ICONS.dot, reefer: ICONS['reefer-pm'],
}

// ----- Página ------------------------------------------------------------------
export default function Home({ userName = '' }: { userName?: string }) {
  const { navigate } = useShell()
  const sumQ = useQuery({
    queryKey: ['home-summary'], queryFn: getHomeSummary,
    refetchInterval: 5 * 60_000,
  })
  const dueQ = useQuery({ queryKey: ['maint', 'due'], queryFn: () => getMaintDue() })
  // Conteos de Quick Navigation: mismas keys que el resto de la app (caché
  // compartida con el badge del nav, Parts y Fleet).
  const reqQ = useQuery({
    queryKey: ['parts-requests', 'pending'],
    queryFn: () => listPartsRequests('pending'), staleTime: 60_000,
  })
  const lowQ = useQuery({ queryKey: ['low-stock'], queryFn: listLowStock })
  const fleetQ = useQuery({ queryKey: ['fleet'], queryFn: listFleet })
  const setupQ = useQuery({ queryKey: ['setup-status'], queryFn: getSetupStatus })

  const [pmSort, setPmSort] = useState<PmSort>('days')
  const [pmAll, setPmAll] = useState(false)
  const [guidesOpen, setGuidesOpen] = useState(false)

  const s = sumQ.data
  const first = (s?.user_first_name || userName.trim().split(/\s+/)[0] || '')
    .trim()
  const byStatus = s?.wo_by_status
  const openTotal = byStatus
    ? byStatus.open + byStatus.assigned + byStatus.in_progress + byStatus.completed
    : 0
  const activeUnits = useMemo(
    () => (fleetQ.data ?? []).filter((u) => !u.archived).length, [fleetQ.data])

  const dueItems = useMemo(
    () => sortDue(dueQ.data?.items ?? [], pmSort), [dueQ.data, pmSort])
  const dueShown = useMemo(() => {
    if (pmAll) return dueItems
    const nOver = dueItems.filter((i) => i.status === 'overdue').length
    return dueItems.slice(0, Math.max(PM_ROWS, nOver))
  }, [dueItems, pmAll])
  const overdue = dueQ.data?.counts.overdue ?? 0
  const pending = (dueQ.data?.counts.overdue ?? 0)
    + (dueQ.data?.counts.upcoming ?? 0)

  const setup = setupQ.data
  const setupNext = setup?.steps.find((st) => !st.done)
  const setupPending = !!setup && setup.done < setup.total

  const fetching = sumQ.isFetching || dueQ.isFetching

  // ----- KPIs ------------------------------------------------------------------
  const kpis: {
    id: string; label: string; value: number; fmt?: (n: number) => string
    sub: string; icon: ReactNode; tone?: 'danger' | 'ok'
    go: () => void
  }[] = [
    {
      id: 'in_progress', label: 'In progress WOs', icon: UI_ICONS.wrench,
      value: s?.kpis.in_progress ?? 0,
      sub: byStatus ? `${int(byStatus.assigned)} assigned · ${int(byStatus.open)} open`
        : 'Being worked on now',
      go: () => navigate('workorders', { filter: { status: ['in_progress'] } }),
    },
    {
      id: 'completed_today', label: 'WOs completed today', icon: UI_ICONS.check,
      value: s?.kpis.completed_today ?? 0,
      sub: s ? `${int(s.weeks.this.closed_wos)} closed this week` : 'Closed today',
      tone: (s?.kpis.completed_today ?? 0) > 0 ? 'ok' : undefined,
      // Mismo criterio que el KPI: cerradas HOY (TZ de la org), facturadas
      // incluidas.
      go: () => navigate('workorders', {
        filter: {
          status: ['completed', 'invoiced'], include_invoiced: true,
          closed_from: s?.today, closed_to: s?.today,
        },
      }),
    },
    {
      id: 'labor_hours', label: 'Labor hours this week', icon: UI_ICONS.clock,
      value: s?.kpis.labor_hours_week ?? 0, fmt: hours,
      sub: s ? `${money0(s.weeks.this.labor_spend)} labor this week`
        : 'Labor lines on this week’s WOs',
      // Mismo criterio que el KPI: líneas de labor de las WOs cuya fecha
      // efectiva cae en esta semana (lun–dom), facturadas incluidas.
      go: () => navigate('workorders', {
        filter: {
          include_invoiced: true,
          worked_from: s?.week_ranges?.this.from,
          worked_to: s?.week_ranges?.this.to,
        },
      }),
    },
    {
      id: 'parts_blocking', label: 'Parts blocking WOs', icon: UI_ICONS.alert,
      value: s?.kpis.parts_blocking ?? 0,
      sub: (s?.kpis.parts_blocking ?? 0) > 0 ? 'Waiting on parts'
        : 'Nothing waiting on parts',
      tone: (s?.kpis.parts_blocking ?? 0) > 0 ? 'danger' : undefined,
      go: () => navigate('workorders', { filter: { waiting_parts: true } }),
    },
  ]

  // ----- Quick navigation (2×3) ------------------------------------------------
  const quick: {
    id: string; label: string; meta: string; icon: ReactNode
    hot?: boolean
  }[] = [
    {
      id: 'service-requests', label: 'Service Requests', icon: ICONS['service-requests'],
      meta: s ? `${int(s.kpis.open_service_requests)} open` : '',
      hot: (s?.kpis.open_service_requests ?? 0) > 0,
    },
    {
      id: 'workorders', label: 'Work Orders', icon: ICONS.workorders,
      meta: byStatus ? `${int(openTotal)} active` : '',
    },
    {
      id: 'purchasing', label: 'Purchasing', icon: ICONS.purchasing,
      meta: reqQ.data ? `${int(reqQ.data.stats.pending)} requests pending` : '',
      hot: (reqQ.data?.stats.pending ?? 0) > 0,
    },
    {
      id: 'parts', label: 'Parts', icon: ICONS.parts,
      meta: lowQ.data ? `${int(lowQ.data.length)} low stock` : '',
      hot: (lowQ.data?.length ?? 0) > 0,
    },
    {
      id: 'flota', label: 'Equipment', icon: ICONS.flota,
      meta: fleetQ.data ? `${int(activeUnits)} active units` : '',
    },
    {
      id: 'reports', label: 'Reports', icon: ICONS.reports,
      meta: 'Library, builder & AI',
    },
  ]

  const weekThis = s?.weeks.this
  const weekLast = s?.weeks.last
  const topUnits = s?.top_units_week ?? []
  const topMax = Math.max(1, ...topUnits.map((u) => u.total))

  return (
    <div className="page page-wide home">
      {fetching && <div className="loadbar" aria-hidden="true" />}

      <header className="home-head">
        <div className="home-hello">
          <span className="home-eyebrow">{todayLabel()}</span>
          <h1>
            {first ? <>Welcome back, <span className="home-name">{first}</span></>
              : 'Welcome back'}
          </h1>
          <p className="page-sub">
            {greeting()} — here’s the shop at a glance.
          </p>
        </div>
        <div className="head-actions">
          {setup && !setupPending && (
            <Button variant="ghost" onClick={() => setGuidesOpen(true)}
              icon={<span className="home-btn-ico">{UI_ICONS.book}</span>}>
              Guides
            </Button>
          )}
          <Button variant="ghost" title="Refresh"
            loading={fetching} disabled={fetching}
            onClick={() => {
              sumQ.refetch(); dueQ.refetch(); reqQ.refetch()
              lowQ.refetch(); fleetQ.refetch()
            }}
            icon={<span className="home-btn-ico">{UI_ICONS.refresh}</span>}>
            {fetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </header>

      {/* Guías y setup (v2.13): progreso real mientras falte onboarding. */}
      {setupPending && setup && (
        <section className="card guides-strip">
          <span className="guides-ico" aria-hidden="true">{UI_ICONS.book}</span>
          <div className="guides-strip-main">
            <strong>Get set up · {setup.done} of {setup.total}</strong>
            <div className="hc-prog">
              <i style={{ width: `${(setup.done / setup.total) * 100}%` }} />
            </div>
          </div>
          {setupNext && (
            <button className="btn-link guides-next"
              onClick={() => navigate(setupNext.section)}>
              Next: {setupNext.label} →
            </button>
          )}
          <Button variant="ghost" onClick={() => setGuidesOpen(true)}>
            All guides
          </Button>
        </section>
      )}

      {sumQ.isError && (
        <div className="home-alert" role="status">
          <span aria-hidden="true">{UI_ICONS.alert}</span>
          <span>The shop summary couldn’t load. Lists and PMs below still work.</span>
          <button className="btn-link" onClick={() => sumQ.refetch()}>Retry</button>
        </div>
      )}

      {/* ===== KPIs ===== */}
      <section className="home-kpis" aria-label="Key metrics">
        {kpis.map((k) => (
          <button key={k.id} type="button"
            className={`home-kpi${k.tone ? ` is-${k.tone}` : ''}`}
            onClick={k.go}>
            <span className="home-kpi-top">
              <span className="home-kpi-label">{k.label}</span>
              <span className="home-kpi-ico" aria-hidden="true">{k.icon}</span>
            </span>
            <span className="home-kpi-value">
              {sumQ.isPending ? <Skeleton w={64} h={30} />
                : sumQ.isError ? '—'
                  : <CountUp value={k.value} format={k.fmt} />}
            </span>
            <span className="home-kpi-sub">
              {k.sub}
              <span className="home-kpi-go" aria-hidden="true">
                {UI_ICONS.arrowRight}
              </span>
            </span>
          </button>
        ))}
      </section>

      {/* ===== Quick navigation ===== */}
      <section className="home-quick" aria-labelledby="home-quick-h">
        <h2 id="home-quick-h" className="home-h2">Quick navigation</h2>
        <div className="home-quick-grid">
          {quick.map((t) => (
            <button key={t.id} type="button" className="home-tile"
              onClick={() => navigate(t.id)}>
              <span className="home-tile-ico" aria-hidden="true">{t.icon}</span>
              <span className="home-tile-label">{t.label}</span>
              {t.meta && (
                <span className={`home-tile-meta${t.hot ? ' is-hot' : ''}`}>
                  {t.meta}
                </span>
              )}
              <span className="home-tile-go" aria-hidden="true">
                {UI_ICONS.chevronRight}
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* ===== Work orders (ancha) + PMs ===== */}
      <div className="home-bottom">
        <section className="card home-card home-wo" aria-labelledby="home-wo-h">
          <div className="home-card-head">
            <span className="home-card-ico" aria-hidden="true">
              {ICONS.workorders}
            </span>
            <div className="home-card-title">
              <h2 id="home-wo-h">Work orders</h2>
              <span>Open by status · last week vs this week</span>
            </div>
          </div>

          <div className="home-wo-grid">
            <div className="home-wo-donut">
              {sumQ.isPending ? (
                <Skeleton className="skel-chart" h={168} />
              ) : byStatus && openTotal > 0 ? (
                <>
                  <StatusDonut
                    centerValue={int(openTotal)}
                    centerLabel="Open WOs"
                    segments={[
                      { label: 'Open', value: byStatus.open, tone: 'info' },
                      { label: 'Assigned', value: byStatus.assigned, tone: 'safe' },
                      { label: 'In progress', value: byStatus.in_progress, tone: 'warn' },
                      { label: 'Completed', value: byStatus.completed, tone: 'ok' },
                    ]} />
                  {byStatus.waiting_parts > 0 && (
                    <button type="button" className="home-wp-chip"
                      onClick={() => navigate('workorders',
                        { filter: { waiting_parts: true } })}>
                      <span className="dot dot-danger" />
                      {int(byStatus.waiting_parts)} waiting on parts
                      <span aria-hidden="true">{UI_ICONS.chevronRight}</span>
                    </button>
                  )}
                </>
              ) : (
                <div className="empty mini">
                  <p>{sumQ.isError ? 'No data.' : 'No open work orders.'}</p>
                </div>
              )}
            </div>

            <div className="home-week">
              {sumQ.isPending ? (
                <div className="skel-rows">
                  {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} h={22} />)}
                </div>
              ) : weekThis && weekLast ? (
                <table className="hw-table">
                  <thead>
                    <tr>
                      <th scope="col"><span className="sr-only">Metric</span></th>
                      <th scope="col">Last week</th>
                      <th scope="col">This week</th>
                      <th scope="col"><span className="sr-only">Change</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {WEEK_ROWS.map((r) => {
                      const a = weekLast[r.key]
                      const b = weekThis[r.key]
                      return (
                        <tr key={r.key}>
                          <th scope="row">{r.label}</th>
                          <td>{a == null ? '—' : r.fmt(a)}</td>
                          <td className="hw-cur">{b == null ? '—' : r.fmt(b)}</td>
                          <td><Delta last={a} cur={b} better={r.better} /></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              ) : (
                <div className="empty mini"><p>Weekly numbers aren’t available.</p></div>
              )}
            </div>
          </div>

          {topUnits.length > 0 && (
            <div className="home-top">
              <h3>Top units this week <span>by spend</span></h3>
              <ul>
                {topUnits.slice(0, 5).map((u) => (
                  <li key={u.unit}>
                    <button type="button" className="home-top-row"
                      onClick={() => navigate('flota', { unit: u.unit })}>
                      <span className="home-top-unit">{u.unit}</span>
                      <span className="home-top-bar" aria-hidden="true">
                        <i style={{ width: `${(u.total / topMax) * 100}%` }} />
                      </span>
                      <span className="home-top-val">{money0(u.total)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="home-card-foot">
            <button type="button" className="home-foot-btn"
              onClick={() => navigate('workorders')}>
              View all work orders
            </button>
          </div>
        </section>

        <section className="card home-card home-pm" aria-labelledby="home-pm-h">
          <div className="home-card-head">
            <span className="home-card-ico" aria-hidden="true">{UI_ICONS.calendar}</span>
            <div className="home-card-title">
              <h2 id="home-pm-h">PMs due &amp; overdue</h2>
              <span>
                {dueQ.isPending ? 'Loading…'
                  : `${int(pending)} pending PM${pending === 1 ? '' : 's'}`}
              </span>
            </div>
          </div>

          {/* Barra: chips de estado + orden Days | Readings (como SR). */}
          <div className="home-pm-bar">
            <div className="home-pm-chips">
              {overdue > 0 && (
                <span className="home-chip is-danger">{int(overdue)} Overdue</span>
              )}
              {(dueQ.data?.counts.upcoming ?? 0) > 0 && (
                <span className="home-chip is-warn">
                  {int(dueQ.data?.counts.upcoming ?? 0)} Upcoming
                </span>
              )}
            </div>
            <div className="home-sort">
              <span className="home-sort-label" id="home-sort-l">Sort by</span>
              <Tabs aria-labelledby="home-sort-l"
                value={pmSort}
                onChange={(id) => setPmSort(id as PmSort)}
                tabs={[
                  { id: 'days', label: <span className="home-sort-opt">{UI_ICONS.clock}Days</span> },
                  { id: 'readings', label: <span className="home-sort-opt">{UI_ICONS.gauge}Readings</span> },
                ]} />
            </div>
          </div>

          <div className="home-pm-list">
            {dueQ.isPending ? (
              <div className="skel-rows">
                {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} h={50} />)}
              </div>
            ) : dueQ.isError ? (
              <div className="empty mini"><p>PM schedule couldn’t load.</p></div>
            ) : dueItems.length === 0 ? (
              <div className="empty mini home-pm-empty">
                <span aria-hidden="true">{UI_ICONS.check}</span>
                <p>Every unit is on schedule.</p>
              </div>
            ) : (
              <ul>
                {dueShown.map((it) => {
                  const over = it.status === 'overdue' || it.to_due < 0
                  const days = pmSort === 'days' && it.due_by !== 'days'
                    && it.to_due_days != null
                    ? (it.to_due_days < 0
                      ? `${int(Math.abs(it.to_due_days))} days over`
                      : `~${int(it.to_due_days)} days`)
                    : ''
                  return (
                    <li key={`${it.campaign}:${it.unit}`}>
                      <button type="button"
                        className={`home-pm-row${over ? ' is-over' : ' is-soon'}`}
                        onClick={() => navigate('flota', { unit: it.unit })}>
                        <span className="home-pm-ico" aria-hidden="true">
                          {over ? UI_ICONS.alert : CAMPAIGN_ICON[it.campaign]}
                        </span>
                        <span className="home-pm-main">
                          <strong>{it.unit}{it.model ? <em> · {it.model}</em> : null}</strong>
                          <span>{it.label}{it.next_due ? ` · due ${it.next_due}` : ''}</span>
                        </span>
                        <span className="home-pm-due">
                          <b>{dueLabel(it)}</b>
                          {days && <small>{days}</small>}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            {!pmAll && dueShown.length < dueItems.length && (
              <button type="button" className="home-foot-btn home-pm-more"
                onClick={() => setPmAll(true)}>
                Show all {int(dueItems.length)}
              </button>
            )}
          </div>

          <div className="home-card-foot">
            <button type="button" className="home-foot-btn"
              onClick={() => navigate('service-requests')}>
              View all service requests
            </button>
          </div>
        </section>
      </div>

      <HelpCenter open={guidesOpen} onClose={() => setGuidesOpen(false)}
        onNavigate={(sec) => navigate(sec)} />
    </div>
  )
}
