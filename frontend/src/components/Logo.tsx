// Marca Rigsmith (rebrand jul-2026, handoff del design system): tile de
// instrumento #131316 con la R facetada italica -7° (zinc, el rig) y la
// llave combinada roja como asta (el smith). La llave ratchetea al hover
// (.rs-wrench en index.css). El tile es dark en ambos temas, como el
// favicon — no inventar variantes.

export default function Logo() {
  return (
    <div className="brand-logo rs-logo">
      <svg
        viewBox="0 0 64 64"
        className="logo-svg"
        role="img"
        aria-label="Rigsmith"
      >
        <rect x="3" y="3" width="58" height="58" rx="16" fill="#131316" />
        <rect
          x="3"
          y="3"
          width="58"
          height="58"
          rx="16"
          fill="none"
          stroke="rgba(255,255,255,0.14)"
          strokeWidth="1.2"
        />
        <g transform="translate(0 1.5) scale(0.31)">
          <g transform="translate(8 0) skewX(-7)">
            <path
              fill="#f4f4f5"
              d="M88 34 H130 Q154 34 154 57 V79 Q154 96 136 101 L164 152 L138 160 L110 104 H88 V82 H118 Q128 82 128 73 V63 Q128 56 118 56 H88 Z"
            />
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
