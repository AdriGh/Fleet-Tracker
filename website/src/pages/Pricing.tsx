import { ArrowRight } from '@phosphor-icons/react'
import { APP_URL } from '../config'
import { btnPrimary, shell, eyebrow } from '../ui'

export default function Pricing() {
  return (
    <section className={`${shell} pt-20 pb-28`}>
      <p className={eyebrow}>Pricing</p>
      <h1 className="mt-3 max-w-3xl font-display text-4xl font-semibold leading-[1.1] tracking-[-0.02em] sm:text-5xl">
        Priced to replace a $577 a month plan
      </h1>
      <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted">
        The detailed plans are being finalized and will land on this page soon.
        You can start free in the meantime and bring your fleet online today.
      </p>
      <a href={APP_URL} className={`${btnPrimary} mt-10`}>
        Start free <ArrowRight size={18} weight="bold" />
      </a>
    </section>
  )
}
