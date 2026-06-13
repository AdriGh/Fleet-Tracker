import {
  lazy, Suspense, type ReactElement, useEffect, useRef, useState,
} from 'react'
import { Toaster } from 'sonner'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  authStatus, clearToken, getHealth, listAlertEvents,
  type AuthUser, type OrgBranding,
} from './api'
import { notifyWarn } from './toast'
import OnboardingWizard from './views/OnboardingWizard'
import Logo from './components/Logo'
import Dashboard from './views/Dashboard'
import DvirPage from './views/DvirPage'
import DefectsPage from './views/DefectsPage'
import NotifyPage from './views/NotifyPage'
import FleetPage from './views/FleetPage'
import MaintBoardPage from './views/MaintBoardPage'
import UnitProfilePage from './views/UnitProfilePage'
import ReeferPage from './views/ReeferPage'
import WorkOrdersPage from './views/WorkOrdersPage'
import PartsPage from './views/PartsPage'
import DriversPage from './views/DriversPage'
import LoadsPage from './views/LoadsPage'
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
    ],
  },
  {
    title: 'Operations',
    items: [
      { id: 'dvir', label: 'DVIR' },
      { id: 'defectos', label: 'Defects' },
      { id: 'avisos', label: 'Notices' },
      { id: 'coldchain', label: 'Cold Chain' },
    ],
  },
  {
    title: 'Maintenance & Compliance',
    items: [
      { id: 'flota', label: 'Fleet' },
      { id: 'pm', label: 'PM Tracker' },
      { id: 'dot', label: 'DOT Inspections' },
      { id: 'workorders', label: 'Work Orders' },
      { id: 'parts', label: 'Parts & Vendors' },
    ],
  },
  {
    title: 'Dispatch',
    items: [
      { id: 'drivers', label: 'Drivers' },
      { id: 'loads', label: 'Loads' },
    ],
  },
  {
    title: 'Coming soon',
    items: [
      { id: 'reports', label: 'Reports & Analytics', soon: true },
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
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L4 16.8 7.2 20l5.3-5.3a4 4 0 0 0 5.2-5.4l-2.5 2.5-2.3-.5-.5-2.3z" />
    </svg>
  ),
  parts: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />
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
  avisos: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m4 7 8 6 8-6" />
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
  drivers: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 3v6.4M12 14.6V21M4 14.5l6.1-1.6M13.9 11.1 20 9.5" />
    </svg>
  ),
  loads: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7h13v10H3zM16 10h3l2 2.5V17h-5z" />
      <path d="M6 10.5h7M6 13.5h4" />
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
  // Navegar a una sección SIEMPRE cierra el perfil de unidad abierto
  // (si no, el perfil se superpone y el clic en el sidebar "no hace nada").
  const navigate = (id: string) => { setProfileUnit(null); setSection(id) }
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
    document.title = branding.app_name || 'Fleet Tracker'
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
  const [navCollapsed, setNavCollapsed] = useState(
    () => localStorage.getItem('ft-sidebar-collapsed') === '1',
  )

  useEffect(() => {
    localStorage.setItem('ft-sidebar-collapsed', navCollapsed ? '1' : '0')
  }, [navCollapsed])

  // Alertas de flota (G3): poll ligero y toast SOLO para eventos nuevos
  // (el primer fetch fija la línea base sin avisar).
  const alertsQuery = useQuery({
    queryKey: ['alert-events-unacked'],
    queryFn: () => listAlertEvents(10, true),
    refetchInterval: 60_000,
    enabled: authed,
  })
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
        appName={branding?.app_name || 'Fleet Tracker'}
        tagline={branding?.tagline || 'Fleet compliance'}
        onLogin={(user) => setSessionUser(user)}
      />
    )
  }

  return (
    <div className="app">
      <Toaster
        theme={theme}
        position="top-right"
        richColors
        closeButton
        toastOptions={{ style: { fontFamily: 'inherit' } }}
      />
      <aside className={`sidebar ${navCollapsed ? 'collapsed' : ''}`}>
        <div className="brand">
          <Logo />
          <span className="brand-text">
            <strong>{branding?.app_name || 'Fleet Tracker'}</strong>
            <span>{branding?.tagline || 'Fleet compliance'}</span>
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
          {NAV_SECTIONS.map((group) => (
            <nav className="nav" key={group.title}>
              <span className="nav-group-label">{group.title}</span>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  className={`nav-item ${section === item.id ? 'active' : ''}`}
                  disabled={item.soon}
                  title={navCollapsed ? item.label : undefined}
                  onClick={() => !item.soon && navigate(item.id)}
                >
                  <span className="nav-ico">{ICONS[item.id]}</span>
                  <span className="nav-text">{item.label}</span>
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
                title={navCollapsed ? item.label : undefined}
                onClick={() => navigate(item.id)}
              >
                <span className="nav-ico">{ICONS[item.id]}</span>
                <span className="nav-text">{item.label}</span>
              </button>
            ))}
          </nav>
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
                  clearToken()
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
          {section === 'avisos' && <NotifyPage />}
          {section === 'flota' && <FleetPage onOpenUnit={setProfileUnit} />}
          {section === 'pm' && <MaintBoardPage kind="pm" />}
          {section === 'dot' && <MaintBoardPage kind="dot" />}
          {section === 'coldchain' && <ReeferPage />}
          {section === 'workorders' && <WorkOrdersPage />}
          {section === 'parts' && <PartsPage />}
          {section === 'drivers' && <DriversPage />}
          {section === 'loads' && <LoadsPage />}
          {section === 'settings' && (
            <SettingsPage
              theme={theme}
              onTheme={setTheme}
              onNavigate={navigate}
              isAdmin={sessionUser?.role === 'admin'}
            />
          )}
          </>}
        </main>
      </div>
    </div>
  )
}
