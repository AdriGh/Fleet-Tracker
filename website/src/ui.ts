// Clases reutilizables alineadas al design system Rigsmith: botones radius
// 11px con glow rojo y press con spring, un solo acento rojo en todo el sitio.
export const btnPrimary =
  'inline-flex items-center justify-center gap-[9px] rounded-[11px] bg-btn px-6 py-[13px] ' +
  'text-[15px] font-semibold text-white shadow-[0_2px_8px_-1px_rgba(226,35,26,0.45)] ' +
  'transition-all duration-150 [transition-timing-function:var(--ease-spring)] ' +
  'hover:-translate-y-px hover:bg-btn-hover hover:shadow-[0_8px_22px_-8px_rgba(226,35,26,0.6)] ' +
  'active:translate-y-px focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-brand-bright focus-visible:ring-offset-2 focus-visible:ring-offset-bg'

export const btnGhost =
  'inline-flex items-center justify-center gap-[9px] rounded-[11px] border border-line ' +
  'bg-surface-2/60 px-6 py-[13px] text-[15px] font-semibold text-ink transition-all duration-150 ' +
  '[transition-timing-function:var(--ease-spring)] hover:-translate-y-px ' +
  'hover:border-line-strong hover:bg-white/[0.06] active:translate-y-px ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-strong'

export const shell = 'mx-auto w-full max-w-[1200px] px-6'

export const eyebrow =
  'font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-brand-bright'
