import React from 'react'

/**
 * Compact icon-only action button with an accessible tooltip. Used in
 * sidebar footer, table rows and toolbars. `danger` tints it red.
 */
type IconButtonProps = {
  title?: string
  danger?: boolean
  size?: number
} & React.ButtonHTMLAttributes<HTMLButtonElement>

export function IconButton({
  title,
  danger = false,
  size = 36,
  children,
  className = '',
  style = {},
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={`ft-icon-btn ${danger ? 'is-danger' : ''} ${className}`}
      style={{
        width: size,
        height: size,
        display: 'grid',
        placeItems: 'center',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-btn)',
        background: 'var(--surface-2)',
        color: danger ? 'var(--accent)' : 'var(--text-muted)',
        cursor: 'pointer',
        transition:
          'background .15s, color .15s, transform .18s var(--ease-spring)',
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  )
}
