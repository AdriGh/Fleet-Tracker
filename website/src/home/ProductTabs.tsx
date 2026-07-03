// Switcher de producto (patron Samsara): tabs del DS sobre un frame de
// browser con UI mock hi-fi de cada area (mocks compartidas en ./mocks).
import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import Reveal from '../components/Reveal'
import { shell, eyebrow } from '../ui'
import {
  BrowserFrame,
  ColdChainMock,
  DvirMock,
  LiveMapMock,
  PmMock,
  WorkOrdersMock,
} from './mocks'

const TABS = [
  {
    id: 'wo',
    label: 'Work orders',
    caption: 'Multi-unit orders with parts, labor, and a printable invoice that matches the shop’s.',
    node: <WorkOrdersMock />,
    path: 'work-orders',
  },
  {
    id: 'dvir',
    label: 'DVIR',
    caption: 'Inspection reports build themselves from your ELD, defects flagged the moment they land.',
    node: <DvirMock />,
    path: 'dvir',
  },
  {
    id: 'pm',
    label: 'PM tracker',
    caption: 'Preventive maintenance on real synced mileage, with alerts before a service is due.',
    node: <PmMock />,
    path: 'pm',
  },
  {
    id: 'cold',
    label: 'Cold chain',
    caption: 'Reefer setpoints, return temps, and alarms watched in real time.',
    node: <ColdChainMock />,
    path: 'cold-chain',
  },
  {
    id: 'map',
    label: 'Live map',
    caption: 'Every truck, every terminal, on one live map as the fleet rolls.',
    node: <LiveMapMock />,
    path: 'map',
  },
]

export default function ProductTabs() {
  const [active, setActive] = useState('wo')
  const reduce = useReducedMotion()
  const tab = TABS.find((t) => t.id === active)!

  // Flechas izq/der mueven el tab activo (patron ARIA tabs con roving tabindex)
  function onTablistKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const i = TABS.findIndex((t) => t.id === active)
    const next =
      TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]
    setActive(next.id)
    ;(
      e.currentTarget.querySelector(`#tab-${next.id}`) as HTMLButtonElement | null
    )?.focus()
  }

  return (
    <section id="product" className={`${shell} py-24`}>
      <Reveal className="max-w-2xl">
        <p className={eyebrow}>The product</p>
        <h2 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] sm:text-4xl">
          One dashboard. The whole maintenance loop.
        </h2>
      </Reveal>

      {/* Track de tabs del DS */}
      <Reveal delay={0.08} className="mt-10">
        <div
          role="tablist"
          aria-label="Product areas"
          onKeyDown={onTablistKeyDown}
          className="inline-flex max-w-full flex-wrap gap-[3px] rounded-[11px] border border-line bg-surface-2 p-[3px]"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              role="tab"
              aria-selected={t.id === active}
              aria-controls={`panel-${t.id}`}
              tabIndex={t.id === active ? 0 : -1}
              onClick={() => setActive(t.id)}
              className={`rounded-lg px-3.5 py-1.5 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-bright ${
                t.id === active
                  ? 'bg-surface text-brand-bright shadow-[0_1px_2px_rgba(0,0,0,0.5)]'
                  : 'text-muted hover:text-ink'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </Reveal>

      <Reveal delay={0.12} className="mt-6">
        <BrowserFrame path={tab.path}>
          <div
            className="min-h-[300px]"
            role="tabpanel"
            id={`panel-${active}`}
            aria-labelledby={`tab-${active}`}
          >
            <AnimatePresence mode="wait">
              <motion.div
                key={active}
                initial={reduce ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? undefined : { opacity: 0, y: -8 }}
                transition={{ duration: 0.28, ease: [0.2, 0.7, 0.2, 1] }}
              >
                {tab.node}
              </motion.div>
            </AnimatePresence>
          </div>
        </BrowserFrame>
        <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-muted">
          {tab.caption}
        </p>
      </Reveal>
    </section>
  )
}
