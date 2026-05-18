import { useEffect, useState } from 'react'
import {
  getBlock,
  missingDrivers,
  recentBlocks,
  type BlockDetail,
  type MissingResponse,
  type RecentBlock,
  type RecentSort,
} from '../api'
import CreateReportModal from '../components/CreateReportModal'
import MissingDrivers from '../components/MissingDrivers'
import PreviewTable from '../components/PreviewTable'
import RecentBlocks from '../components/RecentBlocks'

export default function DvirPage() {
  const [recent, setRecent] = useState<RecentBlock[]>([])
  const [sort, setSort] = useState<RecentSort>('created_at')
  const [missing, setMissing] = useState<MissingResponse>({
    month: null,
    drivers: [],
  })
  const [selected, setSelected] = useState<BlockDetail | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    recentBlocks(sort)
      .then(setRecent)
      .catch((e) => setError(e instanceof Error ? e.message : 'Error'))
  }, [sort])

  useEffect(() => {
    missingDrivers().then(setMissing).catch(() => {})
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
      const [r, m] = await Promise.all([
        recentBlocks('created_at'),
        missingDrivers(),
      ])
      setSort('created_at')
      setRecent(r)
      setMissing(m)
      if (r[0]) selectBlock(r[0].id)
    } catch {
      /* ignorar */
    }
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

        <section className="card grid-missing">
          <div className="card-head">
            <h2>Top sin DVIR del mes</h2>
          </div>
          <div className="card-body">
            <MissingDrivers data={missing} />
          </div>
        </section>

        <section className="card grid-preview">
          <div className="card-head">
            <h2>Vista previa</h2>
            {selected && (
              <span className="sub">
                {selected.company} · {selected.date_label}
              </span>
            )}
          </div>
          <div className="card-body">
            {selected ? (
              <PreviewTable
                columns={selected.columns}
                groups={selected.groups}
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
    </div>
  )
}
