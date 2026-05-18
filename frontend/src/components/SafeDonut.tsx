interface Props {
  pct: number | null
  nBlocks: number
}

const R = 54
const C = 2 * Math.PI * R

export default function SafeDonut({ pct, nBlocks }: Props) {
  if (pct === null) {
    return (
      <div className="empty mini">
        <p>Sin datos del mes todavía.</p>
      </div>
    )
  }

  const filled = (Math.max(0, Math.min(100, pct)) / 100) * C

  return (
    <div className="donut">
      <svg viewBox="0 0 150 150" className="donut-svg">
        <circle cx="75" cy="75" r={R} className="donut-track" />
        <circle
          cx="75"
          cy="75"
          r={R}
          className="donut-fill"
          strokeDasharray={`${filled} ${C}`}
          transform="rotate(-90 75 75)"
        />
        <text x="75" y="72" className="donut-pct">
          {pct.toFixed(1)}%
        </text>
        <text x="75" y="92" className="donut-cap">
          SAFE
        </text>
      </svg>
      <p className="donut-note">
        Promedio de {nBlocks} {nBlocks === 1 ? 'día' : 'días'} del mes
      </p>
    </div>
  )
}
