// Pila de capas superpuestas (v2.22): Escape cierra SOLO la capa de arriba
// (modal, command palette, menú "+", flyout del riel). Cada capa registra su
// propio listener; el que es tope atiende el Escape y lo marca como
// consumido, así el resto lo ignora sin importar el orden de los listeners.
// Se marca en un WeakSet y NO con preventDefault: Radix/vaul llaman
// preventDefault por su cuenta y eso no debe "tragarse" el Escape de la capa.
import { useEffect, useRef, type RefObject } from 'react'

let seq = 0
const stack: number[] = []
const handled = new WeakSet<Event>()

export function pushLayer(): number {
  seq += 1
  stack.push(seq)
  return seq
}

export function popLayer(id: number) {
  const i = stack.lastIndexOf(id)
  if (i >= 0) stack.splice(i, 1)
}

export function isTopLayer(id: number): boolean {
  return stack[stack.length - 1] === id
}

// Marca/consulta de un Escape ya atendido por otra capa.
export function claimEscape(e: Event): boolean {
  if (handled.has(e)) return false
  handled.add(e)
  return true
}

/** Registra una capa mientras `active`; `onEsc` corre solo si es la de arriba. */
export function useEscLayer(active: boolean, onEsc: () => void) {
  const cb = useRef(onEsc)
  useEffect(() => { cb.current = onEsc }, [onEsc])
  useEffect(() => {
    if (!active) return
    const id = pushLayer()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTopLayer(id)) return
      if (!claimEscape(e)) return
      cb.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      popLayer(id)
    }
  }, [active])
}

/** Clic/tap fuera de los elementos dados (el ancla incluida) cierra. */
export function useOutsidePress(
  active: boolean,
  refs: RefObject<HTMLElement | null>[],
  onOutside: () => void,
) {
  const cb = useRef(onOutside)
  useEffect(() => { cb.current = onOutside }, [onOutside])
  const refsRef = useRef(refs)
  useEffect(() => { refsRef.current = refs })
  useEffect(() => {
    if (!active) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (refsRef.current.some((r) => r.current?.contains(t))) return
      cb.current()
    }
    // Captura: un stopPropagation de la página no impide cerrar.
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [active])
}
