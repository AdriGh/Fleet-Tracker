import React from 'react'

/**
 * Status pill for fleet/DVIR states. Uses the decoupled UI semantic colors
 * (legible in dark), not the locked Excel cell fills.
 */
type PillStatus = 'safe' | 'resolved' | 'unsafe' | 'open' | 'nodvir'
type StatusPillProps = {
  status?: PillStatus
} & React.HTMLAttributes<HTMLSpanElement>

export function StatusPill({
  status = 'safe',
  children,
  style = {},
  ...rest
}: StatusPillProps) {
  const tones: Record<PillStatus, React.CSSProperties> = {
    safe: { background: 'var(--ui-success-bg)', color: 'var(--ui-success)' },
    resolved: { background: 'var(--ui-info-bg)', color: 'var(--ui-info)' },
    unsafe: { background: 'var(--ui-danger-bg)', color: 'var(--ui-danger)' },
    open: { background: 'var(--ui-warn-bg)', color: 'var(--ui-warn)' },
    nodvir: { background: 'var(--nodvir-bg)', color: 'var(--nodvir-fg)' },
  }
  const labels: Record<PillStatus, string> = {
    safe: 'SAFE',
    resolved: 'RESOLVED',
    unsafe: 'UNSAFE',
    open: 'OPEN',
    nodvir: 'NO DVIR',
  }
  return (
    <span
      className={`ft-status-pill is-${status}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        fontSize: '11.5px',
        fontWeight: 700,
        padding: '3px 9px',
        borderRadius: 'var(--radius-pill)',
        whiteSpace: 'nowrap',
        letterSpacing: '0.02em',
        ...tones[status],
        ...style,
      }}
      {...rest}
    >
      {children ?? labels[status]}
    </span>
  )
}
