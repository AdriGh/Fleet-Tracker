import { useMemo } from 'react'
import type { TrendPoint } from '../api'

interface Props {
  points: TrendPoint[]
}

const W = 680
const H = 210
const ML = 34
const MR = 14
const MT = 14
const MB = 34
const PLOT_W = W - ML - MR
const PLOT_H = H - MT - MB

export default function TrendsChart({ points }: Props) {
  const days = useMemo(() => {
    const map = new Map<
      string,
      { label: string; safeSum: number; safeN: number; noDvir: number; unsafe: number }
    >()
    for (const p of points) {
      const e =
        map.get(p.date_label) ?? {
          label: p.date_label,
          safeSum: 0,
          safeN: 0,
          noDvir: 0,
          unsafe: 0,
        }
      e.safeSum += p.fleet_safe_pct
      e.safeN += 1
      e.noDvir += p.n_no_dvir
      e.unsafe += p.n_unsafe
      map.set(p.date_label, e)
    }
    return [...map.values()].map((e) => ({
      label: e.label,
      safe: e.safeSum / e.safeN,
      noDvir: e.noDvir,
      unsafe: e.unsafe,
    }))
  }, [points])

  if (days.length === 0) {
    return (
      <div className="empty mini">
        <p>Genera informes y aquí verás la tendencia del mes.</p>
      </div>
    )
  }

  const n = days.length
  const colW = PLOT_W / n
  const maxCount = Math.max(1, ...days.map((d) => d.noDvir + d.unsafe))
  const baseY = MT + PLOT_H
  const bw = Math.min(26, colW * 0.5)

  const x = (i: number) => ML + colW * (i + 0.5)
  const lineY = (pct: number) => MT + PLOT_H - (pct / 100) * PLOT_H

  const linePoints = days
    .map((d, i) => `${x(i)},${lineY(d.safe)}`)
    .join(' ')

  return (
    <div className="trends">
      <svg viewBox={`0 0 ${W} ${H}`} className="trends-svg">
        {/* Rejilla del eje de % */}
        {[0, 25, 50, 75, 100].map((p) => (
          <g key={p}>
            <line
              x1={ML}
              y1={lineY(p)}
              x2={W - MR}
              y2={lineY(p)}
              className="trends-grid"
            />
            <text x={ML - 6} y={lineY(p) + 3} className="trends-axis">
              {p}
            </text>
          </g>
        ))}

        {/* Barras de incidencias */}
        {days.map((d, i) => {
          const hNo = (d.noDvir / maxCount) * PLOT_H
          const hUn = (d.unsafe / maxCount) * PLOT_H
          return (
            <g key={d.label}>
              <rect
                x={x(i) - bw / 2}
                y={baseY - hNo}
                width={bw}
                height={hNo}
                className="bar-nodvir"
              />
              <rect
                x={x(i) - bw / 2}
                y={baseY - hNo - hUn}
                width={bw}
                height={hUn}
                className="bar-unsafe"
              />
              <text x={x(i)} y={H - 12} className="trends-xlabel">
                {d.label}
              </text>
            </g>
          )
        })}

        {/* Línea de % SAFE */}
        <polyline points={linePoints} className="trends-line" />
        {days.map((d, i) => (
          <g key={`p${d.label}`}>
            <circle cx={x(i)} cy={lineY(d.safe)} r={3.5}
              className="trends-dot" />
            <text x={x(i)} y={lineY(d.safe) - 8} className="trends-val">
              {d.safe.toFixed(0)}%
            </text>
          </g>
        ))}
      </svg>

      <div className="trends-legend">
        <span className="lg lg-safe">% Flota SAFE</span>
        <span className="lg lg-nodvir">NO DVIR</span>
        <span className="lg lg-unsafe">Unsafe</span>
      </div>
    </div>
  )
}
