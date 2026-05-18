import { useEffect, useState } from 'react'
import { getHealth } from './api'
import DailyView from './views/DailyView'
import BatchView from './views/BatchView'

type Theme = 'light' | 'dark'
type Tab = 'daily' | 'batch'

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
  const [tab, setTab] = useState<Tab>('daily')

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
        <span className="version">v{version ?? '0.3.0'}</span>
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
          {version ? 'Servidor conectado' : 'Sin conexión'}
        </span>
      </header>

      <main className="container">
        <nav className="tabs">
          <button
            className={`tab ${tab === 'daily' ? 'active' : ''}`}
            onClick={() => setTab('daily')}
          >
            Informe diario
          </button>
          <button
            className={`tab ${tab === 'batch' ? 'active' : ''}`}
            onClick={() => setTab('batch')}
          >
            Lote mensual
          </button>
        </nav>

        {tab === 'daily' ? <DailyView /> : <BatchView />}
      </main>
    </div>
  )
}
