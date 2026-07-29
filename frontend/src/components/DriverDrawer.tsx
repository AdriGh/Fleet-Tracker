// Drawer lateral (Vaul) con el detalle de un conductor: vencimientos de
// compliance editables, contacto, contrato, equipo asignado y su historial de
// DVIR. Se abre desde el buscador de conductores del topbar.
//
// Reemplaza a la página "Driver Compliance" (v2.11): el listado completo pasó a
// ser un agregado en Reports & Analytics, y al conductor individual se llega
// buscándolo. Junta las dos mitades que ya existían — el perfil editable que
// vivía en DriversPage y el historial de DVIR de DriverModal.
import { useEffect, useState } from 'react'
import { Drawer } from 'vaul'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getDriverHistory, listTmsDrivers, saveTmsDriver,
  type TmsDriverRow,
} from '../api'
import { notifyOk, notifyErr } from '../toast'
import { Button } from './ds'
import {
  DOCS, PAY_LABEL, ROLE_LABEL, expLabel, expTone, initials,
} from '../drivers'

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="ud-row">
      <span className="ud-k">{label}</span>
      <span className="ud-v">{value}</span>
    </div>
  )
}

export default function DriverDrawer(
  { name, onClose }: { name: string | null; onClose: () => void },
) {
  const open = !!name
  const qc = useQueryClient()

  // El roster ya está en caché (lo trae el buscador), así que abrir el drawer
  // no dispara otra request.
  const driversQ = useQuery({
    queryKey: ['tms-drivers'], queryFn: listTmsDrivers, enabled: open,
  })
  const driver = (driversQ.data ?? []).find((d) => d.name === name) ?? null

  // Historial de DVIR del conductor (lo que antes mostraba DriverModal).
  const histQ = useQuery({
    queryKey: ['driver-history', name],
    queryFn: () => getDriverHistory(name!),
    enabled: open,
  })

  const [form, setForm] = useState<TmsDriverRow | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => { setForm(driver ? { ...driver } : null) }, [driver])

  const dirty = !!form && !!driver
    && JSON.stringify(form) !== JSON.stringify(driver)

  async function save() {
    if (!form) return
    setSaving(true)
    try {
      await saveTmsDriver(form)
      await qc.invalidateQueries({ queryKey: ['tms-drivers'] })
      // El reporte de compliance depende de estas fechas.
      qc.invalidateQueries({ queryKey: ['driver-compliance'] })
      notifyOk('Profile saved', form.name)
    } catch (e) {
      notifyErr('Could not save the profile', e)
    } finally {
      setSaving(false)
    }
  }

  function field(key: keyof TmsDriverRow, label: string,
                 placeholder = '', type = 'text') {
    return (
      <label className="ud-field">
        <span>{label}</span>
        <input className="cell-input" type={type}
          value={String(form?.[key] ?? '')}
          placeholder={placeholder}
          onChange={(e) => form
            && setForm({ ...form, [key]: e.target.value })} />
      </label>
    )
  }

  return (
    <Drawer.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}
      direction="right">
      <Drawer.Portal>
        <Drawer.Overlay className="ud-overlay" />
        <Drawer.Content className="ud-content">
          <div className="ud-head">
            <div className="dd-head-id">
              <span className="nf-avatar dd-avatar">
                {initials(name || '')}
              </span>
              <div>
                <Drawer.Title className="ud-title">{name}</Drawer.Title>
                <p className="dd-sub">
                  {driver?.company || '—'}
                  {driver?.driver_company ? ` · ${driver.driver_company}` : ''}
                </p>
              </div>
            </div>
            <div className="ud-head-actions">
              {dirty && (
                <Button variant="primary" onClick={save} loading={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </Button>
              )}
              <button className="icon-btn" onClick={onClose}
                aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          <div className="ud-body">
            {!driver ? (
              <p className="modal-note">Loading…</p>
            ) : (
              <>
                {/* Compliance: las 4 fechas, editables en el lugar. */}
                <section className="ud-sec">
                  <h3>Compliance</h3>
                  <div className="dd-docs">
                    {DOCS.map((doc) => {
                      const v = String(form?.[doc.key] ?? '')
                      const tone = expTone(v)
                      return (
                        <div key={doc.label}
                          className={`dd-doc ${tone || 'none'}`}>
                          <span className="dd-doc-label">{doc.label}</span>
                          <input className="dd-doc-date" type="date" value={v}
                            onChange={(e) => form && setForm(
                              { ...form, [doc.key]: e.target.value })} />
                          <span className="dd-doc-state">{expLabel(v)}</span>
                        </div>
                      )
                    })}
                  </div>
                </section>

                {/* Contacto: read-only (viene del roster del ELD). Puede venir
                    enmascarado si el rol no tiene pii.view. */}
                <section className="ud-sec">
                  <h3>Contact</h3>
                  <Row label="Phone" value={driver.phone || '—'} />
                  <Row label="Email" value={
                    <span className="mono">{driver.email || '—'}</span>} />
                  <Row label="License" value={
                    <span className="mono">
                      {driver.license_number || '—'}
                      {driver.license_state ? ` · ${driver.license_state}` : ''}
                    </span>} />
                </section>

                {/* Equipo: el `truck` alimenta la columna Driver del board de
                    PM/DOT, así que se edita acá. */}
                <section className="ud-sec">
                  <h3>Equipment</h3>
                  <div className="dd-row2">
                    {field('truck', 'Truck', '412')}
                    {field('trailer', 'Trailer', '53108')}
                  </div>
                  <p className="dd-hint">
                    The assigned truck is what links this driver to the PM
                    &amp; DOT boards.
                  </p>
                </section>

                <section className="ud-sec">
                  <h3>Contract</h3>
                  {field('driver_company', "Driver's company (LLC)")}
                  <div className="dd-row2">
                    <label className="ud-field">
                      <span>Role</span>
                      <select className="cell-input" value={form?.role ?? ''}
                        onChange={(e) => form && setForm(
                          { ...form, role: e.target.value })}>
                        {Object.entries(ROLE_LABEL).map(([k, v]) => (
                          <option key={k} value={k}>{v}</option>
                        ))}
                      </select>
                    </label>
                    <label className="ud-field">
                      <span>Pay type</span>
                      <select className="cell-input" value={form?.pay_type ?? ''}
                        onChange={(e) => form && setForm(
                          { ...form, pay_type: e.target.value })}>
                        {Object.entries(PAY_LABEL).map(([k, v]) => (
                          <option key={k} value={k}>{v}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {form?.pay_type === 'percentage' && (
                    <label className="ud-field">
                      <span>Percentage (%)</span>
                      <input className="cell-input" type="number" min={0}
                        max={100} value={form.pay_pct}
                        onChange={(e) => setForm(
                          { ...form, pay_pct: Number(e.target.value) })} />
                    </label>
                  )}
                </section>

                <section className="ud-sec">
                  <h3>Personal</h3>
                  <div className="dd-row2">
                    {field('hired_date', 'Hired date', '', 'date')}
                    {field('emergency_name', 'Emergency contact')}
                  </div>
                  {field('emergency_phone', 'Emergency phone')}
                  <label className="ud-field">
                    <span>Notes</span>
                    <textarea className="cell-input ud-notes" rows={3}
                      value={form?.notes ?? ''}
                      placeholder="Special notes…"
                      onChange={(e) => form && setForm(
                        { ...form, notes: e.target.value })} />
                  </label>
                </section>

                {/* Historial de DVIR (lo que mostraba DriverModal). */}
                <section className="ud-sec">
                  <h3>DVIR history</h3>
                  {histQ.isPending ? (
                    <p className="modal-note">Loading…</p>
                  ) : histQ.error ? (
                    <p className="modal-note">
                      No DVIR history for this driver yet.
                    </p>
                  ) : (
                    <>
                      <Row label="Compliance"
                        value={`${histQ.data?.compliance_pct ?? 0}%`} />
                      <Row label="Days recorded"
                        value={`${histQ.data?.ok_days ?? 0} of ${histQ.data?.total_days ?? 0}`} />
                      <Row label="Days missed"
                        value={histQ.data?.missed_days ?? 0} />
                      <Row label="Reported defects"
                        value={histQ.data?.defects?.length ?? 0} />
                    </>
                  )}
                </section>
              </>
            )}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
