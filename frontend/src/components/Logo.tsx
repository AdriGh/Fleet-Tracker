// Logo de Fleet Tracker: ilustración icónica de una tractomula (semi) de
// perfil con líneas de movimiento, en el gradiente rojo de la marca. Estilo
// Fullbay (ícono + wordmark en itálica, este último renderizado aparte).

export default function Logo() {
  return (
    <div className="brand-logo">
      <svg viewBox="0 0 224 120" className="logo-svg" role="img"
        aria-label="Fleet Tracker">
        <defs>
          <linearGradient id="ftGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ff7a5c" />
            <stop offset="0.55" stopColor="#e2231a" />
            <stop offset="1" stopColor="#b3140d" />
          </linearGradient>
          <linearGradient id="ftWheel" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#9a140d" />
            <stop offset="1" stopColor="#5e0b06" />
          </linearGradient>
        </defs>

        {/* líneas de movimiento (detrás del tráiler) */}
        <g className="ft-speed" fill="none" stroke="url(#ftGrad)"
          strokeLinecap="round">
          <line x1="6" y1="40" x2="30" y2="40" strokeWidth="5" opacity="0.85" />
          <line x1="0" y1="54" x2="22" y2="54" strokeWidth="5" opacity="0.55" />
          <line x1="9" y1="68" x2="31" y2="68" strokeWidth="5" opacity="0.3" />
        </g>

        {/* carrocería: tráiler + tractor (un solo silueta) */}
        <path
          fill="url(#ftGrad)"
          d="M34 84 V28 H150 V46 H172 L184 60 H204 L206 66 V84 Z"
        />

        {/* parabrisas */}
        <path fill="#fff" opacity="0.92"
          d="M174 49 H184 L192 59 H174 Z" />

        {/* separación tráiler / tractor */}
        <line x1="150" y1="30" x2="150" y2="82" stroke="#fff"
          strokeOpacity="0.28" strokeWidth="2.5" />

        {/* ruedas */}
        <g>
          <circle cx="56" cy="88" r="12" fill="url(#ftWheel)" />
          <circle cx="84" cy="88" r="12" fill="url(#ftWheel)" />
          <circle cx="150" cy="88" r="12" fill="url(#ftWheel)" />
          <circle cx="192" cy="88" r="12" fill="url(#ftWheel)" />
          {/* cubos */}
          <circle cx="56" cy="88" r="4" fill="#ffd9c9" />
          <circle cx="84" cy="88" r="4" fill="#ffd9c9" />
          <circle cx="150" cy="88" r="4" fill="#ffd9c9" />
          <circle cx="192" cy="88" r="4" fill="#ffd9c9" />
        </g>
      </svg>
    </div>
  )
}
