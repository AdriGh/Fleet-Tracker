// Drawer lateral (Vaul) con el detalle de una unidad: ficha del asset,
// defectos abiertos y, si es camión, su estado de PM. Los datos se reusan
// de las queries en caché (open-defects, pm).
import { useState } from 'react'
import { Drawer } from 'vaul'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fleetArchive, listOpenDefects, listPM, type FleetUnit } from '../api'
import { notifyOk, notifyErr } from '../toast'

const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, '')
const miles = (n: number | null | undefined) =>
  n == null ? '—' : `${n.toLocaleString('en-US')} mi`
const date = (s: string | null | undefined) =>
  s ? s.slice(0, 10) : '—'

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="ud-row">
      <span className="ud-k">{label}</span>
      <span className="ud-v">{value}</span>
    </div>
  )
}

export default function UnitDrawer(
  { unit, onClose }: { unit: FleetUnit | null; onClose: () => void },
) {
  const open = !!unit
  const isTruck = unit?.kind === 'truck'
  const qc = useQueryClient()
  const [archiving, setArchiving] = useState(false)

  async function archive() {
    if (!unit) return
    setArchiving(true)
    try {
      await fleetArchive(unit.id, 'archive')
      await qc.invalidateQueries({ queryKey: ['fleet'] })
      qc.invalidateQueries({ queryKey: ['open-defects'] })
      qc.invalidateQueries({ queryKey: ['defect-stats'] })
      notifyOk('Unidad archivada', `${unit.unit} — excluida de defectos`)
      onClose()
    } catch (e) {
      notifyErr('No se pudo archivar', e)
    } finally {
      setArchiving(false)
    }
  }

  const defectsQ = useQuery({
    queryKey: ['open-defects'], queryFn: listOpenDefects, enabled: open,
  })
  const pmQ = useQuery({
    queryKey: ['pm'], queryFn: listPM, enabled: open && isTruck,
  })

  const defects = unit
    ? (defectsQ.data ?? []).filter((d) => norm(d.unit) === norm(unit.unit))
    : []
  const pm = unit && isTruck
    ? (pmQ.data?.units ?? []).find((u) => norm(u.unit) === norm(unit.unit))
    : undefined

  const remaining = pm?.remaining ?? null
  const pmTone =
    remaining == null ? '' : remaining < 0 ? 'danger'
      : remaining < 2000 ? 'warn' : 'ok'

  return (
    <Drawer.Root direction="right" open={open}
      onOpenChange={(o) => { if (!o) onClose() }}>
      <Drawer.Portal>
        <Drawer.Overlay className="ud-overlay" />
        <Drawer.Content className="ud-content">
          {unit && (
            <>
              <div className="ud-head">
                <div>
                  <Drawer.Title className="ud-title">{unit.unit}</Drawer.Title>
                  <span className="ud-chiprow">
                    <span className="ud-chip">
                      {unit.asset_type === 'unpowered'
                        ? 'trailer (unpowered)' : unit.kind}
                    </span>
                    <span className="ud-chip">{unit.company}</span>
                    {unit.archived && (
                      <span className="ud-chip danger">
                        archivada{unit.archive_reason ? ` · ${unit.archive_reason}` : ''}
                      </span>
                    )}
                  </span>
                </div>
                <button className="icon-btn" onClick={onClose} aria-label="Cerrar">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
              <Drawer.Description className="sr-only">
                Detalle de la unidad {unit.unit}
              </Drawer.Description>

              <div className="ud-body">
                {/* Ficha del asset */}
                <section className="ud-sec">
                  <h3>Detalle</h3>
                  <Row label="Marca / Modelo"
                    value={[unit.make, unit.model].filter(Boolean).join(' ') || '—'} />
                  <Row label="Año" value={unit.year || '—'} />
                  <Row label="VIN" value={<span className="mono">{unit.vin || '—'}</span>} />
                  <Row label="Placa" value={unit.plate || '—'} />
                  <Row label="Último DVIR" value={date(unit.last_dvir)} />
                </section>

                {/* Defectos abiertos */}
                <section className="ud-sec">
                  <h3>
                    Defectos abiertos
                    <span className="ud-count">{defects.length}</span>
                  </h3>
                  {defectsQ.isPending ? (
                    <p className="ud-muted">Cargando…</p>
                  ) : defects.length === 0 ? (
                    <p className="ud-muted">Sin defectos abiertos 🎉</p>
                  ) : (
                    <ul className="ud-defects">
                      {defects.map((d, i) => (
                        <li key={i}>
                          <div className="ud-def-top">
                            <span className={`status-pill ${d.status.toLowerCase()}`}>
                              {d.status}
                            </span>
                            {(d.reports ?? 1) > 1 && (
                              <span className="ud-rep">×{d.reports}</span>
                            )}
                            {d.dvir_type && (
                              <span className="ud-type">{d.dvir_type}</span>
                            )}
                          </div>
                          <p className="ud-def-text">{d.detail || '—'}</p>
                          {d.driver && <span className="ud-def-by">{d.driver}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {/* PM (solo camiones) */}
                {isTruck && (
                  <section className="ud-sec">
                    <h3>Mantenimiento (PM)</h3>
                    {pmQ.isPending ? (
                      <p className="ud-muted">Cargando…</p>
                    ) : !pm ? (
                      <p className="ud-muted">Sin datos de PM.</p>
                    ) : (
                      <>
                        <Row label="Último PM"
                          value={`${date(pm.last_pm_date)} · ${miles(pm.last_pm_miles)}`} />
                        <Row label="Millaje actual"
                          value={<>{miles(pm.current_miles)}
                            {pm.current_source && (
                              <span className="ud-src"> ({pm.current_source})</span>
                            )}</>} />
                        <Row label="Próximo PM" value={miles(pm.next_due_miles)} />
                        <Row label="Restante" value={
                          <span className={`ud-rem ${pmTone}`}>
                            {remaining == null ? '—'
                              : remaining < 0
                                ? `vencido ${miles(Math.abs(remaining))}`
                                : miles(remaining)}
                          </span>
                        } />
                      </>
                    )}
                  </section>
                )}
              </div>

              {!unit.archived && (
                <div className="ud-foot">
                  <button className="btn btn-ghost ud-archive"
                    onClick={archive} disabled={archiving}>
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
                      stroke="currentColor" strokeWidth="1.8"
                      strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="4" width="18" height="4" rx="1" />
                      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
                    </svg>
                    {archiving ? 'Archivando…' : 'Archivar / excluir unidad'}
                  </button>
                </div>
              )}
            </>
          )}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
