// FiltersPanel (v2.21): panel de filtros estilo SquareRigger pero más
// grande (360px): grupos colapsables de checkboxes con el conteo por
// opción, un grupo con buscador para listas largas (unidades), rangos de
// fecha y "Clear all". En desktop es un popover anclado al botón "Filters";
// en móvil (≤760px, por CSS) baja como bottom sheet.
//
// Es agnóstico del dominio: la página arma los grupos (valores, etiquetas y
// conteos ya calculados) y recibe los toggles. El estado vive en el padre.
import {
  useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject,
} from 'react'
import { createPortal } from 'react-dom'

export type FilterOption = {
  value: string
  label: ReactNode
  count: number
  /** Texto por el que filtra el buscador del grupo (si difiere del label). */
  search?: string
}

export type FilterGroup = {
  id: string
  label: string
  options: FilterOption[]
  selected: Set<string>
  /** Caja de búsqueda dentro del grupo (listas largas, p. ej. unidades). */
  searchable?: boolean
  /** Abierto al montar (los demás arrancan colapsados salvo que tengan
      selección). */
  defaultOpen?: boolean
  /** Cuántas opciones se muestran antes de "Show all". */
  limit?: number
}

export type FilterRange = {
  id: string
  label: string
  from: string
  to: string
}

export default function FiltersPanel({
  anchor, onClose, groups, ranges = [], onToggle, onClearGroup, onRange,
  onClearAll, activeCount, resultCount,
}: {
  anchor: RefObject<HTMLElement | null>
  onClose: () => void
  groups: FilterGroup[]
  ranges?: FilterRange[]
  onToggle: (groupId: string, value: string) => void
  onClearGroup: (groupId: string) => void
  onRange: (rangeId: string, from: string, to: string) => void
  onClearAll: () => void
  activeCount: number
  /** Resultados con los filtros actuales (pie del panel). */
  resultCount?: number
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  // Posición: debajo del botón, alineado a su borde derecho, sin salirse del
  // viewport. Se recalcula al redimensionar/scrollear. En móvil el CSS
  // ignora top/left (bottom sheet).
  useLayoutEffect(() => {
    function place() {
      const a = anchor.current
      if (!a) return
      const r = a.getBoundingClientRect()
      const w = Math.min(360, window.innerWidth - 16)
      const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))
      setPos({ top: r.bottom + 6, left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor])

  // Cerrar con Escape o con un clic fuera (el botón ancla no cuenta: su
  // propio onClick alterna el panel).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (panelRef.current?.contains(t)) return
      if (anchor.current?.contains(t)) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [anchor, onClose])

  return createPortal(
    <>
      <div className="flt-scrim" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} className="flt-pop" role="dialog"
        aria-label="Filters"
        style={pos ? { top: pos.top, left: pos.left } : undefined}>
        <div className="flt-head">
          <span className="flt-title">
            Filters
            {activeCount > 0 && (
              <span className="flt-active">{activeCount} active</span>
            )}
          </span>
          <button type="button" className="flt-clear" disabled={!activeCount}
            onClick={onClearAll}>
            Clear all
          </button>
          <button type="button" className="icon-btn flt-x" aria-label="Close"
            onClick={onClose}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="flt-body">
          {groups.map((g) => (
            <Group key={g.id} g={g}
              onToggle={(v) => onToggle(g.id, v)}
              onClear={() => onClearGroup(g.id)} />
          ))}
          {ranges.map((r) => (
            <RangeGroup key={r.id} r={r}
              onChange={(from, to) => onRange(r.id, from, to)} />
          ))}
        </div>
        <div className="flt-foot">
          <span className="flt-result">
            {resultCount != null
              ? `${resultCount} work order${resultCount === 1 ? '' : 's'} match`
              : ''}
          </span>
          <button type="button" className="btn btn-primary btn-xs"
            onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </>,
    document.body,
  )
}

// Un grupo colapsable de checkboxes con conteo.
function Group({ g, onToggle, onClear }: {
  g: FilterGroup
  onToggle: (value: string) => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(!!g.defaultOpen || g.selected.size > 0)
  const [q, setQ] = useState('')
  const [all, setAll] = useState(false)
  const limit = g.limit ?? 8
  const ql = q.trim().toLowerCase()
  const visible = g.options.filter((o) => {
    if (!ql) return true
    const hay = (o.search ?? (typeof o.label === 'string' ? o.label : o.value))
      .toLowerCase()
    return hay.includes(ql)
  })
  // Las opciones elegidas siempre se ven aunque excedan el límite.
  const shown = all || ql
    ? visible
    : visible.filter((o, i) => i < limit || g.selected.has(o.value))
  const hidden = visible.length - shown.length
  return (
    <section className={`flt-group ${open ? 'is-open' : ''}`}>
      <button type="button" className="flt-ghead" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
          stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
          strokeLinejoin="round" className="flt-chev" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
        <span className="flt-glabel">{g.label}</span>
        {g.selected.size > 0 && (
          <span className="flt-gcount">{g.selected.size}</span>
        )}
        {g.selected.size > 0 && (
          <span role="button" tabIndex={0} className="flt-gclear"
            onClick={(e) => { e.stopPropagation(); onClear() }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault(); e.stopPropagation(); onClear()
              }
            }}>
            Clear
          </span>
        )}
      </button>
      {open && (
        <div className="flt-gbody">
          {g.searchable && (
            <input className="cell-input flt-search" value={q}
              placeholder={`Search ${g.label.toLowerCase()}…`}
              onChange={(e) => setQ(e.target.value)} />
          )}
          {shown.length === 0 && (
            <p className="flt-empty">
              {g.options.length === 0 ? 'Nothing to filter here.' : 'No matches.'}
            </p>
          )}
          {shown.map((o) => {
            const on = g.selected.has(o.value)
            return (
              <label key={o.value}
                className={`flt-opt ${on ? 'is-on' : ''} ${o.count === 0 && !on ? 'is-zero' : ''}`}>
                <input type="checkbox" checked={on}
                  onChange={() => onToggle(o.value)} />
                <span className="flt-opt-label">{o.label}</span>
                <span className="flt-opt-count mono">{o.count}</span>
              </label>
            )
          })}
          {hidden > 0 && (
            <button type="button" className="flt-more"
              onClick={() => setAll(true)}>
              Show all ({visible.length})
            </button>
          )}
          {all && !ql && visible.length > limit && (
            <button type="button" className="flt-more"
              onClick={() => setAll(false)}>
              Show less
            </button>
          )}
        </div>
      )}
    </section>
  )
}

// Rango de fechas (desde / hasta), colapsable igual que un grupo.
function RangeGroup({ r, onChange }: {
  r: FilterRange
  onChange: (from: string, to: string) => void
}) {
  const active = !!(r.from || r.to)
  const [open, setOpen] = useState(active)
  return (
    <section className={`flt-group ${open ? 'is-open' : ''}`}>
      <button type="button" className="flt-ghead" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
          stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
          strokeLinejoin="round" className="flt-chev" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
        <span className="flt-glabel">{r.label}</span>
        {active && <span className="flt-gcount">1</span>}
        {active && (
          <span role="button" tabIndex={0} className="flt-gclear"
            onClick={(e) => { e.stopPropagation(); onChange('', '') }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault(); e.stopPropagation(); onChange('', '')
              }
            }}>
            Clear
          </span>
        )}
      </button>
      {open && (
        <div className="flt-gbody flt-range">
          <label className="flt-range-f">
            <span>From</span>
            <input className="cell-input" type="date" value={r.from}
              max={r.to || undefined}
              onChange={(e) => onChange(e.target.value, r.to)} />
          </label>
          <label className="flt-range-f">
            <span>To</span>
            <input className="cell-input" type="date" value={r.to}
              min={r.from || undefined}
              onChange={(e) => onChange(r.from, e.target.value)} />
          </label>
        </div>
      )}
    </section>
  )
}
