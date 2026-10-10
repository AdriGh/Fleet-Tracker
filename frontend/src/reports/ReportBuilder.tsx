// Report Builder (v2.22 [G]), estilo SquareRigger + "Ask Rigsmith": panel
// izquierdo con Primary data source ("One row per …"), Columns (+ Add column:
// lista buscable con íconos de tipo, multi-selección y resumen por columna),
// Filters (rango de tiempo por preset, Match All/Any, + Add filter, + Add
// group de UN nivel), Group & summarize, Sort, Totals y Chart; a la derecha
// la vista previa en vivo (debounce, "N rows · ran in X ms"), tabla/gráfico,
// badge Draft, Cancel (con "Discard unsaved changes?") y Save report. La spec
// que se arma es exactamente la ReportSpec del motor (core/report_engine).
import { useEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  isCondGroup, runReport,
  type ReportAgg, type ReportAssistantAnswer, type ReportColumnSpec,
  type ReportCond, type ReportCondGroup, type ReportField, type ReportOp,
  type ReportPreset, type ReportRunColumn, type ReportSource,
  type ReportSources, type ReportSpec, type SavedReport,
} from '../api'
import Modal from '../components/Modal'
import { Button } from '../components/ds'
import {
  AGG_LABEL, DATE_OP, OP_LABEL, PRESET_LABEL, TYPE_NAME, aggsFor, blankSpec,
  fieldMap, isAggSpec, isNumericCol, isSnapshotSource, normalizeSpec,
  nosumFields, opsFor, outKey, runnableSpec, sameJson, sortAfterUnsummarize,
  specProblem, withGroupColumns,
  stripNosum, type BuilderInit,
} from './model'
import {
  IcAi, IcChart, IcDown, IcPlus, IcSearch, IcTable, IcUp, IcX, TypeIcon,
} from './icons'
import { Section, Seg, Switch } from './ui'
import AskRigsmith from './AskRigsmith'
import ReportTable from './ReportTable'
import ReportCharts from './ReportCharts'
import SaveReportModal from './SaveReportModal'

const PRESET_ORDER: ReportPreset[] = ['today', 'yesterday', 'this_week',
  'prev_week', 'mtd', 'prev_month', 'last_30d', 'last_90d', 'qtd', 'ytd',
  'last_12m', 'all', 'custom']

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return v
}

function dedupeBy<T>(list: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>()
  return list.filter((x) => {
    const k = key(x)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function withDefaults(spec: ReportSpec): ReportSpec {
  // Un group_by con dimensiones que no son columnas (asistente) se vuelve
  // columnas visibles: el builder agrupa por sus columnas.
  return withGroupColumns({
    ...spec,
    columns: spec.columns ?? [],
    filters: spec.filters ?? { match: 'all', items: [] },
    sort: spec.sort ?? [],
  })
}

// Etiqueta automática de una columna resumida cuando la del motor quedaría
// redundante ("Total Total cost" -> "Total cost"). undefined = la del motor.
function autoLabel(agg: ReportAgg | null | undefined, f?: ReportField): string | undefined {
  if (!agg || !f) return undefined
  const word = AGG_LABEL[agg].toLowerCase()
  return f.label.toLowerCase().startsWith(`${word} `) ? f.label : undefined
}

// Cambia la agregación de una columna sin pisar un nombre puesto a mano.
function withAgg(c: ReportColumnSpec, agg: ReportAgg | null, f?: ReportField): ReportColumnSpec {
  const auto = !c.label || c.label === autoLabel(c.agg, f)
  const label = auto ? autoLabel(agg, f) : c.label
  return { field: c.field, ...(agg ? { agg } : {}), ...(label ? { label } : {}) }
}

// Campo para "contar filas": id si existe; si no, el primero.
function countField(src: ReportSource): string {
  return src.fields.find((f) => f.name === 'id')?.name
    ?? src.fields.find((f) => /(^|_)id$/.test(f.name))?.name
    ?? src.fields[0]?.name ?? 'id'
}

function outCols(spec: ReportSpec, src?: ReportSource): ReportRunColumn[] {
  const fm = fieldMap(src)
  return spec.columns.map((c) => {
    const f = fm.get(c.field)
    const type = c.agg === 'count' || c.agg === 'count_distinct' ? 'number'
      : c.agg === 'avg' && f?.type !== 'money' ? 'number' : f?.type ?? 'text'
    const label = c.label || (c.agg
      ? (c.agg === 'count' ? 'Count' : `${AGG_LABEL[c.agg]} ${f?.label ?? c.field}`)
      : f?.label ?? c.field)
    return { key: outKey(c), label, type, field: c.field, agg: c.agg ?? null, enum: c.agg ? undefined : f?.enum }
  })
}

// ---------------------------------------------------------------------------
// Lista buscable de campos (+ Add column)
// ---------------------------------------------------------------------------
function FieldPicker({ src, chosen, onToggle, onClose }: {
  src: ReportSource
  chosen: Set<string>
  onToggle: (f: ReportField, on: boolean) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const ref = useRef<HTMLInputElement | null>(null)
  useEffect(() => { ref.current?.focus() }, [])
  const s = q.trim().toLowerCase()
  const list = s
    ? src.fields.filter((f) => f.label.toLowerCase().includes(s)
      || f.name.includes(s) || f.desc.toLowerCase().includes(s))
    : src.fields
  return (
    <div className="rpb-picker" role="dialog" aria-label="Add columns"
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      }}>
      <div className="rpb-picker-search">
        <IcSearch size={15} />
        <input ref={ref} className="rpb-picker-input" value={q}
          placeholder="Search fields…" aria-label="Search fields"
          onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="rpb-picker-h">Fields</div>
      <ul className="rpb-picker-list">
        {list.map((f) => {
          const on = chosen.has(f.name)
          return (
            <li key={f.name}>
              <label className={on ? 'is-on' : undefined} title={f.desc || undefined}>
                <input type="checkbox" checked={on}
                  onChange={(e) => onToggle(f, e.target.checked)} />
                <TypeIcon type={f.type} />
                <span className="rpb-pf-main">
                  <span className="rpb-pf-lbl">
                    {f.label}
                    {f.pii && <span className="rpb-pii" title="Contact info — hidden without permission">PII</span>}
                  </span>
                  {f.desc && <span className="rpb-pf-desc">{f.desc}</span>}
                </span>
                <span className="sr-only">{TYPE_NAME[f.type]}</span>
              </label>
            </li>
          )
        })}
        {list.length === 0 && <li className="rpb-picker-none">No fields match “{q}”.</li>}
      </ul>
      <div className="rpb-picker-foot">
        <span>Showing {list.length} of {src.fields.length} fields</span>
        <Button size="sm" variant="ghost" onClick={onClose}>Done</Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Editor de valor de una condición
// ---------------------------------------------------------------------------
function ValueEditor({ f, op, value, onChange }: {
  f: ReportField
  op: ReportOp
  value: unknown
  onChange: (v: unknown) => void
}) {
  if (op === 'empty' || op === 'not_empty') return null
  if (f.type === 'bool') {
    return (
      <select className="cell-input" aria-label="Value"
        value={value === false || value === 'false' ? 'false' : 'true'}
        onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    )
  }
  if (f.enum && (op === 'in' || op === 'not_in')) {
    const arr = Array.isArray(value) ? value.map(String) : []
    return (
      <fieldset className="rpb-enum">
        <legend className="sr-only">{f.label} values</legend>
        {f.enum.map((o) => (
          <label key={o.value}>
            <input type="checkbox" checked={arr.includes(o.value)}
              onChange={(e) => onChange(e.target.checked
                ? [...arr, o.value] : arr.filter((x) => x !== o.value))} />
            {o.label}
          </label>
        ))}
      </fieldset>
    )
  }
  if (f.enum) {
    return (
      <select className="cell-input" aria-label="Value" value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}>
        <option value="" disabled>Choose…</option>
        {f.enum.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    )
  }
  const type = f.type === 'date' || f.type === 'datetime' ? 'date'
    : isNumericCol(f) ? 'number' : 'text'
  if (op === 'between') {
    const arr = Array.isArray(value) ? value : ['', '']
    return (
      <div className="rpb-between">
        <input className="cell-input" type={type} aria-label="From"
          value={String(arr[0] ?? '')}
          onChange={(e) => onChange([e.target.value, arr[1] ?? ''])} />
        <span>and</span>
        <input className="cell-input" type={type} aria-label="To"
          value={String(arr[1] ?? '')}
          onChange={(e) => onChange([arr[0] ?? '', e.target.value])} />
      </div>
    )
  }
  if (op === 'in' || op === 'not_in') {
    return <InListInput value={value} onChange={onChange} />
  }
  return (
    <input className="cell-input" type={type} aria-label="Value"
      value={value == null ? '' : String(value)}
      step={type === 'number' ? 'any' : undefined}
      onChange={(e) => onChange(e.target.value)} />
  )
}

// Lista separada por comas: el texto crudo vive en estado local (se puede
// escribir "a, " sin que la coma desaparezca) y la spec recibe el array.
function InListInput({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(
    () => (Array.isArray(value) ? value.join(', ') : String(value ?? '')))
  return (
    <input className="cell-input" aria-label="Values (comma-separated)"
      placeholder="Value 1, value 2…" value={text}
      onChange={(e) => {
        setText(e.target.value)
        onChange(e.target.value.split(',').map((x) => x.trim()).filter(Boolean))
      }} />
  )
}

function defaultValue(f: ReportField, op: ReportOp): unknown {
  if (op === 'empty' || op === 'not_empty') return undefined
  if (f.type === 'bool') return true
  if (op === 'in' || op === 'not_in') return []
  if (op === 'between') return ['', '']
  return ''
}

function CondRow({ cond, src, onChange, onRemove }: {
  cond: ReportCond
  src: ReportSource
  onChange: (c: ReportCond) => void
  onRemove: () => void
}) {
  const f = src.fields.find((x) => x.name === cond.field) ?? src.fields[0]
  const ops = opsFor(f)
  const isDate = f.type === 'date' || f.type === 'datetime'
  return (
    <div className="rpb-cond">
      <div className="rpb-cond-top">
        <select className="cell-input" aria-label="Field" value={f.name}
          onChange={(e) => {
            const nf = src.fields.find((x) => x.name === e.target.value)!
            const op = opsFor(nf)[0]
            onChange({ field: nf.name, op, value: defaultValue(nf, op) })
          }}>
          {src.fields.map((x) => <option key={x.name} value={x.name}>{x.label}</option>)}
        </select>
        <select className="cell-input rpb-op" aria-label="Condition" value={cond.op}
          onChange={(e) => {
            const op = e.target.value as ReportOp
            const keep = (op === 'between') === (cond.op === 'between')
              && (op === 'in' || op === 'not_in') === (cond.op === 'in' || cond.op === 'not_in')
            onChange({ ...cond, op, value: keep ? cond.value : defaultValue(f, op) })
          }}>
          {ops.map((o) => (
            <option key={o} value={o}>{(isDate && DATE_OP[o]) || OP_LABEL[o]}</option>
          ))}
        </select>
        <button type="button" className="rpx-icon-btn sm" aria-label="Remove filter"
          onClick={onRemove}><IcX size={14} /></button>
      </div>
      <ValueEditor key={`${f.name}:${cond.op}`} f={f} op={cond.op} value={cond.value}
        onChange={(v) => onChange({ ...cond, value: v })} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------
export interface ReportBuilderProps {
  init: BuilderInit
  sources: ReportSources
  onCancel: () => void
  onSaved: (r: SavedReport) => void
}

type SecKey = 'source' | 'columns' | 'filters' | 'group' | 'sort' | 'totals' | 'chart'

export default function ReportBuilder({ init, sources, onCancel, onSaved }: ReportBuilderProps) {
  const firstSrc = sources.sources.find((s) => s.key === init.spec?.source)
    ?? sources.sources.find((s) => s.key === 'work_orders') ?? sources.sources[0]
  const [initial] = useState<ReportSpec>(() => (init.spec ? withDefaults(init.spec) : blankSpec(firstSrc)))
  const [spec, setSpec] = useState<ReportSpec>(initial)
  const [name, setName] = useState(init.name ?? '')
  const [ai, setAi] = useState<{ explanation: string; warnings: string[]; prompt: string } | null>(
    init.explanation || init.warnings?.length
      ? { explanation: init.explanation ?? '', warnings: init.warnings ?? [], prompt: init.prompt ?? '' }
      : null)
  const [open, setOpen] = useState<Record<SecKey, boolean>>({
    source: true, columns: true, filters: true, group: isAggSpec(initial),
    sort: !!initial.sort?.length, totals: false, chart: !!initial.chart,
  })
  const [picking, setPicking] = useState(false)
  const [preview, setPreview] = useState<'table' | 'chart'>(
    initial.chart && initial.chart.type !== 'none' ? 'chart' : 'table')
  const [confirm, setConfirm] = useState<null | 'cancel' | 'source'>(null)
  const [pendingSource, setPendingSource] = useState<string | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [editLabel, setEditLabel] = useState<string | null>(null)

  const src = sources.sources.find((s) => s.key === spec.source) ?? firstSrc
  const fm = useMemo(() => fieldMap(src), [src])
  const agg = isAggSpec(spec)
  const outs = useMemo(() => outCols(spec, src), [spec, src])
  const problem = specProblem(spec, src)
  const runSpec = useMemo(() => runnableSpec(spec), [spec])
  const runKey = problem ? '' : JSON.stringify(runSpec)
  const debKey = useDebounced(runKey, 450)

  const previewQ = useQuery({
    queryKey: ['report-preview', debKey],
    queryFn: ({ signal }) => runReport({ spec: JSON.parse(debKey) as ReportSpec }, signal),
    enabled: !!debKey,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 60_000,
  })
  const run = debKey ? previewQ.data : undefined
  const running = !!runKey && (previewQ.isFetching || runKey !== debKey)
  const nosum = useMemo(() => nosumFields(src), [src])
  const runTotals = run ? stripNosum(run.totals, run.columns, nosum) : null

  const dirty = !sameJson(runnableSpec(initial), runSpec) || name !== (init.name ?? '')
  const isDraft = init.savedId == null || dirty

  function requestCancel() {
    if (dirty || (init.savedId == null && spec.columns.length)) setConfirm('cancel')
    else onCancel()
  }

  function patch(p: Partial<ReportSpec>) {
    setSpec((s) => {
      const next = { ...s, ...p }
      // Resumen -> detalle (toggle o columna por columna): un orden por una
      // métrica ("sum_amount") vuelve a su campo; si no, el preview y el Save
      // fallaban con "unknown field … in sort" sin que se viera por qué.
      if (p.columns && !p.sort) next.sort = sortAfterUnsummarize(s, next)
      return normalizeSpec(next)
    })
  }
  function toggleSec(k: SecKey) {
    setOpen((o) => ({ ...o, [k]: !o[k] }))
  }

  // ----- Fuente -----
  function changeSource(key: string) {
    if (key === spec.source) return
    if (spec.columns.length || spec.filters?.items.length) {
      setPendingSource(key)
      setConfirm('source')
      return
    }
    applySource(key)
  }
  function applySource(key: string) {
    const ns = sources.sources.find((s) => s.key === key)
    if (!ns) return
    setSpec(blankSpec(ns))
    setPicking(true)
    setOpen((o) => ({ ...o, columns: true }))
  }

  // ----- Columnas -----
  const plainChosen = useMemo(
    () => new Set(spec.columns.filter((c) => !c.agg).map((c) => c.field)), [spec.columns])
  function toggleField(f: ReportField, on: boolean) {
    if (on) {
      if (spec.columns.length >= sources.limits.max_columns) return
      const col: ReportColumnSpec = agg && isNumericCol(f) && !nosum.has(f.name)
        ? withAgg({ field: f.name }, 'sum', f) : { field: f.name }
      patch({ columns: [...spec.columns, col] })
    } else {
      patch({ columns: spec.columns.filter((c) => c.agg || c.field !== f.name) })
    }
  }
  function setCol(i: number, c: ReportColumnSpec) {
    const cols = [...spec.columns]
    cols[i] = c
    patch({ columns: cols })
  }
  function moveCol(i: number, d: -1 | 1) {
    const j = i + d
    if (j < 0 || j >= spec.columns.length) return
    const cols = [...spec.columns]
    ;[cols[i], cols[j]] = [cols[j], cols[i]]
    patch({ columns: cols })
  }
  function removeCol(i: number) {
    patch({ columns: spec.columns.filter((_, k) => k !== i) })
  }

  // ----- Filtros -----
  const items = spec.filters?.items ?? []
  function setItems(next: (ReportCond | ReportCondGroup)[], match = spec.filters?.match ?? 'all') {
    patch({ filters: { match, items: next } })
  }
  function newCond(): ReportCond {
    const f = src.fields.find((x) => x.enum) ?? src.fields[0]
    const op = opsFor(f)[0]
    return { field: f.name, op, value: defaultValue(f, op) }
  }

  // ----- Agrupar -----
  function setSummarize(on: boolean) {
    if (on) {
      const cols = spec.columns.some((c) => c.agg)
        ? spec.columns
        : [...spec.columns.filter((c) => !isNumericCol(fm.get(c.field) ?? { type: 'text' })
            || nosum.has(c.field)),
          ...spec.columns.filter((c) => {
            const f = fm.get(c.field)
            return f && isNumericCol(f) && !nosum.has(c.field)
          }).map((c) => withAgg(c, 'sum', fm.get(c.field))),
          { field: countField(src), agg: 'count' as ReportAgg }]
      patch({ columns: dedupeBy(cols, outKey) })
      setOpen((o) => ({ ...o, group: true }))
    } else {
      patch({
        columns: dedupeBy(spec.columns.map((c) => withAgg(c, null, fm.get(c.field))),
          (c) => c.field),
        group_by: [],
      })
    }
  }

  // ----- Asistente -----
  function onAssistant(a: ReportAssistantAnswer, prompt: string) {
    if (!a.spec) return
    setSpec(withDefaults(a.spec))
    setAi({ explanation: a.explanation, warnings: a.warnings ?? [], prompt })
    if (!name) setName(prompt.slice(0, 80))
    setPreview(a.spec.chart && a.spec.chart.type !== 'none' ? 'chart' : 'table')
    setOpen((o) => ({ ...o, group: isAggSpec(a.spec!), sort: !!a.spec?.sort?.length }))
    if (isNarrow()) window.requestAnimationFrame(showPreview)
  }

  // ----- Orden: opciones -----
  const sortOptions = agg
    ? outs.map((c) => ({ key: c.key, label: c.label }))
    : src.fields.map((f) => ({ key: f.name, label: f.label }))
  const xOpts = outs.filter((c) => !isNumericCol(c))
  const yOpts = outs.filter((c) => isNumericCol(c))
  const chart = spec.chart ?? null
  const timeLabel = spec.time
    ? `${src.fields.find((f) => f.name === spec.time!.field)?.label ?? spec.time.field}: ${PRESET_LABEL[spec.time.preset]}`
    : 'No date filter'

  // Mobile: la vista previa queda DEBAJO del panel; tras una respuesta del
  // asistente (o con el botón de la barra) se la trae a la vista.
  const previewRef = useRef<HTMLElement | null>(null)
  function showPreview() {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    previewRef.current?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })
  }
  function isNarrow() {
    return !!window.matchMedia?.('(max-width: 760px)').matches
  }
  useEffect(() => {
    if (init.explanation && isNarrow()) window.requestAnimationFrame(showPreview)
    // Solo al abrir el builder con una respuesta del asistente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const tableSort = spec.sort?.[0] && outs.some((c) => c.key === spec.sort![0].field)
    ? { key: spec.sort[0].field, dir: spec.sort[0].dir } : null

  return (
    <div className="rpb">
      <AskRigsmith spec={spec.columns.length ? runSpec : null} onAnswer={onAssistant} variant="compact" />

      {/* Mobile: Cancel / Save arriba (la vista previa queda debajo del panel). */}
      <div className="rpb-mbar">
        <Button variant="ghost" size="sm" onClick={requestCancel}>Cancel</Button>
        <span className="rpb-mbar-t">{name || 'Untitled report'}</span>
        <button type="button" className="rpb-mbar-prev" onClick={showPreview}>
          Preview{run && !problem ? ` · ${run.row_count.toLocaleString('en-US')}` : ''}
        </button>
        <Button size="sm" disabled={!!problem} onClick={() => setSaveOpen(true)}>Save</Button>
      </div>

      <div className="rpb-grid">
        {/* ---------------- Panel izquierdo ---------------- */}
        <aside className="rpb-panel" aria-label="Report setup">
          <div className="rpb-panel-h">
            <h2>Report Builder</h2>
            <span className="rpb-beta">Beta</span>
          </div>
          <div className="rpb-panel-body">
            <Section title="Primary data source" open={open.source} onToggle={() => toggleSec('source')}>
              <label className="ud-field">
                <span className="sr-only">Data source</span>
                <select className="cell-input rpb-source" value={spec.source}
                  onChange={(e) => changeSource(e.target.value)}>
                  {Array.from(new Set(sources.sources.map((s) => s.category))).map((cat) => (
                    <optgroup key={cat} label={cat}>
                      {sources.sources.filter((s) => s.category === cat).map((s) => (
                        <option key={s.key} value={s.key}>{s.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <p className="rpb-src-desc">
                {src.description}
                {src.kind === 'computed' && (
                  <span className="rpb-src-kind" title="Calculated by Rigsmith when the report runs (same numbers as the app screens)">
                    Calculated
                  </span>
                )}
              </p>
            </Section>

            <Section title="Columns" count={spec.columns.length} open={open.columns}
              onToggle={() => toggleSec('columns')}>
              {spec.columns.length === 0 && !picking && (
                <p className="rpb-hint">No columns yet</p>
              )}
              <ul className="rpb-cols">
                {spec.columns.map((c, i) => {
                  const f = fm.get(c.field)
                  const key = outKey(c)
                  const o = outs[i]
                  return (
                    <li key={key} className="rpb-col">
                      <div className="rpb-col-top">
                        {f && <TypeIcon type={c.agg === 'count' || c.agg === 'count_distinct' ? 'number' : f.type} />}
                        {editLabel === key ? (
                          <input className="cell-input rpb-col-input" autoFocus
                            defaultValue={c.label ?? ''} placeholder={o?.label}
                            aria-label="Column label"
                            onBlur={(e) => { setCol(i, { ...c, label: e.target.value.trim() || null }); setEditLabel(null) }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                              if (e.key === 'Escape') { e.stopPropagation(); setEditLabel(null) }
                            }} />
                        ) : (
                          <button type="button" className="rpb-col-lbl" title="Rename column"
                            onClick={() => setEditLabel(key)}>
                            {o?.label ?? c.field}
                          </button>
                        )}
                        <button type="button" className="rpx-icon-btn sm" disabled={i === 0}
                          aria-label={`Move ${o?.label} up`} onClick={() => moveCol(i, -1)}>
                          <IcUp size={13} />
                        </button>
                        <button type="button" className="rpx-icon-btn sm"
                          disabled={i === spec.columns.length - 1}
                          aria-label={`Move ${o?.label} down`} onClick={() => moveCol(i, 1)}>
                          <IcDown size={13} />
                        </button>
                        <button type="button" className="rpx-icon-btn sm"
                          aria-label={`Remove ${o?.label}`} onClick={() => removeCol(i)}>
                          <IcX size={13} />
                        </button>
                      </div>
                      {f && agg && (
                        <label className="rpb-col-agg">
                          <span>Summary</span>
                          <select className="cell-input" value={c.agg ?? ''}
                            onChange={(e) => setCol(i, withAgg(c, (e.target.value || null) as ReportAgg | null, f))}>
                            <option value="">Group by this</option>
                            {aggsFor(f.type).map((a) => <option key={a} value={a}>{AGG_LABEL[a]}</option>)}
                          </select>
                        </label>
                      )}
                    </li>
                  )
                })}
              </ul>
              {picking ? (
                <FieldPicker src={src} chosen={plainChosen} onToggle={toggleField}
                  onClose={() => setPicking(false)} />
              ) : (
                <div className="rpb-addrow">
                  <button type="button" className="rpb-add" onClick={() => setPicking(true)}>
                    <IcPlus size={15} /> Add column
                  </button>
                  <button type="button" className="rpb-add is-quiet"
                    onClick={() => patch({ columns: [...spec.columns.filter((c) => outKey(c) !== `count_${countField(src)}`), { field: countField(src), agg: 'count' }] })}>
                    <IcPlus size={15} /> Count rows
                  </button>
                </div>
              )}
            </Section>

            <Section title="Filters" count={items.length + (spec.time && spec.time.preset !== 'all' ? 1 : 0)}
              open={open.filters} onToggle={() => toggleSec('filters')}>
              <div className="rpb-time">
                <div className="rpb-time-h">{src.time_is_period ? 'Period' : 'Time range'}</div>
                <div className="rpb-time-row">
                  <select className="cell-input" aria-label="Date field"
                    value={spec.time?.field ?? ''}
                    onChange={(e) => patch({ time: e.target.value
                      ? { field: e.target.value, preset: spec.time?.preset ?? 'last_90d' } : null })}>
                    {!src.time_is_period && <option value="">Date field…</option>}
                    {src.time_fields.map((tf) => (
                      <option key={tf} value={tf}>{fm.get(tf)?.label ?? tf}</option>
                    ))}
                  </select>
                  {spec.time && (
                    <select className="cell-input" aria-label="Date range"
                      value={spec.time.preset}
                      onChange={(e) => patch({ time: { ...spec.time!, preset: e.target.value as ReportPreset } })}>
                      {PRESET_ORDER.filter((p) => !(src.time_is_period && p === 'all')).map((p) => (
                        <option key={p} value={p}>{PRESET_LABEL[p]}</option>
                      ))}
                    </select>
                  )}
                </div>
                {spec.time?.preset === 'custom' && (
                  <div className="rpb-between">
                    <input className="cell-input" type="date" aria-label="From"
                      value={spec.time.from ?? ''}
                      onChange={(e) => patch({ time: { ...spec.time!, from: e.target.value || null } })} />
                    <span>to</span>
                    <input className="cell-input" type="date" aria-label="To"
                      value={spec.time.to ?? ''}
                      onChange={(e) => patch({ time: { ...spec.time!, to: e.target.value || null } })} />
                  </div>
                )}
                {(!spec.time || spec.time.preset === 'all') && !src.time_is_period
                  && !isSnapshotSource(src) && (
                  <div className="rpb-nodate">
                    <strong>No date filter</strong>
                    This report may be slow to run. Results are capped at{' '}
                    {(spec.limit ?? sources.limits.default_rows).toLocaleString('en-US')} rows per query.
                  </div>
                )}
              </div>

              <div className="rpb-match">
                <span>Match</span>
                <Seg size="sm" label="Match" value={spec.filters?.match ?? 'all'}
                  options={[{ id: 'all', label: 'All' }, { id: 'any', label: 'Any' }]}
                  onChange={(m) => setItems(items, m)} />
                <span>of the following</span>
              </div>

              <div className="rpb-conds">
                {items.map((it, i) => (isCondGroup(it) ? (
                  <div key={i} className="rpb-group">
                    <div className="rpb-match">
                      <span>Group · match</span>
                      <Seg size="sm" label="Group match" value={it.match}
                        options={[{ id: 'all', label: 'All' }, { id: 'any', label: 'Any' }]}
                        onChange={(m) => setItems(items.map((x, k) => (k === i ? { ...it, match: m } : x)))} />
                      <button type="button" className="rpx-icon-btn sm rpb-group-x"
                        aria-label="Remove group"
                        onClick={() => setItems(items.filter((_, k) => k !== i))}>
                        <IcX size={14} />
                      </button>
                    </div>
                    {it.items.map((c, j) => (
                      <CondRow key={j} cond={c} src={src}
                        onChange={(nc) => setItems(items.map((x, k) => (k === i
                          ? { ...it, items: it.items.map((y, l) => (l === j ? nc : y)) } : x)))}
                        onRemove={() => setItems(items.map((x, k) => (k === i
                          ? { ...it, items: it.items.filter((_, l) => l !== j) } : x))
                          .filter((x) => !isCondGroup(x) || x.items.length > 0))} />
                    ))}
                    <button type="button" className="rpb-add is-quiet"
                      onClick={() => setItems(items.map((x, k) => (k === i
                        ? { ...it, items: [...it.items, newCond()] } : x)))}>
                      <IcPlus size={14} /> Add condition
                    </button>
                  </div>
                ) : (
                  <CondRow key={i} cond={it} src={src}
                    onChange={(nc) => setItems(items.map((x, k) => (k === i ? nc : x)))}
                    onRemove={() => setItems(items.filter((_, k) => k !== i))} />
                )))}
              </div>
              <div className="rpb-addrow">
                <button type="button" className="rpb-add" onClick={() => setItems([...items, newCond()])}>
                  <IcPlus size={15} /> Add filter
                </button>
                <button type="button" className="rpb-add is-quiet"
                  onClick={() => setItems([...items, { match: 'any', items: [newCond(), newCond()] }])}>
                  <IcPlus size={15} /> Add group
                </button>
              </div>
            </Section>

            <Section title="Group & summarize" open={open.group} onToggle={() => toggleSec('group')}
              aside={agg ? <span className="rpb-on">On</span> : undefined}>
              <Switch checked={agg} onChange={setSummarize}
                label="Group rows and calculate totals" />
              <p className="rpb-hint">
                {agg
                  ? 'Rows are grouped by every column without a summary. Columns with a summary (Total, Average, Count…) are calculated per group.'
                  : 'Turn on to group rows (by unit, vendor, month…) and add counts and totals.'}
              </p>
              {agg && (
                <div className="rpb-groupinfo">
                  <div>
                    <span className="rpb-mini-h">Grouped by</span>
                    <div className="rpb-tags">
                      {spec.columns.filter((c) => !c.agg).map((c) => (
                        <span key={c.field} className="rpb-tag">{fm.get(c.field)?.label ?? c.field}</span>
                      ))}
                      {!spec.columns.some((c) => !c.agg) && <span className="rpb-hint">One row (grand total)</span>}
                    </div>
                  </div>
                  <div>
                    <span className="rpb-mini-h">Metrics</span>
                    <div className="rpb-tags">
                      {outs.filter((c) => c.agg).map((c) => (
                        <span key={c.key} className="rpb-tag is-metric">{c.label}</span>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </Section>

            <Section title="Sort" count={spec.sort?.length} open={open.sort} onToggle={() => toggleSec('sort')}>
              {(spec.sort ?? []).map((s, i) => (
                <div key={i} className="rpb-sort">
                  <select className="cell-input" aria-label="Sort by" value={s.field}
                    onChange={(e) => patch({ sort: spec.sort!.map((x, k) => (k === i ? { ...x, field: e.target.value } : x)) })}>
                    {sortOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                  </select>
                  <Seg size="sm" label="Direction" value={s.dir}
                    options={[{ id: 'asc', label: 'A→Z', title: 'Ascending' }, { id: 'desc', label: 'Z→A', title: 'Descending' }]}
                    onChange={(d) => patch({ sort: spec.sort!.map((x, k) => (k === i ? { ...x, dir: d } : x)) })} />
                  <button type="button" className="rpx-icon-btn sm" aria-label="Remove sort"
                    onClick={() => patch({ sort: spec.sort!.filter((_, k) => k !== i) })}>
                    <IcX size={14} />
                  </button>
                </div>
              ))}
              <button type="button" className="rpb-add" disabled={!sortOptions.length}
                onClick={() => patch({ sort: [...(spec.sort ?? []), { field: sortOptions[0].key, dir: 'desc' }] })}>
                <IcPlus size={15} /> Add sort
              </button>
            </Section>

            <Section title="Totals" open={open.totals} onToggle={() => toggleSec('totals')}
              aside={spec.totals ? <span className="rpb-on">On</span> : undefined}>
              <Switch checked={!!spec.totals} onChange={(v) => patch({ totals: v })}
                label="Show a totals row" />
              <label className="ud-field rpb-limit">
                <span>Row limit</span>
                <input className="cell-input" type="number" min={1}
                  max={sources.limits.max_rows}
                  value={spec.limit ?? sources.limits.default_rows}
                  onChange={(e) => {
                    const n = Math.round(Number(e.target.value))
                    patch({ limit: Number.isFinite(n) && n > 0
                      ? Math.min(n, sources.limits.max_rows) : undefined })
                  }} />
                <span className="field-hint">Up to {sources.limits.max_rows.toLocaleString('en-US')} rows.</span>
              </label>
            </Section>

            <Section title="Chart" open={open.chart} onToggle={() => toggleSec('chart')}
              aside={chart && chart.type !== 'none' ? <span className="rpb-on">{chart.type}</span> : undefined}>
              <Seg size="sm" label="Chart type" value={chart?.type ?? 'none'}
                options={[{ id: 'none', label: 'None' }, { id: 'bar', label: 'Bars' },
                  { id: 'line', label: 'Line' }, { id: 'donut', label: 'Donut' },
                  { id: 'kpi', label: 'KPI' }]}
                onChange={(t) => {
                  if (t === 'none') { patch({ chart: null }); return }
                  patch({ chart: { type: t, x: chart?.x ?? xOpts[0]?.key ?? null,
                    y: chart?.y?.length ? chart.y : (yOpts[0] ? [yOpts[0].key] : []) } })
                  setPreview('chart')
                }} />
              {chart && chart.type !== 'none' && chart.type !== 'kpi' && (
                <div className="rpb-chart-sel">
                  <label className="ud-field">
                    <span>Categories (X)</span>
                    <select className="cell-input" value={chart.x ?? ''}
                      onChange={(e) => patch({ chart: { ...chart, x: e.target.value } })}>
                      {xOpts.length === 0 && <option value="">Add a text or date column</option>}
                      {xOpts.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                    </select>
                  </label>
                  <label className="ud-field">
                    <span>Values (Y)</span>
                    <select className="cell-input" value={chart.y?.[0] ?? ''}
                      onChange={(e) => patch({ chart: { ...chart, y: [e.target.value] } })}>
                      {yOpts.length === 0 && <option value="">Add a number column</option>}
                      {yOpts.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                    </select>
                  </label>
                </div>
              )}
              {chart?.type === 'kpi' && (
                <fieldset className="rpb-enum">
                  <legend className="rpb-mini-h">KPI tiles</legend>
                  {yOpts.map((c) => (
                    <label key={c.key}>
                      <input type="checkbox" checked={chart.y?.includes(c.key) ?? false}
                        onChange={(e) => patch({ chart: { ...chart, y: e.target.checked
                          ? [...(chart.y ?? []), c.key] : (chart.y ?? []).filter((k) => k !== c.key) } })} />
                      {c.label}
                    </label>
                  ))}
                  {yOpts.length === 0 && <span className="rpb-hint">Add a number column first.</span>}
                </fieldset>
              )}
            </Section>
          </div>
          <div className="rpb-panel-foot">
            <span>Preview updates as you build</span>
            <button type="button" className="link-btn" disabled={!dirty}
              onClick={() => { setSpec(initial); setName(init.name ?? '') }}>Reset</button>
          </div>
        </aside>

        {/* ---------------- Vista previa ---------------- */}
        <section className="rpb-preview" aria-label="Preview" ref={previewRef}>
          <header className="rpb-prev-h">
            <input className="rpb-name" value={name} maxLength={160}
              placeholder="Untitled report" aria-label="Report name"
              onChange={(e) => setName(e.target.value)} />
            <div className="rpb-prev-ctrls">
              {isDraft && <span className="rpb-draft">Draft</span>}
              <div className="rpx-seg" role="group" aria-label="Preview as">
                <button type="button" aria-pressed={preview === 'table'} title="Table"
                  className={preview === 'table' ? 'is-on' : undefined}
                  onClick={() => setPreview('table')}>
                  <IcTable size={15} /><span className="sr-only">Table</span>
                </button>
                <button type="button" aria-pressed={preview === 'chart'} title="Chart"
                  className={preview === 'chart' ? 'is-on' : undefined}
                  onClick={() => setPreview('chart')}>
                  <IcChart size={15} /><span className="sr-only">Chart</span>
                </button>
              </div>
              <Button variant="ghost" size="sm" className="rpb-prev-act" onClick={requestCancel}>
                Cancel
              </Button>
              <Button size="sm" className="rpb-prev-act" disabled={!!problem}
                onClick={() => setSaveOpen(true)}>
                Save report
              </Button>
            </div>
          </header>
          <div className="rpb-prev-chips">
            <span className="rpb-chip">{src.label}</span>
            <span className="rpb-chip">{timeLabel}</span>
            {items.length > 0 && <span className="rpb-chip">{items.length} filter{items.length === 1 ? '' : 's'}</span>}
            <span className="rpv-spacer" />
            <span className="rpb-runinfo" aria-live="polite">
              {running ? 'Running…'
                : run ? `${run.row_count.toLocaleString('en-US')}${run.truncated ? '+' : ''} row${run.row_count === 1 ? '' : 's'} · ran in ${run.ms < 1000 ? `${run.ms} ms` : `${(run.ms / 1000).toFixed(1)} s`}`
                  : ''}
            </span>
          </div>

          {ai && (
            <div className="rpb-ai" role="status">
              <span className="ask-glyph"><IcAi size={15} /></span>
              <div>
                {ai.prompt && <span className="rpb-ai-q">“{ai.prompt}”</span>}
                {ai.explanation && <p>{ai.explanation}</p>}
                {ai.warnings.length > 0 && (
                  <ul>{ai.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
                )}
              </div>
              <button type="button" className="rpx-icon-btn sm" aria-label="Dismiss"
                onClick={() => setAi(null)}><IcX size={14} /></button>
            </div>
          )}

          {run && run.warnings.length > 0 && (
            <div className="rpv-notes">{run.warnings.map((w) => <p key={w} className="rpv-warn">{w}</p>)}</div>
          )}

          <div className="rpb-prev-body">
            {problem ? (
              <div className="rpb-empty">{problem}</div>
            ) : previewQ.error && !running ? (
              <div className="banner error" role="alert">
                <span>{(previewQ.error as Error).message}</span>
              </div>
            ) : !run ? (
              <div className="rpb-empty">Running the preview…</div>
            ) : run.row_count === 0 ? (
              <div className="rpb-empty">No rows match — widen the date range or remove a filter.</div>
            ) : preview === 'chart' ? (
              <div className={running ? 'is-stale' : undefined}>
                <ReportCharts columns={run.columns} rows={run.rows} totals={runTotals}
                  nosum={nosum} chart={chart} isAgg={agg}
                  onChartChange={(c) => patch({ chart: { type: c.type, x: c.x, y: c.y } })} />
              </div>
            ) : (
              <ReportTable columns={run.columns} rows={run.rows} totals={runTotals}
                showTotals={!!spec.totals} sort={tableSort} label={name || 'Preview'}
                dim={running} maxHeight="max(360px, calc(100vh - 300px))"
                onSort={(s) => patch({ sort: s ? [{ field: s.key, dir: s.dir }] : [] })} />
            )}
          </div>
        </section>
      </div>

      {confirm === 'cancel' && (
        <Modal title="Discard unsaved changes?" onClose={() => setConfirm(null)} width={420}>
          <p className="rpx-confirm-p">Your changes to this report haven’t been saved.</p>
          <div className="sr-form-actions">
            <Button variant="ghost" onClick={() => setConfirm(null)}>Keep editing</Button>
            <Button onClick={() => { setConfirm(null); onCancel() }}>Discard</Button>
          </div>
        </Modal>
      )}
      {confirm === 'source' && (
        <Modal title="Change the data source?" onClose={() => setConfirm(null)} width={420}>
          <p className="rpx-confirm-p">Columns, filters and sorting belong to the current source and will be cleared.</p>
          <div className="sr-form-actions">
            <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button onClick={() => { setConfirm(null); if (pendingSource) applySource(pendingSource) }}>
              Change source
            </Button>
          </div>
        </Modal>
      )}
      {saveOpen && (
        <SaveReportModal savedId={init.savedId ?? null}
          title="Save report"
          initial={{ name: name.trim() || src.label, description: init.description ?? '',
            visibility: init.visibility ?? 'mine' }}
          spec={runSpec} basedOn={init.basedOn ?? ''}
          onClose={() => setSaveOpen(false)}
          onSaved={(r) => { setSaveOpen(false); onSaved(r) }} />
      )}
    </div>
  )
}
