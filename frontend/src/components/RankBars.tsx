interface Item {
  label: string
  value: number
  hint?: string
}

interface Props {
  items: Item[]
  tone?: 'accent' | 'danger' | 'ok' | 'mix'
  emptyText?: string
  onClick?: (label: string) => void
}

const TONE_MIX = ['accent', 'danger', 'ok', 'warn']

export default function RankBars({
  items,
  tone = 'accent',
  emptyText = 'No data.',
  onClick,
}: Props) {
  if (items.length === 0) {
    return <div className="empty mini"><p>{emptyText}</p></div>
  }
  const max = Math.max(1, ...items.map((i) => i.value))
  return (
    <ul className="rank-bars">
      {items.map((it, idx) => {
        const t = tone === 'mix' ? TONE_MIX[idx % TONE_MIX.length] : tone
        return (
          <li
            key={it.label}
            className={onClick ? 'clickable' : ''}
            onClick={onClick ? () => onClick(it.label) : undefined}
          >
            <span className="rank-label" title={it.label}>
              {it.label}
            </span>
            <span className="rank-track">
              <span
                className={`rank-fill bar-${t}`}
                style={{ width: `${(it.value / max) * 100}%` }}
              />
            </span>
            <span className="rank-value">
              {it.value}
              {it.hint && <em>{it.hint}</em>}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
