import type { MissingResponse } from '../api'

interface Props {
  data: MissingResponse
  onSelect: (driver: string) => void
}

function monthLabel(month: string | null): string {
  if (!month) return ''
  const [y, m] = month.split('-')
  const names = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
    'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  ]
  return `${names[Number(m) - 1] ?? m} ${y}`
}

export default function MissingDrivers({ data, onSelect }: Props) {
  if (!data.month || data.drivers.length === 0) {
    return (
      <div className="empty mini">
        <p>Sin conductores con DVIR pendiente este mes.</p>
      </div>
    )
  }

  const max = Math.max(...data.drivers.map((d) => d.misses), 1)

  return (
    <div className="missing">
      <p className="missing-month">{monthLabel(data.month)}</p>
      <ol className="missing-list">
        {data.drivers.map((d, i) => (
          <li key={d.driver}>
            <button
              className="missing-row"
              onClick={() => onSelect(d.driver)}
              title="Ver ficha del conductor"
            >
              <span className="rank">{i + 1}</span>
              <span className="missing-name">{d.driver}</span>
              <span className="missing-bar">
                <span
                  className="missing-fill"
                  style={{ width: `${(d.misses / max) * 100}%` }}
                />
              </span>
              <span className="missing-count">{d.misses}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}
