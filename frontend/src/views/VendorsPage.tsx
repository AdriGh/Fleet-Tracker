// Resources → Vendors (v2.22 [F]): proveedores de partes y talleres
// externos como sección propia, maestro-detalle. El perfil junta lo que hoy
// está disperso: órdenes de compra, outside work orders, partes del vendor y
// el gasto (YTD, POs abiertas, outside work).
// Props de contrato: { intent?: {vendor: id} }.
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  deleteVendor, getVendorProfile, listVendors,
  type Vendor, type VendorKind,
} from '../api'
import { notifyErr, notifyOk } from '../toast'
import { usePerms } from '../perms'
import { useShell, type NavIntent } from '../shell'
import { ICONS } from '../navModel'
import { Button, Tabs } from '../components/ds'
import Skeleton from '../components/Skeleton'
import {
  RxAvatar, RxBack, RxBlock, RxDl, RxEmpty, RxKpi, RxRow, 
} from '../components/ResourceLayout'
import { listKeyHandler } from '../listKeys'
import { money } from '../customers'
import { VENDOR_KIND_LABEL, VENDOR_KIND_SHORT, vendorLoc } from '../vendors'
import { VendorModal } from './PartsPage'
import { WoDrawer } from './WoDetail'
import { dateOf, STATUS_META } from './woShared'

type KindFilter = '' | Exclude<VendorKind, ''>
type VTab = 'overview' | 'pos' | 'wos' | 'parts'

const PO_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', ordered: 'Ordered', received: 'Received',
}
const PO_STATUS_CLS: Record<string, string> = {
  draft: 'wo-open', ordered: 'wo-progress', received: 'wo-done',
}

export default function VendorsPage({ intent }: { intent?: NavIntent }) {
  const qc = useQueryClient()
  const { can } = usePerms()
  const editable = can('maint.edit')
  const vendorsQ = useQuery({ queryKey: ['vendors'], queryFn: listVendors })
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<KindFilter>('')
  const [selId, setSelId] = useState<number | null>(
    () => (typeof intent?.vendor === 'number' ? intent.vendor : null))
  const [showDetail, setShowDetail] = useState(() => intent?.vendor != null)
  const [modal, setModal] = useState<{ v: Vendor | null } | null>(null)

  const all = useMemo(() => vendorsQ.data ?? [], [vendorsQ.data])
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    return all
      .filter((v) => !kind || v.kind === kind || v.kind === 'both')
      .filter((v) => !s || v.name.toLowerCase().includes(s)
        || vendorLoc(v).toLowerCase().includes(s)
        || (v.contact ?? '').toLowerCase().includes(s))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [all, q, kind])
  const sel = rows.find((v) => v.id === selId)
    ?? all.find((v) => v.id === selId) ?? rows[0] ?? null
  const selIndex = rows.findIndex((v) => v.id === sel?.id)
  const onListKey = listKeyHandler(rows, selIndex, (v) => setSelId(v.id))

  function refresh() {
    qc.invalidateQueries({ queryKey: ['vendors'] })
    qc.invalidateQueries({ queryKey: ['vendor-profile'] })
    // Las WO llevan vendor_name/city/state desnormalizados.
    qc.invalidateQueries({ queryKey: ['workorders'] })
    qc.invalidateQueries({ queryKey: ['workorder'] })
    qc.invalidateQueries({ queryKey: ['unit-wos'] })
  }

  return (
    <div className="page page-wide rx-page">
      {vendorsQ.isFetching && <div className="loadbar" aria-hidden="true" />}
      <div className="page-head">
        <div>
          <h1>Vendors</h1>
          <p className="page-sub">
            Parts suppliers and outside repair shops: purchase orders,
            outside work and what you spend with each one.
          </p>
        </div>
        {editable && (
          <div className="head-actions">
            <Button variant="primary" onClick={() => setModal({ v: null })}>
              New vendor
            </Button>
          </div>
        )}
      </div>

      <div className={`rx-layout ${showDetail ? 'show-detail' : ''}`}>
        <aside className="rx-list" aria-label="Vendors">
          <div className="rx-list-tools">
            <input className="cell-input rx-search" type="search"
              placeholder="Search vendor, city or contact…" value={q}
              aria-label="Search vendors"
              onChange={(e) => setQ(e.target.value)} />
            <div className="rx-chips" role="group" aria-label="Vendor type">
              {([['', 'All'], ['parts', 'Parts'], ['shop', 'Shops'],
                ['both', 'Both']] as [KindFilter, string][]).map(([k, l]) => (
                <button key={k || 'all'} type="button"
                  className={`rx-chip ${kind === k ? 'is-on' : ''}`}
                  aria-pressed={kind === k} onClick={() => setKind(k)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="rx-list-head">
            <span>{rows.length} vendor{rows.length === 1 ? '' : 's'}</span>
            <span>Type</span>
          </div>
          <div className="rx-list-body" role="listbox" aria-label="Vendor list"
            onKeyDown={onListKey}>
            {vendorsQ.isPending ? (
              Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} h={52} r={10} />
              ))
            ) : rows.length === 0 ? (
              <RxEmpty title={all.length ? 'No vendors match' : 'No vendors yet'}>
                <p>{all.length ? 'Try another filter.'
                  : 'Add the shops and suppliers you buy from.'}</p>
              </RxEmpty>
            ) : rows.map((v) => (
              <RxRow key={v.id} selected={v.id === sel?.id}
                onSelect={() => { setSelId(v.id); setShowDetail(true) }}
                avatar={<RxAvatar name={v.name} />}
                title={v.name}
                sub={<>
                  {vendorLoc(v) || 'No location'}
                  {(v.wo_count || v.parts_count) ? (
                    <span className="rx-sep">
                      {v.parts_count || 0} parts · {v.wo_count || 0} WOs
                    </span>
                  ) : null}
                </>}
                side={v.kind ? (
                  <span className={`vk-chip vk-${v.kind}`}>
                    {VENDOR_KIND_SHORT[v.kind]}
                  </span>
                ) : null} />
            ))}
          </div>
        </aside>

        <section className="rx-detail" aria-label="Vendor profile">
          {sel ? (
            <VendorProfilePanel key={sel.id} v={sel} editable={editable}
              onEdit={() => setModal({ v: sel })}
              onBack={() => setShowDetail(false)}
              onDeleted={() => { setSelId(null); setShowDetail(false); refresh() }} />
          ) : (
            <RxEmpty icon={ICONS.vendors} title="Pick a vendor">
              <p>Purchase orders, outside work and spend show here.</p>
            </RxEmpty>
          )}
        </section>
      </div>

      {modal && (
        <VendorModal vendor={modal.v} onClose={() => setModal(null)}
          onSaved={() => { setModal(null); refresh() }} />
      )}
    </div>
  )
}

function VendorProfilePanel({ v, editable, onEdit, onBack, onDeleted }: {
  v: Vendor
  editable: boolean
  onEdit: () => void
  onBack: () => void
  onDeleted: () => void
}) {
  const { navigate } = useShell()
  const [tab, setTab] = useState<VTab>('overview')
  const [openWo, setOpenWo] = useState<number | null>(null)
  const profQ = useQuery({
    queryKey: ['vendor-profile', v.id],
    queryFn: () => getVendorProfile(v.id),
    retry: false,
  })
  const p = profQ.data
  const vendor = p?.vendor ?? v

  async function remove() {
    if (v.wo_count) {
      notifyErr("Can't delete this vendor",
        `${v.wo_count} work order${v.wo_count === 1 ? '' : 's'} use it — reassign them first`)
      return
    }
    if (!window.confirm(`Delete vendor ${v.name}?`
      + (v.parts_count ? ` ${v.parts_count} part(s) will keep no vendor.` : ''))) return
    try {
      await deleteVendor(v.id)
      notifyOk('Vendor deleted', v.name)
      onDeleted()
    } catch (e) {
      notifyErr("Couldn't delete vendor", e)
    }
  }

  // Misma regla que open_value del backend: sin recibir y financieramente
  // abiertas.
  const openPos = (p?.purchase_orders ?? []).filter((x) =>
    x.status !== 'received' && x.fin_status !== 'closed')

  return (
    <>
      <header className="rx-phead">
        <RxBack label="Vendors" onClick={onBack} />
        <RxAvatar name={vendor.name} size="lg" />
        <div className="rx-phead-main">
          <span className="rx-eyebrow">Vendor</span>
          <h2 className="rx-ptitle">{vendor.name}</h2>
          <div className="rx-pchips">
            {vendor.kind && (
              <span className={`vk-chip vk-${vendor.kind}`}>
                {VENDOR_KIND_LABEL[vendor.kind]}
              </span>
            )}
            {vendorLoc(vendor) && <span className="rx-psub">{vendorLoc(vendor)}</span>}
            {vendor.account && <span className="rx-psub">Acct {vendor.account}</span>}
          </div>
        </div>
        {editable && (
          <div className="rx-phead-actions">
            <Button variant="ghost" size="sm" onClick={onEdit}>Edit</Button>
            <Button variant="ghost" size="sm" className="up-danger"
              onClick={remove}>Delete</Button>
          </div>
        )}
      </header>

      <div className="rx-tabs">
        <Tabs aria-label="Vendor sections"
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'pos', label: <>Purchase orders{p ? <span className="rx-tab-n">{p.purchase_orders.length}</span> : null}</> },
            { id: 'wos', label: <>Outside work{p ? <span className="rx-tab-n">{p.work_orders.length}</span> : null}</> },
            { id: 'parts', label: <>Parts{p ? <span className="rx-tab-n">{p.parts.length}</span> : null}</> },
          ]}
          value={tab} onChange={(t) => setTab(t as VTab)} />
      </div>

      <div className="rx-pbody">
        {profQ.isPending ? (
          <div className="rx-pskel">
            <div className="rx-kpis">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} h={72} r={12} />)}
            </div>
            <Skeleton h={160} r={12} />
          </div>
        ) : tab === 'overview' ? (
          <div className="rx-stack">
            {p ? (
              <div className="rx-kpis">
                <RxKpi label="Spend YTD" value={money(p.totals.spend_ytd)} />
                <RxKpi label="Open PO value" value={money(p.totals.open_po_value)}
                  tone={p.totals.open_po_value > 0 ? 'warn' : undefined}
                  sub={`${openPos.length} open PO${openPos.length === 1 ? '' : 's'}`} />
                <RxKpi label="Outside work" value={money(p.totals.outside_wo_total)}
                  sub={`${p.work_orders.length} work orders`} />
                <RxKpi label="Parts" value={p.parts.length}
                  sub="in the catalog" />
              </div>
            ) : (
              <p className="rx-none">
                Spend totals aren't available right now
                {profQ.error ? ` (${String(profQ.error)})` : ''}.
              </p>
            )}
            <RxBlock title="Contact">
              <RxDl rows={[
                ['Contact', vendor.contact],
                ['Phone', vendor.phone],
                ['Email', vendor.email],
                ['Address', [vendor.address, vendorLoc(vendor)].filter(Boolean).join(' · ')],
                ['Account #', vendor.account],
                ['Notes', vendor.notes],
              ]} />
            </RxBlock>
          </div>
        ) : tab === 'pos' ? (
          (p?.purchase_orders.length ?? 0) === 0 ? (
            <p className="rx-none">No purchase orders with {vendor.name} yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="defects-table rx-table">
                <thead>
                  <tr>
                    <th scope="col">PO · invoice</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="num">Total</th>
                    <th scope="col" className="num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {p!.purchase_orders.map((po) => (
                    <tr key={po.id} className="rx-click"
                      onClick={() => navigate('purchasing', { po: po.id, tab: 'pos' })}>
                      <td className="mono rx-cell-2">
                        <button type="button" className="link-btn"
                          onClick={(e) => {
                            e.stopPropagation()
                            navigate('purchasing', { po: po.id, tab: 'pos' })
                          }}>#{po.id}</button>
                        <span>
                          {po.invoice_no ? `Inv ${po.invoice_no}` : dateOf(po.created_at)}
                        </span>
                      </td>
                      <td>
                        <span className={`wo-status ${PO_STATUS_CLS[po.status] ?? ''}`}>
                          {PO_STATUS_LABEL[po.status] ?? po.status}
                        </span>
                        {po.fin_status === 'closed' && (
                          <span className="po-fin-chip is-closed">Closed</span>
                        )}
                      </td>
                      <td className="num mono">{money(po.total)}</td>
                      <td className="num mono">
                        {po.financial ? money(po.financial.balance) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : tab === 'wos' ? (
          (p?.work_orders.length ?? 0) === 0 ? (
            <p className="rx-none">No outside work orders with {vendor.name}.</p>
          ) : (
            <div className="table-wrap">
              <table className="defects-table rx-table">
                <thead>
                  <tr>
                    <th scope="col">WO</th>
                    <th scope="col">Unit · work</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {p!.work_orders.map((w) => (
                    <tr key={w.id} className="rx-click" onClick={() => setOpenWo(w.id)}>
                      <td className="mono">
                        <button type="button" className="link-btn"
                          onClick={(e) => { e.stopPropagation(); setOpenWo(w.id) }}>
                          #{w.display_no || w.id}
                        </button>
                      </td>
                      <td className="rx-cell-2">
                        <strong>{w.unit}</strong>
                        <span title={w.title}>{w.title}</span>
                      </td>
                      <td className="rx-cell-2">
                        <span className={`wo-status ${STATUS_META[w.status]?.cls ?? ''}`}>
                          {STATUS_META[w.status]?.label ?? w.status}
                        </span>
                        <span className="muted">{dateOf(w.created_at)}</span>
                      </td>
                      <td className="num mono">{money(w.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : (
          (p?.parts.length ?? 0) === 0 ? (
            <p className="rx-none">No catalog parts list {vendor.name} as their vendor.</p>
          ) : (
            <div className="table-wrap">
              <table className="defects-table rx-table">
                <thead>
                  <tr>
                    <th scope="col">Part #</th>
                    <th scope="col">Description</th>
                    <th scope="col" className="num">On hand</th>
                    <th scope="col" className="num">Avg cost</th>
                  </tr>
                </thead>
                <tbody>
                  {p!.parts.map((x) => (
                    <tr key={x.id} className="rx-click"
                      onClick={() => navigate('parts', { part: x.id })}>
                      <td className="mono">{x.part_number}</td>
                      <td>{x.description}</td>
                      <td className="num">{x.on_hand}</td>
                      <td className="num mono">
                        {money(x.avg_cost && x.avg_cost > 0 ? x.avg_cost : x.cost)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
      <WoDrawer woId={openWo} onClose={() => setOpenWo(null)} />
    </>
  )
}
