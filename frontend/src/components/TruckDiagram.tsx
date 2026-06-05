import { type ReactNode, useState } from 'react'
import {
  TRAILER_ZONES,
  TRUCK_ZONES,
  ZONE_LABEL,
  type Kind,
  type ZoneId,
} from '../truckZones'

interface Props {
  zones: Record<string, number>
  kind: Kind
}

type View = 'top' | 'side'

// --- posiciones de las insignias (cantidad) por vista -----------------------
const TRUCK_BADGE_SIDE: Partial<Record<ZoneId, [number, number]>> = {
  engine: [66, 108], glass: [140, 78], lightsFront: [16, 140],
  lightsRear: [218, 116], cab: [182, 104], tires: [74, 184],
  brakes: [300, 184], suspension: [276, 178],
}
const TRAILER_BADGE_SIDE: Partial<Record<ZoneId, [number, number]>> = {
  body: [150, 80], doors: [314, 70], lights: [320, 150], tires: [269, 190],
  brakes: [228, 190], suspension: [276, 182], landingGear: [118, 192],
}
const TRUCK_BADGE_TOP: Partial<Record<ZoneId, [number, number]>> = {
  engine: [76, 85], glass: [123, 85], lightsFront: [45, 85],
  lightsRear: [196, 85], cab: [166, 85], tires: [78, 22],
  brakes: [241, 24], suspension: [150, 152],
}
const TRAILER_BADGE_TOP: Partial<Record<ZoneId, [number, number]>> = {
  body: [150, 85], doors: [340, 85], lights: [340, 150], tires: [307, 22],
  brakes: [270, 24], suspension: [307, 152], landingGear: [146, 150],
}

export default function TruckDiagram({ zones, kind }: Props) {
  const [view, setView] = useState<View>('top')

  const has = (id: ZoneId) => (zones[id] ?? 0) > 0
  const cls = (id: ZoneId) => `truck-zone zone-${id} ${has(id) ? 'has' : 'ok'}`
  const tip = (id: ZoneId) => {
    const n = zones[id] ?? 0
    return `${ZONE_LABEL[id]}: ${n > 0 ? `${n} defect${n > 1 ? 's' : ''}` : 'no defects'}`
  }

  function Zone({ id, children }: { id: ZoneId; children: ReactNode }) {
    return <g className={cls(id)}><title>{tip(id)}</title>{children}</g>
  }
  function Badges({ list, pos }: {
    list: { id: ZoneId }[]
    pos: Partial<Record<ZoneId, [number, number]>>
  }) {
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

  // rueda de perfil (aro + rayos, neutro)
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
  // neumático visto desde arriba (rectángulo)
  const TopTire = ({ cx, cy }: { cx: number; cy: number }) => (
    <rect className="zfill" x={cx - 14} y={cy - 6.5} width="28" height="13" rx="4" />
  )

  const isTrailer = kind === 'trailer'

  // ====== TOP — camión =======================================================
  const truckTop = (
    <svg viewBox="0 0 360 170" className="truck-svg" role="img"
      aria-label="Truck diagram (top view) by zones">
      {/* neumáticos */}
      <Zone id="tires">
        <TopTire cx={78} cy={46} /><TopTire cx={78} cy={124} />
        {[224, 258].flatMap((ax) =>
          [45, 58, 112, 125].map((cy) => (
            <TopTire key={`${ax}-${cy}`} cx={ax} cy={cy} />
          )))}
      </Zone>
      {/* chasis trasero (neutro) */}
      <rect className="truck-detail solid" x="198" y="73" width="104" height="24" rx="5" />
      {/* capó (motor) */}
      <Zone id="engine">
        <path className="zfill"
          d="M48 66 Q40 66 40 74 L40 96 Q40 104 48 104 L118 124 L118 46 Z" />
        <rect className="zfill" x="40" y="66" width="10" height="11" rx="2" />
      </Zone>
      {/* cabina */}
      <Zone id="cab">
        <rect className="zfill" x="112" y="41" width="88" height="88" rx="12" />
      </Zone>
      {/* parabrisas + espejos */}
      <Zone id="glass">
        <rect className="zfill" x="114" y="46" width="18" height="78" rx="4" />
        <rect className="zfill" x="104" y="31" width="12" height="11" rx="2" />
        <rect className="zfill" x="104" y="128" width="12" height="11" rx="2" />
      </Zone>
      {/* luces delanteras */}
      <Zone id="lightsFront">
        <rect className="zfill" x="40" y="64" width="9" height="12" rx="2" />
        <rect className="zfill" x="40" y="94" width="9" height="12" rx="2" />
      </Zone>
      {/* luces traseras */}
      <Zone id="lightsRear">
        <rect className="zfill" x="191" y="47" width="9" height="13" rx="2" />
        <rect className="zfill" x="191" y="110" width="9" height="13" rx="2" />
      </Zone>
      {/* suspensión (ejes) — sobre el cuerpo para que se vean */}
      <Zone id="suspension">
        <rect className="zfill" x="75" y="44" width="6" height="82" rx="3" />
        <rect className="zfill" x="221" y="44" width="6" height="82" rx="3" />
        <rect className="zfill" x="255" y="44" width="6" height="82" rx="3" />
      </Zone>
      {/* frenos (cubos) */}
      <Zone id="brakes">
        {[[78, 46], [78, 124], [241, 52], [241, 118]].map(([x, y]) => (
          <rect key={`${x}-${y}`} className="zfill"
            x={x - 5} y={y - 5} width="10" height="10" rx="2" />
        ))}
      </Zone>
      <Badges list={TRUCK_ZONES} pos={TRUCK_BADGE_TOP} />
    </svg>
  )

  // ====== TOP — tráiler ======================================================
  const trailerTop = (
    <svg viewBox="0 0 380 170" className="truck-svg" role="img"
      aria-label="Trailer diagram (top view) by zones">
      {/* neumáticos */}
      <Zone id="tires">
        {[290, 324].flatMap((ax) =>
          [45, 58, 112, 125].map((cy) => (
            <TopTire key={`${ax}-${cy}`} cx={ax} cy={cy} />
          )))}
      </Zone>
      {/* caja */}
      <Zone id="body">
        <rect className="zfill" x="34" y="41" width="314" height="88" rx="10" />
      </Zone>
      {/* puertas traseras */}
      <Zone id="doors">
        <rect className="zfill" x="330" y="43" width="18" height="84" rx="4" />
        <line className="door-split" x1="334" y1="85" x2="346" y2="85" />
      </Zone>
      {/* tren de aterrizaje */}
      <Zone id="landingGear">
        <rect className="zfill" x="138" y="33" width="14" height="9" rx="2" />
        <rect className="zfill" x="138" y="128" width="14" height="9" rx="2" />
      </Zone>
      {/* luces / reflectores */}
      <Zone id="lights">
        <rect className="zfill" x="349" y="47" width="8" height="13" rx="2" />
        <rect className="zfill" x="349" y="110" width="8" height="13" rx="2" />
      </Zone>
      {/* kingpin (neutro) */}
      <rect className="truck-detail solid" x="52" y="79" width="16" height="12" rx="3" />
      {/* suspensión (ejes) */}
      <Zone id="suspension">
        <rect className="zfill" x="287" y="44" width="6" height="82" rx="3" />
        <rect className="zfill" x="321" y="44" width="6" height="82" rx="3" />
      </Zone>
      {/* frenos (cubos) */}
      <Zone id="brakes">
        {[[307, 52], [307, 118]].map(([x, y]) => (
          <rect key={`${x}-${y}`} className="zfill"
            x={x - 5} y={y - 5} width="10" height="10" rx="2" />
        ))}
      </Zone>
      <Badges list={TRAILER_ZONES} pos={TRAILER_BADGE_TOP} />
    </svg>
  )

  // ====== SIDE — tráiler =====================================================
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

  // ====== SIDE — camión ======================================================
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
        <path className="zfill"
          d="M24 134 L24 120 C24 113 27 109 35 107 L106 96 L122 92 L122 134 Z" />
      </Zone>
      <Zone id="cab">
        <path className="zfill"
          d="M122 150 L122 70 C122 63 126 58 134 57 L150 55 L150 47
             C150 44 153 43 158 43 L196 42 C205 42 210 46 210 56 L210 150 Z" />
      </Zone>
      <Zone id="glass">
        <path className="zfill"
          d="M126 90 L126 72 C126 67 129 64 134 63 L152 62 L152 90 Z" />
        <path className="zfill" d="M122 90 L122 76 L126 72 L126 90 Z" />
        <rect className="zfill" x="112" y="70" width="5" height="22" rx="2" />
      </Zone>
      <Zone id="lightsFront">
        <path className="zfill" d="M26 121 L41 119 L42 131 L27 133 Z" />
        <path className="zfill"
          d="M14 150 L14 160 C14 165 17 168 22 168 L44 168 L44 150 Z" />
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

  const svg = view === 'top'
    ? (isTrailer ? trailerTop : truckTop)
    : (isTrailer ? trailerSide : truckSide)

  return (
    <div className="truck-diagram">
      <div className="view-toggle">
        <button className={`vt-btn ${view === 'top' ? 'active' : ''}`}
          onClick={() => setView('top')}>Top</button>
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
