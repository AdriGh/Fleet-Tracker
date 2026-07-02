import React from 'react'
import { useInCluster } from './StatCluster'

/**
 * StatCard (rediseño Rigsmith jul-2026): gauge de instrumento KPI — label
 * mono uppercase + LED de tono, valor pesado tabular, sub mono y un riel de
 * 22 ticks que puede mostrar progreso. Reemplaza a la vieja tarjeta blanca
 * con barra de acento izquierda. Es dark en AMBOS temas (un binnacle
 * empotrado en la página, no otra tarjeta flotante) — los hex literales son
 * intencionales del DS, no los pases a tokens.
 * Preferir fusionarlos dentro de <StatCluster>; standalone trae su chrome.
 */

const TICKS = 22

const TONES = {
  neutral: { led: '#4a4a52', tick: '#a1a1aa', glow: false },
  danger: { led: '#fb7185', tick: '#fb7185', glow: true },
  ok: { led: '#34d399', tick: '#34d399', glow: false },
  warn: { led: '#fbbf24', tick: '#fbbf24', glow: false },
  info: { led: '#38bdf8', tick: '#38bdf8', glow: false },
  accent: { led: '#ff4438', tick: '#ff4438', glow: true },
} as const

export type StatTone = keyof typeof TONES

type StatCardProps = {
  label?: React.ReactNode
  value?: React.ReactNode
  sub?: React.ReactNode
  tone?: StatTone
  /** 0–1: fracción del riel de 22 ticks encendida en el color del tono. */
  progress?: number
  /** Enciende los ticks despues de `progress` en un segundo tono (ratios). */
  splitTone?: StatTone
} & React.HTMLAttributes<HTMLDivElement>

export function StatCard({
  label,
  value,
  sub,
  tone = 'neutral',
  progress,
  splitTone,
  className,
  style = {},
  ...rest
}: StatCardProps) {
  const t = TONES[tone] ?? TONES.neutral
  const split = splitTone != null ? TONES[splitTone] ?? TONES.neutral : null
  const inCluster = useInCluster()
  const lit =
    progress == null
      ? 0
      : Math.round(Math.min(1, Math.max(0, progress)) * TICKS)

  const chrome: React.CSSProperties = inCluster
    ? {}
    : {
        background: '#131316',
        border: '1px solid #27272b',
        borderRadius: 14,
        overflow: 'hidden',
      }

  return (
    <div
      className={`ft-stat-card tone-${tone}` + (className ? ' ' + className : '')}
      style={{
        padding: '16px 20px 14px',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        ...chrome,
        ...style,
      }}
      {...rest}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            letterSpacing: 'var(--tracking-label)',
            textTransform: 'uppercase',
            color: '#a1a1aa',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {label}
        </span>
        <span
          aria-hidden="true"
          style={{
            flex: 'none',
            width: 7,
            height: 7,
            borderRadius: 999,
            background: t.led,
            boxShadow: t.glow ? `0 0 8px ${t.led}` : 'none',
          }}
        />
      </span>
      <span
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'var(--fs-stat)',
          fontWeight: 800,
          lineHeight: 1.05,
          letterSpacing: 'var(--tracking-display)',
          fontVariantNumeric: 'tabular-nums',
          color: '#f4f4f5',
          marginTop: 8,
        }}
      >
        {value}
      </span>
      {sub != null && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '10.5px',
            color: '#6b6b76',
            marginTop: 6,
          }}
        >
          {sub}
        </span>
      )}
      <span
        aria-hidden="true"
        style={{
          display: 'flex',
          gap: 4,
          alignItems: 'flex-end',
          marginTop: 'auto',
          paddingTop: 12,
        }}
      >
        {Array.from({ length: TICKS }, (_, i) => {
          const on = i < lit
          const onSplit = !on && split != null && progress != null
          return (
            <span
              key={i}
              style={{
                flex: 'none',
                width: 2,
                height: on || onSplit ? 10 : 7,
                borderRadius: 1,
                background: on ? t.tick : onSplit ? split!.tick : '#35353b',
              }}
            />
          )
        })}
      </span>
    </div>
  )
}
