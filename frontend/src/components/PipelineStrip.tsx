// PipelineStrip (v2.21): la tira de métricas que reemplaza a las tarjetas
// negras grandes de Work Orders. UNA fila fina (≤ 72px en desktop): a la
// izquierda los segmentos del pipeline (conteo + etiqueta + una barrita
// proporcional al máximo), clicables para aplicar ese filtro; a la derecha
// mini-KPIs de solo lectura ("Parts blocking", "Cost 30d"). En móvil pasa a
// dos filas (segmentos arriba, KPIs abajo).
//
// Es genérica a propósito: el Dashboard u otras páginas pueden adoptarla
// pasando sus propios segmentos/KPIs (no se toca el Dashboard en v2.21).
import type { ReactNode } from 'react'

export type StripTone = 'neutral' | 'warn' | 'info' | 'ok' | 'accent'

export type StripSegment = {
  key: string
  label: string
  count: number
  tone?: StripTone
  /** Tooltip del segmento. */
  title?: string
}

export type StripKpi = {
  key?: string
  label: string
  value: ReactNode
  tone?: StripTone
  title?: string
}

export default function PipelineStrip({
  segments, active = null, onSelect, kpis = [], loading = false,
  className = '', 'aria-label': ariaLabel = 'Pipeline',
}: {
  segments: StripSegment[]
  /** Segmento resaltado (p. ej. el filtro de status aplicado). */
  active?: string | null
  /** Sin onSelect los segmentos son estáticos (no botones). */
  onSelect?: (key: string) => void
  kpis?: StripKpi[]
  loading?: boolean
  className?: string
  'aria-label'?: string
}) {
  const max = Math.max(1, ...segments.map((s) => s.count))
  return (
    <div className={`pstrip ${loading ? 'is-loading' : ''} ${className}`}
      role="group" aria-label={ariaLabel}>
      <div className="pstrip-segs">
        {segments.map((s) => {
          const pct = Math.round((s.count / max) * 100)
          const cls = `pstrip-seg t-${s.tone ?? 'neutral'}`
            + `${active === s.key ? ' is-active' : ''}`
            + `${s.count === 0 ? ' is-zero' : ''}`
          const body = (
            <>
              <span className="pstrip-count mono">
                {loading ? '–' : s.count}
              </span>
              <span className="pstrip-label">{s.label}</span>
              <span className="pstrip-bar" aria-hidden="true">
                <i style={{ width: `${loading ? 0 : pct}%` }} />
              </span>
            </>
          )
          return onSelect ? (
            <button type="button" key={s.key} className={cls}
              aria-pressed={active === s.key}
              title={s.title ?? (active === s.key
                ? `Clear the ${s.label} filter`
                : `Show only ${s.label.toLowerCase()}`)}
              onClick={() => onSelect(s.key)}>
              {body}
            </button>
          ) : (
            <div key={s.key} className={cls} title={s.title}>{body}</div>
          )
        })}
      </div>
      {kpis.length > 0 && (
        <div className="pstrip-kpis">
          {kpis.map((k, i) => (
            <div key={k.key ?? i} className={`pstrip-kpi t-${k.tone ?? 'neutral'}`}
              title={k.title}>
              <span className="pstrip-kpi-label">{k.label}</span>
              <span className="pstrip-kpi-value mono">
                {loading ? '–' : k.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
