import {
  lazy, Suspense, type ReactElement, useEffect, useMemo, useRef, useState,
} from 'react'
import { Toaster } from 'sonner'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  authStatus, getHealth, listAlertEvents, listPartsRequests, logout,
  type AuthUser, type OrgBranding,
} from './api'
import { PermsContext, type Perms } from './perms'
import { notifyWarn } from './toast'
import OnboardingWizard from './views/OnboardingWizard'
import Logo from './components/Logo'
import Dashboard from './views/Dashboard'
import DvirPage from './views/DvirPage'
import DefectsPage from './views/DefectsPage'
import FleetPage from './views/FleetPage'
import MaintBoardPage from './views/MaintBoardPage'
import UnitProfilePage from './views/UnitProfilePage'
import DriverSearch from './components/DriverSearch'
import DriverDrawer from './components/DriverDrawer'
import ReeferPage from './views/ReeferPage'
import WalkaroundPage from './views/WalkaroundPage'
import WorkflowsPage from './views/WorkflowsPage'
import WorkOrdersPage from './views/WorkOrdersPage'
import PartsPage from './views/PartsPage'
import PurchasingPage from './views/PurchasingPage'
import ReportsPage from './views/ReportsPage'
import SettingsPage from './views/SettingsPage'
import LoginPage from './views/LoginPage'

// El mapa carga maplibre-gl (~250 kB gz): solo se descarga al abrirlo.
const MapPage = lazy(() => import('./views/MapPage'))

type Theme = 'light' | 'dark'

type NavItem = { id: string; label: string; soon?: boolean }
type NavSection = { title: string; items: NavItem[] }

const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Overview',
    items: [
      { id: 'dashboard', label: 'Dashboard' },
      { id: 'map', label: 'Live Map' },
      { id: 'reports', label: 'Reports & Analytics' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { id: 'dvir', label: 'DVIR' },
      { id: 'walkaround', label: 'Walkaround' },
      { id: 'defectos', label: 'Defects' },
      { id: 'coldchain', label: 'Cold Chain' },
      { id: 'workflows', label: 'Driver Workflows' },
    ],
  },
  {
    title: 'Maintenance & Shop',
    items: [
      { id: 'flota', label: 'Fleet' },
      { id: 'pm', label: 'PM Tracker' },
      { id: 'dot', label: 'DOT Inspections' },
      { id: 'workorders', label: 'Work Orders' },
      { id: 'parts', label: 'Parts' },
      { id: 'purchasing', label: 'Purchasing' },
    ],
  },
]

// Sección de administración (al fondo del sidebar). El Roster vive DENTRO
// de Settings (Driver roster & privacy) — fuera del layout frontal.
const ADMIN_ITEMS: NavItem[] = [
  { id: 'settings', label: 'Settings' },
]

const ICONS: Record<string, ReactElement> = {
  dashboard: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="5" rx="1.5" />
      <rect x="13" y="10" width="8" height="11" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
    </svg>
  ),
  map: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14" />
    </svg>
  ),
  reports: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  ),
  workorders: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </svg>
  ),
  parts: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 8 12 3 3 8v8l9 5 9-5V8z" />
      <path d="m3 8 9 5 9-5M12 13v8" />
    </svg>
  ),
  purchasing: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="20" r="1.4" />
      <circle cx="18" cy="20" r="1.4" />
      <path d="M2.5 3H4.8l2 11.4a1.5 1.5 0 0 0 1.5 1.2h8.2a1.5 1.5 0 0 0 1.5-1.2L20.5 7H5.2" />
    </svg>
  ),
  dvir: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 4h6a1 1 0 0 1 1 1v1h2a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h2V5a1 1 0 0 1 1-1z" />
      <path d="m9 13 2 2 4-4" />
    </svg>
  ),
  defectos: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.3 3.5 1.8 18a1.5 1.5 0 0 0 1.3 2.2h17.8A1.5 1.5 0 0 0 22.2 18L13.7 3.5a1.5 1.5 0 0 0-2.6 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  ),
  flota: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 6h11v9H2zM13 9h4l3 3v3h-7z" />
      <circle cx="6.5" cy="17.5" r="1.8" />
      <circle cx="17.5" cy="17.5" r="1.8" />
    </svg>
  ),
  pm: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L4 16.8 7.2 20l5.3-5.3a4 4 0 0 0 5.2-5.4l-2.5 2.5-2.3-.5-.5-2.3z" />
    </svg>
  ),
  dot: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 4h6M9 4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2M9 4v2h6V4" />
      <path d="m9.5 13 1.8 1.8 3.2-3.6" />
    </svg>
  ),
  coldchain: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13.5V5a2 2 0 0 1 4 0v8.5a4.5 4.5 0 1 1-4 0z" />
      <path d="M12 9v7" />
      <circle cx="12" cy="17.5" r="1.6" />
    </svg>
  ),
  walkaround: (
    // Camión con lupa-check: el driver caminando la unidad, zona por zona.
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 6.5h10v8h-10zM12.5 9.5h4l3 3v2h-7z" />
      <path d="M5.5 17.5h.01M16.5 17.5h.01" />
      <path d="m6 10 1.6 1.6L10.5 8.6" />
    </svg>
  ),
  workflows: (
    // Clipboard con lista + check: los pasos del pre-trip que arma el manager.
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 4h6a1 1 0 0 1 1 1v1h2a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h2V5a1 1 0 0 1 1-1z" />
      <path d="M9 11h6M9 15h2.5" />
      <path d="m14 15.3 1.3 1.3 2.4-2.6" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
}

function initialTheme(): Theme {
  const saved = localStorage.getItem('dvir-theme')
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export default function App() {
  const qc = useQueryClient()
  const [version, setVersion] = useState<string | null>(null)
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [section, setSection] = useState('dashboard')
  // H3: perfil completo de unidad (se superpone a la sección actual).
  const [profileUnit, setProfileUnit] = useState<string | null>(null)
  // Conductor abierto en el drawer (se llega por el buscador de la sidebar).
  const [driverName, setDriverName] = useState<string | null>(null)
  // Drawer móvil (<760px): el sidebar se esconde tras una barra superior con
  // hamburguesa; navegar o tocar el scrim lo cierra.
  const [drawerOpen, setDrawerOpen] = useState(false)
  // Viewport-aware: <=760px es el modo drawer. En ese modo el nav se muestra
  // SIEMPRE completo (el riel de iconos con flyout depende de hover, inútil
  // en touch).
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= 760,
  )
  // Navegar a una sección SIEMPRE cierra el perfil de unidad abierto
  // (si no, el perfil se superpone y el clic en el sidebar "no hace nada")
  // y cierra el drawer móvil.
  const navigate = (id: string) => {
    setProfileUnit(null); setSection(id); setDrawerOpen(false); setRailTip(null)
  }
  // Sesión real (fase G7): el token vive en localStorage ('ft-token');
  // /api/auth/status decide entre wizard, login o app.
  const [sessionUser, setSessionUser] = useState<AuthUser | null>(null)
  const statusQuery = useQuery({
    queryKey: ['auth-status'],
    queryFn: authStatus,
    staleTime: 5 * 60_000,
    retry: 1,
  })
  const branding: OrgBranding | undefined = statusQuery.data?.branding

  useEffect(() => {
    if (statusQuery.data?.authenticated && statusQuery.data.user) {
      setSessionUser(statusQuery.data.user)
    }
  }, [statusQuery.data])

  // Un 401 de cualquier llamada -> volver al login.
  useEffect(() => {
    const onUnauthorized = () => {
      setSessionUser(null)
      qc.removeQueries()
      statusQuery.refetch()
    }
    window.addEventListener('ft-unauthorized', onUnauthorized)
    return () =>
      window.removeEventListener('ft-unauthorized', onUnauthorized)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Branding aplicado en vivo: título + acento (color-mix deriva tonos).
  useEffect(() => {
    if (!branding) return
    document.title = branding.app_name || 'Rigsmith'
    const root = document.documentElement
    const props = ['--accent', '--brand', '--accent-2', '--accent-strong',
                   '--accent-soft']
    if (branding.accent) {
      const a = branding.accent
      root.style.setProperty('--accent', a)
      root.style.setProperty('--brand', a)
      root.style.setProperty('--accent-2',
        `color-mix(in srgb, ${a} 78%, white)`)
      root.style.setProperty('--accent-strong',
        `color-mix(in srgb, ${a} 78%, black)`)
      root.style.setProperty('--accent-soft',
        `color-mix(in srgb, ${a} 12%, transparent)`)
    } else {
      props.forEach((p) => root.style.removeProperty(p))
    }
  }, [branding])

  const authed = sessionUser !== null
  // H4: scopes del rol (del backend) para ocultar/deshabilitar acciones.
  const scopes = statusQuery.data?.scopes ?? []
  const perms: Perms = useMemo(() => ({
    role: sessionUser?.role ?? '',
    scopes,
    can: (s: string) => sessionUser?.role === 'admin' || scopes.includes(s),
  }), [sessionUser?.role, scopes])
  const [navCollapsed, setNavCollapsed] = useState(
    () => localStorage.getItem('ft-sidebar-collapsed') === '1',
  )
  // El icono de búsqueda del riel expande + enfoca el input (un paso). El
  // flag se apaga después de que DriverSearch enfocó (su efecto corre antes
  // que este, por orden hijo→padre), así expandir con la flecha no re-enfoca.
  const [dsrWantFocus, setDsrWantFocus] = useState(false)
  useEffect(() => {
    if (!navCollapsed && dsrWantFocus) setDsrWantFocus(false)
  }, [navCollapsed, dsrWantFocus])

  useEffect(() => {
    localStorage.setItem('ft-sidebar-collapsed', navCollapsed ? '1' : '0')
  }, [navCollapsed])

  useEffect(() => {
    const onResize = () => {
      const mobile = window.innerWidth <= 760
      setIsMobile(mobile)
      if (!mobile) setDrawerOpen(false) // al agrandar, cerrar el drawer
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Drawer móvil: Escape lo cierra; se bloquea el scroll del body mientras
  // está abierto para que el gesto quede contenido en el panel.
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    document.body.classList.add('drawer-lock')
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.classList.remove('drawer-lock')
    }
  }, [drawerOpen])

  // Alertas de flota (G3): poll ligero y toast SOLO para eventos nuevos
  // (el primer fetch fija la línea base sin avisar).
  const alertsQuery = useQuery({
    queryKey: ['alert-events-unacked'],
    queryFn: () => listAlertEvents(10, true),
    refetchInterval: 60_000,
    enabled: authed,
  })
  // Badge de Purchasing: nº de requests de partes pendientes de ordenar.
  const requestsQuery = useQuery({
    queryKey: ['parts-requests', 'pending'],
    queryFn: () => listPartsRequests('pending'),
    enabled: authed,
    staleTime: 60_000,
  })
  const navBadges: Record<string, number> = {
    purchasing: requestsQuery.data?.stats?.pending ?? 0,
  }
  // Tooltip del riel colapsado: se posiciona `fixed` a la altura del icono
  // hovereado, así el riel puede scrollear sin recortar ni encimar el label.
  const [railTip, setRailTip] = useState<
    { label: string; badge?: number; y: number } | null
  >(null)
  const lastAlertId = useRef<number | null>(null)
  useEffect(() => {
    const events = alertsQuery.data
    if (!events) return
    const maxId = events.reduce((m, e) => Math.max(m, e.id), 0)
    if (lastAlertId.current === null) {
      lastAlertId.current = maxId
      return
    }
    const fresh = events.filter((e) => e.id > (lastAlertId.current ?? 0))
    fresh.slice(0, 3).forEach((e) => {
      notifyWarn(`${e.rule_label}: ${e.unit}`, e.message)
    })
    if (fresh.length > 3) {
      notifyWarn(`${fresh.length - 3} more fleet alerts`,
        'See the Dashboard for the full list')
    }
    if (maxId > (lastAlertId.current ?? 0)) lastAlertId.current = maxId
  }, [alertsQuery.data])

  useEffect(() => {
    getHealth()
      .then((h) => setVersion(h.version))
      .catch(() => setVersion(null))
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('dvir-theme', theme)
  }, [theme])

  // Splash mínimo mientras se resuelve el estado de auth.
  if (statusQuery.isPending) {
    return (
      <div className="auth-splash" aria-busy="true">
        <Logo />
      </div>
    )
  }

  // Primer arranque: aún no existe el admin.
  if (statusQuery.data?.setup_needed) {
    return (
      <OnboardingWizard
        onDone={() => {
          qc.invalidateQueries({ queryKey: ['auth-status'] })
          statusQuery.refetch()
        }}
      />
    )
  }

  if (!authed) {
    return (
      <LoginPage
        appName={branding?.app_name || 'Rigsmith'}
        tagline={branding?.tagline || 'Your fleet, forged right.'}
        onLogin={(user) => { setSessionUser(user); statusQuery.refetch() }}
      />
    )
  }

  return (
    <PermsContext.Provider value={perms}>
    <div className={`app ${drawerOpen ? 'drawer-open' : ''}`}>
      <Toaster
        theme={theme}
        position="top-right"
        richColors
        closeButton
        toastOptions={{ style: { fontFamily: 'inherit' } }}
      />

      {/* Barra superior móvil (<760px): hamburguesa + marca. En desktop
          queda oculta por CSS. */}
      <header className="topbar">
        <button
          className="icon-btn topbar-burger"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
          aria-expanded={drawerOpen}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
        <span className="topbar-brand">
          <Logo />
          <strong>{branding?.app_name || 'Rigsmith'}</strong>
        </span>
      </header>

      {/* Scrim: cierra el drawer al tocar fuera. */}
      <div
        className="drawer-scrim"
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />

      <aside className={`sidebar ${navCollapsed ? 'collapsed' : ''}`}>
        <div className="brand">
          <Logo />
          <span className="brand-text">
            <strong>{branding?.app_name || 'Rigsmith'}</strong>
            <span>{branding?.tagline || 'Your fleet, forged right.'}</span>
          </span>
          <button
            className="icon-btn nav-collapse"
            onClick={() => setNavCollapsed((c) => !c)}
            title={navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              style={{ transform: navCollapsed ? 'rotate(180deg)' : 'none' }}>
              <path d="m15 6-6 6 6 6" />
            </svg>
          </button>
        </div>

        {/* Zona scrolleable: el nav nunca desborda la pantalla */}
        <div className="sidebar-scroll">
          {/* Buscador de conductores: reemplaza a la página Driver Compliance
              (v2.11). Va acá y no en la topbar porque la topbar es solo móvil
              (display:none en desktop), así que ahí quedaría escondido. En el
              riel colapsado se degrada a un icono que expande la sidebar. */}
          {navCollapsed && !isMobile ? (
            /* Riel: se ve como el BUSCADOR plegado (chip con borde, glifo
               persona+lupa = "buscar conductor"), no como otro nav item.
               Click = expandir + dejar el input enfocado, listo para tipear. */
            <button className="nav-item nav-rail-btn dsr-rail"
              title="Find a driver"
              onClick={() => { setDsrWantFocus(true); setNavCollapsed(false) }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="9" cy="7.5" r="3.1" />
                <path d="M3.8 18.6c.7-3.2 2.8-5 5.2-5 .9 0 1.8.25 2.5.72" />
                <circle cx="16.2" cy="15.2" r="3.9" />
                <path d="m19.1 18.1 2.4 2.4" />
              </svg>
            </button>
          ) : (
            <DriverSearch
              autoFocus={dsrWantFocus}
              onPick={(n) => {
                setDriverName(n)
                setDrawerOpen(false)    // cierra el drawer de nav en móvil
              }} />
          )}
          {navCollapsed && !isMobile ? (
            <>
              {/* Riel colapsado (Icon rail · 74px): un icono por ÍTEM. El riel
                  scrollea si no entra; el label es un tooltip `fixed` (ver
                  railTip) para no recortarse ni encimar el pie. */}
              {NAV_SECTIONS.map((group) => (
                <nav className="nav nav-rail" key={group.title}>
                  <span className="nav-group-label">{group.title}</span>
                  {group.items.filter((i) => !i.soon).map((item) => (
                    <button
                      key={item.id}
                      className={`nav-item nav-rail-btn ${section === item.id ? 'active' : ''}`}
                      title={item.label}
                      onClick={() => navigate(item.id)}
                      onMouseEnter={(e) => {
                        const r = e.currentTarget.getBoundingClientRect()
                        setRailTip({
                          label: item.label,
                          badge: navBadges[item.id] || undefined,
                          y: r.top + r.height / 2,
                        })
                      }}
                      onMouseLeave={() => setRailTip(null)}
                    >
                      <span className="nav-ico">{ICONS[item.id]}</span>
                      {navBadges[item.id]
                        ? <span className="nav-rail-dot" /> : null}
                    </button>
                  ))}
                </nav>
              ))}
              <nav className="nav nav-bottom nav-rail">
                <span className="nav-group-label">Admin</span>
                {ADMIN_ITEMS.map((item) => (
                  <button
                    key={item.id}
                    className={`nav-item nav-rail-btn ${section === item.id ? 'active' : ''}`}
                    title={item.label}
                    onClick={() => navigate(item.id)}
                    onMouseEnter={(e) => {
                      const r = e.currentTarget.getBoundingClientRect()
                      setRailTip({ label: item.label, y: r.top + r.height / 2 })
                    }}
                    onMouseLeave={() => setRailTip(null)}
                  >
                    <span className="nav-ico">{ICONS[item.id]}</span>
                  </button>
                ))}
              </nav>
            </>
          ) : (
            <>
              {NAV_SECTIONS.map((group) => (
                <nav className="nav" key={group.title}>
                  <span className="nav-group-label">{group.title}</span>
                  {group.items.map((item) => (
                    <button
                      key={item.id}
                      className={`nav-item ${section === item.id ? 'active' : ''}`}
                      disabled={item.soon}
                      onClick={() => !item.soon && navigate(item.id)}
                    >
                      <span className="nav-ico">{ICONS[item.id]}</span>
                      <span className="nav-text">{item.label}</span>
                      {navBadges[item.id]
                        ? <span className="nav-badge">{navBadges[item.id]}</span>
                        : null}
                      {item.soon && <span className="soon">soon</span>}
                    </button>
                  ))}
                </nav>
              ))}

              <nav className="nav nav-bottom">
                <span className="nav-group-label">Admin</span>
                {ADMIN_ITEMS.map((item) => (
                  <button
                    key={item.id}
                    className={`nav-item ${section === item.id ? 'active' : ''}`}
                    onClick={() => navigate(item.id)}
                  >
                    <span className="nav-ico">{ICONS[item.id]}</span>
                    <span className="nav-text">{item.label}</span>
                  </button>
                ))}
              </nav>
            </>
          )}
        </div>

        <div className="sidebar-foot">
          {sessionUser && (
            <div className="foot-user" title={`@${sessionUser.username}`}>
              <span className="nf-avatar sm">
                {sessionUser.name.trim().split(/\s+/).slice(0, 2)
                  .map((w) => w[0] ?? '').join('').toUpperCase() || 'U'}
              </span>
              <span className="foot-user-text">
                <strong>{sessionUser.name || sessionUser.username}</strong>
                <span>{sessionUser.role}</span>
              </span>
            </div>
          )}
          <div className="sidebar-foot-row">
            <div className="foot-btns">
              <button
                className="icon-btn"
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
                aria-label="Toggle theme"
              >
                {theme === 'dark' ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round">
                    <circle cx="12" cy="12" r="4.2" />
                    <path d="M12 2v3M12 19v3M5 12H2M22 12h-3M4.6 4.6l2.1 2.1M17.3
                      17.3l2.1 2.1M19.4 4.6l-2.1 2.1M6.7 17.3l-2.1 2.1" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
                  </svg>
                )}
              </button>
              <button
                className="icon-btn"
                onClick={() => {
                  logout()
                  setSessionUser(null)
                  qc.removeQueries()
                  statusQuery.refetch()
                }}
                title="Sign out"
                aria-label="Sign out"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <path d="m16 17 5-5-5-5M21 12H9" />
                </svg>
              </button>
            </div>
            <span className="health">
              <span className={`dot ${version ? '' : 'off'}`} />
              {version ? 'Connected' : 'Offline'}
            </span>
          </div>
          <span className="version">v{version ?? '0.4.0'}</span>
        </div>
      </aside>

      {navCollapsed && !isMobile && railTip && (
        <div className="nav-rail-tip" style={{ top: railTip.y }}>
          {railTip.label}
          {railTip.badge
            ? <span className="nav-badge">{railTip.badge}</span> : null}
        </div>
      )}

      <div className="main-area">
        <main className="container">
          {profileUnit && (
            <UnitProfilePage unit={profileUnit}
              onClose={() => setProfileUnit(null)} />
          )}
          {!profileUnit && <>
          {section === 'dashboard' && <Dashboard onNavigate={navigate} />}
          {section === 'map' && (
            <Suspense fallback={<div className="loadbar" aria-hidden="true" />}>
              <MapPage theme={theme} />
            </Suspense>
          )}
          {section === 'dvir' && <DvirPage />}
          {section === 'defectos' && <DefectsPage />}
          {section === 'flota' && <FleetPage onOpenUnit={setProfileUnit} />}
          {section === 'pm' && <MaintBoardPage kind="pm" />}
          {section === 'dot' && <MaintBoardPage kind="dot" />}
          {section === 'coldchain' && <ReeferPage />}
          {section === 'walkaround' && <WalkaroundPage onNavigate={navigate} />}
          {section === 'workflows' && <WorkflowsPage />}
          {section === 'workorders' && <WorkOrdersPage />}
          {section === 'parts' && <PartsPage />}
          {section === 'purchasing' && <PurchasingPage />}
          {section === 'reports' && <ReportsPage />}
          {section === 'settings' && (
            <SettingsPage
              theme={theme}
              onTheme={setTheme}
              isAdmin={sessionUser?.role === 'admin'}
            />
          )}
          </>}
        </main>
      </div>

      {/* Drawer del conductor: se abre desde el buscador, sobre cualquier
          pantalla (por eso vive acá y no dentro de una vista). */}
      <DriverDrawer name={driverName} onClose={() => setDriverName(null)} />
    </div>
    </PermsContext.Provider>
  )
}
