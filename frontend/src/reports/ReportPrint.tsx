// "Export PDF" del viewer (v2.22 [G]): mismo pipeline que PM compliance /
// invoices — un portal .print-root fuera de pantalla, window.print() a los
// 150 ms y cierre en afterprint (el diálogo de impresión guarda como PDF).
// Imprime LO QUE SE VE: columnas visibles, filtros y orden del viewer,
// totales y (en la vista Charts) los KPI + el gráfico. Más de 6 columnas =
// hoja apaisada (página con nombre en el CSS).
import { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import type { ReportCell, ReportDataRow, ReportRunColumn } from '../api'
import { cellText, chipTone, fmtMoney, fmtNumber } from './model'
import ReportCharts from './ReportCharts'
import type { ReportChartSpec } from '../api'

const MAX_PRINT_ROWS = 1000

export interface ReportPrintProps {
  title: string
  subtitle: string
  chips: string[]
  columns: ReportRunColumn[]
  rows: ReportDataRow[]
  totals: Record<string, ReportCell | number | null> | null
  withChart: boolean
  chart: ReportChartSpec | null
  nosum: Set<string>
  isAgg: boolean
  onClose: () => void
}

export default function ReportPrint({
  title, subtitle, chips, columns, rows, totals, withChart, chart, nosum,
  isAgg, onClose,
}: ReportPrintProps) {
  const generated = useMemo(() => new Date().toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }), [])

  useEffect(() => {
    const done = () => onClose()
    window.addEventListener('afterprint', done, { once: true })
    // Un poco más que el resto: el gráfico mide su ancho al montar.
    const t = window.setTimeout(() => window.print(), 250)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('afterprint', done)
    }
  }, [onClose])

  const landscape = columns.length > 6
  const shown = rows.slice(0, MAX_PRINT_ROWS)
  const firstText = Math.max(0, columns.findIndex((c) => c.type !== 'money' && c.type !== 'number'))

  return createPortal(
    <div className={`print-root rpt-print-root${landscape ? ' is-landscape' : ''}`}>
      <div className={`maint-report rpt-print${landscape ? ' is-landscape' : ''}`} data-theme="light">
        <header className="ur-head">
          <div className="ur-brand">
            <img src="/favicon.svg" alt="" className="ur-logo" />
            <div>
              <span className="ur-brand-name">Rigsmith</span>
              <span className="ur-brand-sub">Report</span>
            </div>
          </div>
          <div className="ur-title">
            <h1>{title}</h1>
            <span className="ur-gen">
              {subtitle ? `${subtitle} · ` : ''}
              {rows.length.toLocaleString('en-US')} row{rows.length === 1 ? '' : 's'}
              {' · '}Generated {generated}
            </span>
          </div>
        </header>

        {chips.length > 0 && (
          <div className="rpt-print-chips">
            {chips.map((c) => <span key={c}>{c}</span>)}
          </div>
        )}

        {withChart && (
          <div className="rpt-print-chart">
            <ReportCharts columns={columns} rows={rows} totals={totals}
              nosum={nosum} chart={chart} isAgg={isAgg} />
          </div>
        )}

        <table className={`mr-table rpt-print-table${columns.length > 10 ? ' is-dense' : ''}`}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={c.type === 'money' || c.type === 'number' ? 'num' : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => {
                  const v = r[c.key] ?? null
                  const num = c.type === 'money' || c.type === 'number'
                  return (
                    <td key={c.key} className={num ? 'num' : undefined}>
                      {c.enum && v != null && v !== ''
                        ? <span className={`rpt-pchip t-${chipTone(v)}`}>{cellText(c, v)}</span>
                        : cellText(c, v) || '—'}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
          {totals && (
            <tfoot>
              <tr>
                {columns.map((c, i) => {
                  const t = totals[c.key]
                  return (
                    <td key={c.key} className={c.type === 'money' || c.type === 'number' ? 'num' : undefined}>
                      {typeof t === 'number'
                        ? (c.type === 'money' ? fmtMoney(t) : fmtNumber(t))
                        : i === firstText ? 'Total' : ''}
                    </td>
                  )
                })}
              </tr>
            </tfoot>
          )}
        </table>
        {rows.length > MAX_PRINT_ROWS && (
          <p className="rpt-print-more">
            Showing the first {MAX_PRINT_ROWS.toLocaleString('en-US')} of{' '}
            {rows.length.toLocaleString('en-US')} rows. Download CSV or Excel for every row.
          </p>
        )}
        <p className="mr-foot">Rigsmith · {title}</p>
      </div>
    </div>,
    document.body,
  )
}
