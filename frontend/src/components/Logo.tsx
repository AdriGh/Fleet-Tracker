// Logo animado de Fleet Tracker: una ruta orgánica con un pulso de rastreo
// que viaja, un radar "ping" en el destino y partículas ambientales.
// Abstracto (sin formas duras), temático de seguimiento de flota.

const ROUTE = 'M14 58 C 44 26, 78 72, 112 48 S 178 20, 226 42'

export default function Logo() {
  return (
    <div className="brand-logo">
      <svg viewBox="0 0 240 84" className="logo-svg" role="img"
        aria-label="Fleet Tracker">
        <defs>
          <linearGradient id="ftGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#6366f1" />
            <stop offset="0.5" stopColor="#8b5cf6" />
            <stop offset="1" stopColor="#22d3ee" />
          </linearGradient>
        </defs>

        {/* partículas ambientales */}
        <circle className="ft-spark s1" cx="58" cy="30" r="1.7" />
        <circle className="ft-spark s2" cx="150" cy="26" r="1.4" />
        <circle className="ft-spark s3" cx="196" cy="62" r="1.6" />
        <circle className="ft-spark s4" cx="96" cy="64" r="1.3" />

        {/* ruta base + pulso viajero */}
        <path className="ft-route" d={ROUTE} />
        <path className="ft-route-glow" d={ROUTE} />

        {/* waypoints */}
        <circle className="ft-node" cx="14" cy="58" r="3.4" />
        <circle className="ft-node" cx="112" cy="48" r="3" />

        {/* destino con radar ping */}
        <circle className="ft-ping" cx="226" cy="42" r="6" />
        <circle className="ft-ping ft-ping-2" cx="226" cy="42" r="6" />
        <circle className="ft-core" cx="226" cy="42" r="4.4" />
      </svg>
    </div>
  )
}
