// Command palette v2.22 (Ctrl/⌘+K, botón Search del sidebar): equivalente al
// "Command Menu" de SquareRigger. Sin texto lista comandos (Go to / Create /
// Preferences); con 2+ caracteres busca registros en /api/search (debounce
// 200 ms; TODAS las WOs, no el tope de 200 de la lista) y los agrupa, más los
// comandos que coinciden. ↑/↓/Enter/Esc; el ítem activo sigue al mouse.
// ARIA: dialog + combobox (input) + listbox con grupos.
import {
  useEffect, useId, useMemo, useRef, useState, type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { globalSearch, type SearchGroupKey } from '../api'
import {
  CREATE_ITEMS, ICONS, NAV_GROUPS, UI_ICONS,
} from '../navModel'
import { usePerms } from '../perms'
import { useEscLayer } from '../layers'
import {
  toIntent, type CreateKind, type NavIntent, type ThemePref,
} from '../shell'

interface Entry {
  id: string
  group: string
  label: string
  sub?: string
  hint?: string
  icon: ReactNode
  keywords?: string
  checked?: boolean
  // Resultado del texto ANTERIOR (atenuado): nunca es la fila por defecto.
  stale?: boolean
  run: () => void
}

interface Section {
  key: string; label: string; entries: Entry[]
  // Resultados del query anterior mientras llega el nuevo (atenuados).
  stale?: boolean
}

const GROUP_META: Record<SearchGroupKey, { label: string; icon: ReactNode }> = {
  work_orders: { label: 'Work orders', icon: ICONS.workorders },
  units: { label: 'Equipment', icon: ICONS.flota },
  customers: { label: 'Customers', icon: ICONS.customers },
  parts: { label: 'Parts', icon: ICONS.parts },
  vendors: { label: 'Vendors', icon: ICONS.vendors },
  service_requests: { label: 'Service requests', icon: ICONS['service-requests'] },
  technicians: { label: 'Employees', icon: ICONS.employees },
  drivers: { label: 'Drivers', icon: ICONS.drivers },
}

// Coincidencia simple y predecible: todas las palabras del query deben
// aparecer; puntúa más el prefijo del label.
function score(e: Entry, q: string): number {
  if (!q) return 1
  const hay = `${e.label} ${e.sub ?? ''} ${e.keywords ?? ''} ${e.group}`
    .toLowerCase()
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.every((w) => hay.includes(w))) return 0
  const label = e.label.toLowerCase()
  if (label.startsWith(q.toLowerCase())) return 3
  if (label.split(/\s+/).some((w) => w.startsWith(words[0]))) return 2
  return 1
}

export interface CommandPaletteProps {
  onClose: () => void
  onNavigate: (section: string, intent?: NavIntent) => void
  onCreate: (kind: CreateKind) => void
  themePref: ThemePref
  onThemePref: (t: ThemePref) => void
  onSignOut: () => void
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
}

export default function CommandPalette({
  onClose, onNavigate, onCreate, themePref, onThemePref, onSignOut,
  sidebarCollapsed, onToggleSidebar,
}: CommandPaletteProps) {
  const { can } = usePerms()
  const uid = useId()
  const listId = `${uid}-list`
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  // Si el mouse no se movió, un scroll que pasa una fila bajo el puntero no
  // debe robar el ítem activo (pasa al usar ↑/↓).
  const pointerMoved = useRef(false)
  // Enter con la búsqueda del texto actual todavía en curso y sin fila
  // elegida a mano: se difiere hasta que llegan SUS resultados (nunca abre
  // un resultado viejo del texto anterior).
  const pendingEnter = useRef(false)

  useEscLayer(true, onClose)

  // Foco al input al abrir; al cerrar vuelve a donde estaba.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    inputRef.current?.focus({ preventScroll: true })
    return () => {
      if (prev && prev !== document.body && document.contains(prev)) {
        prev.focus({ preventScroll: true })
      }
    }
  }, [])

  const term = q.trim()
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(term), 200)
    return () => window.clearTimeout(t)
  }, [term])

  const searchOn = debounced.length >= 2
  const searchQ = useQuery({
    queryKey: ['global-search', debounced],
    queryFn: ({ signal }) => globalSearch(debounced, 8, signal),
    enabled: searchOn,
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
  })

  // ----- Comandos ---------------------------------------------------------------
  const commands: Entry[] = useMemo(() => {
    const out: Entry[] = []
    for (const g of NAV_GROUPS) {
      for (const i of g.items) {
        if (i.scope && !can(i.scope)) continue
        out.push({
          id: `go:${i.id}`, group: 'Go to', label: i.label, hint: g.label,
          icon: ICONS[i.id], keywords: `go to open ${i.keywords ?? ''}`,
          run: () => { onClose(); onNavigate(i.id) },
        })
      }
    }
    for (const c of CREATE_ITEMS) {
      if (c.scope && !can(c.scope)) continue
      out.push({
        id: `new:${c.kind}`, group: 'Create', label: `New ${c.label}`,
        icon: c.icon, keywords: `add create ${c.keywords ?? ''}`,
        run: () => { onClose(); onCreate(c.kind) },
      })
    }
    const themes: { id: ThemePref; label: string; icon: ReactNode }[] = [
      { id: 'light', label: 'Light', icon: UI_ICONS.sun },
      { id: 'dark', label: 'Dark', icon: UI_ICONS.moon },
      { id: 'system', label: 'System', icon: UI_ICONS.system },
    ]
    for (const t of themes) {
      out.push({
        id: `theme:${t.id}`, group: 'Preferences', label: `Theme: ${t.label}`,
        icon: t.icon, keywords: 'appearance mode color scheme',
        checked: themePref === t.id,
        run: () => { onThemePref(t.id); onClose() },
      })
    }
    if (onToggleSidebar) {
      out.push({
        id: 'pref:sidebar', group: 'Preferences',
        label: sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar',
        icon: UI_ICONS.chevronsLeft, keywords: 'sidebar navigation rail',
        run: () => { onClose(); onToggleSidebar() },
      })
    }
    out.push({
      id: 'pref:signout', group: 'Preferences', label: 'Sign out',
      icon: UI_ICONS.signOut, keywords: 'log out logout exit',
      run: () => { onClose(); onSignOut() },
    })
    return out
  }, [can, onClose, onNavigate, onCreate, themePref, onThemePref, onSignOut,
    sidebarCollapsed, onToggleSidebar])

  // ----- Secciones visibles ----------------------------------------------------
  const sections: Section[] = useMemo(() => {
    const byGroup = (list: Entry[]) => {
      const m = new Map<string, Entry[]>()
      for (const e of list) {
        const arr = m.get(e.group) ?? []
        arr.push(e)
        m.set(e.group, arr)
      }
      return [...m.entries()].map(([label, entries]) =>
        ({ key: `cmd:${label}`, label, entries }))
    }
    if (!term) return byGroup(commands)
    const matched = commands
      .map((e) => ({ e, s: score(e, term) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.e)
    const out: Section[] = []
    if (matched.length) {
      out.push({ key: 'cmd', label: 'Commands', entries: matched.slice(0, 6) })
    }
    // Resultados del backend: mientras se escribe/busca el texto nuevo se
    // dejan los anteriores ATENUADOS (sin saltos de layout ni parpadeo).
    const data = searchQ.data
    const stale = debounced !== term || searchQ.isPlaceholderData
    if (term.length >= 2 && data) {
      for (const g of data.groups) {
        if (!g.items?.length) continue
        const meta = GROUP_META[g.key]
        out.push({
          key: `rec:${g.key}`,
          label: meta?.label ?? g.label,
          stale,
          entries: g.items.map((it) => ({
            id: `rec:${g.key}:${it.id}`,
            group: meta?.label ?? g.label,
            label: it.title,
            sub: it.subtitle,
            icon: meta?.icon ?? UI_ICONS.search,
            stale,
            run: () => {
              onClose()
              onNavigate(it.section, toIntent(it.intent))
            },
          })),
        })
      }
    }
    return out
  }, [term, commands, searchQ.data, searchQ.isPlaceholderData, debounced,
    onClose, onNavigate])

  const flat = useMemo(() => sections.flatMap((s) => s.entries), [sections])
  // Por defecto, la primera fila VIGENTE (con ↑/↓ o el mouse se puede elegir
  // una atenuada a propósito).
  const active = flat.find((e) => e.id === activeId)
    ?? flat.find((e) => !e.stale) ?? null

  // Mantiene el ítem activo a la vista (DOM, no estado).
  useEffect(() => {
    if (!active) return
    const el = document.getElementById(`${uid}-${active.id}`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, uid])

  function move(delta: number) {
    if (!flat.length) return
    const i = active ? flat.indexOf(active) : -1
    const j = (i + delta + flat.length) % flat.length
    pointerMoved.current = false
    setActiveId(flat[j].id)
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
    else if (e.key === 'PageDown') { e.preventDefault(); move(5) }
    else if (e.key === 'PageUp') { e.preventDefault(); move(-5) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      if (active) active.run()
      else if (searching) pendingEnter.current = true
    } else if (e.key === 'Tab') {
      // El foco se queda en el diálogo: Tab avanza como ↓.
      e.preventDefault()
      move(e.shiftKey ? -1 : 1)
    }
  }

  const searching = term.length >= 2
    && (debounced !== term || searchQ.isFetching)
  const searchFailed = term.length >= 2 && debounced === term
    && searchQ.isError

  // Llegaron los resultados del texto actual: ejecutar el Enter diferido.
  useEffect(() => {
    if (!pendingEnter.current || searching) return
    pendingEnter.current = false
    flat.find((e) => !e.stale)?.run()
  }, [searching, flat])
  const noRecords = term.length >= 2 && debounced === term
    && !searchQ.isFetching && !searchQ.isError
    && !(searchQ.data?.groups ?? []).some((g) => g.items?.length)

  return createPortal(
    <div className="cmdk-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="cmdk" role="dialog" aria-modal="true"
        aria-label="Command menu">
        <div className="cmdk-input-row">
          <span className="cmdk-input-ico" aria-hidden="true">
            {UI_ICONS.search}
          </span>
          <input
            ref={inputRef}
            className="cmdk-input"
            value={q}
            onChange={(e) => {
              setQ(e.target.value); setActiveId(null)
              pendingEnter.current = false
            }}
            onKeyDown={onKey}
            placeholder="Type a command or search…"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active ? `${uid}-${active.id}` : undefined}
            aria-label="Type a command or search"
            spellCheck={false}
            autoComplete="off"
          />
          {searching && <span className="cmdk-spin" aria-label="Searching" />}
          <kbd className="cmdk-esc">Esc</kbd>
        </div>

        <div ref={listRef} id={listId} className="cmdk-list" role="listbox"
          aria-label="Results"
          onMouseMove={() => { pointerMoved.current = true }}>
          {sections.map((s) => (
            <div key={s.key} role="group" aria-labelledby={`${uid}-${s.key}`}
              className={`cmdk-group${s.stale ? ' is-stale' : ''}`}>
              <div className="cmdk-group-label" id={`${uid}-${s.key}`}
                role="presentation">
                {s.label}
              </div>
              {s.entries.map((e) => {
                const on = active?.id === e.id
                return (
                  <div
                    key={e.id}
                    id={`${uid}-${e.id}`}
                    role="option"
                    aria-selected={on}
                    className={`cmdk-item${on ? ' is-active' : ''}`}
                    onMouseMove={() => {
                      if (pointerMoved.current && !on) setActiveId(e.id)
                    }}
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={() => e.run()}
                  >
                    <span className="cmdk-ico" aria-hidden="true">{e.icon}</span>
                    <span className="cmdk-text">
                      <span className="cmdk-label">{e.label}</span>
                      {e.sub && <span className="cmdk-sub">{e.sub}</span>}
                    </span>
                    {e.checked && (
                      <span className="cmdk-check" aria-label="current">✓</span>
                    )}
                    {e.hint && <span className="cmdk-hint">{e.hint}</span>}
                    <span className="cmdk-enter" aria-hidden="true">↵</span>
                  </div>
                )
              })}
            </div>
          ))}
          {term.length === 1 && flat.length === 0 && (
            <p className="cmdk-empty">Keep typing to search records…</p>
          )}
          {searchFailed && (
            <p className="cmdk-empty">
              Record search is unavailable right now — commands still work.
            </p>
          )}
          {noRecords && flat.length === 0 && (
            <p className="cmdk-empty">No results for “{term}”.</p>
          )}
          {noRecords && flat.length > 0 && (
            <p className="cmdk-empty is-soft">No records match “{term}”.</p>
          )}
        </div>

        <div className="cmdk-foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
          <span className="cmdk-foot-tip">
            Search work orders, units, customers, parts, vendors…
          </span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
