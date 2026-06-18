import React from 'react'

/**
 * Sidebar navigation item: icon + label, with an active state (accent-soft
 * bg, accent text, spring left indicator bar) and a "soon" disabled tag.
 */
type NavItemProps = {
  icon?: React.ReactNode
  label?: React.ReactNode
  active?: boolean
  soon?: boolean
  onClick?: () => void
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>

export function NavItem({
  icon,
  label,
  active = false,
  soon = false,
  onClick,
  style = {},
  ...rest
}: NavItemProps) {
  return (
    <button
      type="button"
      className={`ft-nav-item ${active ? 'active' : ''}`}
      disabled={soon}
      onClick={soon ? undefined : onClick}
      style={{
        position: 'relative',
        border: 'none',
        background: active ? 'var(--accent-soft)' : 'none',
        color: active ? 'var(--accent)' : 'var(--text-muted)',
        fontFamily: 'inherit',
        fontSize: '14px',
        fontWeight: 600,
        display: 'flex',
        alignItems: 'center',
        gap: '11px',
        padding: '10px 11px',
        borderRadius: 'var(--radius-btn)',
        textAlign: 'left',
        width: '100%',
        opacity: soon ? 0.55 : 1,
        cursor: soon ? 'default' : 'pointer',
        transition: 'background .15s, color .15s, transform .16s var(--ease-spring)',
        ...style,
      }}
      {...rest}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 0,
          top: '50%',
          width: 3,
          height: 18,
          borderRadius: '0 3px 3px 0',
          background: 'var(--accent)',
          transform: `translateY(-50%) scaleY(${active ? 1 : 0})`,
          transition: 'transform .28s var(--ease-spring)',
        }}
      />
      <span
        className="ft-nav-ico"
        style={{ width: 18, height: 18, flex: 'none', display: 'grid', placeItems: 'center' }}
      >
        {icon}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
      {soon && (
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 9,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.4px',
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            color: 'var(--text-muted)',
            padding: '2px 5px',
            borderRadius: 'var(--radius-xs)',
          }}
        >
          soon
        </span>
      )}
    </button>
  )
}
