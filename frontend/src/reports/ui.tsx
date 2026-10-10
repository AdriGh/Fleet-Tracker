// Piezas chicas del hub de reportes: interruptor accesible (role=switch),
// sección colapsable del builder y control segmentado.
import { useId, type ReactNode } from 'react'
import { IcChevron } from './icons'

export function Switch({ checked, onChange, label, disabled }: {
  checked: boolean
  onChange: (v: boolean) => void
  label: ReactNode
  disabled?: boolean
}) {
  return (
    <button type="button" role="switch" aria-checked={checked}
      className={`rpx-switch${checked ? ' is-on' : ''}`} disabled={disabled}
      onClick={() => onChange(!checked)}>
      <span className="rpx-switch-track" aria-hidden="true"><span /></span>
      <span className="rpx-switch-lbl">{label}</span>
    </button>
  )
}

export function Section({ title, count, open, onToggle, children, aside }: {
  title: string
  count?: number
  open: boolean
  onToggle: () => void
  children: ReactNode
  aside?: ReactNode
}) {
  const id = useId()
  return (
    <section className={`rpb-sec${open ? ' is-open' : ''}`}>
      <h3 className="rpb-sec-h">
        <button type="button" aria-expanded={open} aria-controls={id}
          onClick={onToggle}>
          <span>{title}</span>
          {count != null && count > 0 && <span className="rpb-count">{count}</span>}
          {aside && <span className="rpb-sec-aside">{aside}</span>}
          <IcChevron open={open} />
        </button>
      </h3>
      {open && <div className="rpb-sec-body" id={id}>{children}</div>}
    </section>
  )
}

export function Seg<T extends string>({ value, options, onChange, label, size }: {
  value: T
  options: { id: T; label: ReactNode; title?: string }[]
  onChange: (v: T) => void
  label: string
  size?: 'sm'
}) {
  return (
    <div className={`rpx-seg${size === 'sm' ? ' is-sm' : ''}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id}
          className={value === o.id ? 'is-on' : undefined} title={o.title}
          onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}
