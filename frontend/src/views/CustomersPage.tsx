// Resources → Customers (v2.22 [F]). Maestro-detalle estilo SquareRigger,
// pero con lo que SR no tiene en el perfil: unidades del cliente, historial
// de WOs con estado de cobro, partes facturadas y saldo abierto.
//
// Los clientes del taller son sobre todo owner-operators: dueños de sus
// unidades, a los que se les factura partes y labor con su markup.
// Props de contrato: { intent?: {customer: id} } ({create:'customer'} lo
// resuelve App abriendo el modal de alta).
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addCustomerContact, deleteCustomer, deleteCustomerContact, getCustomer,
  listCustomers, patchCustomerContact, patchWorkOrder, removeCustomerUnit,
  setCustomerUnit,
  type CustomerContact, type CustomerKind, type CustomerProfile,
  type CustomerSummary, type WoPaymentStatus,
} from '../api'
import { notifyErr, notifyOk } from '../toast'
import { usePerms } from '../perms'
import { useShell, type NavIntent } from '../shell'
import { ICONS } from '../navModel'
import { Button, Tabs } from '../components/ds'
import Skeleton from '../components/Skeleton'
import UnitPicker from '../components/UnitPicker'
import CustomerModal, { CustomerForm } from '../components/CustomerModal'
import {
  RxAvatar, RxBack, RxBlock, RxDl, RxEmpty, RxKpi, RxRow, RxSeg, 
} from '../components/ResourceLayout'
import { listKeyHandler } from '../listKeys'
import {
  CUSTOMER_KIND_LABEL, CUSTOMER_KINDS, isMasked, money, sinceYear,
  TERMS_LABEL,
} from '../customers'
import { useKnownUnits } from '../unitMatch'
import { WoDrawer } from './WoDetail'
import { dateOf, STATUS_META } from './woShared'

type ActiveFilter = 'active' | 'inactive' | 'all'
type ProfileTab = 'overview' | 'work_orders' | 'parts' | 'contacts' | 'settings'

const locOf = (c: { city?: string; state?: string }) =>
  [c.city, c.state].filter((x) => x && !isMasked(x)).join(', ')

export default function CustomersPage({ intent }: { intent?: NavIntent }) {
  const { can } = usePerms()
  const editable = can('maint.edit')
  const [q, setQ] = useState('')
  const [active, setActive] = useState<ActiveFilter>('active')
  const [kind, setKind] = useState<CustomerKind | ''>('')
  const [selId, setSelId] = useState<number | null>(
    () => (typeof intent?.customer === 'number' ? intent.customer : null))
  // Móvil: lista y perfil se alternan.
  const [showDetail, setShowDetail] = useState(() => intent?.customer != null)
  const [creating, setCreating] = useState(false)

  const listQ = useQuery({
    queryKey: ['customers', 'list', active],
    queryFn: () => listCustomers({
      active: active === 'all' ? 'all' : active === 'active',
    }),
  })
  const all = useMemo(() => listQ.data ?? [], [listQ.data])
  const counts = useMemo(() => {
    const c: Record<string, number> = { '': all.length }
    for (const k of CUSTOMER_KINDS) c[k] = 0
    for (const x of all) c[x.kind] = (c[x.kind] ?? 0) + 1
    return c
  }, [all])
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    return all
      .filter((c) => !kind || c.kind === kind)
      .filter((c) => !s || c.name.toLowerCase().includes(s)
        || locOf(c).toLowerCase().includes(s))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [all, q, kind])

  // Selección derivada: la elegida (aunque no esté en la lista filtrada) o
  // la primera de la lista.
  const profileId = selId ?? rows[0]?.id ?? null
  const selIndex = rows.findIndex((r) => r.id === profileId)
  const onListKey = listKeyHandler(rows, selIndex, (c) => setSelId(c.id))

  function select(id: number) {
    setSelId(id)
    setShowDetail(true)
  }

  return (
    <div className="page page-wide rx-page">
      {listQ.isFetching && <div className="loadbar" aria-hidden="true" />}
      <div className="page-head">
        <div>
          <h1>Customers</h1>
          <p className="page-sub">
            Owner-operators and outside carriers you bill for shop parts and
            labor — with their units, work orders and open balance.
          </p>
        </div>
        {editable && (
          <div className="head-actions">
            <Button variant="primary" onClick={() => setCreating(true)}
              icon={<PlusIcon />}>
              New customer
            </Button>
          </div>
        )}
      </div>

      {listQ.isError && !listQ.data ? (
        <section className="card">
          <RxEmpty icon={ICONS.customers} title="Couldn't load customers">
            <p>{String(listQ.error instanceof Error
              ? listQ.error.message : listQ.error)}</p>
            <button type="button" className="link-btn"
              onClick={() => { void listQ.refetch() }}>Retry</button>
          </RxEmpty>
        </section>
      ) : (
        <div className={`rx-layout ${showDetail ? 'show-detail' : ''}`}>
          <aside className="rx-list" aria-label="Customers">
            <div className="rx-list-tools">
              <input className="cell-input rx-search" type="search"
                placeholder="Search customers…" value={q}
                aria-label="Search customers"
                onChange={(e) => setQ(e.target.value)} />
              <RxSeg<ActiveFilter> label="Status" value={active}
                onChange={setActive}
                options={[
                  { id: 'active', label: 'Active' },
                  { id: 'inactive', label: 'Inactive' },
                  { id: 'all', label: 'All' },
                ]} />
              <div className="rx-chips" role="group" aria-label="Customer type">
                {(['', ...CUSTOMER_KINDS] as (CustomerKind | '')[]).map((k) => (
                  <button key={k || 'all'} type="button"
                    className={`rx-chip ${kind === k ? 'is-on' : ''}`}
                    aria-pressed={kind === k}
                    onClick={() => setKind(k)}>
                    {k ? CUSTOMER_KIND_LABEL[k] : 'All types'}
                    <span className="rx-chip-n">{counts[k] ?? 0}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="rx-list-head">
              <span>{rows.length} customer{rows.length === 1 ? '' : 's'}</span>
              <span>Balance</span>
            </div>
            <div className="rx-list-body" role="listbox"
              aria-label="Customer list"
              onKeyDown={onListKey}>
              {listQ.isPending ? (
                Array.from({ length: 7 }).map((_, i) => (
                  <Skeleton key={i} h={52} r={10} />
                ))
              ) : rows.length === 0 ? (
                <RxEmpty title={all.length ? 'No customers match'
                  : 'No customers yet'}>
                  {all.length ? (
                    <button type="button" className="link-btn"
                      onClick={() => { setQ(''); setKind('') }}>
                      Clear filters
                    </button>
                  ) : (
                    <p>Add the owner-operators whose units you service — or
                      quick-add them from a work order.</p>
                  )}
                </RxEmpty>
              ) : rows.map((c) => (
                <RxRow key={c.id} selected={c.id === profileId}
                  onSelect={() => select(c.id)}
                  avatar={<RxAvatar name={c.name} />}
                  title={c.name}
                  sub={<CustomerSub c={c} />}
                  side={c.balance > 0
                    ? <span className="rx-money is-due"
                        title="Invoiced and unpaid">{money(c.balance)}</span>
                    : c.open_wos > 0
                      ? <span className="rx-pill">{c.open_wos} open</span>
                      : null} />
              ))}
            </div>
          </aside>

          <section className="rx-detail" aria-label="Customer profile">
            {profileId != null ? (
              <CustomerProfilePanel key={profileId} id={profileId}
                editable={editable}
                onBack={() => setShowDetail(false)}
                onGone={() => { setSelId(null); setShowDetail(false) }} />
            ) : (
              <RxEmpty icon={ICONS.customers} title="Pick a customer">
                <p>Their units, work orders and open balance show here.</p>
              </RxEmpty>
            )}
          </section>
        </div>
      )}

      {creating && (
        <CustomerModal onClose={() => setCreating(false)}
          onSaved={(c) => { setCreating(false); select(c.id) }} />
      )}
    </div>
  )
}

function CustomerSub({ c }: { c: CustomerSummary }) {
  const loc = locOf(c)
  const yr = sinceYear(c.since)
  return (
    <>
      {loc || 'No address'}
      {yr ? <span className="rx-sep">Since {yr}</span> : null}
      {!c.active && <span className="rx-sep rx-muted-tag">Inactive</span>}
    </>
  )
}

// ----- Perfil ---------------------------------------------------------------

function CustomerProfilePanel({ id, editable, onBack, onGone }: {
  id: number
  editable: boolean
  onBack: () => void
  onGone: () => void
}) {
  const qc = useQueryClient()
  const { can } = usePerms()
  const [tab, setTab] = useState<ProfileTab>('overview')
  const [editing, setEditing] = useState(false)
  const [openWo, setOpenWo] = useState<number | null>(null)
  const profQ = useQuery({
    queryKey: ['customer', id],
    queryFn: () => getCustomer(id),
  })
  const p = profQ.data

  function refresh() {
    qc.invalidateQueries({ queryKey: ['customer', id] })
    qc.invalidateQueries({ queryKey: ['customers'] })
  }

  if (profQ.isPending) {
    return (
      <div className="rx-pskel">
        <Skeleton w="45%" h={24} />
        <Skeleton w="30%" h={14} />
        <div className="rx-kpis">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} h={72} r={12} />)}
        </div>
        <Skeleton h={180} r={12} />
      </div>
    )
  }
  if (!p?.customer) {
    return (
      <RxEmpty title="Customer not found">
        <p>{profQ.error ? String(profQ.error) : 'It may have been deleted.'}</p>
        <RxBack label="Customers" onClick={onBack} />
      </RxEmpty>
    )
  }
  const c = p.customer
  const nUnpaid = p.work_orders.filter((w) =>
    w.status === 'invoiced' && w.payment_status !== 'paid').length

  return (
    <>
      <header className="rx-phead">
        <RxBack label="Customers" onClick={onBack} />
        <RxAvatar name={c.name} size="lg" />
        <div className="rx-phead-main">
          <span className="rx-eyebrow">Customer</span>
          <h2 className="rx-ptitle">{c.name}</h2>
          <div className="rx-pchips">
            <span className="rx-pill">{CUSTOMER_KIND_LABEL[c.kind] ?? c.kind}</span>
            {!c.active && <span className="rx-pill is-muted">Inactive</span>}
            {locOf(c) && <span className="rx-psub">{locOf(c)}</span>}
            {sinceYear(c.since) && (
              <span className="rx-psub">Since {sinceYear(c.since)}</span>
            )}
          </div>
        </div>
        {editable && (
          <div className="rx-phead-actions">
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          </div>
        )}
      </header>

      <div className="rx-tabs">
        <Tabs aria-label="Customer sections"
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'work_orders', label: <>Work orders<TabN n={p.work_orders.length} /></> },
            { id: 'parts', label: 'Parts billed' },
            { id: 'contacts', label: <>Contacts<TabN n={p.contacts.length} /></> },
            ...(editable ? [{ id: 'settings', label: 'Settings' }] : []),
          ]}
          value={tab}
          onChange={(t) => setTab(t as ProfileTab)} />
      </div>

      <div className="rx-pbody">
        {tab === 'overview' && (
          <OverviewTab p={p} editable={editable} onChanged={refresh}
            onUnpaid={() => setTab('work_orders')} nUnpaid={nUnpaid} />
        )}
        {tab === 'work_orders' && (
          <WorkOrdersTab p={p} editable={can('wo.invoice')} onOpen={setOpenWo}
            onChanged={refresh} />
        )}
        {tab === 'parts' && <PartsTab p={p} />}
        {tab === 'contacts' && (
          <ContactsTab p={p} editable={editable} onChanged={refresh} />
        )}
        {tab === 'settings' && editable && (
          <SettingsTab p={p} onSaved={refresh} onGone={onGone} />
        )}
      </div>

      {editing && (
        <CustomerModal customer={c} onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); refresh() }} />
      )}
      <WoDrawer woId={openWo} onClose={() => { setOpenWo(null); refresh() }} />
    </>
  )
}

function TabN({ n }: { n: number }) {
  return n ? <span className="rx-tab-n">{n}</span> : null
}

// --- Overview ---------------------------------------------------------------
function OverviewTab({ p, editable, onChanged, onUnpaid, nUnpaid }: {
  p: CustomerProfile
  editable: boolean
  onChanged: () => void
  onUnpaid: () => void
  nUnpaid: number
}) {
  const { navigate } = useShell()
  const c = p.customer
  const t = p.totals
  const addr = [c.address, [c.city, [c.state, c.zip].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ')].filter(Boolean)
  const tags = (c.tags || '').split(',').map((x) => x.trim()).filter(Boolean)
  const billing = p.contacts.find((x) => x.is_billing)

  return (
    <div className="rx-stack">
      <div className="rx-kpis">
        <RxKpi label="Billed YTD" value={money(t.billed_ytd)}
          sub={`${money(t.billed_all)} all time`} />
        <RxKpi label="Open balance" value={money(t.open_balance)}
          tone={t.open_balance > 0 ? 'warn' : undefined}
          sub={t.open_balance > 0 ? (
            <button type="button" className="link-btn" onClick={onUnpaid}>
              {nUnpaid} unpaid invoice{nUnpaid === 1 ? '' : 's'}
            </button>
          ) : 'All invoices paid'} />
        <RxKpi label="Work orders" value={t.wo_count}
          sub={`${p.work_orders.filter((w) => w.status !== 'invoiced').length} open`} />
        <RxKpi label="Units" value={p.units.length}
          sub={p.units.length ? 'owned' : 'none linked'} />
      </div>

      <div className="rx-grid2">
        <RxBlock title="Contact">
          <RxDl rows={[
            ['Email', c.email ? <Pii v={c.email} /> : ''],
            ['Phone', c.phone ? <Pii v={c.phone} /> : ''],
            ['Address', addr.length ? (
              <span className="rx-addr">
                {addr.map((l, i) => <span key={i}><Pii v={l} /></span>)}
              </span>
            ) : ''],
            ['Billing contact', billing ? billing.name : ''],
            ['Linked driver', c.driver_name ? (
              <button type="button" className="link-btn"
                onClick={() => navigate('drivers', { driver: c.driver_name })}>
                {c.driver_name}
              </button>
            ) : ''],
          ]} />
        </RxBlock>
        <RxBlock title="Billing">
          <RxDl rows={[
            ['Terms', TERMS_LABEL[c.terms] ?? c.terms],
            ['Parts markup', `${c.parts_markup_pct || 0}%`],
            ['Labor markup', `${c.labor_markup_pct || 0}%`],
            ['Tax', c.tax_exempt ? 'Exempt'
              : c.tax_rate_pct ? `${c.tax_rate_pct}% on parts` : 'Not set'],
            ['Accounting ID', c.accounting_id],
          ]} />
        </RxBlock>
      </div>

      <UnitsBlock p={p} editable={editable} onChanged={onChanged} />

      {(c.notes || tags.length > 0) && (
        <RxBlock title="Notes">
          {tags.length > 0 && (
            <div className="rx-tags">
              {tags.map((x) => <span key={x} className="rx-tag">{x}</span>)}
            </div>
          )}
          {c.notes && <p className="rx-notes">{c.notes}</p>}
        </RxBlock>
      )}
    </div>
  )
}

// Valor posiblemente enmascarado (sin pii.view): se marca como oculto.
function Pii({ v }: { v: string }) {
  if (!isMasked(v)) return <>{v}</>
  return (
    <span className="rx-masked" title="Hidden — needs permission to view personal data">
      {v}
    </span>
  )
}

function UnitsBlock({ p, editable, onChanged }: {
  p: CustomerProfile
  editable: boolean
  onChanged: () => void
}) {
  const qc = useQueryClient()
  const { navigate } = useShell()
  const known = useKnownUnits()
  const [adding, setAdding] = useState(false)
  const [unit, setUnit] = useState('')
  const [busy, setBusy] = useState(false)
  const id = p.customer.id

  async function add() {
    const u = unit.trim()
    if (!u || busy) return
    setBusy(true)
    try {
      await setCustomerUnit(id, u)
      // Mover el dueño cambia el perfil del dueño anterior y el mapa.
      qc.invalidateQueries({ queryKey: ['customer'] })
      onChanged()
      notifyOk('Unit linked', `${u} · ${p.customer.name}`)
      setUnit('')
      setAdding(false)
    } catch (e) {
      notifyErr("Couldn't link the unit", e)
    } finally {
      setBusy(false)
    }
  }

  async function remove(u: string) {
    if (!window.confirm(`Unlink ${u} from ${p.customer.name}? `
      + 'Past work orders keep their Bill to.')) return
    try {
      await removeCustomerUnit(id, u)
      onChanged()
      notifyOk('Unit unlinked', u)
    } catch (e) {
      notifyErr("Couldn't unlink the unit", e)
    }
  }

  return (
    <RxBlock title={`Units owned · ${p.units.length}`}
      action={editable && !adding ? (
        <button type="button" className="btn btn-ghost btn-xs"
          onClick={() => setAdding(true)}>+ Add unit</button>
      ) : undefined}>
      {adding && (
        <form className="rx-inline-add"
          onSubmit={(e) => { e.preventDefault(); void add() }}>
          <UnitPicker value={unit} onChange={setUnit} extraUnits={known}
            autoFocus placeholder="Pick a unit" aria-label="Unit to link" />
          <Button variant="primary" size="sm" type="submit" loading={busy}
            disabled={!unit.trim()}>Link unit</Button>
          <Button variant="ghost" size="sm"
            onClick={() => { setAdding(false); setUnit('') }}>Cancel</Button>
          <span className="field-hint rx-inline-hint">
            New work orders for this unit bill to {p.customer.name} by
            default. A unit has one owner — linking it here moves it.
          </span>
        </form>
      )}
      {p.units.length === 0 ? (
        !adding && (
          <p className="rx-none">
            No units linked. Link the units this customer owns so their
            work orders bill here automatically.
          </p>
        )
      ) : (
        <ul className="rx-units">
          {p.units.map((u) => (
            <li key={u.unit} className="rx-unit">
              <button type="button" className="rx-unit-main"
                title={`Open unit ${u.unit}`}
                onClick={() => navigate('flota', { unit: u.unit })}>
                <span className="rx-unit-ico" aria-hidden="true">{ICONS.flota}</span>
                <strong>{u.unit}</strong>
                {u.model && <span>{u.model}</span>}
              </button>
              {editable && (
                <button type="button" className="icon-x"
                  aria-label={`Unlink ${u.unit}`} title="Unlink unit"
                  onClick={() => remove(u.unit)}>✕</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </RxBlock>
  )
}

// --- Work orders --------------------------------------------------------------
function WorkOrdersTab({ p, editable, onOpen, onChanged }: {
  p: CustomerProfile
  // Puede marcar Paid/Unpaid: wo.invoice (la ruta lo exige), no maint.edit.
  editable: boolean
  onOpen: (id: number) => void
  onChanged: () => void
}) {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<'all' | 'open' | 'unpaid'>('all')
  const [busy, setBusy] = useState<number | null>(null)
  const rows = p.work_orders.filter((w) =>
    filter === 'all' ? true
      : filter === 'open' ? w.status !== 'invoiced'
        : w.status === 'invoiced' && w.payment_status !== 'paid')

  async function setPaid(woId: number, ps: WoPaymentStatus) {
    setBusy(woId)
    try {
      await patchWorkOrder(woId, { payment_status: ps })
      qc.invalidateQueries({ queryKey: ['workorder', woId] })
      qc.invalidateQueries({ queryKey: ['workorders'] })
      onChanged()
      notifyOk(ps === 'paid' ? 'Marked as paid' : 'Marked as unpaid')
    } catch (e) {
      notifyErr("Couldn't update the payment", e)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rx-stack">
      <div className="rx-toolbar">
        <RxSeg label="Work order filter" value={filter} onChange={setFilter}
          options={[
            { id: 'all', label: `All · ${p.work_orders.length}` },
            { id: 'open', label: 'Open' },
            { id: 'unpaid', label: 'Unpaid' },
          ]} />
        <span className="rx-toolbar-note">
          Open balance <strong>{money(p.totals.open_balance)}</strong>
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="rx-none">
          {p.work_orders.length === 0
            ? 'No work orders billed to this customer yet. Pick them in Bill to on a work order.'
            : 'No work orders in this view.'}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="defects-table rx-table">
            <thead>
              <tr>
                <th scope="col">WO</th>
                <th scope="col">Unit · work</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">Billable</th>
                <th scope="col">Payment</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => {
                const sm = STATUS_META[w.status]
                const invoiced = w.status === 'invoiced'
                const paid = w.payment_status === 'paid'
                return (
                  <tr key={w.id} onClick={() => onOpen(w.id)}
                    className="rx-click">
                    <td className="mono">
                      <button type="button" className="link-btn"
                        onClick={(e) => { e.stopPropagation(); onOpen(w.id) }}>
                        #{w.display_no || w.id}
                      </button>
                    </td>
                    <td className="rx-cell-2">
                      <strong>{w.unit}</strong>
                      <span title={w.title}>{w.title}</span>
                    </td>
                    <td className="rx-cell-2">
                      <span className={`wo-status ${sm?.cls ?? ''}`}>
                        {sm?.label ?? w.status}
                      </span>
                      {w.invoiced_at && (
                        <span className="muted">{dateOf(w.invoiced_at)}</span>
                      )}
                    </td>
                    <td className="num mono"
                      title={w.billable_tax ? `Includes ${money(w.billable_tax)} tax on parts` : undefined}>
                      {money(w.billable_due ?? w.billable_total)}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {invoiced ? (
                        <button type="button"
                          className={`rx-paybtn ${paid ? 'is-paid' : 'is-due'}`}
                          disabled={!editable || busy === w.id}
                          aria-pressed={paid}
                          title={editable ? (paid ? 'Mark as unpaid' : 'Mark as paid')
                            : 'Marking payment needs invoicing permission'}
                          onClick={() => setPaid(w.id, paid ? 'unpaid' : 'paid')}>
                          {busy === w.id ? '…' : paid ? 'Paid' : 'Unpaid'}
                        </button>
                      ) : (
                        <span className="muted">Not invoiced</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// --- Parts billed -------------------------------------------------------------
function PartsTab({ p }: { p: CustomerProfile }) {
  const total = p.parts_billed.reduce((s, x) => s + (x.amount || 0), 0)
  const qty = p.parts_billed.reduce((s, x) => s + (x.qty || 0), 0)
  if (p.parts_billed.length === 0) {
    return (
      <p className="rx-none">
        No parts billed yet. Parts on this customer's invoiced work orders
        show here with the amount billed.
      </p>
    )
  }
  return (
    <div className="table-wrap">
      <table className="defects-table rx-table">
        <thead>
          <tr>
            <th scope="col">Part #</th>
            <th scope="col">Description</th>
            <th scope="col" className="num">Qty</th>
            <th scope="col" className="num">Amount billed</th>
          </tr>
        </thead>
        <tbody>
          {p.parts_billed.map((x, i) => (
            <tr key={`${x.part_number}-${i}`}>
              <td className="mono">{x.part_number || <span className="muted">—</span>}</td>
              <td>{x.description}</td>
              <td className="num">{x.qty}</td>
              <td className="num mono">{money(x.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="rx-tfoot">
            <th scope="row" colSpan={2}>Total · {p.parts_billed.length} parts</th>
            <td className="num">{qty}</td>
            <td className="num mono"><strong>{money(total)}</strong></td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// --- Contacts -----------------------------------------------------------------
type ContactDraft = { name: string; role: string; email: string; phone: string
                      is_billing: boolean }
const emptyContact = (): ContactDraft =>
  ({ name: '', role: '', email: '', phone: '', is_billing: false })

function ContactsTab({ p, editable, onChanged }: {
  p: CustomerProfile
  editable: boolean
  onChanged: () => void
}) {
  // null = sin form; 'new' = alta; id = edición.
  const [editId, setEditId] = useState<number | 'new' | null>(null)
  return (
    <div className="rx-stack">
      {editable && editId !== 'new' && (
        <div className="rx-toolbar">
          <span className="rx-toolbar-note">
            The billing contact gets invoices by email.
          </span>
          <button type="button" className="btn btn-ghost btn-xs"
            onClick={() => setEditId('new')}>+ Add contact</button>
        </div>
      )}
      {editId === 'new' && (
        <ContactForm customerId={p.customer.id} initial={emptyContact()}
          onDone={(saved) => { setEditId(null); if (saved) onChanged() }} />
      )}
      {p.contacts.length === 0 && editId !== 'new' ? (
        <p className="rx-none">No contacts yet.</p>
      ) : (
        <ul className="rx-contacts">
          {p.contacts.map((ct) => (
            editId === ct.id ? (
              <li key={ct.id}>
                <ContactForm customerId={p.customer.id} contact={ct}
                  initial={{ name: ct.name, role: ct.role,
                    email: isMasked(ct.email) ? '' : ct.email,
                    phone: isMasked(ct.phone) ? '' : ct.phone,
                    is_billing: ct.is_billing }}
                  onDone={(saved) => { setEditId(null); if (saved) onChanged() }} />
              </li>
            ) : (
              <li key={ct.id} className="rx-contact">
                <RxAvatar name={ct.name} size="sm" />
                <span className="rx-contact-main">
                  <strong>
                    {ct.name}
                    {ct.is_billing && <span className="rx-pill is-accent">Billing</span>}
                  </strong>
                  <span className="rx-row-sub">
                    {[ct.role, ct.email, ct.phone].filter(Boolean).map((x, i) => (
                      <span key={i} className={i ? 'rx-sep' : ''}><Pii v={x} /></span>
                    ))}
                  </span>
                </span>
                {editable && (
                  <span className="rx-contact-actions">
                    <button type="button" className="btn btn-ghost btn-xs"
                      onClick={() => setEditId(ct.id)}>Edit</button>
                    <DeleteContact customerId={p.customer.id} contact={ct}
                      onDone={onChanged} />
                  </span>
                )}
              </li>
            )
          ))}
        </ul>
      )}
    </div>
  )
}

function DeleteContact({ customerId, contact, onDone }: {
  customerId: number
  contact: CustomerContact
  onDone: () => void
}) {
  return (
    <button type="button" className="icon-x" aria-label={`Delete ${contact.name}`}
      title="Delete contact"
      onClick={async () => {
        if (!window.confirm(`Delete contact ${contact.name}?`)) return
        try {
          await deleteCustomerContact(customerId, contact.id)
          notifyOk('Contact deleted', contact.name)
          onDone()
        } catch (e) {
          notifyErr("Couldn't delete the contact", e)
        }
      }}>✕</button>
  )
}

function ContactForm({ customerId, contact, initial, onDone }: {
  customerId: number
  contact?: CustomerContact
  initial: ContactDraft
  onDone: (saved: boolean) => void
}) {
  const [f, setF] = useState<ContactDraft>(initial)
  const [busy, setBusy] = useState(false)
  const emailMasked = !!contact && isMasked(contact.email)
  const phoneMasked = !!contact && isMasked(contact.phone)

  async function save() {
    if (!f.name.trim() || busy) return
    setBusy(true)
    try {
      const body = {
        name: f.name.trim(), role: f.role.trim(), is_billing: f.is_billing,
        ...(emailMasked ? {} : { email: f.email.trim() }),
        ...(phoneMasked ? {} : { phone: f.phone.trim() }),
      }
      if (contact) await patchCustomerContact(customerId, contact.id, body)
      else await addCustomerContact(customerId, body)
      notifyOk(contact ? 'Contact saved' : 'Contact added', f.name.trim())
      onDone(true)
    } catch (e) {
      notifyErr("Couldn't save the contact", e)
      setBusy(false)
    }
  }

  return (
    <form className="rx-cform"
      onSubmit={(e) => { e.preventDefault(); void save() }}>
      <label className="ud-field">
        <span>Name *</span>
        <input className="cell-input" value={f.name} autoFocus maxLength={120}
          onChange={(e) => setF({ ...f, name: e.target.value })} />
      </label>
      <label className="ud-field">
        <span>Role</span>
        <input className="cell-input" value={f.role} maxLength={60}
          placeholder="Owner, dispatcher, accounting…"
          onChange={(e) => setF({ ...f, role: e.target.value })} />
      </label>
      <label className="ud-field">
        <span>Email</span>
        <input className="cell-input" type="email" value={f.email}
          disabled={emailMasked}
          placeholder={emailMasked ? 'Hidden' : 'name@company.com'}
          onChange={(e) => setF({ ...f, email: e.target.value })} />
      </label>
      <label className="ud-field">
        <span>Phone</span>
        <input className="cell-input" inputMode="tel" value={f.phone}
          disabled={phoneMasked} placeholder={phoneMasked ? 'Hidden' : ''}
          onChange={(e) => setF({ ...f, phone: e.target.value })} />
      </label>
      <label className="cf-check rx-cform-wide">
        <input type="checkbox" checked={f.is_billing}
          onChange={(e) => setF({ ...f, is_billing: e.target.checked })} />
        <span><strong>Billing contact</strong>
          <span className="field-hint"> — invoices are emailed here</span></span>
      </label>
      <div className="rx-cform-actions">
        <Button variant="ghost" size="sm" onClick={() => onDone(false)}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" type="submit" loading={busy}
          disabled={!f.name.trim()}>
          {contact ? 'Save contact' : 'Add contact'}
        </Button>
      </div>
    </form>
  )
}

// --- Settings -------------------------------------------------------------
function SettingsTab({ p, onSaved, onGone }: {
  p: CustomerProfile
  onSaved: () => void
  onGone: () => void
}) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const c = p.customer
  const hasWos = p.totals.wo_count > 0 || p.work_orders.length > 0

  async function remove() {
    const msg = hasWos
      ? `${c.name} has work orders, so it will be deactivated (history is kept). Continue?`
      : `Delete ${c.name}? This cannot be undone.`
    if (!window.confirm(msg)) return
    setBusy(true)
    try {
      const r = await deleteCustomer(c.id)
      qc.invalidateQueries({ queryKey: ['customers'] })
      qc.invalidateQueries({ queryKey: ['customer', c.id] })
      notifyOk(r.deactivated ? 'Customer deactivated' : 'Customer deleted', c.name)
      if (!r.deactivated) onGone()
    } catch (e) {
      notifyErr("Couldn't remove the customer", e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rx-stack">
      <CustomerForm key={c.updated_at} customer={c} autoFocus={false}
        onSaved={onSaved} submitLabel="Save changes" />
      <section className="rx-danger">
        <div>
          <strong>{hasWos ? 'Deactivate customer' : 'Delete customer'}</strong>
          <p>
            {hasWos
              ? 'Customers with work orders are deactivated, never deleted: their invoices and history stay intact.'
              : 'Removes this customer and its contacts. Units go back to having no owner.'}
          </p>
        </div>
        <Button variant="ghost" size="sm" className="up-danger" loading={busy}
          disabled={hasWos && !c.active}
          onClick={remove}>
          {hasWos ? (c.active ? 'Deactivate' : 'Inactive') : 'Delete'}
        </Button>
      </section>
    </div>
  )
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      width="16" height="16" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
