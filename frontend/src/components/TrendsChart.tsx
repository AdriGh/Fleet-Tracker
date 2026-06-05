import { useMemo } from 'react'
import type { TrendPoint } from '../api'

interface Props {
  points: TrendPoint[]
}

const W = 680
const H = 200
const ML = 28
const MR = 12
const MT = 22
const MB = 30
const PLOT_W = W - ML - MR
const PLOT_H = H - MT - MB

export default function TrendsChart({ points }: Props) {
  const days = useMemo(() => {
    const map = new Map<string, number>()
    for (const p of points) {
      const k = p.date_label
      map.set(k, (map.get(k) ?? 0) + p.n_no_dvir + p.n_unsafe)
    }
    const key = (l: string) => {
      const [mo, da] = l.split('.').map(Number)
      return (mo || 0) * 100 + (da || 0)
    }
    return [...map.entries()]
      .sort((a, b) => key(a[0]) - key(b[0]))
      .map(([label, count]) => ({ label, count }))
  }, [points])

  if (days.length === 0) {
    return (
      <div className="empty mini">
        <p>Generate reports and you'll see the monthly trend here.</p>
      </div>
    )
  }

  const n = days.length
  const colW = PLOT_W / n
  const maxCount = Math.max(1, ...days.map((d) => d.count))
  const baseY = MT + PLOT_H
  const bw = Math.min(28, colW * 0.62)
  const x = (i: number) => ML + colW * (i + 0.5)

  return (
    <div className="trends">
      <svg viewBox={`0 0 ${W} ${H}`} className="trends-svg">
        <line x1={ML} y1={baseY} x2={W - MR} y2={baseY} className="trends-grid" />
        {days.map((d, i) => {
          const h = (d.count / maxCount) * PLOT_H
          const showLabel = n <= 16 || i % 2 === 0
          return (
            <g key={d.label}>
              <rect
                x={x(i) - bw / 2}
                y={baseY - h}
                width={bw}
                height={Math.max(h, d.count > 0 ? 2 : 0)}
                rx={3}
                className="bar-accent"
              />
              {d.count > 0 && (
                <text x={x(i)} y={baseY - h - 6} className="bar-value">
                  {d.count}
                </text>
              )}
              {showLabel && (
                <text x={x(i)} y={H - 10} className="trends-xlabel">
                  {d.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <p className="chart-caption">Incidents (NO DVIR + Unsafe) per day</p>
    </div>
  )
}
