import { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import PieChart from './PieChart'
import type { MaintRow } from '../api'

// Meta/formatos espejados de MaintBoardPage (duplicados a proposito: mantiene
// el reporte autocontenido y evita un import circular con la vista).
const STATUS_META: Record<string, { label: string; color: string }> = {
  on_track: { label: 'On track', color: '#16a34a' },
  upcoming: { label: 'Upcoming', color: '#d97706' },
  overdue: { label: 'Overdue', color: '#dc2626' },
  never: { label: 'Never performed', color: '#71717a' },
  no_meter: { label: 'No odometer', color: '#a1a1aa' },
  out_of_service: { label: 'Out of service', color: '#52525b' },
  in_shop: { label: 'In shop', color: '#2563eb' },
}
const STATUS_ORDER = ['overdue', 'upcoming', 'on_track', 'never',
  'no_meter', 'in_shop', 'out_of_service']

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return `${Number(m)}/${Number(d)}/${y}`
}
function fmtMi(n: number | null | undefined): string {
  return n == null ? '' : n.toLocaleString('en-US')
}
function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

export default function MaintReport({ kind, title, units, scope, onClose }: {
  kind: 'pm' | 'dot'
  title: string
  units: MaintRow[]
  scope: string          // 'All terminals' o el label de la terminal filtrada
  onClose: () => void
}) {
  const noun = kind === 'pm' ? 'PM' : 'DOT'
  const generated = useMemo(() => new Date().toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }), [])

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const u of units) c[u.status] = (c[u.status] ?? 0) + 1
    return c
  }, [units])
  const total = units.length
  const pieData = useMemo(() =>
    STATUS_ORDER.filter((st) => counts[st]).map((st) => ({
      label: STATUS_META[st].label, value: counts[st],
      color: STATUS_META[st].color,
    })), [counts])

  // Vencidos primero (rojo arriba), despues por estado y numero de unidad.
  const sorted = useMemo(() => [...units].sort((a, b) =>
    (STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status))
    || a.unit.localeCompare(b.unit)), [units])

  useEffect(() => {
    const done = () => onClose()
    window.addEventListener('afterprint', done, { once: true })
    const t = window.setTimeout(() => window.print(), 150)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('afterprint', done)
    }
  }, [onClose])

  return createPortal(
    <div className="print-root">
      <div className="maint-report" data-theme="light">
        <header className="ur-head">
          <div className="ur-brand">
            <img src="/favicon.svg" alt="" className="ur-logo" />
            <div>
              <span className="ur-brand-name">Fleet Tracker</span>
              <span className="ur-brand-sub">Maintenance compliance</span>
            </div>
          </div>
          <div className="ur-title">
            <h1>{title}</h1>
            <span className="ur-gen">
              {scope} · {total} unit{total === 1 ? '' : 's'} ·
              {' '}Generated {generated}
            </span>
          </div>
        </header>

        {/* Resumen: tarjetas por estado + donut (igual que el dashboard) */}
        <section className="mr-overview">
          <div className="mr-cards">
            <div className="mr-card mr-card-all">
              <span className="mr-card-n">{total}</span>
              <span className="mr-card-label">All units</span>
            </div>
            {STATUS_ORDER.filter((st) => counts[st]).map((st) => {
              const m = STATUS_META[st]
              const n = counts[st]
              const pct = total ? Math.round((n / total) * 1000) / 10 : 0
              return (
                <div className="mr-card" key={st}>
                  <span className="mr-card-pct">{pct}%</span>
                  <span className="mr-card-n">{n}</span>
                  <span className="mr-card-label">{m.label}</span>
                  <span className="mr-card-bar">
                    <i style={{ width: `${pct}%`, background: m.color }} />
                  </span>
                </div>
              )
            })}
          </div>
          <div className="mr-donut">
            <PieChart data={pieData} size={150} centerUnit="trucks" />
          </div>
        </section>

        {/* Tabla */}
        <table className="mr-table">
          <thead>
            <tr>
              <th>Unit</th>
              <th>Driver</th>
              <th className="num">Current meter</th>
              <th className="num">Last {noun}</th>
              <th className="num">
                {kind === 'pm' ? 'Next due (mi)' : 'Next due'}
              </th>
              <th className="num">
                {kind === 'pm' ? 'Miles to due' : 'Days to due'}
              </th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((u) => {
              const sm = STATUS_META[u.status] ?? STATUS_META.never
              const neg = u.to_due != null && u.to_due < 0
              return (
                <tr key={u.unit}
                  className={u.status === 'overdue' ? 'is-overdue' : ''}>
                  <td>
                    <strong>{u.unit}</strong>
                    {u.model && <span className="mr-model">{u.model}</span>}
                  </td>
                  <td>{u.driver || '—'}</td>
                  <td className="num">{fmtMi(u.current_miles) || '—'}</td>
                  <td className="num">{fmtDate(u.last_date) || '—'}</td>
                  <td className="num">
                    {kind === 'pm'
                      ? (fmtMi(u.next_due_miles) || '—')
                      : (fmtDate(u.next_due_date) || '—')}
                  </td>
                  <td className={`num ${neg ? 'neg' : ''}`}>
                    {u.to_due == null ? '—'
                      : `${neg ? '-' : ''}${fmtMi(Math.abs(u.to_due))}`}
                  </td>
                  <td>
                    <span className="mr-pill" style={{
                      color: sm.color, background: hexA(sm.color, 0.12),
                    }}>{sm.label}</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        <footer className="mr-foot">
          Generated by Fleet Tracker · {generated} · Internal use only.
        </footer>
      </div>
    </div>,
    document.body,
  )
}
