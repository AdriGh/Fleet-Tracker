import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  activateWorkflow, createWorkflow, deleteWorkflow, getWorkflow,
  listWorkflows, updateWorkflow,
  type Workflow, type WorkflowStepInput, type WorkflowStepType,
} from '../api'
import { notifyErr, notifyOk } from '../toast'
import { Badge, Button } from '../components/ds'

// Editor de workflows del driver (v2.15, elemento 03 del board — el moat).
// Dos columnas como el prototipo S3: izquierda el editor (paleta de tipos,
// lista de pasos, config del seleccionado), derecha el preview de teléfono
// EN VIVO — mismo estado del editor, refresco instantáneo. El guardado es
// replace-all (name + lista completa); dirty por comparación JSON contra lo
// último que devolvió el server.

const STROKE = {
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

const CameraIcon = (
  <svg viewBox="0 0 24 24" {...STROKE} aria-label="Photo required" role="img">
    <path d="M5 7.5h2.6L9.2 5h5.6l1.6 2.5H19A1.5 1.5 0 0 1 20.5 9v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18V9A1.5 1.5 0 0 1 5 7.5z" />
    <circle cx="12" cy="13" r="3.4" />
  </svg>
)

// Tipos de paso (mismo enum del backend). El icono identifica el tipo en la
// paleta, la lista y el preview; el nombre es el label por defecto al agregar.
const STEP_TYPES: Record<
  WorkflowStepType, { name: string; ico: ReactElement }
> = {
  check: {
    name: 'Checklist item',
    ico: (
      <svg viewBox="0 0 24 24" {...STROKE}>
        <rect x="4" y="4" width="16" height="16" rx="3.5" />
        <path d="m8.7 12.3 2.2 2.2 4.4-4.8" />
      </svg>
    ),
  },
  photo: { name: 'Photo required', ico: CameraIcon },
  read: {
    name: 'Reading / input',
    ico: (
      <svg viewBox="0 0 24 24" {...STROKE}>
        <path d="M9.5 4 8 20M16 4l-1.5 16M4 9.5h16.5M3.5 14.5H20" />
      </svg>
    ),
  },
  sign: {
    name: 'Signature',
    ico: (
      <svg viewBox="0 0 24 24" {...STROKE}>
        <path d="M12 19.5h8.5" />
        <path d="m16.2 4.6 3.2 3.2L8.5 18.7l-4.3 1.1 1.1-4.3z" />
      </svg>
    ),
  },
}

// Paso del borrador local: `key` es un uid de UI (selección + key de React);
// el id real de la fila no sirve porque el replace-all los regenera.
interface DraftStep {
  key: number
  type: WorkflowStepType
  label: string
  required: boolean
}

interface Draft {
  name: string
  steps: DraftStep[]
}

let uid = 0
const nextKey = () => ++uid

const toInputs = (steps: { type: WorkflowStepType; label: string;
  required: boolean }[]): WorkflowStepInput[] =>
  steps.map(({ type, label, required }) => ({ type, label, required }))

// Firma canónica para el dirty-check: solo lo que viaja al guardar.
const serialize = (name: string, steps: { type: WorkflowStepType;
  label: string; required: boolean }[]) =>
  JSON.stringify({ name, steps: toInputs(steps) })

function Toggle({ on, label, onToggle }: {
  on: boolean; label: string; onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`wf-toggle ${on ? 'on' : ''}`}
      onClick={onToggle}
    />
  )
}

export default function WorkflowsPage() {
  const qc = useQueryClient()
  const [wid, setWid] = useState<number | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [selKey, setSelKey] = useState<number | null>(null)
  // Qué versión del server está cargada en el borrador: al cambiar (otro
  // workflow, o refetch tras guardar) se recarga; un refetch de fondo con el
  // mismo updated_at NO pisa lo que el manager está editando.
  const loadedRef = useRef<string | null>(null)

  const listQ = useQuery({ queryKey: ['workflows'], queryFn: listWorkflows })
  const summaries = listQ.data

  // Selección inicial (o tras borrar el elegido): el activo, si no el primero.
  useEffect(() => {
    if (!summaries || summaries.length === 0) return
    if (wid != null && summaries.some((w) => w.id === wid)) return
    const pick = summaries.find((w) => w.active) ?? summaries[0]
    setWid(pick.id)
  }, [summaries, wid])

  const wfQ = useQuery({
    queryKey: ['workflow', wid],
    queryFn: () => getWorkflow(wid as number),
    enabled: wid != null,
  })
  const wf: Workflow | undefined = wfQ.data

  useEffect(() => {
    if (!wf) return
    const key = `${wf.id}:${wf.updated_at}`
    if (loadedRef.current === key) return
    loadedRef.current = key
    setDraft({
      name: wf.name,
      steps: wf.steps.map((s) => ({
        key: nextKey(), type: s.type, label: s.label, required: s.required,
      })),
    })
    setSelKey(null)
  }, [wf])

  const dirty = useMemo(() => {
    if (!draft || !wf || wf.id !== wid) return false
    return serialize(draft.name, draft.steps) !== serialize(wf.name, wf.steps)
  }, [draft, wf, wid])

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['workflows'] })
    qc.invalidateQueries({ queryKey: ['workflow'] })
  }

  const saveM = useMutation({
    mutationFn: () => updateWorkflow(
      wid as number, draft!.name.trim(), toInputs(draft!.steps)),
    onSuccess: () => { notifyOk('Workflow saved'); invalidate() },
    onError: (e) => notifyErr('Could not save the workflow', e),
  })
  const createM = useMutation({
    mutationFn: () => createWorkflow('New workflow', [
      { type: 'check', label: 'Checklist item', required: false },
    ]),
    onSuccess: (created) => {
      invalidate()
      setWid(created.id)
      notifyOk('Workflow created', 'Name it and add your steps.')
    },
    onError: (e) => notifyErr('Could not create the workflow', e),
  })
  const deleteM = useMutation({
    mutationFn: () => deleteWorkflow(wid as number),
    onSuccess: () => { setWid(null); invalidate(); notifyOk('Workflow deleted') },
    onError: (e) => notifyErr('Could not delete the workflow', e),
  })
  const activateM = useMutation({
    mutationFn: () => activateWorkflow(wid as number),
    onSuccess: () => {
      invalidate()
      notifyOk('Workflow activated', 'This is what your drivers will run.')
    },
    onError: (e) => notifyErr('Could not activate the workflow', e),
  })

  const summary = summaries?.find((w) => w.id === wid)
  const selStep = draft?.steps.find((s) => s.key === selKey) ?? null

  const patchStep = (key: number, patch: Partial<DraftStep>) => {
    setDraft((d) => d && ({
      ...d,
      steps: d.steps.map((s) => (s.key === key ? { ...s, ...patch } : s)),
    }))
  }

  const addStep = (type: WorkflowStepType) => {
    const step: DraftStep = {
      key: nextKey(), type, label: STEP_TYPES[type].name, required: false,
    }
    setDraft((d) => d && ({ ...d, steps: [...d.steps, step] }))
    setSelKey(step.key)
  }

  const moveStep = (key: number, dir: -1 | 1) => {
    setDraft((d) => {
      if (!d) return d
      const i = d.steps.findIndex((s) => s.key === key)
      const j = i + dir
      if (i < 0 || j < 0 || j >= d.steps.length) return d
      const steps = [...d.steps]
      ;[steps[i], steps[j]] = [steps[j], steps[i]]
      return { ...d, steps }
    })
  }

  const removeStep = (key: number) => {
    setDraft((d) => d && ({
      ...d, steps: d.steps.filter((s) => s.key !== key),
    }))
    if (selKey === key) setSelKey(null)
  }

  const onSave = () => {
    if (!draft) return
    if (!draft.name.trim()) {
      notifyErr('The workflow needs a name.'); return
    }
    if (draft.steps.length === 0) {
      notifyErr('A workflow needs at least one step.'); return
    }
    if (draft.steps.some((s) => !s.label.trim())) {
      notifyErr('Every step needs a label.'); return
    }
    saveM.mutate()
  }

  // Cambiar de workflow (o crear otro) descarta el borrador: se avisa.
  const confirmDiscard = () =>
    !dirty || window.confirm('Discard unsaved changes to this workflow?')

  return (
    <div className="page page-wide">
      {(listQ.isFetching || wfQ.isFetching) && (
        <div className="loadbar" aria-hidden="true" />
      )}
      <div className="page-head">
        <div>
          <h1>Driver Workflows</h1>
          <p className="page-sub">
            Build the pre-trip inspection your drivers run on their phone —
            every fleet checks different things.
          </p>
        </div>
      </div>

      <div className="wf-layout">
        {/* ----- Columna izquierda: el editor ----- */}
        <section className="card wf-editor">
          <div className="wf-editor-head">
            {summaries && summaries.length > 1 && (
              <select
                className="wf-select"
                aria-label="Workflow"
                value={wid ?? ''}
                onChange={(e) => {
                  if (confirmDiscard()) setWid(Number(e.target.value))
                }}
              >
                {summaries.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.n_steps})
                  </option>
                ))}
              </select>
            )}
            <input
              className="wf-name"
              aria-label="Workflow name"
              placeholder="Workflow name"
              maxLength={80}
              value={draft?.name ?? ''}
              disabled={!draft}
              onChange={(e) =>
                setDraft((d) => d && ({ ...d, name: e.target.value }))}
            />
            {summary?.active ? (
              <Badge tone="success">Active</Badge>
            ) : (
              <Button size="sm" variant="ghost" disabled={wid == null}
                loading={activateM.isPending}
                onClick={() => activateM.mutate()}>
                Set active
              </Button>
            )}
            <span className="wf-head-actions">
              <Button size="sm" variant="ghost"
                loading={createM.isPending}
                onClick={() => { if (confirmDiscard()) createM.mutate() }}>
                + New
              </Button>
              <Button size="sm" variant="ghost"
                disabled={(summaries?.length ?? 0) < 2}
                title={(summaries?.length ?? 0) < 2
                  ? 'Your fleet needs at least one workflow'
                  : 'Delete this workflow'}
                loading={deleteM.isPending}
                onClick={() => {
                  if (window.confirm('Delete this workflow?')) deleteM.mutate()
                }}>
                Delete
              </Button>
              <Button size="sm" variant="primary"
                disabled={!dirty} loading={saveM.isPending} onClick={onSave}>
                Save
              </Button>
            </span>
          </div>

          <div className="wf-palette" role="group" aria-label="Add a step">
            {(Object.keys(STEP_TYPES) as WorkflowStepType[]).map((t) => (
              <button key={t} type="button" className="wf-pal-btn"
                disabled={!draft} onClick={() => addStep(t)}>
                <span className="wf-pal-ico">{STEP_TYPES[t].ico}</span>
                + {STEP_TYPES[t].name}
              </button>
            ))}
          </div>

          <div className="wf-steps">
            {!draft && <p className="wf-empty">Loading…</p>}
            {draft && draft.steps.length === 0 && (
              <p className="wf-empty">
                No steps yet — add the first one from the palette above.
              </p>
            )}
            {draft?.steps.map((s, i) => (
              <div
                key={s.key}
                className={`wf-step ${s.key === selKey ? 'sel' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => setSelKey(s.key)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault(); setSelKey(s.key)
                  }
                }}
              >
                <span className="wf-step-ico">{STEP_TYPES[s.type].ico}</span>
                <span className="wf-step-lbl">
                  <b>{s.label || STEP_TYPES[s.type].name}</b>
                  <span>{STEP_TYPES[s.type].name}</span>
                </span>
                <span className="wf-flags">
                  {s.type === 'photo' && <span className="wf-flag on">PHOTO</span>}
                  {s.required && <span className="wf-flag on">REQ</span>}
                </span>
                <span className="wf-mv">
                  <button type="button" aria-label="Move step up"
                    disabled={i === 0}
                    onClick={(e) => { e.stopPropagation(); moveStep(s.key, -1) }}>
                    ▲
                  </button>
                  <button type="button" aria-label="Move step down"
                    disabled={i === draft.steps.length - 1}
                    onClick={(e) => { e.stopPropagation(); moveStep(s.key, 1) }}>
                    ▼
                  </button>
                </span>
                <button type="button" className="wf-del" aria-label="Remove step"
                  onClick={(e) => { e.stopPropagation(); removeStep(s.key) }}>
                  <svg viewBox="0 0 24 24" {...STROKE}>
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              </div>
            ))}
          </div>

          {selStep && (
            <div className="wf-config">
              <span className="wf-config-title">
                Step settings · {selStep.label || STEP_TYPES[selStep.type].name}
              </span>
              <label className="wf-config-row">
                <span>Label</span>
                <input
                  className="wf-config-input"
                  aria-label="Step label"
                  maxLength={120}
                  value={selStep.label}
                  onChange={(e) =>
                    patchStep(selStep.key, { label: e.target.value })}
                />
              </label>
              <div className="wf-config-row">
                <span>Required (blocks submit)</span>
                <Toggle
                  on={selStep.required}
                  label="Required (blocks submit)"
                  onToggle={() =>
                    patchStep(selStep.key, { required: !selStep.required })}
                />
              </div>
              {/* Foto solo aplica a pasos de inspección visual: alterna
                  check <-> photo. Reading y Signature no llevan foto. */}
              {(selStep.type === 'check' || selStep.type === 'photo') && (
                <div className="wf-config-row">
                  <span>Requires photo</span>
                  <Toggle
                    on={selStep.type === 'photo'}
                    label="Requires photo"
                    onToggle={() => patchStep(selStep.key, {
                      type: selStep.type === 'photo' ? 'check' : 'photo',
                    })}
                  />
                </div>
              )}
            </div>
          )}
        </section>

        {/* ----- Columna derecha (sticky): lo que ve el driver ----- */}
        <aside className="wf-preview-wrap" aria-label="Driver phone preview">
          <p className="wf-preview-label">
            Live preview — what your driver sees
          </p>
          <div className="wf-phone">
            <span className="wf-phone-notch" aria-hidden="true" />
            <div className="wf-phone-screen">
              <div className="wf-drv-head">
                <span className="wf-drv-eyebrow">
                  {(draft?.name || 'Pre-trip')} · Unit 418
                </span>
                <strong>{draft?.steps.length ?? 0} steps</strong>
              </div>
              <div className="wf-drv-steps">
                {draft?.steps.map((s, i) => (
                  <div className="wf-drv-step" key={s.key}>
                    <span className="wf-drv-num">{i + 1}</span>
                    <span className="wf-drv-t">
                      {s.label || STEP_TYPES[s.type].name}
                    </span>
                    {s.type === 'photo' && (
                      <span className="wf-drv-cam">{CameraIcon}</span>
                    )}
                    {s.required && <span className="wf-drv-req">REQ</span>}
                  </div>
                ))}
              </div>
              <div className="wf-drv-foot">
                {/* Decorativo: el walkaround real llega en v2.16. */}
                <span className="wf-start-btn" aria-hidden="true">
                  Start walkaround
                </span>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
