// El moat, dibujado: Rigsmith como plataforma de integracion agnostica.
// Categorias (sin nombres de vendor, salvo QuickBooks a proposito) fluyen al
// hub y salen como resultados. Las lineas se dibujan al entrar en viewport y
// llevan puntos de datos viajando (SMIL animateMotion, apagado con
// prefers-reduced-motion). En mobile se apila una version sin SVG.
import { useRef } from 'react'
import { motion, useInView, useReducedMotion } from 'motion/react'
import { ArrowDown, ArrowRight } from '@phosphor-icons/react'
import { Link } from 'react-router-dom'
import Reveal from '../components/Reveal'
import { shell, eyebrow } from '../ui'

const INPUTS: Array<[string, string]> = [
  ['Any ELD / telematics', 'odometer · DVIR · fault codes'],
  ['Any TMS', 'dispatch · loads'],
  ['Fuel cards', 'transactions · MPG'],
  ['Parts suppliers', 'catalog · pricing'],
  ['QuickBooks & accounting', 'invoices · ledger'],
]

const OUTPUTS: Array<[string, string]> = [
  ['DVIR auto-filed', 'defects flagged on arrival'],
  ['Work orders open themselves', 'defect in, WO out'],
  ['PM on real odometer', 'no manual meter entry'],
  ['Costs booked to your ledger', 'every repair, accounted'],
]

const IN_Y = [70, 170, 280, 390, 490]
const IN_T = [236, 258, 280, 302, 324]
const OUT_Y = [100, 220, 340, 460]
const OUT_S = [250, 270, 290, 310]

function inPath(i: number) {
  return `M 252 ${IN_Y[i]} C 370 ${IN_Y[i]}, 380 ${IN_T[i]}, 476 ${IN_T[i]}`
}
function outPath(j: number) {
  return `M 684 ${OUT_S[j]} C 790 ${OUT_S[j]}, 800 ${OUT_Y[j]}, 906 ${OUT_Y[j]}`
}

function NodeChip({
  x,
  y,
  title,
  sub,
  anchor,
}: {
  x: number
  y: number
  title: string
  sub: string
  anchor: 'start' | 'end'
}) {
  const w = 222
  const rx = anchor === 'start' ? x : x - w
  return (
    <g>
      <rect
        x={rx}
        y={y - 30}
        width={w}
        height={60}
        rx={12}
        fill="#161618"
        stroke="#27272b"
      />
      <text
        x={rx + 16}
        y={y - 4}
        fill="#f4f4f5"
        fontSize={13.5}
        fontWeight={600}
        style={{ fontFamily: 'var(--font-sans)' }}
      >
        {title}
      </text>
      <text
        x={rx + 16}
        y={y + 16}
        fill="#6b6b76"
        fontSize={10}
        letterSpacing={0.5}
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {sub}
      </text>
    </g>
  )
}

// El punto SMIL solo se monta con el diagrama en viewport (`showDot`): antes
// de eso el circle viviria apilado en el origen del SVG esperando su `begin`.
function Flow({ d, delay, showDot }: { d: string; delay: number; showDot: boolean }) {
  const reduce = useReducedMotion()
  return (
    <>
      <motion.path
        d={d}
        fill="none"
        stroke="#3a3a41"
        strokeWidth={1.5}
        initial={reduce ? false : { pathLength: 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true, amount: 0.4 }}
        transition={{ duration: 1.1, delay, ease: [0.2, 0.7, 0.2, 1] }}
      />
      {!reduce && showDot && (
        <circle r={3} fill="#ff4438" opacity={0.9}>
          <animateMotion
            dur="3.2s"
            begin={`${delay + 1}s`}
            repeatCount="indefinite"
            path={d}
          />
        </circle>
      )}
    </>
  )
}

// Marca Rigsmith dentro del hub del SVG (paths del handoff, escala 0.5).
function HubMark({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(0.5)`}>
      <g transform="translate(8 0) skewX(-7)">
        <path
          fill="#f4f4f5"
          d="M88 34 H130 Q154 34 154 57 V79 Q154 96 136 101 L164 152 L138 160 L110 104 H88 V82 H118 Q128 82 128 73 V63 Q128 56 118 56 H88 Z"
        />
        <path
          fill="#ff4438"
          fillRule="evenodd"
          transform="rotate(-45 65 40)"
          d="M51 58 L51 36 L58 26 L72 26 L79 36 L79 58 Z M58 26 H72 V43 Q72 50 65 50 Q58 50 58 43 Z"
        />
        <path fill="#ff4438" d="M57 50 H74 L71.5 136 H59.5 Z" />
        <path
          fill="#ff4438"
          fillRule="evenodd"
          d="M67 133 L81.7 141.5 V158.5 L67 167 L52.3 158.5 V141.5 Z M67 141 L74.8 145.5 V154.5 L67 159 L59.2 154.5 V145.5 Z"
        />
      </g>
    </g>
  )
}

function MobileChip({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <p className="text-[13.5px] font-semibold text-ink">{title}</p>
      <p className="mt-0.5 font-mono text-[10px] tracking-[0.04em] text-faint">{sub}</p>
    </div>
  )
}

export default function PlatformDiagram() {
  const svgWrapRef = useRef<HTMLDivElement>(null)
  const dotsOn = useInView(svgWrapRef, { once: true, amount: 0.35 })
  return (
    <section id="platform" className={`${shell} py-24`}>
      <Reveal className="max-w-2xl">
        <p className={eyebrow}>Integration platform</p>
        <h2 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] sm:text-4xl">
          Any ELD. Any TMS. Your books.
        </h2>
        <p className="mt-4 text-lg leading-relaxed text-muted">
          Rigsmith does not replace your stack, it plugs into it. Agnostic
          adapters read the telematics you already pay for, one canonical copy
          of your fleet keeps everything honest, and automations push the
          results where they belong.
        </p>
      </Reveal>

      {/* Desktop: diagrama SVG con lineas que se dibujan y datos viajando */}
      <Reveal delay={0.1} className="mt-12 hidden md:block">
        <div ref={svgWrapRef}>
        <svg
          viewBox="0 0 1160 560"
          className="w-full"
          role="img"
          aria-label="Diagram: ELD, TMS, fuel cards, parts suppliers, and QuickBooks flow into Rigsmith, which outputs auto-filed DVIRs, work orders, PM on real odometer, and booked costs"
        >
          {INPUTS.map(([title, sub], i) => (
            <NodeChip key={title} x={30} y={IN_Y[i]} title={title} sub={sub} anchor="start" />
          ))}
          {INPUTS.map((_, i) => (
            <Flow key={i} d={inPath(i)} delay={i * 0.12} showDot={dotsOn} />
          ))}

          {/* Hub */}
          <rect
            x={480}
            y={200}
            width={200}
            height={160}
            rx={18}
            fill="#131316"
            stroke="#38383e"
            strokeWidth={1.4}
          />
          <HubMark x={530} y={210} />
          <text
            x={580}
            y={322}
            textAnchor="middle"
            fill="#f4f4f5"
            fontSize={19}
            fontWeight={700}
            letterSpacing={-0.5}
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Rigsmith
          </text>
          <text
            x={580}
            y={342}
            textAnchor="middle"
            fill="#6b6b76"
            fontSize={9.5}
            letterSpacing={1.52}
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            CANONICAL FLEET DATA
          </text>

          {OUTPUTS.map((_, j) => (
            <Flow key={j} d={outPath(j)} delay={0.5 + j * 0.12} showDot={dotsOn} />
          ))}
          {OUTPUTS.map(([title, sub], j) => (
            <NodeChip key={title} x={1130} y={OUT_Y[j]} title={title} sub={sub} anchor="end" />
          ))}
        </svg>
        </div>
      </Reveal>

      {/* Mobile: version apilada sin SVG */}
      <Reveal delay={0.1} className="mt-10 space-y-4 md:hidden">
        <div className="grid grid-cols-1 gap-2.5 min-[420px]:grid-cols-2">
          {INPUTS.map(([title, sub]) => (
            <MobileChip key={title} title={title} sub={sub} />
          ))}
        </div>
        <div className="flex justify-center text-faint">
          <ArrowDown size={18} />
        </div>
        <div className="rounded-2xl border border-line-strong bg-panel px-5 py-4 text-center">
          <p className="font-display text-lg font-bold text-ink">Rigsmith</p>
          <p className="mt-0.5 font-mono text-[10px] tracking-[0.16em] text-faint">
            CANONICAL FLEET DATA
          </p>
        </div>
        <div className="flex justify-center text-faint">
          <ArrowDown size={18} />
        </div>
        <div className="grid grid-cols-1 gap-2.5 min-[420px]:grid-cols-2">
          {OUTPUTS.map(([title, sub]) => (
            <MobileChip key={title} title={title} sub={sub} />
          ))}
        </div>
      </Reveal>

      <Reveal delay={0.15} className="mt-10">
        <Link
          to="/features"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-bright transition-colors hover:text-brand-soft"
        >
          Explore integrations <ArrowRight size={16} weight="bold" />
        </Link>
      </Reveal>
    </section>
  )
}
