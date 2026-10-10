// Viewer de un reporte (v2.22 [G]), estilo SquareRigger y un paso más:
// título + ★ + ⓘ, versión, "Save as mine", Data | Charts (| Dashboard para
// los tableros heredados), menú ⋮ (PDF, CSV, XLSX, email programado, builder),
// filtros por columna (chips), Σ fila de totales, selector de columnas
// (mostrar/ocultar/reordenar), "N of N rows", orden por encabezado y tabla
// virtualizada. Filtros/orden/columnas son de la VISTA (del lado del
// cliente, instantáneos); "Save as mine" los convierte en spec.
import { useMemo, useRef, useState, type RefObject } from 'react'
import {
  keepPreviousData, useQuery, useQueryClient,
} from '@tanstack/react-query'
import {
  deleteSavedReport, exportReport, listSchedules, runReport,
  type ReportOverrides, type ReportRun, type ReportRunColumn,
  type ReportSchedule, type ReportSources, type SavedReport,
} from '../api'
import { Button } from '../components/ds'
import Skeleton from '../components/Skeleton'
import { MenuList, Popover } from '../components/ShellPopover'
import { notifyErr, notifyOk } from '../toast'
import {
  applyColPrefs, applyViewFilters, cellText, computeTotals, describeViewFilter,
  enumLabel, exportCsvLocal, exportXlsxLocal, fileSlug, fmtDate, isAggSpec,
  lsGet, lsSet, mergeConds, nosumFields, sortRows, splitViewFilters,
  stripNosum, viewOpsFor, viewToSpec, DATE_OP_LABEL,
  VIEW_OP_LABEL,
  type BuilderInit, type ColPrefs, type LibEntry, type ViewFilter, type ViewOp,
  type ViewSort,
} from './model'
import {
  IcBack, IcChart, IcColumns, IcCopy, IcDash, IcDown, IcDownload, IcEdit,
  IcFilter, IcInfo, IcMail, IcMore, IcPrint, IcSigma, IcStar, IcTable,
  IcTrash, IcUp, IcX,
} from './icons'
import ReportTable from './ReportTable'
import ReportCharts from './ReportCharts'
import ReportPrint from './ReportPrint'
import SaveReportModal from './SaveReportModal'
import ScheduleModal from './Schedules'
import {
  CpmDashboard, DriverComplianceSection, PmComplianceSection, SpendDashboard,
} from './LegacyDashboards'

type ViewMode = 'data' | 'charts' | 'dashboard'

const DASH_LABEL: Record<string, string> = {
  spend: 'Spend dashboard', cpm: 'Cost per mile dashboard',
  pm_compliance: 'PM compliance dashboard',
  driver_compliance: 'Driver compliance dashboard',
}

export interface ReportViewerProps {
  entry: LibEntry
  favorite: boolean
  onToggleFavorite: () => void
  sources?: ReportSources
  categoryOf: (source: string) => string
  nameOf: (ref: string) => string
  onOpenBuilder: (init: BuilderInit) => void
  onSaved: (r: SavedReport) => void
  onDeleted: () => void
  onBack?: () => void
}

// ---------------------------------------------------------------------------
// Popover "Add filter"
// ---------------------------------------------------------------------------
function AddFilter({ columns, rows, onAdd, onClose, anchor }: {
  columns: ReportRunColumn[]
  rows: ReportRun['rows']
  onAdd: (f: ViewFilter) => void
  onClose: () => void
  anchor: RefObject<HTMLButtonElement | null>
}) {
  const [key, setKey] = useState(columns[0]?.key ?? '')
  const col = columns.find((c) => c.key === key) ?? columns[0]
  const ops = col ? viewOpsFor(col) : []
  const [op, setOp] = useState<ViewOp>(ops[0] ?? 'eq')
  const [v1, setV1] = useState('')
  const [v2, setV2] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const isDate = col?.type === 'date' || col?.type === 'datetime'
  const isNum = col?.type === 'money' || col?.type === 'number'

  // Valores presentes (para listas de opciones).
  const distinct = useMemo(() => {
    if (!col) return []
    const m = new Map<string, string>()
    for (const r of rows) {
      const v = r[col.key]
      if (v == null || v === '') continue
      const k = String(v)
      if (!m.has(k)) m.set(k, enumLabel(col, v) ?? cellText(col, v))
      if (m.size > 200) break
    }
    return Array.from(m.entries()).sort((a, b) => a[1].localeCompare(b[1]))
  }, [col, rows])

  function changeCol(k: string) {
    setKey(k)
    const c = columns.find((x) => x.key === k)
    setOp(c ? viewOpsFor(c)[0] : 'eq')
    setV1(''); setV2(''); setPicked([])
  }

  const needsNone = op === 'empty' || op === 'not_empty' || op === 'yes' || op === 'no'
  const usesList = !!col && (op === 'in' || (col.enum && op === 'ne'))
    && distinct.length > 0 && distinct.length <= 60
  const ready = needsNone
    || (usesList ? picked.length > 0
      : op === 'between' ? v1 !== '' && v2 !== '' : v1.trim() !== '')

  function apply() {
    if (!col || !ready) return
    let value: string | string[] | undefined
    if (needsNone) value = undefined
    else if (usesList) value = picked
    else if (op === 'between') value = [v1, v2]
    else if (op === 'in') value = v1.split(',').map((x) => x.trim()).filter(Boolean)
    else value = v1.trim()
    onAdd({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, key: col.key, op, value })
    onClose()
  }

  const inputType = isDate ? 'date' : isNum ? 'number' : 'text'
  const listId = `rpv-dl-${key}`

  return (
    <Popover anchor={anchor} placement="bottom-start" onClose={onClose}
      className="rs-menu rpv-pop rpv-addf" role="dialog" label="Add filter">
      <form onSubmit={(e) => { e.preventDefault(); apply() }}>
        <div className="rpv-pop-h">Add filter</div>
        <label className="ud-field">
          <span>Column</span>
          <select className="cell-input" value={key} autoFocus
            onChange={(e) => changeCol(e.target.value)}>
            {columns.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>
        <label className="ud-field">
          <span>Condition</span>
          <select className="cell-input" value={op}
            onChange={(e) => { setOp(e.target.value as ViewOp); setPicked([]) }}>
            {ops.map((o) => (
              <option key={o} value={o}>{(isDate && DATE_OP_LABEL[o]) || VIEW_OP_LABEL[o]}</option>
            ))}
          </select>
        </label>
        {!needsNone && (usesList ? (
          <fieldset className="rpv-picklist">
            <legend className="sr-only">Values</legend>
            {distinct.map(([val, lbl]) => (
              <label key={val} className="rpv-pick">
                <input type="checkbox" checked={picked.includes(val)}
                  onChange={(e) => setPicked((p) => e.target.checked
                    ? [...p, val] : p.filter((x) => x !== val))} />
                <span>{lbl}</span>
              </label>
            ))}
          </fieldset>
        ) : op === 'between' ? (
          <div className="rpv-between">
            <input className="cell-input" type={inputType} value={v1}
              aria-label="From" onChange={(e) => setV1(e.target.value)} />
            <span>and</span>
            <input className="cell-input" type={inputType} value={v2}
              aria-label="To" onChange={(e) => setV2(e.target.value)} />
          </div>
        ) : (
          <label className="ud-field">
            <span>Value</span>
            <input className="cell-input" type={inputType} value={v1}
              list={inputType === 'text' ? listId : undefined}
              placeholder={op === 'in' ? 'Comma-separated values' : ''}
              onChange={(e) => setV1(e.target.value)} />
            {inputType === 'text' && (
              <datalist id={listId}>
                {distinct.slice(0, 100).map(([val, lbl]) => <option key={val} value={lbl} />)}
              </datalist>
            )}
          </label>
        ))}
        <div className="rpv-pop-actions">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" type="submit" disabled={!ready}>Apply</Button>
        </div>
      </form>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// Popover de columnas (mostrar / ocultar / reordenar)
// ---------------------------------------------------------------------------
function ColumnsPicker({ all, prefs, onChange, onClose, anchor }: {
  all: ReportRunColumn[]
  prefs: ColPrefs
  onChange: (p: ColPrefs) => void
  onClose: () => void
  anchor: RefObject<HTMLButtonElement | null>
}) {
  const ordered = applyColPrefs(all, { ...prefs, hidden: [] })
  const keys = ordered.map((c) => c.key)
  function move(k: string, d: -1 | 1) {
    const i = keys.indexOf(k)
    const j = i + d
    if (j < 0 || j >= keys.length) return
    const next = [...keys]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange({ ...prefs, order: next })
  }
  function toggle(k: string, show: boolean) {
    const hidden = show ? prefs.hidden.filter((x) => x !== k) : [...prefs.hidden, k]
    if (hidden.length >= all.length) return     // al menos una visible
    onChange({ ...prefs, hidden })
  }
  return (
    <Popover anchor={anchor} placement="bottom-end" onClose={onClose}
      className="rs-menu rpv-pop rpv-cols" role="dialog" label="Columns">
      <div className="rpv-pop-h">
        Columns
        <span>{all.length - prefs.hidden.length} of {all.length} shown</span>
      </div>
      <ul className="rpv-collist">
        {ordered.map((c, i) => {
          const shown = !prefs.hidden.includes(c.key)
          return (
            <li key={c.key} className={shown ? undefined : 'is-off'}>
              <label>
                <input type="checkbox" checked={shown}
                  onChange={(e) => toggle(c.key, e.target.checked)} />
                <span>{c.label}</span>
              </label>
              <button type="button" className="rpx-icon-btn sm" disabled={i === 0}
                aria-label={`Move ${c.label} up`} onClick={() => move(c.key, -1)}>
                <IcUp size={14} />
              </button>
              <button type="button" className="rpx-icon-btn sm" disabled={i === ordered.length - 1}
                aria-label={`Move ${c.label} down`} onClick={() => move(c.key, 1)}>
                <IcDown size={14} />
              </button>
            </li>
          )
        })}
      </ul>
      <div className="rpv-pop-actions">
        <button type="button" className="link-btn"
          onClick={() => onChange({ hidden: [], order: [] })}>Reset</button>
      </div>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------
export default function ReportViewer({
  entry, favorite, onToggleFavorite, sources, categoryOf, nameOf,
  onOpenBuilder, onSaved, onDeleted, onBack,
}: ReportViewerProps) {
  const qc = useQueryClient()
  const sys = entry.kind === 'system' ? entry.sys : null
  const saved = entry.kind === 'saved' ? entry.saved : null
  const ref = entry.ref
  const name = sys?.name ?? saved?.name ?? 'Report'
  const versions = sys?.versions ?? []
  const [version, setVersion] = useState(sys?.default_version ?? '')
  const [mode, setMode] = useState<ViewMode>(sys?.dashboard ? 'dashboard' : 'data')
  const [filters, setFilters] = useState<ViewFilter[]>([])
  const [sort, setSort] = useState<ViewSort | null>(null)
  const [totalsPref, setTotalsPref] = useState<boolean | null>(null)
  const [prefs, setPrefsState] = useState<ColPrefs>(
    () => lsGet<ColPrefs>(`ft-rpt-cols:${ref}`, { hidden: [], order: [] }))
  const [pop, setPop] = useState<null | 'info' | 'menu' | 'filter' | 'cols'>(null)
  const [printing, setPrinting] = useState(false)
  const [saveOpen, setSaveOpen] = useState<null | 'copy' | 'details'>(null)
  const [schedOpen, setSchedOpen] = useState(false)
  const infoRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLButtonElement | null>(null)
  const filterRef = useRef<HTMLButtonElement | null>(null)
  const colsRef = useRef<HTMLButtonElement | null>(null)

  function setPrefs(p: ColPrefs) {
    setPrefsState(p)
    lsSet(`ft-rpt-cols:${ref}`, p.hidden.length || p.order.length ? p : null)
  }

  const runQ = useQuery({
    queryKey: ['report-run', ref, version],
    queryFn: ({ signal }) => runReport({ ref, ...(version ? { version } : {}) }, signal),
    placeholderData: keepPreviousData,
    enabled: mode !== 'dashboard',
    staleTime: 30_000,
    retry: false,
  })
  // Corrida BASE del reporte (la spec, la copia y el builder salen de acá).
  const baseRun = runQ.data
  const stale = runQ.isPlaceholderData

  const src = sources?.sources.find((s) => s.key === (baseRun?.source ?? sys?.source ?? saved?.source))
  const nosum = useMemo(() => nosumFields(src), [src])
  const allCols = useMemo(() => baseRun?.columns ?? [], [baseRun])

  // Resultado RECORTADO (truncated): ordenar / filtrar del lado del cliente
  // solo vería las primeras N filas. En ese caso el orden y los filtros
  // traducibles se mandan al server como overrides (mismo /run) y solo los
  // intraducibles (sobre métricas…) quedan locales.
  const serverView = useMemo(() => {
    if (!baseRun?.truncated || (!filters.length && !sort)) return null
    const { conds, rest } = splitViewFilters(filters, allCols, baseRun.rows)
    const merged = conds.length ? mergeConds(baseRun.spec.filters, conds) : null
    if (conds.length && !merged) return null
    const overrides: ReportOverrides = {
      ...(merged ? { filters: merged } : {}),
      ...(sort ? { sort: [{ field: sort.key, dir: sort.dir }] } : {}),
    }
    return { overrides, rest: merged ? rest : filters }
  }, [baseRun, filters, sort, allCols])
  const viewQ = useQuery({
    queryKey: ['report-run', ref, version, 'view', JSON.stringify(serverView?.overrides ?? null)],
    queryFn: ({ signal }) => runReport({
      ref, ...(version ? { version } : {}), overrides: serverView!.overrides,
    }, signal),
    enabled: !!serverView && mode !== 'dashboard',
    staleTime: 30_000,
    retry: false,
  })
  // Lo que se muestra: la corrida del server con la vista aplicada si ya
  // llegó; mientras tanto, la base filtrada localmente (atenuada).
  const onServer = !!serverView && !!viewQ.data
  const run = onServer ? viewQ.data : baseRun
  const localFilters = onServer ? serverView!.rest : filters
  const refining = !!serverView && !viewQ.data && viewQ.isFetching

  const visCols = useMemo(() => {
    const v = applyColPrefs(allCols, prefs)
    return v.length ? v : allCols
  }, [allCols, prefs])
  const filtered = useMemo(
    () => (run ? applyViewFilters(run.rows, localFilters, allCols) : []),
    [run, localFilters, allCols])
  const rows = useMemo(() => sortRows(filtered, sort), [filtered, sort])
  const isAgg = allCols.some((c) => !!c.agg)
  const showTotals = totalsPref ?? !!run?.spec.totals
  // Totales: los del motor (sobre TODAS las filas que matchean, aun si la
  // tabla está recortada) cuando no hay filtros locales; si no, la suma de
  // lo que se ve.
  const totalsAll = !!run?.totals && !localFilters.length
  const totals = useMemo(() => {
    if (!run) return null
    const local = computeTotals(filtered, allCols, nosum)
    if (totalsAll && run.totals) {
      return stripNosum({ ...local, ...run.totals }, allCols, nosum)
    }
    return local
  }, [run, filtered, allCols, nosum, totalsAll])

  const modified = filters.length > 0 || !!sort || prefs.hidden.length > 0
    || prefs.order.length > 0
  const versionLabel = versions.find((v) => v.key === version)?.label
    ?? run?.report?.version_label ?? ''
  const timeLabel = run?.time
    ? `${run.time.label}${run.time.from ? ` · ${fmtDate(run.time.from)}${run.time.to && run.time.to !== run.time.from ? ` – ${fmtDate(run.time.to)}` : ''}` : ''}`
    : ''
  const subtitle = [versionLabel, run?.time?.label !== versionLabel ? run?.time?.label : '']
    .filter(Boolean).join(' · ')

  const kindLabel = sys
    ? 'Rigsmith report'
    : saved?.mine
      ? (saved.visibility === 'org' ? 'My report · Shared with org' : 'My report · Private')
      : 'Organization report'
  const category = sys?.category ?? categoryOf(saved?.source ?? '')

  async function ensureRun(): Promise<ReportRun> {
    // Siempre la corrida BASE: la de la vista trae los filtros ya sumados.
    if (baseRun && !stale) return baseRun
    return qc.fetchQuery({
      queryKey: ['report-run', ref, version],
      queryFn: () => runReport({ ref, ...(version ? { version } : {}) }),
    })
  }

  async function doExport(fmt: 'csv' | 'xlsx') {
    setPop(null)
    try {
      if (!modified || !run) {
        await exportReport({ ref, ...(version ? { version } : {}), format: fmt }, fileSlug(name))
        notifyOk(fmt === 'csv' ? 'CSV downloaded' : 'Excel file downloaded')
      } else if (serverView && !serverView.rest.length && !prefs.hidden.length
        && !prefs.order.length) {
        // Recortado + vista traducible: exportar del server con la vista
        // aplicada (no solo las primeras filas que trajo el viewer).
        await exportReport({
          ref, ...(version ? { version } : {}), overrides: serverView.overrides,
          format: fmt,
        }, fileSlug(name))
        notifyOk(fmt === 'csv' ? 'CSV downloaded' : 'Excel file downloaded')
      } else if (fmt === 'csv') {
        exportCsvLocal(name, visCols, rows, showTotals ? totals : null)
        notifyOk('CSV downloaded', `${rows.length.toLocaleString('en-US')} rows as shown`)
      } else {
        await exportXlsxLocal(name, [subtitle, ...filters.map((f) =>
          describeViewFilter(f, allCols.find((c) => c.key === f.key)))].filter(Boolean).join(' · '),
        visCols, rows, showTotals ? totals : null)
        notifyOk('Excel file downloaded', `${rows.length.toLocaleString('en-US')} rows as shown`)
      }
    } catch (e) {
      notifyErr('Couldn’t export the report', e)
    }
  }

  async function editInBuilder() {
    setPop(null)
    try {
      const r = await ensureRun()
      onOpenBuilder({
        spec: r.spec,
        name: saved?.name ?? name,
        description: saved?.description ?? sys?.description ?? '',
        visibility: saved?.visibility ?? 'mine',
        savedId: saved?.can_edit ? saved.id : null,
        basedOn: sys ? ref : saved?.based_on || ref,
      })
    } catch (e) {
      notifyErr('Couldn’t open the builder', e)
    }
  }

  async function removeSaved() {
    setPop(null)
    if (!saved) return
    // Los envíos programados de este reporte se borran con él (cascada en el
    // server, report_saved.delete_saved): acá solo se avisa cuántos son.
    const scheds = await listSchedules(ref).catch(() => [] as ReportSchedule[])
    const n = scheds.length
    const also = n ? ` Its ${n} scheduled email${n === 1 ? '' : 's'} will be deleted too.` : ''
    if (!window.confirm(`Delete “${saved.name}”?${also} This can’t be undone.`)) return
    try {
      await deleteSavedReport(saved.id)
    } catch (e) {
      notifyErr('Couldn’t delete the report', e)
      return
    }
    qc.invalidateQueries({ queryKey: ['report-library'] })
    qc.invalidateQueries({ queryKey: ['report-schedules'] })
    notifyOk('Report deleted', n ? `${n} scheduled email${n === 1 ? '' : 's'} removed` : undefined)
    onDeleted()
  }

  // La copia sale de la spec BASE (la corrida de la vista ya trae los
  // filtros sumados) con la vista traducida.
  const copy = useMemo(() => {
    if (!baseRun) return null
    return viewToSpec(baseRun.spec, {
      columns: visCols, allColumns: allCols, filters, sort, rows: baseRun.rows,
    })
  }, [baseRun, visCols, allCols, filters, sort])

  const ownSaved = !!saved?.can_edit
  const dashLabel = sys?.dashboard ? DASH_LABEL[sys.dashboard] ?? 'Dashboard' : ''

  return (
    <section className="rpv" aria-labelledby="rpv-title">
      <header className="rpv-head">
        {onBack && (
          <button type="button" className="rx-back rpv-back" onClick={onBack}>
            <IcBack size={16} /> Reports
          </button>
        )}
        <div className="rpv-titlebox">
          <div className="rpv-titlerow">
            <h2 id="rpv-title">{name}</h2>
            <button type="button" className={`rpx-icon-btn rpv-star${favorite ? ' is-on' : ''}`}
              aria-pressed={favorite}
              aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'}
              title={favorite ? 'Remove from favorites' : 'Add to favorites'}
              onClick={onToggleFavorite}>
              <IcStar on={favorite} />
            </button>
            <button type="button" ref={infoRef} className="rpx-icon-btn"
              aria-label="About this report" aria-expanded={pop === 'info'}
              onClick={() => setPop(pop === 'info' ? null : 'info')}>
              <IcInfo size={17} />
            </button>
          </div>
          <span className="rpv-kind">
            {kindLabel}{category ? ` · ${category}` : ''}
            {timeLabel && mode !== 'dashboard' && <span className="rpv-time">{timeLabel}</span>}
          </span>
        </div>
        <div className="rpv-actions">
          {mode !== 'dashboard' && versions.length > 1 && (
            <label className="rpv-version">
              <span className="sr-only">Version</span>
              <select className="cell-input" value={version}
                onChange={(e) => {
                  // Otra versión puede traer otras columnas: filtros y orden
                  // de la vista se reinician.
                  setVersion(e.target.value)
                  setFilters([])
                  setSort(null)
                }}>
                {versions.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
              </select>
            </label>
          )}
          {ownSaved ? (
            <Button variant="ghost" size="sm" icon={<IcEdit size={14} />}
              onClick={() => void editInBuilder()}>Edit</Button>
          ) : (
            <Button variant="ghost" size="sm" icon={<IcCopy size={14} />}
              disabled={mode !== 'dashboard' && !run}
              onClick={() => {
                ensureRun().then(() => setSaveOpen('copy'))
                  .catch((e) => notifyErr('Couldn’t load the report', e))
              }}>
              Save as mine
            </Button>
          )}
          <div className="rpx-seg rpv-modes" role="group" aria-label="View">
            <button type="button" aria-pressed={mode === 'data'}
              className={mode === 'data' ? 'is-on' : undefined}
              onClick={() => setMode('data')} title="Data" aria-label="Data">
              <IcTable size={15} /><span>Data</span>
            </button>
            <button type="button" aria-pressed={mode === 'charts'}
              className={mode === 'charts' ? 'is-on' : undefined}
              onClick={() => setMode('charts')} title="Charts" aria-label="Charts">
              <IcChart size={15} /><span>Charts</span>
            </button>
            {sys?.dashboard && (
              <button type="button" aria-pressed={mode === 'dashboard'}
                className={mode === 'dashboard' ? 'is-on' : undefined}
                onClick={() => setMode('dashboard')} title={dashLabel} aria-label="Dashboard">
                <IcDash size={15} /><span>Dashboard</span>
              </button>
            )}
          </div>
          <button type="button" ref={menuRef} className="rpx-icon-btn rpv-more"
            aria-label="More actions" aria-haspopup="menu" aria-expanded={pop === 'menu'}
            onClick={() => setPop(pop === 'menu' ? null : 'menu')}>
            <IcMore size={18} />
          </button>
        </div>
      </header>

      {mode !== 'dashboard' && (
        <div className="rpv-tools">
          <button type="button" ref={filterRef}
            className={`rpv-tool${filters.length ? ' is-on' : ''}`}
            aria-expanded={pop === 'filter'} disabled={!run || !allCols.length}
            onClick={() => setPop(pop === 'filter' ? null : 'filter')}>
            <IcFilter size={15} /> Filters
            {filters.length > 0 && <span className="rpv-n">{filters.length}</span>}
          </button>
          {filters.length > 0 && (
            <ul className="rpv-chips" aria-label="Active filters">
              {filters.map((f) => {
                const col = allCols.find((c) => c.key === f.key)
                const text = describeViewFilter(f, col)
                return (
                  <li key={f.id} className="rpv-chip">
                    <span>{text}</span>
                    <button type="button" aria-label={`Remove filter: ${text}`}
                      onClick={() => setFilters((fs) => fs.filter((x) => x.id !== f.id))}>
                      <IcX size={13} />
                    </button>
                  </li>
                )
              })}
              <li>
                <button type="button" className="link-btn rpv-clear"
                  onClick={() => setFilters([])}>Clear</button>
              </li>
            </ul>
          )}
          <span className="rpv-spacer" />
          {run && (
            <span className="rpv-count" aria-live="polite">
              <strong>{rows.length.toLocaleString('en-US')}</strong>
              {' of '}{run.row_count.toLocaleString('en-US')} rows
              {run.truncated && (
                <span className="rpv-capped" title={`The report matched ${run.total_count.toLocaleString('en-US')} rows; the first ${run.row_count.toLocaleString('en-US')} are shown.${showTotals ? (totalsAll ? ` Totals cover all ${run.total_count.toLocaleString('en-US')} matching rows.` : ' Totals cover the rows shown.') : ''}`}>
                  {' '}· capped
                </span>
              )}
              {onServer && (
                <span className="rpv-capped" title="The report has more rows than the viewer loads, so this sort and these filters ran on the server over every matching row.">
                  {' '}· sorted & filtered on server
                </span>
              )}
              {refining && <span className="rpv-capped"> · refining…</span>}
            </span>
          )}
          <button type="button" className={`rpx-icon-btn${showTotals ? ' is-on' : ''}`}
            aria-pressed={showTotals} title="Show totals row" aria-label="Show totals row"
            disabled={!run} onClick={() => setTotalsPref(!showTotals)}>
            <IcSigma size={16} />
          </button>
          <button type="button" ref={colsRef} className={`rpx-icon-btn${prefs.hidden.length ? ' is-on' : ''}`}
            aria-expanded={pop === 'cols'} title="Columns" aria-label="Columns"
            disabled={!allCols.length} onClick={() => setPop(pop === 'cols' ? null : 'cols')}>
            <IcColumns size={16} />
          </button>
        </div>
      )}

      {mode !== 'dashboard' && run && (run.warnings.length > 0 || run.pii_masked) && (
        <div className="rpv-notes">
          {run.warnings.map((w) => <p key={w} className="rpv-warn">{w}</p>)}
          {run.pii_masked && (
            <p className="rpv-muted">Contact details are hidden — viewing them needs contact-info permission.</p>
          )}
        </div>
      )}

      <div className="rpv-body">
        {mode === 'dashboard' && sys?.dashboard ? (
          sys.dashboard === 'spend' ? <SpendDashboard />
            : sys.dashboard === 'cpm' ? <CpmDashboard />
              : sys.dashboard === 'pm_compliance' ? <PmComplianceSection />
                : <DriverComplianceSection />
        ) : runQ.isPending ? (
          <div className="rpv-skel" aria-busy="true" aria-label="Loading report">
            <Skeleton h={34} />
            {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} h={28} />)}
          </div>
        ) : runQ.error && !run ? (
          <div className="rpx-empty">
            <h3>Couldn’t run this report</h3>
            <p>{(runQ.error as Error).message}</p>
            <Button variant="ghost" size="sm" onClick={() => void runQ.refetch()}>Try again</Button>
          </div>
        ) : run && run.row_count === 0 && !onServer ? (
          <div className="rpx-empty">
            <IcTable size={34} />
            <h3>No rows for this {run.time ? 'period' : 'report'}</h3>
            <p>{run.time ? 'Try another version (date range) above, or open it in the builder to change filters.'
              : 'Nothing matches this report yet.'}</p>
          </div>
        ) : run && mode === 'charts' ? (
          <div className={stale ? 'is-stale' : undefined}>
            <ReportCharts columns={visCols} rows={rows} totals={totals}
              nosum={nosum} chart={run.chart} isAgg={isAgg} />
          </div>
        ) : run ? (
          rows.length === 0 ? (
            <div className="rpx-empty">
              <IcFilter size={30} />
              <h3>No rows match these filters</h3>
              <Button variant="ghost" size="sm" onClick={() => setFilters([])}>Clear filters</Button>
            </div>
          ) : (
            <ReportTable columns={visCols} rows={rows} widthRows={run.rows}
              sort={sort} onSort={setSort} totals={totals} showTotals={showTotals}
              label={name} dim={stale} maxHeight="max(340px, calc(100vh - 330px))" />
          )
        ) : null}
      </div>

      {pop === 'info' && (
        <Popover anchor={infoRef} placement="bottom-start" onClose={() => setPop(null)}
          className="rs-menu rpv-pop rpv-info" role="dialog" label="About this report">
          <div className="rpv-pop-h">{name}</div>
          <p>{sys?.description || saved?.description || 'No description.'}</p>
          {sys?.info && <p className="rpv-info-note">{sys.info}</p>}
          {src && (
            <p className="rpv-info-src">
              <strong>Data source:</strong> {src.label} — {src.description}
            </p>
          )}
          {saved?.based_on && (
            <p className="rpv-info-src"><strong>Based on:</strong> {nameOf(saved.based_on)}</p>
          )}
        </Popover>
      )}

      {pop === 'menu' && (
        <Popover anchor={menuRef} placement="bottom-end" onClose={() => setPop(null)}
          className="rs-menu">
          <MenuList label="Report actions" onClose={() => setPop(null)}>
            <button type="button" role="menuitem" className="rs-menu-item"
              disabled={mode === 'dashboard' || !run}
              onClick={() => { setPop(null); setPrinting(true) }}>
              <span className="rs-mi-ico"><IcPrint /></span>
              <span className="rs-mi-label">Export PDF</span>
            </button>
            <button type="button" role="menuitem" className="rs-menu-item"
              onClick={() => void doExport('csv')}>
              <span className="rs-mi-ico"><IcDownload /></span>
              <span className="rs-mi-label">Download CSV</span>
            </button>
            <button type="button" role="menuitem" className="rs-menu-item"
              onClick={() => void doExport('xlsx')}>
              <span className="rs-mi-ico"><IcDownload /></span>
              <span className="rs-mi-label">Download Excel (.xlsx)</span>
            </button>
            <div className="rs-menu-sep" role="separator" />
            <button type="button" role="menuitem" className="rs-menu-item"
              onClick={() => { setPop(null); setSchedOpen(true) }}>
              <span className="rs-mi-ico"><IcMail /></span>
              <span className="rs-mi-label">Schedule email…</span>
            </button>
            <button type="button" role="menuitem" className="rs-menu-item"
              onClick={() => void editInBuilder()}>
              <span className="rs-mi-ico"><IcEdit /></span>
              <span className="rs-mi-label">{ownSaved ? 'Edit in builder' : 'Customize in builder'}</span>
            </button>
            {ownSaved && (
              <>
                <button type="button" role="menuitem" className="rs-menu-item"
                  onClick={() => { setPop(null); setSaveOpen('details') }}>
                  <span className="rs-mi-ico"><IcInfo /></span>
                  <span className="rs-mi-label">Name &amp; sharing…</span>
                </button>
                <div className="rs-menu-sep" role="separator" />
                <button type="button" role="menuitem" className="rs-menu-item is-danger"
                  onClick={() => void removeSaved()}>
                  <span className="rs-mi-ico"><IcTrash /></span>
                  <span className="rs-mi-label">Delete report</span>
                </button>
              </>
            )}
            {modified && mode !== 'dashboard' && (
              <p className="rs-menu-note">Downloads and PDF use the filters, sort and columns you see.</p>
            )}
          </MenuList>
        </Popover>
      )}

      {pop === 'filter' && run && (
        <AddFilter columns={visCols.length ? visCols : allCols} rows={run.rows}
          anchor={filterRef} onClose={() => setPop(null)}
          onAdd={(f) => setFilters((fs) => [...fs, f])} />
      )}
      {pop === 'cols' && (
        <ColumnsPicker all={allCols} prefs={prefs} onChange={setPrefs}
          anchor={colsRef} onClose={() => setPop(null)} />
      )}

      {printing && run && (
        <ReportPrint title={name} subtitle={subtitle}
          chips={[timeLabel, ...filters.map((f) => describeViewFilter(f, allCols.find((c) => c.key === f.key)))].filter(Boolean)}
          columns={visCols} rows={rows} totals={showTotals ? totals : null}
          withChart={mode === 'charts'} chart={run.chart} nosum={nosum} isAgg={isAgg}
          onClose={() => setPrinting(false)} />
      )}

      {saveOpen === 'copy' && copy && (
        <SaveReportModal title={saved ? 'Save a copy' : 'Save as mine'}
          initial={{ name, description: sys?.description ?? saved?.description ?? '', visibility: 'mine' }}
          spec={copy.spec}
          basedOn={ref}
          note={copy && copy.skipped
            ? `${copy.skipped} filter${copy.skipped === 1 ? '' : 's'} (on summary columns or formatted text) stay in this view only.`
            : !modified ? undefined
              : isAggSpec(copy?.spec ?? { source: '', columns: [] })
                ? 'Your filters and sort are saved with it (summary reports keep all their columns).'
                : 'Your filters, sort and visible columns are saved with it.'}
          onClose={() => setSaveOpen(null)}
          onSaved={(r) => {
            setSaveOpen(null)
            qc.invalidateQueries({ queryKey: ['report-library'] })
            onSaved(r)
          }} />
      )}
      {saveOpen === 'details' && saved && (
        <SaveReportModal savedId={saved.id}
          initial={{ name: saved.name, description: saved.description, visibility: saved.visibility }}
          onClose={() => setSaveOpen(null)}
          onSaved={(r) => {
            setSaveOpen(null)
            qc.invalidateQueries({ queryKey: ['report-library'] })
            onSaved(r)
          }} />
      )}
      {schedOpen && (
        <ScheduleModal reportRef={ref} reportName={name} version={version}
          versions={versions} onClose={() => setSchedOpen(false)} />
      )}
    </section>
  )
}
