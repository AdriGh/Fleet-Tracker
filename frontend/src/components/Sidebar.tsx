// Sidebar v2.22 (estructura y timings de SquareRigger, look Rigsmith).
//
// UN solo árbol DOM para expandido (256px) y riel (70px): el ancho anima
// `width .3s cubic-bezier(0,0,.2,1)` y los labels se RECORTAN (overflow
// hidden + nowrap) — nada de display:none ni de dos árboles que se swapean.
// Los iconos quedan en la misma x en ambos estados.
//
// Riel: WORK muestra un icono por ítem; RESOURCES / INSIGHTS / ADMIN son UN
// icono de grupo que abre un flyout (portal, fixed, teclado + Esc + clic
// afuera). Tooltips en hover/focus. El "+" se convierte en ⚡ (acciones
// rápidas: Add new + Search en un popover horizontal).
//
// Grupos colapsables con chevron (localStorage 'ft-nav-groups'); el estado
// del riel lo persiste App ('ft-sidebar-collapsed'). Al terminar la
// transición de ancho se dispara 'ft-sidebar-resized' (MapPage → resize()).
import {
  useEffect, useId, useRef, useState, type FocusEvent,
  type MouseEvent, type ReactNode, type TransitionEvent,
} from 'react'
import Logo from './Logo'
import AddNewMenu from './AddNewMenu'
import { MenuList, Popover, Tooltip } from './ShellPopover'
import {
  ICONS, NAV_GROUPS, UI_ICONS, type NavGroupDef, type NavGroupKey,
  type NavItemDef,
} from '../navModel'
import { usePerms } from '../perms'
import type { AuthUser } from '../api'
import {
  initialsOf, MOD_KEY, type CreateKind, type ThemePref,
} from '../shell'

const GROUPS_KEY = 'ft-nav-groups'

function loadClosedGroups(): Set<NavGroupKey> {
  try {
    const raw = localStorage.getItem(GROUPS_KEY)
    const arr: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(arr)
      ? arr.filter((k): k is NavGroupKey => typeof k === 'string') : [])
  } catch {
    return new Set()
  }
}

// Marca de tiempo para el "skip delay" de tooltips (fuera del render).
const stamp = () => performance.now()

type Menu = 'add' | 'quick' | 'user' | null
type Tip = { el: HTMLElement; label: string; badge?: number }

const THEMES: { id: ThemePref; label: string; icon: ReactNode }[] = [
  { id: 'light', label: 'Light', icon: UI_ICONS.sun },
  { id: 'dark', label: 'Dark', icon: UI_ICONS.moon },
  { id: 'system', label: 'System', icon: UI_ICONS.system },
]

export interface SidebarProps {
  section: string
  onNavigate: (id: string) => void
  collapsed: boolean
  onToggleCollapsed: () => void
  isMobile: boolean
  badges: Record<string, number>
  user: AuthUser | null
  appName: string
  tagline: string
  version: string | null
  themePref: ThemePref
  onThemePref: (t: ThemePref) => void
  onSignOut: () => void
  onOpenSearch: () => void
  onCreate: (kind: CreateKind) => void
}

export default function Sidebar({
  section, onNavigate, collapsed, onToggleCollapsed, isMobile, badges, user,
  appName, tagline, version, themePref, onThemePref, onSignOut, onOpenSearch,
  onCreate,
}: SidebarProps) {
  const { can } = usePerms()
  // En el drawer móvil el nav va SIEMPRE completo (hover no existe en touch).
  const rail = collapsed && !isMobile
  const uid = useId()
  // La sección activa siempre queda a la vista dentro del nav scrolleable
  // (p. ej. al llegar a Fleet overview desde el palette).
  const navRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const el = navRef.current?.querySelector<HTMLElement>(
      '.sb-item.is-active:not([tabindex="-1"])')
    el?.scrollIntoView({ block: 'nearest' })
  }, [section, rail])

  const [closed, setClosed] = useState<Set<NavGroupKey>>(loadClosedGroups)
  useEffect(() => {
    try { localStorage.setItem(GROUPS_KEY, JSON.stringify([...closed])) } catch {
      /* storage bloqueado: el estado vive solo en memoria */
    }
  }, [closed])
  function toggleGroup(k: NavGroupKey) {
    setClosed((s) => {
      const n = new Set(s)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  }

  // Grupos e ítems visibles según permisos (los grupos vacíos no se pintan).
  const groups: NavGroupDef[] = NAV_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.scope || can(i.scope)) }))
    .filter((g) => g.items.length > 0)

  // ----- Menús flotantes ------------------------------------------------------
  const [menu, setMenu] = useState<Menu>(null)
  const slotRef = useRef<HTMLButtonElement | null>(null)
  const userRef = useRef<HTMLButtonElement | null>(null)
  const [fly, setFly] = useState<NavGroupKey | null>(null)
  const flyAnchor = useRef<HTMLElement | null>(null)
  const closeMenu = () => setMenu(null)
  const closeFly = () => setFly(null)

  // ----- Tooltips del riel (delay 280 ms; instantáneo si otro acaba de
  // cerrarse, como Radix "skip delay") ----------------------------------------
  const [tip, setTip] = useState<Tip | null>(null)
  const tipTimer = useRef<number | undefined>(undefined)
  const lastTipAt = useRef(0)
  const showTip = (t: Tip, immediate = false) => {
    window.clearTimeout(tipTimer.current)
    const warm = stamp() - lastTipAt.current < 450
    if (immediate || warm) setTip(t)
    else tipTimer.current = window.setTimeout(() => setTip(t), 280)
  }
  const hideTip = () => {
    window.clearTimeout(tipTimer.current)
    if (tip) lastTipAt.current = stamp()
    setTip(null)
  }
  useEffect(() => () => window.clearTimeout(tipTimer.current), [])
  // Cambiar de modo cierra tooltips y flyouts (anclas que se mueven).
  const [prevRail, setPrevRail] = useState(rail)
  if (prevRail !== rail) {
    setPrevRail(rail)
    setTip(null)
    setFly(null)
    setMenu(null)
  }

  const tipHandlers = (label: string, badge?: number) => (rail ? {
    onMouseEnter: (e: MouseEvent<HTMLElement>) =>
      showTip({ el: e.currentTarget, label, badge }),
    onMouseLeave: hideTip,
    onFocus: (e: FocusEvent<HTMLElement>) => {
      if (e.currentTarget.matches(':focus-visible')) {
        showTip({ el: e.currentTarget, label, badge }, true)
      }
    },
    onBlur: hideTip,
  } : {})

  function go(id: string) {
    hideTip()
    onNavigate(id)
  }

  function onWidthEnd(e: TransitionEvent<HTMLElement>) {
    if (e.target !== e.currentTarget || e.propertyName !== 'width') return
    window.dispatchEvent(new Event('ft-sidebar-resized'))
  }

  const renderItem = (item: NavItemDef, inFlow = true) => {
    const active = section === item.id
    const badge = badges[item.id] || 0
    return (
      <button
        key={item.id}
        type="button"
        className={`sb-item${active ? ' is-active' : ''}`}
        aria-current={active ? 'page' : undefined}
        tabIndex={inFlow ? 0 : -1}
        onClick={() => go(item.id)}
        {...tipHandlers(item.label, badge || undefined)}
      >
        <span className="sb-ico">
          {ICONS[item.id]}
          {badge > 0 && <span className="sb-dot" aria-hidden="true" />}
        </span>
        <span className="sb-label">{item.label}</span>
        {badge > 0 && (
          <span className="nav-badge sb-badge"
            aria-label={`${badge} pending`}>{badge}</span>
        )}
      </button>
    )
  }

  const userName = user?.name || user?.username || 'User'
  const flyGroup = groups.find((g) => g.key === fly)

  return (
    <aside
      className={`sb sidebar${rail ? ' is-rail' : ''}`}
      aria-label="Sidebar"
      onTransitionEnd={onWidthEnd}
    >
      {/* Marca: clic = Home. El logo queda fijo; el nombre se recorta. */}
      <button type="button" className="sb-brand" onClick={() => go('dashboard')}
        aria-label={`${appName} home`} {...tipHandlers(appName)}>
        <Logo />
        <span className="sb-brand-text">
          <strong>{appName}</strong>
          <span>{tagline}</span>
        </span>
      </button>

      {/* Acciones: "+" (Add new) + Search (palette). En el riel el "+" se
          vuelve ⚡ y abre ambas acciones en un popover horizontal. */}
      <div className="sb-actions">
        <button
          ref={slotRef}
          type="button"
          className={`sb-slot${menu === 'add' || menu === 'quick' ? ' is-open' : ''}`}
          aria-haspopup="menu"
          aria-expanded={menu === 'add' || menu === 'quick'}
          aria-label={rail ? 'Quick actions' : 'Add new'}
          onClick={() => {
            hideTip()
            setMenu((m) => (m ? null : rail ? 'quick' : 'add'))
          }}
          {...tipHandlers('Quick actions')}
        >
          <span className="sb-slot-ico is-plus">{UI_ICONS.plus}</span>
          <span className="sb-slot-ico is-bolt">{UI_ICONS.bolt}</span>
        </button>
        <button
          type="button"
          className="sb-search"
          onClick={onOpenSearch}
          tabIndex={rail ? -1 : 0}
          aria-hidden={rail || undefined}
          aria-keyshortcuts="Control+K Meta+K"
        >
          <span className="sb-search-ico">{UI_ICONS.search}</span>
          <span className="sb-search-text">Search</span>
          <kbd className="sb-kbd">{MOD_KEY} K</kbd>
        </button>
      </div>

      <nav ref={navRef} className="sb-scroll" aria-label="Main">
        {groups.map((g, gi) => {
          const flyMode = rail && g.rail === 'flyout'
          const workRail = rail && g.rail === 'items'
          const open = rail ? g.rail === 'items' : !closed.has(g.key)
          const activeItem = g.items.find((i) => i.id === section)
          const groupBadge = g.items.some((i) => (badges[i.id] || 0) > 0)
          const bodyId = `${uid}-${g.key}`
          return (
            <div key={g.key}
              className={`sb-group${open ? ' is-open' : ''}${flyMode ? ' is-fly' : ''}${workRail ? ' is-railitems' : ''}`}>
              {gi > 0 && <div className="sb-sep" aria-hidden="true" />}
              <button
                type="button"
                className={`sb-ghead${flyMode && activeItem ? ' has-active' : ''}${fly === g.key ? ' is-open' : ''}`}
                tabIndex={workRail ? -1 : 0}
                aria-hidden={workRail || undefined}
                {...(flyMode
                  ? {
                    'aria-haspopup': 'menu' as const,
                    'aria-expanded': fly === g.key,
                    'aria-label': g.label,
                  }
                  : { 'aria-expanded': open, 'aria-controls': bodyId })}
                onClick={(e) => {
                  if (flyMode) {
                    hideTip()
                    flyAnchor.current = e.currentTarget
                    setFly((f) => (f === g.key ? null : g.key))
                  } else if (!rail) {
                    toggleGroup(g.key)
                  }
                }}
                onKeyDown={(e) => {
                  if (flyMode && e.key === 'ArrowRight') {
                    e.preventDefault()
                    flyAnchor.current = e.currentTarget
                    setFly(g.key)
                  }
                }}
                {...(flyMode && fly !== g.key ? tipHandlers(g.label) : {})}
              >
                <span className="sb-gh-slot" aria-hidden="true">
                  <span className="sb-gh-chev">{UI_ICONS.chevronDown}</span>
                  <span className="sb-gh-ico">{g.icon}</span>
                  {groupBadge && <span className="sb-dot" />}
                </span>
                <span className="sb-gh-label">{g.label}</span>
              </button>
              {/* Grupo cerrado que contiene la sección activa: se ve el ítem
                  activo igual (el usuario siempre sabe dónde está). */}
              {!rail && !open && activeItem && (
                <div className="sb-gpinned">{renderItem(activeItem)}</div>
              )}
              <div id={bodyId} className="sb-gbody" inert={!open}>
                <div className="sb-gbody-in">
                  {g.items.map((i) => renderItem(i, open))}
                </div>
              </div>
            </div>
          )
        })}
      </nav>

      <div className="sb-foot">
        <div className="sb-meta">
          {!isMobile && (
            <button type="button" className="sb-collapse"
              onClick={() => { hideTip(); onToggleCollapsed() }}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!collapsed}
              {...tipHandlers('Expand sidebar')}>
              {UI_ICONS.chevronsLeft}
            </button>
          )}
          <span className="sb-health" aria-live="polite">
            <span className={`dot ${version ? '' : 'off'}`} />
            {version ? 'Connected' : 'Offline'}
          </span>
          <span className="sb-version">v{version ?? '—'}</span>
        </div>
        <button
          ref={userRef}
          type="button"
          className={`sb-user${menu === 'user' ? ' is-open' : ''}`}
          aria-haspopup="menu"
          aria-expanded={menu === 'user'}
          aria-label={`Account: ${userName}`}
          onClick={() => { hideTip(); setMenu((m) => (m === 'user' ? null : 'user')) }}
          {...tipHandlers(userName)}
        >
          <span className="nf-avatar sm sb-avatar" aria-hidden="true">
            {initialsOf(userName)}
          </span>
          <span className="sb-user-text">
            <strong>{userName}</strong>
            <span>{user?.role ?? ''}</span>
          </span>
          <span className="sb-user-more" aria-hidden="true">{UI_ICONS.more}</span>
        </button>
      </div>

      {tip && rail && (
        <Tooltip anchor={tip.el}>
          {tip.label}
          {tip.badge ? <span className="nav-badge">{tip.badge}</span> : null}
        </Tooltip>
      )}

      {fly && flyGroup && (
        <Popover anchor={flyAnchor} placement="right-start" onClose={closeFly}
          className="rs-menu rs-flyout">
          <div className="rs-menu-head" aria-hidden="true">{flyGroup.label}</div>
          <MenuList label={flyGroup.label} onClose={closeFly}>
            {flyGroup.items.map((i) => {
              const active = section === i.id
              const badge = badges[i.id] || 0
              return (
                <button key={i.id} type="button" role="menuitem"
                  className={`rs-menu-item${active ? ' is-active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => { closeFly(); go(i.id) }}>
                  <span className="rs-mi-ico">{ICONS[i.id]}</span>
                  <span className="rs-mi-label">{i.label}</span>
                  {badge > 0 && <span className="nav-badge">{badge}</span>}
                </button>
              )
            })}
          </MenuList>
        </Popover>
      )}

      {menu === 'quick' && (
        <Popover anchor={slotRef} placement="right-center" onClose={closeMenu}
          className="rs-quick" role="toolbar" label="Quick actions">
          <QuickActions
            onAdd={() => setMenu('add')}
            onSearch={() => { setMenu(null); onOpenSearch() }} />
        </Popover>
      )}

      {menu === 'add' && (
        <AddNewMenu anchor={slotRef}
          placement={rail ? 'right-start' : 'bottom-start'}
          onClose={closeMenu} onPick={onCreate} />
      )}

      {menu === 'user' && (
        <Popover anchor={userRef} placement={rail ? 'right-end' : 'top-start'}
          onClose={closeMenu} className="rs-menu rs-user-menu">
          <div className="rs-user-head">
            <span className="nf-avatar sm" aria-hidden="true">
              {initialsOf(userName)}
            </span>
            <span className="rs-user-id">
              <strong>{userName}</strong>
              <span>
                {user?.username ? `@${user.username}` : ''}
                {user?.role ? ` · ${user.role}` : ''}
              </span>
            </span>
          </div>
          <MenuList label="Account" onClose={closeMenu}>
            <div className="rs-menu-label" id={`${uid}-theme`}>Theme</div>
            <div className="rs-theme-seg" role="group"
              aria-labelledby={`${uid}-theme`}>
              {THEMES.map((t) => (
                <button key={t.id} type="button" role="menuitemradio"
                  aria-checked={themePref === t.id}
                  className={`rs-theme-opt${themePref === t.id ? ' is-on' : ''}`}
                  onClick={() => onThemePref(t.id)}>
                  {t.icon}
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
            <div role="separator" className="rs-menu-sep" />
            <button type="button" role="menuitem" className="rs-menu-item"
              onClick={() => { closeMenu(); onOpenSearch() }}>
              <span className="rs-mi-ico">{UI_ICONS.search}</span>
              <span className="rs-mi-label">Search & commands</span>
              <kbd className="sb-kbd">{MOD_KEY} K</kbd>
            </button>
            <button type="button" role="menuitem"
              className="rs-menu-item is-danger"
              onClick={() => { closeMenu(); onSignOut() }}>
              <span className="rs-mi-ico">{UI_ICONS.signOut}</span>
              <span className="rs-mi-label">Sign out</span>
            </button>
          </MenuList>
          <div className="rs-menu-foot">
            <span className={`dot ${version ? '' : 'off'}`} />
            {version ? 'Connected' : 'Offline'}
            <span className="rs-menu-foot-v">v{version ?? '—'}</span>
          </div>
        </Popover>
      )}
    </aside>
  )
}

// Popover horizontal del ⚡ (riel): Add new + Search. El foco entra al "+".
function QuickActions({ onAdd, onSearch }: {
  onAdd: () => void
  onSearch: () => void
}) {
  const first = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { first.current?.focus({ preventScroll: true }) }, [])
  return (
    <>
      <button ref={first} type="button" className="rs-quick-btn"
        onClick={onAdd} aria-label="Add new" title="Add new">
        {UI_ICONS.plus}
      </button>
      <button type="button" className="rs-quick-btn" onClick={onSearch}
        aria-label={`Search (${MOD_KEY} K)`} title={`Search (${MOD_KEY} K)`}>
        {UI_ICONS.search}
      </button>
    </>
  )
}
