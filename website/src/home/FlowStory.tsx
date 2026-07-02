// Connect-the-dots (patron Fleetio): un dia real, del defecto a la
// contabilidad, sin re-tipear. Linea de progreso ligada al scroll.
import { useRef } from 'react'
import { motion, useReducedMotion, useScroll, useSpring } from 'motion/react'
import Reveal from '../components/Reveal'
import { shell, eyebrow } from '../ui'
import { Pill } from './instrument'

const STEPS: Array<{
  time: string
  title: string
  body: string
  chip: React.ReactNode
}> = [
  {
    time: '06:42 AM',
    title: 'A driver flags a defect',
    body: 'The morning DVIR lands straight from the ELD. Air leak at the brake chamber on unit 402, flagged before the truck leaves the yard.',
    chip: (
      <>
        <span className="font-mono text-[11.5px] text-ink">402 · Brakes — air leak</span>
        <Pill kind="unsafe" />
      </>
    ),
  },
  {
    time: '06:43 AM',
    title: 'The work order opens itself',
    body: 'Defect in, work order out. Unit, complaint, and service history are prefilled; the shop just picks it up.',
    chip: (
      <>
        <span className="font-mono text-[11.5px] text-ink">WO-1201</span>
        <Pill kind="open" />
      </>
    ),
  },
  {
    time: '02:15 PM',
    title: "The shop's invoice gets scanned",
    body: 'Drop the PDF. The AI reads vendor, parts, and labor, matches the unit, and fills every line in about 3 seconds.',
    chip: (
      <span className="font-mono text-[11.5px] text-ink">
        6 lines · $1,284.50 · <span className="text-brand-bright">3.1s</span>
      </span>
    ),
  },
  {
    time: '09:00 PM',
    title: 'Costs land where they belong',
    body: 'Cost per unit updates, PM resets on real mileage, and the invoice is ready for your books, QuickBooks included.',
    chip: (
      <>
        <span className="font-mono text-[11.5px] text-ink">$1,284.50 → ledger</span>
        <Pill kind="ready" />
      </>
    ),
  },
]

export default function FlowStory() {
  const reduce = useReducedMotion()
  const listRef = useRef<HTMLOListElement>(null)
  const { scrollYProgress } = useScroll({
    target: listRef,
    offset: ['start 0.75', 'end 0.6'],
  })
  const progress = useSpring(scrollYProgress, { stiffness: 90, damping: 24 })

  return (
    <section id="flow" className="border-y border-line/60 bg-surface/30">
      <div className={`${shell} py-24`}>
        <Reveal className="max-w-2xl">
          <p className={eyebrow}>One day on Rigsmith</p>
          <h2 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] sm:text-4xl">
            From defect to booked cost, hands off
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-muted">
            The whole loop is native, so nothing gets re-typed between systems.
          </p>
        </Reveal>

        {/* Los rieles viven FUERA del <ol> (HTML valido: <ol> solo admite <li>)
            y en un wrapper propio para que space-y no los acorte. */}
        <div className="relative mt-14">
          <span
            aria-hidden="true"
            className="absolute bottom-2 left-[9px] top-2 w-px bg-line"
          />
          <motion.span
            aria-hidden="true"
            className="absolute bottom-2 left-[9px] top-2 w-px origin-top bg-brand-bright"
            style={reduce ? { scaleY: 1 } : { scaleY: progress }}
          />
          <ol ref={listRef} className="space-y-12 pl-12">
            {STEPS.map((s) => (
              <li key={s.title} className="relative">
                <Reveal y={16}>
                  <span
                    aria-hidden="true"
                    className="absolute -left-12 top-1 grid h-[19px] w-[19px] place-items-center rounded-full border border-line-strong bg-panel"
                  >
                    <span className="h-[7px] w-[7px] rounded-full bg-brand-bright shadow-[0_0_8px_#ff4438]" />
                  </span>
                  <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
                    {s.time}
                  </p>
                  <h3 className="mt-1.5 font-display text-xl font-bold tracking-[-0.02em] text-ink">
                    {s.title}
                  </h3>
                  <p className="mt-2 max-w-lg text-[15px] leading-relaxed text-muted">
                    {s.body}
                  </p>
                  <span className="mt-3 inline-flex items-center gap-2.5 rounded-xl border border-line bg-panel px-3.5 py-2">
                    {s.chip}
                  </span>
                </Reveal>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  )
}
