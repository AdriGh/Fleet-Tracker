// Prueba social como panel de instrumentos: numeros reales de la flota que ya
// corre Rigsmith en produccion, en el StatCluster del design system (gauges
// con count-up y riel de ticks que se enciende al entrar en viewport).
import Reveal from '../components/Reveal'
import { shell, eyebrow } from '../ui'
import { Cluster, Gauge } from './instrument'

export default function InstrumentBand() {
  return (
    <section className="border-y border-line/60 bg-surface/30">
      <div className={`${shell} py-16 md:py-20`}>
        <Reveal className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className={eyebrow}>Live from production</p>
            <h2 className="mt-3 font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
              A real 430-unit fleet runs on it today
            </h2>
          </div>
          <p className="max-w-sm text-sm leading-relaxed text-muted">
            Not a demo environment. These are the working numbers of the fleet
            Rigsmith was forged in.
          </p>
        </Reveal>

        <Reveal delay={0.1} className="mt-10">
          <Cluster className="grid-cols-2 lg:grid-cols-4">
            <Gauge
              label="Fleet safe"
              countTo={94.2}
              decimals={1}
              suffix="%"
              sub="+1.8 pts vs last month"
              tone="ok"
              progress={0.94}
            />
            <Gauge
              label="Active units"
              countTo={430}
              sub="140 trucks · 290 trailers"
              tone="info"
              progress={0.78}
            />
            <Gauge
              label="Invoice scan"
              value="~3s"
              sub="vendor, parts, labor auto-filled"
              tone="accent"
              progress={0.14}
            />
            <Gauge
              label="Terminals"
              countTo={5}
              sub="one live dashboard"
              tone="neutral"
              progress={0.36}
            />
          </Cluster>
        </Reveal>
      </div>
    </section>
  )
}
