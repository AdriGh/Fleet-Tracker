import { downloadBlockUrl, type RecentBlock, type RecentSort } from '../api'

interface Props {
  blocks: RecentBlock[]
  sort: RecentSort
  onSort: (sort: RecentSort) => void
  onSelect: (id: number) => void
  selectedId: number | null
}

const METRICS: { key: RecentSort; label: string }[] = [
  { key: 'n_reports', label: 'Reports' },
  { key: 'n_no_dvir', label: 'NO DVIR' },
  { key: 'n_unsafe', label: 'Unsafe' },
  { key: 'fleet_safe_pct', label: '% SAFE' },
]

export default function RecentBlocks({
  blocks,
  sort,
  onSort,
  onSelect,
  selectedId,
}: Props) {
  if (blocks.length === 0) {
    return (
      <div className="empty mini">
        <p>Aún no hay informes. Crea el primero con «Crear DVIR Report».</p>
      </div>
    )
  }

  return (
    <div className="table-wrap">
      <table className="recent-table">
        <thead>
          <tr>
            <th>Empresa</th>
            <th>Día</th>
            {METRICS.map((m) => (
              <th key={m.key}>
                <button
                  className={`sort-th ${sort === m.key ? 'active' : ''}`}
                  onClick={() => onSort(m.key)}
                >
                  {m.label}
                  <span className="caret">{sort === m.key ? '▼' : ''}</span>
                </button>
              </th>
            ))}
            <th aria-label="Descargar" />
          </tr>
        </thead>
        <tbody>
          {blocks.map((b) => (
            <tr
              key={b.id}
              className={selectedId === b.id ? 'selected' : ''}
              onClick={() => onSelect(b.id)}
            >
              <td>{b.company}</td>
              <td className="strong">{b.date_label}</td>
              <td>{b.n_reports}</td>
              <td className={b.n_no_dvir > 0 ? 'cell-warn' : ''}>
                {b.n_no_dvir}
              </td>
              <td className={b.n_unsafe > 0 ? 'cell-bad' : ''}>
                {b.n_unsafe}
              </td>
              <td className="strong">{b.fleet_safe_pct.toFixed(1)}%</td>
              <td className="dl-cell">
                <a
                  className="dl-btn"
                  href={downloadBlockUrl(b.id)}
                  title="Descargar Excel"
                  onClick={(e) => e.stopPropagation()}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round"
                    strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <path d="M7 10l5 5 5-5" />
                    <path d="M12 15V3" />
                  </svg>
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
