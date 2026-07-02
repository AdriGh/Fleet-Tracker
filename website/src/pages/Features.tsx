import { ArrowRight } from '@phosphor-icons/react'
import { APP_URL } from '../config'
import { btnPrimary, shell, eyebrow } from '../ui'

const FEATURES = [
  ['DVIR compliance', 'Daily inspection reports built from your ELD, defects flagged on arrival.'],
  ['AI invoice scanning', "Read the shop's PDF and fill the work order in about 3 seconds."],
  ['Work orders', 'Multi-unit orders with parts, labor, and a printable invoice.'],
  ['PM tracking', 'Mileage-based preventive maintenance with alerts before service is due.'],
  ['Cold chain', 'Reefer temps and alarms watched in real time.'],
  ['Live map', 'Location, duty status, fuel, and open defects for the whole fleet.'],
]

export default function Features() {
  return (
    <section className={`${shell} pt-20 pb-28`}>
      <p className={eyebrow}>Features</p>
      <h1 className="mt-3 max-w-3xl font-display text-4xl font-semibold leading-[1.1] tracking-[-0.02em] sm:text-5xl">
        Everything Rigsmith does
      </h1>
      <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted">
        The short version below. A full walkthrough of each area is landing here
        next.
      </p>

      <div className="mt-14 grid gap-x-10 gap-y-10 sm:grid-cols-2">
        {FEATURES.map(([title, body]) => (
          <div key={title} className="border-t border-line/70 pt-5">
            <h2 className="font-display text-xl font-semibold text-ink">{title}</h2>
            <p className="mt-2 max-w-md text-[15px] leading-relaxed text-muted">{body}</p>
          </div>
        ))}
      </div>

      <a href={APP_URL} className={`${btnPrimary} mt-14`}>
        Start free <ArrowRight size={18} weight="bold" />
      </a>
    </section>
  )
}
