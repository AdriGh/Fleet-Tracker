import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fleetArchive, getSettings, listFleet, saveSettings } from '../api'
import Skeleton from '../components/Skeleton'

export default function SettingsPage() {
  const qc = useQueryClient()
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const fleetQuery = useQuery({ queryKey: ['fleet'], queryFn: listFleet })

  const [open, setOpen] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [days, setDays] = useState(30)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const archived = useMemo(
    () => (fleetQuery.data ?? [])
      .filter((u) => u.archived)
      .sort((a, b) => a.company.localeCompare(b.company)
        || a.unit.localeCompare(b.unit)),
    [fleetQuery.data])

  async function archiveAction(id: string, action: string) {
    setBusyId(id)
    try {
      await fleetArchive(id, action)
      await qc.invalidateQueries({ queryKey: ['fleet'] })
    } finally {
      setBusyId(null)
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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
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
                    Based on Samsara DVIR history — a DVIR covers the truck and
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

            <h3 className="settings-sub-h">
              Archived units ({archived.length})
            </h3>
            {fleetQuery.isPending ? (
              <div className="skel-rows">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} h={32} />
                ))}
              </div>
            ) : archived.length === 0 ? (
              <div className="empty mini">
                <p>No archived units. Archive unused units from the Fleet tab.</p>
              </div>
            ) : (
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
                  {archived.map((u) => (
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
            )}
          </div>
        )}
      </section>
    </div>
  )
}
