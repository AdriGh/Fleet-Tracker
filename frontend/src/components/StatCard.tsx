import CountUp from './CountUp'
import { StatCard as Gauge, type StatTone } from './ds/StatCard'

/**
 * Adaptador legacy → gauge de instrumento del DS (rediseño jul-2026).
 * Mantiene la API vieja de las vistas (tone 'default', value number con
 * CountUp) y delega el render en ds/StatCard. Dentro de un <StatCluster>
 * el gauge suelta su chrome solo (via contexto).
 */
interface Props {
  label: string
  value: string | number
  sub?: string
  tone?: 'default' | 'danger' | 'ok' | 'warn' | 'accent' | 'info'
  /** 0–1: enciende el riel de ticks del gauge. */
  progress?: number
}

export default function StatCard({ label, value, sub, tone = 'default', progress }: Props) {
  const dsTone: StatTone = tone === 'default' ? 'neutral' : tone
  return (
    <Gauge
      label={label}
      value={typeof value === 'number' ? <CountUp value={value} /> : value}
      sub={sub}
      tone={dsTone}
      progress={progress}
    />
  )
}
