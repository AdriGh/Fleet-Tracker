import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addCompany, assignTeam, assignTerminal, createAppUser, deleteCompany,
  deleteTeam, deleteTerminal,
  eldFleetPreview, fleetArchive, getAlertsSettings, getHealth,
  getIntegrationSpecs, getIntegrations, getOrg, getSettings, importUnitsCsv,
  listAppUsers, listCompanies,
  listFleet, patchAppUser, renameCompany, saveAlertsSettings,
  saveIntegrationConfig, saveOrg, saveSettings, saveTeam, saveTerminal,
  setEldActive,
  testIntegration, unitsCsvTemplate,
  type AlertsSettings, type Company, type Driver, type FleetUnit,
  type IntegrationGroup,
  type IntegrationProvider, type IntegrationSpec, type IntegrationStatus,
  type OrgConfig, type TeamDef, type TeamsConfig,
  type TerminalDef, type TerminalsConfig,
  type UnitImportResult,
} from '../api'
import { useTerminals } from '../terminal'
import { useTeams } from '../teams'
import FleetBoard from '../components/FleetBoard'
import { notifyOk, notifyErr } from '../toast'
import { Button } from '../components/ds'
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
  const [connOpen, setConnOpen] = useState(true)
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
          <p className="page-sub">Configure how Rigsmith behaves.</p>
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

      {/* ----- Conectividad: hub de integraciones (colapsable) ----- */}
      <section className="card settings-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="collapse-head" style={{ flex: 1 }}
            onClick={() => setConnOpen((o) => !o)} aria-expanded={connOpen}>
            <svg className={`collapse-chevron ${connOpen ? 'open' : ''}`}
              viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="m9 18 6-6-6-6" />
            </svg>
            <div>
              <h2>Integrations</h2>
              <span className="sub">
                Your ELD, messaging and data sources
              </span>
            </div>
          </button>
          <button className="btn-link" style={{ marginRight: 16,
            whiteSpace: 'nowrap' }} onClick={() => onNavigate('avisos')}>
            Open Notices →
          </button>
        </div>
        {connOpen && (
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
                g.id === 'eld' ? (
                  <EldGroup key={g.id} group={g}
                    onConfigure={(id) => setConfiguring(id)} />
                ) : (
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
                )
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
        )}
      </section>

      {/* ----- Empresa y usuarios (G7, solo admin) ----- */}
      {isAdmin && <CompanyCard />}
      {isAdmin && <CompaniesCard />}
      {isAdmin && <TerminalsCard activeUnits={activeUnits} />}
      {isAdmin && <TeamsCard activeUnits={activeUnits} />}
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
                    Based on the ELD DVIR history: a DVIR covers the truck and
                    its attached trailer, so this applies to both.
                  </span>
                </div>

                <div className="settings-actions">
                  <Button variant="primary" onClick={save} loading={saving}
                    disabled={!dirty || saving}>
                    {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save changes'}
                  </Button>
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
              <span className="set-row-value">Rigsmith · compliance suite</span>
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
                ELD (live) · DVIR/HoS CSVs
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

// ----- Empresas + import masivo de unidades (Settings, solo admin) ---------
function CompaniesCard() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const q = useQuery({
    queryKey: ['companies'], queryFn: listCompanies, enabled: open })
  const companies = q.data ?? []
  const [nLabel, setNLabel] = useState('')
  const [editKey, setEditKey] = useState<string | null>(null)
  const [eLabel, setELabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<UnitImportResult | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function run(p: Promise<Company[]>, ok: string) {
    setBusy(true)
    try {
      qc.setQueryData(['companies'], await p)
      notifyOk(ok)
      return true
    } catch (e) {
      notifyErr("Couldn't save companies", e)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function add() {
    if (!nLabel.trim()) {
      notifyErr('Missing name', 'Give the company a name')
      return
    }
    if (await run(addCompany(nLabel.trim()), `Company ${nLabel.trim()} added`)) {
      setNLabel('')
    }
  }
  async function saveEdit(c: Company) {
    if (await run(renameCompany(c.key, eLabel.trim() || c.label),
      'Company renamed')) setEditKey(null)
  }
  async function remove(c: Company) {
    if (!window.confirm(
      `Delete company ${c.label}? Existing units keep their company tag.`)) {
      return
    }
    await run(deleteCompany(c.key), `Company ${c.label} deleted`)
  }

  async function downloadTemplate() {
    try {
      const csv = await unitsCsvTemplate()
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
      const a = document.createElement('a')
      a.href = url
      a.download = 'fleet-units-template.csv'
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      notifyErr("Couldn't get the template", e)
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImporting(true)
    setResult(null)
    try {
      const res = await importUnitsCsv(await file.text())
      setResult(res)
      qc.invalidateQueries({ queryKey: ['fleet'] })
      qc.invalidateQueries({ queryKey: ['pm'] })
      notifyOk('Import done', `${res.added} added · ${res.updated} updated`)
    } catch (err) {
      notifyErr('Import failed', err)
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
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
          <h2>Companies &amp; fleet import</h2>
          <span className="sub">
            Carriers and bulk unit import (CSV)
          </span>
        </div>
      </button>

      {open && (
        <div className="card-body">
          {q.isPending ? (
            <Skeleton h={160} />
          ) : (
            <>
              <h3 className="settings-sub-h">Companies</h3>
              <p className="settings-help">
                Carriers that own units. Used across Fleet, Bill-To and
                reports.
              </p>
              <table className="defects-table users-table">
                <thead>
                  <tr>
                    <th>Company</th><th>Key</th><th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {companies.map((c) => (
                    <tr key={c.key}>
                      {editKey === c.key ? (
                        <>
                          <td>
                            <input className="cell-input" value={eLabel}
                              autoFocus
                              onChange={(e) => setELabel(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') saveEdit(c)
                                if (e.key === 'Escape') setEditKey(null)
                              }} />
                          </td>
                          <td><span className="nf-units">{c.key}</span></td>
                          <td className="num">
                            <span className="users-reset">
                              <button className="btn btn-primary btn-xs"
                                disabled={busy} onClick={() => saveEdit(c)}>
                                Save
                              </button>
                              <button className="btn btn-ghost btn-xs"
                                onClick={() => setEditKey(null)}>
                                Cancel
                              </button>
                            </span>
                          </td>
                        </>
                      ) : (
                        <>
                          <td><strong>{c.label}</strong></td>
                          <td><span className="nf-units">{c.key}</span></td>
                          <td className="num">
                            <span className="users-reset">
                              <button className="btn btn-ghost btn-xs"
                                onClick={() => {
                                  setEditKey(c.key); setELabel(c.label)
                                }}>
                                Rename
                              </button>
                              <button className="icon-x" title="Delete company"
                                onClick={() => remove(c)}>✕</button>
                            </span>
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                  {companies.length === 0 && (
                    <tr>
                      <td colSpan={3} className="muted"
                        style={{ textAlign: 'center', padding: 12 }}>
                        No companies yet. Add one below.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              <div className="settings-add-row">
                <input className="cell-input"
                  placeholder="New company name (e.g. Demo Co)"
                  value={nLabel} onChange={(e) => setNLabel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') add() }} />
                <button className="btn btn-primary btn-expand" disabled={busy}
                  onClick={add}>
                  <span className="btn-plus" aria-hidden>＋</span>
                  Add company
                </button>
              </div>

              <hr className="settings-divider" />

              <h3 className="settings-sub-h">Bulk import units (CSV)</h3>
              <p className="settings-help">
                Upload a CSV to add or update many units at once (e.g. every
                truck of a company). Required column: <code>unit</code>.
                Optional: <code>unit_type</code>, <code>company</code>,{' '}
                <code>terminal</code>, <code>vin</code>, <code>year</code>,{' '}
                <code>make</code>, <code>model</code>, <code>plate</code>,{' '}
                <code>plate_state</code>, <code>fleet_no</code>. Matches by
                unit number (upsert). Assign units to terminals in{' '}
                <strong>Terminals</strong> below or via the{' '}
                <code>terminal</code> column.
              </p>
              <div className="settings-actions" style={{ gap: 8 }}>
                <Button variant="ghost" onClick={downloadTemplate}>
                  Download template
                </Button>
                <label className="btn btn-primary btn-expand"
                  style={{ cursor: importing ? 'default' : 'pointer' }}>
                  {importing ? 'Importing…' : 'Upload CSV'}
                  <input ref={fileRef} type="file" accept=".csv,text/csv" hidden
                    disabled={importing} onChange={onFile} />
                </label>
              </div>
              {result && (
                <div className={`banner ${result.errors.length
                  ? 'warn' : 'success'}`}>
                  <span>
                    {result.added} added · {result.updated} updated
                    {result.errors.length > 0 && (
                      <>
                        {' '}· {result.errors.length} skipped
                        <br />{result.errors.slice(0, 5).join(' · ')}
                      </>
                    )}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}

function CompanyCard() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<OrgConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const q = useQuery({ queryKey: ['org'], queryFn: getOrg, enabled: open })
  const companiesQ = useQuery({
    queryKey: ['companies'], queryFn: listCompanies, enabled: open })
  // CC routing por terminal configurada (ya no listas hardcodeadas).
  const { terminals } = useTerminals()

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

  // H3-C: helpers para taller, invoice y Bill-To por empresa.
  function setShop(patch: Partial<OrgConfig['shop']>) {
    if (!form) return
    setForm({ ...form, shop: { ...form.shop, ...patch } })
  }
  function setInvoice(patch: Partial<OrgConfig['invoice']>) {
    if (!form) return
    setForm({ ...form, invoice: { ...form.invoice, ...patch } })
  }
  function setBilling(co: string, patch: Partial<OrgConfig['billing'][string]>) {
    if (!form) return
    setForm({ ...form, billing: {
      ...form.billing, [co]: { ...(form.billing[co] ?? {}), ...patch },
    } })
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
                <label className="org-threshold"
                  title="Default hourly labor rate for new work order labor lines (0 = none)">
                  <span className="org-th-label">Labor rate</span>
                  <span className="alert-rule-threshold">
                    <input type="number" min={0} step="0.5"
                      value={form.labor_rate}
                      onChange={(e) => setForm({ ...form,
                        labor_rate: Number(e.target.value) })} />
                    <em>$/hr</em>
                  </span>
                </label>
              </div>

              <hr className="settings-divider" />

              <h3 className="settings-sub-h">Notice CC routing</h3>
              <p className="settings-help">
                Comma-separated emails per terminal (from your{' '}
                <strong>Terminals</strong> below). Empty = factory default
                routing. "Always" goes on every notice.
              </p>
              <div className="org-cc">
                <label className="ud-field">
                  <span>Always CC</span>
                  <input className="cell-input"
                    value={(form.always_cc ?? []).join(', ')}
                    placeholder="every notice"
                    onChange={(e) => setForm({ ...form,
                      always_cc: e.target.value.split(',')
                        .map((s) => s.trim()).filter(Boolean) })} />
                </label>
                {terminals.map((t) => (
                  <label className="ud-field" key={t.key}>
                    <span>{t.label}</span>
                    <input className="cell-input"
                      value={(form.cc[t.key] ?? []).join(', ')}
                      placeholder="factory default"
                      onChange={(e) => setCc(t.key, e.target.value)} />
                  </label>
                ))}
              </div>

              <hr className="settings-divider" />

              <h3 className="settings-sub-h">Shop identity (invoice header)</h3>
              <p className="settings-help">
                The "From" on printed and emailed estimates/invoices. Empty
                name uses the app name.
              </p>
              <div className="org-grid">
                <label className="ud-field">
                  <span>Shop name</span>
                  <input className="cell-input" value={form.shop.name}
                    placeholder={form.branding.app_name}
                    onChange={(e) => setShop({ name: e.target.value })} />
                </label>
                <label className="ud-field">
                  <span>Phone</span>
                  <input className="cell-input" value={form.shop.phone}
                    onChange={(e) => setShop({ phone: e.target.value })} />
                </label>
                <label className="ud-field">
                  <span>Email</span>
                  <input className="cell-input" value={form.shop.email}
                    onChange={(e) => setShop({ email: e.target.value })} />
                </label>
                <label className="ud-field">
                  <span>Address</span>
                  <input className="cell-input" value={form.shop.address}
                    onChange={(e) => setShop({ address: e.target.value })} />
                </label>
                <label className="ud-field">
                  <span>City</span>
                  <input className="cell-input" value={form.shop.city}
                    onChange={(e) => setShop({ city: e.target.value })} />
                </label>
                <label className="ud-field">
                  <span>State</span>
                  <input className="cell-input" value={form.shop.state}
                    maxLength={2}
                    onChange={(e) =>
                      setShop({ state: e.target.value.toUpperCase() })} />
                </label>
                <label className="ud-field">
                  <span>ZIP</span>
                  <input className="cell-input" value={form.shop.zip}
                    onChange={(e) => setShop({ zip: e.target.value })} />
                </label>
              </div>

              <hr className="settings-divider" />

              <h3 className="settings-sub-h">Invoice</h3>
              <div className="org-grid">
                <label className="ud-field">
                  <span>Invoice prefix</span>
                  <input className="cell-input" value={form.invoice.prefix}
                    placeholder="e.g. INV-"
                    onChange={(e) => setInvoice({ prefix: e.target.value })} />
                </label>
                <label className="ud-field">
                  <span>Next invoice #</span>
                  <input className="cell-input" value={form.invoice.next_number}
                    readOnly title="Auto-increments on each new invoice" />
                </label>
                <label className="ud-field">
                  <span>Default terms</span>
                  <input className="cell-input" value={form.invoice.terms}
                    placeholder="e.g. Net 30 / COD"
                    onChange={(e) => setInvoice({ terms: e.target.value })} />
                </label>
              </div>
              <label className="ud-field" style={{ marginTop: 10 }}>
                <span>Invoice footer / notes</span>
                <textarea className="cell-input ud-notes" rows={2}
                  value={form.invoice.footer}
                  placeholder="Payment terms, thank-you note, remit-to…"
                  onChange={(e) => setInvoice({ footer: e.target.value })} />
              </label>

              <hr className="settings-divider" />

              <h3 className="settings-sub-h">Bill-To addresses</h3>
              <p className="settings-help">
                Per company that owns the unit. Empty = just the company
                name on the document. Manage companies in{' '}
                <strong>Companies &amp; fleet import</strong> below.
              </p>
              {(companiesQ.data?.length
                ? companiesQ.data
                : Object.keys(form.billing).map((k) => ({ key: k, label: k }))
              ).map(({ key: co, label }) => (
                <div className="org-billing" key={co}>
                  <span className="org-billing-co">{label}</span>
                  <div className="org-grid">
                    <label className="ud-field">
                      <span>Name</span>
                      <input className="cell-input" placeholder={co}
                        value={form.billing[co]?.name ?? ''}
                        onChange={(e) =>
                          setBilling(co, { name: e.target.value })} />
                    </label>
                    <label className="ud-field">
                      <span>Address</span>
                      <input className="cell-input"
                        value={form.billing[co]?.address ?? ''}
                        onChange={(e) =>
                          setBilling(co, { address: e.target.value })} />
                    </label>
                    <label className="ud-field">
                      <span>City</span>
                      <input className="cell-input"
                        value={form.billing[co]?.city ?? ''}
                        onChange={(e) =>
                          setBilling(co, { city: e.target.value })} />
                    </label>
                    <label className="ud-field">
                      <span>State</span>
                      <input className="cell-input" maxLength={2}
                        value={form.billing[co]?.state ?? ''}
                        onChange={(e) => setBilling(co,
                          { state: e.target.value.toUpperCase() })} />
                    </label>
                    <label className="ud-field">
                      <span>ZIP</span>
                      <input className="cell-input"
                        value={form.billing[co]?.zip ?? ''}
                        onChange={(e) =>
                          setBilling(co, { zip: e.target.value })} />
                    </label>
                    <label className="ud-field">
                      <span>Email (for sending)</span>
                      <input className="cell-input"
                        value={form.billing[co]?.email ?? ''}
                        onChange={(e) =>
                          setBilling(co, { email: e.target.value })} />
                    </label>
                  </div>
                </div>
              ))}

              <div className="settings-actions">
                <Button variant="primary" onClick={save} loading={saving}
                  disabled={!dirty || saving}>
                  {saving ? 'Saving…' : 'Save company'}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}

// ----- Usuarios (G7, solo admin) -------------------------------------------
// H4: 5 roles. 'safety' = cumplimiento (DVIR/PM/DOT, avisos, PII).
const USER_ROLES = ['admin', 'dispatcher', 'safety', 'mechanic', 'viewer']
// Resumen legible de lo que puede cada rol (se muestra bajo el selector).
const ROLE_HINTS: Record<string, string> = {
  admin: 'Full access, including company settings and users.',
  dispatcher: 'Work orders, invoicing, dispatch, notices, PII.',
  safety: 'Compliance: DVIR/PM/DOT, notices, driver PII. No invoicing/dispatch.',
  mechanic: 'Work orders, PM/DOT and fleet. No invoicing, notices or PII.',
  viewer: 'Read-only across the app.',
}

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
              <p className="settings-help">{ROLE_HINTS[nRole]}</p>
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
  field: 'mph' | 'minutes' | 'pct' | 'hours' | 'deviation_f' | 'min_severity'
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
  { key: 'reefer_fault_wo', label: 'Reefer fault → work order',
    field: 'min_severity', suffix: 'sev',
    desc: 'Auto-create a work order from reefer fault codes (severity ≥)' },
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
            Speeding, idle, fuel, DEF, GPS and cold-chain rules
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
                Rules run every minute against the live ELD feed.
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
                <Button variant="primary" onClick={save} loading={saving}
                  disabled={!dirty || saving}>
                  {saving ? 'Saving…' : 'Save alert rules'}
                </Button>
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

// Capacidades del adapter ELD -> etiqueta legible (orden de muestra).
const CAP_LABELS: [keyof NonNullable<IntegrationProvider['capabilities']>,
  string][] = [
  ['fleet', 'Fleet'], ['drivers', 'Drivers'], ['defects', 'Defects'],
  ['track', 'Live map'], ['reefer', 'Reefer'],
]

function IntegrationCard({ provider, onConfigure }: {
  provider: IntegrationProvider
  onConfigure: () => void
}) {
  const qc = useQueryClient()
  const badge = STATUS_BADGE[provider.status]
  const inactive =
    provider.status === 'planned' || provider.status === 'not_configured'
  const [testing, setTesting] = useState(false)
  const [busy, setBusy] = useState(false)
  const caps = provider.capabilities
  const liveCaps = caps ? CAP_LABELS.filter(([k]) => caps[k]) : []
  const canActivate = !!caps && !provider.active
    && (provider.status === 'connected' || provider.status === 'live')

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

  async function makeActive() {
    setBusy(true)
    try {
      await setEldActive(provider.id)
      notifyOk(`${provider.name} is now the active ELD`)
      qc.invalidateQueries({ queryKey: ['integrations'] })
    } catch (e) {
      notifyErr("Couldn't set active provider", e)
    } finally {
      setBusy(false)
    }
  }

  async function previewFleet() {
    setBusy(true)
    try {
      const r = await eldFleetPreview(provider.id)
      if (r.ok) {
        notifyOk(`${provider.name}: ${r.detail}`,
          r.sample.slice(0, 6).map((u) => u.unit).join(', ') || 'no units')
      } else {
        notifyErr(`${provider.name}: preview`, r.detail)
      }
    } catch (e) {
      notifyErr(`${provider.name}: preview failed`, e)
    } finally {
      setBusy(false)
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
          {provider.active && (
            <span className="set-badge is-ok"
              title="Default ELD data source">Active</span>
          )}
        </span>
        <span className="intg-kind">{provider.kind}</span>
        <span className="intg-detail">{provider.detail}</span>
        {liveCaps.length > 0 && (
          <span className="intg-chips">
            {liveCaps.map(([k, label]) => (
              <span key={k} className="intg-chip"><strong>{label}</strong></span>
            ))}
          </span>
        )}
        {provider.items.length > 0 && (
          <span className="intg-chips">
            {provider.items.map((it) => (
              <span key={it.label} className="intg-chip">
                <strong>{it.label}</strong> {it.value}
              </span>
            ))}
          </span>
        )}
        {(provider.testable || provider.configurable
          || provider.previewable || canActivate) && (
          <span className="intg-actions">
            {provider.testable && (
              <button className="btn btn-ghost btn-xs" onClick={runTest}
                disabled={testing}>
                {testing ? 'Testing…' : 'Test'}
              </button>
            )}
            {provider.previewable && (
              <button className="btn btn-ghost btn-xs" onClick={previewFleet}
                disabled={busy}>
                Preview fleet
              </button>
            )}
            {canActivate && (
              <button className="btn btn-ghost btn-xs" onClick={makeActive}
                disabled={busy}>
                Set active
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

// ----- Grupo ELD: UNA card + picker (rework Integrations, jul-3) -----------
// En vez de la grilla de vendors, se muestra solo la conexion ACTIVA (o un
// placeholder) y un unico boton "Connect your ELD" que abre el selector.
function EldGroup({ group, onConfigure }: {
  group: IntegrationGroup
  onConfigure: (id: string) => void
}) {
  const [picking, setPicking] = useState(false)
  // Solo cuenta como conexion la activa Y realmente configurada; si no,
  // placeholder generico (una instancia fresca no debe mostrar vendors).
  const active = group.providers.find(
    (p) => p.active && (p.status === 'connected' || p.status === 'live'),
  )
  return (
    <div className="intg-group">
      <div className="intg-group-head">
        <h3>ELD · Telematics</h3>
        <span className="intg-note">
          One connection feeds fleet, drivers, DVIR, odometers and the live
          map. Swap platforms anytime; your data stays.
        </span>
      </div>
      <div className="intg-grid">
        {active ? (
          <IntegrationCard provider={active}
            onConfigure={() => onConfigure(active.id)} />
        ) : (
          <div className="intg-card is-inactive">
            <span className="intg-ico">
              <span className="intg-mono">E</span>
            </span>
            <div className="intg-text">
              <span className="intg-name-row">
                <strong>Your ELD</strong>
                <span className="set-badge is-off">Not connected</span>
              </span>
              <span className="intg-kind">Telematics + ELD</span>
              <span className="intg-detail">
                Connect the ELD you already run to sync your fleet.
              </span>
            </div>
          </div>
        )}
      </div>
      <span className="intg-actions" style={{ marginTop: 10 }}>
        <button className="btn btn-ghost btn-xs"
          onClick={() => setPicking(true)}>
          {active ? 'Change ELD' : 'Connect your ELD'}
        </button>
      </span>
      {picking && (
        <EldPickerModal providers={group.providers}
          onClose={() => setPicking(false)}
          onConfigure={(id) => { setPicking(false); onConfigure(id) }} />
      )}
    </div>
  )
}

function EldPickerModal({ providers, onClose, onConfigure }: {
  providers: IntegrationProvider[]
  onClose: () => void
  onConfigure: (id: string) => void
}) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState('')

  async function makeActive(p: IntegrationProvider) {
    setBusy(p.id)
    try {
      await setEldActive(p.id)
      notifyOk(`${p.name} is now your active ELD`)
      qc.invalidateQueries({ queryKey: ['integrations'] })
      onClose()
    } catch (e) {
      notifyErr("Couldn't set the active ELD", e)
    } finally {
      setBusy('')
    }
  }

  return (
    <Modal title="Connect your ELD" onClose={onClose} width={560}>
      <p className="settings-help" style={{ marginBottom: 12 }}>
        Pick the platform your fleet already runs. Configure its credentials,
        test the connection, then set it active.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {providers.map((p) => {
          const badge = STATUS_BADGE[p.status]
          const connected =
            p.status === 'connected' || p.status === 'live'
          return (
            <div key={p.id} className="intg-card"
              style={{ alignItems: 'center' }}>
              <div className="intg-text">
                <span className="intg-name-row">
                  <strong>{p.name}</strong>
                  <span className={`set-badge ${badge.cls}`}>{badge.label}</span>
                  {p.active && (
                    <span className="set-badge is-ok">Active</span>
                  )}
                </span>
                <span className="intg-detail">{p.detail}</span>
              </div>
              <span className="intg-actions" style={{ flex: 'none' }}>
                {p.configurable && (
                  <button className="btn btn-ghost btn-xs"
                    onClick={() => onConfigure(p.id)}>
                    Configure
                  </button>
                )}
                {connected && !p.active && (
                  <button className="btn btn-ghost btn-xs"
                    disabled={busy === p.id}
                    onClick={() => makeActive(p)}>
                    Set active
                  </button>
                )}
              </span>
            </div>
          )
        })}
      </div>
    </Modal>
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
            <button className="btn btn-primary btn-expand" onClick={save}
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

// ----- Terminales dinámicas: regiones + flota asignada (solo admin) --------
function TerminalsCard({ activeUnits }: { activeUnits: FleetUnit[] }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const { cfg, terminals, terminalOf, labelOf } = useTerminals()
  const [board, setBoard] = useState<{ focus: string | null } | null>(null)
  const [editKey, setEditKey] = useState<string | null>(null)
  const [eLabel, setELabel] = useState('')
  const [ePrefixes, setEPrefixes] = useState('')
  const [nLabel, setNLabel] = useState('')
  const [nPrefixes, setNPrefixes] = useState('')
  const [busy, setBusy] = useState(false)

  // Unidades efectivas por terminal (asignación o prefijo) y pinneadas.
  const counts = useMemo(() => {
    const eff: Record<string, number> = {}
    for (const u of activeUnits) {
      const k = terminalOf(u.unit, u.company)
      eff[k] = (eff[k] ?? 0) + 1
    }
    const pinned: Record<string, number> = {}
    for (const t of Object.values(cfg.assignments)) {
      pinned[t] = (pinned[t] ?? 0) + 1
    }
    return { eff, pinned }
  }, [activeUnits, terminalOf, cfg])

  const parsePrefixes = (raw: string) =>
    raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)

  async function persist(
    run: () => Promise<TerminalsConfig>, ok: string,
  ): Promise<boolean> {
    setBusy(true)
    try {
      qc.setQueryData(['terminals'], await run())
      notifyOk(ok)
      return true
    } catch (e) {
      notifyErr("Couldn't save terminals", e)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function addTerminal() {
    if (!nLabel.trim()) {
      notifyErr('Missing name', 'Give the terminal a name')
      return
    }
    if (await persist(
      () => saveTerminal({ label: nLabel.trim(),
        prefixes: parsePrefixes(nPrefixes) }),
      `Terminal ${nLabel.trim()} created`,
    )) {
      setNLabel(''); setNPrefixes('')
    }
  }

  async function saveEdit(t: TerminalDef) {
    if (await persist(
      () => saveTerminal({ key: t.key, label: eLabel.trim() || t.label,
        prefixes: parsePrefixes(ePrefixes) }),
      `Terminal ${eLabel.trim() || t.label} saved`,
    )) setEditKey(null)
  }

  async function remove(t: TerminalDef) {
    const pinned = counts.pinned[t.key] ?? 0
    if (!window.confirm(
      `Delete terminal ${t.label}?` +
      (pinned ? ` ${pinned} pinned unit${pinned === 1 ? '' : 's'} will`
        + ' go back to prefix rules.' : ''))) return
    await persist(() => deleteTerminal(t.key), `Terminal ${t.label} deleted`)
  }

  // Guarda el tablero: reconciliando todas las terminales de una vez.
  // assign() reemplaza el set pinneado de cada terminal, así que iteramos
  // todas (incluso las vacías) para soltar los pins removidos. Los pines de
  // unidades archivadas (no visibles en el board) se preservan aparte.
  async function commitBoard(placement: Record<string, string[]>) {
    setBusy(true)
    try {
      const activeSet = new Set(activeUnits.map((u) => u.unit))
      const hidden: Record<string, string[]> = {}
      for (const [unit, key] of Object.entries(cfg.assignments)) {
        if (!activeSet.has(unit)) (hidden[key] ??= []).push(unit)
      }
      let last: TerminalsConfig | null = null
      for (const t of terminals) {
        last = await assignTerminal(t.key,
          [...(placement[t.key] ?? []), ...(hidden[t.key] ?? [])])
      }
      if (last) qc.setQueryData(['terminals'], last)
      notifyOk('Fleet board saved')
      setBoard(null)
    } catch (e) {
      notifyErr("Couldn't save terminals", e)
    } finally {
      setBusy(false)
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
          <h2>Terminals</h2>
          <span className="sub">
            Regions and their assigned fleet · {terminals.length}
          </span>
        </div>
      </button>

      {open && (
        <div className="card-body">
          <p className="settings-help">
            Terminals group the fleet by yard or region, and drive the
            terminal filters in PM Tracker, DOT Inspections, Work Orders,
            Fleet and Defects. A unit lands in a terminal by its pinned
            assignment first, then by unit-number prefix (e.g.
            <code>MEM</code> matches <code>MEM-123</code>).
          </p>

          <div className="settings-actions" style={{ marginBottom: 12 }}>
            <Button variant="primary"
              onClick={() => setBoard({ focus: null })}
              icon={<span className="btn-plus" aria-hidden>⠿</span>}>
              Open fleet board
            </Button>
          </div>

          <table className="defects-table users-table">
            <thead>
              <tr>
                <th>Terminal</th>
                <th>Prefixes</th>
                <th>Units</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {terminals.map((t) => (
                <tr key={t.key}>
                  {editKey === t.key ? (
                    <>
                      <td>
                        <input className="cell-input" value={eLabel}
                          autoFocus placeholder={t.label}
                          onChange={(e) => setELabel(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit(t)
                            if (e.key === 'Escape') setEditKey(null)
                          }} />
                      </td>
                      <td>
                        <input className="cell-input" value={ePrefixes}
                          placeholder="MEM, ATL…"
                          onChange={(e) => setEPrefixes(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit(t)
                            if (e.key === 'Escape') setEditKey(null)
                          }} />
                      </td>
                      <td colSpan={2}>
                        <span className="users-reset">
                          <button className="btn btn-primary btn-xs"
                            disabled={busy} onClick={() => saveEdit(t)}>
                            Save
                          </button>
                          <button className="btn btn-ghost btn-xs"
                            onClick={() => setEditKey(null)}>
                            Cancel
                          </button>
                        </span>
                      </td>
                    </>
                  ) : (
                    <>
                      <td>
                        <span className="nf-driver-text">
                          <strong>{t.label}</strong>
                          <span className="nf-units">{t.key}</span>
                        </span>
                      </td>
                      <td>
                        {t.prefixes.length
                          ? t.prefixes.join(', ')
                          : <span className="muted">—</span>}
                      </td>
                      <td>
                        {counts.eff[t.key] ?? 0}
                        {(counts.pinned[t.key] ?? 0) > 0 && (
                          <span className="muted">
                            {' '}· {counts.pinned[t.key]} pinned
                          </span>
                        )}
                      </td>
                      <td className="num">
                        <span className="users-reset">
                          <button className="btn btn-ghost btn-xs"
                            onClick={() => setBoard({ focus: t.key })}>
                            Assign fleet
                          </button>
                          <button className="btn btn-ghost btn-xs"
                            onClick={() => {
                              setEditKey(t.key)
                              setELabel(t.label)
                              setEPrefixes(t.prefixes.join(', '))
                            }}>
                            Edit
                          </button>
                          <button className="icon-x" title="Delete terminal"
                            onClick={() => remove(t)}>✕</button>
                        </span>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          <hr className="settings-divider" />
          <h3 className="settings-sub-h">Add terminal</h3>
          <div className="settings-add-row">
            <input className="cell-input" placeholder="Name (e.g. Dallas)"
              value={nLabel} onChange={(e) => setNLabel(e.target.value)} />
            <input className="cell-input"
              placeholder="Prefixes, comma separated (e.g. DAL)"
              value={nPrefixes}
              onChange={(e) => setNPrefixes(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addTerminal() }} />
            <button className="btn btn-primary btn-expand" onClick={addTerminal}
              disabled={busy}>
              <span className="btn-plus" aria-hidden>＋</span>
              {busy ? 'Saving…' : 'Add terminal'}
            </button>
          </div>
          <p className="settings-help">
            Prefixes are optional: you can also pin any unit with
            “Assign fleet”. Pinned units win over prefixes.
          </p>
        </div>
      )}

      {board && (
        <Modal title="Fleet board — Terminals" width={1060} fullHeight
          onClose={() => setBoard(null)}>
          <FleetBoard kind="terminal" busy={busy} focusKey={board.focus}
            units={activeUnits}
            columns={terminals.map((t) => ({ key: t.key, label: t.label }))}
            initialOf={(unit) => cfg.assignments[unit] ?? ''}
            autoHintOf={(u) => cfg.assignments[u.unit]
              ? undefined
              : `auto: ${labelOf(terminalOf(u.unit, u.company))}`}
            onCommit={commitBoard} />
        </Modal>
      )}
    </section>
  )
}

// ----- Equipos: grupos de unidades + conductores (solo admin) ------------
function TeamsCard({ activeUnits }: { activeUnits: FleetUnit[] }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const { cfg, teams, teamOf } = useTeams()
  const [board, setBoard] = useState<{ focus: string | null } | null>(null)
  const [editing, setEditing] = useState<TeamDef | null>(null)
  const [nLabel, setNLabel] = useState('')
  const [busy, setBusy] = useState(false)

  // Unidades efectivas por equipo (de la flota activa) y total pinneado
  // (incluye archivadas, que no aparecen en activeUnits).
  const counts = useMemo(() => {
    const eff: Record<string, number> = {}
    for (const u of activeUnits) {
      const k = teamOf(u.unit)
      if (k) eff[k] = (eff[k] ?? 0) + 1
    }
    const total: Record<string, number> = {}
    for (const t of Object.values(cfg.members)) {
      total[t] = (total[t] ?? 0) + 1
    }
    return { eff, total }
  }, [activeUnits, teamOf, cfg])

  async function persist(
    run: () => Promise<TeamsConfig>, ok: string,
  ): Promise<boolean> {
    setBusy(true)
    try {
      qc.setQueryData(['teams'], await run())
      notifyOk(ok)
      return true
    } catch (e) {
      notifyErr("Couldn't save teams", e)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function addTeam() {
    if (!nLabel.trim()) {
      notifyErr('Missing name', 'Give the team a name')
      return
    }
    if (await persist(
      () => saveTeam({ label: nLabel.trim(), drivers: [] }),
      `Team ${nLabel.trim()} created`,
    )) setNLabel('')
  }

  async function saveEdited(label: string, drivers: Driver[]) {
    if (!editing) return
    if (await persist(
      () => saveTeam({ key: editing.key, label, drivers }),
      `Team ${label} saved`,
    )) setEditing(null)
  }

  async function remove(t: TeamDef) {
    const n = counts.total[t.key] ?? 0
    if (!window.confirm(
      `Delete team ${t.label}?` +
      (n ? ` ${n} unit${n === 1 ? '' : 's'} will be unassigned.` : ''))) return
    await persist(() => deleteTeam(t.key), `Team ${t.label} deleted`)
  }

  // Guarda el tablero: reasigna cada equipo de una vez. assign() reemplaza
  // la flota del equipo, así que iteramos todos (incluso vacíos) para que
  // las unidades movidas al pool queden sin equipo. Las membresías de
  // unidades archivadas (no visibles) se preservan aparte.
  async function commitBoard(placement: Record<string, string[]>) {
    setBusy(true)
    try {
      const activeSet = new Set(activeUnits.map((u) => u.unit))
      const hidden: Record<string, string[]> = {}
      for (const [unit, key] of Object.entries(cfg.members)) {
        if (!activeSet.has(unit)) (hidden[key] ??= []).push(unit)
      }
      let last: TeamsConfig | null = null
      for (const t of teams) {
        last = await assignTeam(t.key,
          [...(placement[t.key] ?? []), ...(hidden[t.key] ?? [])])
      }
      if (last) qc.setQueryData(['teams'], last)
      notifyOk('Fleet board saved')
      setBoard(null)
    } catch (e) {
      notifyErr("Couldn't save teams", e)
    } finally {
      setBusy(false)
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
          <h2>Teams</h2>
          <span className="sub">
            Fleet groups with their drivers · {teams.length}
          </span>
        </div>
      </button>

      {open && (
        <div className="card-body">
          <p className="settings-help">
            Teams group fleet units together with the drivers that run them
            — handy for dispatch and ownership. A unit belongs to a team
            only when you assign it (a unit can be in one team at a time).
          </p>

          {teams.length > 0 && (
            <div className="settings-actions" style={{ marginBottom: 12 }}>
              <Button variant="primary"
                onClick={() => setBoard({ focus: null })}
                icon={<span className="btn-plus" aria-hidden>⠿</span>}>
                Open fleet board
              </Button>
            </div>
          )}

          {teams.length === 0 ? (
            <p className="muted" style={{ margin: '6px 0 2px' }}>
              No teams yet. Create one below, then add drivers and fleet.
            </p>
          ) : (
            <table className="defects-table users-table">
              <thead>
                <tr>
                  <th>Team</th>
                  <th>Drivers</th>
                  <th>Units</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {teams.map((t) => (
                  <tr key={t.key}>
                    <td>
                      <span className="nf-driver-text">
                        <strong>{t.label}</strong>
                        <span className="nf-units">{t.key}</span>
                      </span>
                    </td>
                    <td>
                      {t.drivers.length === 0
                        ? <span className="muted">—</span>
                        : (
                          <span>
                            {t.drivers.slice(0, 2)
                              .map((d) => d.name || d.email).join(', ')}
                            {t.drivers.length > 2 && (
                              <span className="muted">
                                {' '}+{t.drivers.length - 2}
                              </span>
                            )}
                          </span>
                        )}
                    </td>
                    <td>
                      {counts.eff[t.key] ?? 0}
                      {(counts.total[t.key] ?? 0)
                        > (counts.eff[t.key] ?? 0) && (
                        <span className="muted">
                          {' '}· {counts.total[t.key]} total
                        </span>
                      )}
                    </td>
                    <td className="num">
                      <span className="users-reset">
                        <button className="btn btn-ghost btn-xs"
                          onClick={() => setBoard({ focus: t.key })}>
                          Assign fleet
                        </button>
                        <button className="btn btn-ghost btn-xs"
                          onClick={() => setEditing(t)}>
                          Edit
                        </button>
                        <button className="icon-x" title="Delete team"
                          onClick={() => remove(t)}>✕</button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <hr className="settings-divider" />
          <h3 className="settings-sub-h">Add team</h3>
          <div className="settings-add-row">
            <input className="cell-input" placeholder="Name (e.g. Road Crew)"
              value={nLabel} onChange={(e) => setNLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addTeam() }} />
            <button className="btn btn-primary btn-expand" onClick={addTeam}
              disabled={busy}>
              <span className="btn-plus" aria-hidden>＋</span>
              {busy ? 'Saving…' : 'Add team'}
            </button>
          </div>
          <p className="settings-help">
            After creating a team, use <strong>Edit</strong> to add drivers
            and <strong>Assign fleet</strong> to add units.
          </p>
        </div>
      )}

      {editing && (
        <Modal title={`Edit team — ${editing.label}`} width={520}
          onClose={() => setEditing(null)}>
          <TeamEditor team={editing} busy={busy} onSave={saveEdited} />
        </Modal>
      )}

      {board && (
        <Modal title="Fleet board — Teams" width={1060} fullHeight
          onClose={() => setBoard(null)}>
          <FleetBoard kind="team" busy={busy} focusKey={board.focus}
            units={activeUnits}
            columns={teams.map((t) => ({ key: t.key, label: t.label }))}
            initialOf={(unit) => teamOf(unit)}
            onCommit={commitBoard} />
        </Modal>
      )}
    </section>
  )
}

// Editor de un equipo: nombre + lista de conductores ({name, email}).
function TeamEditor({ team, busy, onSave }: {
  team: TeamDef
  busy: boolean
  onSave: (label: string, drivers: Driver[]) => void
}) {
  const [label, setLabel] = useState(team.label)
  const [drivers, setDrivers] = useState<Driver[]>(
    team.drivers.map((d) => ({ ...d })))

  const setDriver = (i: number, patch: Partial<Driver>) =>
    setDrivers((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)))
  const addDriver = () =>
    setDrivers((ds) => [...ds, { name: '', email: '' }])
  const removeDriver = (i: number) =>
    setDrivers((ds) => ds.filter((_, j) => j !== i))
  const clean = () => drivers
    .map((d) => ({ name: d.name.trim(), email: d.email.trim() }))
    .filter((d) => d.name || d.email)

  return (
    <div className="team-editor">
      <label className="ud-field">
        <span>Team name</span>
        <input className="cell-input" value={label} autoFocus
          onChange={(e) => setLabel(e.target.value)} />
      </label>

      <h4 className="settings-sub-h">Drivers</h4>
      {drivers.length === 0 && (
        <p className="muted" style={{ margin: '2px 0 8px' }}>
          No drivers yet — add the people who run this team.
        </p>
      )}
      <div className="team-drivers">
        {drivers.map((d, i) => (
          <div className="team-driver-row" key={i}>
            <input className="cell-input" placeholder="Name"
              value={d.name}
              onChange={(e) => setDriver(i, { name: e.target.value })} />
            <input className="cell-input" placeholder="email@company.com"
              value={d.email} type="email"
              onChange={(e) => setDriver(i, { email: e.target.value })} />
            <button className="icon-x" title="Remove driver"
              onClick={() => removeDriver(i)}>✕</button>
          </div>
        ))}
      </div>
      <button className="btn btn-ghost btn-xs btn-expand" onClick={addDriver}>
        <span className="btn-plus" aria-hidden>＋</span>Add driver
      </button>

      <div className="ep-foot">
        <span className="settings-sub">
          Empty rows are dropped on save.
        </span>
        <button className="btn btn-primary btn-expand"
          disabled={busy || !label.trim()}
          onClick={() => onSave(label.trim(), clean())}>
          {busy ? 'Saving…' : 'Save team'}
        </button>
      </div>
    </div>
  )
}

