// Switcher de producto (patron Samsara): tabs del DS sobre un frame de
// browser con UI mock hi-fi de cada area, con datos realistas. La UI mock usa
// la estetica de instrumento del design system (panel dark, mono, pills).
import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import Reveal from '../components/Reveal'
import { shell, eyebrow } from '../ui'
import { Pill } from './instrument'

function Spark({ pts, stroke }: { pts: string; stroke: string }) {
  return (
    <svg viewBox="0 0 60 18" className="h-[18px] w-[60px]" aria-hidden="true">
      <polyline
        points={pts}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

const RAIL_TICKS = 14
function Rail({ frac, color }: { frac: number; color: string }) {
  const lit = Math.round(frac * RAIL_TICKS)
  return (
    <span className="flex items-end gap-[3px]" aria-hidden="true">
      {Array.from({ length: RAIL_TICKS }, (_, i) => (
        <span
          key={i}
          className="w-[2px] rounded-[1px]"
          style={{
            height: i < lit ? 9 : 6,
            background: i < lit ? color : '#35353b',
          }}
        />
      ))}
    </span>
  )
}

function MockHeader({ left, right }: { left: string; right: string }) {
  return (
    <div className="flex items-center justify-between border-b border-[#232327] px-5 py-3">
      <span className="font-display text-[14px] font-semibold text-ink">{left}</span>
      <span className="font-mono text-[10.5px] text-[#a1a1aa]">{right}</span>
    </div>
  )
}

function WorkOrdersMock() {
  const rows: Array<[string, string, string, string, 'open' | 'ready']> = [
    ['WO-1201', '402', 'R&D Truck Repair', '1,284.50', 'open'],
    ['WO-1198', 'T-118', 'FleetPride Mobile', '842.10', 'ready'],
    ['WO-1196', '508 +2', 'In-house shop', '1,976.25', 'ready'],
    ['WO-1195', '219', 'TA Truck Service', '312.40', 'ready'],
  ]
  return (
    <div>
      <MockHeader left="Work orders" right="4 of 23 this month" />
      <div className="grid grid-cols-[1fr_64px_1.2fr_86px_74px] items-center gap-x-3 px-5 py-2.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#6b6b76]">
        <span>WO</span>
        <span>Unit</span>
        <span>Vendor</span>
        <span className="text-right">Total</span>
        <span className="text-right">Status</span>
      </div>
      {rows.map(([wo, unit, vendor, total, status]) => (
        <div
          key={wo}
          className={`grid grid-cols-[1fr_64px_1.2fr_86px_74px] items-center gap-x-3 border-t border-[#232327] px-5 py-3 text-[12.5px] ${
            status === 'open' ? 'bg-white/[0.025]' : ''
          }`}
        >
          <span className="font-mono text-ink">{wo}</span>
          <span className="font-mono text-muted">{unit}</span>
          <span className="truncate text-muted">{vendor}</span>
          <span className="text-right font-mono text-ink tabular-nums">${total}</span>
          <span className="text-right">
            <Pill kind={status} />
          </span>
        </div>
      ))}
      <div className="flex items-center justify-between border-t border-[#232327] px-5 py-3">
        <span className="font-mono text-[10.5px] text-[#6b6b76]">
          Month to date · $4,415.25
        </span>
        <span className="rounded-[11px] bg-btn px-3 py-1.5 text-[11.5px] font-semibold text-white shadow-[0_2px_8px_-1px_rgba(226,35,26,0.45)]">
          Scan invoice
        </span>
      </div>
    </div>
  )
}

function DvirMock() {
  const rows: Array<[string, string, string, 'unsafe' | 'resolved' | 'safe' | 'open']> = [
    ['06:42', '402', 'Brakes — air leak at chamber', 'unsafe'],
    ['06:51', 'T-118', 'Marker lamp out', 'resolved'],
    ['07:03', '219', 'No defects reported', 'safe'],
    ['07:10', '508', 'Tire tread low — RF outer', 'open'],
  ]
  return (
    <div>
      <MockHeader left="DVIR — today" right="128 reports · 3 open defects" />
      {rows.map(([time, unit, defect, kind]) => (
        <div
          key={unit}
          className={`flex items-center gap-4 border-t border-[#232327] px-5 py-3.5 ${
            kind === 'unsafe' ? 'bg-[rgba(251,113,133,0.05)]' : ''
          }`}
        >
          <span className="font-mono text-[11px] text-[#6b6b76]">{time}</span>
          <span className="w-12 font-mono text-[12.5px] text-ink">{unit}</span>
          <span className="flex-1 truncate text-[12.5px] text-muted">{defect}</span>
          <Pill kind={kind} />
        </div>
      ))}
      <p className="border-t border-[#232327] px-5 py-3 font-mono text-[10.5px] text-[#a1a1aa]">
        Defects land from your ELD the moment the driver signs.
      </p>
    </div>
  )
}

function PmMock() {
  const rows: Array<[string, string, string, number, string]> = [
    ['402', 'Oil & filter', 'overdue by 320 mi', 1, '#fb7185'],
    ['508', 'Chassis lube', '1,240 mi left', 0.8, '#fbbf24'],
    ['T-231', 'Annual DOT inspection', '8,600 mi left', 0.35, '#34d399'],
    ['117', 'Coolant flush', '11,900 mi left', 0.15, '#34d399'],
  ]
  return (
    <div>
      <MockHeader left="PM tracker" right="synced odometer · live" />
      {rows.map(([unit, service, left, frac, color]) => (
        <div
          key={unit + service}
          className="flex items-center gap-4 border-t border-[#232327] px-5 py-3.5"
        >
          <span className="w-12 font-mono text-[12.5px] text-ink">{unit}</span>
          <span className="w-44 truncate text-[12.5px] text-muted">{service}</span>
          <span className="flex-1">
            <Rail frac={frac} color={color} />
          </span>
          <span
            className="font-mono text-[11px] tabular-nums"
            style={{ color: frac >= 1 ? '#fb7185' : '#a1a1aa' }}
          >
            {left}
          </span>
        </div>
      ))}
      <p className="border-t border-[#232327] px-5 py-3 font-mono text-[10.5px] text-[#a1a1aa]">
        Meters come from telematics. Nobody types an odometer again.
      </p>
    </div>
  )
}

function ColdChainMock() {
  const rows: Array<[string, string, string, 'ok' | 'alarm', string, string]> = [
    ['R-102', '-10°F', '-9.2°F', 'ok', '2,14 8,13 16,14 24,12 32,13 40,14 48,13 58,14', '#34d399'],
    ['R-117', '34°F', '33.6°F', 'ok', '2,12 10,13 18,12 26,13 34,12 42,13 50,12 58,13', '#34d399'],
    ['R-089', '-10°F', '+18°F', 'alarm', '2,15 10,14 18,13 26,11 34,8 42,6 50,4 58,2', '#fb7185'],
  ]
  return (
    <div>
      <MockHeader left="Cold chain" right="reefer telemetry · 30s poll" />
      <div className="grid grid-cols-[56px_1fr_1fr_74px_70px] items-center gap-x-3 px-5 py-2.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#6b6b76]">
        <span>Unit</span>
        <span>Setpoint</span>
        <span>Return air</span>
        <span>Trend</span>
        <span className="text-right">Status</span>
      </div>
      {rows.map(([unit, set, ret, kind, pts, color]) => (
        <div
          key={unit}
          className={`grid grid-cols-[56px_1fr_1fr_74px_70px] items-center gap-x-3 border-t border-[#232327] px-5 py-3.5 text-[12.5px] ${
            kind === 'alarm' ? 'bg-[rgba(251,113,133,0.06)]' : ''
          }`}
        >
          <span className="font-mono text-ink">{unit}</span>
          <span className="font-mono text-muted tabular-nums">{set}</span>
          <span
            className="font-mono tabular-nums"
            style={{ color: kind === 'alarm' ? '#fb7185' : '#a1a1aa' }}
          >
            {ret}
          </span>
          <Spark pts={pts} stroke={color} />
          <span className="text-right">
            <Pill kind={kind} />
          </span>
        </div>
      ))}
      <p className="border-t border-[#232327] px-5 py-3 font-mono text-[10.5px] text-[#a1a1aa]">
        A load never spoils quietly. Alarms hit before the temp does.
      </p>
    </div>
  )
}

function LiveMapMock() {
  const reduce = useReducedMotion()
  return (
    <div>
      <MockHeader left="Live map" right="128 moving · 42 idle · 7 in shop" />
      <div className="relative h-[252px] overflow-hidden">
        <svg viewBox="0 0 640 252" className="h-full w-full" aria-hidden="true">
          <defs>
            <pattern id="mapdots" width="24" height="24" patternUnits="userSpaceOnUse">
              <circle cx="1.2" cy="1.2" r="1.2" fill="#232327" />
            </pattern>
          </defs>
          <rect width="640" height="252" fill="url(#mapdots)" />
          <path
            d="M -10 200 C 120 150, 210 190, 330 120 S 560 60, 660 30"
            fill="none"
            stroke="#38383e"
            strokeWidth="2"
            strokeDasharray="1 7"
            strokeLinecap="round"
          />
          <path
            d="M -10 60 C 140 90, 300 70, 420 140 S 600 220, 670 200"
            fill="none"
            stroke="#38383e"
            strokeWidth="2"
            strokeDasharray="1 7"
            strokeLinecap="round"
          />
          <circle cx="150" cy="172" r="5" fill="#34d399" />
          <circle cx="452" cy="152" r="5" fill="#a1a1aa" />
          <circle cx="330" cy="120" r="5" fill="#ff4438" />
          {!reduce && (
            <circle cx="330" cy="120" r="5" fill="none" stroke="#ff4438">
              <animate attributeName="r" values="5;16" dur="1.8s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.8;0" dur="1.8s" repeatCount="indefinite" />
            </circle>
          )}
        </svg>
        <span className="absolute left-[54%] top-[34%] rounded-lg border border-line bg-bg/90 px-2.5 py-1.5 font-mono text-[10.5px] text-ink shadow-lg shadow-black/40 backdrop-blur">
          402 · 61 mph · I-95 N
        </span>
      </div>
      <p className="border-t border-[#232327] px-5 py-3 font-mono text-[10.5px] text-[#a1a1aa]">
        Location, duty status, fuel, and open defects on one native map.
      </p>
    </div>
  )
}

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
        {/* Frame de browser */}
        <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl shadow-black/50">
          <div className="flex items-center gap-2 border-b border-[#232327] bg-surface px-4 py-2.5">
            <span className="flex gap-1.5" aria-hidden="true">
              <span className="h-2.5 w-2.5 rounded-full bg-[#35353b]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#35353b]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#35353b]" />
            </span>
            <span className="ml-2 rounded-md bg-bg px-3 py-1 font-mono text-[10.5px] text-faint">
              app.rigsmith.com/{tab.path}
            </span>
          </div>
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
        </div>
        <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-muted">
          {tab.caption}
        </p>
      </Reveal>
    </section>
  )
}
