// Primitivos de instrumento del design system Rigsmith (StatCard/StatCluster
// del handoff jul-2026), portados a TSX con animacion de entrada: el valor
// cuenta hacia arriba y los ticks del riel se encienden en secuencia.
// El panel es SIEMPRE dark (binnacle) — los hex literales son la excepcion
// intencional del DS, no los cambies por tokens.
import { useEffect, useRef, useState } from 'react'
import { useInView, useReducedMotion } from 'motion/react'

const TICKS = 22

export const TONES = {
  neutral: { led: '#4a4a52', tick: '#a1a1aa', glow: false },
  danger: { led: '#fb7185', tick: '#fb7185', glow: true },
  ok: { led: '#34d399', tick: '#34d399', glow: false },
  warn: { led: '#fbbf24', tick: '#fbbf24', glow: false },
  info: { led: '#38bdf8', tick: '#38bdf8', glow: false },
  accent: { led: '#ff4438', tick: '#ff4438', glow: true },
} as const
export type Tone = keyof typeof TONES

// Cuenta 0 -> target con ease-out cubico cuando `active` pasa a true.
export function useCountUp(target: number, active: boolean, duration = 1400) {
  const [v, setV] = useState(0)
  useEffect(() => {
    if (!active) return
    let raf = 0
    const t0 = performance.now()
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / duration)
      setV(target * (1 - Math.pow(1 - p, 3)))
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [active, target, duration])
  return v
}

export function Gauge({
  label,
  value,
  countTo,
  decimals = 0,
  suffix = '',
  sub,
  tone = 'neutral',
  progress,
}: {
  label: string
  value?: string
  countTo?: number
  decimals?: number
  suffix?: string
  sub?: string
  tone?: Tone
  progress?: number
}) {
  const t = TONES[tone]
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, amount: 0.5 })
  const reduce = useReducedMotion()
  const active = inView || !!reduce
  const n = useCountUp(countTo ?? 0, active && !reduce)
  const shown =
    countTo != null
      ? (reduce ? countTo : n).toFixed(decimals) + suffix
      : value
  const lit =
    progress == null
      ? 0
      : Math.round(Math.min(1, Math.max(0, progress)) * TICKS)

  return (
    <div ref={ref} className="flex min-w-0 flex-col bg-panel px-5 pb-3.5 pt-4">
      <span className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[10px] uppercase tracking-[0.12em] text-[#a1a1aa]">
          {label}
        </span>
        <span
          aria-hidden="true"
          className="h-[7px] w-[7px] flex-none rounded-full"
          style={{
            background: t.led,
            boxShadow: t.glow ? `0 0 8px ${t.led}` : 'none',
          }}
        />
      </span>
      <span className="mt-2 font-display text-[1.7rem] font-bold leading-[1.05] tracking-[-0.02em] text-[#f4f4f5] tabular-nums">
        {shown}
      </span>
      {sub != null && (
        <span className="mt-1.5 font-mono text-[10.5px] text-[#6b6b76]">{sub}</span>
      )}
      <span
        aria-hidden="true"
        className="mt-auto flex items-end gap-[4px] pt-3"
      >
        {Array.from({ length: TICKS }, (_, i) => {
          const on = active && i < lit
          return (
            <span
              key={i}
              className="w-[2px] flex-none rounded-[1px] transition-all duration-300"
              style={{
                height: on ? 10 : 7,
                background: on ? t.tick : '#35353b',
                transitionDelay: reduce ? '0ms' : `${i * 45 + 300}ms`,
              }}
            />
          )
        })}
      </span>
    </div>
  )
}

// El panel de instrumentos: funde gauges en UNA sola placa con divisores
// hairline (#232327 via gap-px). Nunca tiles sueltos en grilla.
export function Cluster({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={`grid gap-px overflow-hidden rounded-[14px] border border-[#27272b] bg-[#232327] ${className}`}
    >
      {children}
    </div>
  )
}

// StatusPill del DS (semantica UI dark-safe).
const PILL_TONES = {
  safe: { bg: 'rgba(52,211,153,.15)', fg: '#34d399', label: 'SAFE' },
  resolved: { bg: 'rgba(56,189,248,.15)', fg: '#38bdf8', label: 'RESOLVED' },
  unsafe: { bg: 'rgba(251,113,133,.15)', fg: '#fb7185', label: 'UNSAFE' },
  open: { bg: 'rgba(251,191,36,.15)', fg: '#fbbf24', label: 'OPEN' },
  ok: { bg: 'rgba(52,211,153,.15)', fg: '#34d399', label: 'OK' },
  alarm: { bg: 'rgba(251,113,133,.15)', fg: '#fb7185', label: 'ALARM' },
  draft: { bg: 'rgba(161,161,170,.15)', fg: '#a1a1aa', label: 'DRAFT' },
  ready: { bg: 'rgba(52,211,153,.15)', fg: '#34d399', label: 'READY' },
} as const

export function Pill({
  kind,
  children,
}: {
  kind: keyof typeof PILL_TONES
  children?: React.ReactNode
}) {
  const t = PILL_TONES[kind]
  return (
    <span
      className="inline-flex items-center whitespace-nowrap rounded-full px-[9px] py-[3px] text-[11.5px] font-bold tracking-[0.02em]"
      style={{ background: t.bg, color: t.fg }}
    >
      {children ?? t.label}
    </span>
  )
}
