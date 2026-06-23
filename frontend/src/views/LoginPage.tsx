import { type FormEvent, useEffect, useState } from 'react'
import Logo from '../components/Logo'
import { authLogin, setToken, type AuthUser } from '../api'

type Props = {
  appName: string
  tagline: string
  onLogin: (user: AuthUser) => void
}

/**
 * Pantalla de acceso comercial. Hero con fotos rotativas (logística/flota),
 * copy de marketing y un panel de acceso premium.
 *
 * Las fotos son de Unsplash y son intercambiables: si una URL falla, el slide
 * cae con gracia al gradiente de marca (no se ve roto). Para cambiar el set,
 * edita SLIDES abajo.
 *
 * AUTENTICACIÓN REAL: handleSubmit llama a POST /api/auth/login, que valida
 * contra el backend (PBKDF2-SHA256 + token HMAC firmado). El token se guarda
 * en localStorage (ver api.ts) — pendiente migrar a cookie HttpOnly (SEC-4 en
 * docs/ROADMAP-SEGURIDAD.md). (Corregido: el comentario anterior afirmaba en
 * falso que no había endpoint de auth.)
 */

type Slide = {
  src: string
  alt: string
  eyebrow: string
  headline: string
  sub: string
}

const SLIDES: Slide[] = [
  {
    src: 'https://images.unsplash.com/photo-1601584115197-04ecc0da31d7?auto=format&fit=crop&w=1600&q=80',
    alt: 'Semi truck driving down a highway at sunset',
    eyebrow: 'Live compliance',
    headline: 'Your fleet, inspected to the minute',
    sub: 'Daily DVIR reports that build themselves from Samsara.',
  },
  {
    src: 'https://images.unsplash.com/photo-1519003722824-194d4455a60c?auto=format&fit=crop&w=1600&q=80',
    alt: 'Trucks parked at a freight terminal',
    eyebrow: 'Defects in real time',
    headline: 'Every open defect, on a single board',
    sub: 'Import the full list and notify drivers in seconds.',
  },
  {
    src: 'https://images.unsplash.com/photo-1586191582151-f73872dfd183?auto=format&fit=crop&w=1600&q=80',
    alt: 'Cab of a modern truck on the road',
    eyebrow: 'Preventive maintenance',
    headline: 'Stay ahead of the next PM',
    sub: 'Mileage-based tracking and alerts before service is due.',
  },
  {
    src: 'https://images.unsplash.com/photo-1591768793355-74d04bb6608f?auto=format&fit=crop&w=1600&q=80',
    alt: 'Fleet of cargo trucks seen from the front',
    eyebrow: 'Multi-terminal',
    headline: 'Every terminal, every unit',
    sub: 'One unified view of every terminal and every unit.',
  },
]

// Cifras reales del sistema (inventario vivo de Samsara): ~430 unidades
// clasificadas (trucks + trailers + chassis) en 5 terminales.
const STATS = [
  { v: '430+', k: 'Units tracked' },
  { v: '5', k: 'Terminals' },
  { v: 'Live', k: 'Samsara sync' },
]

export default function LoginPage({ appName, tagline, onLogin }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [slide, setSlide] = useState(0)
  const [broken, setBroken] = useState<Record<number, boolean>>({})

  // Auto-avance del carrusel cada 6s (se pausa si el usuario reduce movimiento)
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) return
    const id = window.setInterval(() => {
      setSlide((s) => (s + 1) % SLIDES.length)
    }, 6000)
    return () => window.clearInterval(id)
  }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!email.trim() || !password) {
      setError('Enter your username and password.')
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      const r = await authLogin(email.trim(), password)
      setToken(r.token)
      onLogin(r.user)
    } catch (err) {
      setError(err instanceof Error
        ? err.message : 'Couldn\'t sign in.')
    } finally {
      setSubmitting(false)
    }
  }

  const active = SLIDES[slide]

  return (
    <div className="login-screen">
      <div className="login-card">
        {/* ----- Hero de marca con fotos rotativas ----- */}
        <aside className="login-hero">
          <div className="login-hero-photos" aria-hidden="true">
            {SLIDES.map((s, i) => (
              <div
                key={s.src}
                className={`login-hero-photo ${i === slide ? 'is-active' : ''}`}
              >
                {!broken[i] && (
                  <img
                    src={s.src}
                    alt=""
                    loading={i === 0 ? 'eager' : 'lazy'}
                    onError={() => setBroken((b) => ({ ...b, [i]: true }))}
                  />
                )}
              </div>
            ))}
            <div className="login-hero-scrim" />
            <div className="login-hero-grain" />
          </div>

          <div className="login-hero-top">
            <span className="login-hero-logo">
              <Logo />
            </span>
            <span className="login-hero-brand">
              <strong>{appName}</strong>
              <small>{tagline}</small>
            </span>
          </div>

          <div className="login-hero-copy" key={slide}>
            <span className="login-hero-eyebrow">{active.eyebrow}</span>
            <h2>{active.headline}</h2>
            <p>{active.sub}</p>
          </div>

          <div className="login-hero-foot">
            <div className="login-hero-stats">
              {STATS.map((s) => (
                <div className="login-hero-stat" key={s.k}>
                  <strong>{s.v}</strong>
                  <span>{s.k}</span>
                </div>
              ))}
            </div>
            <div className="login-hero-dots" role="tablist" aria-label="Change image">
              {SLIDES.map((s, i) => (
                <button
                  key={s.src}
                  type="button"
                  className={`login-hero-dot ${i === slide ? 'is-active' : ''}`}
                  onClick={() => setSlide(i)}
                  aria-label={`Image ${i + 1}: ${s.alt}`}
                  aria-selected={i === slide}
                  role="tab"
                />
              ))}
            </div>
          </div>
        </aside>

        {/* ----- Panel de acceso ----- */}
        <section className="login-panel">
          <div className="login-panel-inner">
            <div className="login-panel-brand">
              <span className="login-panel-logo">
                <Logo />
              </span>
              <span>{appName}</span>
            </div>

            <span className="login-kicker">Dashboard access</span>
            <h1 className="login-title">Welcome back</h1>
            <p className="login-subtitle">
              Sign in to manage DVIR, defects and maintenance for your fleet.
            </p>

            <form className="login-form" onSubmit={handleSubmit}>
              <label className="login-field">
                <span>Username</span>
                <input
                  type="text"
                  autoComplete="username"
                  placeholder="your username"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    setError(null)
                  }}
                />
              </label>

              <label className="login-field">
                <span>Password</span>
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
                    aria-label={showPw ? 'Hide password' : 'Show password'}
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
                  <span>Remember me</span>
                </label>
                <a href="#" className="login-forgot" onClick={(e) => e.preventDefault()}>
                  Forgot your password?
                </a>
              </div>

              {error && <div className="login-error">{error}</div>}

              <button type="submit" className="login-submit"
                disabled={submitting}>
                <span>{submitting ? 'Signing in…' : 'Sign in'}</span>
                <span className="login-shimmer" />
              </button>
            </form>

            <p className="login-foot">
              Trouble signing in? Contact your administrator.
            </p>
          </div>
        </section>
      </div>
    </div>
  )
}
