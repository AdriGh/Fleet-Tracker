// About: la historia real (nacido dentro de una flota que trabaja, sin
// nombres inventados ni fotos de stock de equipo), la historia del nombre y
// la marca, y tres valores. Anti-slop: numeros duros, cero humo.
import { useRef } from 'react'
import { useInView } from 'motion/react'
import { ArrowRight } from '@phosphor-icons/react'
import { Link } from 'react-router-dom'
import Reveal from '../components/Reveal'
import { RigsmithMark } from '../components/Logo'
import { APP_URL } from '../config'
import { btnPrimary, btnGhost, shell, eyebrow } from '../ui'
import { Cluster, Gauge } from '../home/instrument'

const VALUES: Array<[string, string]> = [
  [
    'Blue-collar first',
    'Built beside the mechanics who use it, for hands that wear gloves. If a feature slows the shop down, it does not ship.',
  ],
  [
    'Transparent',
    'Public pricing, monthly billing, and your data exports to CSV any day you want it. No quote calls, no hostage data.',
  ],
  [
    'Fast',
    'A three-second invoice scan set the bar. Every screen is expected to keep up with the person using it.',
  ],
]

export default function About() {
  const markRef = useRef<HTMLDivElement>(null)
  const markInView = useInView(markRef, { amount: 0.5 })

  return (
    <>
      <section className={`${shell} pb-14 pt-20`}>
        <Reveal className="max-w-2xl">
          <p className={eyebrow}>About</p>
          <h1 className="mt-3 font-display text-4xl font-semibold leading-[1.1] tracking-[-0.02em] sm:text-5xl">
            Forged inside a working fleet
          </h1>
        </Reveal>
        <Reveal delay={0.08} className="mt-8 max-w-2xl space-y-5 text-lg leading-relaxed text-muted">
          <p>
            Rigsmith was not designed in a pitch deck. It started inside a real
            operation: 430 units across five terminals, a shop paying over
            $500 a month for a legacy suite, and a compliance workflow held
            together by spreadsheets.
          </p>
          <p>
            So it got built beside the shop, one working feature at a time.
            First the daily DVIR boards, because that was the morning fire.
            Then preventive maintenance on real synced mileage. Then work
            orders, and the AI scan that writes them from the shop&apos;s own
            invoices in about three seconds. Piece by piece, the old suite had
            nothing left to do.
          </p>
          <p>
            That fleet runs on Rigsmith in production today. The numbers on
            this site are not projections; they are its working numbers.
          </p>
        </Reveal>
      </section>

      {/* ---------- Numeros de la flota ---------- */}
      <section className="border-y border-line/60 bg-surface/30">
        <div className={`${shell} py-14`}>
          <Cluster className="grid-cols-2 lg:grid-cols-4">
            <Gauge
              label="Units in production"
              countTo={430}
              sub="140 trucks · 290 trailers"
              tone="info"
              progress={0.78}
            />
            <Gauge label="Terminals" countTo={5} sub="one live dashboard" tone="neutral" progress={0.36} />
            <Gauge
              label="Invoice scan"
              value="~3s"
              sub="the bar for everything else"
              tone="accent"
              progress={0.14}
            />
            <Gauge
              label="Fleet safe"
              countTo={94.2}
              decimals={1}
              suffix="%"
              sub="and climbing"
              tone="ok"
              progress={0.94}
            />
          </Cluster>
        </div>
      </section>

      {/* ---------- El nombre ---------- */}
      <section className={`${shell} py-20`}>
        <div className="grid items-center gap-10 md:grid-cols-[0.8fr_1.2fr]">
          <Reveal>
            <div ref={markRef} className="flex justify-center md:justify-start">
              <RigsmithMark className="h-40 w-40" auto={markInView} />
            </div>
          </Reveal>
          <Reveal delay={0.08}>
            <p className={eyebrow}>The name</p>
            <h2 className="mt-3 font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
              Rig, the machine. Smith, the craft.
            </h2>
            <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-muted">
              A rig is the truck. A smith is the person who works metal until
              it is right. The mark says the same thing: a faceted R for the
              rig, with a combination wrench as its stem, open jaw up, hex ring
              down. Put a cursor on it and it ratchets.
            </p>
            <p className="mt-3 max-w-lg text-[15px] leading-relaxed text-muted">
              Your fleet, forged right.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ---------- Valores ---------- */}
      <section className="border-y border-line/60 bg-surface/30">
        <div className={`${shell} py-20`}>
          <Reveal className="max-w-2xl">
            <p className={eyebrow}>How we work</p>
            <h2 className="mt-3 font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
              Three rules the product lives by
            </h2>
          </Reveal>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {VALUES.map(([title, body], i) => (
              <Reveal key={title} delay={i * 0.06}>
                <div className="h-full rounded-2xl border border-line/70 bg-surface/40 p-6">
                  <h3 className="font-display text-[17px] font-bold tracking-[-0.02em] text-ink">
                    {title}
                  </h3>
                  <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- CTA ---------- */}
      <section className={`${shell} py-20`}>
        <Reveal>
          <div className="flex flex-wrap items-center justify-between gap-6 rounded-[2rem] border border-line bg-panel px-8 py-10">
            <div>
              <h2 className="font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
                Put it on your fleet
              </h2>
              <p className="mt-2 text-[15px] text-muted">
                Free to start. If it does not earn its keep, export your data
                and walk.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <a href={APP_URL} className={btnPrimary}>
                Start free <ArrowRight size={18} weight="bold" />
              </a>
              <Link to="/features" className={btnGhost}>
                See the features
              </Link>
            </div>
          </div>
        </Reveal>
      </section>
    </>
  )
}
