import { type ReactNode, useId, useState } from 'react'
import {
  TRAILER_ZONES,
  TRUCK_ZONES,
  ZONE_LABEL,
  type Kind,
  type ZoneId,
} from '../truckZones'

type View = 'top' | 'front' | 'side'

interface Props {
  zones: Record<string, number>
  kind: Kind
  // Si se pasa, muestra solo esa vista, sin selector ni leyenda (para el PDF).
  fixedView?: View
}

const TRUCK_BADGE_TOP: Partial<Record<ZoneId, [number, number]>> = {
  engine: [88, 100], cab: [186, 100], glass: [156, 100],
  lightsFront: [38, 100], lightsRear: [224, 100],
  tires: [108, 18], brakes: [321, 100], suspension: [318, 16],
}
const TRUCK_BADGE_FRONT: Partial<Record<ZoneId, [number, number]>> = {
  cab: [170, 58], glass: [170, 112], engine: [170, 182],
  lightsFront: [83, 178], tires: [170, 256],
}
const TRUCK_BADGE_SIDE: Partial<Record<ZoneId, [number, number]>> = {
  engine: [66, 108], glass: [140, 78], lightsFront: [16, 140],
  lightsRear: [218, 116], cab: [182, 104], tires: [74, 184],
  brakes: [300, 184], suspension: [276, 178],
}
const TRAILER_BADGE_TOP: Partial<Record<ZoneId, [number, number]>> = {
  body: [150, 85], doors: [340, 85], lights: [340, 150], tires: [307, 22],
  brakes: [270, 24], suspension: [307, 152], landingGear: [146, 150],
}
const TRAILER_BADGE_SIDE: Partial<Record<ZoneId, [number, number]>> = {
  body: [150, 80], doors: [314, 70], lights: [320, 150], tires: [269, 190],
  brakes: [228, 190], suspension: [276, 182], landingGear: [118, 192],
}

// Neumáticos del top-down con su posición DVIR (esquina sup-izq del rect).
const TOP_TIRES = [
  { pos: 'RF', x: 91, y: 38.5 }, { pos: 'LF', x: 91, y: 146.5 },
  { pos: 'RFO', x: 273, y: 32.5 }, { pos: 'RFI', x: 273, y: 48.5 },
  { pos: 'LFI', x: 273, y: 136.5 }, { pos: 'LFO', x: 273, y: 152.5 },
  { pos: 'RRO', x: 335, y: 32.5 }, { pos: 'RRI', x: 335, y: 48.5 },
  { pos: 'LRI', x: 335, y: 136.5 }, { pos: 'LRO', x: 335, y: 152.5 },
]
const TIRE_W = 34
const TIRE_H = 15

export default function TruckDiagram({ zones, kind, fixedView }: Props) {
  const [viewState, setView] = useState<View>('top')
  const view = fixedView ?? viewState
  const uid = useId().replace(/:/g, '')
  const isTrailer = kind === 'trailer'

  const has = (id: ZoneId) => (zones[id] ?? 0) > 0
  const cls = (id: ZoneId) => `truck-zone zone-${id} ${has(id) ? 'has' : 'ok'}`
  const tip = (id: ZoneId) => {
    const n = zones[id] ?? 0
    return `${ZONE_LABEL[id]}: ${n > 0 ? `${n} defect${n > 1 ? 's' : ''}` : 'no defects'}`
  }

  function Zone({ id, children }: { id: ZoneId; children: ReactNode }) {
    return <g className={cls(id)}><title>{tip(id)}</title>{children}</g>
  }
  function Badges({
    list, pos,
  }: { list: { id: ZoneId }[]; pos: Partial<Record<ZoneId, [number, number]>> }) {
    return (
      <>
        {list.filter((z) => has(z.id) && pos[z.id]).map((z) => {
          const [x, y] = pos[z.id]!
          return (
            <g key={z.id} className="zone-badge">
              <circle cx={x} cy={y} r="10" />
              <text x={x} y={y + 3.5}>{zones[z.id]}</text>
            </g>
          )
        })}
      </>
    )
  }

  const SideWheel = ({ cx }: { cx: number }) => (
    <>
      <circle className="truck-rim" cx={cx} cy="150" r="11.5" />
      {[0, 60, 120].map((a) => {
        const r = (a * Math.PI) / 180
        return (
          <line key={a} className="truck-detail"
            x1={cx + Math.cos(r) * 4} y1={150 + Math.sin(r) * 4}
            x2={cx + Math.cos(r) * 11} y2={150 + Math.sin(r) * 11} />
        )
      })}
    </>
  )
  const TopTire = ({ cx, cy }: { cx: number; cy: number }) => (
    <rect className="zfill" x={cx - 14} y={cy - 6.5} width="28" height="13" rx="4" />
  )

  // ===== TOP realista (camión) ==============================================
  const truckTopReal = (
    <svg viewBox="0 0 470 200" className="truck-svg" role="img"
      aria-label="Truck diagram (top view) by zones">
      <defs>
        <linearGradient id={`${uid}-vol`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#000" stopOpacity=".40" />
          <stop offset=".5" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity=".40" />
        </linearGradient>
        <linearGradient id={`${uid}-hi`} x1="0" y1="0" x2="0" y2="1">
          <stop offset=".34" stopColor="#fff" stopOpacity="0" />
          <stop offset=".5" stopColor="#fff" stopOpacity=".28" />
          <stop offset=".66" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={`${uid}-body`}>
          <path d="M58 56 C80 50 100 50 116 42 C130 48 138 52 146 54 L146 146 C138 148 130 152 116 158 C100 150 80 150 58 144 C42 138 34 114 34 100 C34 86 42 62 58 56 Z" />
          <path d="M146 54 C156 46 166 42 178 42 L222 42 C227 42 230 45 230 50 L230 150 C230 155 227 158 222 158 L178 158 C166 158 156 154 146 146 Z" />
        </clipPath>
      </defs>

      <g className="truck-chassis">
        <rect x="228" y="78" width="157" height="13" rx="4" />
        <rect x="228" y="109" width="157" height="13" rx="4" />
        <rect x="248" y="78" width="16" height="44" rx="2" />
        <rect x="313" y="78" width="16" height="44" rx="2" />
        <rect x="372" y="74" width="13" height="52" rx="3" />
      </g>

      <Zone id="engine">
        <path className="zfill" d="M58 56 C80 50 100 50 116 42 C130 48 138 52 146 54 L146 146 C138 148 130 152 116 158 C100 150 80 150 58 144 C42 138 34 114 34 100 C34 86 42 62 58 56 Z" />
      </Zone>
      <Zone id="cab">
        <path className="zfill" d="M146 54 C156 46 166 42 178 42 L222 42 C227 42 230 45 230 50 L230 150 C230 155 227 158 222 158 L178 158 C166 158 156 154 146 146 Z" />
      </Zone>
      <Zone id="glass">
        <path className="zfill" d="M152 48 C162 50 165 74 165 100 C165 126 162 150 152 152 C148 150 147 126 147 100 C147 74 148 50 152 48 Z" />
        <rect className="zfill" x="143" y="26" width="6" height="28" rx="2" />
        <rect className="zfill" x="143" y="146" width="6" height="28" rx="2" />
        <rect className="zfill" x="138" y="17" width="16" height="11" rx="3" />
        <rect className="zfill" x="138" y="172" width="16" height="11" rx="3" />
      </Zone>
      <Zone id="lightsFront">
        <rect className="zfill" x="35" y="82" width="9" height="11" rx="2" />
        <rect className="zfill" x="35" y="107" width="9" height="11" rx="2" />
      </Zone>
      <Zone id="lightsRear">
        <rect className="zfill" x="221" y="57" width="9" height="13" rx="2" />
        <rect className="zfill" x="221" y="130" width="9" height="13" rx="2" />
      </Zone>

      <g className="truck-shade" clipPath={`url(#${uid}-body)`}>
        <rect x="0" y="0" width="470" height="200" fill={`url(#${uid}-vol)`} />
        <rect x="0" y="0" width="470" height="200" fill={`url(#${uid}-hi)`} />
      </g>

      <Zone id="suspension">
        <rect className="zfill" x="287" y="62" width="6" height="76" rx="3" />
        <rect className="zfill" x="349" y="62" width="6" height="76" rx="3" />
      </Zone>
      <Zone id="brakes">
        {[[285, 63], [347, 63], [285, 127], [347, 127]].map(([x, y]) => (
          <rect key={`${x}-${y}`} className="zfill" x={x} y={y} width="10" height="10" rx="2" />
        ))}
      </Zone>
      <Zone id="tires">
        {TOP_TIRES.map((t) => (
          <rect key={t.pos} className="zfill" x={t.x} y={t.y}
            width={TIRE_W} height={TIRE_H} rx="7.5" />
        ))}
      </Zone>
      <g className="truck-tiretext">
        {TOP_TIRES.map((t) => {
          const cx = t.x + TIRE_W / 2
          const cy = t.y + TIRE_H / 2
          return (
            <g key={t.pos}>
              <line className="truck-tread" x1={cx - 9} y1={cy} x2={cx + 9} y2={cy} />
              <text className="truck-tlabel" x={cx} y={cy + 2.8} fontSize="7.2">{t.pos}</text>
            </g>
          )
        })}
      </g>

      <Badges list={TRUCK_ZONES} pos={TRUCK_BADGE_TOP} />
    </svg>
  )

  // ===== FRONT realista (camión) ============================================
  const truckFront = (
    <svg viewBox="0 0 340 282" className="truck-svg truck-svg-front" role="img"
      aria-label="Truck diagram (front view) by zones">
      <defs>
        <linearGradient id={`${uid}-fvol`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#000" stopOpacity=".40" />
          <stop offset=".5" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity=".40" />
        </linearGradient>
        <linearGradient id={`${uid}-fhi`} x1="0" y1="0" x2="1" y2="0">
          <stop offset=".34" stopColor="#fff" stopOpacity="0" />
          <stop offset=".5" stopColor="#fff" stopOpacity=".24" />
          <stop offset=".66" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={`${uid}-fbody`}>
          <path d="M92 50 L100 30 Q100 26 106 26 L234 26 Q240 26 240 30 L248 50 Z" />
          <rect x="56" y="46" width="228" height="128" rx="22" />
          <rect x="50" y="146" width="240" height="68" rx="14" />
          <rect x="44" y="208" width="252" height="32" rx="11" />
        </clipPath>
      </defs>

      <Zone id="tires">
        <rect className="zfill" x="48" y="230" width="48" height="50" rx="9" />
        <rect className="zfill" x="244" y="230" width="48" height="50" rx="9" />
      </Zone>
      <Zone id="cab">
        <path className="zfill" d="M92 50 L100 30 Q100 26 106 26 L234 26 Q240 26 240 30 L248 50 Z" />
        <rect className="zfill" x="56" y="46" width="228" height="128" rx="22" />
      </Zone>
      <Zone id="engine">
        <rect className="zfill" x="50" y="146" width="240" height="68" rx="14" />
      </Zone>
      <Zone id="glass">
        <path className="zfill" d="M82 66 L258 66 L270 148 L70 148 Z" />
        <rect className="zfill" x="52" y="112" width="8" height="14" rx="2" />
        <rect className="zfill" x="28" y="92" width="24" height="56" rx="6" />
        <rect className="zfill" x="280" y="112" width="8" height="14" rx="2" />
        <rect className="zfill" x="288" y="92" width="24" height="56" rx="6" />
      </Zone>
      <Zone id="lightsFront">
        <path className="zfill" d="M54 154 Q50 154 50 158 L50 192 Q50 196 54 196 L116 202 L116 160 Z" />
        <path className="zfill" d="M286 154 Q290 154 290 158 L290 192 Q290 196 286 196 L224 202 L224 160 Z" />
        <rect className="zfill" x="44" y="208" width="252" height="32" rx="11" />
      </Zone>

      <line className="truck-wsplit" x1="170" y1="68" x2="170" y2="146" />
      <rect className="truck-grille-frame" x="120" y="152" width="100" height="60" rx="9" />
      {[162, 172, 182, 192, 202].map((y) => (
        <line key={y} className="truck-grille" x1="127" y1={y} x2="213" y2={y} />
      ))}

      <g className="truck-shade" clipPath={`url(#${uid}-fbody)`}>
        <rect x="0" y="0" width="340" height="282" fill={`url(#${uid}-fvol)`} />
        <rect x="0" y="0" width="340" height="282" fill={`url(#${uid}-fhi)`} />
      </g>

      <g className="truck-tiretext">
        <text className="truck-tlabel" x="72" y="259" fontSize="13">RF</text>
        <text className="truck-tlabel" x="268" y="259" fontSize="13">LF</text>
      </g>

      <Badges list={TRUCK_ZONES} pos={TRUCK_BADGE_FRONT} />
    </svg>
  )

  // ===== SIDE — camión (Cascadia) ===========================================
  const truckSide = (
    <svg viewBox="0 0 380 200" className="truck-svg" role="img"
      aria-label="Truck diagram (Freightliner Cascadia, side view) by zones">
      <line className="truck-frame" x1="118" y1="150" x2="322" y2="150" />
      <Zone id="suspension">
        <rect className="zfill" x="246" y="147" width="60" height="7" rx="3" />
        <rect className="zfill" x="58" y="147" width="32" height="6" rx="3" />
      </Zone>
      <Zone id="tires">
        <circle className="zfill" cx="74" cy="150" r="24" />
        <circle className="zfill" cx="256" cy="150" r="24" />
        <circle className="zfill" cx="300" cy="150" r="24" />
      </Zone>
      <SideWheel cx={74} /><SideWheel cx={256} /><SideWheel cx={300} />
      <Zone id="brakes">
        {[74, 256, 300].map((cx) => (
          <circle key={cx} className="zfill" cx={cx} cy="150" r="6" />
        ))}
      </Zone>
      <Zone id="engine">
        <path className="zfill" d="M24 134 L24 120 C24 113 27 109 35 107 L106 96 L122 92 L122 134 Z" />
      </Zone>
      <Zone id="cab">
        <path className="zfill"
          d="M122 150 L122 70 C122 63 126 58 134 57 L150 55 L150 47
             C150 44 153 43 158 43 L196 42 C205 42 210 46 210 56 L210 150 Z" />
      </Zone>
      <Zone id="glass">
        <path className="zfill" d="M126 90 L126 72 C126 67 129 64 134 63 L152 62 L152 90 Z" />
        <path className="zfill" d="M122 90 L122 76 L126 72 L126 90 Z" />
        <rect className="zfill" x="112" y="70" width="5" height="22" rx="2" />
      </Zone>
      <Zone id="lightsFront">
        <path className="zfill" d="M26 121 L41 119 L42 131 L27 133 Z" />
        <path className="zfill" d="M14 150 L14 160 C14 165 17 168 22 168 L44 168 L44 150 Z" />
      </Zone>
      <Zone id="lightsRear">
        <rect className="zfill" x="204" y="126" width="6" height="15" rx="1.5" />
      </Zone>
      <rect className="truck-detail solid" x="130" y="124" width="54" height="30" rx="15" />
      <rect className="truck-detail solid" x="212" y="66" width="5" height="84" rx="2" />
      <path className="truck-detail" d="M48 134 Q74 104 100 134" />
      <path className="truck-detail" d="M230 150 Q278 118 326 150" />
      <line className="truck-detail" x1="158" y1="62" x2="158" y2="148" />
      <line className="truck-detail" x1="142" y1="104" x2="150" y2="104" />
      <line className="truck-detail" x1="28" y1="112" x2="40" y2="111" />
      <line className="truck-detail" x1="28" y1="116" x2="40" y2="115" />
      <line className="truck-detail" x1="324" y1="150" x2="324" y2="170" />
      <rect className="truck-detail solid" x="318" y="156" width="12" height="16" rx="1" />
      <Badges list={TRUCK_ZONES} pos={TRUCK_BADGE_SIDE} />
    </svg>
  )

  // ===== TOP / SIDE — tráiler (esquemático) =================================
  const trailerTop = (
    <svg viewBox="0 0 380 170" className="truck-svg" role="img"
      aria-label="Trailer diagram (top view) by zones">
      <Zone id="tires">
        {[290, 324].flatMap((ax) =>
          [45, 58, 112, 125].map((cy) => (
            <TopTire key={`${ax}-${cy}`} cx={ax} cy={cy} />
          )))}
      </Zone>
      <Zone id="body">
        <rect className="zfill" x="34" y="41" width="314" height="88" rx="10" />
      </Zone>
      <Zone id="doors">
        <rect className="zfill" x="330" y="43" width="18" height="84" rx="4" />
        <line className="door-split" x1="334" y1="85" x2="346" y2="85" />
      </Zone>
      <Zone id="landingGear">
        <rect className="zfill" x="138" y="33" width="14" height="9" rx="2" />
        <rect className="zfill" x="138" y="128" width="14" height="9" rx="2" />
      </Zone>
      <Zone id="lights">
        <rect className="zfill" x="349" y="47" width="8" height="13" rx="2" />
        <rect className="zfill" x="349" y="110" width="8" height="13" rx="2" />
      </Zone>
      <rect className="truck-detail solid" x="52" y="79" width="16" height="12" rx="3" />
      <Zone id="suspension">
        <rect className="zfill" x="287" y="44" width="6" height="82" rx="3" />
        <rect className="zfill" x="321" y="44" width="6" height="82" rx="3" />
      </Zone>
      <Zone id="brakes">
        {[[307, 52], [307, 118]].map(([x, y]) => (
          <rect key={`${x}-${y}`} className="zfill" x={x - 5} y={y - 5}
            width="10" height="10" rx="2" />
        ))}
      </Zone>
      <Badges list={TRAILER_ZONES} pos={TRAILER_BADGE_TOP} />
    </svg>
  )
  const trailerSide = (
    <svg viewBox="0 0 380 200" className="truck-svg" role="img"
      aria-label="Trailer diagram (side view) by zones">
      <line className="truck-frame" x1="40" y1="150" x2="320" y2="150" />
      <Zone id="suspension">
        <rect className="zfill" x="244" y="147" width="62" height="7" rx="3" />
      </Zone>
      <Zone id="tires">
        <circle className="zfill" cx="250" cy="150" r="22" />
        <circle className="zfill" cx="288" cy="150" r="22" />
      </Zone>
      <SideWheel cx={250} /><SideWheel cx={288} />
      <Zone id="brakes">
        <circle className="zfill" cx="250" cy="150" r="6" />
        <circle className="zfill" cx="288" cy="150" r="6" />
      </Zone>
      <Zone id="landingGear">
        <rect className="zfill" x="104" y="138" width="8" height="32" rx="2" />
        <rect className="zfill" x="118" y="138" width="8" height="32" rx="2" />
        <rect className="zfill" x="100" y="168" width="30" height="6" rx="2" />
      </Zone>
      <Zone id="body">
        <path className="zfill" d="M26 138 L26 50 Q26 44 32 44 L306 44 L306 138 Z" />
      </Zone>
      <Zone id="doors">
        <rect className="zfill" x="306" y="46" width="20" height="92" rx="2" />
        <line className="door-split" x1="316" y1="50" x2="316" y2="134" />
        <circle className="door-split" cx="309.5" cy="92" r="1.6" />
        <circle className="door-split" cx="322.5" cy="92" r="1.6" />
      </Zone>
      <Zone id="lights">
        <rect className="zfill" x="310" y="120" width="12" height="14" rx="2" />
        <rect className="zfill" x="60" y="142" width="8" height="7" rx="1.5" />
        <rect className="zfill" x="170" y="142" width="8" height="7" rx="1.5" />
      </Zone>
      <path className="truck-detail solid" d="M14 134 L26 134 L26 120 L14 126 Z" />
      <line className="truck-detail" x1="320" y1="150" x2="320" y2="170" />
      <rect className="truck-detail solid" x="314" y="156" width="12" height="16" rx="1" />
      <path className="truck-detail" d="M230 150 Q269 120 312 150" />
      <Badges list={TRAILER_ZONES} pos={TRAILER_BADGE_SIDE} />
    </svg>
  )

  const svg = isTrailer
    ? (view === 'side' ? trailerSide : trailerTop)
    : (view === 'top' ? truckTopReal : view === 'front' ? truckFront : truckSide)

  if (fixedView) return <div className="truck-diagram">{svg}</div>

  return (
    <div className="truck-diagram">
      <div className="view-toggle">
        <button className={`vt-btn ${view === 'top' ? 'active' : ''}`}
          onClick={() => setView('top')}>Top</button>
        {!isTrailer && (
          <button className={`vt-btn ${view === 'front' ? 'active' : ''}`}
            onClick={() => setView('front')}>Front</button>
        )}
        <button className={`vt-btn ${view === 'side' ? 'active' : ''}`}
          onClick={() => setView('side')}>Side</button>
      </div>
      {svg}
      <ul className="truck-legend">
        <li><span className="lg-swatch sw-has" /> With defects</li>
        <li><span className="lg-swatch sw-ok" /> No defects</li>
      </ul>
    </div>
  )
}
