import React from 'react'

/**
 * Labelled form field: stacked label + control with an optional hint and error.
 * Focus ring + border switch to accent red. Pass `as="select"`/`"textarea"`.
 */
type InputProps = {
  label?: React.ReactNode
  hint?: React.ReactNode
  error?: string
  as?: 'input' | 'select' | 'textarea'
} & Omit<React.AllHTMLAttributes<HTMLElement>, 'label' | 'as'>

export function Input({
  label,
  hint,
  error,
  as = 'input',
  id,
  children,
  style = {},
  ...rest
}: InputProps) {
  const reactId = React.useId()
  const fieldId = id ?? reactId
  const Tag = as as React.ElementType
  const controlStyle: React.CSSProperties = {
    fontFamily: 'inherit',
    fontSize: '14px',
    padding: '10px 12px',
    borderRadius: 'var(--radius-sm)',
    border: `1px solid ${error ? 'var(--danger)' : 'var(--border-strong)'}`,
    background: 'var(--surface)',
    color: 'var(--text)',
    width: '100%',
    outline: 'none',
    transition: 'border-color .15s ease, box-shadow .15s ease',
  }
  return (
    <div
      className="ft-field"
      style={{ display: 'flex', flexDirection: 'column', gap: '6px', ...style }}
    >
      {label != null && (
        <label htmlFor={fieldId} style={{ fontSize: '13px', fontWeight: 600 }}>
          {label}
        </label>
      )}
      {hint != null && (
        <span style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '-2px' }}>
          {hint}
        </span>
      )}
      <Tag
        id={fieldId}
        className="ft-field-control"
        style={controlStyle}
        onFocus={(e: React.FocusEvent<HTMLElement>) => {
          e.currentTarget.style.borderColor = 'var(--accent)'
          e.currentTarget.style.boxShadow = '0 0 0 3px var(--ring)'
        }}
        onBlur={(e: React.FocusEvent<HTMLElement>) => {
          e.currentTarget.style.borderColor = error
            ? 'var(--danger)'
            : 'var(--border-strong)'
          e.currentTarget.style.boxShadow = 'none'
        }}
        {...rest}
      >
        {children}
      </Tag>
      {error != null && (
        <span style={{ fontSize: '11.5px', color: 'var(--danger)', fontWeight: 600 }}>
          {error}
        </span>
      )}
    </div>
  )
}
