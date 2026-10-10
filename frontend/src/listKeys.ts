// Navegación ↑/↓/Home/End entre las filas [role=option] de un listbox
// maestro (Resources v2.22). El foco sigue a la selección, como en Service
// Requests. Sin refs: el contenedor sale del propio evento (currentTarget).
import type { KeyboardEvent } from 'react'

export function listKeyHandler<T>(
  items: T[], selIndex: number, select: (item: T) => void,
) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (!items.length) return
    let j = -1
    if (e.key === 'ArrowDown') j = Math.min(items.length - 1, selIndex + 1)
    else if (e.key === 'ArrowUp') j = Math.max(0, selIndex - 1)
    else if (e.key === 'Home') j = 0
    else if (e.key === 'End') j = items.length - 1
    if (j < 0) return
    e.preventDefault()
    const box = e.currentTarget
    select(items[j])
    window.requestAnimationFrame(() => {
      const opt = box.querySelectorAll<HTMLElement>('[role="option"]')[j]
      opt?.focus()
      opt?.scrollIntoView({ block: 'nearest' })
    })
  }
}
