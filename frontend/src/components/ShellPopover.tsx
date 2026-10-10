// Primitivas flotantes del shell v2.22: Popover anclado (portal + fixed),
// menú con teclado (role=menu) y tooltip. Todas viven en un portal a <body>
// (el sidebar recorta con overflow:hidden) y se posicionan escribiendo el
// estilo en el DOM en un layout effect — antes del primer paint, sin setState.
// Animación: fade + scale .95→1 en 150 ms (paridad con los menús de SR).
import {
  useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent,
  type ReactNode, type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { useEscLayer, useOutsidePress } from '../layers'

export type Placement =
  | 'bottom-start' | 'bottom-end' | 'right-start' | 'right-end'
  | 'right-center' | 'top-start'

const GAP = 8
const MARGIN = 8

// Los menús/tooltips que salen hacia la derecha de un elemento del sidebar
// se apoyan en el BORDE del sidebar (no del ítem), como en SR.
function rightEdge(a: HTMLElement): number {
  const r = a.getBoundingClientRect().right
  const sb = a.closest('.sb')
  return sb ? Math.max(r, sb.getBoundingClientRect().right) : r
}

function place(
  el: HTMLElement, anchor: DOMRect, placement: Placement, edge?: number,
) {
  const right = Math.max(anchor.right, edge ?? anchor.right)
  const w = el.offsetWidth
  const h = el.offsetHeight
  const vw = window.innerWidth
  const vh = window.innerHeight
  let top = 0
  let left = 0
  let origin = 'top left'
  switch (placement) {
    case 'bottom-start':
      top = anchor.bottom + GAP - 2; left = anchor.left; origin = 'top left'
      break
    case 'bottom-end':
      top = anchor.bottom + GAP - 2; left = anchor.right - w
      origin = 'top right'
      break
    case 'top-start':
      top = anchor.top - GAP - h; left = anchor.left; origin = 'bottom left'
      break
    case 'right-start':
      top = anchor.top - 6; left = right + GAP; origin = 'top left'
      break
    case 'right-end':
      top = anchor.bottom - h + 6; left = right + GAP
      origin = 'bottom left'
      break
    case 'right-center':
      top = anchor.top + anchor.height / 2 - h / 2
      left = right + GAP; origin = 'left center'
      break
  }
  // Clamp al viewport (nunca se sale de pantalla en ventanas bajas).
  left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN))
  top = Math.max(MARGIN, Math.min(top, vh - h - MARGIN))
  el.style.top = `${Math.round(top)}px`
  el.style.left = `${Math.round(left)}px`
  el.style.transformOrigin = origin
}

export function Popover({
  anchor, placement, onClose, children, className = '', label, role,
  style, extraInside = [],
}: {
  anchor: RefObject<HTMLElement | null>
  placement: Placement
  onClose: () => void
  children: ReactNode
  className?: string
  label?: string
  role?: string
  style?: CSSProperties
  // Elementos que NO cuentan como "afuera" (p. ej. el botón ancla).
  extraInside?: RefObject<HTMLElement | null>[]
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEscLayer(true, () => {
    onClose()
    anchor.current?.focus({ preventScroll: true })
  })
  useOutsidePress(true, [ref, anchor, ...extraInside], onClose)

  useLayoutEffect(() => {
    const el = ref.current
    const a = anchor.current
    if (!el || !a) return
    const update = () => {
      const cur = anchor.current
      if (cur) place(el, cur.getBoundingClientRect(), placement, rightEdge(cur))
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchor, placement])

  return createPortal(
    <div ref={ref} className={`rs-pop ${className}`} role={role}
      aria-label={label} style={style}>
      {children}
    </div>,
    document.body,
  )
}

// ----- Menú (role=menu) con navegación por teclado ---------------------------
// ↑/↓/Home/End mueven el foco entre [role=menuitem]; Tab cierra; el foco
// entra al primer ítem al abrir.
export function MenuList({ children, label, onClose, className = '' }: {
  children: ReactNode
  label: string
  onClose: () => void
  className?: string
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>(
      '[role="menuitem"]:not([disabled]), [role="menuitemradio"]')
    first?.focus({ preventScroll: true })
  }, [])

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([disabled]), [role="menuitemradio"]') ?? [])
    if (!items.length) return
    const i = items.indexOf(document.activeElement as HTMLElement)
    let j = -1
    if (e.key === 'ArrowDown') j = i < 0 ? 0 : (i + 1) % items.length
    else if (e.key === 'ArrowUp') j = i <= 0 ? items.length - 1 : i - 1
    else if (e.key === 'Home') j = 0
    else if (e.key === 'End') j = items.length - 1
    else if (e.key === 'Tab') { onClose(); return }
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      // Type-ahead: primera letra.
      const k = e.key.toLowerCase()
      const from = i + 1
      const order = [...items.slice(from), ...items.slice(0, from)]
      const hit = order.find((el) =>
        (el.textContent ?? '').trim().toLowerCase().startsWith(k))
      if (hit) { e.preventDefault(); hit.focus() }
      return
    }
    if (j >= 0) {
      e.preventDefault()
      items[j].focus()
    }
  }

  return (
    <div ref={ref} role="menu" aria-label={label} className={className}
      onKeyDown={onKey}>
      {children}
    </div>
  )
}

// ----- Tooltip ---------------------------------------------------------------
export function Tooltip({ anchor, children, placement = 'right-center' }: {
  anchor: HTMLElement
  children: ReactNode
  placement?: Placement
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el) {
      place(el, anchor.getBoundingClientRect(), placement, rightEdge(anchor))
    }
  }, [anchor, placement])
  return createPortal(
    <div ref={ref} className="rs-tip" role="tooltip">{children}</div>,
    document.body,
  )
}
