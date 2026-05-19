import { useEffect, useState } from 'react'
import {
  getBlock,
  getTrends,
  missingDrivers,
  monthSummary,
  recentBlocks,
  type BlockDetail,
  type MissingResponse,
  type MonthSummary,
  type RecentBlock,
  type RecentSort,
  type TrendsResponse,
} from '../api'
import CreateReportModal from '../components/CreateReportModal'
import DriverModal from '../components/DriverModal'
import MissingDrivers from '../components/MissingDrivers'
import PreviewTable from '../components/PreviewTable'
import RecentBlocks from '../components/RecentBlocks'
import SafeDonut from '../components/SafeDonut'
import TrendsChart from '../components/TrendsChart'

export default function DvirPage() {
  const [recent, setRecent] = useState<RecentBlock[]>([])
  const [sort, setSort] = useState<RecentSort>('created_at')
  const [missing, setMissing] = useState<MissingResponse>({
    month: null,
    drivers: [],
  })
  const [summary, setSummary] = useState<MonthSummary>({
    month: null,
    fleet_safe_pct: null,
    n_blocks: 0,
  })
  const [trends, setTrends] = useState<TrendsResponse>({
    month: null,
    points: [],
  })
  const [selected, setSelected] = useState<BlockDetail | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [driverModal, setDriverModal] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    recentBlocks(sort)
      .then(setRecent)
      .catch((e) => setError(e instanceof Error ? e.message : 'Error'))
  }, [sort])

  useEffect(() => {
    missingDrivers().then(setMissing).catch(() => {})
    monthSummary().then(setSummary).catch(() => {})
    getTrends().then(setTrends).catch(() => {})
  }, [])

  async function selectBlock(id: number) {
    try {
      setSelected(await getBlock(id))
    } catch {
      /* ignorar */
    }
  }

  async function handleCreated() {
    try {
      const [r, m, s, t] = await Promise.all([
        recentBlocks('created_at'),
        missingDrivers(),
        monthSummary(),
        getTrends(),
      ])
      setSort('created_at')
      setRecent(r)
      setMissing(m)
      setSummary(s)
      setTrends(t)
      if (r[0]) selectBlock(r[0].id)
    } catch {
      /* ignorar */
    }
  }

  function copyDay() {
    if (!selected) return
    const lines = [selected.date_label]
    for (const group of selected.groups) {
      for (const row of group.rows) {
        lines.push(
          selected.columns
            .map((c) => String(row[c] ?? ''))
            .join('\t'),
        )
      }
    }
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const donut = selected
    ? {
        pct: selected.fleet_safe_pct,
        title: `Flota SAFE · ${selected.date_label}`,
        caption: `${selected.company} · día ${selected.date_label}`,
      }
    : {
        pct: summary.fleet_safe_pct,
        title: 'Flota SAFE del mes',
        caption: summary.month
          ? `Promedio de ${summary.n_blocks} ${
              summary.n_blocks === 1 ? 'día' : 'días'
            } del mes`
          : '',
      }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Panel DVIR</h1>
          <p className="page-sub">
            Inspecciones diarias de la flota — informes, cumplimiento y
            conductores pendientes.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setModalOpen(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" width="17" height="17" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Crear DVIR Report
        </button>
      </div>

      {error && (
        <div className="banner error">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v5M12 16h.01" />
          </svg>
          <span>{error}</span>
        </div>
      )}

      <div className="dvir-grid">
        <section className="card grid-recent">
          <div className="card-head">
            <h2>Últimos DVIR</h2>
            <span className="sub">Ordena por cualquier métrica</span>
          </div>
          <div className="card-body">
            <RecentBlocks
              blocks={recent}
              sort={sort}
              onSort={setSort}
              onSelect={selectBlock}
              selectedId={selected?.id ?? null}
            />
          </div>
        </section>

        <div className="grid-side">
          <section className="card">
            <div className="card-head">
              <h2>Top sin DVIR del mes</h2>
            </div>
            <div className="card-body">
              <MissingDrivers data={missing} onSelect={setDriverModal} />
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>{donut.title}</h2>
            </div>
            <div className="card-body">
              <SafeDonut pct={donut.pct} caption={donut.caption} />
            </div>
          </section>
        </div>

        <section className="card grid-trends">
          <div className="card-head">
            <h2>Tendencia del mes</h2>
            <span className="sub">% flota SAFE e incidencias por día</span>
          </div>
          <div className="card-body">
            <TrendsChart points={trends.points} />
          </div>
        </section>

        <section className="card grid-preview">
          <div className="card-head">
            <h2>Vista previa</h2>
            {selected && (
              <>
                <span className="sub">
                  {selected.company} · {selected.date_label}
                </span>
                <button className="btn-copy" onClick={copyDay}>
                  {copied ? (
                    <>
                      <svg viewBox="0 0 24 24" fill="none"
                        stroke="currentColor" strokeWidth="2"
                        strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                      Copiado
                    </>
                  ) : (
                    <>
                      <svg viewBox="0 0 24 24" fill="none"
                        stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="11" height="11" rx="2" />
                        <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                      </svg>
                      Copiar día
                    </>
                  )}
                </button>
              </>
            )}
          </div>
          <div className="card-body">
            {selected ? (
              <PreviewTable
                columns={selected.columns}
                groups={selected.groups}
                dateLabel={selected.date_label}
              />
            ) : (
              <div className="empty">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.6">
                  <path d="M9 17V7h10v10z" />
                  <path d="M5 3v14a2 2 0 0 0 2 2h12" />
                </svg>
                <p>
                  Selecciona un informe de la lista para ver aquí el bloque
                  diario.
                </p>
              </div>
            )}
          </div>
        </section>
      </div>

      {modalOpen && (
        <CreateReportModal
          onClose={() => setModalOpen(false)}
          onCreated={handleCreated}
        />
      )}

      {driverModal && (
        <DriverModal
          name={driverModal}
          onClose={() => setDriverModal(null)}
        />
      )}
    </div>
  )
}
