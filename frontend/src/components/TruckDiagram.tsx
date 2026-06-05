import { ZONES, type ZoneId } from '../truckZones'

interface Props {
  zones: Record<string, number>
}

// Posición de la insignia con la cantidad, por zona.
const BADGE: Record<ZoneId, [number, number]> = {
  engine: [54, 120],
  glass: [104, 86],
  lightsFront: [30, 110],
  lightsRear: [424, 110],
  cab: [110, 132],
  tires: [70, 186],
  brakes: [152, 186],
  suspension: [360, 184],
  trailer: [300, 150],
}

export default function TruckDiagram({ zones }: Props) {
  const has = (id: ZoneId) => (zones[id] ?? 0) > 0
  const cls = (id: ZoneId) =>
    `truck-zone zone-${id} ${has(id) ? 'has' : 'ok'}`
  const tip = (id: ZoneId, label: string) => {
    const n = zones[id] ?? 0
    return `${label}: ${n > 0 ? `${n} defecto${n > 1 ? 's' : ''}` : 'sin defectos'}`
  }

  const wheels = [70, 120, 152, 345, 380] // cx de cada rueda

  return (
    <div className="truck-diagram">
      <svg viewBox="0 0 440 210" className="truck-svg" role="img"
        aria-label="Diagrama del camión por zonas">
        {/* chasis */}
        <line x1="58" y1="160" x2="402" y2="160" className="truck-frame" />

        {/* suspensión */}
        <g className={cls('suspension')}>
          <title>{tip('suspension', 'Suspensión')}</title>
          <rect className="zfill" x="104" y="158" width="64" height="7" rx="3" />
          <rect className="zfill" x="328" y="158" width="68" height="7" rx="3" />
        </g>

        {/* neumáticos */}
        <g className={cls('tires')}>
          <title>{tip('tires', 'Neumáticos / llantas')}</title>
          {wheels.map((cx) => (
            <circle key={cx} className="zfill" cx={cx} cy="162" r="19" />
          ))}
        </g>
        {wheels.map((cx) => (
          <circle key={`rim${cx}`} className="truck-rim" cx={cx} cy="162" r="9.5" />
        ))}

        {/* frenos (cubo) */}
        <g className={cls('brakes')}>
          <title>{tip('brakes', 'Frenos')}</title>
          {wheels.map((cx) => (
            <circle key={`hub${cx}`} className="zfill" cx={cx} cy="162" r="5" />
          ))}
        </g>

        {/* capó / motor */}
        <g className={cls('engine')}>
          <title>{tip('engine', 'Motor')}</title>
          <path className="zfill"
            d="M30 152 L30 116 Q30 110 36 110 L78 110 L78 152 Z" />
        </g>

        {/* cabina */}
        <g className={cls('cab')}>
          <title>{tip('cab', 'Cabina / puertas')}</title>
          <path className="zfill"
            d="M78 152 L78 78 Q78 72 84 72 L130 72 L130 152 Z" />
        </g>

        {/* parabrisas + espejo */}
        <g className={cls('glass')}>
          <title>{tip('glass', 'Parabrisas / espejos')}</title>
          <path className="zfill" d="M82 108 L90 78 L126 78 L126 108 Z" />
          <rect className="zfill" x="72" y="92" width="6" height="20" rx="2" />
        </g>

        {/* luces delanteras */}
        <g className={cls('lightsFront')}>
          <title>{tip('lightsFront', 'Luces delanteras')}</title>
          <circle className="zfill" cx="32" cy="120" r="6.5" />
          <rect className="zfill" x="26" y="132" width="9" height="18" rx="2" />
        </g>

        {/* tráiler */}
        <g className={cls('trailer')}>
          <title>{tip('trailer', 'Tráiler / tren de rodaje')}</title>
          <rect className="zfill" x="148" y="60" width="272" height="92" rx="4" />
          <rect className="zfill" x="206" y="152" width="9" height="22" rx="2" />
          <rect className="zfill" x="218" y="152" width="9" height="22" rx="2" />
        </g>

        {/* luces traseras */}
        <g className={cls('lightsRear')}>
          <title>{tip('lightsRear', 'Luces traseras')}</title>
          <rect className="zfill" x="410" y="118" width="9" height="18" rx="2" />
          <circle className="zfill" cx="414.5" cy="146" r="4.5" />
        </g>

        {/* insignias de cantidad */}
        {ZONES.filter((z) => has(z.id)).map((z) => {
          const [x, y] = BADGE[z.id]
          return (
            <g key={z.id} className="zone-badge">
              <circle cx={x} cy={y} r="10" />
              <text x={x} y={y + 3.5}>{zones[z.id]}</text>
            </g>
          )
        })}
      </svg>

      <ul className="truck-legend">
        <li><span className="lg-swatch sw-has" /> Con defectos</li>
        <li><span className="lg-swatch sw-ok" /> Sin defectos</li>
      </ul>
    </div>
  )
}
