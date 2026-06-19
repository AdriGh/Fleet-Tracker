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
  addMaintRecord, getMaintBoard, getUnitOdometer, setOpsStatus,
  setPMExcluded, setPMOverride,
  type MaintKind, type MaintRow, type OpsStatus,
} from '../api'
import { notifyOk, notifyErr } from '../toast'
import { useTerminals } from '../terminal'
import { Button, Tabs } from '../components/ds'
import MaintReport from '../components/MaintReport'
import Modal from '../components/Modal'
import PieChart from '../components/PieChart'
import CountUp from '../components/CountUp'
import Skeleton from '../components/Skeleton'

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
}

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
  const qc = useQueryClient()
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
        label: STATUS_META[st].label,
        value: counts[st],
        color: STATUS_META[st].color,
      })), [counts])

  function startEdit(u: MaintRow) {
    setEditing(u.unit)
    setEDate(fmtDate(u.last_date ?? todayISO()))   // US: M/D/YYYY
    setEMiles(u.last_miles != null ? String(u.last_miles) : '')
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
      await addMaintRecord({
        kind, unit: u.unit, date: iso,
        mileage: eMiles ? Number(eMiles) : null,
      })
      setEditing(null)
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
      await qc.invalidateQueries({ queryKey: ['maint'] })
      notifyOk('Unit excluded', u.unit)
    } catch (e) {
      notifyErr("Couldn't exclude", e)
    }
  }

  async function include(unit: string) {
    try {
      await setPMExcluded(unit, false)
      await qc.invalidateQueries({ queryKey: ['maint'] })
    } catch (e) {
      notifyErr("Couldn't include", e)
    }
  }

  async function saveCurrent(u: MaintRow, raw: string) {
    try {
      await setPMOverride(
        u.unit, 'current_miles', raw === '' ? null : Number(raw))
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
  const dueUnit = kind === 'pm' ? 'mi' : 'days'
  // Unidad más vencida (to_due más negativo) y la próxima a vencer (menor +).
  const worst = useMemo(() =>
    units.filter((u) => u.status === 'overdue' && u.to_due != null)
      .sort((a, b) => (a.to_due as number) - (b.to_due as number))[0] ?? null,
    [units])
  const nextDue = useMemo(() =>
    units.filter((u) => u.to_due != null && (u.to_due as number) >= 0 &&
      (u.status === 'upcoming' || u.status === 'on_track'))
      .sort((a, b) => (a.to_due as number) - (b.to_due as number))[0] ?? null,
    [units])

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
                const m = STATUS_META[st]
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
                    {worst ? (
                      <span className="mnt-hl-v">
                        <strong>{worst.unit}</strong>
                        <em>-{fmtMi(Math.abs(worst.to_due as number))} {dueUnit}</em>
                      </span>
                    ) : (
                      <span className="mnt-hl-none">None — all current</span>
                    )}
                  </div>
                  <div className="mnt-hl mnt-hl-next">
                    <span className="mnt-hl-k">Next due</span>
                    {nextDue ? (
                      <span className="mnt-hl-v">
                        <strong>{nextDue.unit}</strong>
                        <em>{fmtMi(nextDue.to_due as number)} {dueUnit}</em>
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
                <PieChart data={pieData} size={172} centerUnit="trucks" />
              </div>
            </div>
          </div>

          {/* ----- Tabla editable ----- */}
          <div className="card">
            <div className="card-head mnt-table-head">
              <h2>
                {statusFilter
                  ? STATUS_META[statusFilter].label
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
                    <th className="num">Current meter</th>
                    <th className="num">Last {meta.noun}</th>
                    <th className="num">Miles</th>
                    <th className="num">Next due</th>
                    <th className="num">
                      {kind === 'pm' ? 'Miles to due' : 'Days to due'}
                    </th>
                    <th>Status</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((u, i) => {
                    const sm = STATUS_META[u.status] ?? STATUS_META.never
                    const isEdit = editing === u.unit
                    const isConfirmed = confirmed === u.unit
                    const frac = u.to_due == null ? 0 : Math.max(0,
                      Math.min(1, u.to_due / (kind === 'pm'
                        ? data.interval_miles : data.interval_days)))
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
                                placeholder="mileage" value={eMiles}
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
                              {fmtMi(u.last_miles) ||
                                (u.last_date ? '' : <span className="mnt-dash">add</span>)}
                              {u.last_overridden && <i className="mnt-src">manual</i>}
                            </td>
                          </>
                        )}
                        <td className="num">
                          {kind === 'pm'
                            ? fmtMi(u.next_due_miles)
                            : fmtDate(u.next_due_date)}
                        </td>
                        <td className="num">
                          {u.to_due != null && (
                            <span className={`mnt-due ${u.to_due < 0 ? 'neg' : ''}`}>
                              {u.to_due < 0 ? '-' : ''}
                              {fmtMi(Math.abs(u.to_due))}
                              <span className="mnt-due-unit">
                                {kind === 'pm' ? 'mi' : 'days'}
                              </span>
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
          placeholder="empty = Samsara"
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

// Modal Add PM / Add DOT: unit + date + mileage (con botón que trae el
// odómetro actual de Samsara) + notes.
function AddModal({ kind, units, onClose, onSaved }: {
  kind: MaintKind
  units: MaintRow[]
  onClose: () => void
  onSaved: (unit: string) => void
}) {
  const meta = KIND_META[kind]
  const [unit, setUnit] = useState('')
  const [date, setDate] = useState(fmtDate(todayISO()))   // US: M/D/YYYY
  const [miles, setMiles] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [fetching, setFetching] = useState(false)

  async function fillCurrent() {
    if (!unit.trim() || fetching) return
    setFetching(true)
    try {
      const o = await getUnitOdometer(unit.trim())
      if (o.miles != null) {
        setMiles(String(o.miles))
        notifyOk('Current mileage', `${fmtMi(o.miles)} mi · ${o.source}`)
      } else {
        notifyErr('No odometer', `Samsara has no reading for ${unit.trim()}`)
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
    setBusy(true)
    try {
      await addMaintRecord({
        kind, unit: unit.trim(), date: iso,
        mileage: miles ? Number(miles) : null,
        notes: notes.trim(),
      })
      onSaved(unit.trim())
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
          <input
            className="cell-input" list="mnt-units" autoFocus
            placeholder="e.g. CF2246" value={unit}
            onChange={(e) => setUnit(e.target.value)}
          />
          <datalist id="mnt-units">
            {units.map((u) => <option key={u.unit} value={u.unit} />)}
          </datalist>
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
          <span>Mileage</span>
          <span className="mnt-miles-row">
            <input
              type="number" className="cell-input" placeholder="optional"
              value={miles} onChange={(e) => setMiles(e.target.value)}
            />
            <button
              className="btn btn-ghost" disabled={!unit.trim() || fetching}
              title="Fetch the current odometer from Samsara"
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
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? 'Saving…' : `Save ${meta.noun}`}
          </button>
        </div>
      </div>
    </Modal>
  )
}
