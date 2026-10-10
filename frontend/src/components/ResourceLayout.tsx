// Piezas compartidas de las páginas de Resources (v2.22 [F]): Customers,
// Employees, Locations y Vendors usan el mismo maestro-detalle estilo
// SquareRigger — lista a la izquierda (buscador + filtros + filas) y el
// perfil a la derecha con cabecera, pestañas y cuerpo. En móvil (≤760px) la
// lista y el perfil se alternan con un botón "back".
import { useId, type ReactNode } from 'react'
import { initialsOf } from '../shell'

// Avatar de iniciales (tono estable por nombre: 6 matices de marca).
export function RxAvatar({ name, size = 'md', icon }: {
  name: string
  size?: 'sm' | 'md' | 'lg'
  icon?: ReactNode
}) {
  let h = 0
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return (
    <span className={`rx-av rx-av-${size} rx-tone-${h % 6}`} aria-hidden="true">
      {icon ?? initialsOf(name || '?')}
    </span>
  )
}

// Fila de la lista maestra (botón real, role=option dentro del listbox).
export function RxRow({ selected, onSelect, avatar, title, sub, side, id }: {
  selected: boolean
  onSelect: () => void
  avatar?: ReactNode
  title: ReactNode
  sub?: ReactNode
  side?: ReactNode
  id?: string
}) {
  return (
    <button type="button" role="option" aria-selected={selected} id={id}
      className={`rx-row ${selected ? 'is-sel' : ''}`} onClick={onSelect}>
      {avatar}
      <span className="rx-row-main">
        <strong>{title}</strong>
        {sub && <span className="rx-row-sub">{sub}</span>}
      </span>
      {side && <span className="rx-row-side">{side}</span>}
    </button>
  )
}

// Botón "volver a la lista" (solo visible en móvil por CSS).
export function RxBack({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="rx-back" onClick={onClick}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
        aria-hidden="true">
        <path d="m15 6-6 6 6 6" />
      </svg>
      {label}
    </button>
  )
}

// Tile de KPI claro (el StatCard oscuro es para cabeceras de página).
export function RxKpi({ label, value, sub, tone }: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: 'warn' | 'danger' | 'ok' | 'accent'
}) {
  return (
    <div className={`rx-kpi ${tone ? `is-${tone}` : ''}`}>
      <span className="rx-kpi-l">{label}</span>
      <strong className="rx-kpi-v">{value}</strong>
      {sub && <span className="rx-kpi-s">{sub}</span>}
    </div>
  )
}

// Bloque de datos (título + filas clave/valor). Valores vacíos → "—".
export function RxBlock({ title, action, children }: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rx-block">
      <header className="rx-block-h">
        <h3>{title}</h3>
        {action}
      </header>
      {children}
    </section>
  )
}

export function RxDl({ rows }: {
  rows: [ReactNode, ReactNode | null | undefined | false][]
}) {
  return (
    <dl className="rx-dl">
      {rows.map(([k, v], i) => (
        <div className="rx-dl-row" key={i}>
          <dt>{k}</dt>
          <dd>{v === '' || v == null || v === false
            ? <span className="rx-dash">—</span> : v}</dd>
        </div>
      ))}
    </dl>
  )
}

// Estado vacío del panel (sin selección / sin resultados).
export function RxEmpty({ icon, title, children }: {
  icon?: ReactNode
  title: string
  children?: ReactNode
}) {
  return (
    <div className="rx-empty">
      {icon && <span className="rx-empty-ico" aria-hidden="true">{icon}</span>}
      <strong>{title}</strong>
      {children}
    </div>
  )
}

// Segmentado accesible (radiogroup con inputs nativos) para filtros cortos.
export function RxSeg<T extends string>({ value, options, onChange, label }: {
  value: T
  options: { id: T; label: ReactNode }[]
  onChange: (v: T) => void
  label: string
}) {
  const name = useId()
  return (
    <div className="bt-seg rx-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={o.id} className={`bt-opt ${value === o.id ? 'is-on' : ''}`}>
          <input type="radio" name={name} value={o.id}
            checked={value === o.id} onChange={() => onChange(o.id)} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  )
}
