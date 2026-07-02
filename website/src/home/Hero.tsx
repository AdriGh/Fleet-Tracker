// Hero cinematico: la escena cuenta el pitch literal — una factura de taller
// se escanea (beam) y la work order se escribe sola al lado. Composicion en
// 3D leve (perspective + rotate) que se aplana al scrollear; loop de ~7s.
// Con prefers-reduced-motion se muestra el estado final, sin loop ni tilt.
import { useRef } from 'react'
import {
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
} from 'motion/react'
import { ArrowRight, CheckCircle, Lightning } from '@phosphor-icons/react'
import { APP_URL, PHOTOS } from '../config'
import { btnPrimary, btnGhost, shell, eyebrow } from '../ui'
import { Pill } from './instrument'

const CYCLE = 7

// Aparece en la fraccion `at` del ciclo y se desvanece al final (loop).
function Stage({
  at,
  className = '',
  children,
}: {
  at: number
  className?: string
  children: React.ReactNode
}) {
  const reduce = useReducedMotion()
  if (reduce) return <div className={className}>{children}</div>
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0 }}
      animate={{ opacity: [0, 0, 1, 1, 0], y: [8, 8, 0, 0, 0] }}
      transition={{
        duration: CYCLE,
        times: [0, Math.max(0.01, at - 0.02), at, 0.93, 0.97],
        repeat: Infinity,
        ease: 'easeOut',
      }}
    >
      {children}
    </motion.div>
  )
}

const INVOICE_LINES: Array<[string, string]> = [
  ['Brake chamber T30 (x2)', '368.00'],
  ['Slack adjuster', '96.40'],
  ['Shop labor 6.5 hr', '617.50'],
  ['DEF filter', '38.20'],
  ['Coolant hose', '61.90'],
  ['Shop supplies', '102.50'],
]

function InvoicePanel() {
  const reduce = useReducedMotion()
  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl shadow-black/60">
      {/* Beam de escaneo (solo transform: nada de animar `top`/layout) */}
      {!reduce && (
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-1 top-0 z-10 h-16"
          initial={{ y: 8, opacity: 0 }}
          animate={{ y: [8, 8, 290, 290], opacity: [0, 1, 1, 0] }}
          transition={{
            duration: CYCLE,
            times: [0, 0.04, 0.32, 0.35],
            repeat: Infinity,
            ease: 'linear',
          }}
        >
          <div className="h-full bg-gradient-to-b from-transparent via-brand-bright/20 to-transparent" />
          <div className="absolute inset-x-0 top-1/2 h-px bg-brand-bright shadow-[0_0_14px_#ff4438]" />
        </motion.div>
      )}
      <div className="border-b border-line px-5 py-3.5">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
          R&amp;D Truck Repair
        </p>
        <p className="mt-0.5 font-display text-[15px] font-semibold text-ink">
          Invoice #48213
        </p>
      </div>
      <div className="space-y-2.5 px-5 py-4">
        {INVOICE_LINES.map(([desc, amt]) => (
          <div
            key={desc}
            className="flex items-baseline justify-between gap-3 text-[12px]"
          >
            <span className="text-muted">{desc}</span>
            <span className="font-mono text-faint tabular-nums">${amt}</span>
          </div>
        ))}
        <div className="flex items-baseline justify-between border-t border-line pt-2.5 text-[12px]">
          <span className="font-semibold text-ink">Total</span>
          <span className="font-mono font-semibold text-ink tabular-nums">
            $1,284.50
          </span>
        </div>
      </div>
    </div>
  )
}

// Labels estaticos (la WO "espera" sus campos); solo los VALORES aparecen en
// escena, asi el panel nunca se ve vacio durante el loop.
function WoRow({
  label,
  at,
  children,
}: {
  label: string
  at: number
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-[24px] items-center justify-between gap-3">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#6b6b76]">
        {label}
      </span>
      <Stage at={at}>
        <span className="text-[12.5px] text-ink">{children}</span>
      </Stage>
    </div>
  )
}

function WoLine({ label, amt, at }: { label: string; amt: string; at: number }) {
  return (
    <div className="flex min-h-[20px] items-baseline justify-between text-[12px]">
      <span className="text-muted">{label}</span>
      <Stage at={at}>
        <span className="font-mono text-muted tabular-nums">${amt}</span>
      </Stage>
    </div>
  )
}

function WorkOrderPanel() {
  return (
    <div className="overflow-hidden rounded-2xl border border-[#27272b] bg-panel shadow-2xl shadow-black/60">
      <div className="flex items-center justify-between border-b border-[#232327] px-5 py-3.5">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#6b6b76]">
            Work order
          </p>
          <p className="mt-0.5 font-display text-[15px] font-semibold text-ink">
            WO-1201
          </p>
        </div>
        <Stage at={0.86}>
          <Pill kind="ready" />
        </Stage>
      </div>
      <div className="space-y-3 px-5 py-4">
        <WoRow label="Vendor" at={0.42}>
          R&amp;D Truck Repair
        </WoRow>
        <WoRow label="Unit" at={0.5}>
          <span className="rounded-md border border-line bg-surface-2 px-2 py-0.5 font-mono text-[11px]">
            402
          </span>
        </WoRow>
        <div className="space-y-2 border-t border-[#232327] pt-3">
          <WoLine label="Parts (4)" amt="564.50" at={0.58} />
          <WoLine label="Labor · 6.5 hr" amt="617.50" at={0.64} />
          <WoLine label="Shop supplies" amt="102.50" at={0.7} />
        </div>
        <div className="flex min-h-[26px] items-baseline justify-between border-t border-[#232327] pt-3">
          <span className="font-display text-[13px] font-semibold text-ink">
            Total
          </span>
          <Stage at={0.78}>
            <span className="font-mono text-[15px] font-semibold text-brand-bright tabular-nums">
              $1,284.50
            </span>
          </Stage>
        </div>
      </div>
    </div>
  )
}

const EXTRACT_CHIPS: Array<[number, string]> = [
  [0.38, 'Vendor matched'],
  [0.46, 'Unit 402 detected'],
  [0.54, '6 lines read'],
]

export default function Hero() {
  const reduce = useReducedMotion()
  const ref = useRef<HTMLElement>(null)
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start start', 'end start'],
  })
  const rotateY = useTransform(scrollYProgress, [0, 0.55], [-12, 0])
  const rotateX = useTransform(scrollYProgress, [0, 0.55], [7, 0])
  const sceneY = useTransform(scrollYProgress, [0, 1], [0, 70])

  return (
    <section ref={ref} className="relative overflow-hidden">
      {/* Fondo: foto de flota bien oscurecida + glow rojo (playbook: UI real
          compuesta sobre foto, no 3D decorativo) */}
      <div aria-hidden="true" className="absolute inset-0 -z-10">
        <img
          src={PHOTOS.highway}
          alt=""
          className="h-full w-full object-cover opacity-[0.16]"
          loading="eager"
          decoding="async"
          // React 18: el atributo va en minusculas (fetchPriority es React 19)
          {...{ fetchpriority: 'low' }}
        />
        <div className="absolute inset-0 bg-gradient-to-b from-bg/70 via-bg/55 to-bg" />
        <div className="absolute -right-40 top-10 h-[560px] w-[560px] rounded-full bg-brand/15 blur-[140px]" />
      </div>

      <div
        className={`${shell} grid items-center gap-14 pb-24 pt-16 md:grid-cols-[1.02fr_0.98fr] md:pb-32 md:pt-24`}
      >
        <div>
          <motion.p
            className={eyebrow}
            initial={reduce ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          >
            Rigsmith · Fleet maintenance platform
          </motion.p>
          <motion.h1
            className="mt-4 font-display text-4xl font-bold leading-[1.04] tracking-[-0.02em] sm:text-5xl lg:text-[3.6rem]"
            initial={reduce ? false : { opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.06, ease: [0.16, 1, 0.3, 1] }}
          >
            Scan the invoice.
            <br />
            The work order{' '}
            <span className="text-brand-bright">writes itself.</span>
          </motion.h1>
          <motion.p
            className="mt-6 max-w-xl text-lg leading-relaxed text-muted"
            initial={reduce ? false : { opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.14, ease: [0.16, 1, 0.3, 1] }}
          >
            One live dashboard for DVIR, PM, and work orders, forged on top of
            the ELD you already run. No re-typing, no legacy suite.
          </motion.p>
          <motion.div
            className="mt-9 flex flex-wrap items-center gap-3"
            initial={reduce ? false : { opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            <a href={APP_URL} className={btnPrimary}>
              Start free <ArrowRight size={18} weight="bold" />
            </a>
            <a href="#product" className={btnGhost}>
              See it work
            </a>
          </motion.div>
          <motion.p
            className="mt-8 font-mono text-[11px] uppercase tracking-[0.12em] text-faint"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.4 }}
          >
            Live in production · 430 units · 5 terminals
          </motion.p>
        </div>

        {/* Escena de escaneo en 3D leve */}
        <div style={{ perspective: 1400 }}>
          <motion.div
            className="relative md:h-[480px]"
            style={
              reduce
                ? undefined
                : { rotateX, rotateY, y: sceneY, transformStyle: 'preserve-3d' }
            }
          >
            {/* Desktop: lado a lado sin solapamiento (los montos de la factura
                quedan visibles); mobile: cascada de documentos. */}
            <div
              className="w-[86%] max-w-[300px] md:absolute md:left-0 md:top-12 md:w-[47.5%]"
              style={{ transform: 'translateZ(-24px)' }}
            >
              <InvoicePanel />
            </div>

            {/* Chips de extraccion entre paneles */}
            <div className="absolute left-1/2 top-[42%] z-20 -translate-x-1/2 space-y-2 md:left-[44%] md:top-[68%] md:translate-x-0">
              {EXTRACT_CHIPS.map(([at, label]) => (
                <Stage key={label} at={at}>
                  <span className="flex w-max items-center gap-1.5 rounded-full border border-line bg-bg/90 py-1 pl-2 pr-3 text-[11px] font-medium text-ink shadow-lg shadow-black/40 backdrop-blur">
                    <CheckCircle
                      size={14}
                      weight="fill"
                      className="text-[#34d399]"
                    />
                    {label}
                  </span>
                </Stage>
              ))}
            </div>

            <div
              className="relative z-10 -mt-20 ml-auto w-[86%] max-w-[310px] md:absolute md:right-0 md:top-0 md:mt-0 md:w-[49%]"
              style={{ transform: 'translateZ(28px)' }}
            >
              <WorkOrderPanel />
              <Stage at={0.9} className="absolute -right-2 -top-3">
                <span className="flex items-center gap-1 rounded-full bg-btn px-2.5 py-1 text-[11px] font-bold text-white shadow-[0_2px_12px_rgba(226,35,26,0.5)]">
                  <Lightning size={12} weight="fill" /> 3.1s
                </span>
              </Stage>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  )
}
