interface Props {
  label: string
  value: string | number
  sub?: string
  tone?: 'default' | 'danger' | 'ok' | 'warn' | 'accent' | 'info'
}

export default function StatCard({ label, value, sub, tone = 'default' }: Props) {
  return (
    <div className={`stat-card tone-${tone}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  )
}
