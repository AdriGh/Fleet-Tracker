import { useEffect, useState } from 'react'
import { getHealth } from './api'
import DvirPage from './views/DvirPage'
import DefectsPage from './views/DefectsPage'
import NotifyPage from './views/NotifyPage'

type Theme = 'light' | 'dark'

const MENU = [
  { id: 'dvir', label: 'DVIR', soon: false },
  { id: 'defectos', label: 'Defectos', soon: false },
  { id: 'avisos', label: 'Avisos', soon: false },
  { id: 'roster', label: 'Roster', soon: true },
  { id: 'flota', label: 'Flota', soon: true },
]

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
      <header className="topbar">
        <img src="/favicon.svg" alt="" />
        <h1>DVIR Report Generator</h1>
        <span className="version">v{version ?? '0.4.0'}</span>
        <span className="spacer" />
        <button
          className="icon-btn"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title={theme === 'dark' ? 'Tema claro' : 'Tema oscuro'}
          aria-label="Cambiar tema"
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
          {version ? 'Conectado' : 'Sin conexión'}
        </span>
      </header>

      <nav className="menubar">
        {MENU.map((item) => (
          <button
            key={item.id}
            className={`menu-item ${section === item.id ? 'active' : ''}`}
            disabled={item.soon}
            onClick={() => !item.soon && setSection(item.id)}
          >
            {item.label}
            {item.soon && <span className="soon">pronto</span>}
          </button>
        ))}
      </nav>

      <main className="container">
        {section === 'dvir' && <DvirPage />}
        {section === 'defectos' && <DefectsPage />}
        {section === 'avisos' && <NotifyPage />}
      </main>
    </div>
  )
}
