import { Link } from 'react-router-dom'
import Logo from './Logo'
import { APP_URL } from '../config'
import { shell } from '../ui'

const COLS = [
  {
    title: 'Product',
    links: [
      { to: '/features', label: 'Features' },
      { to: '/pricing', label: 'Pricing' },
      { to: '/features', label: 'Integrations' },
    ],
  },
  {
    title: 'Company',
    links: [
      { to: '/about', label: 'About' },
      { to: '/about', label: 'Contact' },
    ],
  },
]

export default function Footer() {
  return (
    <footer className="border-t border-line/70 bg-surface/40">
      <div className={`${shell} grid gap-10 py-16 md:grid-cols-[1.5fr_1fr_1fr]`}>
        <div className="max-w-xs">
          <Logo />
          <p className="mt-4 text-sm leading-relaxed text-muted">
            Your fleet, forged right. DVIR, PM, work orders, and AI invoice
            scanning in one live dashboard, on top of the ELD you already run.
          </p>
        </div>
        {COLS.map((c) => (
          <div key={c.title}>
            <p className="text-sm font-semibold text-ink">{c.title}</p>
            <ul className="mt-4 space-y-3">
              {c.links.map((l, i) => (
                <li key={i}>
                  <Link
                    to={l.to}
                    className="text-sm text-muted transition-colors hover:text-ink"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div
        className={`${shell} flex flex-col gap-4 border-t border-line/60 py-6 sm:flex-row sm:items-center sm:justify-between`}
      >
        <p className="text-xs text-faint">
          © {new Date().getFullYear()} Rigsmith. All rights reserved.
        </p>
        <a
          href={APP_URL}
          className="text-xs font-semibold text-muted transition-colors hover:text-ink"
        >
          Log in to the app
        </a>
      </div>
    </footer>
  )
}
