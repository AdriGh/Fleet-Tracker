// Reports (v2.22 [G]) — hub estilo SquareRigger, y un paso más:
//  - Izquierda: biblioteca con pestañas Mine / Org / Rigsmith, búsqueda,
//    All / Favorites, agrupada por categoría; cada ítem = nombre + versión
//    por defecto + "N vers".
//  - Derecha: viewer del reporte elegido (Data | Charts | Dashboard, ★, ⓘ,
//    versión, Save as mine, ⋮ export/schedule/builder, filtros, Σ, columnas).
//  - "Ask Rigsmith": asistente de IA que arma un reporte desde lenguaje
//    natural sobre los datos de la org (SR solo tiene un chatbot de docs) y
//    lo abre en el builder con vista previa.
//  - Report Builder ("New report") y la lista de envíos programados.
// Los tableros heredados (gasto, CPM, PM compliance, driver compliance)
// siguen accesibles como la vista "Dashboard" de sus reportes de sistema.
// Mobile (≤760px): lista y viewer son paneles alternos (CSS + data-pane).
import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getReportLibrary, getReportSources, toggleFavorite,
  type ReportAssistantAnswer, type ReportLibrary, type SavedReport,
} from '../api'
import type { NavIntent } from '../shell'
import { Button } from '../components/ds'
import Skeleton from '../components/Skeleton'
import { notifyErr } from '../toast'
import AskRigsmith from '../reports/AskRigsmith'
import ReportViewer from '../reports/ReportViewer'
import ReportBuilder from '../reports/ReportBuilder'
import { SchedulesModal } from '../reports/Schedules'
import { lsGet, lsSet, type BuilderInit, type LibEntry } from '../reports/model'
import {
  IcChevron, IcClock, IcDash, IcPlus, IcSearch, IcStar, IcX,
} from '../reports/icons'
import '../reports/reports.css'

type LibTab = 'mine' | 'org' | 'system'

const CATEGORY_ORDER = ['Work orders', 'Equipment', 'Parts & inventory',
  'Purchasing', 'Labor', 'PM & compliance', 'Customers', 'Financial']
const DEFAULT_REF = 'sys:work-order-open-summary'

function entryName(e: LibEntry): string {
  return e.kind === 'system' ? e.sys.name : e.saved.name
}

export default function ReportsPage({ intent }: { intent?: NavIntent }) {
  const qc = useQueryClient()
  const libQ = useQuery({ queryKey: ['report-library'], queryFn: getReportLibrary })
  const srcQ = useQuery({
    queryKey: ['report-sources'], queryFn: getReportSources, staleTime: 10 * 60_000,
  })
  const lib = libQ.data
  const sources = srcQ.data

  const intentRef = typeof intent?.report === 'string' ? intent.report : null
  const [mode, setMode] = useState<'library' | 'builder'>(
    intent?.tab === 'builder' ? 'builder' : 'library')
  const [builderInit, setBuilderInit] = useState<BuilderInit>({ spec: null })
  const [builderSeq, setBuilderSeq] = useState(0)
  const [tab, setTab] = useState<LibTab>(() => lsGet<LibTab>('ft-rpt-tab', 'system'))
  const [q, setQ] = useState('')
  const [favOnly, setFavOnly] = useState(false)
  const [selected, setSelected] = useState<string | null>(
    () => intentRef ?? lsGet<string | null>('ft-rpt-last', null))
  const [pane, setPane] = useState<'list' | 'viewer'>(intentRef ? 'viewer' : 'list')
  const [closedCats, setClosedCats] = useState<string[]>([])
  const [schedOpen, setSchedOpen] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  const favorites = useMemo(() => new Set(lib?.favorites ?? []), [lib])

  const entries = useMemo<LibEntry[]>(() => [
    ...(lib?.system ?? []).map((s) => ({ kind: 'system' as const, ref: s.ref, sys: s })),
    ...(lib?.saved ?? []).map((s) => ({ kind: 'saved' as const, ref: s.ref, saved: s })),
  ], [lib])
  const byRef = useMemo(() => new Map(entries.map((e) => [e.ref, e])), [entries])
  const sysOrder = useMemo(
    () => new Map((lib?.system ?? []).map((s, i) => [s.ref, i])), [lib])

  const srcCategory = useMemo(() => {
    const m = new Map((sources?.sources ?? []).map((s) => [s.key, s.category]))
    return (key: string) => m.get(key) ?? 'Other'
  }, [sources])
  const nameOf = (ref: string) => {
    const e = byRef.get(ref)
    return e ? entryName(e) : ref.startsWith('sys:') ? ref.slice(4) : 'Report'
  }

  const counts = useMemo(() => ({
    mine: (lib?.saved ?? []).filter((s) => s.mine).length,
    org: (lib?.saved ?? []).filter((s) => s.visibility === 'org').length,
    system: (lib?.system ?? []).length,
  }), [lib])

  // Lista visible: pestaña + favoritos + búsqueda, agrupada por categoría.
  const groups = useMemo(() => {
    const s = q.trim().toLowerCase()
    const list = entries.filter((e) => {
      if (tab === 'system' && e.kind !== 'system') return false
      if (tab === 'mine' && !(e.kind === 'saved' && e.saved.mine)) return false
      if (tab === 'org' && !(e.kind === 'saved' && e.saved.visibility === 'org')) return false
      if (favOnly && !favorites.has(e.ref)) return false
      if (!s) return true
      const hay = e.kind === 'system'
        ? `${e.sys.name} ${e.sys.description} ${e.sys.category}`
        : `${e.saved.name} ${e.saved.description} ${srcCategory(e.saved.source)}`
      return hay.toLowerCase().includes(s)
    })
    const map = new Map<string, LibEntry[]>()
    for (const e of list) {
      const c = (e.kind === 'system' ? e.sys.category : srcCategory(e.saved.source)) || 'Other'
      if (!map.has(c)) map.set(c, [])
      map.get(c)!.push(e)
    }
    const cats = Array.from(map.keys()).sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a)
      const ib = CATEGORY_ORDER.indexOf(b)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b)
    })
    return cats.map((c) => ({
      cat: c,
      // Sistema: el orden curado de la biblioteca; guardados: alfabético.
      items: map.get(c)!.sort((a, b) => (a.kind === 'system' && b.kind === 'system'
        ? sysOrder.get(a.ref)! - sysOrder.get(b.ref)!
        : entryName(a).localeCompare(entryName(b)))),
    }))
  }, [entries, tab, favOnly, favorites, q, srcCategory, sysOrder])
  const visibleCount = groups.reduce((n, g) => n + g.items.length, 0)

  // Reporte elegido: el de la selección, o el primero razonable.
  const current: LibEntry | null = (selected && byRef.get(selected))
    || byRef.get(DEFAULT_REF) || entries[0] || null

  function select(ref: string) {
    setSelected(ref)
    setPane('viewer')
    lsSet('ft-rpt-last', ref)
    // Mobile: lista y viewer se alternan; se lleva el viewer a la vista.
    if (window.matchMedia?.('(max-width: 760px)').matches) {
      window.requestAnimationFrame(() => {
        document.querySelector('.rpv-pane')?.scrollIntoView({ block: 'start' })
      })
    }
  }
  function changeTab(t: LibTab) {
    setTab(t)
    lsSet('ft-rpt-tab', t)
  }

  async function toggleFav(ref: string) {
    const on = !favorites.has(ref)
    const prev = qc.getQueryData<ReportLibrary>(['report-library'])
    if (prev) {
      qc.setQueryData<ReportLibrary>(['report-library'], {
        ...prev,
        favorites: on ? [...prev.favorites, ref] : prev.favorites.filter((r) => r !== ref),
      })
    }
    try {
      const favs = await toggleFavorite(ref, on)
      const cur = qc.getQueryData<ReportLibrary>(['report-library'])
      if (cur) qc.setQueryData<ReportLibrary>(['report-library'], { ...cur, favorites: favs })
    } catch (e) {
      if (prev) qc.setQueryData(['report-library'], prev)
      notifyErr('Couldn’t update favorites', e)
    }
  }

  function openBuilder(init: BuilderInit) {
    setBuilderInit(init)
    setBuilderSeq((n) => n + 1)
    setMode('builder')
    window.scrollTo({ top: 0 })
  }

  function onAssistant(a: ReportAssistantAnswer, prompt: string) {
    if (!a.spec) return
    openBuilder({
      spec: a.spec, name: prompt.slice(0, 80), explanation: a.explanation,
      warnings: a.warnings, prompt,
    })
  }

  function afterSave(r: SavedReport) {
    qc.invalidateQueries({ queryKey: ['report-library'] })
    // El viewer del guardado vuelve a correr con la spec nueva.
    qc.invalidateQueries({ queryKey: ['report-run', r.ref] })
    setMode('library')
    changeTab(r.mine || r.visibility !== 'org' ? 'mine' : 'org')
    setFavOnly(false)
    setQ('')
    select(r.ref)
  }

  // ↑/↓ entre los ítems de la lista (los encabezados de categoría se saltan).
  function onListKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('.rpl-item') ?? [])
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    if (i < 0) return
    e.preventDefault()
    const j = e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)
    items[j]?.focus()
  }

  // ----- Builder -----
  if (mode === 'builder') {
    return (
      <div className="page page-wide rpx-page">
        {sources ? (
          <ReportBuilder key={builderSeq} init={builderInit} sources={sources}
            onCancel={() => setMode('library')} onSaved={afterSave} />
        ) : srcQ.error ? (
          <div className="banner error"><span>{(srcQ.error as Error).message}</span></div>
        ) : (
          <div className="rpx-skel"><Skeleton h={48} /><Skeleton h={420} /></div>
        )}
      </div>
    )
  }

  // ----- Biblioteca + viewer -----
  return (
    <div className="page page-wide rpx-page">
      <div className="page-head rpx-head">
        <div>
          <h1>Reports</h1>
          <p className="page-sub">
            {counts.system} ready-made reports, your saved reports, and an assistant
            that builds new ones from your shop’s data.
          </p>
        </div>
        <div className="head-actions">
          <Button variant="ghost" icon={<IcClock size={16} />}
            onClick={() => setSchedOpen(true)}>
            Scheduled
          </Button>
          <Button icon={<IcPlus size={16} />}
            onClick={() => openBuilder({ spec: null })}>
            New report
          </Button>
        </div>
      </div>

      <AskRigsmith onAnswer={onAssistant} variant="hero" />

      {libQ.error ? (
        <div className="banner error" role="alert">
          <span>Couldn’t load reports — {(libQ.error as Error).message}</span>
          <Button variant="ghost" size="sm" onClick={() => void libQ.refetch()}>Retry</Button>
        </div>
      ) : (
        <div className="rpx-layout" data-pane={pane}>
          {/* ---------------- Lista ---------------- */}
          <aside className="rpl" aria-label="Report library">
            <div className="rpl-tools">
              <div className="rpl-tabs" role="group" aria-label="Whose reports">
                {([['mine', 'Mine'], ['org', 'Org'], ['system', 'Rigsmith']] as [LibTab, string][]).map(([id, label]) => (
                  <button key={id} type="button" aria-pressed={tab === id}
                    className={tab === id ? 'is-on' : undefined}
                    onClick={() => changeTab(id)}>
                    {label}
                    {counts[id] > 0 && <span className="rpl-tab-n">{counts[id]}</span>}
                  </button>
                ))}
              </div>
              <label className="rpl-search">
                <IcSearch size={15} />
                <span className="sr-only">Search reports</span>
                <input value={q} placeholder="Search…" onChange={(e) => setQ(e.target.value)} />
                {q && (
                  <button type="button" aria-label="Clear search" onClick={() => setQ('')}>
                    <IcX size={13} />
                  </button>
                )}
              </label>
              <div className="rpl-favseg" role="group" aria-label="Show">
                <button type="button" aria-pressed={!favOnly}
                  className={!favOnly ? 'is-on' : undefined} onClick={() => setFavOnly(false)}>All</button>
                <button type="button" aria-pressed={favOnly}
                  className={favOnly ? 'is-on' : undefined} onClick={() => setFavOnly(true)}>
                  <IcStar size={13} on={favOnly} /> Favorites
                </button>
              </div>
            </div>

            <div className="rpl-body" ref={listRef} onKeyDown={onListKey}>
              {libQ.isPending ? (
                <div className="rpl-skel">
                  {Array.from({ length: 9 }, (_, i) => <Skeleton key={i} h={42} />)}
                </div>
              ) : visibleCount === 0 ? (
                <div className="rpl-empty">
                  {favOnly ? (
                    <p>No favorites here yet. Star a report with ★ to pin it.</p>
                  ) : q ? (
                    <p>No reports match “{q}”.</p>
                  ) : tab === 'mine' ? (
                    <>
                      <p><strong>No reports of your own yet.</strong></p>
                      <p>Build one, ask Rigsmith, or open a Rigsmith report and choose
                        <em> Save as mine</em>.</p>
                      <Button size="sm" icon={<IcPlus size={14} />}
                        onClick={() => openBuilder({ spec: null })}>New report</Button>
                    </>
                  ) : tab === 'org' ? (
                    <p>No shared reports yet. Save a report with <em>Organization</em> visibility
                      to share it with your team.</p>
                  ) : (
                    <p>No reports.</p>
                  )}
                </div>
              ) : groups.map((g) => {
                const closed = closedCats.includes(g.cat) && !q
                return (
                  <div key={g.cat} className="rpl-group">
                    <button type="button" className="rpl-cat" aria-expanded={!closed}
                      onClick={() => setClosedCats((cs) => (cs.includes(g.cat)
                        ? cs.filter((c) => c !== g.cat) : [...cs, g.cat]))}>
                      <IcChevron open={!closed} size={14} />
                      <span>{g.cat}</span>
                      <span className="rpl-cat-n">{g.items.length}</span>
                    </button>
                    {!closed && (
                      <ul className="rpl-list">
                        {g.items.map((e) => {
                          const sel = current?.ref === e.ref
                          const fav = favorites.has(e.ref)
                          const sys = e.kind === 'system' ? e.sys : null
                          const sv = e.kind === 'saved' ? e.saved : null
                          const nv = sys ? sys.versions.length : 1
                          return (
                            <li key={e.ref}>
                              <button type="button" className={`rpl-item${sel ? ' is-sel' : ''}`}
                                aria-current={sel ? 'true' : undefined}
                                onClick={() => select(e.ref)}>
                                <span className="rpl-main">
                                  <span className="rpl-name">
                                    {fav && <span className="rpl-fav" aria-label="Favorite"><IcStar on size={12} /></span>}
                                    <span className="rpl-name-t">{entryName(e)}</span>
                                  </span>
                                  <span className="rpl-ver">
                                    {sys ? (sys.default_version_label || 'Default')
                                      : sv?.visibility === 'org' ? (sv.mine ? 'Shared with org' : 'Organization') : 'Private'}
                                    {sys?.dashboard && (
                                      <span className="rpl-dash" title="Has a dashboard view">
                                        <IcDash size={11} /> Dashboard
                                      </span>
                                    )}
                                  </span>
                                </span>
                                <span className="rpl-vers">{nv} vers</span>
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                )
              })}
            </div>
          </aside>

          {/* ---------------- Viewer ---------------- */}
          <div className="rpv-pane">
            {libQ.isPending ? (
              <div className="rpv rpv-skel"><Skeleton h={40} /><Skeleton h={360} /></div>
            ) : current ? (
              <ReportViewer key={current.ref} entry={current}
                favorite={favorites.has(current.ref)}
                onToggleFavorite={() => void toggleFav(current.ref)}
                sources={sources} categoryOf={srcCategory} nameOf={nameOf}
                onOpenBuilder={openBuilder} onSaved={afterSave}
                onDeleted={() => { setSelected(null); setPane('list') }}
                onBack={() => {
                  setPane('list')
                  window.requestAnimationFrame(() => {
                    document.querySelector('.rpl')?.scrollIntoView({ block: 'start' })
                  })
                }} />
            ) : (
              <div className="rpv rpx-empty"><p>Pick a report from the list.</p></div>
            )}
          </div>
        </div>
      )}

      {schedOpen && (
        <SchedulesModal nameOf={nameOf}
          exists={(ref) => !lib || byRef.has(ref)}
          versionsOf={(ref) => {
            const e = byRef.get(ref)
            return e?.kind === 'system' ? e.sys.versions : []
          }}
          onClose={() => setSchedOpen(false)} />
      )}
    </div>
  )
}
