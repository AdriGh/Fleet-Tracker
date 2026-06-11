import { useMemo, useState } from 'react'
import Logo from '../components/Logo'
import { authSetup, saveOrg, setToken } from '../api'
import { notifyErr } from '../toast'

// Primer arranque (fase G7): crea el admin, nombra la empresa y aplica
// el acento de marca. Tres pasos, sin vuelta atrás destructiva.

type Props = { onDone: () => void }

const ACCENTS: { value: string; label: string }[] = [
  { value: '', label: 'Rojo Fleet Tracker' },
  { value: '#2563eb', label: 'Azul' },
  { value: '#16a34a', label: 'Verde' },
  { value: '#d97706', label: 'Ámbar' },
  { value: '#7c3aed', label: 'Violeta' },
  { value: '#0d9488', label: 'Teal' },
]

const STEPS = ['Tu cuenta', 'Tu empresa', 'Listo']

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
  const [appName, setAppName] = useState('Fleet Tracker')
  const [tagline, setTagline] = useState('Fleet compliance')
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
      setError(e instanceof Error ? e.message : 'No se pudo crear la cuenta')
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
          app_name: appName.trim() || 'Fleet Tracker',
          tagline: tagline.trim(),
          accent,
        },
      })
      setStep(2)
    } catch (e) {
      notifyErr('No se pudo guardar la empresa', e)
      setError(e instanceof Error ? e.message : 'Error guardando')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wiz-screen">
      <div className="wiz-card">
        <div className="wiz-brand">
          <Logo />
          <strong>{appName.trim() || 'Fleet Tracker'}</strong>
        </div>

        <ol className="wiz-steps" aria-label="Progreso de configuración">
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
            <h1>Crea la cuenta de administrador</h1>
            <p className="wiz-sub">
              La primera cuenta controla usuarios, integraciones y la
              configuración de la empresa.
            </p>
            <label className="ud-field">
              <span>Tu nombre</span>
              <input className="cell-input" value={name} autoFocus
                placeholder="Adrian Ramirez" autoComplete="name"
                onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="ud-field">
              <span>Usuario</span>
              <input className="cell-input" value={username}
                placeholder="adrian" autoComplete="username"
                onChange={(e) => setUsername(
                  e.target.value.toLowerCase().replace(/\s/g, ''))} />
            </label>
            <div className="wiz-row">
              <label className="ud-field">
                <span>Contraseña (mín. 8)</span>
                <input className="cell-input" type="password"
                  value={password} autoComplete="new-password"
                  onChange={(e) => setPassword(e.target.value)} />
              </label>
              <label className="ud-field">
                <span>Confirmar</span>
                <input className="cell-input" type="password"
                  value={confirm} autoComplete="new-password"
                  onChange={(e) => setConfirm(e.target.value)} />
              </label>
            </div>
            {pwMismatch && (
              <p className="wiz-error">Las contraseñas no coinciden.</p>
            )}
            {error && <p className="wiz-error">{error}</p>}
            <div className="wiz-actions">
              <button className="btn btn-primary" disabled={!step1Valid || busy}
                onClick={createAdmin}>
                {busy ? 'Creando…' : 'Crear cuenta'}
              </button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="wiz-body" key="s1">
            <h1>Nombra tu operación</h1>
            <p className="wiz-sub">
              El nombre y el acento se aplican a toda la app. Se puede
              cambiar después en Settings.
            </p>
            <label className="ud-field">
              <span>Nombre de la app</span>
              <input className="cell-input" value={appName} autoFocus
                onChange={(e) => setAppName(e.target.value)} />
            </label>
            <label className="ud-field">
              <span>Tagline</span>
              <input className="cell-input" value={tagline}
                placeholder="Fleet compliance"
                onChange={(e) => setTagline(e.target.value)} />
            </label>
            <span className="ud-field"><span>Color de acento</span></span>
            <div className="wiz-accents" role="radiogroup"
              aria-label="Color de acento">
              {ACCENTS.map((a) => (
                <button key={a.label} type="button"
                  role="radio" aria-checked={accent === a.value}
                  title={a.label}
                  className={`wiz-accent ${accent === a.value ? 'on' : ''}`}
                  style={{ background: a.value || '#e11900' }}
                  onClick={() => setAccent(a.value)} />
              ))}
              <label className="wiz-accent-custom" title="Color personalizado">
                <input type="color"
                  value={accent || '#e11900'}
                  onChange={(e) => setAccent(e.target.value)} />
                <span>+</span>
              </label>
            </div>
            {error && <p className="wiz-error">{error}</p>}
            <div className="wiz-actions">
              <button className="btn btn-ghost" disabled={busy}
                onClick={() => setStep(2)}>
                Saltar
              </button>
              <button className="btn btn-primary" disabled={busy}
                onClick={saveCompany}>
                {busy ? 'Guardando…' : 'Continuar'}
              </button>
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
            <h1>Todo listo</h1>
            <p className="wiz-sub">
              Siguiente parada: <strong>Settings → Connectivity</strong> para
              conectar Samsara, email y SMS. El Live Map y el Dashboard se
              encienden solos con datos.
            </p>
            <div className="wiz-actions">
              <button className="btn btn-primary" onClick={onDone}>
                Entrar al panel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
