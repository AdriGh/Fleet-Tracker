import { useEffect, useState } from 'react'
import { listDefects, type Defect } from '../api'

const STATUSES = ['Safe', 'Unsafe', 'Resolved']
const COMPANIES = ['CHASER', 'MCC']

function statusClass(status: string): string {
  if (status === 'Safe') return 'safe'
  if (status === 'Resolved') return 'resolved'
  if (status === 'Unsafe') return 'unsafe'
  return ''
}

export default function DefectsPage() {
  const [defects, setDefects] = useState<Defect[]>([])
  const [company, setCompany] = useState('')
  const [status, setStatus] = useState('')
  const [unit, setUnit] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(() => {
      listDefects({ company, status, unit: unit.trim() })
        .then(setDefects)
        .catch((e) => setError(e instanceof Error ? e.message : 'Error'))
    }, 200)
    return () => clearTimeout(t)
  }, [company, status, unit])

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Defectos</h1>
          <p className="page-sub">
            Defectos de vehículo y tráiler reportados en los DVIR.
          </p>
        </div>
      </div>

      {error && (
        <div className="banner error">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v5M12 16h.01" />
          </svg>
          <span>{error}</span>
        </div>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Defectos reportados</h2>
          <span className="sub">{defects.length} resultados</span>
        </div>
        <div className="card-body">
          <div className="filters-row">
            <select value={company}
              onChange={(e) => setCompany(e.target.value)}>
              <option value="">Todas las empresas</option>
              {COMPANIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <select value={status}
              onChange={(e) => setStatus(e.target.value)}>
              <option value="">Todos los estados</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <input
              className="cell-input"
              placeholder="Filtrar por unidad…"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
            />
          </div>

          {defects.length === 0 ? (
            <div className="empty mini">
              <p>No hay defectos para estos filtros.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="defects-table">
                <thead>
                  <tr>
                    <th>Día</th>
                    <th>Empresa</th>
                    <th>Conductor</th>
                    <th>Unidad</th>
                    <th>Estado</th>
                    <th>Defecto</th>
                  </tr>
                </thead>
                <tbody>
                  {defects.map((d, i) => (
                    <tr key={i}>
                      <td className="strong">{d.date_label}</td>
                      <td>{d.company}</td>
                      <td>{d.driver || '—'}</td>
                      <td>
                        {d.unit}
                        <span className="unit-kind">
                          {d.unit_kind === 'trailer' ? 'tráiler' : 'camión'}
                        </span>
                      </td>
                      <td>
                        <span className={`status-pill ${statusClass(d.status)}`}>
                          {d.status}
                        </span>
                      </td>
                      <td className="defect-detail">
                        {d.detail || '—'}
                        {d.mechanic_notes && (
                          <span className="mech-note">
                            Mecánico: {d.mechanic_notes}
                          </span>
                        )}
                      </td>
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
