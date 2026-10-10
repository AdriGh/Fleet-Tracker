// "Ask Rigsmith" (v2.22 [G]): barra de pedido en lenguaje natural que arma
// un reporte sobre los datos de la org (POST /api/reports/assistant). El
// server devuelve una ReportSpec YA validada por el motor + explicación +
// avisos; quien lo monta decide qué hacer (la biblioteca abre el builder con
// la spec, el builder la reemplaza como refinamiento). Nunca se mandan filas
// al modelo: solo el pedido y, al refinar, la spec actual.
// Estado deshabilitado (503: sin clave o apagado por el plan de la org) con
// un texto amable en vez de un error.
import { useId, useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ApiError, askReportAssistant, getReportAssistantStatus,
  type ReportAssistantAnswer, type ReportSpec,
} from '../api'
import { notifyErr } from '../toast'
import { IcAi } from './icons'

const ASK_EXAMPLES = [
  'Parts cost by unit last 90 days',
  'Overdue reefer PMs by engine hours',
  'What did each owner-operator get billed this month?',
  'Open work orders waiting on parts, oldest first',
]

const REFINE_EXAMPLES = [
  'Only the last 30 days',
  'Add labor hours',
  'Group by month instead',
]

export interface AskRigsmithProps {
  // Spec actual (refinamientos desde el builder).
  spec?: ReportSpec | null
  onAnswer: (a: ReportAssistantAnswer, prompt: string) => void
  variant?: 'hero' | 'compact'
}

function unavailableCopy(msg: string, enabled?: boolean): string {
  if (enabled === false || /turned off/i.test(msg)) {
    return 'Ask Rigsmith is turned off for your organization. An admin can turn it on in Settings → AI assistant.'
  }
  return 'Ask Rigsmith isn’t set up yet. An admin can connect an Anthropic API key to build reports from plain English.'
}

export default function AskRigsmith({ spec, onAnswer, variant = 'hero' }: AskRigsmithProps) {
  const qc = useQueryClient()
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const ctrl = useRef<AbortController | null>(null)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [blocked, setBlocked] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ text: string; warnings: string[] } | null>(null)

  // /status puede no existir en un backend viejo: ante error se asume
  // disponible y el 503 del POST decide.
  const status = useQuery({
    queryKey: ['report-assistant-status'],
    queryFn: getReportAssistantStatus,
    staleTime: 5 * 60_000,
    retry: false,
  })
  const st = status.data
  const unavailable = blocked
    ?? (st && !st.available ? unavailableCopy(st.message, st.enabled) : null)
  const refining = !!spec && spec.columns.length > 0

  async function ask(text: string) {
    const p = text.trim()
    if (!p || busy || unavailable) return
    ctrl.current?.abort()
    const ac = new AbortController()
    ctrl.current = ac
    setBusy(true)
    setProblem(null)
    try {
      const a = await askReportAssistant({ prompt: p, spec: refining ? spec : null }, ac.signal)
      if (!a.spec) {
        setProblem({
          text: a.explanation || 'Rigsmith couldn’t build that report.',
          warnings: a.warnings ?? [],
        })
        return
      }
      setPrompt('')
      onAnswer(a, p)
    } catch (e) {
      if (ac.signal.aborted) return
      if (e instanceof ApiError && e.status === 503) {
        setBlocked(unavailableCopy(e.message))
        qc.invalidateQueries({ queryKey: ['report-assistant-status'] })
      } else if (e instanceof ApiError && e.status === 429) {
        notifyErr('Too many requests', e)
      } else {
        setProblem({ text: e instanceof Error ? e.message : 'Something went wrong.', warnings: [] })
      }
    } finally {
      if (ctrl.current === ac) {
        setBusy(false)
        ctrl.current = null
      }
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    void ask(prompt)
  }

  const examples = refining ? REFINE_EXAMPLES : ASK_EXAMPLES

  return (
    <section className={`ask ask-${variant}${unavailable ? ' is-off' : ''}`}
      aria-label="Ask Rigsmith">
      <form className="ask-row" onSubmit={submit} role="search">
        <label htmlFor={inputId} className="ask-brand">
          <span className="ask-glyph"><IcAi size={17} /></span>
          <span className="ask-name">Ask Rigsmith</span>
        </label>
        <input id={inputId} ref={inputRef} className="ask-input"
          value={prompt} onChange={(e) => setPrompt(e.target.value)}
          placeholder={refining
            ? 'Refine this report — “only overdue”, “add labor hours”…'
            : 'Describe the report you need…'}
          disabled={!!unavailable} maxLength={600}
          aria-describedby={unavailable ? `${inputId}-off` : undefined}
          autoComplete="off" />
        {busy ? (
          <button type="button" className="ask-go is-busy"
            onClick={() => { ctrl.current?.abort(); setBusy(false) }}
            aria-label="Stop">
            <span className="ask-spin" aria-hidden="true" />
            <span>Building…</span>
          </button>
        ) : (
          <button type="submit" className="ask-go"
            disabled={!prompt.trim() || !!unavailable}>
            {refining ? 'Refine' : 'Ask'}
          </button>
        )}
      </form>
      {unavailable ? (
        <p className="ask-off" id={`${inputId}-off`}>{unavailable}</p>
      ) : (
        <div className="ask-examples" role="group" aria-label="Examples">
          {examples.map((x) => (
            <button key={x} type="button" className="ask-chip" disabled={busy}
              onClick={() => { setPrompt(x); void ask(x) }}>
              {x}
            </button>
          ))}
          {variant === 'hero' && (
            <span className="ask-note">Only your question and the report layout go to the AI — never your records.</span>
          )}
        </div>
      )}
      {busy && (
        <p className="ask-status" role="status">
          Reading your data sources and building the report…
        </p>
      )}
      {problem && (
        <div className="ask-problem" role="alert">
          <strong>{problem.text}</strong>
          {problem.warnings.length > 0 && (
            <ul>{problem.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          )}
          <button type="button" className="link-btn"
            onClick={() => { setProblem(null); inputRef.current?.focus() }}>
            Dismiss
          </button>
        </div>
      )}
    </section>
  )
}
