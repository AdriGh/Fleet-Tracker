// Marca Rigsmith (rebrand jul-2026, handoff del design system): R facetada
// italica -7° en zinc (el rig) + llave combinada roja como asta (el smith).
// Variante dark (el sitio es dark-locked). Al hover del .rs-logo contenedor,
// la llave ratchetea alrededor del anillo hex (.rs-wrench en styles.css).

function MarkSvg({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 200" className={className} role="img" aria-label="Rigsmith">
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
    </svg>
  )
}

// Marca sola, tamaño libre. `auto` fuerza el ratchet sin hover (momentos hero).
export function RigsmithMark({
  className = 'h-9 w-9',
  auto = false,
}: {
  className?: string
  auto?: boolean
}) {
  return (
    <span className={`rs-logo ${auto ? 'rs-logo-auto' : ''} inline-block`}>
      <MarkSvg className={className} />
    </span>
  )
}

// Lockup de nav/footer: marca + wordmark Space Grotesk bold tracking -0.03em.
export default function Logo({
  withWordmark = true,
  className = '',
}: {
  withWordmark?: boolean
  className?: string
}) {
  return (
    <span className={`rs-logo inline-flex items-center gap-2 ${className}`}>
      <MarkSvg className="-my-1 h-9 w-9" />
      {withWordmark && (
        <span className="font-display text-[17px] font-bold tracking-[-0.03em] text-ink">
          Rigsmith
        </span>
      )}
    </span>
  )
}
