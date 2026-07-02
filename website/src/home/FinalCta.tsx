// Cierre: momento de marca. La llave ratchetea mientras la seccion esta en
// viewport y el tagline del rebrand carga el peso.
import { useRef } from 'react'
import { useInView } from 'motion/react'
import { ArrowRight } from '@phosphor-icons/react'
import { Link } from 'react-router-dom'
import Reveal from '../components/Reveal'
import { RigsmithMark } from '../components/Logo'
import { APP_URL } from '../config'
import { btnPrimary, btnGhost, shell } from '../ui'

export default function FinalCta() {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { amount: 0.5 })

  return (
    <section className={`${shell} pb-28 pt-4`}>
      <Reveal>
        <div
          ref={ref}
          className="relative overflow-hidden rounded-[2rem] border border-line bg-panel px-8 py-16 text-center md:py-20"
        >
          <div
            aria-hidden="true"
            className="absolute left-1/2 top-0 h-[340px] w-[640px] -translate-x-1/2 -translate-y-1/3 rounded-full bg-brand/15 blur-[110px]"
          />
          <div className="relative">
            <div className="flex justify-center">
              <RigsmithMark className="h-24 w-24" auto={inView} />
            </div>
            <h2 className="mt-6 font-display text-4xl font-bold tracking-[-0.02em] sm:text-5xl">
              Your fleet, <span className="text-brand-bright">forged right.</span>
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-muted">
              Free to start. Connect the ELD you already have, scan your first
              invoice, and watch a work order write itself.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <a href={APP_URL} className={btnPrimary}>
                Start free <ArrowRight size={18} weight="bold" />
              </a>
              <Link to="/pricing" className={btnGhost}>
                See pricing
              </Link>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  )
}
