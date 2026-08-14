// Centro de guías (v2.13, elemento 04 — PERMANENTE). Drawer lateral (Vaul,
// mismo patrón que DriverDrawer) con TODOS los tutoriales siempre accesibles
// + el checklist "Get set up" con progreso real del backend. Se abre desde la
// tarjeta de guías del Dashboard (decisión del founder: ahí y no en el
// sidebar).
import { useState } from 'react'
import { Drawer } from 'vaul'
import { useQuery } from '@tanstack/react-query'
import { getSetupStatus } from '../api'
import { GUIDES } from '../guides'
import { Button } from './ds'

export default function HelpCenter({ open, onClose, onNavigate }: {
  open: boolean
  onClose: () => void
  onNavigate: (section: string) => void
}) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const setupQ = useQuery({
    queryKey: ['setup-status'], queryFn: getSetupStatus, enabled: open,
  })
  const st = setupQ.data
  const go = (section: string) => { onClose(); onNavigate(section) }

  return (
    <Drawer.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}
      direction="right">
      <Drawer.Portal>
        <Drawer.Overlay className="ud-overlay" />
        <Drawer.Content className="ud-content hc-content">
          <div className="ud-head">
            <div>
              <Drawer.Title className="ud-title">Guides & setup</Drawer.Title>
              <p className="dd-sub">
                Short, honest walkthroughs of every flow. Always here.
              </p>
            </div>
          </div>
          <div className="ud-body">
            {/* Get set up: progreso real (cada paso se marca solo cuando el
                dato existe en el tenant — nada de checkboxes manuales). */}
            {st && st.done < st.total && (
              <section className="ud-sec hc-setup">
                <h3>Get set up · {st.done} of {st.total}</h3>
                <div className="hc-prog" role="progressbar"
                  aria-valuenow={st.done} aria-valuemax={st.total}>
                  <i style={{ width: `${(st.done / st.total) * 100}%` }} />
                </div>
                <ul className="hc-steps">
                  {st.steps.map((s) => (
                    <li key={s.key} className={s.done ? 'done' : ''}>
                      <span className="hc-check" aria-hidden="true">
                        {s.done ? '✓' : ''}
                      </span>
                      <span className="hc-step-label">{s.label}</span>
                      {!s.done && (
                        <button className="btn-link" onClick={() => go(s.section)}>
                          Go →
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="ud-sec">
              <h3>All guides</h3>
              <div className="hc-guides">
                {GUIDES.map((g) => {
                  const isOpen = expanded === g.id
                  return (
                    <div key={g.id}
                      className={`hc-guide ${isOpen ? 'open' : ''}`}>
                      <button className="hc-guide-head"
                        aria-expanded={isOpen}
                        onClick={() => setExpanded(isOpen ? null : g.id)}>
                        <span className="hc-guide-title">{g.title}</span>
                        <span className="hc-guide-meta">
                          {g.minutes} min · {g.sectionLabel}
                        </span>
                        <svg className="hc-chev" viewBox="0 0 24 24"
                          fill="none" stroke="currentColor" strokeWidth="2"
                          strokeLinecap="round" width="14" height="14">
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </button>
                      {isOpen && (
                        <div className="hc-guide-body">
                          <ol>
                            {g.steps.map((s, i) => <li key={i}>{s}</li>)}
                          </ol>
                          {g.tip && <p className="hc-tip">{g.tip}</p>}
                          <Button variant="ghost" onClick={() => go(g.section)}>
                            Open {g.sectionLabel} →
                          </Button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
