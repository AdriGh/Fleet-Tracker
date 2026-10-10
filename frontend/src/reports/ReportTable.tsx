// Tabla del viewer / builder (v2.22 [G]). Encabezados ordenables, celdas
// tipadas (dinero, fechas, chips de estado, sí/no), fila de totales fija
// abajo y VIRTUALIZACIÓN por ventana para resultados grandes (hasta 50.000
// filas): se pintan solo las filas visibles + un margen, con filas de alto
// fijo y espaciadores arriba/abajo. table-layout fixed + <colgroup> para que
// los anchos no "salten" al scrollear.
import {
  useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties,
} from 'react'
import type { ReportCell, ReportDataRow, ReportRunColumn } from '../api'
import {
  cellText, chipTone, enumLabel, fmtMoney, fmtNumber, type ViewSort,
} from './model'

const ROW_H = 36
const OVERSCAN = 12
const VIRTUAL_FROM = 150

function colWidth(c: ReportRunColumn, rows: ReportDataRow[]): number {
  switch (c.type) {
    case 'money': return Math.max(116, c.label.length * 7.4 + 44)
    case 'number': return Math.max(96, c.label.length * 7.4 + 44)
    case 'date': return Math.max(118, c.label.length * 7.4 + 44)
    case 'datetime': return Math.max(176, c.label.length * 7.4 + 44)
    case 'bool': return Math.max(84, c.label.length * 7.4 + 44)
    default: {
      let longest = c.label.length + 4
      for (let i = 0; i < Math.min(rows.length, 60); i += 1) {
        const t = cellText(c, rows[i][c.key] ?? null)
        if (t.length > longest) longest = t.length
      }
      const chip = c.enum ? 18 : 0
      return Math.min(320, Math.max(110, longest * 7.3 + 28 + chip))
    }
  }
}

function Cell({ col, v }: { col: ReportRunColumn; v: ReportCell }) {
  if (v == null || v === '') return <span className="rpt-nil">—</span>
  if (col.enum) {
    const lbl = enumLabel(col, v) ?? String(v)
    return <span className={`rpt-chip t-${chipTone(v)}`}>{lbl}</span>
  }
  if (col.type === 'bool') {
    return v === true
      ? <span className="rpt-yes">Yes</span>
      : <span className="rpt-no">No</span>
  }
  if (col.type === 'money' && typeof v === 'number') {
    return <span className={v < 0 ? 'rpt-neg' : undefined}>{fmtMoney(v)}</span>
  }
  const text = cellText(col, v)
  return <span title={text.length > 28 ? text : undefined}>{text}</span>
}

function SortIcon({ dir }: { dir: 'asc' | 'desc' | null }) {
  return (
    <svg viewBox="0 0 12 16" aria-hidden="true" className={`rpt-sort ${dir ?? ''}`}>
      <path d="M6 2 2.5 6h7z" className="up" />
      <path d="M6 14 2.5 10h7z" className="down" />
    </svg>
  )
}

export interface ReportTableProps {
  columns: ReportRunColumn[]
  rows: ReportDataRow[]
  sort?: ViewSort | null
  onSort?: (s: ViewSort | null) => void
  totals?: Record<string, ReportCell | number | null> | null
  showTotals?: boolean
  maxHeight?: string
  label: string
  dim?: boolean
  // Filas para medir anchos (las del resultado, sin ordenar ni filtrar).
  widthRows?: ReportDataRow[]
}

export default function ReportTable({
  columns, rows, sort = null, onSort, totals, showTotals = false,
  maxHeight, label, dim = false, widthRows,
}: ReportTableProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(600)
  const raf = useRef(0)

  // Los anchos salen de las filas SIN ordenar/filtrar (`widthRows`): así
  // ordenar o filtrar no hace "bailar" las columnas.
  const sample = widthRows ?? rows
  const widths = useMemo(
    () => columns.map((c) => Math.round(colWidth(c, sample))),
    [columns, sample])
  const totalW = widths.reduce((s, w) => s + w, 0)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // El observer avisa una vez al empezar y en cada cambio de tamaño.
    const ro = new ResizeObserver(() => setViewH(el.clientHeight || 600))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Al cambiar el set de filas (filtro / reporte) se vuelve arriba: el
  // estado se ajusta durante el render (patrón "info del render previo") y
  // el DOM en un efecto.
  const resetKey = `${rows.length}|${columns.map((c) => c.key).join(',')}`
  const [prevKey, setPrevKey] = useState(resetKey)
  if (prevKey !== resetKey) {
    setPrevKey(resetKey)
    setScrollTop(0)
  }
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = 0
  }, [resetKey])

  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  function onScroll() {
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => {
      setScrollTop(scrollRef.current?.scrollTop ?? 0)
    })
  }

  const virtual = rows.length > VIRTUAL_FROM
  const start = virtual ? Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN) : 0
  const end = virtual
    ? Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN)
    : rows.length
  const padTop = start * ROW_H
  const padBottom = (rows.length - end) * ROW_H
  const slice = rows.slice(start, end)

  function clickSort(key: string) {
    if (!onSort) return
    if (!sort || sort.key !== key) onSort({ key, dir: 'asc' })
    else if (sort.dir === 'asc') onSort({ key, dir: 'desc' })
    else onSort(null)
  }

  const firstTextIdx = columns.findIndex((c) => !(c.type === 'money' || c.type === 'number'))
  const style = { maxHeight } as CSSProperties

  return (
    <div className={`rpt-scroll${dim ? ' is-dim' : ''}`} ref={scrollRef}
      onScroll={onScroll} style={style} tabIndex={0}
      role="region" aria-label={`${label} table`}>
      <table className="rpt-table" style={{ width: totalW }}
        aria-rowcount={rows.length + 1 + (showTotals ? 1 : 0)}>
        <colgroup>
          {widths.map((w, i) => <col key={columns[i].key} style={{ width: w }} />)}
        </colgroup>
        <thead>
          <tr aria-rowindex={1}>
            {columns.map((c) => {
              const dir = sort?.key === c.key ? sort.dir : null
              const num = c.type === 'money' || c.type === 'number'
              return (
                <th key={c.key} scope="col"
                  className={num ? 'num' : undefined}
                  aria-sort={dir === 'asc' ? 'ascending'
                    : dir === 'desc' ? 'descending' : undefined}>
                  {onSort ? (
                    <button type="button" className="rpt-th-btn"
                      onClick={() => clickSort(c.key)}
                      title={`Sort by ${c.label}`}>
                      <span className="rpt-th-lbl">{c.label}</span>
                      <SortIcon dir={dir} />
                    </button>
                  ) : <span className="rpt-th-lbl">{c.label}</span>}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {padTop > 0 && (
            <tr aria-hidden="true" className="rpt-pad" style={{ height: padTop }}>
              <td colSpan={columns.length} />
            </tr>
          )}
          {slice.map((r, i) => (
            <tr key={start + i} aria-rowindex={start + i + 2}>
              {columns.map((c) => (
                <td key={c.key}
                  className={c.type === 'money' || c.type === 'number' ? 'num' : undefined}>
                  <Cell col={c} v={r[c.key] ?? null} />
                </td>
              ))}
            </tr>
          ))}
          {padBottom > 0 && (
            <tr aria-hidden="true" className="rpt-pad" style={{ height: padBottom }}>
              <td colSpan={columns.length} />
            </tr>
          )}
        </tbody>
        {showTotals && totals && (
          <tfoot>
            <tr aria-rowindex={rows.length + 2}>
              {columns.map((c, i) => {
                const t = totals[c.key]
                const num = c.type === 'money' || c.type === 'number'
                let text = ''
                if (typeof t === 'number') {
                  text = c.type === 'money' ? fmtMoney(t) : fmtNumber(t)
                } else if (i === Math.max(0, firstTextIdx)) {
                  text = 'Total'
                }
                return (
                  <td key={c.key} className={num ? 'num' : undefined}>
                    {i === Math.max(0, firstTextIdx) && typeof t !== 'number'
                      ? <strong className="rpt-total-lbl">Total</strong>
                      : text}
                  </td>
                )
              })}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}
