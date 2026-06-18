import { useEffect, useRef, useState } from 'react'

const REDUCED =
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

type Props = {
  value: number
  duration?: number // ms
  format?: (n: number) => string
}

/**
 * Animated number that eases up from its previous value to `value` (count-up).
 * Used on dashboard KPIs. Respects prefers-reduced-motion (jumps to the value).
 */
export default function CountUp({ value, duration = 900, format }: Props) {
  const fmt = format ?? ((n: number) => Math.round(n).toLocaleString())
  const [display, setDisplay] = useState(REDUCED ? value : 0)
  const fromRef = useRef(0)
  const rafRef = useRef(0)

  useEffect(() => {
    if (REDUCED) {
      setDisplay(value)
      return
    }
    const from = fromRef.current
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3) // easeOutCubic
      setDisplay(from + (value - from) * eased)
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        fromRef.current = value
      }
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [value, duration])

  return <>{fmt(display)}</>
}
