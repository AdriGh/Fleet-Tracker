import { type FormEvent, useState } from 'react'
import Logo from '../components/Logo'

type Props = {
  onLogin: () => void
}

/**
 * Pantalla de login (UI). Adaptada de un componente de 21st.dev al sistema
 * de diseño de la app (CSS plano + variables de tema, sin Tailwind).
 *
 * NOTA: por ahora es una compuerta de front-end (no hay endpoint de auth en el
 * backend). Acepta cualquier credencial no vacía y marca la sesión en
 * localStorage. Para seguridad real hay que cablear un endpoint /auth.
 */
export default function LoginPage({ onLogin }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [glow, setGlow] = useState({ x: 50, y: 30, on: false })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!email.trim() || !password) {
      setError('Ingresa tu correo y contraseña.')
      return
    }
    setError(null)
    onLogin()
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        {/* Panel de marca con glow que sigue el cursor */}
        <aside
          className="login-brandpanel"
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setGlow({
              x: ((e.clientX - r.left) / r.width) * 100,
              y: ((e.clientY - r.top) / r.height) * 100,
              on: true,
            })
          }}
          onMouseLeave={() => setGlow((g) => ({ ...g, on: false }))}
        >
          <div
            className="login-glow"
            style={{
              opacity: glow.on ? 1 : 0,
              background: `radial-gradient(260px circle at ${glow.x}% ${glow.y}%, rgba(226,35,26,0.45), transparent 70%)`,
            }}
          />
          <div className="login-brand-top">
            <span className="login-logo">
              <Logo />
            </span>
            <span className="login-brand-name">Fleet Tracker</span>
          </div>
          <div className="login-brand-copy">
            <h2>
              Cumplimiento de flota, automatizado
              <span className="login-dot">.</span>
            </h2>
            <p>
              Reportes DVIR diarios, defectos y avisos — todo en un solo lugar.
            </p>
          </div>
          <div className="login-brand-foot">DVIR Report Generator</div>
        </aside>

        {/* Panel del formulario */}
        <section className="login-formpanel">
          <div className="login-form-inner">
            <h1 className="login-title">Iniciar sesión</h1>
            <p className="login-subtitle">Accede a tu panel de cumplimiento.</p>

            <form className="login-form" onSubmit={handleSubmit}>
              <label className="login-field">
                <span>Correo</span>
                <input
                  type="email"
                  autoComplete="email"
                  placeholder="tucorreo@empresa.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    setError(null)
                  }}
                />
              </label>

              <label className="login-field">
                <span>Contraseña</span>
                <div className="login-pw">
                  <input
                    type={showPw ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value)
                      setError(null)
                    }}
                  />
                  <button
                    type="button"
                    className="login-pw-toggle"
                    onClick={() => setShowPw((v) => !v)}
                    aria-label={showPw ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                  >
                    {showPw ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8" />
                        <path d="M9.4 5.2A9.5 9.5 0 0 1 12 5c5 0 9 4.5 10 7a13 13 0 0 1-2.2 3M6.1 6.1A13.4 13.4 0 0 0 2 12c1 2.5 5 7 10 7a9.6 9.6 0 0 0 3.7-.7" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                </div>
              </label>

              <div className="login-row">
                <label className="login-remember">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                  />
                  <span>Recordarme</span>
                </label>
                <a href="#" className="login-forgot" onClick={(e) => e.preventDefault()}>
                  ¿Olvidaste tu contraseña?
                </a>
              </div>

              {error && <div className="login-error">{error}</div>}

              <button type="submit" className="login-submit">
                <span>Entrar</span>
                <span className="login-shimmer" />
              </button>
            </form>

            <p className="login-foot">
              ¿Problemas para entrar? Contacta a tu administrador.
            </p>
          </div>
        </section>
      </div>
    </div>
  )
}
