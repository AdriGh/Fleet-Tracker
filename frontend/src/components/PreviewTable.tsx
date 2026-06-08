import type { ReportGroup } from '../api'

interface Props {
  columns: string[]
  groups: ReportGroup[]
  dateLabel?: string
}

const TRUCK_SIDE = new Set(['Trk#', 'DVIR trk', 'Distance (mi)'])
// Pre-trip es por conductor: se fusiona hacia abajo como el nombre.
const DRIVER_SIDE = new Set(['Pre-trip'])
const STATUS_COLS = new Set(['DVIR trk', 'DVIR trl'])
const DUR_COLS = new Set(['Pre-trip'])
const DUR_THRESHOLD = 900
// Mismo formato que las celdas vacias (relleno azul).
const BLUE_COLS = new Set(['Trl#', 'Distance (mi)'])
// Columnas D..F que absorbe la celda "NO DVIR" al mergearse (colspan 3).
const NODVIR_MERGE = new Set(['Trl#', 'DVIR trl'])

function statusClass(value: string): string {
  if (value.includes('NO DVIR')) return 'nodvir'
  if (value === 'Safe') return 'safe'
  if (value === 'Resolved') return 'resolved'
  if (value === 'Unsafe') return 'unsafe'
  return ''
}

function durationSeconds(text: string): number {
  let total = 0
  const unit: Record<string, number> = { h: 3600, m: 60, s: 1 }
  for (const m of text.matchAll(/(\d+)\s*([hms])/g)) {
    total += Number(m[1]) * (unit[m[2]] ?? 0)
  }
  return total
}

export default function PreviewTable({ columns, groups, dateLabel }: Props) {
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
          {dateLabel && (
            <tr className="marker-row">
              <td colSpan={columns.length}>{dateLabel}</td>
            </tr>
          )}
          {groups.flatMap((group, gi) =>
            group.rows.map((row, ri) => {
              const noDvir = String(row['DVIR trk'] ?? '').includes('NO DVIR')
              return (
              <tr key={`${gi}-${ri}`}>
                {columns.map((col) => {
                  const value = String(row[col] ?? '')
                  const mergedDriver = col === 'Driver' || DRIVER_SIDE.has(col)
                  const mergedTruck = group.truck_merge && TRUCK_SIDE.has(col)

                  // Celdas fusionadas: solo se pintan en la primera fila.
                  if ((mergedDriver || mergedTruck) && ri > 0) return null
                  // NO DVIR: la celda "DVIR trk" se mergea de la D a la F.
                  if (noDvir && NODVIR_MERGE.has(col)) return null

                  const rowSpan =
                    (mergedDriver || mergedTruck) && group.rows.length > 1
                      ? group.rows.length
                      : undefined
                  const colSpan =
                    noDvir && col === 'DVIR trk' ? 3 : undefined

                  const classes: string[] = []
                  if (col === 'Driver') classes.push('driver')
                  if (STATUS_COLS.has(col) && value) {
                    const sc = statusClass(value)
                    if (sc) classes.push('status', sc)
                  }
                  if (DUR_COLS.has(col) && value && value !== '-') {
                    // '⚠ NO PRE-TRIP' en naranja (como NO DVIR); si no, rojo
                    // < 15 min y verde >= 15 min.
                    if (value.includes('NO PRE-TRIP')) {
                      classes.push('status', 'nodvir')
                    } else {
                      classes.push(
                        durationSeconds(value) < DUR_THRESHOLD
                          ? 'dur-low'
                          : 'dur-high',
                      )
                    }
                  }
                  if (value === '-' || BLUE_COLS.has(col)) classes.push('dash')

                  return (
                    <td
                      key={col}
                      rowSpan={rowSpan}
                      colSpan={colSpan}
                      className={classes.join(' ') || undefined}
                    >
                      {value}
                    </td>
                  )
                })}
              </tr>
              )
            }),
          )}
        </tbody>
      </table>
    </div>
  )
}
