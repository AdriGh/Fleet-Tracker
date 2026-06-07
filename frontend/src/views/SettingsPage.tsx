import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fleetArchive, getSettings, listFleet, saveSettings, type FleetUnit,
} from '../api'
import Skeleton from '../components/Skeleton'
import Modal from '../components/Modal'

const PAGE_SIZE = 50

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
