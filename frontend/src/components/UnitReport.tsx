import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Defect } from '../api'
import { analyzeUnit } from '../defectGroups'
import {
  analyzeGroup, groupByCategory, SEVERITY_LABEL, type Severity,
} from '../defectAnalysis'
import { ZONE_LABEL, type Kind, type ZoneId } from '../truckZones'
import TruckDiagram from './TruckDiagram'

export interface ReportRow {
  unit: string
  kind: string
  company: string
  status: Record<string, number>
  records: Defect[]
}

const VIEW_LABEL: Record<string, string> = {
  top: 'Top', front: 'Front', side: 'Side',
}

function fmtDate(d: Date): string {
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// Una página = el reporte de una unidad.
function ReportPage({ row, generated }: { row: ReportRow; generated: string }) {
  const kind: Kind = row.kind === 'trailer' ? 'trailer' : 'truck'
  const VIEWS = kind === 'trailer'
    ? (['top', 'side'] as const)
    : (['top', 'front', 'side'] as const)
  const { groups, zones } = useMemo(
    () => analyzeUnit(row.records, kind), [row.records, kind])
  const cats = useMemo(
    () => groupByCategory(groups.map((g) => analyzeGroup(g, kind))),
    [groups, kind])

  const totalReports = groups.reduce((s, g) => s + g.count, 0)
  const sevCount = useMemo(() => {
    const c: Record<Severity, number> = { critical: 0, major: 0, minor: 0 }
    for (const g of cats) c[g.severity] += 1
    return c
  }, [cats])
  const affectedZones = useMemo(
    () => Object.entries(zones).sort((a, b) => b[1] - a[1]), [zones])
  const openCount = row.status.Open ?? 0

  // Auto-ajuste a una hoja: la caja .unit-report tiene alto fijo (una página).
  // Mido el alto natural del contenido y, si se pasa, lo ACHICO (con
  // compensación de ancho para que igual llene a lo ancho). Nunca agranda con
  // recorte: jamás se pierde un defecto. Si sobra, queda en escala 1.
  const innerRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const el = innerRef.current
    if (!el) return
    const PAGE = 1020 // alto útil de una hoja (~270 mm) en px CSS
    const h = el.scrollHeight
    setScale(h > PAGE ? Math.max(0.5, (PAGE * 0.98) / h) : 1)
  }, [row])
  const innerStyle = scale < 1
    ? {
        transform: `scale(${scale})`,
        transformOrigin: 'top left' as const,
        width: `${(100 / scale).toFixed(3)}%`,
      }
    : undefined

  return (
    <div className="unit-report" data-theme="light">
     <div className="ur-inner" ref={innerRef} style={innerStyle}>
      <header className="ur-head">
        <div className="ur-brand">
          <img src="/favicon.svg" alt="" className="ur-logo" />
          <div>
            <span className="ur-brand-name">Rigsmith</span>
            <span className="ur-brand-sub">DVIR compliance</span>
          </div>
        </div>
        <div className="ur-title">
          <h1>Unit Defect Report</h1>
          <span className="ur-gen">Generated {generated}</span>
        </div>
      </header>

      <div className="ur-meta">
        <div className="ur-chip ur-chip-lg">
          <span className="urc-label">Unit</span>
          <span className="urc-value">{row.unit}</span>
        </div>
        <div className="ur-chip">
          <span className="urc-label">Type</span>
          <span className="urc-value">{kind === 'trailer' ? 'Trailer' : 'Truck'}</span>
        </div>
        <div className="ur-chip">
          <span className="urc-label">Company</span>
          <span className="urc-value">{row.company}</span>
        </div>
        <div className="ur-chip">
          <span className="urc-label">Open</span>
          <span className="urc-value">{openCount}</span>
        </div>
        <div className="ur-chip">
          <span className="urc-label">Distinct defects</span>
          <span className="urc-value">{groups.length}</span>
        </div>
        <div className="ur-chip">
          <span className="urc-label">Total reports</span>
          <span className="urc-value">{totalReports}</span>
        </div>
      </div>

      <p className="ur-summary">
        {totalReports} report{totalReports === 1 ? '' : 's'} ·{' '}
        {groups.length} distinct defect{groups.length === 1 ? '' : 's'} in{' '}
        {cats.length} categor{cats.length === 1 ? 'y' : 'ies'}
        {cats.length > 0 && (
          <> · <strong className="sev-t-critical">{sevCount.critical} critical</strong>,{' '}
            <strong className="sev-t-major">{sevCount.major} major</strong>,{' '}
            <strong className="sev-t-minor">{sevCount.minor} minor</strong>.</>
        )}
      </p>

      <div className="ur-diagrams">
        {VIEWS.map((v) => (
          <figure key={v} className="ur-dgm">
            <TruckDiagram zones={zones} kind={kind} fixedView={v} />
            <figcaption>{VIEW_LABEL[v]} view</figcaption>
          </figure>
        ))}
      </div>

      {affectedZones.length > 0 && (
        <p className="ur-zoneline">
          <span className="ur-zoneline-key">Affected areas</span>
          {affectedZones.map(([z, n]) => (
            <span key={z} className="ur-zonechip">
              {ZONE_LABEL[z as ZoneId] ?? z} <em>{n}</em>
            </span>
          ))}
          <span className="ur-zoneline-note">red zones = reported defects</span>
        </p>
      )}

      <section className="ur-defects">
        <h2>
          Defect analysis
          <span className="ur-defects-sub">
            by category · {cats.length} area{cats.length === 1 ? '' : 's'}
          </span>
        </h2>
        {cats.length === 0 ? (
          <p className="ur-empty">
            No real defects (only unchanged re-inspections).
          </p>
        ) : (
          <ol className="ur-defect-list">
            {cats.map((c, i) => (
              <li key={i} className={`ur-defect sev-${c.severity}`}>
                <div className="ud-head">
                  <span className={`ud-sev sev-${c.severity}`}>
                    {SEVERITY_LABEL[c.severity]}
                  </span>
                  <span className="ud-cat">{c.category}</span>
                  {c.location && <span className="ud-loc">· {c.location}</span>}
                  <span className="ud-count">
                    {c.totalReports} report{c.totalReports === 1 ? '' : 's'}
                  </span>
                </div>
                <p className="ud-line">
                  <span className="ud-tag">Assessment</span>
                  <span className="ud-val">{c.assessment}</span>
                </p>
                <div className="ud-line ud-notes">
                  <span className="ud-tag">
                    Driver{c.notes.length > 1 ? ` (${c.notes.length})` : ''}
                  </span>
                  <ul className="ud-notelist">
                    {c.notes.map((n, j) => (
                      <li key={j}>
                        “{n.text}”
                        {n.count > 1 && <em> ×{n.count}</em>}
                      </li>
                    ))}
                  </ul>
                </div>
                <p className="ud-line">
                  <span className="ud-tag ud-tag-act">Action</span>
                  <span className="ud-val">{c.recommendation}</span>
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <footer className="ur-foot">
        <span>Generated by Rigsmith · {generated} · {row.unit}</span>
        <span>
          Assessments are auto-generated from driver DVIR notes; verify
          before maintenance action. Internal use only.
        </span>
      </footer>
     </div>
    </div>
  )
}

export default function UnitReport(
  { rows, onClose }: { rows: ReportRow[]; onClose: () => void },
) {
  const generated = useMemo(() => fmtDate(new Date()), [])

  // Disparar el diálogo de impresión una vez montado; al cerrarlo, desmontar.
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
      {rows.map((row) => (
        <ReportPage key={row.unit} row={row} generated={generated} />
      ))}
    </div>,
    document.body,
  )
}
