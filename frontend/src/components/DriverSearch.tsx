// Buscador de conductores del topbar (v2.11).
//
// Reemplaza a la página "Driver Compliance": al conductor individual se llega
// buscándolo desde cualquier pantalla, y lo agregado vive en Reports. Es el
// primer typeahead de la app, así que se implementa con teclado completo
// (↑/↓ para moverse, Enter para abrir, Esc para cerrar) para que no haga falta
// el mouse.
//
// El roster se pide UNA vez y se filtra en memoria: son decenas de conductores,
// no miles, así que no hace falta buscar en el servidor.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listTmsDrivers } from '../api'
import { DOCS, expTone, initials, needsAttention } from '../drivers'

export default function DriverSearch(
  { onPick }: { onPick: (name: string) => void },
) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // El roster solo se pide cuando el usuario enfoca el buscador (no en cada
  // carga de la app).
  const [enabled, setEnabled] = useState(false)
  const driversQ = useQuery({
    queryKey: ['tms-drivers'], queryFn: listTmsDrivers, enabled,
  })
  const drivers = driversQ.data ?? []

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) {
      // Sin texto: se muestran primero los que necesitan atención — así el
      // buscador vacío ya es útil (a quién perseguir).
      return [...drivers]
        .sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)))
        .slice(0, 8)
    }
    return drivers.filter((d) =>
      d.name.toLowerCase().includes(s)
      || (d.truck || '').toLowerCase().includes(s)
      || (d.trailer || '').toLowerCase().includes(s)
      || (d.driver_company || '').toLowerCase().includes(s)
      || (d.phone || '').includes(s)).slice(0, 8)
  }, [drivers, q])

  useEffect(() => { setActive(0) }, [q])

  // Cerrar al clickear afuera.
  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  function pick(name: string) {
    onPick(name)
    setOpen(false)
    setQ('')
    inputRef.current?.blur()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); return }
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, matches.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const m = matches[active]
      if (m) pick(m.name)
    }
  }

  return (
    <div className="dsr" ref={boxRef}>
      <span className="dsr-ic" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      </span>
      <input
        ref={inputRef}
        className="dsr-input"
        type="search"
        placeholder="Find a driver…"
        aria-label="Find a driver"
        role="combobox"
        aria-expanded={open}
        aria-controls="dsr-list"
        value={q}
        onFocus={() => { setEnabled(true); setOpen(true) }}
        onChange={(e) => { setQ(e.target.value); setOpen(true) }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <div className="dsr-pop" id="dsr-list" role="listbox">
          {driversQ.isPending ? (
            <p className="dsr-note">Loading roster…</p>
          ) : driversQ.error ? (
            <p className="dsr-note">Couldn’t load the driver roster.</p>
          ) : matches.length === 0 ? (
            <p className="dsr-note">
              {q.trim() ? `No driver matches “${q.trim()}”.` : 'No drivers yet.'}
            </p>
          ) : (
            <>
              {!q.trim() && (
                <p className="dsr-hint">Needs attention first</p>
              )}
              {matches.map((d, i) => (
                <button
                  key={d.name}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className={`dsr-row${i === active ? ' on' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(d.name)}
                >
                  <span className="nf-avatar dsr-av">{initials(d.name)}</span>
                  <span className="dsr-text">
                    <strong>{d.name}</strong>
                    <span className="dsr-meta">
                      {d.truck ? `Truck ${d.truck}` : 'no truck'}
                      {d.driver_company ? ` · ${d.driver_company}` : ''}
                    </span>
                  </span>
                  <span className="dsr-docs">
                    {DOCS.map((doc) => {
                      const v = String(d[doc.key] ?? '')
                      const tone = expTone(v)
                      // Solo se marcan los que piden acción; los vigentes no
                      // hacen ruido.
                      if (tone === 'ok') return null
                      return (
                        <span key={doc.label}
                          className={`dsr-doc ${tone || 'none'}`}
                          title={v ? `${doc.label}: ${v}`
                            : `${doc.label}: no date`}>
                          {doc.label}
                        </span>
                      )
                    })}
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
