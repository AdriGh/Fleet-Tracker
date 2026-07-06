// Marca Rigsmith (rebrand jul-2026, handoff del design system): chip de
// instrumento con la R facetada italica -7° (el rig) y la llave combinada
// roja como asta (el smith). La llave ratchetea al hover (.rs-wrench) y un
// destello barre la R (.rs-gleam). El chip y la R son THEME-AWARE: en dark
// la R es casi blanca sobre chip oscuro; en light la R es casi negra sobre
// chip claro (fills en index.css por [data-theme]). El chip se conserva para
// que el logo tenga contraste sobre cualquier superficie (ej. el hero oscuro
// del login).

// Path de la R (en el espacio local del grupo con skew): se reusa para el
// relleno visible y para el clip del destello.
const R_PATH =
  'M88 34 H130 Q154 34 154 57 V79 Q154 96 136 101 L164 152 L138 160 ' +
  'L110 104 H88 V82 H118 Q128 82 128 73 V63 Q128 56 118 56 H88 Z'

export default function Logo() {
  return (
    <div className="brand-logo rs-logo">
      <svg
        viewBox="0 0 64 64"
        className="logo-svg"
        role="img"
        aria-label="Rigsmith"
      >
        <defs>
          {/* Destello: barrido tipo reflejo con núcleo blanco y flancos
              sutilmente oscuros, para que "reluzca" en ambos temas — en la R
              blanca (dark) resaltan los flancos, en la R negra (light) el
              núcleo. */}
          <linearGradient id="rsGleamGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#000" stopOpacity="0" />
            <stop offset="0.34" stopColor="#000" stopOpacity="0.22" />
            <stop offset="0.5" stopColor="#fff" stopOpacity="0.98" />
            <stop offset="0.66" stopColor="#000" stopOpacity="0.22" />
            <stop offset="1" stopColor="#000" stopOpacity="0" />
          </linearGradient>
          <clipPath id="rsRClip">
            <path d={R_PATH} />
          </clipPath>
        </defs>

        {/* Chip (theme-aware) */}
        <rect x="3" y="3" width="58" height="58" rx="16" className="rs-tile" />
        <rect
          x="3"
          y="3"
          width="58"
          height="58"
          rx="16"
          fill="none"
          strokeWidth="1.2"
          className="rs-tile-border"
        />

        <g transform="translate(0 1.5) scale(0.31)">
          <g transform="translate(8 0) skewX(-7)">
            {/* La R (theme-aware vía var(--text)) */}
            <path className="rs-r" d={R_PATH} />

            {/* Destello: solo visible dentro de la R (clip), barre al hover. */}
            <g className="rs-gleam" clipPath="url(#rsRClip)">
              <rect
                x="72"
                y="18"
                width="26"
                height="152"
                fill="url(#rsGleamGrad)"
                transform="skewX(-16)"
              />
            </g>

            {/* La llave (asta de la R): roja fija, ratchetea al hover */}
            <g className="rs-wrench">
              <path
                fill="#ff4438"
                fillRule="evenodd"
                transform="rotate(-45 65 40)"
                d="M51 58 L51 36 L58 26 L72 26 L79 36 L79 58 Z M58 26 H72 V43 Q72 50 65 50 Q58 50 58 43 Z"
              />
              <path fill="#ff4438" d="M57 50 H74 L71.5 136 H59.5 Z" />
              <path
                fill="#ff4438"
                fillRule="evenodd"
                d="M67 133 L81.7 141.5 V158.5 L67 167 L52.3 158.5 V141.5 Z M67 141 L74.8 145.5 V154.5 L67 159 L59.2 154.5 V145.5 Z"
              />
            </g>
          </g>
        </g>
      </svg>
    </div>
  )
}
