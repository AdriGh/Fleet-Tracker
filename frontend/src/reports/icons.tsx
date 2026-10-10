// Íconos del hub de reportes (trazo 1.8, mismo estándar que el resto).
import type { ReactNode } from 'react'
import type { ReportFieldType } from '../api'

const S = {
  fill: 'none' as const, stroke: 'currentColor', strokeWidth: 1.8,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
}

function I({ children, size = 16, className }: {
  children: ReactNode; size?: number; className?: string
}) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"
      className={className} {...S}>
      {children}
    </svg>
  )
}

export const IcTable = (p: { size?: number }) => (
  <I {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M3 15h18M9 4v16" /></I>
)
export const IcChart = (p: { size?: number }) => (
  <I {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></I>
)
export const IcDash = (p: { size?: number }) => (
  <I {...p}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></I>
)
export const IcStar = ({ on, size = 17 }: { on?: boolean; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"
    fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8}
    strokeLinejoin="round">
    <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />
  </svg>
)
export const IcInfo = (p: { size?: number }) => (
  <I {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.01" /></I>
)
export const IcMore = (p: { size?: number }) => (
  <I {...p}><circle cx="12" cy="5" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="12" cy="19" r="1.2" /></I>
)
export const IcFilter = (p: { size?: number }) => (
  <I {...p}><path d="M3 5h18l-7 8v6l-4 2v-8z" /></I>
)
export const IcSigma = (p: { size?: number }) => (
  <I {...p}><path d="M18 5H6l6 7-6 7h12" /></I>
)
export const IcColumns = (p: { size?: number }) => (
  <I {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></I>
)
export const IcSpark = (p: { size?: number }) => (
  <I {...p}><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /><circle cx="12" cy="12" r="2.6" /></I>
)
export const IcAi = (p: { size?: number }) => (
  <I {...p}><path d="M9.5 3.5 11 8l4.5 1.5L11 11l-1.5 4.5L8 11 3.5 9.5 8 8z" /><path d="M17 13.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z" /></I>
)
export const IcPlus = (p: { size?: number }) => (
  <I {...p}><path d="M12 5v14M5 12h14" /></I>
)
export const IcX = (p: { size?: number }) => (
  <I {...p}><path d="M6 6l12 12M18 6 6 18" /></I>
)
export const IcSearch = (p: { size?: number }) => (
  <I {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></I>
)
export const IcChevron = ({ open, size = 16 }: { open?: boolean; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" {...S}
    className={`rpx-chev${open ? ' is-open' : ''}`}>
    <path d="m9 18 6-6-6-6" />
  </svg>
)
export const IcBack = (p: { size?: number }) => (
  <I {...p}><path d="m15 18-6-6 6-6" /></I>
)
export const IcUp = (p: { size?: number }) => (
  <I {...p}><path d="m6 15 6-6 6 6" /></I>
)
export const IcDown = (p: { size?: number }) => (
  <I {...p}><path d="m6 9 6 6 6-6" /></I>
)
export const IcMail = (p: { size?: number }) => (
  <I {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></I>
)
export const IcDownload = (p: { size?: number }) => (
  <I {...p}><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></I>
)
export const IcPrint = (p: { size?: number }) => (
  <I {...p}><path d="M6 9V3h12v6M6 18H4v-7h16v7h-2" /><rect x="6" y="14" width="12" height="7" /></I>
)
export const IcEdit = (p: { size?: number }) => (
  <I {...p}><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></I>
)
export const IcTrash = (p: { size?: number }) => (
  <I {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></I>
)
export const IcClock = (p: { size?: number }) => (
  <I {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></I>
)
export const IcCopy = (p: { size?: number }) => (
  <I {...p}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></I>
)
export const IcGrip = (p: { size?: number }) => (
  <I {...p}><circle cx="9" cy="6" r=".8" /><circle cx="15" cy="6" r=".8" /><circle cx="9" cy="12" r=".8" /><circle cx="15" cy="12" r=".8" /><circle cx="9" cy="18" r=".8" /><circle cx="15" cy="18" r=".8" /></I>
)

// Ícono por tipo de campo (lista de campos del builder, como SR: # / T / 📅).
export function TypeIcon({ type }: { type: ReportFieldType }) {
  const label = type === 'money' ? '$' : type === 'number' ? '#'
    : type === 'bool' ? '✓' : type === 'text' ? 'T' : ''
  if (type === 'date' || type === 'datetime') {
    return (
      <span className="rpx-ti is-date" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="13" height="13" {...S}>
          <rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" />
        </svg>
      </span>
    )
  }
  return <span className={`rpx-ti is-${type}`} aria-hidden="true">{label}</span>
}
