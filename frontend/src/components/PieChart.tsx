// Gráfico de torta simple (SVG) con leyenda (valor + %).
export interface PieSlice {
  label: string
  value: number
  color: string
}

export default function PieChart(
  { data, size = 190 }: { data: PieSlice[]; size?: number },
) {
  const total = data.reduce((s, d) => s + d.value, 0)
  const r = size / 2
  const visible = data.filter((d) => d.value > 0)

  let acc = -Math.PI / 2 // arranca arriba
  const slices = visible.map((d) => {
    const frac = d.value / total
    const a0 = acc
    const a1 = acc + frac * 2 * Math.PI
    acc = a1
    const large = frac > 0.5 ? 1 : 0
    const x0 = r + r * Math.cos(a0)
    const y0 = r + r * Math.sin(a0)
    const x1 = r + r * Math.cos(a1)
    const y1 = r + r * Math.sin(a1)
    const path = `M ${r} ${r} L ${x0.toFixed(2)} ${y0.toFixed(2)} `
      + `A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`
    return { path, color: d.color }
  })

  return (
    <div className="piechart">
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}
        className="pie-svg" role="img" aria-label="PM status distribution">
        {total === 0 ? (
          <circle cx={r} cy={r} r={r} fill="var(--surface-2)" />
        ) : visible.length === 1 ? (
          <circle cx={r} cy={r} r={r} fill={visible[0].color} />
        ) : (
          slices.map((s, i) => (
            <path key={i} d={s.path} fill={s.color}
              stroke="var(--surface)" strokeWidth="1.5" />
          ))
        )}
      </svg>
      <ul className="pie-legend">
        {data.map((d, i) => (
          <li key={i}>
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
