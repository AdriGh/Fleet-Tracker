// Perfil de unidad (fase H3, estilo Fullbay): Components & PMs,
// Active Services, Service History y Attachments. Se abre desde Fleet.
import { useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addMaintRecord, deleteUnitDoc, deleteWorkOrder, downloadUnitDoc,
  getUnitCampaigns, listFleet, listUnitDocs, listWorkOrders,
  toggleUnitCampaign, uploadUnitDocs,
  type MaintKind, type UnitCampaign, type WorkOrder, type WoStatus,
} from '../api'
import { notifyOk, notifyErr } from '../toast'
import { PIPELINE, STATUS_META, WoDrawer } from './WorkOrdersPage'

type Tab = 'campaigns' | 'active' | 'history' | 'docs'

const TABS: { key: Tab; label: string }[] = [
  { key: 'campaigns', label: 'Components & PMs' },
  { key: 'active', label: 'Active Services' },
  { key: 'history', label: 'Service History' },
  { key: 'docs', label: 'Attachments' },
]

const CAMP_STATUS: Record<string, { label: string; cls: string }> = {
  on_track: { label: 'On track', cls: 's-on_track' },
  upcoming: { label: 'Upcoming', cls: 's-upcoming' },
  overdue: { label: 'Overdue', cls: 's-overdue' },
  never: { label: 'Never performed', cls: 's-never' },
  no_meter: { label: 'No odometer', cls: 's-never' },
  tracked: { label: 'Tracked', cls: 's-on_track' },
}

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const fmtMi = (n: number | null | undefined) =>
  n == null ? '' : n.toLocaleString('en-US')
const dateOf = (iso: string | null) => (iso ? iso.slice(0, 10) : '')

function fmtSize(b: number): string {
  if (b > 1e6) return `${(b / 1e6).toFixed(1)} MB`
  return `${Math.max(1, Math.round(b / 1024))} KB`
}

function todayISO(): string {
  const t = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`
}

export default function UnitProfilePage({ unit, onClose }: {
  unit: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('campaigns')
  const [openWo, setOpenWo] = useState<number | null>(null)

  const fleetQ = useQuery({ queryKey: ['fleet'], queryFn: listFleet })
  const info = useMemo(
    () => (fleetQ.data ?? []).find((u) => u.unit === unit),
    [fleetQ.data, unit])

  const campQ = useQuery({
    queryKey: ['unit-campaigns', unit],
    queryFn: () => getUnitCampaigns(unit, info?.model ?? ''),
  })
  const wosQ = useQuery({
    queryKey: ['unit-wos', unit],
    queryFn: () => listWorkOrders('', unit),
  })
  const docsQ = useQuery({
    queryKey: ['unit-docs', unit],
    queryFn: () => listUnitDocs(unit),
  })

  const wos = wosQ.data?.workorders ?? []
  const active = wos.filter((w) => w.status !== 'invoiced')
  const history = wos.filter((w) => w.status === 'invoiced')
  const cost12 = history
    .filter((w) => Date.parse(w.invoiced_at ?? w.updated_at) >
      Date.now() - 365 * 86400_000)
    .reduce((s, w) => s + w.total, 0)
  const pmCamp = campQ.data?.campaigns.find((c) => c.key === 'pm')

  function refreshAll() {
    qc.invalidateQueries({ queryKey: ['unit-campaigns', unit] })
    qc.invalidateQueries({ queryKey: ['maint'] })
    qc.invalidateQueries({ queryKey: ['pm'] })
  }

  return (
    <div className="page page-wide unit-profile">
      <div className="page-head">
        <div className="up-headline">
          <button className="btn btn-ghost up-back" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" width="16" height="16">
              <path d="M15 5l-7 7 7 7" />
            </svg>
            Fleet
          </button>
          <div>
            <h1>Unit {unit}</h1>
            <p className="page-sub">
              {info
                ? [info.model || info.kind, info.vin && `VIN ${info.vin}`,
                   info.plate && `Plate ${info.plate}`, info.company]
                    .filter(Boolean).join(' · ')
                : 'Loading unit…'}
            </p>
          </div>
        </div>
      </div>

      {/* Tarjetas resumen (estilo Fullbay, con datos útiles) */}
      <div className="up-cards">
        <div className="up-card up-card-blue">
          <strong>{money(cost12)}</strong>
          <span>Maintenance cost · last 12 months</span>
        </div>
        <div className="up-card up-card-green">
          <strong>{active.length}</strong>
          <span>Active service orders</span>
        </div>
        <div className="up-card up-card-sky">
          <strong>
            {campQ.data?.current_miles != null
              ? `${fmtMi(campQ.data.current_miles)} mi`
              : '—'}
          </strong>
          <span>
            Odometer
            {campQ.data?.current_source
              ? ` · ${campQ.data.current_source}`
              : ''}
            {pmCamp?.to_due != null
              ? ` · PM in ${fmtMi(Math.abs(pmCamp.to_due))} mi`
                .replace('in -', 'overdue by ')
              : ''}
          </span>
        </div>
      </div>

      <div className="up-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab"
            aria-selected={tab === t.key}
            className={`up-tab ${tab === t.key ? 'on' : ''}`}
            onClick={() => setTab(t.key)}>
            {t.label}
            {t.key === 'active' && active.length > 0 && (
              <i className="up-tab-n">{active.length}</i>
            )}
            {t.key === 'docs' && (docsQ.data?.docs.length ?? 0) > 0 && (
              <i className="up-tab-n">{docsQ.data?.docs.length}</i>
            )}
          </button>
        ))}
      </div>

      {tab === 'campaigns' && (
        <CampaignsTab unit={unit} data={campQ.data}
          loading={campQ.isPending} onChanged={refreshAll} />
      )}
      {tab === 'active' && (
        <ServicesTab
          title="Active service orders"
          empty="There are no active service orders for this unit."
          wos={active} grouped onOpen={setOpenWo} />
      )}
      {tab === 'history' && (
        <ServicesTab
          title="Invoiced service orders"
          empty="No invoiced service orders yet."
          wos={history} onOpen={setOpenWo}
          onDelete={async (w) => {
            if (!window.confirm(
              `Delete work order #${w.id}? This cannot be undone.`)) return
            try {
              await deleteWorkOrder(w.id)
              qc.invalidateQueries({ queryKey: ['unit-wos', unit] })
              qc.invalidateQueries({ queryKey: ['workorders'] })
              notifyOk(`Work order #${w.id} deleted`)
            } catch (e) {
              notifyErr("Couldn't delete", e)
            }
          }} />
      )}
      {tab === 'docs' && (
        <DocsTab unit={unit} data={docsQ.data}
          onChanged={() =>
            qc.invalidateQueries({ queryKey: ['unit-docs', unit] })} />
      )}

      <WoDrawer woId={openWo} mechanics={wosQ.data?.mechanics ?? []}
        onClose={() => {
          setOpenWo(null)
          qc.invalidateQueries({ queryKey: ['unit-wos', unit] })
        }} />
    </div>
  )
}

// ----- Components & PMs ----------------------------------------------------
function CampaignsTab({ unit, data, loading, onChanged }: {
  unit: string
  data: import('../api').UnitCampaignsResult | undefined
  loading: boolean
  onChanged: () => void
}) {
  const [recordFor, setRecordFor] = useState<UnitCampaign | null>(null)

  if (loading || !data) {
    return <div className="card"><div className="card-body empty mini">
      <p>Loading campaigns…</p></div></div>
  }

  return (
    <>
      <div className="up-campaigns">
        {data.campaigns.map((c) => {
          const sm = CAMP_STATUS[c.status] ?? CAMP_STATUS.never
          return (
            <div className="card up-campaign" key={c.key}>
              <div className="up-camp-head">
                <strong>{c.label}</strong>
                <span className={`mnt-status-pill ${sm.cls}`}>
                  {sm.label}
                </span>
                {!c.default && (
                  <button className="mnt-icon" title="Remove campaign"
                    onClick={async () => {
                      await toggleUnitCampaign(unit, c.key, false)
                      onChanged()
                    }}>
                    <svg viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth="1.8"
                      strokeLinecap="round">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                )}
              </div>
              <div className="up-camp-grid">
                <span>
                  <em>Last done</em>
                  {c.last_date
                    ? `${c.last_date}${c.last_miles != null
                        ? ` · ${fmtMi(c.last_miles)} mi` : ''}`
                    : 'Never'}
                </span>
                <span>
                  <em>Next due</em>
                  {c.due === 'miles' && c.next_due_miles != null
                    ? `${fmtMi(c.next_due_miles)} mi`
                    : c.due === 'days' && c.next_due_date
                      ? c.next_due_date
                      : c.due === 'none' ? 'On condition' : '—'}
                </span>
                <span>
                  <em>{c.due === 'miles' ? 'Miles to due'
                    : c.due === 'days' ? 'Days to due' : 'Interval'}</em>
                  {c.to_due != null
                    ? `${c.to_due < 0 ? '-' : ''}${fmtMi(Math.abs(c.to_due))}`
                    : '—'}
                </span>
                <button className="btn btn-ghost btn-xs"
                  onClick={() => setRecordFor(c)}>
                  Record done
                </button>
              </div>
              {c.records.length > 0 && (
                <div className="up-camp-recs">
                  {c.records.map((r) => (
                    <span key={r.id}>
                      {r.date}
                      {r.mileage != null ? ` · ${fmtMi(r.mileage)} mi` : ''}
                      {r.notes ? ` · ${r.notes}` : ''}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {data.available.length > 0 && (
        <div className="up-add-campaign">
          <span>Add a maintenance campaign:</span>
          {data.available.map((a) => (
            <button key={a.key} className="btn btn-ghost btn-xs"
              onClick={async () => {
                await toggleUnitCampaign(unit, a.key, true)
                onChanged()
                notifyOk('Campaign added', a.label)
              }}>
              + {a.label}
            </button>
          ))}
        </div>
      )}

      {recordFor && (
        <RecordModal unit={unit} campaign={recordFor}
          currentMiles={data.current_miles}
          onClose={() => setRecordFor(null)}
          onSaved={() => { setRecordFor(null); onChanged() }} />
      )}
    </>
  )
}

function RecordModal({ unit, campaign, currentMiles, onClose, onSaved }: {
  unit: string
  campaign: UnitCampaign
  currentMiles: number | null
  onClose: () => void
  onSaved: () => void
}) {
  const [date, setDate] = useState(todayISO())
  const [miles, setMiles] = useState(
    currentMiles != null ? String(currentMiles) : '')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 420 }}
        onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Record · {campaign.label}</h2>
          <button className="modal-x" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="modal-body mnt-form">
          <label><span>Date</span>
            <input type="date" className="cell-input" value={date}
              onChange={(e) => setDate(e.target.value)} />
          </label>
          <label><span>Mileage</span>
            <input type="number" className="cell-input" value={miles}
              placeholder="optional"
              onChange={(e) => setMiles(e.target.value)} />
          </label>
          <label><span>Notes</span>
            <input className="cell-input" value={notes} placeholder="optional"
              onChange={(e) => setNotes(e.target.value)} />
          </label>
          <div className="mnt-form-actions">
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await addMaintRecord({
                    kind: campaign.key as MaintKind, unit, date,
                    mileage: miles ? Number(miles) : null, notes,
                  })
                  notifyOk(`${campaign.label} recorded`, unit)
                  onSaved()
                } catch (e) {
                  notifyErr("Couldn't save", e)
                  setBusy(false)
                }
              }}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ----- Active Services / Service History ------------------------------------
function ServicesTab({ title, empty, wos, grouped, onOpen, onDelete }: {
  title: string
  empty: string
  wos: WorkOrder[]
  grouped?: boolean
  onOpen: (id: number) => void
  onDelete?: (w: WorkOrder) => void
}) {
  const sections: { status: WoStatus; rows: WorkOrder[] }[] = grouped
    ? PIPELINE.filter((s) => s !== 'invoiced')
        .map((s) => ({ status: s, rows: wos.filter((w) => w.status === s) }))
    : [{ status: 'invoiced', rows: wos }]

  return (
    <section className="card">
      <div className="card-head"><h2>{title}</h2>
        <span className="sub">{wos.length} total</span></div>
      <div className="card-body">
        {wos.length === 0 && (
          <div className="empty mini"><p>{empty}</p></div>
        )}
        {wos.length > 0 && sections.map(({ status, rows }) => (
          (grouped || rows.length > 0) && (
            <div key={status} className="up-svc-group">
              {grouped && (
                <div className="up-svc-head">
                  <span className={`wo-status ${STATUS_META[status].cls}`}>
                    {STATUS_META[status].label}
                  </span>
                  <i>{rows.length}</i>
                </div>
              )}
              {rows.length === 0 ? (
                <p className="up-svc-empty">
                  No service orders in this status.
                </p>
              ) : (
                <table className="up-svc-table">
                  <tbody>
                    {rows.map((w) => (
                      <tr key={w.id} onClick={() => onOpen(w.id)}>
                        <td className="mono">#{w.id}</td>
                        <td className="up-svc-title">
                          {w.title}
                          {w.is_pm && <span className="wo-pm-tag">PM</span>}
                          {w.waiting_parts && (
                            <span className="wo-wait-tag">parts</span>
                          )}
                        </td>
                        <td>{w.mechanic || '—'}</td>
                        <td className="muted">
                          {dateOf(w.invoiced_at) || dateOf(w.service_date)
                            || dateOf(w.created_at)}
                        </td>
                        <td className="num mono">
                          {w.total ? money(w.total) : '—'}
                        </td>
                        <td className="up-svc-actions">
                          <button className="btn btn-ghost btn-xs"
                            onClick={(e) => {
                              e.stopPropagation(); onOpen(w.id)
                            }}>
                            Edit
                          </button>
                          {onDelete && (
                            <button className="btn btn-ghost btn-xs up-danger"
                              onClick={(e) => {
                                e.stopPropagation(); onDelete(w)
                              }}>
                              Delete
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )
        ))}
      </div>
    </section>
  )
}

// ----- Attachments -----------------------------------------------------------
function DocsTab({ unit, data, onChanged }: {
  unit: string
  data: { docs: import('../api').UnitDoc[]
          kinds: { key: string; label: string }[] } | undefined
  onChanged: () => void
}) {
  const [kind, setKind] = useState('other')
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  async function upload(files: FileList | null) {
    if (!files || files.length === 0 || busy) return
    setBusy(true)
    try {
      const r = await uploadUnitDocs(unit, kind, Array.from(files))
      onChanged()
      if (r.saved.length) {
        notifyOk(`${r.saved.length} document${r.saved.length === 1 ? '' : 's'} uploaded`)
      }
      for (const err of r.errors) notifyErr('Skipped', err)
    } catch (e) {
      notifyErr("Couldn't upload", e)
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <section className="card">
      <div className="card-head"><h2>Unit documents</h2>
        <span className="sub">
          PM copies, DOT inspections, CAB cards, registrations
        </span>
      </div>
      <div className="card-body">
        <div className="up-doc-bar">
          <label className="ud-field up-doc-kind">
            <span>Document type</span>
            <select className="cell-input" value={kind}
              onChange={(e) => setKind(e.target.value)}>
              {(data?.kinds ?? []).map((k) => (
                <option key={k.key} value={k.key}>{k.label}</option>
              ))}
            </select>
          </label>
          <div
            className={`wo-scan up-doc-drop ${dragOver ? 'is-over' : ''} ${busy ? 'is-busy' : ''}`}
            role="button" tabIndex={0}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') fileRef.current?.click()
            }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault(); setDragOver(false)
              upload(e.dataTransfer.files)
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.7" strokeLinecap="round"
              className="wo-scan-ico">
              <path d="M12 16V4m0 0L7 9m5-5 5 5" />
              <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
            </svg>
            <span className="wo-scan-text">
              <strong>{busy ? 'Uploading…' : 'Upload documents'}</strong>
              <span>PDF or photos. Several files at once work.</span>
            </span>
            <input ref={fileRef} type="file" hidden multiple
              accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,application/pdf,image/*"
              onChange={(e) => upload(e.target.files)} />
          </div>
        </div>

        {(data?.docs ?? []).length === 0 ? (
          <div className="empty mini">
            <p>No documents yet. Upload the PM copy, DOT inspection,
              CAB card or registration.</p>
          </div>
        ) : (
          <table className="up-svc-table up-docs-table">
            <tbody>
              {(data?.docs ?? []).map((d) => (
                <tr key={d.id}>
                  <td>
                    <span className="up-doc-kind-tag">{d.kind_label}</span>
                  </td>
                  <td className="up-svc-title">{d.filename}</td>
                  <td className="muted">{fmtSize(d.size)}</td>
                  <td className="muted">{dateOf(d.uploaded_at)}</td>
                  <td className="up-svc-actions">
                    <button className="btn btn-ghost btn-xs"
                      onClick={() => downloadUnitDoc(d.id, d.filename)
                        .catch((e) => notifyErr("Couldn't download", e))}>
                      Download
                    </button>
                    <button className="btn btn-ghost btn-xs up-danger"
                      onClick={async () => {
                        if (!window.confirm(
                          `Delete ${d.filename}?`)) return
                        try {
                          await deleteUnitDoc(d.id)
                          onChanged()
                        } catch (e) {
                          notifyErr("Couldn't delete", e)
                        }
                      }}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}
