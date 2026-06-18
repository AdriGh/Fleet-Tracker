import React from 'react'

/**
 * Segmented tab control. A pill track holds tab buttons; the active one gets
 * a raised surface chip and accent text. Controlled via `value`/`onChange`.
 */
type Tab = string | { id: string; label: React.ReactNode }
type TabsProps = {
  tabs?: Tab[]
  value?: string
  onChange?: (id: string) => void
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'>

export function Tabs({ tabs = [], value, onChange, style = {}, ...rest }: TabsProps) {
  return (
    <div
      role="tablist"
      className="ft-tabs"
      style={{
        display: 'inline-flex',
        gap: '3px',
        padding: '3px',
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-btn)',
        ...style,
      }}
      {...rest}
    >
      {tabs.map((t) => {
        const id = typeof t === 'string' ? t : t.id
        const lbl = typeof t === 'string' ? t : t.label
        const active = id === value
        return (
          <button
            key={id}
            role="tab"
            aria-selected={active}
            className={`ft-tab-btn ${active ? 'active' : ''}`}
            onClick={() => onChange?.(id)}
            style={{
              border: 'none',
              background: active ? 'var(--surface)' : 'none',
              color: active ? 'var(--accent)' : 'var(--text-muted)',
              fontFamily: 'inherit',
              fontSize: '13px',
              fontWeight: 600,
              padding: '6px 14px',
              borderRadius: '8px',
              boxShadow: active ? 'var(--shadow-sm)' : 'none',
              cursor: 'pointer',
              transition:
                'background .15s, color .15s, transform .16s var(--ease-spring)',
            }}
          >
            {lbl}
          </button>
        )
      })}
    </div>
  )
}
