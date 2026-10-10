// Dashboards gemelos de mantenimiento (fase H1): PM Tracker y DOT
// Inspections comparten ESTE tablero. Diseño nuevo (no hereda el PM
// viejo): tarjetas de status filtrables con %, donut, tabla editable
// inline, modal Add con odómetro en un clic y confirmación en cascada
// verde sobre la celda de la unidad ("PM updated" / "DOT updated").
import {
  useEffect, useMemo, useRef, useState, type CSSProperties,
} from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addMaintRecord, getMaintBoard, getUnitEngineHours, getUnitOdometer,
  logUnitEngineHours, setOpsStatus, setPMExcluded, setPMOverride,
  type MaintBoardResult, type MaintKind, type MaintRow, type OpsStatus,
} from '../api'
import { notifyOk, notifyErr } from '../toast'
import { useTerminals } from '../terminal'
import { Button, Tabs } from '../components/ds'
import MaintReport from '../components/MaintReport'
import Modal from '../components/Modal'
import PieChart from '../components/PieChart'
import CountUp from '../components/CountUp'
import Skeleton from '../components/Skeleton'
import UnitPicker from '../components/UnitPicker'
import { useUnitMatcher, type PickerUnit } from '../unitMatch'

type Props = { kind: MaintKind }

const KIND_META: Record<MaintKind, {
  title: string; sub: string; noun: string; add: string
}> = {
  pm: {
    title: 'PM Tracker',
    sub: 'Preventive maintenance by unit. Edit inline or add a completed PM.',
    noun: 'PM',
    add: 'Add PM',
  },
  dot: {
    title: 'DOT Inspections',
    sub: 'Annual DOT inspection by unit. Due 365 days after the last one.',
    noun: 'DOT',
    add: 'Add DOT',
  },
  // v2.22: PM del reefer por HORAS de motor — horómetro propio de cada
  // unidad, nunca el odómetro (el error de SquareRigger).
  reefer: {
    title: 'Reefer PM',
    sub: 'By engine hours, with a date fallback — whichever comes first.',
    noun: 'Reefer PM',
    add: 'Add PM',
  },
}

// Valor "a vencer" de una fila en SU unidad. El reefer usa horas mientras
// haya horómetro y venzan primero; si no, la fecha de respaldo (días).
function dueOf(kind: MaintKind, u: MaintRow):
  { v: number; unit: 'mi' | 'days' | 'hrs' } | null {
  if (kind === 'pm') return u.to_due == null ? null : { v: u.to_due, unit: 'mi' }
  if (kind === 'dot') {
    return u.to_due == null ? null : { v: u.to_due, unit: 'days' }
  }
  if (u.to_due != null && u.due_by !== 'days') {
    return { v: u.to_due, unit: 'hrs' }
  }
  if (u.to_due_days != null) return { v: u.to_due_days, unit: 'days' }
  return u.to_due != null ? { v: u.to_due, unit: 'hrs' } : null
}

// Urgencia comparable entre horas y días: en "ventanas de aviso".
function dueRatio(kind: MaintKind, u: MaintRow, d: MaintBoardResult): number {
  const x = dueOf(kind, u)
  if (!x) return Number.POSITIVE_INFINITY
  const w = x.unit === 'mi' ? d.upcoming_miles
    : x.unit === 'hrs' ? (d.upcoming_hours ?? 150) : d.upcoming_days
  return w ? x.v / w : x.v
}

const fmtHrs = (n: number | null | undefined) =>
  n == null ? '' : Math.round(n).toLocaleString('en-US')

const STATUS_META: Record<string, { label: string; color: string }> = {
  on_track: { label: 'On track', color: '#16a34a' },
  upcoming: { label: 'Upcoming', color: '#d99a00' },   // amarillo pato
  overdue: { label: 'Overdue', color: '#dc2626' },
  never: { label: 'Never performed', color: '#0891b2' },  // celeste oscuro
  no_meter: { label: 'No odometer', color: '#a1a1aa' },
  out_of_service: { label: 'Out of service', color: '#52525b' },
  in_shop: { label: 'In shop', color: '#2563eb' },
}
const STATUS_ORDER = ['overdue', 'upcoming', 'on_track', 'never',
                      'no_meter', 'in_shop', 'out_of_service']

const STROKE = {
  fill: 'none' as const, stroke: 'currentColor', strokeWidth: 1.8,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
}

function fmtMi(n: number | null | undefined): string {
  return n == null ? '' : n.toLocaleString('en-US')
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return `${Number(m)}/${Number(d)}/${y}`
}

function todayISO(): string {
  const t = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`
}

// Parsea una fecha en formato estadounidense (M/D/YYYY) a ISO (YYYY-MM-DD).
// Devuelve null si no es valida. Se usa en vez de <input type="date"> para que
// la edicion sea siempre US y no dependa del locale del navegador.
function usToISO(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return null
  const mo = Number(m[1]), da = Number(m[2]), yr = Number(m[3])
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null
  const p = (n: number) => String(n).padStart(2, '0')
  return `${yr}-${p(mo)}-${p(da)}`
}

export default function MaintBoardPage({ kind }: Props) {
  const meta = KIND_META[kind]
  const isHours = kind === 'reefer'
  const qc = useQueryClient()
  // "No odometer" no aplica al reefer: su medidor es el horómetro.
  const stMeta = (st: string) => (st === 'no_meter' && isHours
    ? { ...STATUS_META.no_meter, label: 'No hours reading' }
    : STATUS_META[st] ?? STATUS_META.never)
  // Registro / override / exclusión cambian lo que vence: el backend olvida
  // el TTL del sync de Service Requests y acá se refrescan badge y backlog
  // (si no, un "PM due" ya registrado seguía abierto y tentaba otra WO).
  const refreshSr = () => {
    void qc.invalidateQueries({ queryKey: ['service-requests'] })
  }
  const query = useQuery({
    queryKey: ['maint', kind],
    queryFn: () => getMaintBoard(kind),
    placeholderData: keepPreviousData,
  })
  const data = query.data

  const { terminalOf, labelOf, present } = useTerminals()
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [terminal, setTerminal] = useState('')
  const [q, setQ] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [eDate, setEDate] = useState('')
  const [eMiles, setEMiles] = useState('')
  const [savingRow, setSavingRow] = useState(false)
  const [showExcluded, setShowExcluded] = useState(false)
  // Unidad recién confirmada -> cascada verde + mensaje "PM updated".
  const [confirmed, setConfirmed] = useState<string | null>(null)
  const confirmTimer = useRef<number | null>(null)

  useEffect(() => () => {
    if (confirmTimer.current) window.clearTimeout(confirmTimer.current)
  }, [])

  function celebrate(unit: string) {
    setConfirmed(null)
    requestAnimationFrame(() => {
      setConfirmed(unit)
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current)
      confirmTimer.current = window.setTimeout(
        () => setConfirmed(null), 2000)
    })
  }

  const allUnits = useMemo(() => data?.units ?? [], [data])
  // Chips de terminal (solo si el tablero cruza más de una).
  const boardTerminals = useMemo(
    () => present(allUnits), [allUnits, present])

  // Si la terminal filtrada deja de existir (p.ej. se borró en Settings),
  // limpiar el filtro para no esconder filas tras un chip ausente.
  useEffect(() => {
    if (terminal && !boardTerminals.includes(terminal)) setTerminal('')
  }, [terminal, boardTerminals])
  const units = useMemo(
    () => allUnits.filter(
      (u) => !terminal || terminalOf(u.unit) === terminal),
    [allUnits, terminal, terminalOf])

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const u of units) c[u.status] = (c[u.status] ?? 0) + 1
    return c
  }, [units])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    return units.filter((u) =>
      (!statusFilter || u.status === statusFilter) &&
      (!s || u.unit.toLowerCase().includes(s) ||
        u.model.toLowerCase().includes(s)))
  }, [units, statusFilter, q])

  const pieData = useMemo(() =>
    STATUS_ORDER.filter((st) => counts[st])
      .map((st) => ({
        label: stMeta(st).label,
        value: counts[st],
        color: stMeta(st).color,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [counts, isHours])

  function startEdit(u: MaintRow) {
    setEditing(u.unit)
    setEDate(fmtDate(u.last_date ?? todayISO()))   // US: M/D/YYYY
    // Reefer: el campo es HORAS del último PM (si no, millas).
    const last = isHours ? u.last_hours : u.last_miles
    setEMiles(last != null ? String(last) : '')
  }

  async function saveEdit(u: MaintRow) {
    if (savingRow) return
    const iso = usToISO(eDate)
    if (!iso) {
      notifyErr('Invalid date', 'Use US format: MM/DD/YYYY')
      return
    }
    setSavingRow(true)
    try {
      await addMaintRecord(isHours
        ? { kind, unit: u.unit, date: iso,
            hours: eMiles ? Number(eMiles) : null }
        : { kind, unit: u.unit, date: iso,
            mileage: eMiles ? Number(eMiles) : null })
      setEditing(null)
      refreshSr()
      await qc.invalidateQueries({ queryKey: ['maint', kind] })
      celebrate(u.unit)
    } catch (e) {
      notifyErr(`Couldn't update ${meta.noun}`, e)
    } finally {
      setSavingRow(false)
    }
  }

  async function changeOps(u: MaintRow, status: OpsStatus) {
    try {
      await setOpsStatus(u.unit, status)
      await qc.invalidateQueries({ queryKey: ['maint'] })
      celebrate(u.unit)
    } catch (e) {
      notifyErr("Couldn't change status", e)
    }
  }

  async function exclude(u: MaintRow) {
    try {
      await setPMExcluded(u.unit, true)
      refreshSr()
      await qc.invalidateQueries({ queryKey: ['maint'] })
      notifyOk('Unit excluded', u.unit)
    } catch (e) {
      notifyErr("Couldn't exclude", e)
    }
  }

  async function include(unit: string) {
    try {
      await setPMExcluded(unit, false)
      refreshSr()
      await qc.invalidateQueries({ queryKey: ['maint'] })
    } catch (e) {
      notifyErr("Couldn't include", e)
    }
  }

  // v2.22 reefer: lectura manual del horómetro desde la celda. Si el backend
  // la rechaza por inverosímil (más baja que la anterior / > 24 h por día),
  // se ofrece guardarla igual (horómetro reseteado o controlador cambiado).
  async function saveHours(u: MaintRow, raw: string) {
    const v = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(v) || v < 0) return
    try {
      try {
        await logUnitEngineHours(u.unit, { value: v })
      } catch (e) {
        if (!window.confirm(
          `${e instanceof Error ? e.message : String(e)}\n\n`
          + 'Save this engine-hours reading anyway? (meter reset or controller replaced)')) {
          return
        }
        await logUnitEngineHours(u.unit, { value: v, force: true })
      }
      refreshSr()
      qc.invalidateQueries({ queryKey: ['unit-engine-hours', u.unit] })
      qc.invalidateQueries({ queryKey: ['unit-campaigns', u.unit] })
      await qc.invalidateQueries({ queryKey: ['maint'] })
      celebrate(u.unit)
    } catch (e) {
      notifyErr("Couldn't log engine hours", e)
    }
  }

  async function saveCurrent(u: MaintRow, raw: string) {
    try {
      await setPMOverride(
        u.unit, 'current_miles', raw === '' ? null : Number(raw))
      refreshSr()
      await qc.invalidateQueries({ queryKey: ['maint'] })
      celebrate(u.unit)
    } catch (e) {
      notifyErr("Couldn't update mileage", e)
    }
  }

  const total = units.length

  // ----- Panel "Fleet readiness" (rellena la columna izq. junto al donut) -----
  // Readiness = unidades que NO están vencidas ni sin servicio realizado.
  const readyN = Math.max(0, total - (counts.overdue ?? 0) - (counts.never ?? 0))
  const readyPct = total ? Math.round((readyN / total) * 100) : 0
  // Unidad más vencida y la próxima a vencer. El reefer mezcla horas y días:
  // se compara en "ventanas de aviso" (dueRatio), igual que el backend.
  const worst = useMemo(() => {
    if (!data) return null
    return units.filter((u) => u.status === 'overdue' && dueOf(kind, u))
      .sort((a, b) => dueRatio(kind, a, data) - dueRatio(kind, b, data))[0]
      ?? null
  }, [units, kind, data])
  const nextDue = useMemo(() => {
    if (!data) return null
    return units.filter((u) => {
      const d = dueOf(kind, u)
      return d != null && d.v >= 0
        && (u.status === 'upcoming' || u.status === 'on_track')
    }).sort((a, b) => dueRatio(kind, a, data) - dueRatio(kind, b, data))[0]
      ?? null
  }, [units, kind, data])
  const worstDue = worst ? dueOf(kind, worst) : null
  const nextDueV = nextDue ? dueOf(kind, nextDue) : null

  return (
    <div className="page page-wide">
      {query.isFetching && <div className="loadbar" aria-hidden="true" />}
      <div className="page-head">
        <div>
          <h1>{meta.title}</h1>
          <p className="page-sub">{meta.sub}</p>
        </div>
        <div className="head-actions">
          <Button variant="ghost" onClick={() => query.refetch()}
            loading={query.isFetching}
            icon={
              <svg viewBox="0 0 24 24" {...STROKE}>
                <path d="M20 11a8 8 0 1 0-2.3 6.3M20 5v6h-6" />
              </svg>
            }>
            Refresh
          </Button>
          <Button variant="ghost" disabled={units.length === 0}
            onClick={() => setReportOpen(true)} title="Download PDF report"
            icon={
              <svg viewBox="0 0 24 24" {...STROKE}>
                <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
              </svg>
            }>
            Export PDF
          </Button>
          <Button variant="primary" onClick={() => setAddOpen(true)}
            icon={
              <svg viewBox="0 0 24 24" {...STROKE}>
                <path d="M12 5v14M5 12h14" />
              </svg>
            }>
            {meta.add}
          </Button>
        </div>
      </div>

      {query.isPending ? (
        <div className="card"><div className="card-body skel-rows">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} h={34} />
          ))}
        </div></div>
      ) : !data?.available || allUnits.length === 0 ? (
        <div className="card"><div className="card-body mnt-empty">
          <h2>No units yet</h2>
          <p>
            {kind === 'pm'
              ? 'Drop the Fullbay fleet export at backend/pm.local.csv or add a PM manually.'
              : isHours
                ? 'Reefer units show up here automatically: trailers marked as reefer, units in your Lynx, Thermo King or Traccar feed, and any unit with an engine-hours reading. Record a reefer PM to start tracking one by hand.'
                : `Add the first DOT inspection with the ${meta.add} button.`}
          </p>
          <Button variant="primary" onClick={() => setAddOpen(true)}>
            {meta.add}
          </Button>
        </div></div>
      ) : (
        <>
          {/* ----- Filtro por terminal (Settings → Terminals) ----- */}
          {boardTerminals.length > 1 && (
            <div className="card">
              <div className="card-body filters-row">
                <Tabs
                  tabs={[{ id: '', label: 'All terminals' },
                    ...boardTerminals.map((t) => ({ id: t, label: labelOf(t) }))]}
                  value={terminal}
                  onChange={(id) => setTerminal(terminal === id ? '' : id)}
                />
              </div>
            </div>
          )}

          {/* ----- Resumen: tarjetas por status + donut ----- */}
          <div className="mnt-overview">
            <div className="mnt-left">
            <div className="mnt-cards">
              <button
                className={`mnt-card ${statusFilter === null ? 'on' : ''}`}
                onClick={() => setStatusFilter(null)}
              >
                <span className="mnt-card-n">{total}</span>
                <span className="mnt-card-label">All units</span>
                <span className="mnt-card-bar">
                  <i style={{ width: '100%', background: 'var(--accent)' }} />
                </span>
              </button>
              {STATUS_ORDER.filter((st) => counts[st]).map((st) => {
                const m = stMeta(st)
                const n = counts[st]
                const pct = total ? Math.round((n / total) * 1000) / 10 : 0
                return (
                  <button
                    key={st}
                    className={`mnt-card ${statusFilter === st ? 'on' : ''}`}
                    onClick={() =>
                      setStatusFilter(statusFilter === st ? null : st)}
                    style={{ '--mnt-c': m.color } as CSSProperties}
                  >
                    <span className="mnt-card-n">{n}</span>
                    <span className="mnt-card-label">{m.label}</span>
                    <span className="mnt-card-pct">{pct}%</span>
                    <span className="mnt-card-bar">
                      <i style={{ width: `${pct}%`, background: m.color }} />
                    </span>
                  </button>
                )
              })}
            </div>

            {/* Panel de salud de la flota: ocupa el espacio bajo las tarjetas */}
            <div className="card mnt-health">
              <div className="card-body">
                <div className="mnt-health-score">
                  <span className="mnt-health-eyebrow">Fleet readiness</span>
                  <span className="mnt-health-pct">
                    <CountUp value={readyPct} />%
                  </span>
                  <span className="mnt-health-note">
                    {readyN} of {total} {total === 1 ? 'unit' : 'units'} on schedule
                  </span>
                </div>
                <div className="mnt-health-bar" role="img"
                  aria-label={`${meta.noun} status distribution`}>
                  {pieData.map((s) => (
                    <span key={s.label} className="mnt-health-seg"
                      style={{
                        width: total ? `${(s.value / total) * 100}%` : '0%',
                        background: s.color,
                      }}
                      title={`${s.label}: ${s.value}`} />
                  ))}
                </div>
                <div className="mnt-health-chips">
                  <div className="mnt-hl mnt-hl-worst">
                    <span className="mnt-hl-k">Most overdue</span>
                    {worst && worstDue ? (
                      <span className="mnt-hl-v">
                        <strong>{worst.unit}</strong>
                        <em>-{fmtMi(Math.abs(Math.round(worstDue.v)))} {worstDue.unit}</em>
                      </span>
                    ) : (
                      <span className="mnt-hl-none">None — all current</span>
                    )}
                  </div>
                  <div className="mnt-hl mnt-hl-next">
                    <span className="mnt-hl-k">Next due</span>
                    {nextDue && nextDueV ? (
                      <span className="mnt-hl-v">
                        <strong>{nextDue.unit}</strong>
                        <em>{fmtMi(Math.round(nextDueV.v))} {nextDueV.unit}</em>
                      </span>
                    ) : (
                      <span className="mnt-hl-none">—</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
            </div>

            <div className="card mnt-donut">
              <div className="card-head"><h2>{meta.noun} status</h2></div>
              <div className="card-body">
                <PieChart data={pieData} size={172}
                  centerUnit={isHours ? 'units' : 'trucks'} />
              </div>
            </div>
          </div>

          {/* ----- Tabla editable ----- */}
          <div className="card">
            <div className="card-head mnt-table-head">
              <h2>
                {statusFilter
                  ? stMeta(statusFilter).label
                  : 'All units'}
                <span className="mnt-count">{filtered.length}</span>
              </h2>
              <input
                className="cell-input mnt-search"
                placeholder="Search unit, driver or model…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <div className="table-wrap">
              <table className="mnt-table">
                <thead>
                  <tr>
                    <th>Unit</th>
                    <th className="num">
                      {isHours ? 'Engine hours' : 'Current meter'}
                    </th>
                    <th className="num">Last {meta.noun}</th>
                    <th className="num">{isHours ? 'Hours' : 'Miles'}</th>
                    <th className="num">Next due</th>
                    <th className="num">
                      {kind === 'pm' ? 'Miles to due'
                        : isHours ? 'To due' : 'Days to due'}
                    </th>
                    <th>Status</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((u, i) => {
                    const sm = stMeta(u.status)
                    const isEdit = editing === u.unit
                    const isConfirmed = confirmed === u.unit
                    const due = dueOf(kind, u)
                    const span = !due ? 1
                      : due.unit === 'mi' ? data.interval_miles
                        : due.unit === 'hrs' ? (data.interval_hours ?? 1500)
                          : data.interval_days
                    const frac = !due ? 0
                      : Math.max(0, Math.min(1, due.v / (span || 1)))
                    return (
                      <tr key={u.unit} className={`s-${u.status}`}
                        style={{ animationDelay: `${Math.min(i, 14) * 28}ms` }}>
                        <td className={`mnt-unit ${isConfirmed ? 'is-confirmed' : ''}`}>
                          <strong>{u.unit}</strong>
                          {u.model && <em>{u.model}</em>}
                          {isConfirmed && (
                            <span className="mnt-confirm-msg">
                              {meta.noun} updated
                            </span>
                          )}
                        </td>
                        {kind === 'pm' ? (
                          <MeterCell row={u} onSave={saveCurrent} />
                        ) : isHours ? (
                          <HoursCell row={u} onSave={saveHours} />
                        ) : (
                          <td className="num">
                            <span className="mnt-meter">
                              {fmtMi(u.current_miles)}
                              {u.current_source &&
                                <i className="mnt-src">{u.current_source}</i>}
                            </span>
                          </td>
                        )}
                        {isEdit ? (
                          <>
                            <td className="num">
                              <input
                                type="text" inputMode="numeric"
                                className="cell-input mnt-input"
                                placeholder="MM/DD/YYYY"
                                value={eDate} autoFocus
                                onChange={(e) => setEDate(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') saveEdit(u)
                                  if (e.key === 'Escape') setEditing(null)
                                }}
                              />
                            </td>
                            <td className="num">
                              <input
                                type="number" className="cell-input mnt-input"
                                placeholder={isHours ? 'hours' : 'mileage'}
                                aria-label={isHours
                                  ? 'Engine hours at the PM' : 'Mileage at the PM'}
                                value={eMiles}
                                onChange={(e) => setEMiles(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') saveEdit(u)
                                  if (e.key === 'Escape') setEditing(null)
                                }}
                              />
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="num mnt-editable"
                              title={`Edit last ${meta.noun}`}
                              onClick={() => startEdit(u)}>
                              {fmtDate(u.last_date) || <span className="mnt-dash">add</span>}
                            </td>
                            <td className="num mnt-editable"
                              title={`Edit last ${meta.noun}`}
                              onClick={() => startEdit(u)}>
                              {(isHours ? fmtHrs(u.last_hours)
                                : fmtMi(u.last_miles)) ||
                                (u.last_date ? '' : <span className="mnt-dash">add</span>)}
                              {u.last_overridden && <i className="mnt-src">manual</i>}
                            </td>
                          </>
                        )}
                        <td className="num">
                          {kind === 'pm'
                            ? fmtMi(u.next_due_miles)
                            : isHours ? (
                              <span className="mnt-next2">
                                {u.next_due_hours != null && (
                                  <span>{fmtHrs(u.next_due_hours)} hrs</span>
                                )}
                                {u.next_due_date && (
                                  <i>{u.next_due_hours != null ? 'or ' : ''}
                                    {fmtDate(u.next_due_date)}</i>
                                )}
                              </span>
                            ) : fmtDate(u.next_due_date)}
                        </td>
                        <td className="num">
                          {due != null && (
                            <span className={`mnt-due ${due.v < 0 ? 'neg' : ''}`}
                              title={isHours && u.meter_missing
                                ? 'No engine-hours reading: due by date only'
                                : undefined}>
                              {due.v < 0 ? '-' : ''}
                              {fmtMi(Math.abs(Math.round(due.v)))}
                              <span className="mnt-due-unit">{due.unit}</span>
                              <span className="mnt-due-bar">
                                <i style={{
                                  width: `${Math.round(frac * 100)}%`,
                                  background: sm.color,
                                }} />
                              </span>
                            </span>
                          )}
                        </td>
                        <td>
                          {isEdit ? (
                            <span className="mnt-edit-actions">
                              <button className="btn btn-primary btn-xs"
                                disabled={savingRow}
                                onClick={() => saveEdit(u)}>
                                {savingRow ? 'Saving…' : 'Save'}
                              </button>
                              <button className="btn btn-ghost btn-xs"
                                onClick={() => setEditing(null)}>
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <select
                              className={`mnt-status s-${u.status}`}
                              value={u.ops_status}
                              title="Status (set Out of service / In shop manually)"
                              onChange={(e) =>
                                changeOps(u, e.target.value as OpsStatus)}
                            >
                              <option value="">{
                                u.ops_status ? 'Auto' : sm.label
                              }</option>
                              <option value="out_of_service">Out of service</option>
                              <option value="in_shop">In shop</option>
                            </select>
                          )}
                        </td>
                        <td className="mnt-actions">
                          <button className="mnt-icon" title={`Edit last ${meta.noun}`}
                            onClick={() => (isEdit ? setEditing(null) : startEdit(u))}>
                            <svg viewBox="0 0 24 24" {...STROKE}>
                              <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17l-1 3zM13.5 6.5l3 3" />
                            </svg>
                          </button>
                          <button className="mnt-icon" title="Exclude unit"
                            onClick={() => exclude(u)}>
                            <svg viewBox="0 0 24 24" {...STROKE}>
                              <circle cx="12" cy="12" r="8" />
                              <path d="M6.5 6.5l11 11" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {(data.excluded.length > 0) && (
            <div className="card">
              <button className="collapse-head"
                onClick={() => setShowExcluded((s) => !s)}>
                <span className={`collapse-chevron ${showExcluded ? 'open' : ''}`}>
                  <svg viewBox="0 0 24 24" {...STROKE}><path d="m9 6 6 6-6 6" /></svg>
                </span>
                Excluded units
                <span className="mnt-count">{data.excluded.length}</span>
              </button>
              {showExcluded && (
                <div className="card-body mnt-excluded">
                  {data.excluded.map((e) => (
                    <span key={e.unit} className="mnt-excluded-row">
                      <strong>{e.unit}</strong>
                      <em>{e.model}</em>
                      <button className="btn btn-ghost btn-xs"
                        onClick={() => include(e.unit)}>
                        Include
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {addOpen && (
        <AddModal
          kind={kind}
          units={allUnits}
          onClose={() => setAddOpen(false)}
          onSaved={(unit) => {
            setAddOpen(false)
            qc.invalidateQueries({ queryKey: ['maint', kind] })
            refreshSr()
            notifyOk(`${meta.noun} recorded`, unit)
            celebrate(unit)
          }}
        />
      )}

      {reportOpen && (
        <MaintReport
          kind={kind}
          title={meta.title}
          units={units}
          scope={terminal ? labelOf(terminal) : 'All terminals'}
          onClose={() => setReportOpen(false)}
        />
      )}
    </div>
  )
}

// Celda de odómetro actual editable (solo PM: override manual).
function MeterCell({ row, onSave }:
  { row: MaintRow; onSave: (u: MaintRow, raw: string) => void }) {
  const [edit, setEdit] = useState(false)
  const [val, setVal] = useState('')
  if (edit) {
    return (
      <td className="num">
        <input
          type="number" className="cell-input mnt-input" autoFocus
          defaultValue={row.current_miles ?? ''}
          placeholder="empty = ELD"
          onChange={(e) => setVal(e.target.value)}
          onBlur={() => setEdit(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { onSave(row, val); setEdit(false) }
            if (e.key === 'Escape') setEdit(false)
          }}
        />
      </td>
    )
  }
  return (
    <td className="num mnt-editable" title="Edit current mileage"
      onClick={() => { setVal(String(row.current_miles ?? '')); setEdit(true) }}>
      <span className="mnt-meter">
        {fmtMi(row.current_miles) || <span className="mnt-dash">set</span>}
        {row.current_source && <i className="mnt-src">{row.current_source}</i>}
      </span>
    </td>
  )
}

// v2.22 reefer: celda del horómetro (última lectura + fuente/fecha). Clic =
// registrar una lectura manual (Enter guarda, Escape cancela).
function HoursCell({ row, onSave }:
  { row: MaintRow; onSave: (u: MaintRow, raw: string) => void }) {
  const [edit, setEdit] = useState(false)
  const [val, setVal] = useState('')
  if (edit) {
    return (
      <td className="num">
        <input
          type="number" min={0} step="0.1" className="cell-input mnt-input"
          autoFocus aria-label={`Engine hours for ${row.unit}`}
          placeholder="hours" value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={() => setEdit(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { onSave(row, val); setEdit(false) }
            if (e.key === 'Escape') setEdit(false)
          }}
        />
      </td>
    )
  }
  return (
    <td className="num mnt-editable" title="Log an engine-hours reading"
      onClick={() => {
        setVal(row.current_hours != null ? String(row.current_hours) : '')
        setEdit(true)
      }}>
      <span className="mnt-meter">
        {row.current_hours != null
          ? `${fmtHrs(row.current_hours)} hrs`
          : <span className="mnt-dash">log</span>}
        {row.current_hours_source && (
          <i className="mnt-src"
            title={row.current_hours_date
              ? `Read ${fmtDate(row.current_hours_date)}` : undefined}>
            {row.current_hours_source}
          </i>
        )}
      </span>
    </td>
  )
}

// Modal Add PM / Add DOT: unit + date + mileage (con botón que trae el
// odómetro actual del ELD) + notes.
function AddModal({ kind, units, onClose, onSaved }: {
  kind: MaintKind
  units: MaintRow[]
  onClose: () => void
  onSaved: (unit: string) => void
}) {
  const meta = KIND_META[kind]
  // Opciones = las filas de ESTE board + la flota (GET /api/fleet: también
  // trailers y unidades que todavía no están en el board — registrar su
  // PRIMERA DOT es lo que las suma al board). Ante dos grafías gana la del
  // BOARD ('CAN1' del CSV aunque Samsara diga 'CAN 1'): el registro tiene
  // que caer en esa fila, no abrir otra. Con la flota caída o vacía el
  // picker se degrada a texto libre, como antes.
  const options = useMemo<PickerUnit[]>(
    () => units.map((u) => ({ unit: u.unit, model: u.model })), [units])
  const unitList = useUnitMatcher(undefined, options, true)
  const [unit, setUnit] = useState('')
  const [date, setDate] = useState(fmtDate(todayISO()))   // US: M/D/YYYY
  const [miles, setMiles] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [fetching, setFetching] = useState(false)
  const unitOk = unitList.isValid(unit)
  // v2.22 reefer: el campo es el horómetro (horas), nunca el odómetro.
  const isHours = kind === 'reefer'

  async function fillCurrent() {
    if (!unitOk || fetching) return
    setFetching(true)
    const u = unitList.canonical(unit)
    if (isHours) {
      try {
        const m = await getUnitEngineHours(u)
        if (m.latest) {
          setMiles(String(m.latest.value))
          notifyOk('Current engine hours',
            `${fmtHrs(m.latest.value)} hrs · ${m.latest.source} · ${fmtDate(m.latest.date)}`)
        } else {
          notifyErr('No engine hours', `No engine-hours reading for ${u} yet`)
        }
      } catch (e) {
        notifyErr("Couldn't fetch engine hours", e)
      } finally {
        setFetching(false)
      }
      return
    }
    try {
      const o = await getUnitOdometer(u)
      if (o.miles != null) {
        setMiles(String(o.miles))
        notifyOk('Current mileage', `${fmtMi(o.miles)} mi · ${o.source}`)
      } else {
        notifyErr('No odometer', `The ELD has no reading for ${u}`)
      }
    } catch (e) {
      notifyErr("Couldn't fetch mileage", e)
    } finally {
      setFetching(false)
    }
  }

  async function submit() {
    if (busy) return
    const iso = usToISO(date)
    if (!unit.trim() || !iso) {
      notifyErr('Missing fields',
        'Unit and a valid date (MM/DD/YYYY) are required')
      return
    }
    if (!unitOk) {
      notifyErr('Unknown unit', 'Pick a unit from the list')
      return
    }
    const u = unitList.canonical(unit)
    setBusy(true)
    try {
      await addMaintRecord(isHours
        ? { kind, unit: u, date: iso, hours: miles ? Number(miles) : null,
            notes: notes.trim() }
        : { kind, unit: u, date: iso, mileage: miles ? Number(miles) : null,
            notes: notes.trim() })
      onSaved(u)
    } catch (e) {
      notifyErr(`Couldn't save the ${meta.noun}`, e)
      setBusy(false)
    }
  }

  return (
    <Modal title={meta.add} onClose={onClose} width={460}>
      <div className="mnt-form">
        <label>
          <span>Unit #</span>
          <UnitPicker value={unit} onChange={setUnit} extraUnits={options}
            extraWins autoFocus placeholder="Pick a unit" />
        </label>
        <label>
          <span>Date</span>
          <input
            type="text" inputMode="numeric" className="cell-input"
            placeholder="MM/DD/YYYY" value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label>
          <span>{isHours ? 'Engine hours' : 'Mileage'}</span>
          <span className="mnt-miles-row">
            <input
              type="number" className="cell-input" placeholder="optional"
              min={0} step={isHours ? '0.1' : '1'}
              value={miles} onChange={(e) => setMiles(e.target.value)}
            />
            <button
              className="btn btn-ghost" disabled={!unitOk || fetching}
              title={isHours
                ? 'Use the latest engine-hours reading of this unit'
                : 'Fetch the current odometer from the ELD'}
              onClick={fillCurrent}
            >
              <svg viewBox="0 0 24 24" {...STROKE}
                className={fetching ? 'spin' : ''}>
                <circle cx="12" cy="13" r="8" />
                <path d="M12 13l3.5-3.5M12 5V2M9 2h6" />
              </svg>
              Current
            </button>
          </span>
        </label>
        <label>
          <span>Notes</span>
          <input
            className="cell-input" placeholder="optional" value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          />
        </label>
        <div className="mnt-form-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !unitOk}
            title={unitOk ? undefined : 'Pick a unit from the list'}
            onClick={submit}>
            {busy ? 'Saving…' : `Save ${meta.noun}`}
          </button>
        </div>
      </div>
    </Modal>
  )
}
