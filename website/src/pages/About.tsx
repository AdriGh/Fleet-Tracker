import { ArrowRight } from '@phosphor-icons/react'
import { APP_URL } from '../config'
import { btnPrimary, shell, eyebrow } from '../ui'

export default function About() {
  return (
    <section className={`${shell} pt-20 pb-28`}>
      <p className={eyebrow}>About</p>
      <h1 className="mt-3 max-w-3xl font-display text-4xl font-semibold leading-[1.1] tracking-[-0.02em] sm:text-5xl">
        Shop software drivers and mechanics actually like
      </h1>
      <div className="mt-6 max-w-xl space-y-4 text-lg leading-relaxed text-muted">
        <p>
          Fleet maintenance software has felt stuck for a decade: slow, clunky,
          and priced like it is doing you a favor. Rigsmith is the answer to
          that, built with a modern interface, native ELD sync, and AI that does
          the data entry for you.
        </p>
        <p>
          It runs a real fleet today across five terminals and hundreds of units.
          This page will grow with the story and the team behind it.
        </p>
      </div>
      <a href={APP_URL} className={`${btnPrimary} mt-10`}>
        Start free <ArrowRight size={18} weight="bold" />
      </a>
    </section>
  )
}
