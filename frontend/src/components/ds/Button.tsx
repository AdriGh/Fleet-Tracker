import React from 'react'

/**
 * Fleet Tracker primary button. Red `primary`, neutral `ghost`, green
 * `success`. Lifts on hover, springs on press; primary carries a red glow.
 * Design system core — styling is inline via CSS custom properties.
 */
type ButtonProps = {
  variant?: 'primary' | 'success' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  icon?: React.ReactNode
} & React.ButtonHTMLAttributes<HTMLButtonElement>

export function Button({
  variant = 'primary',
  size = 'md',
  type = 'button',
  loading = false,
  disabled = false,
  icon = null,
  children,
  className = '',
  style = {},
  ...rest
}: ButtonProps) {
  const base: React.CSSProperties = {
    border: 'none',
    borderRadius: 'var(--radius-btn)',
    fontFamily: 'var(--font)',
    fontWeight: 600,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '9px',
    cursor: disabled || loading ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition:
      'background .15s, transform .18s var(--ease-spring), box-shadow .2s ease, opacity .15s',
  }

  const sizes: Record<string, React.CSSProperties> = {
    sm: { fontSize: '11.5px', padding: '6px 12px' },
    md: { fontSize: '14px', padding: '10px 18px' },
    lg: { fontSize: '15px', padding: '13px 24px' },
  }

  const variants: Record<string, React.CSSProperties> = {
    primary: {
      background: 'var(--btn-primary)',
      color: '#fff',
      boxShadow: 'var(--glow-accent)',
    },
    success: { background: 'var(--btn-success)', color: '#fff' },
    ghost: {
      background: 'var(--surface-2)',
      color: 'var(--text)',
      border: '1px solid var(--border)',
    },
  }

  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={`ft-btn ft-btn-${variant} ${className}`}
      style={{ ...base, ...sizes[size], ...variants[variant], ...style }}
      {...rest}
    >
      {loading && (
        <span
          aria-hidden="true"
          style={{
            width: 16,
            height: 16,
            border: '2.4px solid rgba(255,255,255,0.4)',
            borderTopColor: '#fff',
            borderRadius: '50%',
            animation: 'ft-spin .7s linear infinite',
          }}
        />
      )}
      {!loading && icon}
      {children}
    </button>
  )
}
