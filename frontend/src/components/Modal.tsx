import {
  useEffect, useId, useRef, type CSSProperties, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useEscLayer } from '../layers'

interface Props {
  title: string
  onClose: () => void
  children: ReactNode
  width?: number
  // Ocupa (casi) todo el alto de la página, con el cuerpo scrolleable.
  fullHeight?: boolean
  // Clase extra del backdrop (p. ej. para una variante de layout). El
  // backdrop ya va en --z-modal con pointer-events propios, así que funciona
  // igual encima de un drawer vaul o del panel de detalle móvil.
  className?: string
}

export default function Modal(
  { title, onClose, children, width, fullHeight, className = '' }: Props,
) {
  // v2.22: el modal es una capa de la pila (layers.ts) — con modales
  // anidados (o el command palette encima) Escape cierra SOLO la de arriba.
  useEscLayer(true, onClose)
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Foco: si ningún campo del modal se auto-enfocó, el foco entra al panel
  // (los lectores de pantalla anuncian el diálogo); al cerrar vuelve al
  // elemento que lo abrió, si todavía existe.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    if (panel && !panel.contains(document.activeElement)) {
      panel.focus({ preventScroll: true })
    }
    return () => {
      if (prev && prev !== document.body && document.contains(prev)) {
        prev.focus({ preventScroll: true })
      }
    }
  }, [])

  // El ancho viaja como variable CSS para que el estilo lo limite por
  // viewport (min(px, 94vw)) — así es fluido, no una caja fija en px.
  const style = { '--modal-max': `${width ?? 720}px` } as CSSProperties

  // Portal a <body>: si un ancestro tiene transform/filter (p. ej. la
  // animación de entrada de .page), capturaría el position:fixed del
  // backdrop y el modal saldría cortado. Desde body es inmune.
  return createPortal(
    <div className={`modal-backdrop ${className}`} onClick={onClose}>
      <div
        ref={panelRef}
        className={`modal${fullHeight ? ' is-tall' : ''}`}
        style={style}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button className="modal-x" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
