import React from 'react'

/**
 * Small label chip. `solid` = red brand chip (counts, "LIVE"); `soft` =
 * tinted; `outline` = hairline. Neutral by default.
 */
type BadgeTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger'
type BadgeProps = {
  tone?: BadgeTone
  variant?: 'solid' | 'soft' | 'outline'
} & React.HTMLAttributes<HTMLSpanElement>

export function Badge({
  tone = 'neutral',
  variant = 'soft',
  children,
  style = {},
  ...rest
}: BadgeProps) {
  const palette: Record<BadgeTone, { fg: string; bg: string; soft: string }> = {
    neutral: { fg: 'var(--text-muted)', bg: 'var(--surface-2)', soft: 'var(--surface-2)' },
    accent: { fg: 'var(--accent)', bg: 'var(--accent)', soft: 'var(--accent-soft)' },
    success: { fg: 'var(--ui-success)', bg: 'var(--ui-success)', soft: 'var(--ui-success-bg)' },
    warn: { fg: 'var(--ui-warn)', bg: 'var(--ui-warn)', soft: 'var(--ui-warn-bg)' },
    danger: { fg: 'var(--ui-danger)', bg: 'var(--ui-danger)', soft: 'var(--ui-danger-bg)' },
  }
  const p = palette[tone]
  const variants: Record<string, React.CSSProperties> = {
    solid: { background: p.bg, color: '#fff', border: '1px solid transparent' },
    soft: { background: p.soft, color: p.fg, border: '1px solid transparent' },
    outline: {
      background: 'transparent',
      color: p.fg,
      border: `1px solid ${tone === 'neutral' ? 'var(--border-strong)' : p.fg}`,
    },
  }
  return (
    <span
      className={`ft-badge ft-badge-${tone} is-${variant}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        fontSize: '0.74rem',
        fontWeight: 700,
        lineHeight: 1.4,
        padding: '2px 8px',
        borderRadius: 'var(--radius-xs)',
        whiteSpace: 'nowrap',
        ...variants[variant],
        ...style,
      }}
      {...rest}
    >
      {children}
    </span>
  )
}
