// Drawer lateral (Vaul) con el detalle de una unidad: ficha del asset,
// defectos abiertos, device settings (apodo/grupo/mute de alertas/notas)
// y, si es camión, su estado de PM. Los datos se reusan de las queries
// en caché (open-defects, pm).
import { useEffect, useState } from 'react'
import { Drawer } from 'vaul'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createWorkOrder, fleetArchive, getUnitSettings, listOpenDefects,
  listPM, saveUnitSettings, type FleetUnit, type UnitSettings,
} from '../api'
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

  // Device settings (G3): apodo, grupo, mute de alertas, notas.
  const settingsQ = useQuery({
    queryKey: ['unit-settings', unit?.unit],
    queryFn: () => getUnitSettings(unit!.unit),
    enabled: open,
  })
  const [form, setForm] = useState<UnitSettings | null>(null)
  const [savingForm, setSavingForm] = useState(false)
  useEffect(() => {
    setForm(settingsQ.data ?? null)
  }, [settingsQ.data])

  const formDirty = !!form && !!settingsQ.data && (
    form.nickname !== settingsQ.data.nickname ||
    form.group !== settingsQ.data.group ||
    form.muted !== settingsQ.data.muted ||
    form.notes !== settingsQ.data.notes)

  async function saveForm() {
    if (!unit || !form) return
    setSavingForm(true)
    try {
      const saved = await saveUnitSettings(unit.unit, form)
      qc.setQueryData(['unit-settings', unit.unit], saved)
      qc.invalidateQueries({ queryKey: ['unit-settings-all'] })
      notifyOk('Profile saved', unit.unit)
    } catch (e) {
      notifyErr('Could not save the profile', e)
    } finally {
      setSavingForm(false)
    }
  }

  // Defecto -> Work Order (pipeline G5).
  const [creatingWo, setCreatingWo] = useState<number | null>(null)
  async function defectToWo(idx: number, detail: string, dvirType: string) {
    if (!unit) return
    setCreatingWo(idx)
    try {
      const title = (detail || `${dvirType} defect`).slice(0, 90)
      const wo = await createWorkOrder({
        unit: unit.unit,
        title,
        complaint: `From open defect (${dvirType || 'DVIR'}): ${detail}`,
        company: unit.company,
        source: 'defect',
      })
      qc.invalidateQueries({ queryKey: ['workorders'] })
      notifyOk('Work order created', `#${wo.id} · ${unit.unit} · open it in Work Orders`)
    } catch (e) {
      notifyErr('Could not create the work order', e)
    } finally {
      setCreatingWo(null)
    }
  }

  async function archive() {
    if (!unit) return
    setArchiving(true)
    try {
      await fleetArchive(unit.id, 'archive')
      await qc.invalidateQueries({ queryKey: ['fleet'] })
      qc.invalidateQueries({ queryKey: ['open-defects'] })
      qc.invalidateQueries({ queryKey: ['defect-stats'] })
      notifyOk('Unit archived', `${unit.unit} · excluded from defects`)
      onClose()
    } catch (e) {
      notifyErr('Could not archive the unit', e)
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
                        archived{unit.archive_reason ? ` · ${unit.archive_reason}` : ''}
                      </span>
                    )}
                  </span>
                </div>
                <button className="icon-btn" onClick={onClose} aria-label="Close">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
              <Drawer.Description className="sr-only">
                Details for unit {unit.unit}
              </Drawer.Description>

              <div className="ud-body">
                {/* Ficha del asset */}
                <section className="ud-sec">
                  <h3>Details</h3>
                  <Row label="Make / Model"
                    value={[unit.make, unit.model].filter(Boolean).join(' ') || '—'} />
                  <Row label="Year" value={unit.year || '—'} />
                  <Row label="VIN" value={<span className="mono">{unit.vin || '—'}</span>} />
                  <Row label="Plate" value={unit.plate || '—'} />
                  <Row label="Last DVIR" value={date(unit.last_dvir)} />
                </section>

                {/* Defectos abiertos */}
                <section className="ud-sec">
                  <h3>
                    Open defects
                    <span className="ud-count">{defects.length}</span>
                  </h3>
                  {defectsQ.isPending ? (
                    <p className="ud-muted">Loading…</p>
                  ) : defects.length === 0 ? (
                    <p className="ud-muted">No open defects</p>
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
                            <button className="btn btn-ghost btn-xs ud-towo"
                              title="Create a work order from this defect"
                              disabled={creatingWo === i}
                              onClick={() =>
                                defectToWo(i, d.detail, d.dvir_type)}>
                              {creatingWo === i ? 'Creating…' : '→ WO'}
                            </button>
                          </div>
                          <p className="ud-def-text">{d.detail || '—'}</p>
                          {d.driver && <span className="ud-def-by">{d.driver}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {/* Device settings (G3) */}
                <section className="ud-sec">
                  <h3>Device settings</h3>
                  {settingsQ.isPending || !form ? (
                    <p className="ud-muted">Loading…</p>
                  ) : (
                    <div className="ud-form">
                      <label className="ud-field">
                        <span>Nickname</span>
                        <input className="cell-input" value={form.nickname}
                          placeholder="e.g. The Beast"
                          onChange={(e) => setForm(
                            { ...form, nickname: e.target.value })} />
                      </label>
                      <label className="ud-field">
                        <span>Group</span>
                        <input className="cell-input" value={form.group}
                          placeholder="e.g. Reefer team"
                          onChange={(e) => setForm(
                            { ...form, group: e.target.value })} />
                      </label>
                      <label className="settings-toggle ud-toggle">
                        <input type="checkbox" checked={form.muted}
                          onChange={(e) => setForm(
                            { ...form, muted: e.target.checked })} />
                        <span>
                          <strong>Mute alerts</strong>
                          <span className="settings-sub">
                            This unit will not fire speeding, idle, fuel,
                            DEF or GPS alerts.
                          </span>
                        </span>
                      </label>
                      <label className="ud-field">
                        <span>Notes</span>
                        <textarea className="cell-input ud-notes"
                          value={form.notes} rows={2}
                          placeholder="Operational notes for this unit…"
                          onChange={(e) => setForm(
                            { ...form, notes: e.target.value })} />
                      </label>
                      {formDirty && (
                        <button className="btn btn-primary btn-xs ud-save"
                          onClick={saveForm} disabled={savingForm}>
                          {savingForm ? 'Saving…' : 'Save profile'}
                        </button>
                      )}
                    </div>
                  )}
                </section>

                {/* PM (solo camiones) */}
                {isTruck && (
                  <section className="ud-sec">
                    <h3>Maintenance (PM)</h3>
                    {pmQ.isPending ? (
                      <p className="ud-muted">Loading…</p>
                    ) : !pm ? (
                      <p className="ud-muted">No PM data.</p>
                    ) : (
                      <>
                        <Row label="Last PM"
                          value={`${date(pm.last_pm_date)} · ${miles(pm.last_pm_miles)}`} />
                        <Row label="Current mileage"
                          value={<>{miles(pm.current_miles)}
                            {pm.current_source && (
                              <span className="ud-src"> ({pm.current_source})</span>
                            )}</>} />
                        <Row label="Next PM" value={miles(pm.next_due_miles)} />
                        <Row label="Remaining" value={
                          <span className={`ud-rem ${pmTone}`}>
                            {remaining == null ? '—'
                              : remaining < 0
                                ? `overdue by ${miles(Math.abs(remaining))}`
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
                    {archiving ? 'Archiving…' : 'Archive / exclude unit'}
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
