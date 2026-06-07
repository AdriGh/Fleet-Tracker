import { type ReactElement, useEffect, useState } from 'react'
import { getHealth } from './api'
import Logo from './components/Logo'
import DvirPage from './views/DvirPage'
import DefectsPage from './views/DefectsPage'
import NotifyPage from './views/NotifyPage'
import FleetPage from './views/FleetPage'
import RosterPage from './views/RosterPage'
import SettingsPage from './views/SettingsPage'

type Theme = 'light' | 'dark'

const MENU = [
  { id: 'dvir', label: 'DVIR', soon: false },
  { id: 'defectos', label: 'Defects', soon: false },
  { id: 'avisos', label: 'Notices', soon: false },
  { id: 'roster', label: 'Roster', soon: false },
  { id: 'flota', label: 'Fleet', soon: false },
]

const ICONS: Record<string, ReactElement> = {
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
  const [section, setSection] = useState('dvir')

  useEffect(() => {
    getHealth()
      .then((h) => setVersion(h.version))
      .catch(() => setVersion(null))
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('dvir-theme', theme)
  }, [theme])

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <Logo />
          <span className="brand-text">
            <strong>Fleet Tracker</strong>
            <span>Fleet compliance</span>
          </span>
        </div>

        <nav className="nav">
          {MENU.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${section === item.id ? 'active' : ''}`}
              disabled={item.soon}
              onClick={() => !item.soon && setSection(item.id)}
            >
              <span className="nav-ico">{ICONS[item.id]}</span>
              <span className="nav-label">{item.label}</span>
              {item.soon && <span className="soon">soon</span>}
            </button>
          ))}
        </nav>

        <nav className="nav nav-bottom">
          <button
            className={`nav-item ${section === 'settings' ? 'active' : ''}`}
            onClick={() => setSection('settings')}
          >
            <span className="nav-ico">{ICONS.settings}</span>
            <span className="nav-label">Settings</span>
          </button>
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
          <span className="health">
            <span className={`dot ${version ? '' : 'off'}`} />
            {version ? 'Connected' : 'Offline'}
          </span>
          <span className="version">v{version ?? '0.4.0'}</span>
        </div>
      </aside>

      <div className="main-area">
        <main className="container">
          {section === 'dvir' && <DvirPage />}
          {section === 'defectos' && <DefectsPage />}
          {section === 'avisos' && <NotifyPage />}
          {section === 'flota' && <FleetPage />}
          {section === 'roster' && <RosterPage />}
          {section === 'settings' && <SettingsPage />}
        </main>
      </div>
    </div>
  )
}
