import React from 'react'

/**
 * KPI stat card: uppercase label, heavy tabular value, muted sub, and a 4px
 * left accent bar colored by tone. The dashboard's headline metric unit.
 */
type StatTone = 'neutral' | 'danger' | 'ok' | 'warn' | 'info' | 'accent'
type StatCardProps = {
  label?: React.ReactNode
  value?: React.ReactNode
  sub?: React.ReactNode
  tone?: StatTone
} & React.HTMLAttributes<HTMLDivElement>

export function StatCard({
  label,
  value,
  sub,
  tone = 'neutral',
  style = {},
  ...rest
}: StatCardProps) {
  const bar: Record<StatTone, string> = {
    neutral: 'var(--border-strong)',
    danger: 'var(--ui-danger)',
    ok: 'var(--ui-success)',
    warn: 'var(--ui-warn)',
    info: 'var(--ui-info)',
    accent: 'var(--accent)',
  }
  const valueColor: Record<string, string> = {
    danger: 'var(--ui-danger)',
    ok: 'var(--ui-success)',
    info: 'var(--ui-info)',
  }
  return (
    <div
      className={`ft-stat-card tone-${tone}`}
      style={{
        position: 'relative',
        overflow: 'hidden',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-sm)',
        padding: '16px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        ...style,
      }}
      {...rest}
    >
      <span
        aria-hidden="true"
        style={{ position: 'absolute', insetBlock: 0, left: 0, width: 4, background: bar[tone] }}
      />
      <span
        style={{
          fontSize: '0.74rem',
          fontWeight: 600,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: '1.7rem',
          fontWeight: 800,
          lineHeight: 1.1,
          letterSpacing: '-0.02em',
          fontVariantNumeric: 'tabular-nums',
          color: valueColor[tone] ?? 'var(--text)',
        }}
      >
        {value}
      </span>
      {sub != null && (
        <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>{sub}</span>
      )}
    </div>
  )
}
