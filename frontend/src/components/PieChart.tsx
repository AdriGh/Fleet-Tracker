// Donut chart (SVG) con leyenda en pills interactivas: al pasar el mouse por
// una pill se resalta su porción (y viceversa) y el centro muestra su valor.
import { useState } from 'react'

export interface PieSlice {
  label: string
  value: number
  color: string
}

export default function PieChart(
  { data, size = 210, centerUnit = 'trucks' }:
  { data: PieSlice[]; size?: number; centerUnit?: string },
) {
  const [hover, setHover] = useState<number | null>(null)
  const total = data.reduce((s, d) => s + d.value, 0)
  const HOVER_GROW = 5
  const stroke = Math.round(size * 0.17)
  // El radio deja sitio para el engrosamiento del arco en hover (+HOVER_GROW):
  // si no, el segmento resaltado se sale del viewBox y se ve "cortado".
  const r = (size - stroke) / 2 - HOVER_GROW / 2 - 2
  const C = 2 * Math.PI * r
  const c = size / 2

  let acc = 0
  const arcs = data.map((d, i) => {
    const frac = total ? d.value / total : 0
    const arc = frac * C
    const seg = { ...d, i, arc, offset: acc }
    acc += arc
    return seg
  }).filter((s) => s.value > 0)

  const center = hover != null ? data[hover] : null
  const dim = (i: number) => hover != null && hover !== i

  return (
    <div className="piechart">
      <div className="pie-donut"
        style={{ width: '100%', maxWidth: size, aspectRatio: '1 / 1' }}>
        <svg viewBox={`0 0 ${size} ${size}`} className="pie-svg" role="img"
          aria-label="PM status distribution">
          <g transform={`rotate(-90 ${c} ${c})`}>
            <circle cx={c} cy={c} r={r} fill="none"
              stroke="var(--surface-2)" strokeWidth={stroke} />
            {arcs.map((s) => (
              <circle key={s.i} cx={c} cy={c} r={r} fill="none"
                stroke={s.color}
                strokeWidth={hover === s.i ? stroke + HOVER_GROW : stroke}
                strokeDasharray={`${s.arc} ${C - s.arc}`}
                strokeDashoffset={-s.offset}
                strokeLinecap="butt"
                className="pie-arc"
                style={{ opacity: dim(s.i) ? 0.28 : 1 }}
                onMouseEnter={() => setHover(s.i)}
                onMouseLeave={() => setHover(null)} />
            ))}
          </g>
        </svg>
        <div className="pie-center">
          <strong>{center ? center.value : total}</strong>
          <span>{center ? center.label : centerUnit}</span>
        </div>
      </div>

      <ul className="pie-legend">
        {data.map((d, i) => (
          <li key={i}
            className={`pie-item${hover === i ? ' on' : ''}`}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}>
            <span className="pie-sw" style={{ background: d.color }} />
            <span className="pie-lbl">{d.label}</span>
            <span className="pie-val">{d.value}</span>
            <span className="pie-pct">
              {total ? Math.round((d.value / total) * 100) : 0}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
