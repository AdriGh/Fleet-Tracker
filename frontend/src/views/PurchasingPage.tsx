// Purchasing (Increment 4 del handoff de Design): la cola de PARTS REQUESTS
// (faltantes de bajo stock / WO / manual) se agrupa por vendor y se funde en
// una sola PO. Dos sub-vistas: Requests (esta cola) y Purchase orders (reusa
// PurchaseOrdersPage). El stock lo repone la PO al recibirse (pipeline de POs).
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  bundleRequests, cancelPartsRequest, generateLowStockRequests,
  listCores, listPartsRequests, listPurchaseOrders, returnCore,
  unreturnCore, type CoreItem, type PartsRequest,
} from '../api'
import { notifyOk, notifyErr } from '../toast'
import { Button, Tabs, StatCluster } from '../components/ds'
import StatCard from '../components/StatCard'
import Skeleton from '../components/Skeleton'
import PurchaseOrdersPage from './PurchaseOrdersPage'

type PurchTab = 'requests' | 'pos' | 'cores'

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const SOURCE_LABEL: Record<string, string> = {
  low_stock: 'Low stock', wo: 'Work order', manual: 'Manual',
}
const fmtDate = (iso: string) => (iso ? iso.slice(0, 10) : '—')

export default function PurchasingPage() {
  const [tab, setTab] = useState<PurchTab>('requests')
  const reqQ = useQuery({
    queryKey: ['parts-requests', 'pending'],
    queryFn: () => listPartsRequests('pending'),
  })
  // Conteo de POs para el label de la sub-tab (reusa la caché de POs).
  const posQ = useQuery({
    queryKey: ['purchase-orders', ''], queryFn: () => listPurchaseOrders(),
  })
  // Banco de cores (pendientes de devolver) para el label + KPIs.
  const coresQ = useQuery({
    queryKey: ['cores', 'pending'], queryFn: () => listCores('pending'),
  })

  const stats = reqQ.data?.stats
  const requests = reqQ.data?.requests ?? []
  const poCount = posQ.data?.purchase_orders.length ?? 0
  const coreStats = coresQ.data?.stats
  const coreCount = coreStats?.pending ?? 0

  return (
    <div className="page page-wide">
      {(reqQ.isFetching) && <div className="loadbar" aria-hidden="true" />}

      <div className="parts-head">
        <div>
          <span className="parts-eyebrow">Shop · Procurement</span>
          <h2 className="parts-title">Purchasing</h2>
          <p className="parts-sub">
            Every shortage lands here. Bundle requests by vendor and send one
            purchase order.
          </p>
        </div>
      </div>

      {tab === 'requests' && (
        <StatCluster className="kpi-row" columns="repeat(4, minmax(0, 1fr))">
          <StatCard label="Pending requests" value={stats?.pending ?? 0}
            sub={`${stats?.vendors ?? 0} vendors`}
            tone={stats?.pending ? 'warn' : 'default'} />
          <StatCard label="Est. value" value={money(stats?.pending_value ?? 0)}
            sub="to order" tone="info" />
          <StatCard label="POs in flight" value={stats?.pos_in_flight ?? 0}
            sub={stats?.in_flight_value
              ? `${money(stats.in_flight_value)} in flight` : 'none open'}
            tone={stats?.pos_in_flight ? 'accent' : 'default'} />
          <StatCard label="Received 30d"
            value={money(stats?.received_30d_value ?? 0)}
            sub={`${stats?.received_30d_count ?? 0} POs closed`} tone="ok" />
        </StatCluster>
      )}

      {tab === 'cores' && (
        <StatCluster className="kpi-row" columns="repeat(3, minmax(0, 1fr))">
          <StatCard label="Cores to return" value={coreStats?.pending ?? 0}
            sub={`${coreStats?.vendors ?? 0} vendors`}
            tone={coreStats?.pending ? 'warn' : 'ok'} />
          <StatCard label="Deposits outstanding"
            value={money(coreStats?.pending_deposit ?? 0)}
            sub="tied up until returned"
            tone={coreStats?.pending_deposit ? 'accent' : 'default'} />
          <StatCard label="Credited 30d"
            value={money(coreStats?.credited_30d ?? 0)}
            sub={`${coreStats?.returned_30d ?? 0} cores returned`} tone="ok" />
        </StatCluster>
      )}

      <div className="parts-toolbar">
        <Tabs
          tabs={[{ id: 'requests', label: `Requests · ${stats?.pending ?? 0}` },
            { id: 'pos', label: `Purchase orders · ${poCount}` },
            { id: 'cores', label: `Cores · ${coreCount}` }]}
          value={tab}
          onChange={(id) => setTab(id as PurchTab)}
        />
      </div>

      {tab === 'requests' && (
        <RequestsQueue requests={requests} pending={reqQ.isPending} />
      )}
      {tab === 'pos' && <PurchaseOrdersPage />}
      {tab === 'cores' && <CoresTab />}
    </div>
  )
}

// ----- Banco de cores: pendientes de devolver + devolución -----------------
function CoresTab() {
  const qc = useQueryClient()
  const [showReturned, setShowReturned] = useState(false)
  const status = showReturned ? 'returned' : 'pending'
  const coresQ = useQuery({
    queryKey: ['cores', status], queryFn: () => listCores(status),
  })
  const [busy, setBusy] = useState<number | null>(null)
  const cores = coresQ.data?.cores ?? []

  async function toggle(c: CoreItem) {
    setBusy(c.id)
    try {
      if (c.status === 'pending') await returnCore(c.id)
      else await unreturnCore(c.id)
      qc.invalidateQueries({ queryKey: ['cores'] })
      notifyOk(c.status === 'pending'
        ? 'Core returned' : 'Core reopened',
        `${c.part_number} · ${money(c.deposit)}`)
    } catch (e) {
      notifyErr("Couldn't update core", e)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>{showReturned ? 'Returned cores' : 'Core bank — pending return'}</h2>
        <span className="head-spacer" />
        <button className="btn btn-ghost btn-sm"
          onClick={() => setShowReturned((v) => !v)}>
          {showReturned ? 'Show pending' : 'Show returned'}
        </button>
      </div>
      <div className="card-body">
        {coresQ.isPending ? (
          <div className="skel-rows">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} h={34} />)}
          </div>
        ) : cores.length === 0 ? (
          <div className="empty mini">
            <p>{showReturned
              ? 'No cores returned yet.'
              : 'No cores to return. Cores appear here when you receive a PO '
                + 'of a part that carries a core charge.'}</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="defects-table wo-table">
              <thead>
                <tr>
                  <th>Part #</th>
                  <th>Description</th>
                  <th>Vendor</th>
                  <th className="num">Qty</th>
                  <th className="num">Deposit</th>
                  <th>{showReturned ? 'Returned' : 'Received'}</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {cores.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.part_number}</td>
                    <td className="wo-title">{c.description}</td>
                    <td>{c.vendor || <span className="muted">—</span>}</td>
                    <td className="num">{c.qty}</td>
                    <td className="num mono">{money(c.deposit)}</td>
                    <td className="muted">
                      {fmtDate(showReturned
                        ? (c.returned_at ?? '') : c.created_at)}
                    </td>
                    <td className="num">
                      <button className="btn btn-xs btn-primary"
                        disabled={busy === c.id}
                        onClick={() => toggle(c)}>
                        {c.status === 'pending'
                          ? (busy === c.id ? 'Returning…' : 'Mark returned')
                          : (busy === c.id ? 'Reopening…' : 'Reopen')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}

// ----- Cola de requests: agrupada por vendor + selección → PO --------------
function RequestsQueue({ requests, pending }: {
  requests: PartsRequest[]
  pending: boolean
}) {
  const qc = useQueryClient()
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)

  const groups = useMemo(() => {
    const m = new Map<string, PartsRequest[]>()
    for (const r of requests) {
      const k = r.vendor || 'No vendor'
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(r)
    }
    return [...m.entries()]
  }, [requests])

  const selected = useMemo(
    () => requests.filter((r) => sel.has(r.id)), [requests, sel])
  const selVendors = useMemo(
    () => new Set(selected.map((r) => r.vendor || 'No vendor')), [selected])
  const selTotal = selected.reduce((s, r) => s + r.total, 0)
  const oneVendor = selVendors.size === 1 && !selVendors.has('No vendor')
  const canBundle = selected.length > 0 && oneVendor

  function toggle(id: number) {
    setSel((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }
  function toggleGroup(rows: PartsRequest[]) {
    setSel((s) => {
      const n = new Set(s)
      const allIn = rows.every((r) => n.has(r.id))
      rows.forEach((r) => (allIn ? n.delete(r.id) : n.add(r.id)))
      return n
    })
  }

  function refresh() {
    qc.invalidateQueries({ queryKey: ['parts-requests'] })
    qc.invalidateQueries({ queryKey: ['purchase-orders'] })
    qc.invalidateQueries({ queryKey: ['parts'] })
    setSel(new Set())
  }

  async function generate() {
    setBusy(true)
    try {
      const r = await generateLowStockRequests()
      notifyOk(r.created ? 'Requests generated'
        : 'Nothing to generate',
        r.created ? `${r.created} low-stock part(s) queued`
          : 'All low-stock parts are already queued')
      refresh()
    } catch (e) { notifyErr("Couldn't generate requests", e) }
    finally { setBusy(false) }
  }

  async function bundle() {
    if (!canBundle) return
    setBusy(true)
    try {
      const r = await bundleRequests([...sel])
      notifyOk('Purchase order created',
        `PO-${r.po.id} · ${r.po.vendor} · ${money(r.po.total)} (${r.n} items)`)
      refresh()
    } catch (e) { notifyErr("Couldn't create the PO", e) }
    finally { setBusy(false) }
  }

  async function cancel(id: number) {
    try {
      await cancelPartsRequest(id)
      qc.invalidateQueries({ queryKey: ['parts-requests'] })
      setSel((s) => { const n = new Set(s); n.delete(id); return n })
    } catch (e) { notifyErr("Couldn't cancel request", e) }
  }

  return (
    <>
      <div className="purch-actions">
        <Button variant="ghost" size="sm" onClick={generate} loading={busy}>
          Generate from low stock
        </Button>
        <span className="head-spacer" />
        {selected.length > 0 && !oneVendor && (
          <span className="purch-hint">
            Select requests from a single vendor to bundle a PO.
          </span>
        )}
        <Button variant="primary" size="sm" onClick={bundle}
          disabled={!canBundle || busy}>
          {canBundle
            ? `Create PO · ${money(selTotal)} (${selected.length})`
            : 'Create PO'}
        </Button>
      </div>

      {pending ? (
        <section className="card"><div className="card-body">
          <div className="skel-rows">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} h={40} />)}
          </div>
        </div></section>
      ) : requests.length === 0 ? (
        <section className="card"><div className="card-body">
          <div className="empty mini">
            <p>No pending parts requests. Generate them from low stock, or
              they arrive from work orders when a part is out of stock.</p>
            <button className="btn btn-primary" onClick={generate}>
              Generate from low stock
            </button>
          </div>
        </div></section>
      ) : (
        <div className="purch-groups">
          {groups.map(([vendor, rows]) => {
            const allIn = rows.every((r) => sel.has(r.id))
            const groupTotal = rows.reduce((s, r) => s + r.total, 0)
            return (
              <section className="card purch-group" key={vendor}>
                <div className="purch-group-head">
                  <label className="purch-check">
                    <input type="checkbox" checked={allIn}
                      onChange={() => toggleGroup(rows)} />
                  </label>
                  <strong>{vendor}</strong>
                  <span className="badge-soft">{rows.length} request
                    {rows.length > 1 ? 's' : ''}</span>
                  <span className="head-spacer" />
                  <span className="mono sm muted">{money(groupTotal)}</span>
                </div>
                <div className="purch-rows">
                  {rows.map((r) => (
                    <div className={`purch-row${sel.has(r.id) ? ' is-sel' : ''}`}
                      key={r.id}>
                      <label className="purch-check">
                        <input type="checkbox" checked={sel.has(r.id)}
                          onChange={() => toggle(r.id)} />
                      </label>
                      <span className="purch-part">
                        <span className="purch-name">{r.description
                          || r.part_number}</span>
                        <span className="purch-pn mono">{r.part_number}</span>
                      </span>
                      <span className="purch-qty mono">×{r.qty}</span>
                      <span className="purch-src">
                        <span className="badge-soft">
                          {SOURCE_LABEL[r.source] ?? r.source}</span>
                        {r.source_ref && r.source_ref !== 'auto' && (
                          <span className="sm muted"> {r.source_ref}</span>)}
                      </span>
                      <span className="purch-by sm muted">
                        {r.requested_by || '—'} · {fmtDate(r.created_at)}
                      </span>
                      <span className="purch-price mono">{money(r.total)}</span>
                      <button className="icon-x" title="Cancel request"
                        onClick={() => cancel(r.id)}>✕</button>
                    </div>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </>
  )
}
