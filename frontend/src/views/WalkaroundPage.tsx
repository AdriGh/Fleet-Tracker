// Walkaround del driver (v2.16, elemento 02 del board — el que integra todo).
//
// El pre-trip deja de ser un formulario que se llena desde la cama: una zona
// por pantalla, foto donde el workflow la exige, OK o defecto con nota. Al
// submit el server materializa: defectos reales con las fotos re-parentadas
// (pipeline v2.14), lectura de odómetro (CPM, v2.8) y firma. Los pasos salen
// del workflow ACTIVO que el manager armó en Driver Workflows (v2.15).
//
// Mobile-first a propósito: el driver lo corre en el teléfono (input file con
// capture abre la cámara directo). En desktop funciona igual con file picker.
import { useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getActiveWorkflow, listFleet, listTmsDrivers, recentWalkarounds,
  startWalkaround, submitWalkaround, uploadWalkstepPhoto,
  type WalkaroundRun, type WalkStep,
} from '../api'
import { notifyErr, notifyOk } from '../toast'
import Skeleton from '../components/Skeleton'
import { Button } from '../components/ds'

type StepState = {
  verdict: '' | 'ok' | 'defect'
  value: string
  note: string
  photos: number
}

const TYPE_HINT: Record<WalkStep['type'], string> = {
  photo: 'Take a photo of this zone, then mark it.',
  check: 'Inspect and mark it. Add a photo if something looks off.',
  read: 'Enter the reading from the dash.',
  sign: 'Sign with your finger to close the inspection.',
}

// ---- Firma: canvas con pointer events (dedo y mouse) ----------------------
function SignPad({ padRef, onStroke }: {
  padRef: React.RefObject<HTMLCanvasElement | null>
  onStroke: () => void
}) {
  const drawing = useRef(false)
  const pos = (e: React.PointerEvent, c: HTMLCanvasElement) => {
    const r = c.getBoundingClientRect()
    return { x: (e.clientX - r.left) * (c.width / r.width),
             y: (e.clientY - r.top) * (c.height / r.height) }
  }
  return (
    <canvas
      ref={padRef}
      className="wk-signpad"
      width={640} height={240}
      onPointerDown={(e) => {
        const c = padRef.current
        if (!c) return
        c.setPointerCapture(e.pointerId)
        drawing.current = true
        const ctx = c.getContext('2d')!
        const p = pos(e, c)
        ctx.lineWidth = 3.5
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.strokeStyle = '#18181b'
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
      }}
      onPointerMove={(e) => {
        const c = padRef.current
        if (!c || !drawing.current) return
        const ctx = c.getContext('2d')!
        const p = pos(e, c)
        ctx.lineTo(p.x, p.y)
        ctx.stroke()
      }}
      onPointerUp={() => { drawing.current = false; onStroke() }}
    />
  )
}

export default function WalkaroundPage({ onNavigate }: {
  onNavigate: (section: string) => void
}) {
  const qc = useQueryClient()
  // Fase: 'start' | índice de paso | 'review' | 'done'
  const [phase, setPhase] = useState<'start' | number | 'review' | 'done'>('start')
  const [run, setRun] = useState<WalkaroundRun | null>(null)
  const [states, setStates] = useState<Record<number, StepState>>({})
  const [result, setResult] = useState<WalkaroundRun | null>(null)
  const [unit, setUnit] = useState('')
  const [driver, setDriver] = useState('')
  const [busy, setBusy] = useState(false)
  const [sigDrawn, setSigDrawn] = useState(false)
  const padRef = useRef<HTMLCanvasElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const fleetQ = useQuery({ queryKey: ['fleet'], queryFn: listFleet })
  const driversQ = useQuery({ queryKey: ['tms-drivers'], queryFn: listTmsDrivers })
  const wfQ = useQuery({ queryKey: ['workflow-active'], queryFn: getActiveWorkflow })
  const recentQ = useQuery({
    queryKey: ['walkarounds-recent'], queryFn: recentWalkarounds,
    enabled: phase === 'start',
  })

  const units = useMemo(
    () => (fleetQ.data ?? []).filter((u) => !u.archived),
    [fleetQ.data])

  const st = (id: number): StepState =>
    states[id] ?? { verdict: '', value: '', note: '', photos: 0 }
  const patch = (id: number, p: Partial<StepState>) =>
    setStates((s) => ({ ...s, [id]: { ...st(id), ...p } }))

  async function begin() {
    const info = units.find((u) => u.unit === unit)
    setBusy(true)
    try {
      const r = await startWalkaround(unit, driver, info?.company ?? '')
      setRun(r)
      setStates({})
      setSigDrawn(false)
      setPhase(0)
    } catch (e) {
      notifyErr("Couldn't start the walkaround", e)
    } finally {
      setBusy(false)
    }
  }

  async function addPhoto(step: WalkStep, file: File | undefined) {
    if (!file) return
    setBusy(true)
    try {
      await uploadWalkstepPhoto(step.id, file)
      patch(step.id, { photos: st(step.id).photos + 1 })
    } catch (e) {
      notifyErr("Couldn't upload the photo", e)
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  // La firma se sube al pasar de paso (no en cada trazo).
  async function uploadSignature(step: WalkStep): Promise<boolean> {
    const c = padRef.current
    if (!c || !sigDrawn) return st(step.id).photos > 0
    const blob: Blob | null = await new Promise((res) => c.toBlob(res, 'image/png'))
    if (!blob) return false
    await uploadWalkstepPhoto(step.id, blob, 'signature.png')
    patch(step.id, { photos: st(step.id).photos + 1 })
    setSigDrawn(false)
    return true
  }

  function canAdvance(step: WalkStep): boolean {
    const s = st(step.id)
    if (step.type === 'photo' && step.required && s.photos === 0) return false
    if ((step.type === 'photo' || step.type === 'check') && step.required
      && s.verdict === '') return false
    if (s.verdict === 'defect' && !s.note.trim()) return false
    if (step.type === 'read' && step.required
      && !(Number(s.value) > 0)) return false
    if (step.type === 'sign' && step.required
      && !sigDrawn && s.photos === 0) return false
    return true
  }

  async function next(step: WalkStep, idx: number) {
    if (step.type === 'sign') {
      setBusy(true)
      try {
        const ok = await uploadSignature(step)
        if (!ok && step.required) {
          notifyErr('Signature is missing', new Error('sign first'))
          return
        }
      } catch (e) {
        notifyErr("Couldn't save the signature", e)
        return
      } finally {
        setBusy(false)
      }
    }
    setPhase(idx + 1 >= run!.steps.length ? 'review' : idx + 1)
  }

  async function doSubmit() {
    if (!run) return
    setBusy(true)
    try {
      const out = await submitWalkaround(run.id, run.steps.map((s) => ({
        step_id: s.id,
        verdict: st(s.id).verdict,
        value: st(s.id).value,
        note: st(s.id).note,
      })))
      setResult(out)
      setPhase('done')
      notifyOk('Walkaround submitted', `${out.defects_created} defect(s) reported`)
      qc.invalidateQueries({ queryKey: ['walkarounds-recent'] })
      qc.invalidateQueries({ queryKey: ['dvir-defects'] })
      qc.invalidateQueries({ queryKey: ['unit-odometer', run.unit] })
    } catch (e) {
      notifyErr("Couldn't submit", e)
    } finally {
      setBusy(false)
    }
  }

  // ---------- Pantalla de inicio ----------
  if (phase === 'start') {
    const wf = wfQ.data
    return (
      <div className="page wk-page">
        <div className="page-head">
          <div>
            <h1>Walkaround</h1>
            <p className="page-sub">
              Guided pre-trip: one zone per screen, photo where required.
              Defects come out with evidence attached.
            </p>
          </div>
        </div>
        <div className="wk-card">
          {wfQ.isPending ? <Skeleton h={120} /> : wf ? (
            <>
              <div className="wk-wfrow">
                <span className="wk-wfname">{wf.name}</span>
                <span className="wk-wfmeta">{wf.steps.length} steps</span>
                <button className="btn-link" onClick={() => onNavigate('workflows')}>
                  Edit →
                </button>
              </div>
              <label className="wk-field">Unit
                <select value={unit} onChange={(e) => setUnit(e.target.value)}>
                  <option value="">Pick a unit…</option>
                  {units.map((u) => (
                    <option key={u.id} value={u.unit}>
                      {u.unit} · {[u.make, u.model].filter(Boolean).join(' ') || u.unit_type}
                    </option>
                  ))}
                </select>
              </label>
              <label className="wk-field">Driver
                <input list="wk-drivers" value={driver} placeholder="Your name"
                  onChange={(e) => setDriver(e.target.value)} />
                <datalist id="wk-drivers">
                  {(driversQ.data ?? []).map((d) => (
                    <option key={d.name} value={d.name} />
                  ))}
                </datalist>
              </label>
              <Button variant="primary" disabled={!unit || !driver.trim() || busy}
                onClick={begin} className="wk-startbtn">
                {busy ? 'Starting…' : 'Start walkaround'}
              </Button>
            </>
          ) : (
            <div className="empty mini">
              <p>
                No active workflow yet.{' '}
                <button className="btn-link" onClick={() => onNavigate('workflows')}>
                  Build your pre-trip →
                </button>
              </p>
            </div>
          )}
        </div>

        {(recentQ.data ?? []).length > 0 && (
          <div className="wk-card">
            <h3 className="wk-subhead">Recent walkarounds</h3>
            {(recentQ.data ?? []).map((r) => (
              <div key={r.id} className="wk-recent-row">
                <span className="wk-recent-unit">{r.unit}</span>
                <span className="wk-recent-driver">{r.driver}</span>
                <span className="wk-recent-meta">
                  {r.started_at.slice(5, 10).replace('-', '/')}
                  {r.status === 'submitted'
                    ? (r.defects_created > 0
                      ? ` · ${r.defects_created} defect${r.defects_created > 1 ? 's' : ''}`
                      : ' · clean')
                    : ' · in progress'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  if (!run) return null

  // ---------- Review ----------
  if (phase === 'review') {
    const defects = run.steps.filter((s) => st(s.id).verdict === 'defect')
    return (
      <div className="page wk-page">
        <div className="wk-runhead">
          <span className="wk-eyebrow">{run.workflow_name} · Unit {run.unit}</span>
          <h1>Review & submit</h1>
        </div>
        <div className="wk-card">
          {run.steps.map((s) => {
            const state = st(s.id)
            return (
              <div key={s.id} className="wk-review-row">
                <span className={`wk-review-dot ${state.verdict || (s.type === 'read' || s.type === 'sign' ? 'ok' : '')}`} />
                <span className="wk-review-label">
                  {s.label}
                  {state.note && <em> — {state.note}</em>}
                </span>
                <span className="wk-review-meta">
                  {s.type === 'read' && state.value
                    ? `${Number(state.value).toLocaleString('en-US')} mi`
                    : state.photos > 0 ? `${state.photos} 📷` : ''}
                </span>
              </div>
            )
          })}
        </div>
        {defects.length > 0 && (
          <p className="wk-review-note">
            {defects.length} defect{defects.length > 1 ? 's' : ''} will be
            reported with photos and enter the Defects backlog.
          </p>
        )}
        <div className="wk-foot">
          <Button variant="ghost" onClick={() => setPhase(run.steps.length - 1)}>
            Back
          </Button>
          <Button variant="primary" disabled={busy} onClick={doSubmit}>
            {busy ? 'Submitting…' : 'Sign off & submit'}
          </Button>
        </div>
      </div>
    )
  }

  // ---------- Done ----------
  if (phase === 'done') {
    const r = result!
    return (
      <div className="page wk-page">
        <div className="wk-done">
          <span className="wk-done-badge">✓</span>
          <h1>Pre-trip complete</h1>
          <p className="wk-done-sub">
            Unit {r.unit} · {r.driver}
            {r.defects_created > 0
              ? <> · <b>{r.defects_created} defect{r.defects_created > 1 ? 's' : ''} reported</b></>
              : ' · no defects'}
            {r.odometer_logged ? ' · odometer logged' : ''}
          </p>
          <div className="wk-done-actions">
            {r.defects_created > 0 && (
              <Button variant="ghost" onClick={() => onNavigate('defectos')}>
                View defects
              </Button>
            )}
            <Button variant="primary" onClick={() => {
              setRun(null); setResult(null); setUnit(''); setPhase('start')
            }}>
              New walkaround
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // ---------- Paso ----------
  const idx = phase as number
  const step = run.steps[idx]
  const state = st(step.id)
  return (
    <div className="page wk-page">
      <div className="wk-prog" aria-hidden="true">
        {run.steps.map((_, k) => (
          <i key={k} className={k < idx ? 'done' : k === idx ? 'cur' : ''} />
        ))}
      </div>
      <div className="wk-runhead">
        <span className="wk-eyebrow">
          {run.workflow_name} · Unit {run.unit} · step {idx + 1} of {run.steps.length}
        </span>
        <h1>{step.label}</h1>
        <p className="wk-hint">{TYPE_HINT[step.type]}</p>
      </div>

      {(step.type === 'photo' || step.type === 'check') && (
        <>
          <input ref={fileRef} type="file" accept="image/*" capture="environment"
            hidden onChange={(e) => addPhoto(step, e.target.files?.[0])} />
          <button
            className={`wk-photozone ${state.photos > 0 ? 'has' : ''} ${step.type === 'check' ? 'slim' : ''}`}
            disabled={busy}
            onClick={() => fileRef.current?.click()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
              width="26" height="26">
              <path d="M4 8h3l2-2h6l2 2h3v11H4z" />
              <circle cx="12" cy="13" r="3.2" />
            </svg>
            <span>
              {state.photos > 0
                ? `${state.photos} photo${state.photos > 1 ? 's' : ''} ✓ — add another`
                : step.type === 'photo' ? 'Take photo (required)' : 'Add photo (optional)'}
            </span>
          </button>
          <div className="wk-verdict">
            <button className={`ok ${state.verdict === 'ok' ? 'sel' : ''}`}
              onClick={() => patch(step.id, { verdict: 'ok' })}>✓ OK</button>
            <button className={`bad ${state.verdict === 'defect' ? 'sel' : ''}`}
              onClick={() => patch(step.id, { verdict: 'defect' })}>✗ Defect</button>
          </div>
          {state.verdict === 'defect' && (
            <textarea className="wk-note" rows={2} autoFocus
              placeholder="What's wrong? (required)"
              value={state.note}
              onChange={(e) => patch(step.id, { note: e.target.value })} />
          )}
        </>
      )}

      {step.type === 'read' && (
        <input className="wk-reading" type="number" inputMode="numeric"
          placeholder="Odometer (mi)" value={state.value} autoFocus
          onChange={(e) => patch(step.id, { value: e.target.value })} />
      )}

      {step.type === 'sign' && (
        <div className="wk-signwrap">
          <SignPad padRef={padRef} onStroke={() => setSigDrawn(true)} />
          <button className="btn-link" onClick={() => {
            const c = padRef.current
            c?.getContext('2d')?.clearRect(0, 0, c.width, c.height)
            setSigDrawn(false)
          }}>Clear</button>
        </div>
      )}

      <div className="wk-foot">
        {idx > 0
          ? <Button variant="ghost" onClick={() => setPhase(idx - 1)}>Back</Button>
          : <Button variant="ghost" onClick={() => setPhase('start')}>Cancel</Button>}
        <Button variant="primary" disabled={!canAdvance(step) || busy}
          onClick={() => next(step, idx)}>
          {busy ? 'Saving…'
            : idx + 1 >= run.steps.length ? 'Review' : 'Next'}
        </Button>
      </div>
    </div>
  )
}
