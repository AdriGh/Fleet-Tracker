import { useEffect, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  title: string
  onClose: () => void
  children: ReactNode
  width?: number
  // Ocupa (casi) todo el alto de la página, con el cuerpo scrolleable.
  fullHeight?: boolean
}

export default function Modal(
  { title, onClose, children, width, fullHeight }: Props,
) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // El ancho viaja como variable CSS para que el estilo lo limite por
  // viewport (min(px, 94vw)) — así es fluido, no una caja fija en px.
  const style = { '--modal-max': `${width ?? 720}px` } as CSSProperties

  // Portal a <body>: si un ancestro tiene transform/filter (p. ej. la
  // animación de entrada de .page), capturaría el position:fixed del
  // backdrop y el modal saldría cortado. Desde body es inmune.
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={`modal${fullHeight ? ' is-tall' : ''}`}
        style={style}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{title}</h2>
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
