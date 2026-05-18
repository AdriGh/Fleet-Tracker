import { useEffect, useRef, useState } from 'react'
import {
  createReport,
  downloadUrl,
  getHealth,
  type ReportResponse,
} from './api'
import FileDrop from './components/FileDrop'
import PreviewTable from './components/PreviewTable'

type Theme = 'light' | 'dark'

function guessDateLabel(): string {
  const now = new Date()
  return `${now.getMonth() + 1}.${now.getDate()}`
}

function initialTheme(): Theme {
  const saved = localStorage.getItem('dvir-theme')
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export default function App() {
  const [dvirFile, setDvirFile] = useState<File | null>(null)
  const [activityFile, setActivityFile] = useState<File | null>(null)
  const [rosterFile, setRosterFile] = useState<File | null>(null)
  const [company, setCompany] = useState('CHASER')
  const [dateLabel, setDateLabel] = useState(guessDateLabel())
  const [minMiles, setMinMiles] = useState('25')

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<ReportResponse | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [theme, setTheme] = useState<Theme>(initialTheme)

  const rosterInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    getHealth()
      .then((h) => setVersion(h.version))
      .catch(() => setVersion(null))
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('dvir-theme', theme)
  }, [theme])

  const canSubmit =
    !!dvirFile && !!activityFile && dateLabel.trim() !== '' && !loading

  async function handleSubmit() {
    if (!dvirFile || !activityFile) return
    setLoading(true)
    setError(null)
    try {
      const result = await createReport({
        dvirFile,
        activityFile,
        rosterFile,
        company: company.trim() || 'CHASER',
        dateLabel: dateLabel.trim(),
        minMiles: Number(minMiles) || 0,
      })
      setReport(result)
    } catch (err) {
      setReport(null)
      setError(err instanceof Error ? err.message : 'Error desconocido')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <img src="/favicon.svg" alt="" />
        <h1>DVIR Report Generator</h1>
        <span className="version">v{version ?? '0.2.0'}</span>
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
        {/* ---- Paso 1: entradas ------------------------------------ */}
        <section className="card">
          <div className="card-head">
            <span className="step">1</span>
            <h2>Archivos y datos</h2>
            <span className="sub">Exportaciones CSV de Samsara</span>
          </div>
          <div className="card-body">
            <div className="dropzones">
              <FileDrop
                label="CSV de DVIR"
                hint="Driver Vehicle Inspection Reports"
                file={dvirFile}
                onChange={setDvirFile}
              />
              <FileDrop
                label="CSV de actividad"
                hint="Vehicle Activity Report"
                file={activityFile}
                onChange={setActivityFile}
              />
            </div>

            <div className="fields">
              <div className="field">
                <label htmlFor="company">Empresa</label>
                <input
                  id="company"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="date">
                  Etiqueta del día
                  <span className="field-hint"> · mes.día (ej. 5.18)</span>
                </label>
                <input
                  id="date"
                  value={dateLabel}
                  onChange={(e) => setDateLabel(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="miles">
                  Millas mín. activo
                  <span className="field-hint"> · umbral NO DVIR</span>
                </label>
                <input
                  id="miles"
                  type="number"
                  min="0"
                  value={minMiles}
                  onChange={(e) => setMinMiles(e.target.value)}
                />
              </div>
            </div>

            <div className="roster-row">
              <input
                ref={rosterInput}
                type="file"
                accept=".csv"
                hidden
                onChange={(e) => setRosterFile(e.target.files?.[0] ?? null)}
              />
              <span>Roster camión→conductor:</span>
              {rosterFile ? (
                <span className="file-pill">
                  {rosterFile.name}
                  <button
                    type="button"
                    className="linkbtn"
                    onClick={() => {
                      setRosterFile(null)
                      if (rosterInput.current) rosterInput.current.value = ''
                    }}
                  >
                    quitar
                  </button>
                </span>
              ) : (
                <>
                  <strong>roster.csv del servidor</strong>
                  <button
                    type="button"
                    className="linkbtn"
                    onClick={() => rosterInput.current?.click()}
                  >
                    usar otro CSV
                  </button>
                </>
              )}
            </div>

            {error && (
              <div className="banner error" style={{ marginTop: 18 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 8v5M12 16h.01" />
                </svg>
                <span>{error}</span>
              </div>
            )}

            <div className="actions">
              <button
                className="btn btn-primary"
                disabled={!canSubmit}
                onClick={handleSubmit}
              >
                {loading && <span className="spin" />}
                {loading ? 'Generando…' : 'Generar informe'}
              </button>
            </div>
          </div>
        </section>

        {/* ---- Paso 2: vista previa -------------------------------- */}
        <section className="card">
          <div className="card-head">
            <span className="step">2</span>
            <h2>Vista previa</h2>
            {report && (
              <span className="sub">
                {report.company} · {report.date_label}
              </span>
            )}
          </div>
          <div className="card-body">
            {report ? (
              <>
                <div className="stats">
                  <div className="stat">
                    <div className="stat-val">{report.stats.drivers}</div>
                    <div className="stat-label">Conductores</div>
                  </div>
                  <div className="stat">
                    <div className="stat-val">{report.stats.rows}</div>
                    <div className="stat-label">Filas totales</div>
                  </div>
                  <div className="stat warn">
                    <div className="stat-val">{report.stats.no_dvir}</div>
                    <div className="stat-label">NO DVIR detectados</div>
                  </div>
                </div>

                <PreviewTable
                  columns={report.columns}
                  groups={report.groups}
                />

                <div className="actions">
                  <a
                    className="btn btn-success"
                    href={downloadUrl(report.id)}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="2" width="17" height="17">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <path d="M7 10l5 5 5-5" />
                      <path d="M12 15V3" />
                    </svg>
                    Descargar Excel
                  </a>
                </div>
              </>
            ) : (
              <div className="empty">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.6">
                  <path d="M9 17V7h10v10z" />
                  <path d="M5 3v14a2 2 0 0 0 2 2h12" />
                </svg>
                <p>
                  Carga los dos CSV y genera el informe para ver aquí la
                  vista previa del bloque diario.
                </p>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}
