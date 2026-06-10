// Marca de Fleet Tracker: badge squircle rojo con una flecha de navegación
// blanca (heading/tracking) + un nodo de ruta. Geométrico, de alto contraste,
// brandeable a cualquier tamaño (sirve también de favicon).

export default function Logo() {
  return (
    <div className="brand-logo">
      <svg viewBox="0 0 64 64" className="logo-svg" role="img"
        aria-label="Fleet Tracker">
        <defs>
          <linearGradient id="ftBadge" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ff4d3d" />
            <stop offset="0.55" stopColor="#e11900" />
            <stop offset="1" stopColor="#b71400" />
          </linearGradient>
        </defs>

        {/* Badge squircle */}
        <rect x="3" y="3" width="58" height="58" rx="18"
          fill="url(#ftBadge)" />
        {/* brillo superior sutil */}
        <rect x="3" y="3" width="58" height="58" rx="18" fill="none"
          stroke="rgba(255,255,255,0.18)" strokeWidth="1.2" />

        {/* Flecha de navegación (heading) blanca */}
        <path
          fill="#fff"
          d="M32 15 L45 46 a1.4 1.4 0 0 1-2 1.7 L32 41 L21 47.7 a1.4 1.4 0 0 1-2-1.7 Z"
        />
        {/* nodo de ruta */}
        <circle cx="32" cy="50.5" r="2.4" fill="rgba(255,255,255,0.55)" />
      </svg>
    </div>
  )
}
