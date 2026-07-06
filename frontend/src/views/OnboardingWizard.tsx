import { useMemo, useState } from 'react'
import Logo from '../components/Logo'
import { authSetup, saveOrg, setToken } from '../api'
import { notifyErr } from '../toast'
import { Button } from '../components/ds'

// Primer arranque (fase G7): crea el admin, nombra la empresa y aplica
// el acento de marca. Tres pasos, sin vuelta atrás destructiva.

type Props = { onDone: () => void }

const ACCENTS: { value: string; label: string }[] = [
  { value: '', label: 'Rigsmith red' },
  { value: '#2563eb', label: 'Blue' },
  { value: '#16a34a', label: 'Green' },
  { value: '#d97706', label: 'Amber' },
  { value: '#7c3aed', label: 'Violet' },
  { value: '#0d9488', label: 'Teal' },
]

const STEPS = ['Your account', 'Your company', 'Done']

export default function OnboardingWizard({ onDone }: Props) {
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Paso 1 — admin
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')

  // Paso 2 — empresa
  const [appName, setAppName] = useState('Rigsmith')
  const [tagline, setTagline] = useState('Your fleet, forged right.')
  const [accent, setAccent] = useState('')

  const step1Valid = useMemo(() =>
    name.trim().length > 1 &&
    username.trim().length > 2 &&
    password.length >= 8 &&
    password === confirm,
  [name, username, password, confirm])

  const pwMismatch = confirm.length > 0 && password !== confirm

  async function createAdmin() {
    setBusy(true)
    setError('')
    try {
      const r = await authSetup(name.trim(), username.trim(), password)
      setToken(r.token)
      setStep(1)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn\'t create the account')
    } finally {
      setBusy(false)
    }
  }

  async function saveCompany() {
    setBusy(true)
    setError('')
    try {
      await saveOrg({
        branding: {
          app_name: appName.trim() || 'Rigsmith',
          tagline: tagline.trim(),
          accent,
        },
      })
      setStep(2)
    } catch (e) {
      notifyErr('Couldn\'t save the company', e)
      setError(e instanceof Error ? e.message : 'Couldn\'t save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wiz-screen">
      <div className="wiz-card">
        <div className="wiz-brand">
          <Logo />
          <strong>{appName.trim() || 'Rigsmith'}</strong>
        </div>

        <ol className="wiz-steps" aria-label="Setup progress">
          {STEPS.map((s, i) => (
            <li key={s}
              className={i < step ? 'done' : i === step ? 'now' : ''}
              aria-current={i === step ? 'step' : undefined}>
              <span className="wiz-step-n">
                {i < step ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2.6" strokeLinecap="round"
                    strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : i + 1}
              </span>
              {s}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <div className="wiz-body" key="s0">
            <h1>Create the admin account</h1>
            <p className="wiz-sub">
              The first account controls users, integrations and the
              company settings.
            </p>
            <label className="ud-field">
              <span>Your name</span>
              <input className="cell-input" value={name} autoFocus
                placeholder="Adrian Ramirez" autoComplete="name"
                onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="ud-field">
              <span>Username</span>
              <input className="cell-input" value={username}
                placeholder="adrian" autoComplete="username"
                onChange={(e) => setUsername(
                  e.target.value.toLowerCase().replace(/\s/g, ''))} />
            </label>
            <div className="wiz-row">
              <label className="ud-field">
                <span>Password (min. 8)</span>
                <input className="cell-input" type="password"
                  value={password} autoComplete="new-password"
                  onChange={(e) => setPassword(e.target.value)} />
              </label>
              <label className="ud-field">
                <span>Confirm</span>
                <input className="cell-input" type="password"
                  value={confirm} autoComplete="new-password"
                  onChange={(e) => setConfirm(e.target.value)} />
              </label>
            </div>
            {pwMismatch && (
              <p className="wiz-error">Passwords do not match.</p>
            )}
            {error && <p className="wiz-error">{error}</p>}
            <div className="wiz-actions">
              <Button variant="primary" disabled={!step1Valid || busy}
                loading={busy} onClick={createAdmin}>
                {busy ? 'Creating…' : 'Create account'}
              </Button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="wiz-body" key="s1">
            <h1>Name your operation</h1>
            <p className="wiz-sub">
              The name and accent apply across the whole app. You can
              change them later in Settings.
            </p>
            <label className="ud-field">
              <span>App name</span>
              <input className="cell-input" value={appName} autoFocus
                onChange={(e) => setAppName(e.target.value)} />
            </label>
            <label className="ud-field">
              <span>Tagline</span>
              <input className="cell-input" value={tagline}
                placeholder="Your fleet, forged right."
                onChange={(e) => setTagline(e.target.value)} />
            </label>
            <span className="ud-field"><span>Accent color</span></span>
            <div className="wiz-accents" role="radiogroup"
              aria-label="Accent color">
              {ACCENTS.map((a) => (
                <button key={a.label} type="button"
                  role="radio" aria-checked={accent === a.value}
                  title={a.label}
                  className={`wiz-accent ${accent === a.value ? 'on' : ''}`}
                  style={{ background: a.value || '#e11900' }}
                  onClick={() => setAccent(a.value)} />
              ))}
              <label className="wiz-accent-custom" title="Custom color">
                <input type="color"
                  value={accent || '#e11900'}
                  onChange={(e) => setAccent(e.target.value)} />
                <span>+</span>
              </label>
            </div>
            {error && <p className="wiz-error">{error}</p>}
            <div className="wiz-actions">
              <Button variant="ghost" disabled={busy}
                onClick={() => setStep(2)}>
                Skip
              </Button>
              <Button variant="primary" disabled={busy} loading={busy}
                onClick={saveCompany}>
                {busy ? 'Saving…' : 'Continue'}
              </Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="wiz-body wiz-done" key="s2">
            <span className="wiz-done-ico">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </span>
            <h1>All set</h1>
            <p className="wiz-sub">
              Next stop: <strong>Settings → Integrations</strong> to
              connect your ELD, email and SMS. The Live Map and Dashboard
              light up on their own once data flows in.
            </p>
            <div className="wiz-actions">
              <Button variant="primary" onClick={onDone}>
                Go to the dashboard
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
