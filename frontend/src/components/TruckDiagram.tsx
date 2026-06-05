import { type ReactNode } from 'react'
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

const TRUCK_BADGE: Partial<Record<ZoneId, [number, number]>> = {
  engine: [66, 108],
  glass: [140, 78],
  lightsFront: [16, 140],
  lightsRear: [218, 116],
  cab: [182, 104],
  tires: [74, 184],
  brakes: [300, 184],
  suspension: [276, 178],
}

const TRAILER_BADGE: Partial<Record<ZoneId, [number, number]>> = {
  body: [150, 80],
  doors: [314, 70],
  lights: [320, 150],
  tires: [269, 190],
  brakes: [228, 190],
  suspension: [276, 182],
  landingGear: [118, 192],
}

export default function TruckDiagram({ zones, kind }: Props) {
  const has = (id: ZoneId) => (zones[id] ?? 0) > 0
  const cls = (id: ZoneId) => `truck-zone zone-${id} ${has(id) ? 'has' : 'ok'}`
  const tip = (id: ZoneId) => {
    const n = zones[id] ?? 0
    return `${ZONE_LABEL[id]}: ${n > 0 ? `${n} defect${n > 1 ? 's' : ''}` : 'no defects'}`
  }

  function Zone({ id, children }: { id: ZoneId; children: ReactNode }) {
    return (
      <g className={cls(id)}>
        <title>{tip(id)}</title>
        {children}
      </g>
    )
  }

  function Badges({
    list,
    pos,
  }: {
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

  const Wheel = ({ cx }: { cx: number }) => (
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

  return (
    <div className="truck-diagram">
      {kind === 'trailer' ? (
        <svg viewBox="0 0 380 200" className="truck-svg" role="img"
          aria-label="Trailer diagram by zones">
          {/* tren rodaje / chasis */}
          <line className="truck-frame" x1="40" y1="150" x2="320" y2="150" />

          <Zone id="suspension">
            <rect className="zfill" x="244" y="147" width="62" height="7" rx="3" />
          </Zone>

          <Zone id="tires">
            <circle className="zfill" cx="250" cy="150" r="22" />
            <circle className="zfill" cx="288" cy="150" r="22" />
          </Zone>
          <Wheel cx={250} /><Wheel cx={288} />
          <Zone id="brakes">
            <circle className="zfill" cx="250" cy="150" r="6" />
            <circle className="zfill" cx="288" cy="150" r="6" />
          </Zone>

          <Zone id="landingGear">
            <rect className="zfill" x="104" y="138" width="8" height="32" rx="2" />
            <rect className="zfill" x="118" y="138" width="8" height="32" rx="2" />
            <rect className="zfill" x="100" y="168" width="30" height="6" rx="2" />
          </Zone>

          {/* caja */}
          <Zone id="body">
            <path className="zfill"
              d="M26 138 L26 50 Q26 44 32 44 L306 44 L306 138 Z" />
          </Zone>

          {/* puertas traseras */}
          <Zone id="doors">
            <rect className="zfill" x="306" y="46" width="20" height="92" rx="2" />
            <line className="door-split" x1="316" y1="50" x2="316" y2="134" />
            <circle className="door-split" cx="309.5" cy="92" r="1.6" />
            <circle className="door-split" cx="322.5" cy="92" r="1.6" />
          </Zone>

          {/* luces / reflectores */}
          <Zone id="lights">
            <rect className="zfill" x="310" y="120" width="12" height="14" rx="2" />
            <rect className="zfill" x="60" y="142" width="8" height="7" rx="1.5" />
            <rect className="zfill" x="170" y="142" width="8" height="7" rx="1.5" />
          </Zone>

          {/* detalle neutro */}
          <path className="truck-detail solid" d="M14 134 L26 134 L26 120 L14 126 Z" />
          <line className="truck-detail" x1="320" y1="150" x2="320" y2="170" />
          <rect className="truck-detail solid" x="314" y="156" width="12" height="16" rx="1" />
          <path className="truck-detail" d="M230 150 Q269 120 312 150" />

          <Badges list={TRAILER_ZONES} pos={TRAILER_BADGE} />
        </svg>
      ) : (
        <svg viewBox="0 0 380 200" className="truck-svg" role="img"
          aria-label="Truck diagram (Freightliner Cascadia) by zones">
          {/* chasis */}
          <line className="truck-frame" x1="118" y1="150" x2="322" y2="150" />

          <Zone id="suspension">
            <rect className="zfill" x="246" y="147" width="60" height="7" rx="3" />
            <rect className="zfill" x="58" y="147" width="32" height="6" rx="3" />
          </Zone>

          {/* ruedas: dirección + tándem */}
          <Zone id="tires">
            <circle className="zfill" cx="74" cy="150" r="24" />
            <circle className="zfill" cx="256" cy="150" r="24" />
            <circle className="zfill" cx="300" cy="150" r="24" />
          </Zone>
          <Wheel cx={74} /><Wheel cx={256} /><Wheel cx={300} />
          <Zone id="brakes">
            {[74, 256, 300].map((cx) => (
              <circle key={cx} className="zfill" cx={cx} cy="150" r="6" />
            ))}
          </Zone>

          {/* capó aerodinámico (motor) */}
          <Zone id="engine">
            <path className="zfill"
              d="M24 134 L24 120 C24 113 27 109 35 107 L106 96 L122 92 L122 134 Z" />
          </Zone>

          {/* cabina + fairing de techo */}
          <Zone id="cab">
            <path className="zfill"
              d="M122 150 L122 70 C122 63 126 58 134 57 L150 55 L150 47
                 C150 44 153 43 158 43 L196 42 C205 42 210 46 210 56 L210 150 Z" />
          </Zone>

          {/* parabrisas + ventana lateral + espejo */}
          <Zone id="glass">
            <path className="zfill"
              d="M126 90 L126 72 C126 67 129 64 134 63 L152 62 L152 90 Z" />
            <path className="zfill" d="M122 90 L122 76 L126 72 L126 90 Z" />
            <rect className="zfill" x="112" y="70" width="5" height="22" rx="2" />
          </Zone>

          {/* luces delanteras */}
          <Zone id="lightsFront">
            <path className="zfill" d="M26 121 L41 119 L42 131 L27 133 Z" />
            <path className="zfill"
              d="M14 150 L14 160 C14 165 17 168 22 168 L44 168 L44 150 Z" />
          </Zone>

          {/* luces traseras */}
          <Zone id="lightsRear">
            <rect className="zfill" x="204" y="126" width="6" height="15" rx="1.5" />
          </Zone>

          {/* detalle neutro: tanque, escape, guardabarros, puerta, mud flap */}
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

          <Badges list={TRUCK_ZONES} pos={TRUCK_BADGE} />
        </svg>
      )}

      <ul className="truck-legend">
        <li><span className="lg-swatch sw-has" /> With defects</li>
        <li><span className="lg-swatch sw-ok" /> No defects</li>
      </ul>
    </div>
  )
}
