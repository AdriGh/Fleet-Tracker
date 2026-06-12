import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createAppUser, fleetArchive, getAlertsSettings, getHealth,
  getIntegrationSpecs, getIntegrations, getOrg, getSettings, listAppUsers,
  listFleet, patchAppUser, saveAlertsSettings, saveIntegrationConfig,
  saveOrg, saveSettings, testIntegration,
  type AlertsSettings, type FleetUnit,
  type IntegrationProvider, type IntegrationSpec, type IntegrationStatus,
  type OrgConfig,
} from '../api'
import { notifyOk, notifyErr } from '../toast'
import Skeleton from '../components/Skeleton'
import Modal from '../components/Modal'
import RosterPage from './RosterPage'

const PAGE_SIZE = 50

type Props = {
  theme: 'light' | 'dark'
  onTheme: (t: 'light' | 'dark') => void
  onNavigate: (section: string) => void
  isAdmin?: boolean
}

export default function SettingsPage(
  { theme, onTheme, onNavigate, isAdmin = false }: Props,
) {
  const qc = useQueryClient()
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const fleetQuery = useQuery({ queryKey: ['fleet'], queryFn: listFleet })
  const integrationsQuery = useQuery({
    queryKey: ['integrations'], queryFn: getIntegrations })
  const healthQuery = useQuery({ queryKey: ['health'], queryFn: getHealth })

  // Default de privacidad del Roster (localStorage; el Roster lo lee al montar).
  const [maskPII, setMaskPII] = useState(
    () => localStorage.getItem('ft-roster-mask') !== '0',
  )
  const [rosterOpen, setRosterOpen] = useState(false)
  const [configuring, setConfiguring] = useState<string | null>(null)
  function toggleMask(on: boolean) {
    setMaskPII(on)
    localStorage.setItem('ft-roster-mask', on ? '1' : '0')
  }

  const [open, setOpen] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [days, setDays] = useState(30)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [modalOpen, setModalOpen] = useState(false)
  const [archiving, setArchiving] = useState(false)

  const allUnits = fleetQuery.data ?? []
  const archived = useMemo(
    () => allUnits
      .filter((u) => u.archived)
      .sort((a, b) => a.company.localeCompare(b.company)
        || a.unit.localeCompare(b.unit)),
    [allUnits])
  const activeUnits = useMemo(
    () => allUnits
      .filter((u) => !u.archived)
      .sort((a, b) => a.company.localeCompare(b.company)
        || a.unit.localeCompare(b.unit)),
    [allUnits])

  const archFiltered = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s
      ? archived.filter((u) => u.unit.toLowerCase().includes(s)
          || u.company.toLowerCase().includes(s))
      : archived
  }, [archived, q])
  const pages = Math.max(1, Math.ceil(archFiltered.length / PAGE_SIZE))
  const pageSafe = Math.min(page, pages)
  const pageRows = archFiltered.slice(
    (pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE)

  async function archiveAction(id: string, action: string) {
    setBusyId(id)
    try {
      await fleetArchive(id, action)
      await qc.invalidateQueries({ queryKey: ['fleet'] })
    } finally {
      setBusyId(null)
    }
  }

  async function archiveMany(ids: string[]) {
    setArchiving(true)
    try {
      for (const id of ids) await fleetArchive(id, 'archive')
      await qc.invalidateQueries({ queryKey: ['fleet'] })
      setModalOpen(false)
    } finally {
      setArchiving(false)
    }
  }

  // Sincronizar el formulario cuando llegan los settings.
  useEffect(() => {
    if (settingsQuery.data) {
      setEnabled(settingsQuery.data.auto_archive_enabled)
      setDays(settingsQuery.data.auto_archive_days)
    }
  }, [settingsQuery.data])

  const dirty = !!settingsQuery.data && (
    enabled !== settingsQuery.data.auto_archive_enabled ||
    days !== settingsQuery.data.auto_archive_days)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await saveSettings({
        auto_archive_enabled: enabled,
        auto_archive_days: Math.max(1, Math.min(days || 1, 365)),
      })
      await qc.invalidateQueries({ queryKey: ['settings'] })
      qc.invalidateQueries({ queryKey: ['fleet'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      notifyOk('Settings saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
      notifyErr('Couldn\'t save changes', e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="page-sub">Configure how Fleet Tracker behaves.</p>
        </div>
      </div>

      {error && <div className="banner error"><span>{error}</span></div>}

      {/* ----- Apariencia ----- */}
      <section className="card">
        <div className="card-head">
          <h2>Appearance</h2>
          <span className="sub">Theme for this device</span>
        </div>
        <div className="card-body">
          <div className="theme-pick" role="radiogroup" aria-label="Theme">
            <button
              className={`theme-opt ${theme === 'light' ? 'on' : ''}`}
              role="radio" aria-checked={theme === 'light'}
              onClick={() => onTheme('light')}
            >
              <span className="theme-swatch is-light">
                <span className="theme-swatch-bar" />
                <span className="theme-swatch-dot" />
              </span>
              <span className="theme-opt-text">
                <strong>Light</strong>
                <span>Bright surfaces, zinc neutrals</span>
              </span>
            </button>
            <button
              className={`theme-opt ${theme === 'dark' ? 'on' : ''}`}
              role="radio" aria-checked={theme === 'dark'}
              onClick={() => onTheme('dark')}
            >
              <span className="theme-swatch is-dark">
                <span className="theme-swatch-bar" />
                <span className="theme-swatch-dot" />
              </span>
              <span className="theme-opt-text">
                <strong>Dark</strong>
                <span>Layered charcoal, high contrast</span>
              </span>
            </button>
          </div>
        </div>
      </section>

      {/* ----- Conectividad: hub de integraciones ----- */}
      <section className="card">
        <div className="card-head">
          <h2>Connectivity</h2>
          <span className="sub">ELD platforms, messaging and data sources</span>
          <button className="btn-link" onClick={() => onNavigate('avisos')}>
            Open Notices →
          </button>
        </div>
        <div className="card-body">
          {integrationsQuery.isPending ? (
            <Skeleton h={220} />
          ) : integrationsQuery.error ? (
            <div className="empty mini">
              <p>Could not load integration status.</p>
            </div>
          ) : (
            <div className="intg">
              {integrationsQuery.data?.groups.map((g) => (
                <div className="intg-group" key={g.id}>
                  <div className="intg-group-head">
                    <h3>{g.label}</h3>
                    {g.note && <span className="intg-note">{g.note}</span>}
                  </div>
                  <div className="intg-grid">
                    {g.providers.map((p) => (
                      <IntegrationCard key={p.id} provider={p}
                        onConfigure={() => setConfiguring(p.id)} />
                    ))}
                  </div>
                </div>
              ))}
              <p className="settings-help" style={{ marginTop: 4 }}>
                Credentials live in <code>backend/*.local.json</code> (never
                committed). Configure writes them for you; tests never send
                anything.
              </p>
            </div>
          )}
          {configuring && (
            <IntegrationConfigModal provider={configuring}
              onClose={() => setConfiguring(null)}
              onSaved={() => {
                setConfiguring(null)
                qc.invalidateQueries({ queryKey: ['integrations'] })
                qc.invalidateQueries({ queryKey: ['integration-specs'] })
              }} />
          )}
        </div>
      </section>

      {/* ----- Empresa y usuarios (G7, solo admin) ----- */}
      {isAdmin && <CompanyCard />}
      {isAdmin && <UsersCard />}

      {/* ----- Alertas de flota (G3) ----- */}
      <AlertsCard />

      {/* ----- Roster + privacidad (datos sensibles, solo en Admin) ----- */}
      <section className="card settings-card">
        <button className="collapse-head" onClick={() => setRosterOpen((o) => !o)}
          aria-expanded={rosterOpen}>
          <svg className={`collapse-chevron ${rosterOpen ? 'open' : ''}`}
            viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="m9 18 6-6-6-6" />
          </svg>
          <div>
            <h2>Driver roster &amp; privacy</h2>
            <span className="sub">
              Active drivers, contacts and licenses
              {maskPII ? ' · masked by default' : ''}
            </span>
          </div>
        </button>

        {rosterOpen && (
          <div className="card-body">
            <label className="settings-toggle">
              <input type="checkbox" checked={maskPII}
                onChange={(e) => toggleMask(e.target.checked)} />
              <span>
                <strong>Mask sensitive data by default</strong>
                <span className="settings-sub">
                  Emails, phone numbers, licenses and usernames open masked
                  (j•••@g•••.com). Use the Reveal button below to view them
                  for the session. Exporting the CSV requires revealing first.
                </span>
              </span>
            </label>

            <hr className="settings-divider" />

            <RosterPage embedded />
          </div>
        )}
      </section>

      {/* ----- Archivo de unidades (existente) ----- */}
      <section className="card settings-card">
        <button className="collapse-head" onClick={() => setOpen((o) => !o)}
          aria-expanded={open}>
          <svg className={`collapse-chevron ${open ? 'open' : ''}`}
            viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="m9 18 6-6-6-6" />
          </svg>
          <div>
            <h2>Unit archive</h2>
            <span className="sub">
              Keep the Fleet list clean · {archived.length} archived
            </span>
          </div>
        </button>

        {open && (
          <div className="card-body">
            {settingsQuery.isPending ? (
              <Skeleton h={120} />
            ) : (
              <>
                <p className="settings-help">
                  Archived units are hidden from the Fleet list. You can archive
                  unused units or chassis by hand from <strong>Fleet</strong>,
                  and optionally auto-archive inactive units below.
                </p>

                <label className="settings-toggle">
                  <input type="checkbox" checked={enabled}
                    onChange={(e) => setEnabled(e.target.checked)} />
                  <span>
                    <strong>Auto-archive inactive units</strong>
                    <span className="settings-sub">
                      Archive a unit (truck or trailer) automatically when it
                      has no DVIR for the configured number of days.
                    </span>
                  </span>
                </label>

                <div className={`settings-days ${enabled ? '' : 'disabled'}`}>
                  <label>
                    Days without a DVIR
                    <input type="number" min={1} max={365} value={days}
                      disabled={!enabled}
                      onChange={(e) => setDays(Number(e.target.value))} />
                  </label>
                  <span className="settings-note">
                    Based on Samsara DVIR history: a DVIR covers the truck and
                    its attached trailer, so this applies to both.
                  </span>
                </div>

                <div className="settings-actions">
                  <button className="btn btn-primary" onClick={save}
                    disabled={!dirty || saving}>
                    {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save changes'}
                  </button>
                </div>
              </>
            )}

            <hr className="settings-divider" />

            <div className="archive-listhead">
              <h3 className="settings-sub-h">
                Archived units ({archived.length})
              </h3>
              <button className="btn btn-ghost btn-xs"
                onClick={() => setModalOpen(true)}>
                + Archive units
              </button>
            </div>

            <div className="filters-row archive-search">
              <input className="cell-input" placeholder="Search archived…"
                value={q}
                onChange={(e) => { setQ(e.target.value); setPage(1) }} />
              {q && (
                <button className="btn btn-ghost btn-xs"
                  onClick={() => { setQ(''); setPage(1) }}>Clear</button>
              )}
            </div>

            {fleetQuery.isPending ? (
              <div className="skel-rows">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} h={32} />
                ))}
              </div>
            ) : archived.length === 0 ? (
              <div className="empty mini">
                <p>No archived units. Use “+ Archive units” or the Fleet tab.</p>
              </div>
            ) : archFiltered.length === 0 ? (
              <div className="empty mini"><p>No matches.</p></div>
            ) : (
              <>
              <table className="defects-table fleet-table">
                <thead>
                  <tr>
                    <th>Unit</th>
                    <th>Company</th>
                    <th>Reason</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <span className="unit-cell">
                          <span>
                            <span className="unit-code">{u.unit}</span>
                            <span className="unit-kind">
                              {u.asset_type === 'unpowered'
                                ? 'trailer (unpowered)' : u.kind}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td>{u.company}</td>
                      <td>
                        <span className={`archive-tag ${u.archive_reason}`}>
                          {u.archive_reason === 'auto'
                            ? 'auto · no DVIR' : 'manual'}
                        </span>
                      </td>
                      <td className="num">
                        {busyId === u.id ? (
                          <span className="muted">…</span>
                        ) : u.archive_reason === 'manual' ? (
                          <button className="btn btn-ghost btn-xs"
                            onClick={() => archiveAction(u.id, 'unarchive')}>
                            Unarchive
                          </button>
                        ) : (
                          <button className="btn btn-ghost btn-xs"
                            onClick={() => archiveAction(u.id, 'keep_active')}>
                            Keep active
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {pages > 1 && (
                <div className="pager">
                  <button className="btn btn-ghost btn-xs" disabled={pageSafe <= 1}
                    onClick={() => setPage(pageSafe - 1)}>Prev</button>
                  <span>Page {pageSafe} of {pages} · {archFiltered.length} units</span>
                  <button className="btn btn-ghost btn-xs"
                    disabled={pageSafe >= pages}
                    onClick={() => setPage(pageSafe + 1)}>Next</button>
                </div>
              )}
              </>
            )}
          </div>
        )}
      </section>

      {/* ----- Acerca de ----- */}
      <section className="card">
        <div className="card-head">
          <h2>About</h2>
        </div>
        <div className="card-body">
          <div className="set-rows">
            <div className="set-row">
              <span className="set-row-label">App</span>
              <span className="set-row-value">Fleet Tracker · compliance suite</span>
            </div>
            <div className="set-row">
              <span className="set-row-label">Version</span>
              <span className="set-row-value mono">
                {healthQuery.data ? `v${healthQuery.data.version}` : '—'}
              </span>
              {healthQuery.data ? (
                <span className="set-badge is-ok">API connected</span>
              ) : (
                <span className="set-badge is-danger">API offline</span>
              )}
            </div>
            <div className="set-row">
              <span className="set-row-label">Data sources</span>
              <span className="set-row-value">
                Samsara (live) · DVIR/HoS CSVs · Fullbay PM
              </span>
            </div>
          </div>
        </div>
      </section>

      {modalOpen && (
        <Modal title="Archive units" width={560}
          onClose={() => setModalOpen(false)}>
          <ArchivePicker units={activeUnits} busy={archiving}
            onArchive={archiveMany} />
        </Modal>
      )}
    </div>
  )
}

// ----- Empresa (G7): branding, umbrales y CC routing -----------------------
const ORG_ACCENTS = ['', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0d9488']
const CC_TERMINALS = ['CHASER', 'MEM', 'MDW', 'MIA', 'ATL', 'SAV']
const THRESHOLD_META: {
  key: keyof OrgConfig['thresholds']
  label: string
  suffix: string
  help: string
}[] = [
  { key: 'dvir_min_minutes', label: 'Short pre-trip', suffix: 'min',
    help: 'Below this, the pre-trip flags red and notifies' },
  { key: 'pm_interval_miles', label: 'PM interval', suffix: 'mi',
    help: 'Miles between preventive services' },
  { key: 'pm_upcoming_miles', label: 'PM upcoming', suffix: 'mi',
    help: 'Remaining miles that flag a PM as Upcoming' },
  { key: 'defect_lookback_days', label: 'Defect window', suffix: 'days',
    help: 'How far back the live defect stream looks' },
]

function CompanyCard() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<OrgConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const q = useQuery({ queryKey: ['org'], queryFn: getOrg, enabled: open })

  useEffect(() => {
    if (q.data) setForm(JSON.parse(JSON.stringify(q.data)))
  }, [q.data])

  const dirty = !!form && !!q.data
    && JSON.stringify(form) !== JSON.stringify(q.data)

  async function save() {
    if (!form) return
    setSaving(true)
    try {
      const saved = await saveOrg(form)
      qc.setQueryData(['org'], saved)
      qc.invalidateQueries({ queryKey: ['auth-status'] })
      qc.invalidateQueries({ queryKey: ['pm'] })
      notifyOk('Company saved',
        'Branding and thresholds applied')
    } catch (e) {
      notifyErr('Couldn\'t save changes', e)
    } finally {
      setSaving(false)
    }
  }

  function setCc(terminal: string, raw: string) {
    if (!form) return
    const emails = raw.split(',').map((s) => s.trim()).filter(Boolean)
    const cc = { ...form.cc }
    if (emails.length) cc[terminal] = emails
    else delete cc[terminal]
    setForm({ ...form, cc })
  }

  return (
    <section className="card settings-card">
      <button className="collapse-head" onClick={() => setOpen((o) => !o)}
        aria-expanded={open}>
        <svg className={`collapse-chevron ${open ? 'open' : ''}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="m9 18 6-6-6-6" />
        </svg>
        <div>
          <h2>Company</h2>
          <span className="sub">
            Branding, business thresholds and notice CC routing
          </span>
        </div>
      </button>

      {open && (
        <div className="card-body">
          {q.isPending || !form ? (
            <Skeleton h={220} />
          ) : (
            <>
              <div className="org-grid">
                <label className="ud-field">
                  <span>App name</span>
                  <input className="cell-input"
                    value={form.branding.app_name}
                    onChange={(e) => setForm({ ...form,
                      branding: { ...form.branding,
                        app_name: e.target.value } })} />
                </label>
                <label className="ud-field">
                  <span>Tagline</span>
                  <input className="cell-input"
                    value={form.branding.tagline}
                    onChange={(e) => setForm({ ...form,
                      branding: { ...form.branding,
                        tagline: e.target.value } })} />
                </label>
              </div>

              <span className="ud-field" style={{ marginTop: 10 }}>
                <span>Accent color</span>
              </span>
              <div className="wiz-accents">
                {ORG_ACCENTS.map((a) => (
                  <button key={a || 'default'} type="button"
                    title={a || 'Factory red'}
                    className={`wiz-accent ${form.branding.accent === a ? 'on' : ''}`}
                    style={{ background: a || '#e11900' }}
                    onClick={() => setForm({ ...form,
                      branding: { ...form.branding, accent: a } })} />
                ))}
                <label className="wiz-accent-custom" title="Custom">
                  <input type="color"
                    value={form.branding.accent || '#e11900'}
                    onChange={(e) => setForm({ ...form,
                      branding: { ...form.branding,
                        accent: e.target.value } })} />
                  <span>+</span>
                </label>
              </div>

              <hr className="settings-divider" />

              <h3 className="settings-sub-h">Business thresholds</h3>
              <div className="org-thresholds">
                {THRESHOLD_META.map((m) => (
                  <label className="org-threshold" key={m.key}
                    title={m.help}>
                    <span className="org-th-label">{m.label}</span>
                    <span className="alert-rule-threshold">
                      <input type="number" min={1}
                        value={form.thresholds[m.key]}
                        onChange={(e) => setForm({ ...form,
                          thresholds: { ...form.thresholds,
                            [m.key]: Number(e.target.value) } })} />
                      <em>{m.suffix}</em>
                    </span>
                  </label>
                ))}
              </div>

              <hr className="settings-divider" />

              <h3 className="settings-sub-h">Notice CC routing</h3>
              <p className="settings-help">
                Comma-separated emails per terminal. Empty = factory
                default (Chaser/MCCI lists). "Always" goes on every
                notice.
              </p>
              <div className="org-cc">
                <label className="ud-field">
                  <span>Always CC</span>
                  <input className="cell-input"
                    value={(form.always_cc ?? []).join(', ')}
                    placeholder="factory default"
                    onChange={(e) => setForm({ ...form,
                      always_cc: e.target.value.split(',')
                        .map((s) => s.trim()).filter(Boolean) })} />
                </label>
                {CC_TERMINALS.map((t) => (
                  <label className="ud-field" key={t}>
                    <span>{t}</span>
                    <input className="cell-input"
                      value={(form.cc[t] ?? []).join(', ')}
                      placeholder="factory default"
                      onChange={(e) => setCc(t, e.target.value)} />
                  </label>
                ))}
              </div>

              <div className="settings-actions">
                <button className="btn btn-primary" onClick={save}
                  disabled={!dirty || saving}>
                  {saving ? 'Saving…' : 'Save company'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}

// ----- Usuarios (G7, solo admin) -------------------------------------------
const USER_ROLES = ['admin', 'dispatcher', 'mechanic', 'viewer']

function UsersCard() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const q = useQuery({
    queryKey: ['app-users'], queryFn: listAppUsers, enabled: open })
  const users = q.data ?? []

  const [nName, setNName] = useState('')
  const [nUser, setNUser] = useState('')
  const [nPass, setNPass] = useState('')
  const [nRole, setNRole] = useState('dispatcher')
  const [busy, setBusy] = useState(false)
  const [resetFor, setResetFor] = useState<number | null>(null)
  const [resetPw, setResetPw] = useState('')

  async function addUser() {
    if (!nName.trim() || !nUser.trim() || nPass.length < 8) {
      notifyErr('Missing fields',
        'Name, username and a password of 8+ characters')
      return
    }
    setBusy(true)
    try {
      await createAppUser({ name: nName.trim(), username: nUser.trim(),
        password: nPass, role: nRole })
      qc.invalidateQueries({ queryKey: ['app-users'] })
      setNName(''); setNUser(''); setNPass('')
      notifyOk('User created', nUser.trim())
    } catch (e) {
      notifyErr('Couldn\'t create user', e)
    } finally {
      setBusy(false)
    }
  }

  async function patch(id: number, p: Parameters<typeof patchAppUser>[1],
                       okMsg: string) {
    try {
      await patchAppUser(id, p)
      qc.invalidateQueries({ queryKey: ['app-users'] })
      notifyOk(okMsg)
    } catch (e) {
      notifyErr('Couldn\'t update', e)
    }
  }

  return (
    <section className="card settings-card">
      <button className="collapse-head" onClick={() => setOpen((o) => !o)}
        aria-expanded={open}>
        <svg className={`collapse-chevron ${open ? 'open' : ''}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="m9 18 6-6-6-6" />
        </svg>
        <div>
          <h2>Users</h2>
          <span className="sub">
            Accounts and roles{users.length ? ` · ${users.length}` : ''}
          </span>
        </div>
      </button>

      {open && (
        <div className="card-body">
          {q.isPending ? (
            <Skeleton h={140} />
          ) : (
            <>
              <table className="defects-table users-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Role</th>
                    <th>Active</th>
                    <th>Password</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className={u.active ? '' : 'is-off'}>
                      <td>
                        <span className="nf-driver-text">
                          <strong>{u.name || u.username}</strong>
                          <span className="nf-units">@{u.username}</span>
                        </span>
                      </td>
                      <td>
                        <select className="cell-input users-role"
                          value={u.role}
                          onChange={(e) => patch(u.id,
                            { role: e.target.value },
                            `Role for @${u.username}: ${e.target.value}`)}>
                          {USER_ROLES.map((r) => (
                            <option key={r} value={r}>{r}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input type="checkbox" checked={u.active}
                          onChange={(e) => patch(u.id,
                            { active: e.target.checked },
                            e.target.checked
                              ? `@${u.username} enabled`
                              : `@${u.username} disabled`)} />
                      </td>
                      <td>
                        {resetFor === u.id ? (
                          <span className="users-reset">
                            <input className="cell-input" type="password"
                              placeholder="New (8+)" value={resetPw}
                              onChange={(e) => setResetPw(e.target.value)} />
                            <button className="btn btn-ghost btn-xs"
                              disabled={resetPw.length < 8}
                              onClick={async () => {
                                await patch(u.id, { password: resetPw },
                                  `Password for @${u.username} changed`)
                                setResetFor(null); setResetPw('')
                              }}>OK</button>
                            <button className="icon-x"
                              onClick={() => {
                                setResetFor(null); setResetPw('')
                              }}>✕</button>
                          </span>
                        ) : (
                          <button className="btn btn-ghost btn-xs"
                            onClick={() => setResetFor(u.id)}>
                            Reset
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <hr className="settings-divider" />
              <h3 className="settings-sub-h">Add user</h3>
              <div className="users-add">
                <input className="cell-input" placeholder="Name"
                  value={nName} onChange={(e) => setNName(e.target.value)} />
                <input className="cell-input" placeholder="username"
                  value={nUser}
                  onChange={(e) => setNUser(
                    e.target.value.toLowerCase().replace(/\s/g, ''))} />
                <input className="cell-input" type="password"
                  placeholder="Password (8+)" value={nPass}
                  onChange={(e) => setNPass(e.target.value)} />
                <select className="cell-input users-role" value={nRole}
                  onChange={(e) => setNRole(e.target.value)}>
                  {USER_ROLES.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
                <button className="btn btn-primary btn-xs" onClick={addUser}
                  disabled={busy}>
                  {busy ? 'Creating…' : 'Add'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}

// ----- Alertas de flota (G3) ---------------------------------------------
const RULE_META: {
  key: keyof AlertsSettings['rules']
  label: string
  desc: string
  field: 'mph' | 'minutes' | 'pct' | 'hours' | 'deviation_f'
  suffix: string
}[] = [
  { key: 'speeding', label: 'Speeding', field: 'mph', suffix: 'mph',
    desc: 'Unit moving above the limit' },
  { key: 'idle', label: 'Excessive idle', field: 'minutes', suffix: 'min',
    desc: 'Engine in Idle continuously' },
  { key: 'low_fuel', label: 'Low fuel', field: 'pct', suffix: '%',
    desc: 'Fuel level at or below' },
  { key: 'low_def', label: 'Low DEF', field: 'pct', suffix: '%',
    desc: 'DEF level at or below' },
  { key: 'no_gps', label: 'No GPS signal', field: 'hours', suffix: 'h',
    desc: 'No GPS ping for this long' },
  { key: 'reefer_temp', label: 'Reefer temp deviation', field: 'deviation_f',
    suffix: '°F', desc: 'Return air away from setpoint (live data only)' },
]

function AlertsCard() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<AlertsSettings | null>(null)
  const q = useQuery({
    queryKey: ['alerts-settings'], queryFn: getAlertsSettings })

  useEffect(() => {
    if (q.data) setForm(JSON.parse(JSON.stringify(q.data)))
  }, [q.data])

  const dirty = !!form && !!q.data
    && JSON.stringify(form) !== JSON.stringify(q.data)
  const enabledCount = form
    ? Object.values(form.rules).filter((r) => r.enabled).length : 0

  async function save() {
    if (!form) return
    setSaving(true)
    try {
      const saved = await saveAlertsSettings(form)
      qc.setQueryData(['alerts-settings'], saved)
      notifyOk('Alert rules saved')
    } catch (e) {
      notifyErr('Couldn\'t save changes', e)
    } finally {
      setSaving(false)
    }
  }

  function setRule(key: keyof AlertsSettings['rules'],
                   patch: Partial<AlertsSettings['rules'][typeof key]>) {
    if (!form) return
    setForm({
      ...form,
      rules: { ...form.rules, [key]: { ...form.rules[key], ...patch } },
    })
  }

  return (
    <section className="card settings-card">
      <button className="collapse-head" onClick={() => setOpen((o) => !o)}
        aria-expanded={open}>
        <svg className={`collapse-chevron ${open ? 'open' : ''}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="m9 18 6-6-6-6" />
        </svg>
        <div>
          <h2>Fleet alerts</h2>
          <span className="sub">
            Speeding, idle, fuel, DEF and GPS rules
            {enabledCount ? ` · ${enabledCount} active` : ' · all off'}
          </span>
        </div>
      </button>

      {open && (
        <div className="card-body">
          {q.isPending || !form ? (
            <Skeleton h={180} />
          ) : (
            <>
              <p className="settings-help">
                Rules run every minute against the live Samsara feed.
                Events always show in the app (Dashboard + toasts); email
                and SMS are opt-in. Mute single units from their drawer in
                Fleet.
              </p>

              <div className="alert-rules">
                {RULE_META.map((m) => {
                  const rule = form.rules[m.key]
                  const val = rule[m.field] ?? 0
                  return (
                    <div className={`alert-rule ${rule.enabled ? 'on' : ''}`}
                      key={m.key}>
                      <label className="alert-rule-main">
                        <input type="checkbox" checked={rule.enabled}
                          onChange={(e) =>
                            setRule(m.key, { enabled: e.target.checked })} />
                        <span className="alert-rule-text">
                          <strong>{m.label}</strong>
                          <span>{m.desc}</span>
                        </span>
                      </label>
                      <span className="alert-rule-threshold">
                        <input type="number" min={1} value={val}
                          disabled={!rule.enabled}
                          onChange={(e) => setRule(m.key,
                            { [m.field]: Number(e.target.value) })} />
                        <em>{m.suffix}</em>
                      </span>
                    </div>
                  )
                })}
              </div>

              <hr className="settings-divider" />

              <div className="alert-channels">
                <span className="set-badge is-ok">In-app · always on</span>
                <label className="settings-toggle alert-ch">
                  <input type="checkbox" checked={form.channels.email}
                    onChange={(e) => setForm({ ...form,
                      channels: { ...form.channels,
                        email: e.target.checked } })} />
                  <span>
                    <strong>
                      Email
                      <span className="set-badge is-danger"
                        style={{ marginLeft: 8 }}>
                        sends for real
                      </span>
                    </strong>
                    <span className="settings-sub">
                      Sends alert digests to the addresses below.
                    </span>
                  </span>
                </label>
                <label className="settings-toggle alert-ch">
                  <input type="checkbox" checked={form.channels.sms}
                    onChange={(e) => setForm({ ...form,
                      channels: { ...form.channels,
                        sms: e.target.checked } })} />
                  <span>
                    <strong>SMS (Twilio)</strong>
                    <span className="settings-sub">
                      Simulated until Twilio credentials are configured.
                    </span>
                  </span>
                </label>

                <label className="ud-field alert-rcpt">
                  <span>Alert emails (comma separated)</span>
                  <input className="cell-input"
                    value={form.recipients.emails.join(', ')}
                    placeholder="safety@company.com, ops@company.com"
                    onChange={(e) => setForm({ ...form,
                      recipients: { ...form.recipients,
                        emails: e.target.value.split(',')
                          .map((s) => s.trim()).filter(Boolean) } })} />
                </label>
                <label className="ud-field alert-rcpt">
                  <span>Alert phones (comma separated)</span>
                  <input className="cell-input"
                    value={form.recipients.phones.join(', ')}
                    placeholder="3055551234, 9015555678"
                    onChange={(e) => setForm({ ...form,
                      recipients: { ...form.recipients,
                        phones: e.target.value.split(',')
                          .map((s) => s.trim()).filter(Boolean) } })} />
                </label>
              </div>

              <div className="settings-actions">
                <button className="btn btn-primary" onClick={save}
                  disabled={!dirty || saving}>
                  {saving ? 'Saving…' : 'Save alert rules'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}

const STATUS_BADGE: Record<IntegrationStatus, { label: string; cls: string }> = {
  connected: { label: 'Connected', cls: 'is-ok' },
  live: { label: 'LIVE', cls: 'is-danger' },
  dry_run: { label: 'Dry run', cls: 'is-muted' },
  not_configured: { label: 'Not configured', cls: 'is-off' },
  available: { label: 'Available', cls: 'is-info' },
  planned: { label: 'Coming soon', cls: 'is-off' },
}

// Glifos por proveedor: monograma para plataformas ELD, icono de la familia
// SVG de la app para canales y fuentes de datos.
function providerGlyph(id: string, name: string) {
  const stroke = {
    fill: 'none' as const, stroke: 'currentColor', strokeWidth: 1.8,
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  }
  switch (id) {
    case 'gmail':
      return (
        <svg viewBox="0 0 24 24" {...stroke}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m4 7 8 6 8-6" />
        </svg>
      )
    case 'twilio':
      return (
        <svg viewBox="0 0 24 24" {...stroke}>
          <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.6 0-3.1-.4-4.4-1.2L3 20l1.2-5.1A8.5 8.5 0 1 1 21 11.5z" />
        </svg>
      )
    case 'cloudinary':
      return (
        <svg viewBox="0 0 24 24" {...stroke}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="9" cy="10" r="1.6" />
          <path d="m4 18 5-5 4 4 3-3 4 4" />
        </svg>
      )
    case 'gsheets':
      return (
        <svg viewBox="0 0 24 24" {...stroke}>
          <rect x="4" y="3" width="16" height="18" rx="2" />
          <path d="M4 9h16M4 15h16M10 9v12" />
        </svg>
      )
    case 'fullbay':
      return (
        <svg viewBox="0 0 24 24" {...stroke}>
          <path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L4 16.8 7.2 20l5.3-5.3a4 4 0 0 0 5.2-5.4l-2.5 2.5-2.3-.5-.5-2.3z" />
        </svg>
      )
    default:
      return <span className="intg-mono">{name.slice(0, 1)}</span>
  }
}

function IntegrationCard({ provider, onConfigure }: {
  provider: IntegrationProvider
  onConfigure: () => void
}) {
  const badge = STATUS_BADGE[provider.status]
  const inactive =
    provider.status === 'planned' || provider.status === 'not_configured'
  const [testing, setTesting] = useState(false)

  async function runTest() {
    setTesting(true)
    try {
      const r = await testIntegration(provider.id)
      if (r.ok) notifyOk(`${provider.name}: connection OK`, r.detail)
      else notifyErr(`${provider.name}: test failed`, r.detail)
    } catch (e) {
      notifyErr(`${provider.name}: error`, e)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className={`intg-card ${inactive ? 'is-inactive' : ''}`}>
      <span className={`intg-ico ico-${provider.id}`}>
        {providerGlyph(provider.id, provider.name)}
      </span>
      <div className="intg-text">
        <span className="intg-name-row">
          <strong>{provider.name}</strong>
          <span
            className={`set-badge ${badge.cls}`}
            title={provider.status === 'live'
              ? 'This channel sends for real' : undefined}
          >
            {badge.label}
          </span>
        </span>
        <span className="intg-kind">{provider.kind}</span>
        <span className="intg-detail">{provider.detail}</span>
        {provider.items.length > 0 && (
          <span className="intg-chips">
            {provider.items.map((it) => (
              <span key={it.label} className="intg-chip">
                <strong>{it.label}</strong> {it.value}
              </span>
            ))}
          </span>
        )}
        {(provider.testable || provider.configurable) && (
          <span className="intg-actions">
            {provider.testable && (
              <button className="btn btn-ghost btn-xs" onClick={runTest}
                disabled={testing}>
                {testing ? 'Testing…' : 'Test'}
              </button>
            )}
            {provider.configurable && (
              <button className="btn btn-ghost btn-xs" onClick={onConfigure}>
                Configure
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  )
}

// ----- Modal de credenciales (G6) -----------------------------------------
function IntegrationConfigModal({ provider, onClose, onSaved }: {
  provider: string
  onClose: () => void
  onSaved: () => void
}) {
  const specsQ = useQuery({
    queryKey: ['integration-specs'], queryFn: getIntegrationSpecs })
  const spec: IntegrationSpec | undefined = specsQ.data?.[provider]
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [orgTokens, setOrgTokens] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      if (provider === 'samsara' && spec?.orgs) {
        await saveIntegrationConfig('samsara', {
          orgs: spec.orgs.map((o) => ({
            company: o.company,
            api_token: orgTokens[o.company] ?? '',
            trailer_dvirs: o.trailer_dvirs,
          })),
        })
      } else {
        await saveIntegrationConfig(provider, values)
      }
      notifyOk('Credentials saved',
        'Restart the app if the change does not show')
      onSaved()
    } catch (e) {
      notifyErr('Couldn\'t save changes', e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={spec?.title ?? 'Configure'} width={480} onClose={onClose}>
      {specsQ.isPending || !spec ? (
        <Skeleton h={160} />
      ) : (
        <div className="wo-form">
          <p className={`settings-help ${spec.danger ? 'intg-danger' : ''}`}>
            {spec.help}
          </p>

          {provider === 'samsara' && spec.orgs ? (
            spec.orgs.map((o) => (
              <label className="ud-field" key={o.company}>
                <span>{o.company} · current token {o.token_tail}</span>
                <input className="cell-input" type="password"
                  placeholder="Paste new token (empty = keep)"
                  value={orgTokens[o.company] ?? ''}
                  onChange={(e) => setOrgTokens(
                    { ...orgTokens, [o.company]: e.target.value })} />
              </label>
            ))
          ) : (
            (spec.fields ?? []).map((f) => (
              f.kind === 'toggle' ? (
                <label className="settings-toggle ud-toggle" key={f.key}>
                  <input type="checkbox"
                    checked={Boolean(values[f.key] ?? f.value)}
                    onChange={(e) => setValues(
                      { ...values, [f.key]: e.target.checked })} />
                  <span><strong>{f.label}</strong></span>
                </label>
              ) : (
                <label className="ud-field" key={f.key}>
                  <span>
                    {f.label}
                    {f.tail ? ` · current ${f.tail}` : ''}
                  </span>
                  <input className="cell-input" type={f.kind}
                    placeholder={f.tail
                      ? 'Empty = keep current' : ''}
                    value={String(values[f.key] ?? '')}
                    onChange={(e) => setValues(
                      { ...values, [f.key]: e.target.value })} />
                </label>
              )
            ))
          )}

          <div className="settings-actions">
            <button className="btn btn-primary" onClick={save}
              disabled={saving}>
              {saving ? 'Saving…' : 'Save credentials'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function ArchivePicker(
  { units, busy, onArchive }: {
    units: FleetUnit[]; busy: boolean; onArchive: (ids: string[]) => void
  },
) {
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s
      ? units.filter((u) => u.unit.toLowerCase().includes(s)
          || u.company.toLowerCase().includes(s))
      : units
  }, [units, q])
  const allOn = shown.length > 0 && shown.every((u) => picked.has(u.id))

  function toggle(id: string) {
    setPicked((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }
  function toggleAll() {
    setPicked((prev) => {
      const n = new Set(prev)
      if (allOn) shown.forEach((u) => n.delete(u.id))
      else shown.forEach((u) => n.add(u.id))
      return n
    })
  }

  return (
    <div className="export-picker">
      <input className="cell-input" placeholder="Search active units…"
        value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="ep-head">
        <label className="ep-all">
          <input type="checkbox" checked={allOn} onChange={toggleAll} />
          <span>{allOn ? 'Deselect all' : 'Select all'}</span>
        </label>
        <span className="ep-count">{picked.size} selected</span>
      </div>
      <ul className="ep-list">
        {shown.map((u) => (
          <li key={u.id}>
            <label className="ep-item">
              <input type="checkbox" checked={picked.has(u.id)}
                onChange={() => toggle(u.id)} />
              <span className="ep-unit">{u.unit}</span>
              <span className="ep-kind">
                {u.asset_type === 'unpowered' ? 'trailer (unpowered)' : u.kind}
              </span>
              <span className="ep-co">{u.company}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="ep-foot">
        <button className="btn btn-primary"
          disabled={picked.size === 0 || busy}
          onClick={() => onArchive([...picked])}>
          {busy ? 'Archiving…' : `Archive ${picked.size}`}
        </button>
      </div>
    </div>
  )
}
