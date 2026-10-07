// UnitPicker (v2.20 addendum): combobox con búsqueda para elegir una unidad
// EXISTENTE de la flota. Reemplaza los <input list=…> de texto libre: la
// misma unidad escrita distinto ("MEM 77" / "MEM77") ya no se parte en dos.
//
// Contrato con el padre:
//  - `value` es el texto del input (controlado) y `onChange` recibe:
//      · el texto tal cual mientras se escribe;
//      · el nombre CANÓNICO de la flota al elegir una opción, o cuando el
//        texto coincide exacto normalizado (mayúsculas, sin espacios):
//        "mem77" → "MEM 77" — también si el valor vino de afuera (un escaneo).
//  - Validez: el padre la deriva con `useUnitMatcher(units).isValid(value)`
//    (src/unitMatch.ts), la misma fuente que usa el picker → nunca queda
//    desfasada, y sirve igual para listas (los complaints de una WO). Así
//    el padre deshabilita Guardar y manda `canonical(value)` al backend.
//  - Texto que no coincide con nada: se conserva (no se pierde lo escaneado)
//    y, fuera de foco, se marca con "Pick a unit from the list".
//  - Si la flota falla o está vacía se degrada a un input de texto común
//    (isValid acepta cualquier texto no vacío): nunca bloquea al usuario.
//    Es el MISMO <input> en todos los modos (solo cambian el ARIA, el botón
//    y la lista): si la flota llega fallida mientras se escribe, el input no
//    se re-monta ni pierde el foco.
//  - `extraUnits`: unidades que la app ya muestra fuera de /api/fleet (las
//    del backlog, las del board). El padre pasa la MISMA lista a
//    useUnitMatcher(undefined, extra) para validar igual.
//
// El desplegable va en un portal a <body> con position:fixed: no lo recorta
// el overflow del .modal-body y queda por encima del modal.
import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  filterUnits, unitDescription, useUnitMatcher, type PickerUnit,
} from '../unitMatch'

// Tope de opciones renderizadas (flotas de cientos de unidades): con texto
// se acota sola; sin texto se avisa que se puede escribir para filtrar.
const MAX_OPTIONS = 150

interface Props {
  value: string
  onChange: (value: string) => void
  // Reemplaza la flota (p. ej. solo las unidades del board de PM/DOT).
  units?: PickerUnit[]
  // Se suman a la flota (ver useUnitMatcher): backlog, board, etc.
  extraUnits?: PickerUnit[]
  // La grafía de extraUnits gana sobre la de la flota (board de PM/DOT).
  extraWins?: boolean
  placeholder?: string
  autoFocus?: boolean
  disabled?: boolean
  // Clase del contenedor (ancho/flex en el layout del padre).
  className?: string
  inputClassName?: string
  'aria-label'?: string
  title?: string
}

export default function UnitPicker({
  value, onChange, units: override, extraUnits, extraWins,
  placeholder = 'Pick a unit', autoFocus, disabled, className = '',
  inputClassName = '', 'aria-label': ariaLabel, title,
}: Props) {
  const m = useUnitMatcher(override, extraUnits, extraWins)
  const uid = useId()
  const listId = `${uid}-list`
  const errId = `${uid}-err`
  const optId = (i: number) => `${uid}-opt-${i}`

  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const [active, setActive] = useState(0)
  // Con el texto completo la lista arranca sin filtrar (ver opciones al
  // abrir sobre un valor ya elegido); al escribir se filtra.
  const [typed, setTyped] = useState(false)
  const boxRef = useRef<HTMLSpanElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)
  const kbNav = useRef(false)

  const hit = m.find(value)
  const options = useMemo(
    () => filterUnits(m.units, typed ? value : ''),
    [m.units, typed, value])
  const shown = options.slice(0, MAX_OPTIONS)
  const activeIdx = shown.length ? Math.min(Math.max(active, 0), shown.length - 1) : -1
  const strict = m.mode === 'strict'
  const invalid = strict && !focused && !!value.trim() && !hit
  const isOpen = open && !disabled && m.mode !== 'free'

  // Valor que llega de afuera (escaneo, unidad por defecto) con otra grafía:
  // se ajusta al nombre canónico apenas hay flota. Mientras se escribe no:
  // eso lo resuelve onInput.
  useEffect(() => {
    if (!focused && hit && hit.unit !== value) onChange(hit.unit)
  }, [focused, hit, value, onChange])

  // Posición del desplegable (fixed, relativo al input). Abre hacia abajo;
  // si no entra y arriba hay más lugar, hacia arriba. Se escribe directo en
  // el style (sin estado) en cada scroll/resize.
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
    // .up-pop es el contenedor que scrollea: scrollHeight = alto natural.
    const want = Math.min(pop.scrollHeight, 300)
    const up = below < Math.min(want, 200) && above > below
    const maxH = Math.max(96, Math.min(300, up ? above : below))
    const width = Math.min(Math.max(r.width, 260), vw - pad * 2)
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
  }, [isOpen, place, shown.length, m.mode])

  // Mientras está abierta sigue al input cuadro a cuadro: cubre scroll
  // (página o .modal-body), resize, teclado del teléfono y la animación de
  // entrada del Modal (con autoFocus se puede escribir mientras el modal
  // todavía escala). Solo reescribe el style si el input se movió.
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

  // La opción activa por teclado siempre visible dentro del scroll.
  useEffect(() => {
    if (!isOpen || !kbNav.current || activeIdx < 0) return
    document.getElementById(`${uid}-opt-${activeIdx}`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [isOpen, activeIdx, uid])

  function openList() {
    if (disabled) return
    // Sobre un valor ya elegido: lista completa con esa unidad activa.
    const base = filterUnits(m.units, '')
    const i = hit ? base.findIndex((u) => u.unit === hit.unit) : -1
    setTyped(false)
    setActive(i >= 0 && i < MAX_OPTIONS ? i : 0)
    setOpen(true)
  }

  function choose(u: PickerUnit) {
    onChange(u.unit)
    setOpen(false)
    setTyped(false)
    kbNav.current = false
  }

  function onInput(text: string) {
    // Coincidencia exacta normalizada → nombre canónico de una vez.
    const exact = m.find(text)
    onChange(exact ? exact.unit : text)
    setTyped(true)
    setActive(0)
    kbNav.current = false
    // Si el texto ya es una unidad y es la ÚNICA opción, la lista se cierra:
    // no queda tapando el campo siguiente (el click iría a la lista y lo que
    // se escriba después terminaría en este input).
    const only = !!exact && filterUnits(m.units, text).length <= 1
    if (m.mode !== 'free') setOpen(!only)
  }

  // Al salir: cerrar y, si el texto es una unidad, dejarlo canónico. Si no
  // coincide queda tal cual y se ve el error (invalid, fuera de foco).
  function commit() {
    setOpen(false)
    setTyped(false)
    kbNav.current = false
    if (hit && hit.unit !== value) onChange(hit.unit)
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (m.mode === 'free') return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      kbNav.current = true
      if (!isOpen) {
        openList()
        return
      }
      if (!shown.length) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive(Math.max(0, Math.min(shown.length - 1, activeIdx + step)))
    } else if (e.key === 'Enter') {
      if (isOpen && activeIdx >= 0 && shown[activeIdx]) {
        // No enviar el form: Enter elige la opción.
        e.preventDefault()
        choose(shown[activeIdx])
      } else {
        commit()
      }
    } else if (e.key === 'Escape') {
      if (isOpen) {
        // Solo cierra la lista; el Modal (listener en document) no se entera.
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        setTyped(false)
      }
    } else if (e.key === 'Tab') {
      // Tab acepta la opción solo si se eligió con flechas; el foco sigue
      // su camino normal (sin preventDefault).
      if (isOpen && kbNav.current && activeIdx >= 0 && shown[activeIdx]) {
        choose(shown[activeIdx])
      }
    }
  }

  // Sin flota (falló, vacía o parcial): texto común — pero el MISMO input
  // (misma posición en el árbol): cambiar de modo no lo re-monta.
  const free = m.mode === 'free'
  const total = options.length
  return (
    <span className={`up-root ${invalid ? 'is-invalid' : ''} ${
      free ? 'is-free' : ''} ${className}`}>
      <span className="up-field" ref={boxRef}>
        <input ref={inputRef}
          className={`cell-input up-input ${inputClassName}`}
          role={free ? undefined : 'combobox'}
          aria-autocomplete={free ? undefined : 'list'}
          aria-expanded={free ? undefined : isOpen}
          aria-controls={free ? undefined : listId}
          aria-activedescendant={isOpen && activeIdx >= 0
            ? optId(activeIdx) : undefined}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errId : undefined}
          aria-label={ariaLabel}
          title={title}
          value={value} placeholder={placeholder}
          autoFocus={autoFocus} disabled={disabled}
          autoComplete="off" autoCapitalize="characters" spellCheck={false}
          onChange={(e) => onInput(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => { setFocused(false); commit() }}
          onMouseDown={() => { if (!free && !isOpen && !disabled) openList() }}
          onKeyDown={onKey} />
        {!free && <button type="button" className="up-toggle" tabIndex={-1}
          aria-label={isOpen ? 'Close unit list' : 'Open unit list'}
          disabled={disabled}
          // Sin robarle el foco al input (si no, el blur cierra la lista).
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (isOpen) {
              setOpen(false)
              setTyped(false)
            } else {
              inputRef.current?.focus()
              openList()
            }
          }}>
          {m.mode === 'loading' && isOpen ? (
            <span className="up-spin" aria-hidden="true" />
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
              aria-hidden="true">
              <path d="m6 9 6 6 6-6" />
            </svg>
          )}
        </button>}
      </span>
      {invalid && (
        <span className="up-error" id={errId} role="alert">
          Pick a unit from the list
        </span>
      )}

      {isOpen && createPortal(
        <div className="up-pop" ref={popRef}
          // Clic/scroll en la lista sin perder el foco del input.
          onMouseDown={(e) => e.preventDefault()}>
          <ul className="up-list" id={listId} role="listbox"
            aria-label={ariaLabel ? `${ariaLabel} options` : 'Units'}>
            {shown.map((u, i) => {
              const desc = unitDescription(u)
              const kind = u.unit_type || u.kind || ''
              const selected = hit?.unit === u.unit
              return (
                <li key={u.unit} id={optId(i)} role="option"
                  aria-selected={selected}
                  className={`up-opt ${i === activeIdx ? 'is-active' : ''} ${
                    selected ? 'is-selected' : ''}`}
                  onMouseMove={() => {
                    if (i !== activeIdx) {
                      kbNav.current = false
                      setActive(i)
                    }
                  }}
                  onClick={() => choose(u)}>
                  <strong className="up-unit">{u.unit}</strong>
                  <span className="up-desc">
                    {[desc, u.company].filter(Boolean).join(' · ')}
                  </span>
                  {u.archived && <span className="up-tag is-muted">archived</span>}
                  {kind && <span className={`up-tag up-k-${kind}`}>{kind}</span>}
                </li>
              )
            })}
          </ul>
          {m.mode === 'loading' ? (
            <p className="up-note">Loading units…</p>
          ) : total === 0 ? (
            <p className="up-note">
              {typed && value.trim()
                ? <>No unit matches “{value.trim()}”</>
                : 'No units in the fleet list'}
            </p>
          ) : total > shown.length ? (
            <p className="up-note">
              Showing {shown.length} of {total} — type to narrow
            </p>
          ) : null}
        </div>,
        document.body,
      )}
    </span>
  )
}
