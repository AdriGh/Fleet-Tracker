// Features hub (cap 07 del playbook): una seccion por area del producto,
// alternando texto | mock hi-fi en frame de browser. Cada claim con numero
// duro donde lo hay. Teaser de integraciones al pie (ancla #integrations,
// linkeada desde el footer).
import { ArrowRight, CheckCircle } from '@phosphor-icons/react'
import { Link } from 'react-router-dom'
import Reveal from '../components/Reveal'
import { APP_URL } from '../config'
import { btnPrimary, btnGhost, shell, eyebrow } from '../ui'
import {
  BrowserFrame,
  ColdChainMock,
  DvirMock,
  LiveMapMock,
  PartsMock,
  PmMock,
  ReportsMock,
  WorkOrdersMock,
} from '../home/mocks'

type Area = {
  id: string
  kicker: string
  title: string
  body: string
  bullets: string[]
  chip?: string
  path: string
  mock: React.ReactNode
}

const AREAS: Area[] = [
  {
    id: 'work-orders',
    kicker: 'AI invoice scan · Work orders',
    title: 'Scan the invoice. The work order writes itself.',
    body: 'Drop the shop’s PDF or a photo. The AI reads it, matches your units, and fills the whole order.',
    bullets: [
      'Vendor, units, parts, and labor auto-filled in about 3 seconds',
      'Multi-unit invoices split into parent and child orders (4 / 4.1) without duplicating cost',
      'Printable invoice that matches the shop’s, with your own numbering',
      'The original PDF stays attached to the order',
    ],
    chip: '~3s per invoice',
    path: 'work-orders',
    mock: <WorkOrdersMock />,
  },
  {
    id: 'dvir',
    kicker: 'DVIR compliance',
    title: 'Inspections that file themselves',
    body: 'Daily reports build straight from the ELD as drivers sign. Nobody chases paper.',
    bullets: [
      'Defects land the moment the driver submits, flagged by severity',
      'Unsafe units surface instantly, with a resolve workflow and history',
      'Daily boards per terminal, plus who is missing their DVIR',
      'Exports that mirror your compliance spreadsheet, cell for cell',
    ],
    path: 'dvir',
    mock: <DvirMock />,
  },
  {
    id: 'pm',
    kicker: 'PM tracker · DOT',
    title: 'Preventive maintenance on real mileage',
    body: 'Odometers sync from telematics. Alerts fire before a service is due, not after.',
    bullets: [
      'No manual meter entry, ever',
      'Alerts ahead of every service interval, per unit',
      'Annual DOT inspections tracked on the same board',
      'Closing a work order resets the PM clock automatically',
    ],
    path: 'pm',
    mock: <PmMock />,
  },
  {
    id: 'cold-chain',
    kicker: 'Cold chain',
    title: 'A load never spoils quietly',
    body: 'Reefer setpoints and return air, watched around the clock.',
    bullets: [
      'Setpoint vs return temperature per reefer, polled continuously',
      'Alarms hit before the temperature does',
      'A reefer fault can open its own work order',
    ],
    path: 'cold-chain',
    mock: <ColdChainMock />,
  },
  {
    id: 'map',
    kicker: 'Live map',
    title: 'Every truck, every terminal, one map',
    body: 'Native, not an embedded afterthought.',
    bullets: [
      'Location, duty status, fuel and DEF for the whole fleet',
      'Open defects overlaid on the units that carry them',
      'Views per terminal for dispatch',
    ],
    path: 'map',
    mock: <LiveMapMock />,
  },
  {
    id: 'parts',
    kicker: 'Parts · Vendors · POs',
    title: 'The parts room, accounted for',
    body: 'On-hand counts, reorder points, and purchasing in the same loop as the work orders.',
    bullets: [
      'Inventory with bins, on-hand and reorder points',
      'Low stock feeds QuickBuy: one click from shortage to purchase order',
      'Receiving updates stock and cost automatically',
      'Parts used on WOs draw from inventory at real cost',
    ],
    path: 'parts',
    mock: <PartsMock />,
  },
  {
    id: 'reports',
    kicker: 'Reports & analytics',
    title: 'Know where the money goes',
    body: 'Every closed order rolls up the moment it closes.',
    bullets: [
      'Spend by category, unit, and month',
      'Parts vs labor split at a glance',
      'Date presets or custom ranges, filtered by terminal',
      'CSV export of everything',
    ],
    path: 'reports',
    mock: <ReportsMock />,
  },
]

const INTEGRATION_CATS: Array<[string, string]> = [
  ['Any ELD / telematics', 'odometer · DVIR · fault codes'],
  ['Any TMS', 'dispatch · loads'],
  ['Fuel cards', 'transactions · MPG'],
  ['Parts suppliers', 'catalog · pricing'],
  ['QuickBooks & accounting', 'invoices · ledger'],
]

export default function Features() {
  return (
    <>
      <section className={`${shell} pb-10 pt-20`}>
        <Reveal className="max-w-2xl">
          <p className={eyebrow}>Features</p>
          <h1 className="mt-3 font-display text-4xl font-semibold leading-[1.1] tracking-[-0.02em] sm:text-5xl">
            Everything Rigsmith does
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted">
            The whole maintenance loop, native in one dashboard. Every screen
            below is the real product, running a real fleet today.
          </p>
        </Reveal>
      </section>

      {AREAS.map((a, i) => (
        <section
          key={a.id}
          id={a.id}
          className={i % 2 ? 'border-y border-line/60 bg-surface/30' : ''}
        >
          <div className={`${shell} grid items-center gap-10 py-16 md:grid-cols-2 md:gap-14 md:py-20`}>
            <Reveal className={i % 2 ? 'md:order-2' : ''}>
              <p className={eyebrow}>{a.kicker}</p>
              <h2 className="mt-3 font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
                {a.title}
              </h2>
              <p className="mt-3 text-[15px] leading-relaxed text-muted">{a.body}</p>
              <ul className="mt-6 space-y-3">
                {a.bullets.map((b) => (
                  <li key={b} className="flex items-start gap-3">
                    <CheckCircle
                      size={20}
                      weight="fill"
                      className="mt-0.5 shrink-0 text-brand-bright"
                    />
                    <span className="text-[15px] leading-relaxed text-ink">{b}</span>
                  </li>
                ))}
              </ul>
              {a.chip && (
                <span className="mt-6 inline-flex items-center rounded-full border border-line bg-panel px-3.5 py-1.5 font-mono text-[11.5px] text-brand-bright">
                  {a.chip}
                </span>
              )}
            </Reveal>
            <Reveal delay={0.08} className={i % 2 ? 'md:order-1' : ''}>
              <BrowserFrame path={a.path}>{a.mock}</BrowserFrame>
            </Reveal>
          </div>
        </section>
      ))}

      {/* ---------- Integraciones (ancla del footer) ---------- */}
      <section id="integrations" className={`${shell} py-20`}>
        <Reveal className="max-w-2xl">
          <p className={eyebrow}>Integrations</p>
          <h2 className="mt-3 font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
            Plugs into the stack you already pay for
          </h2>
          <p className="mt-3 text-[15px] leading-relaxed text-muted">
            Rigsmith is telematics-agnostic by design: adapters read your ELD,
            your TMS, and your fuel cards into one canonical copy of the fleet,
            and automations push results where they belong. QuickBooks is first
            in line on the accounting side.
          </p>
        </Reveal>
        <Reveal delay={0.08} className="mt-8 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
          {INTEGRATION_CATS.map(([title, sub]) => (
            <div key={title} className="rounded-xl border border-line bg-surface px-4 py-3">
              <p className="text-[13.5px] font-semibold text-ink">{title}</p>
              <p className="mt-0.5 font-mono text-[10px] tracking-[0.04em] text-faint">{sub}</p>
            </div>
          ))}
        </Reveal>
        <Reveal delay={0.12} className="mt-6">
          <p className="text-sm text-muted">
            Running an ELD we have not met yet? The adapter framework was built
            for exactly that. Tell us what you run when you sign up.
          </p>
        </Reveal>
      </section>

      {/* ---------- CTA ---------- */}
      <section className={`${shell} pb-24`}>
        <Reveal>
          <div className="flex flex-wrap items-center justify-between gap-6 rounded-[2rem] border border-line bg-panel px-8 py-10">
            <div>
              <h2 className="font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
                See it on your own fleet
              </h2>
              <p className="mt-2 text-[15px] text-muted">
                Free to start. Connect your ELD and scan your first invoice today.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <a href={APP_URL} className={btnPrimary}>
                Start free <ArrowRight size={18} weight="bold" />
              </a>
              <Link to="/pricing" className={btnGhost}>
                See pricing
              </Link>
            </div>
          </div>
        </Reveal>
      </section>
    </>
  )
}
