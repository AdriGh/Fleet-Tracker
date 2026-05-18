import type { ReportGroup } from '../api'

interface Props {
  columns: string[]
  groups: ReportGroup[]
}

const TRUCK_SIDE = new Set([
  'Trk#',
  'DVIR trk',
  'Duration trk',
  'DOT Issues trk',
  'Fullbay trk',
])
const STATUS_COLS = new Set(['DVIR trk', 'DVIR trl'])

function statusClass(value: string): string {
  if (value.includes('NO DVIR')) return 'nodvir'
  if (value === 'Safe') return 'safe'
  if (value === 'Resolved') return 'resolved'
  if (value === 'Unsafe') return 'unsafe'
  return ''
}

export default function PreviewTable({ columns, groups }: Props) {
  return (
    <div className="table-wrap">
      <table className="preview">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.flatMap((group, gi) =>
            group.rows.map((row, ri) => (
              <tr key={`${gi}-${ri}`}>
                {columns.map((col) => {
                  const value = String(row[col] ?? '')
                  const mergedDriver = col === 'Driver'
                  const mergedTruck = group.truck_merge && TRUCK_SIDE.has(col)

                  // Celdas fusionadas: solo se pintan en la primera fila.
                  if ((mergedDriver || mergedTruck) && ri > 0) return null

                  const rowSpan =
                    (mergedDriver || mergedTruck) && group.rows.length > 1
                      ? group.rows.length
                      : undefined

                  const classes: string[] = []
                  if (col === 'Driver') classes.push('driver')
                  if (STATUS_COLS.has(col) && value) {
                    const sc = statusClass(value)
                    if (sc) classes.push('status', sc)
                  }
                  if (value === '-') classes.push('dash')

                  return (
                    <td
                      key={col}
                      rowSpan={rowSpan}
                      className={classes.join(' ') || undefined}
                    >
                      {value}
                    </td>
                  )
                })}
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  )
}
