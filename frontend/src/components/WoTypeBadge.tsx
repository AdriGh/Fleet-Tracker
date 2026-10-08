// Tipo de trabajo de una WO (v2.21): INSIDE (taller propio, técnico) vs
// OUTSIDE (taller externo = Vendor). Tres piezas reutilizables por el
// drawer, las listas/board y el modal de creación — pensadas para
// re-hospedarse en el rediseño de layout (SquareRigger: eyebrow en
// mayúsculas chiquito + chip rosa/acento con el nombre del vendor).
//
//  - <WoTypeBadge wo compact interactive>: chip del tipo. `compact` solo
//    pinta el chip outside (en listas el inside no agrega información).
//    `interactive` lo vuelve botón: abre el popover con los datos del vendor.
//  - <VendorInfoPopover vendorId anchor onClose>: teléfono / email /
//    dirección / cuenta del vendor (de ['vendors']), en portal fixed.
//  - <WoTypeSwitch value onChange>: control segmentado "Inside work ·
//    Outside work" (modal de creación, drawer).
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { listVendors, type WoType } from '../api'
import { VENDOR_KIND_LABEL, vendorLoc } from '../vendors'

export type WoTypeInfo = {
  wo_type: WoType
  vendor_id: number | null
  vendor_name: string
  vendor_city: string
  vendor_state: string
}

export function WoTypeBadge({ wo, compact, interactive, className = '' }: {
  wo: WoTypeInfo
  compact?: boolean
  // Botón que abre el popover del vendor (solo outside).
  interactive?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)

  if (wo.wo_type !== 'outside') {
    if (compact) return null
    return (
      <span className={`wot-badge is-inside ${className}`}>
        <span className="wot-eyebrow">Inside work</span>
      </span>
    )
  }
  const name = wo.vendor_name || 'Third-party shop'
  const loc = vendorLoc({ city: wo.vendor_city, state: wo.vendor_state })
  const body = (
    <>
      <span className="wot-eyebrow">Outside</span>
      <span className="wot-vendor">{name}</span>
    </>
  )
  const cls = `wot-badge is-outside ${compact ? 'is-compact' : ''} ${className}`
  const title = `Outside work · ${name}${loc ? ` · ${loc}` : ''}`
  if (!interactive) {
    return <span className={cls} title={title}>{body}</span>
  }
  return (
    <>
      <button type="button" ref={btnRef} className={`${cls} is-btn`}
        title={title} aria-haspopup="dialog" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}>
        {body}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true" className="wot-caret">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <VendorInfoPopover vendorId={wo.vendor_id} fallback={wo}
          anchor={btnRef} onClose={() => setOpen(false)} />
      )}
    </>
  )
}

// Popover con los datos de contacto del vendor. Portal a <body> con
// position:fixed (no lo recorta el drawer); con pointer-events propio
// porque un dialog modal (vaul) deja el <body> sin pointer-events.
export function VendorInfoPopover({ vendorId, fallback, anchor, onClose }: {
  vendorId: number | null
  // Datos desnormalizados de la WO por si el vendor aún no cargó.
  fallback?: Pick<WoTypeInfo, 'vendor_name' | 'vendor_city' | 'vendor_state'>
  anchor: RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const popRef = useRef<HTMLDivElement | null>(null)
  const vendorsQ = useQuery({ queryKey: ['vendors'], queryFn: listVendors })
  const v = (vendorsQ.data ?? []).find((x) => x.id === vendorId) ?? null

  // Posición (debajo del ancla; arriba si no entra) + cierre por clic
  // afuera / Escape. Se recalcula al cargar el vendor (cambia el alto).
  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current
      const pop = popRef.current
      if (!a || !pop) return
      const r = a.getBoundingClientRect()
      const vw = document.documentElement.clientWidth
      const vh = window.innerHeight
      const pad = 8
      const gap = 6
      const width = Math.min(300, vw - pad * 2)
      const left = Math.max(pad, Math.min(r.left, vw - pad - width))
      const h = pop.offsetHeight
      const below = vh - r.bottom - gap - pad
      const up = h > below && r.top > below
      pop.style.left = `${left}px`
      pop.style.width = `${width}px`
      if (up) {
        pop.style.top = 'auto'
        pop.style.bottom = `${vh - r.top + gap}px`
      } else {
        pop.style.bottom = 'auto'
        pop.style.top = `${r.bottom + gap}px`
      }
    }
    place()
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || anchor.current?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor, onClose, v])

  const name = v?.name || fallback?.vendor_name || 'Vendor'
  const loc = v ? vendorLoc(v)
    : vendorLoc({ city: fallback?.vendor_city, state: fallback?.vendor_state })
  const rows: { k: string; v: string; href?: string }[] = []
  if (v?.phone) rows.push({ k: 'Phone', v: v.phone, href: `tel:${v.phone}` })
  if (v?.email) rows.push({ k: 'Email', v: v.email, href: `mailto:${v.email}` })
  if (v?.address) rows.push({ k: 'Address', v: v.address })
  if (v?.contact) rows.push({ k: 'Contact', v: v.contact })
  if (v?.account) rows.push({ k: 'Account #', v: v.account })

  return createPortal(
    <div className="wot-pop" ref={popRef} role="dialog"
      aria-label={`${name} contact`}
      onClick={(e) => e.stopPropagation()}>
      <div className="wot-pop-head">
        <span className="wot-eyebrow">
          {v?.kind ? VENDOR_KIND_LABEL[v.kind] : 'Vendor'}
        </span>
        <strong className="wot-pop-name">{name}</strong>
        {loc && <span className="wot-pop-loc">{loc}</span>}
      </div>
      {vendorsQ.isPending ? (
        <p className="wot-pop-note">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="wot-pop-note">
          {v ? 'No contact details yet — add them in Parts, Vendors.'
            : 'Vendor details unavailable.'}
        </p>
      ) : (
        <dl className="wot-pop-rows">
          {rows.map((r) => (
            <div className="wot-pop-row" key={r.k}>
              <dt>{r.k}</dt>
              <dd>
                {r.href ? <a href={r.href}>{r.v}</a> : r.v}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {v?.notes && <p className="wot-pop-notes">{v.notes}</p>}
    </div>,
    document.body,
  )
}

// Control segmentado Inside / Outside (estilo SquareRigger). `size="sm"`
// omite la línea secundaria (para el drawer).
export function WoTypeSwitch({
  value, onChange, disabled, size = 'md', className = '',
}: {
  value: WoType
  onChange: (t: WoType) => void
  disabled?: boolean
  size?: 'sm' | 'md'
  className?: string
}) {
  const opts: { key: WoType; label: string; sub: string; icon: string }[] = [
    { key: 'inside', label: 'Inside work', sub: 'Own shop · technician',
      icon: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2-2z' },
    { key: 'outside', label: 'Outside work', sub: 'Third-party shop · vendor',
      icon: 'M3 9l1.5-5h15L21 9M3 9v11h18V9M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0M9 20v-6h6v6' },
  ]
  return (
    <div className={`wot-switch is-${size} ${className}`} role="radiogroup"
      aria-label="Work type">
      {opts.map((o) => (
        <button key={o.key} type="button" role="radio"
          aria-checked={value === o.key}
          className={`wot-seg is-${o.key} ${value === o.key ? 'is-on' : ''}`}
          disabled={disabled}
          onClick={() => { if (value !== o.key) onChange(o.key) }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true">
            <path d={o.icon} />
          </svg>
          <span className="wot-seg-text">
            <strong>{o.label}</strong>
            {size === 'md' && <small>{o.sub}</small>}
          </span>
        </button>
      ))}
    </div>
  )
}
