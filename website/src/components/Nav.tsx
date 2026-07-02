import { useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { List, X } from '@phosphor-icons/react'
import Logo from './Logo'
import { APP_URL } from '../config'
import { btnPrimary, shell } from '../ui'

const LINKS = [
  { to: '/features', label: 'Features' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/about', label: 'About' },
]

export default function Nav() {
  const [open, setOpen] = useState(false)
  return (
    <header className="sticky top-0 z-50 border-b border-line/70 bg-bg/80 backdrop-blur-xl">
      <nav className={`${shell} flex h-16 items-center justify-between gap-6`}>
        <Link to="/" className="shrink-0" aria-label="Rigsmith home">
          <Logo />
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          {LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) =>
                `text-sm font-medium transition-colors ${
                  isActive ? 'text-ink' : 'text-muted hover:text-ink'
                }`
              }
            >
              {l.label}
            </NavLink>
          ))}
        </div>

        <div className="hidden items-center gap-4 md:flex">
          <a
            href={APP_URL}
            className="text-sm font-semibold text-muted transition-colors hover:text-ink"
          >
            Log in
          </a>
          <a href={APP_URL} className={btnPrimary}>
            Start free
          </a>
        </div>

        <button
          className="text-ink md:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          aria-controls="mobile-nav"
        >
          {open ? <X size={24} /> : <List size={24} />}
        </button>
      </nav>

      {open && (
        <div id="mobile-nav" className="border-t border-line/70 bg-bg md:hidden">
          <div className={`${shell} flex flex-col gap-1 py-4`}>
            {LINKS.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2.5 text-sm font-medium text-muted hover:bg-white/5 hover:text-ink"
              >
                {l.label}
              </NavLink>
            ))}
            <a href={APP_URL} className={`${btnPrimary} mt-2`}>
              Start free
            </a>
          </div>
        </div>
      )}
    </header>
  )
}
