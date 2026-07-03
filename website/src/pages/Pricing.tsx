// Pricing publico y transparente (moat: self-serve vs los quote-based del
// rubro). Modelo por activo, un solo plan pago, sin per-seat y sin contrato
// anual. Numeros calibrados contra el benchmark competitivo, pero SIN nombrar
// competidores en el copy publico (decision del usuario jul-3): se habla de
// "market average" / numeros del mercado.
import { useState } from 'react'
import { ArrowRight, CheckCircle } from '@phosphor-icons/react'
import { Link } from 'react-router-dom'
import Reveal from '../components/Reveal'
import { APP_URL } from '../config'
import { btnPrimary, btnGhost, shell, eyebrow } from '../ui'

const PER_ASSET = 3
const FLEET_MIN = 49
const STARTER_MAX = 10
const ENTERPRISE_FROM = 300

function fleetPrice(assets: number): number {
  return Math.max(FLEET_MIN, assets * PER_ASSET)
}

type Plan = {
  name: string
  price: string
  priceSub: string
  blurb: string
  features: string[]
  cta: string
  highlight?: boolean
}

const PLANS: Plan[] = [
  {
    name: 'Starter',
    price: 'Free',
    priceSub: `up to ${STARTER_MAX} assets`,
    blurb: 'For owner-operators and small yards. Free for real, not a trial.',
    features: [
      'DVIR, PM tracker, and work orders',
      '25 AI invoice scans a month',
      'One terminal',
      'CSV export of your data, always',
    ],
    cta: 'Start free',
  },
  {
    name: 'Fleet',
    price: `$${PER_ASSET}`,
    priceSub: `per asset / month · $${FLEET_MIN} minimum`,
    blurb: 'The whole platform. Billed monthly, cancel anytime.',
    features: [
      'Everything in Starter, no caps',
      'Unlimited users. No per-seat pricing, ever',
      'AI invoice scanning included (fair use)',
      'Cold chain, live map, parts & purchase orders',
      'Reports & analytics with CSV export',
      'ELD sync and integrations',
      'Priority support',
    ],
    cta: 'Start free',
    highlight: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    priceSub: `${ENTERPRISE_FROM}+ assets`,
    blurb: 'Volume discounts and white-glove onboarding for large operations.',
    features: [
      'Everything in Fleet',
      'Volume pricing per asset',
      'Assisted data migration from your old suite',
      'Bring-your-own AI keys if you want them',
    ],
    cta: 'Talk to us',
  },
]

const FIRST_30: Array<[string, string, string]> = [
  [
    'Day 1',
    'Connect and see your fleet',
    'Plug in the ELD you already run. Units, drivers, and odometers sync on their own.',
  ],
  [
    'Week 1',
    'DVIR and PM run themselves',
    'Inspections file as drivers sign. PM alerts fire on real synced mileage.',
  ],
  [
    'Weeks 2-4',
    'The shop loop closes',
    'Scan invoices, work orders write themselves, costs land in reports.',
  ],
  [
    'Day 30',
    'Turn the old suite off',
    'Everything it did now lives in one dashboard your team actually likes.',
  ],
]

const FAQ: Array<[string, string]> = [
  [
    'Is there a contract?',
    'No. Fleet is billed monthly and you can cancel anytime. Your data exports to CSV whenever you want it.',
  ],
  [
    'How do you count assets?',
    'Active trucks, trailers, and chassis in your fleet. Archived units are free.',
  ],
  [
    'Are users really unlimited?',
    'Yes. Dispatchers, mechanics, drivers, office. Per-seat pricing is how legacy suites punish you for growing; we price per asset instead.',
  ],
  [
    'Is the AI scanning extra?',
    'No. Invoice scanning is included in Fleet under fair use. Starter includes 25 scans a month.',
  ],
  [
    'Which ELDs do you support?',
    'Rigsmith is telematics-agnostic. Major ELDs sync today and the adapter framework was built to add yours fast. Tell us what you run.',
  ],
  [
    'How long does setup take?',
    'An afternoon, not a quarter. Connect the ELD, invite your team, scan your first invoice the same day.',
  ],
]

export default function Pricing() {
  const [assets, setAssets] = useState(100)
  const price = fleetPrice(assets)

  return (
    <>
      <section className={`${shell} pb-12 pt-20`}>
        <Reveal className="max-w-2xl">
          <p className={eyebrow}>Pricing</p>
          <h1 className="mt-3 font-display text-4xl font-semibold leading-[1.1] tracking-[-0.02em] sm:text-5xl">
            Per asset. All in. No fine print.
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted">
            One paid plan with everything. Unlimited users, monthly billing,
            cancel anytime. Priced below the market average, not to imitate
            it.
          </p>
        </Reveal>
      </section>

      {/* ---------- Planes ---------- */}
      <section className={`${shell} pb-16`}>
        <div className="grid gap-4 md:grid-cols-3">
          {PLANS.map((p, i) => (
            <Reveal key={p.name} delay={i * 0.06}>
              <div
                className={`flex h-full flex-col rounded-3xl border p-7 ${
                  p.highlight
                    ? 'border-brand-bright/50 bg-panel shadow-[0_0_60px_-24px_rgba(255,68,56,0.45)]'
                    : 'border-line/70 bg-surface/40'
                }`}
              >
                <div className="flex items-center justify-between">
                  <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-muted">
                    {p.name}
                  </h2>
                  {p.highlight && (
                    <span className="rounded-full bg-btn px-2.5 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.06em] text-white">
                      The plan
                    </span>
                  )}
                </div>
                <div className="mt-4 flex items-baseline gap-2">
                  <span className="font-display text-4xl font-bold tracking-[-0.02em] text-ink">
                    {p.price}
                  </span>
                </div>
                <p className="mt-1 font-mono text-[11px] text-faint">{p.priceSub}</p>
                <p className="mt-4 text-[14px] leading-relaxed text-muted">{p.blurb}</p>
                <ul className="mt-6 flex-1 space-y-3">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5">
                      <CheckCircle
                        size={18}
                        weight="fill"
                        className={`mt-0.5 shrink-0 ${p.highlight ? 'text-brand-bright' : 'text-faint'}`}
                      />
                      <span className="text-[13.5px] leading-relaxed text-ink">{f}</span>
                    </li>
                  ))}
                </ul>
                {p.name === 'Enterprise' ? (
                  <Link to="/about" className={`${btnGhost} mt-7 w-full`}>
                    {p.cta} <ArrowRight size={16} weight="bold" />
                  </Link>
                ) : (
                  <a
                    href={APP_URL}
                    className={`${p.highlight ? btnPrimary : btnGhost} mt-7 w-full`}
                  >
                    {p.cta} <ArrowRight size={16} weight="bold" />
                  </a>
                )}
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------- Calculadora ---------- */}
      <section className="border-y border-line/60 bg-surface/30">
        <div className={`${shell} grid items-center gap-10 py-16 md:grid-cols-[1fr_0.9fr]`}>
          <Reveal>
            <p className={eyebrow}>Do the math</p>
            <h2 className="mt-3 font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
              What would your fleet pay?
            </h2>
            <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted">
              Drag the slider. That number is the whole bill: every feature,
              every user, AI scanning included.
            </p>
            <label className="mt-8 block">
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
                Assets in your fleet
              </span>
              <input
                type="range"
                min={10}
                max={500}
                step={5}
                value={assets}
                onChange={(e) => setAssets(Number(e.target.value))}
                className="mt-3 w-full accent-brand-bright"
              />
            </label>
          </Reveal>
          <Reveal delay={0.08}>
            <div className="overflow-hidden rounded-[14px] border border-[#27272b] bg-panel px-6 pb-5 pt-5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#a1a1aa]">
                  Fleet plan · {assets} assets
                </span>
                <span
                  aria-hidden="true"
                  className="h-[7px] w-[7px] rounded-full bg-[#ff4438] shadow-[0_0_8px_#ff4438]"
                />
              </div>
              <div className="mt-3 font-display text-5xl font-bold tracking-[-0.02em] text-[#f4f4f5] tabular-nums">
                ${price.toLocaleString('en-US')}
                <span className="ml-1 font-mono text-[13px] font-normal text-[#6b6b76]">/mo</span>
              </div>
              <p className="mt-2 font-mono text-[10.5px] text-[#6b6b76]">
                {assets <= STARTER_MAX
                  ? 'that fits in Starter: free'
                  : assets >= ENTERPRISE_FROM
                    ? 'volume pricing available at this size, talk to us'
                    : `$${PER_ASSET} per asset, everything included`}
              </p>
              <div className="mt-5 border-t border-[#232327] pt-4">
                <p className="flex items-baseline justify-between text-[13px]">
                  <span className="text-muted">Market average, for reference</span>
                  <span className="font-mono text-ink tabular-nums">$550+/mo</span>
                </p>
                <p className="mt-1 font-mono text-[10.5px] text-[#6b6b76]">
                  legacy shop suites, per shop, with user limits (Jul 2026)
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---------- First 30 days ---------- */}
      <section className={`${shell} py-20`}>
        <Reveal className="max-w-2xl">
          <p className={eyebrow}>Your first 30 days</p>
          <h2 className="mt-3 font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
            Switching is the easy part
          </h2>
        </Reveal>
        <div className="mt-10 grid gap-4 md:grid-cols-4">
          {FIRST_30.map(([when, title, body], i) => (
            <Reveal key={when} delay={i * 0.06}>
              <div className="h-full rounded-2xl border border-line/70 bg-surface/40 p-6">
                <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-brand-bright">
                  {when}
                </p>
                <h3 className="mt-2 font-display text-[17px] font-bold tracking-[-0.02em] text-ink">
                  {title}
                </h3>
                <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------- FAQ ---------- */}
      <section className="border-y border-line/60 bg-surface/30">
        <div className={`${shell} py-20`}>
          <Reveal className="max-w-2xl">
            <p className={eyebrow}>Questions</p>
            <h2 className="mt-3 font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
              The straight answers
            </h2>
          </Reveal>
          <div className="mt-10 grid gap-3 md:grid-cols-2">
            {FAQ.map(([q, a]) => (
              <Reveal key={q}>
                <details className="group rounded-2xl border border-line/70 bg-surface/40 px-6 py-4 open:bg-surface/60">
                  <summary className="cursor-pointer list-none text-[15px] font-semibold text-ink marker:content-none">
                    {q}
                  </summary>
                  <p className="mt-3 text-[14px] leading-relaxed text-muted">{a}</p>
                </details>
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
                Start free. Stay because it works.
              </h2>
              <p className="mt-2 text-[15px] text-muted">
                Ten assets free forever. No card, no call, no contract.
              </p>
            </div>
            <a href={APP_URL} className={btnPrimary}>
              Start free <ArrowRight size={18} weight="bold" />
            </a>
          </div>
        </Reveal>
      </section>
    </>
  )
}
