interface Segment {
  label: string
  value: number
  tone: 'ok' | 'danger' | 'warn' | 'safe' | 'info'
}

interface Props {
  segments: Segment[]
  centerValue: string | number
  centerLabel: string
}

const R = 54
const C = 2 * Math.PI * R

export default function StatusDonut({
  segments,
  centerValue,
  centerLabel,
}: Props) {
  const total = segments.reduce((s, x) => s + x.value, 0)
  if (total === 0) {
    return <div className="empty mini"><p>No data for the breakdown.</p></div>
  }

  let offset = 0
  const arcs = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const len = (s.value / total) * C
      const arc = {
        tone: s.tone,
        dash: `${len} ${C - len}`,
        dashoffset: -offset,
      }
      offset += len
      return arc
    })

  return (
    <div className="status-donut">
      <svg viewBox="0 0 150 150" className="donut-svg">
        <circle cx="75" cy="75" r={R} className="donut-track" />
        {arcs.map((a, i) => (
          <circle
            key={i}
            cx="75"
            cy="75"
            r={R}
            className={`seg seg-${a.tone}`}
            strokeDasharray={a.dash}
            strokeDashoffset={a.dashoffset}
            transform="rotate(-90 75 75)"
          />
        ))}
        <text x="75" y="72" className="donut-pct">{centerValue}</text>
        <text x="75" y="92" className="donut-cap">{centerLabel}</text>
      </svg>
      <ul className="donut-legend">
        {segments.map((s) => {
          const pct = total ? Math.round((s.value / total) * 100) : 0
          return (
            <li key={s.label}>
              <span className="lg-row">
                <span className={`dot dot-${s.tone}`} />
                <span className="lg-label">{s.label}</span>
                <strong>{s.value}</strong>
                <span className="lg-pct">{pct}%</span>
              </span>
              <span className="lg-bar">
                <span className={`lg-fill fill-${s.tone}`}
                  style={{ width: `${pct}%` }} />
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
