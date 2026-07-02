// Comparacion honesta vs el suite legacy (Fullbay nombrado a proposito:
// es el reemplazo directo y el precio ancla del pitch).
import { CheckCircle, XCircle } from '@phosphor-icons/react'
import Reveal from '../components/Reveal'
import { eyebrow, shell } from '../ui'

const OLD_WAY = [
  'An interface designed a decade ago',
  'Line items typed by hand, one by one',
  'Telematics bolted on as an afterthought',
  'Locked into a $577/mo plan',
]
const NEW_WAY = [
  'A modern UI your team will actually use',
  'AI scans the invoice in about 3 seconds',
  'Native sync with the ELD you already run',
  'Priced to replace that $577/mo plan',
]

export default function Compare() {
  return (
    <section className={`${shell} py-24`}>
      <Reveal className="max-w-2xl">
        <p className={eyebrow}>Why teams switch</p>
        <h2 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] sm:text-4xl">
          Built to replace Fullbay, not to feel like it
        </h2>
      </Reveal>

      <div className="mt-12 grid gap-4 md:grid-cols-2">
        <Reveal>
          <div className="h-full rounded-3xl border border-line/70 bg-surface/40 p-8">
            <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-faint">
              Legacy shop software
            </h3>
            <ul className="mt-6 space-y-4">
              {OLD_WAY.map((t) => (
                <li key={t} className="flex items-start gap-3">
                  <XCircle size={22} className="mt-0.5 shrink-0 text-faint" />
                  <span className="text-[15px] leading-relaxed text-muted">{t}</span>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>

        <Reveal delay={0.08}>
          <div className="h-full rounded-3xl border border-brand-bright/40 bg-brand/[0.06] p-8">
            <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-brand-bright">
              Rigsmith
            </h3>
            <ul className="mt-6 space-y-4">
              {NEW_WAY.map((t) => (
                <li key={t} className="flex items-start gap-3">
                  <CheckCircle
                    size={22}
                    weight="fill"
                    className="mt-0.5 shrink-0 text-brand-bright"
                  />
                  <span className="text-[15px] leading-relaxed text-ink">{t}</span>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
