// Resources → Locations (v2.22 [F]): las terminales de Settings como
// ubicaciones (taller / yard / terminal) con código, dirección y las
// unidades que caen en cada una (por asignación o por prefijo).
// Props de contrato: { intent?: {location: key} }.
// Editar ubicaciones es administración (settings.manage, igual que Settings
// → Terminals); el tablero de asignación de unidades sigue en Settings.
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { deleteTerminal, listFleet, type TerminalDef } from '../api'
import { notifyErr, notifyOk } from '../toast'
import { usePerms } from '../perms'
import { useShell, type NavIntent } from '../shell'
import { useTerminals } from '../terminal'
import { ICONS } from '../navModel'
import { Button } from '../components/ds'
import LocationModal from '../components/LocationModal'
import { locationTypeLabel } from '../locations'
import {
  RxAvatar, RxBack, RxBlock, RxDl, RxEmpty, RxKpi, RxRow, 
} from '../components/ResourceLayout'
import { listKeyHandler } from '../listKeys'

export default function LocationsPage({ intent }: { intent?: NavIntent }) {
  const { can } = usePerms()
  const admin = can('settings.manage')
  const { cfg, terminals, terminalOf } = useTerminals()
  const fleetQ = useQuery({ queryKey: ['fleet'], queryFn: listFleet })
  const [q, setQ] = useState('')
  const [selKey, setSelKey] = useState<string | null>(
    () => (typeof intent?.location === 'string' ? intent.location : null))
  const [showDetail, setShowDetail] = useState(() => !!intent?.location)
  const [modal, setModal] = useState<{ t: TerminalDef | null } | null>(null)

  // Unidades por ubicación (asignación fija o regla de prefijo).
  const unitsByKey = useMemo(() => {
    const m: Record<string, { unit: string; model: string }[]> = {}
    for (const u of fleetQ.data ?? []) {
      const k = terminalOf(u.unit, u.company)
      ;(m[k] ??= []).push({ unit: u.unit, model: u.model || '' })
    }
    for (const list of Object.values(m)) {
      list.sort((a, b) => a.unit.localeCompare(b.unit, 'en', { numeric: true }))
    }
    return m
  }, [fleetQ.data, terminalOf])
  const pinned = useMemo(() => {
    const m: Record<string, number> = {}
    for (const k of Object.values(cfg.assignments)) m[k] = (m[k] ?? 0) + 1
    return m
  }, [cfg])

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    return terminals.filter((t) => !s
      || t.label.toLowerCase().includes(s)
      || (t.code ?? '').toLowerCase().includes(s)
      || (t.city ?? '').toLowerCase().includes(s))
  }, [terminals, q])
  const sel = rows.find((t) => t.key === selKey)
    ?? terminals.find((t) => t.key === selKey) ?? rows[0] ?? null
  const selIndex = rows.findIndex((t) => t.key === sel?.key)
  const onListKey = listKeyHandler(rows, selIndex, (t) => setSelKey(t.key))

  return (
    <div className="page page-wide rx-page">
      <div className="page-head">
        <div>
          <h1>Locations</h1>
          <p className="page-sub">
            Shops, yards and terminals. Units are grouped by location across
            work orders, PM and reports.
          </p>
        </div>
        {admin && (
          <div className="head-actions">
            <Button variant="primary" onClick={() => setModal({ t: null })}>
              New location
            </Button>
          </div>
        )}
      </div>

      <div className={`rx-layout ${showDetail ? 'show-detail' : ''}`}>
        <aside className="rx-list" aria-label="Locations">
          <div className="rx-list-tools">
            <input className="cell-input rx-search" type="search"
              placeholder="Search name, code or city…" value={q}
              aria-label="Search locations"
              onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="rx-list-head">
            <span>{rows.length} location{rows.length === 1 ? '' : 's'}</span>
            <span>Units</span>
          </div>
          <div className="rx-list-body" role="listbox" aria-label="Location list"
            onKeyDown={onListKey}>
            {rows.length === 0 ? (
              <RxEmpty title="No locations match" />
            ) : rows.map((t) => (
              <RxRow key={t.key} selected={t.key === sel?.key}
                onSelect={() => { setSelKey(t.key); setShowDetail(true) }}
                avatar={<RxAvatar name={t.label} icon={ICONS.locations} />}
                title={<>{t.label}{t.code ? <span className="rx-code">{t.code}</span> : null}</>}
                sub={<>
                  {locationTypeLabel(t.type)}
                  {[t.city, t.state].filter(Boolean).length > 0 && (
                    <span className="rx-sep">{[t.city, t.state].filter(Boolean).join(', ')}</span>
                  )}
                </>}
                side={<span className="rx-pill">{unitsByKey[t.key]?.length ?? 0}</span>} />
            ))}
          </div>
        </aside>

        <section className="rx-detail" aria-label="Location profile">
          {sel ? (
            <LocationProfile key={sel.key} t={sel}
              units={unitsByKey[sel.key] ?? []}
              pinned={pinned[sel.key] ?? 0}
              loadingUnits={fleetQ.isPending}
              admin={admin} canDelete={terminals.length > 1}
              onEdit={() => setModal({ t: sel })}
              onBack={() => setShowDetail(false)}
              onDeleted={() => { setSelKey(null); setShowDetail(false) }} />
          ) : (
            <RxEmpty icon={ICONS.locations} title="No locations yet" />
          )}
        </section>
      </div>

      {modal && (
        <LocationModal terminal={modal.t} onClose={() => setModal(null)}
          onSaved={(key) => {
            setModal(null)
            if (key) { setSelKey(key); setShowDetail(true) }
          }} />
      )}
    </div>
  )
}

function LocationProfile({
  t, units, pinned, loadingUnits, admin, canDelete, onEdit, onBack, onDeleted,
}: {
  t: TerminalDef
  units: { unit: string; model: string }[]
  pinned: number
  loadingUnits: boolean
  admin: boolean
  canDelete: boolean
  onEdit: () => void
  onBack: () => void
  onDeleted: () => void
}) {
  const qc = useQueryClient()
  const { navigate } = useShell()
  const [busy, setBusy] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const addr = [t.address, [t.city, [t.state, t.zip].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ')].filter(Boolean)
  const shown = showAll ? units : units.slice(0, 24)

  async function remove() {
    if (!window.confirm(`Delete location ${t.label}?`
      + (pinned ? ` ${pinned} pinned unit${pinned === 1 ? '' : 's'} go back to prefix rules.` : ''))) return
    setBusy(true)
    try {
      qc.setQueryData(['terminals'], await deleteTerminal(t.key))
      notifyOk('Location deleted', t.label)
      onDeleted()
    } catch (e) {
      notifyErr("Couldn't delete the location", e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header className="rx-phead">
        <RxBack label="Locations" onClick={onBack} />
        <RxAvatar name={t.label} size="lg" icon={ICONS.locations} />
        <div className="rx-phead-main">
          <span className="rx-eyebrow">Location</span>
          <h2 className="rx-ptitle">{t.label}</h2>
          <div className="rx-pchips">
            <span className="rx-pill">{locationTypeLabel(t.type)}</span>
            {t.code && <span className="rx-pill is-accent">{t.code}</span>}
            {t.city && <span className="rx-psub">{[t.city, t.state].filter(Boolean).join(', ')}</span>}
          </div>
        </div>
        {admin && (
          <div className="rx-phead-actions">
            <Button variant="ghost" size="sm" onClick={onEdit}>Edit</Button>
            {canDelete && (
              <Button variant="ghost" size="sm" className="up-danger"
                loading={busy} onClick={remove}>Delete</Button>
            )}
          </div>
        )}
      </header>
      <div className="rx-pbody">
        <div className="rx-stack">
          <div className="rx-kpis rx-kpis-3">
            <RxKpi label="Units" value={loadingUnits ? '…' : units.length}
              sub="by assignment or prefix" />
            <RxKpi label="Pinned units" value={pinned}
              sub="assigned on the fleet board" />
            <RxKpi label="Prefixes" value={t.prefixes.length}
              sub={t.prefixes.length ? t.prefixes.join(', ') : 'none'} />
          </div>
          <RxBlock title="Info">
            <RxDl rows={[
              ['Type', locationTypeLabel(t.type)],
              ['Code', t.code],
              ['Address', addr.length ? (
                <span className="rx-addr">{addr.map((l, i) => <span key={i}>{l}</span>)}</span>
              ) : ''],
              ['Phone', t.phone],
              ['Unit prefixes', t.prefixes.join(', ')],
            ]} />
          </RxBlock>
          <RxBlock title={`Units · ${units.length}`}
            action={admin ? (
              <button type="button" className="link-btn"
                onClick={() => navigate('settings')}>
                Assign on the fleet board →
              </button>
            ) : undefined}>
            {units.length === 0 ? (
              <p className="rx-none">
                No units here yet. Add a unit prefix or pin units on the fleet
                board in Settings → Terminals.
              </p>
            ) : (
              <>
                <ul className="rx-units">
                  {shown.map((u) => (
                    <li key={u.unit} className="rx-unit">
                      <button type="button" className="rx-unit-main"
                        onClick={() => navigate('flota', { unit: u.unit })}>
                        <span className="rx-unit-ico" aria-hidden="true">{ICONS.flota}</span>
                        <strong>{u.unit}</strong>
                        {u.model && <span>{u.model}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
                {units.length > 24 && (
                  <button type="button" className="link-btn rx-more"
                    onClick={() => setShowAll((v) => !v)}>
                    {showAll ? 'Show fewer' : `Show all ${units.length} units`}
                  </button>
                )}
              </>
            )}
          </RxBlock>
        </div>
      </div>
    </>
  )
}
