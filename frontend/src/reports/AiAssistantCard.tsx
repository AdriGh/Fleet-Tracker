// Settings → "AI assistant" (v2.22 [G], admin): interruptor del plan
// (org_config.ai_assistant_enabled — el "switch de suscripción" de Ask
// Rigsmith) y el modelo (vacío = el default del server). Muestra si hay una
// clave configurada (secretstore 'assistant' → ANTHROPIC_API_KEY → la del
// escaneo de documentos). Usa solo clases de Settings / Resources: no
// depende de reports.css (que carga con la página de Reports).
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getOrg, getReportAssistantStatus, saveOrg } from '../api'
import { Button } from '../components/ds'
import Skeleton from '../components/Skeleton'
import { notifyErr, notifyOk } from '../toast'

const KEY_SOURCE: Record<string, string> = {
  assistant: 'the assistant key in the secret store',
  env: 'the ANTHROPIC_API_KEY environment variable',
  docscan: 'the Document scan (Claude) key in Integrations',
}

export default function AiAssistantCard() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const orgQ = useQuery({ queryKey: ['org'], queryFn: getOrg, enabled: open })
  const stQ = useQuery({
    queryKey: ['report-assistant-status'], queryFn: getReportAssistantStatus,
    enabled: open, retry: false,
  })
  const [draft, setDraft] = useState<{ enabled: boolean; model: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const base = orgQ.data
    ? { enabled: orgQ.data.ai_assistant_enabled ?? true, model: orgQ.data.assistant_model ?? '' }
    : null
  const form = draft ?? base
  const dirty = !!form && !!base
    && (form.enabled !== base.enabled || form.model !== base.model)
  const st = stQ.data
  const models = st?.models?.length ? st.models : ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']

  async function save() {
    if (!form) return
    setSaving(true)
    try {
      const saved = await saveOrg({
        ai_assistant_enabled: form.enabled, assistant_model: form.model,
      })
      qc.setQueryData(['org'], saved)
      setDraft(null)
      await qc.invalidateQueries({ queryKey: ['report-assistant-status'] })
      notifyOk('AI assistant saved',
        form.enabled ? 'Ask Rigsmith is on for your organization' : 'Ask Rigsmith is off')
    } catch (e) {
      notifyErr('Couldn’t save changes', e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="card settings-card">
      <button className="collapse-head" onClick={() => setOpen((o) => !o)}
        aria-expanded={open}>
        <svg className={`collapse-chevron ${open ? 'open' : ''}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="m9 18 6-6-6-6" />
        </svg>
        <div>
          <h2>AI assistant</h2>
          <span className="sub">
            “Ask Rigsmith” builds reports from plain English over your own data
          </span>
        </div>
      </button>

      {open && (
        <div className="card-body">
          {orgQ.isPending || !form ? (
            <Skeleton h={120} />
          ) : (
            <>
              <p className="settings-help">
                Only the question and the report layout are sent to Claude —
                never your records. The assistant answers with a report that
                Rigsmith validates and runs on your data.
              </p>
              <p className="settings-help">
                {stQ.isPending ? 'Checking the connection…'
                  : !st ? 'Couldn’t check the assistant status.'
                    : st.configured ? (
                      <>
                        <span className="rx-pill is-ok">Connected</span>{' '}
                        Using {KEY_SOURCE[st.key_source ?? ''] ?? 'a configured API key'}.
                      </>
                    ) : (
                      <>
                        <span className="rx-pill">Not connected</span>{' '}
                        Add an Anthropic API key (the ANTHROPIC_API_KEY environment
                        variable, or the Claude key under Integrations → Document
                        scan) to turn the assistant on.
                      </>
                    )}
              </p>
              <label className="settings-toggle">
                <input type="checkbox" checked={form.enabled}
                  onChange={(e) => setDraft({ ...form, enabled: e.target.checked })} />
                <span>
                  <strong>Turn on Ask Rigsmith for this organization</strong>
                  <span className="settings-sub">
                    When off, everyone sees the assistant as unavailable in
                    Reports; ready-made reports and the builder keep working.
                  </span>
                </span>
              </label>
              <label className="ud-field" style={{ maxWidth: 340 }}>
                <span>Model</span>
                <select className="cell-input" value={form.model}
                  disabled={!form.enabled}
                  onChange={(e) => setDraft({ ...form, model: e.target.value })}>
                  <option value="">
                    Default{st?.default_model ? ` (${st.default_model})` : ''}
                  </option>
                  {models.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <div className="settings-actions" style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <Button onClick={() => void save()} disabled={!dirty} loading={saving}>
                  Save
                </Button>
                {dirty && (
                  <Button variant="ghost" onClick={() => setDraft(null)}>Discard</Button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}
