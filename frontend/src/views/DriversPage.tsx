import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  listTmsDrivers, saveTmsDriver,
  type TmsDriverRow,
} from '../api'
import { notifyOk, notifyErr } from '../toast'
import { Button } from '../components/ds'
import Skeleton from '../components/Skeleton'
import StatCard from '../components/StatCard'
import { StatCluster } from '../components/ds'

const ROLE_LABEL: Record<string, string> = {
  owner_operator: 'Owner Operator',
  company_driver: 'Company Driver',
  lease_operator: 'Lease Operator',
}
const PAY_LABEL: Record<string, string> = {
  percentage: 'Percentage',
  flat: 'Flat pay',
  mileage: 'Mileage',
  hourly: 'Hourly',
}

// Tarjetas de compliance (vencimientos) estilo QuickManage.
const DOCS: { key: keyof TmsDriverRow; label: string }[] = [
  { key: 'cdl_exp', label: 'CDL' },
  { key: 'med_exp', label: 'Med/Cert' },
  { key: 'mvr_exp', label: 'MVR' },
  { key: 'chouse_exp', label: 'C/House' },
]

function expTone(iso: string): string {
  if (!iso) return ''
  const days = (Date.parse(iso) - Date.now()) / 86_400_000
  if (Number.isNaN(days)) return ''
  if (days < 0) return 'danger'
  if (days < 30) return 'warn'
  return 'ok'
}

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2)
    .map((w) => w[0] ?? '').join('').toUpperCase()
}

export default function DriversPage() {
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const driversQ = useQuery({
    queryKey: ['tms-drivers'], queryFn: listTmsDrivers })
  const drivers = driversQ.data ?? []

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return drivers
    return drivers.filter((d) =>
      d.name.toLowerCase().includes(s) ||
      d.driver_company.toLowerCase().includes(s) ||
      d.truck.toLowerCase().includes(s) ||
      d.phone.includes(s))
  }, [drivers, q])

  const kpis = useMemo(() => ({
    total: drivers.length,
    oo: drivers.filter((d) => d.role === 'owner_operator'
      && d.has_profile).length,
    withProfile: drivers.filter((d) => d.has_profile).length,
    expiring: drivers.filter((d) => DOCS.some((doc) => {
      const t = expTone(String(d[doc.key] ?? ''))
      return t === 'danger' || t === 'warn'
    })).length,
  }), [drivers])

  const current = useMemo(
    () => drivers.find((d) => d.name === selected) ?? null,
    [drivers, selected])

  if (current) {
    return <DriverProfile driver={current}
      onBack={() => setSelected(null)} />
  }

  return (
    <div className="page page-wide">
      {driversQ.isFetching && <div className="loadbar" aria-hidden="true" />}
      <div className="page-head">
        <div>
          <h1>Driver Compliance</h1>
          <p className="page-sub">
            Roster, contracts, equipment and compliance dates.
          </p>
        </div>
        <div className="head-actions">
          <input className="cell-input" placeholder="Search driver, company, truck…"
            value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {driversQ.error && (
        <div className="banner error"><span>{String(driversQ.error)}</span></div>
      )}

      {driversQ.isPending ? (
        <StatCluster className="kpi-row">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} h={86} />)}
        </StatCluster>
      ) : (
        <StatCluster className="kpi-row">
          <StatCard label="Active drivers" value={kpis.total} tone="accent" />
          <StatCard label="Owner operators" value={kpis.oo} tone="info" />
          <StatCard label="With profile" value={kpis.withProfile}
            sub={`of ${kpis.total}`} tone="default"
            progress={kpis.total ? kpis.withProfile / kpis.total : undefined} />
          <StatCard label="Docs expiring" value={kpis.expiring}
            sub="within 30 days" tone={kpis.expiring ? 'warn' : 'ok'} />
        </StatCluster>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Drivers</h2>
          <span className="sub">{filtered.length} of {drivers.length}</span>
        </div>
        <div className="card-body">
          {driversQ.isPending ? (
            <div className="skel-rows">
              {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} h={42} />)}
            </div>
          ) : (
            <div className="table-wrap">
              <table className="defects-table tms-table">
                <thead>
                  <tr>
                    <th>Driver</th>
                    <th>Driver's company</th>
                    <th>Contract</th>
                    <th>Equipment</th>
                    <th>Compliance</th>
                    <th>Contact</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((d) => (
                    <tr key={d.name} onClick={() => setSelected(d.name)}>
                      <td>
                        <span className="nf-driver">
                          <span className="nf-avatar">{initials(d.name)}</span>
                          <span className="nf-driver-text">
                            <strong>{d.name}</strong>
                            <span className="nf-units">{d.company}</span>
                          </span>
                        </span>
                      </td>
                      <td className="tms-llc">
                        {d.driver_company || <span className="muted">—</span>}
                      </td>
                      <td>
                        {d.has_profile ? (
                          <span className="tms-contract">
                            <strong>
                              {d.pay_type === 'percentage'
                                ? `${d.pay_pct}%`
                                : PAY_LABEL[d.pay_type] ?? d.pay_type}
                            </strong>
                            <span>{ROLE_LABEL[d.role] ?? d.role}</span>
                          </span>
                        ) : (
                          <span className="muted">no profile</span>
                        )}
                      </td>
                      <td>
                        <span className="tms-equip">
                          {d.truck && <span className="ud-chip">{d.truck}</span>}
                          {d.trailer && <span className="ud-chip">{d.trailer}</span>}
                          {!d.truck && !d.trailer && (
                            <span className="muted">—</span>
                          )}
                        </span>
                      </td>
                      <td>
                        <span className="tms-docs">
                          {DOCS.map((doc) => {
                            const v = String(d[doc.key] ?? '')
                            const tone = expTone(v)
                            return (
                              <span key={doc.label}
                                className={`tms-doc ${tone}`}
                                title={v ? `${doc.label}: ${v}`
                                  : `${doc.label}: no date`}>
                                {doc.label}
                              </span>
                            )
                          })}
                        </span>
                      </td>
                      <td>
                        <span className="nf-contact">
                          <span className={d.phone ? '' : 'muted'}>
                            {d.phone || 'no phone'}
                          </span>
                          <span className={`mono ${d.email ? '' : 'muted'}`}>
                            {d.email || 'no email'}
                          </span>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

// ----- Perfil de driver (lugar de paso recurrente) ------------------------
function DriverProfile({ driver, onBack }: {
  driver: TmsDriverRow
  onBack: () => void
}) {
  const qc = useQueryClient()
  const [form, setForm] = useState<TmsDriverRow>({ ...driver })
  const [saving, setSaving] = useState(false)

  const dirty = JSON.stringify(form) !== JSON.stringify(driver)

  async function save() {
    setSaving(true)
    try {
      await saveTmsDriver(form)
      await qc.invalidateQueries({ queryKey: ['tms-drivers'] })
      notifyOk('Profile saved', driver.name)
    } catch (e) {
      notifyErr('Could not save', e)
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
          value={String(form[key] ?? '')}
          placeholder={placeholder}
          onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
      </label>
    )
  }

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div className="tms-profile-head">
          <span className="nf-avatar tms-avatar-lg">
            {initials(driver.name)}
          </span>
          <div>
            <h1>{driver.name}</h1>
            <p className="page-sub">
              {driver.company}
              {driver.driver_company ? ` · ${driver.driver_company}` : ''}
            </p>
          </div>
        </div>
        <div className="head-actions">
          {dirty && (
            <Button variant="primary" onClick={save} loading={saving}>
              {saving ? 'Saving…' : 'Save profile'}
            </Button>
          )}
          <Button variant="ghost" onClick={onBack}>
            ← Back to list
          </Button>
        </div>
      </div>

      {/* Tarjetas de compliance con vencimientos */}
      <div className="tms-comp-row">
        {DOCS.map((doc) => {
          const v = String(form[doc.key] ?? '')
          const tone = expTone(v)
          return (
            <div key={doc.label} className={`tms-comp ${tone}`}>
              <span className="tms-comp-label">{doc.label}</span>
              <input className="tms-comp-date" type="date" value={v}
                onChange={(e) => setForm(
                  { ...form, [doc.key]: e.target.value })} />
              <span className="tms-comp-state">
                {!v ? 'No date' : tone === 'danger' ? 'EXPIRED'
                  : tone === 'warn' ? 'Expiring soon' : 'Valid'}
              </span>
            </div>
          )
        })}
      </div>

      <div className="tms-cols">
        <section className="card">
          <div className="card-head"><h2>Personal</h2></div>
          <div className="card-body wo-form">
            <div className="set-rows">
              <div className="set-row">
                <span className="set-row-label">Phone</span>
                <span className="set-row-value">{driver.phone || '—'}</span>
              </div>
              <div className="set-row">
                <span className="set-row-label">Email</span>
                <span className="set-row-value mono">
                  {driver.email || '—'}
                </span>
              </div>
              <div className="set-row">
                <span className="set-row-label">License</span>
                <span className="set-row-value mono">
                  {driver.license_number || '—'}
                  {driver.license_state ? ` · ${driver.license_state}` : ''}
                </span>
              </div>
            </div>
            {field('hired_date', 'Hired date', '', 'date')}
            {field('emergency_name', 'Emergency contact')}
            {field('emergency_phone', 'Emergency phone', '305 555 1234')}
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h2>Contract</h2></div>
          <div className="card-body wo-form">
            {field('driver_company', "Driver's company (LLC)",
              '011 - FERDAL TRANSPORT INC')}
            <div className="wo-form-row">
              <label className="ud-field">
                <span>Role</span>
                <select className="cell-input" value={form.role}
                  onChange={(e) => setForm(
                    { ...form, role: e.target.value })}>
                  {Object.entries(ROLE_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="ud-field">
                <span>Pay type</span>
                <select className="cell-input" value={form.pay_type}
                  onChange={(e) => setForm(
                    { ...form, pay_type: e.target.value })}>
                  {Object.entries(PAY_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </label>
            </div>
            {form.pay_type === 'percentage' && (
              <label className="ud-field">
                <span>Percentage (%)</span>
                <input className="cell-input" type="number" min={0} max={100}
                  value={form.pay_pct}
                  onChange={(e) => setForm(
                    { ...form, pay_pct: Number(e.target.value) })} />
              </label>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h2>Equipment &amp; notes</h2></div>
          <div className="card-body wo-form">
            <div className="wo-form-row">
              {field('truck', 'Truck', '011')}
              {field('trailer', 'Trailer', '53206')}
            </div>
            <label className="ud-field">
              <span>Notes</span>
              <textarea className="cell-input ud-notes" rows={4}
                value={form.notes}
                placeholder="Special notes…"
                onChange={(e) => setForm(
                  { ...form, notes: e.target.value })} />
            </label>
          </div>
        </section>
      </div>
    </div>
  )
}
