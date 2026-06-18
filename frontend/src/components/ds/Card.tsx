import React from 'react'

/**
 * Surface card with optional header (numbered red step / title / right sub).
 * The workhorse container for dashboard panels and forms.
 */
type CardProps = {
  title?: React.ReactNode
  step?: React.ReactNode
  sub?: React.ReactNode
  action?: React.ReactNode
  bodyPad?: boolean
} & React.HTMLAttributes<HTMLElement>

export function Card({
  title,
  step,
  sub,
  action,
  children,
  bodyPad = true,
  className = '',
  style = {},
  ...rest
}: CardProps) {
  const hasHead = title != null || step != null || sub != null || action != null
  return (
    <section
      className={`ft-card ${className}`}
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-sm)',
        overflow: 'hidden',
        ...style,
      }}
      {...rest}
    >
      {hasHead && (
        <div
          className="ft-card-head"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '11px',
            padding: '16px 22px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          {step != null && (
            <span
              style={{
                width: 26,
                height: 26,
                flex: 'none',
                borderRadius: '50%',
                background: 'var(--header-bg)',
                color: '#fff',
                fontSize: 13,
                fontWeight: 700,
                display: 'grid',
                placeItems: 'center',
              }}
            >
              {step}
            </span>
          )}
          {title != null && (
            <h2 style={{ fontSize: '15.5px', fontWeight: 700, letterSpacing: '-0.2px' }}>
              {title}
            </h2>
          )}
          {(sub != null || action != null) && (
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 10 }}>
              {sub != null && (
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{sub}</span>
              )}
              {action}
            </span>
          )}
        </div>
      )}
      <div className="ft-card-body" style={{ padding: bodyPad ? '22px' : 0 }}>
        {children}
      </div>
    </section>
  )
}
