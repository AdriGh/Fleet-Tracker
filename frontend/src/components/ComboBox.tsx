// ComboBox (v2.21): base genérica de VendorPicker y TechnicianPicker. Mismo
// patrón que UnitPicker (v2.20): input controlado por el padre (`text`),
// lista en un portal a <body> con position:fixed (no la recorta el
// .modal-body ni el drawer), ARIA combobox/listbox, flechas/Enter/Escape/
// Tab, y una fila "+ Crear…" opcional al final.
//
// Dos formas de crear desde el picker:
//  - `create.onCreate(q)`: crea directo y elige el ítem (TechnicianPicker).
//  - `create.render(q, done)`: muestra un form inline DENTRO del desplegable
//    (VendorPicker: nombre, ciudad, estado); `done(item)` lo elige, `done(null)`
//    cancela. Mientras el form está abierto el blur del input no cierra la
//    lista (el foco está en el form); un clic afuera o Escape la cierran.
//
// El padre decide qué es el texto: VendorPicker lo mapea a un vendor_id;
// TechnicianPicker lo pasa tal cual (WorkOrder.mechanic es un nombre).
import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

const DEFAULT_MAX = 150

export interface ComboCreate<T> {
  // Texto de la fila "+ Crear…" (solo con texto escrito y sin match exacto).
  label: (q: string) => ReactNode
  // Crear directo: devuelve el ítem creado (se elige) o null (queda el texto).
  onCreate?: (q: string) => Promise<T | null>
  // Form inline en el desplegable. Gana sobre onCreate si están los dos.
  render?: (q: string, done: (item: T | null) => void) => ReactNode
}

export interface ComboBoxProps<T> {
  text: string
  onText: (text: string) => void
  items: T[]
  getKey: (item: T) => string | number
  filter: (item: T, q: string) => boolean
  // Match exacto del texto (oculta la fila "+ Crear…" y marca la opción).
  exact?: (q: string) => T | undefined
  isSelected?: (item: T) => boolean
  renderOption: (item: T) => ReactNode
  onPick: (item: T) => void
  // Blur / Enter sin opción: el padre confirma el texto (o lo revierte).
  onCommit?: () => void
  loading?: boolean
  // Nota al pie con la lista vacía (default: "No matches").
  emptyNote?: (q: string) => ReactNode
  create?: ComboCreate<T>
  // Prefijo de clases específicas ("vp", "tp") que acompaña a las cb-*.
  prefix: string
  listLabel?: string
  maxOptions?: number
  placeholder?: string
  disabled?: boolean
  autoFocus?: boolean
  className?: string
  inputClassName?: string
  'aria-label'?: string
  title?: string
  invalid?: boolean
  errorText?: string
  autoCapitalize?: 'characters' | 'words' | 'none' | 'sentences'
}

// Form inline de creación (VendorPicker). Componente aparte para que el
// render prop se evalúe acá y no en el render del ComboBox.
function CreatePane<T>({ q, render, done }: {
  q: string
  render: NonNullable<ComboCreate<T>['render']>
  done: (item: T | null) => void
}) {
  return <div className="cb-create-pane">{render(q, done)}</div>
}

export default function ComboBox<T>({
  text, onText, items, getKey, filter, exact, isSelected, renderOption,
  onPick, onCommit, loading, emptyNote, create, prefix, listLabel,
  maxOptions = DEFAULT_MAX, placeholder, disabled, autoFocus,
  className = '', inputClassName = '', 'aria-label': ariaLabel, title,
  invalid, errorText, autoCapitalize = 'words',
}: ComboBoxProps<T>) {
  const uid = useId()
  const inputId = `${uid}-input`
  const listId = `${uid}-list`
  const errId = `${uid}-err`
  const optId = (i: number) => `${uid}-opt-${i}`

  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  // Con el texto completo la lista arranca sin filtrar (ver opciones al
  // abrir sobre un valor ya elegido); al escribir se filtra.
  const [typed, setTyped] = useState(false)
  // Form inline de creación visible dentro del desplegable.
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const boxRef = useRef<HTMLSpanElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)
  const kbNav = useRef(false)

  const q = text.trim()
  const exactHit = exact ? exact(q) : undefined
  const options = useMemo(() => {
    const needle = typed ? q.toLowerCase() : ''
    return needle ? items.filter((it) => filter(it, needle)) : items
  }, [items, typed, q, filter])
  const shown = options.slice(0, maxOptions)
  const canCreate = !!create && !!q && !exactHit && !loading
  // Filas navegables: opciones + (fila de crear). idx === shown.length = crear.
  const rows = shown.length + (canCreate ? 1 : 0)
  const activeIdx = rows ? Math.min(Math.max(active, 0), rows - 1) : -1
  const isOpen = open && !disabled

  // Posición del desplegable (fixed, relativo al input). Abre hacia abajo;
  // si no entra y arriba hay más lugar, hacia arriba.
  const place = useCallback(() => {
    const box = boxRef.current
    const pop = popRef.current
    if (!box || !pop) return
    const r = box.getBoundingClientRect()
    const vv = window.visualViewport
    const vh = vv ? vv.height + vv.offsetTop : window.innerHeight
    const vw = document.documentElement.clientWidth
    const gap = 4
    const pad = 8
    const below = vh - r.bottom - gap - pad
    const above = r.top - gap - pad
    const want = Math.min(pop.scrollHeight, 320)
    const up = below < Math.min(want, 200) && above > below
    const maxH = Math.max(96, Math.min(320, up ? above : below))
    const width = Math.min(Math.max(r.width, 280), vw - pad * 2)
    const left = Math.max(pad, Math.min(r.left, vw - pad - width))
    pop.style.left = `${left}px`
    pop.style.width = `${width}px`
    pop.style.maxHeight = `${maxH}px`
    if (up) {
      pop.style.top = 'auto'
      pop.style.bottom = `${window.innerHeight - r.top + gap}px`
    } else {
      pop.style.bottom = 'auto'
      pop.style.top = `${r.bottom + gap}px`
    }
  }, [])

  useLayoutEffect(() => {
    if (isOpen) place()
  }, [isOpen, place, rows, creating, loading])

  // Mientras está abierta sigue al input cuadro a cuadro (scroll del modal
  // o del drawer, resize, teclado del teléfono, animación de entrada).
  useEffect(() => {
    if (!isOpen) return
    let raf = 0
    let last = ''
    const tick = () => {
      const r = boxRef.current?.getBoundingClientRect()
      const vv = window.visualViewport
      const sig = r ? [r.left, r.top, r.width, r.height, window.innerWidth,
        window.innerHeight, vv?.height ?? 0, vv?.offsetTop ?? 0].join('|') : ''
      if (sig !== last) {
        last = sig
        place()
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isOpen, place])

  // Con el form inline abierto el foco vive en el form: un clic fuera del
  // input y del desplegable cancela y cierra.
  useEffect(() => {
    if (!isOpen || !creating) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (boxRef.current?.contains(t) || popRef.current?.contains(t)) return
      setCreating(false)
      setOpen(false)
      setTyped(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [isOpen, creating])

  // La fila activa por teclado siempre visible dentro del scroll.
  useEffect(() => {
    if (!isOpen || !kbNav.current || activeIdx < 0) return
    document.getElementById(`${uid}-opt-${activeIdx}`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [isOpen, activeIdx, uid])

  function openList() {
    if (disabled) return
    const i = isSelected ? items.findIndex(isSelected) : -1
    setTyped(false)
    setActive(i >= 0 && i < maxOptions ? i : 0)
    setCreating(false)
    setOpen(true)
  }

  function close() {
    setOpen(false)
    setTyped(false)
    setCreating(false)
    kbNav.current = false
  }

  function choose(item: T) {
    onPick(item)
    close()
  }

  function onInput(t: string) {
    onText(t)
    setTyped(true)
    setActive(0)
    kbNav.current = false
    if (!disabled) setOpen(true)
  }

  // Blur / Enter sin opción elegida: el padre confirma el texto.
  function commit() {
    if (creating) return
    close()
    onCommit?.()
  }

  async function startCreate() {
    if (!create || !q) return
    if (create.render) {
      setCreating(true)
      return
    }
    if (!create.onCreate || busy) return
    setBusy(true)
    try {
      const made = await create.onCreate(q)
      if (made) choose(made)
      else close()
    } finally {
      setBusy(false)
    }
  }

  function doneCreate(item: T | null) {
    setCreating(false)
    if (item) {
      choose(item)
    } else {
      setOpen(false)
      setTyped(false)
      // Por id (no por ref): este callback viaja a create.render() en el
      // render y la regla react-hooks/refs no permite leer refs ahí.
      document.getElementById(inputId)?.focus()
    }
  }

  function activate(i: number) {
    if (i === shown.length && canCreate) startCreate()
    else if (shown[i]) choose(shown[i])
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      kbNav.current = true
      if (!isOpen) {
        openList()
        return
      }
      if (!rows) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive(Math.max(0, Math.min(rows - 1, activeIdx + step)))
    } else if (e.key === 'Enter') {
      if (isOpen && activeIdx >= 0) {
        // No enviar el form: Enter elige la fila activa.
        e.preventDefault()
        activate(activeIdx)
      } else {
        commit()
      }
    } else if (e.key === 'Escape') {
      if (isOpen) {
        // Solo cierra la lista; el Modal (listener en document) no se entera.
        e.preventDefault()
        e.stopPropagation()
        close()
      }
    } else if (e.key === 'Tab') {
      // Tab acepta la opción solo si se eligió con flechas.
      if (isOpen && kbNav.current && activeIdx >= 0 && shown[activeIdx]) {
        choose(shown[activeIdx])
      } else if (isOpen) {
        close()
      }
    }
  }

  const total = options.length
  return (
    <span className={`cb-root ${prefix}-root ${invalid ? 'is-invalid' : ''} ${
      className}`}>
      <span className="cb-field" ref={boxRef}>
        <input ref={inputRef} id={inputId}
          className={`cell-input cb-input ${inputClassName}`}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={isOpen}
          aria-controls={listId}
          aria-activedescendant={isOpen && !creating && activeIdx >= 0
            ? optId(activeIdx) : undefined}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid && errorText ? errId : undefined}
          aria-label={ariaLabel}
          title={title}
          value={text} placeholder={placeholder}
          autoFocus={autoFocus} disabled={disabled}
          autoComplete="off" autoCapitalize={autoCapitalize} spellCheck={false}
          onChange={(e) => onInput(e.target.value)}
          onBlur={commit}
          onMouseDown={() => { if (!isOpen && !disabled) openList() }}
          onKeyDown={onKey} />
        <button type="button" className="cb-toggle" tabIndex={-1}
          aria-label={isOpen ? 'Close list' : 'Open list'}
          disabled={disabled}
          // Sin robarle el foco al input (si no, el blur cierra la lista).
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (isOpen) {
              close()
            } else {
              inputRef.current?.focus()
              openList()
            }
          }}>
          {(loading || busy) && isOpen ? (
            <span className="cb-spin" aria-hidden="true" />
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
              aria-hidden="true">
              <path d="m6 9 6 6 6-6" />
            </svg>
          )}
        </button>
      </span>
      {invalid && errorText && (
        <span className="cb-error" id={errId} role="alert">{errorText}</span>
      )}

      {isOpen && createPortal(
        <div className={`cb-pop ${prefix}-pop ${creating ? 'is-creating' : ''}`}
          ref={popRef}
          // Clic/scroll en la lista sin perder el foco del input — salvo con
          // el form inline, que necesita el foco en sus propios inputs.
          onMouseDown={creating ? undefined : (e) => e.preventDefault()}
          onKeyDown={creating ? (e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              doneCreate(null)
            }
          } : undefined}>
          {creating && create?.render ? (
            <CreatePane<T> q={q} render={create.render} done={doneCreate} />
          ) : (
            <>
              <ul className="cb-list" id={listId} role="listbox"
                aria-label={listLabel ?? (ariaLabel ? `${ariaLabel} options` : 'Options')}>
                {shown.map((it, i) => {
                  const selected = !!isSelected?.(it)
                  return (
                    <li key={getKey(it)} id={optId(i)} role="option"
                      aria-selected={selected}
                      className={`cb-opt ${i === activeIdx ? 'is-active' : ''} ${
                        selected ? 'is-selected' : ''}`}
                      onMouseMove={() => {
                        if (i !== activeIdx) {
                          kbNav.current = false
                          setActive(i)
                        }
                      }}
                      onClick={() => choose(it)}>
                      {renderOption(it)}
                    </li>
                  )
                })}
                {canCreate && create && (
                  <li id={optId(shown.length)} role="option"
                    aria-selected={false}
                    className={`cb-opt cb-opt-create ${
                      activeIdx === shown.length ? 'is-active' : ''}`}
                    onMouseMove={() => {
                      if (activeIdx !== shown.length) {
                        kbNav.current = false
                        setActive(shown.length)
                      }
                    }}
                    onClick={() => { startCreate() }}>
                    <span className="cb-plus" aria-hidden="true">+</span>
                    <span className="cb-create-label">
                      {busy ? 'Creating…' : create.label(q)}
                    </span>
                  </li>
                )}
              </ul>
              {loading && total === 0 ? (
                <p className="cb-note">Loading…</p>
              ) : total === 0 && !canCreate ? (
                <p className="cb-note">
                  {emptyNote ? emptyNote(q)
                    : (typed && q ? <>No match for “{q}”</> : 'Nothing to pick yet')}
                </p>
              ) : total > shown.length ? (
                <p className="cb-note">
                  Showing {shown.length} of {total} — type to narrow
                </p>
              ) : null}
            </>
          )}
        </div>,
        document.body,
      )}
    </span>
  )
}
