import { type ReactElement, useEffect, useState } from 'react'
import { Toaster } from 'sonner'
import { getHealth } from './api'
import Logo from './components/Logo'
import Dashboard from './views/Dashboard'
import DvirPage from './views/DvirPage'
import DefectsPage from './views/DefectsPage'
import NotifyPage from './views/NotifyPage'
import FleetPage from './views/FleetPage'
import RosterPage from './views/RosterPage'
import PMPage from './views/PMPage'
import SettingsPage from './views/SettingsPage'
import LoginPage from './views/LoginPage'

type Theme = 'light' | 'dark'

type NavItem = { id: string; label: string; soon?: boolean }
type NavSection = { title: string; items: NavItem[] }

const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Overview',
    items: [{ id: 'dashboard', label: 'Dashboard' }],
  },
  {
    title: 'Operations',
    items: [
      { id: 'dvir', label: 'DVIR' },
      { id: 'defectos', label: 'Defects' },
      { id: 'avisos', label: 'Notices' },
      { id: 'flota', label: 'Fleet' },
      { id: 'pm', label: 'PM Tracker' },
    ],
  },
  {
    title: 'Coming soon',
    items: [
      { id: 'reports', label: 'Reports & Analytics', soon: true },
      { id: 'workorders', label: 'Work Orders', soon: true },
    ],
  },
]

// Sección de administración (info sensible, al fondo del sidebar).
const ADMIN_ITEMS: NavItem[] = [
  { id: 'roster', label: 'Roster' },
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
  roster: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0M17 8.5a3 3 0 0 1 0 5.8M20.5 19a4.5 4.5 0 0 0-3-4.2" />
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
  const [version, setVersion] = useState<string | null>(null)
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [section, setSection] = useState('dashboard')
  const [authed, setAuthed] = useState(
    () => localStorage.getItem('dvir-auth') === '1',
  )

  useEffect(() => {
    getHealth()
      .then((h) => setVersion(h.version))
      .catch(() => setVersion(null))
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('dvir-theme', theme)
  }, [theme])

  if (!authed) {
    return (
      <LoginPage
        onLogin={() => {
          localStorage.setItem('dvir-auth', '1')
          setAuthed(true)
        }}
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
      <aside className="sidebar">
        <div className="brand">
          <Logo />
          <span className="brand-text">
            <strong>Fleet Tracker</strong>
            <span>Fleet compliance</span>
          </span>
        </div>

        {NAV_SECTIONS.map((group) => (
          <nav className="nav" key={group.title}>
            <span className="nav-group-label">{group.title}</span>
            {group.items.map((item) => (
              <button
                key={item.id}
                className={`nav-item ${section === item.id ? 'active' : ''}`}
                disabled={item.soon}
                onClick={() => !item.soon && setSection(item.id)}
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
              onClick={() => setSection(item.id)}
            >
              <span className="nav-ico">{ICONS[item.id]}</span>
              <span className="nav-text">{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
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
              localStorage.removeItem('dvir-auth')
              setAuthed(false)
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
          <span className="health">
            <span className={`dot ${version ? '' : 'off'}`} />
            {version ? 'Connected' : 'Offline'}
          </span>
          <span className="version">v{version ?? '0.4.0'}</span>
        </div>
      </aside>

      <div className="main-area">
        <main className="container">
          {section === 'dashboard' && <Dashboard onNavigate={setSection} />}
          {section === 'dvir' && <DvirPage />}
          {section === 'defectos' && <DefectsPage />}
          {section === 'avisos' && <NotifyPage />}
          {section === 'flota' && <FleetPage />}
          {section === 'roster' && <RosterPage />}
          {section === 'pm' && <PMPage />}
          {section === 'settings' && <SettingsPage />}
        </main>
      </div>
    </div>
  )
}
