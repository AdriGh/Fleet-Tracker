import { useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
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
import { copyBlock } from '../clipboard'
import { notifyOk, notifyErr } from '../toast'
import CreateReportModal from '../components/CreateReportModal'
import DriverModal from '../components/DriverModal'
import MissingDrivers from '../components/MissingDrivers'
import PreviewTable from '../components/PreviewTable'
import RecentBlocks from '../components/RecentBlocks'
import SafeDonut from '../components/SafeDonut'
import Skeleton from '../components/Skeleton'
import TrendsChart from '../components/TrendsChart'

const EMPTY_MISSING: MissingResponse = { month: null, drivers: [] }
const EMPTY_SUMMARY: MonthSummary = {
  month: null, fleet_safe_pct: null, n_blocks: 0,
}
const EMPTY_TRENDS: TrendsResponse = { month: null, points: [] }

export default function DvirPage() {
  const qc = useQueryClient()
  const [sort, setSort] = useState<RecentSort>('created_at')
  const [selected, setSelected] = useState<BlockDetail | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [driverModal, setDriverModal] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const recentQuery = useQuery({
    queryKey: ['recent-blocks', sort],
    queryFn: () => recentBlocks(sort),
    placeholderData: keepPreviousData,
  })
  const missingQuery = useQuery({
    queryKey: ['missing-drivers'], queryFn: missingDrivers })
  const summaryQuery = useQuery({
    queryKey: ['month-summary'], queryFn: monthSummary })
  const trendsQuery = useQuery({ queryKey: ['trends'], queryFn: getTrends })

  const recent: RecentBlock[] = recentQuery.data ?? []
  const missing = missingQuery.data ?? EMPTY_MISSING
  const summary = summaryQuery.data ?? EMPTY_SUMMARY
  const trends = trendsQuery.data ?? EMPTY_TRENDS
  const err = recentQuery.error ?? missingQuery.error
    ?? summaryQuery.error ?? trendsQuery.error
  const error = err ? (err instanceof Error ? err.message : 'Error') : null
  const fetching = recentQuery.isFetching || missingQuery.isFetching
    || summaryQuery.isFetching || trendsQuery.isFetching
  const recentLoading = recentQuery.isPending
  const sideLoading = missingQuery.isPending || summaryQuery.isPending
  const trendsLoading = trendsQuery.isPending

  async function selectBlock(id: number) {
    try {
      setSelected(await getBlock(id))
    } catch {
      /* ignorar */
    }
  }

  async function handleCreated() {
    setSort('created_at')
    qc.invalidateQueries({ queryKey: ['missing-drivers'] })
    qc.invalidateQueries({ queryKey: ['month-summary'] })
    qc.invalidateQueries({ queryKey: ['trends'] })
    try {
      const r = await recentBlocks('created_at')
      qc.setQueryData(['recent-blocks', 'created_at'], r)
      if (r[0]) selectBlock(r[0].id)
    } catch {
      /* ignorar */
    }
  }

  function refresh() {
    recentQuery.refetch()
    missingQuery.refetch()
    summaryQuery.refetch()
    trendsQuery.refetch()
  }

  async function copyDay() {
    if (!selected) return
    try {
      await copyBlock(selected.columns, selected.groups, selected.date_label)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      notifyOk('Día copiado al portapapeles')
    } catch (e) {
      notifyErr('No se pudo copiar', e)
    }
  }

  const donut = selected
    ? {
        pct: selected.fleet_safe_pct,
        title: `Fleet SAFE · ${selected.date_label}`,
        caption: `${selected.company} · day ${selected.date_label}`,
      }
    : {
        pct: summary.fleet_safe_pct,
        title: 'Fleet SAFE this month',
        caption: summary.month
          ? `Average of ${summary.n_blocks} ${
              summary.n_blocks === 1 ? 'day' : 'days'
            } this month`
          : '',
      }

  return (
    <div className="page page-wide">
      {fetching && <div className="loadbar" aria-hidden="true" />}
      <div className="page-head">
        <div>
          <h1>DVIR Dashboard</h1>
          <p className="page-sub">
            Daily fleet inspections — reports, compliance and pending
            drivers.
          </p>
        </div>
        <div className="head-actions">
          <button className="btn btn-ghost" onClick={refresh}
            disabled={fetching} title="Refresh">
            <svg className={fetching ? 'spin' : ''} viewBox="0 0 24 24"
              width="15" height="15" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
            </svg>
            {fetching ? 'Refreshing…' : 'Refresh'}
          </button>
          <button className="btn btn-primary" onClick={() => setModalOpen(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" width="17" height="17" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Create DVIR Report
          </button>
        </div>
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
            <h2>Recent DVIRs</h2>
            <span className="sub">Sort by any metric</span>
          </div>
          <div className="card-body">
            {recentLoading ? (
              <div className="skel-rows">
                {Array.from({ length: 7 }).map((_, i) => (
                  <Skeleton key={i} h={38} />
                ))}
              </div>
            ) : (
              <RecentBlocks
                blocks={recent}
                sort={sort}
                onSort={setSort}
                onSelect={selectBlock}
                selectedId={selected?.id ?? null}
              />
            )}
          </div>
        </section>

        <div className="grid-side">
          <section className="card">
            <div className="card-head">
              <h2>Top missing DVIR this month</h2>
            </div>
            <div className="card-body">
              {sideLoading ? (
                <div className="skel-rows">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} h={28} />
                  ))}
                </div>
              ) : (
                <MissingDrivers data={missing} onSelect={setDriverModal} />
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>{donut.title}</h2>
            </div>
            <div className="card-body">
              {sideLoading ? (
                <Skeleton className="skel-chart" h={180} />
              ) : (
                <SafeDonut pct={donut.pct} caption={donut.caption} />
              )}
            </div>
          </section>
        </div>

        <section className="card grid-trends">
          <div className="card-head">
            <h2>Monthly trend</h2>
            <span className="sub">incidents per day (NO DVIR + Unsafe)</span>
          </div>
          <div className="card-body">
            {trendsLoading ? (
              <Skeleton className="skel-chart" h={180} />
            ) : (
              <TrendsChart points={trends.points} />
            )}
          </div>
        </section>

        <section className="card grid-preview">
          <div className="card-head">
            <h2>Preview</h2>
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
                      Copied
                    </>
                  ) : (
                    <>
                      <svg viewBox="0 0 24 24" fill="none"
                        stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="11" height="11" rx="2" />
                        <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                      </svg>
                      Copy day
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
                  Select a report from the list to see the daily block
                  here.
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
