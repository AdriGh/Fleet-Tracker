// Catálogo de Partes + Vendors (fase H3, estilo Fullbay). Dos pestañas:
// Parts (catálogo con costo interno, vendor, inventario manual) y Vendors
// (proveedores). Se reusan al cargar líneas de una work order.
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  adjustPartStock, deletePart, deleteVendor, listPartMovements,
  listParts, listPurchaseOrders, listVendors, savePart, saveVendor,
  type Part, type PartInput, type StockMovement, type Vendor,
  type VendorInput,
} from '../api'
import { notifyOk, notifyErr } from '../toast'
import { Button, Tabs } from '../components/ds'
import Modal from '../components/Modal'
import Skeleton from '../components/Skeleton'
import StatCard from '../components/StatCard'
import { StatCluster } from '../components/ds'
import PurchaseOrdersPage, { QuickBuyButton } from './PurchaseOrdersPage'
import MarketplacePanel from './MarketplacePanel'

// ¿La parte está en/bajo su punto de reorden? (solo cuenta si reorder_point > 0)
function isLow(p: { on_hand: number; reorder_point: number }): boolean {
  return p.reorder_point > 0 && p.on_hand <= p.reorder_point
}

const fmtDate = (iso: string) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—')
const STOCK_REASON_LABEL: Record<string, string> = {
  po_receive: 'PO received',
  wo_consume: 'WO consumed',
  manual: 'Manual',
}

type Tab = 'parts' | 'vendors' | 'pos' | 'marketplace'

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export default function PartsPage() {
  const [tab, setTab] = useState<Tab>('parts')

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <h1>Parts &amp; Vendors</h1>
          <p className="page-sub">
            Shop catalog: parts with internal cost, the vendors you buy them
            from, purchase orders, and a marketplace search. Reused when
            building work orders.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-body filters-row">
          <Tabs
            tabs={[{ id: 'parts', label: 'Parts' },
              { id: 'vendors', label: 'Vendors' },
              { id: 'pos', label: 'Purchase Orders' },
              { id: 'marketplace', label: 'Marketplace' }]}
            value={tab}
            onChange={(id) => setTab(id as Tab)}
          />
        </div>
      </div>

      {tab === 'parts' && <PartsTab />}
      {tab === 'vendors' && <VendorsTab />}
      {tab === 'pos' && <PurchaseOrdersPage />}
      {tab === 'marketplace' && <MarketplacePanel />}
    </div>
  )
}

// Color por categoría (treemap + chips). Fallback gris para categorías nuevas.
const CATEGORY_COLOR: Record<string, string> = {
  Filters: '#34d399', Fluids: '#fbbf24', Tires: '#38bdf8', Brakes: '#fb7185',
  Electrical: '#a78bfa', Cab: '#f472b6', Engine: '#22d3ee',
  Suspension: '#f59e0b', Lighting: '#818cf8',
}
const catColor = (c: string) => CATEGORY_COLOR[c] || '#8b8b95'

type PartsView = 'overview' | 'list' | 'grid'

// ----- Pestaña Parts (3 vistas: Overview / List / Data grid) --------------
function PartsTab() {
  const qc = useQueryClient()
  const partsQ = useQuery({ queryKey: ['parts'], queryFn: listParts })
  const vendorsQ = useQuery({ queryKey: ['vendors'], queryFn: listVendors })
  const posQ = useQuery({
    queryKey: ['purchase-orders', ''], queryFn: () => listPurchaseOrders(),
  })

  const [view, setView] = useState<PartsView>('overview')
  const [q, setQ] = useState('')
  const [selectedPn, setSelectedPn] = useState<string | null>(null)
  const [spendCat, setSpendCat] = useState<string | null>(null)
  const [lowOnly, setLowOnly] = useState(false)
  const [editing, setEditing] = useState<Part | null>(null)
  const [adding, setAdding] = useState(false)
  const [adjusting, setAdjusting] = useState<Part | null>(null)

  const parts = partsQ.data?.parts ?? []
  const usage = partsQ.data?.usage ?? {}
  const vendors = vendorsQ.data ?? []
  const categories = partsQ.data?.categories ?? []
  const stats = posQ.data?.stats

  // KPIs
  const totalValue = useMemo(
    () => parts.reduce((s, p) => s + p.cost * (p.on_hand || 0), 0), [parts])
  const lowParts = useMemo(() => parts.filter(isLow), [parts])
  const blocking = useMemo(
    () => parts.filter((p) => (p.on_hand || 0) <= 0
      && (usage[p.part_number] || 0) > 0), [parts, usage])
  const openPOs = (stats?.draft || 0) + (stats?.ordered || 0)
  const openValue = stats?.open_value || 0

  // Valor de inventario por categoría (on_hand × costo): siempre poblado,
  // ata al KPI "Inventory value". (El gasto real por período llegará cuando
  // haya historial de recepción de POs.)
  const valueByCat = useMemo(() => {
    const m: Record<string, number> = {}
    for (const p of parts) {
      const v = p.cost * (p.on_hand || 0)
      if (v > 0) {
        const k = p.category || 'Uncategorized'
        m[k] = (m[k] || 0) + v
      }
    }
    return Object.entries(m).map(([cat, val]) => ({ cat, val }))
      .sort((a, b) => b.val - a.val)
  }, [parts])
  const totalCatValue = valueByCat.reduce((s, x) => s + x.val, 0)

  // Fast movers: por uso en WOs; si aún no hay historial, top por valor.
  const anyUsage = useMemo(
    () => parts.some((p) => usage[p.part_number]), [parts, usage])
  const fastMovers = useMemo(() => {
    const sorted = [...parts]
    if (anyUsage) {
      sorted.sort((a, b) =>
        (usage[b.part_number] || 0) - (usage[a.part_number] || 0))
    } else {
      sorted.sort((a, b) =>
        b.cost * (b.on_hand || 0) - a.cost * (a.on_hand || 0))
    }
    return sorted.slice(0, 6)
  }, [parts, usage, anyUsage])

  // Lista filtrada (List + Data grid comparten búsqueda + filtro por categoría).
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    let rows = parts
    if (lowOnly) rows = rows.filter(isLow)
    if (spendCat) rows = rows.filter((p) => (p.category || '') === spendCat)
    if (!s) return rows
    return rows.filter((p) =>
      p.part_number.toLowerCase().includes(s) ||
      p.description.toLowerCase().includes(s) ||
      p.category.toLowerCase().includes(s) ||
      p.vendor_name.toLowerCase().includes(s))
  }, [parts, q, lowOnly, spendCat])

  const selected = useMemo(
    () => parts.find((p) => p.part_number === selectedPn) ?? null,
    [parts, selectedPn])

  // Al entrar a List sin selección, elige la primera de la lista filtrada.
  const listFirst = filtered[0]?.part_number
  useEffect(() => {
    if (view === 'list' && !selectedPn && listFirst) setSelectedPn(listFirst)
  }, [view, selectedPn, listFirst])

  function refreshInventory() {
    qc.invalidateQueries({ queryKey: ['parts'] })
  }

  async function remove(p: Part) {
    if (!window.confirm(`Delete part ${p.part_number}?`)) return
    try {
      await deletePart(p.id)
      qc.invalidateQueries({ queryKey: ['parts'] })
      if (selectedPn === p.part_number) setSelectedPn(null)
      notifyOk('Part deleted', p.part_number)
    } catch (e) {
      notifyErr("Couldn't delete part", e)
    }
  }

  function exportCsv() {
    const head = ['Part #', 'Description', 'Category', 'Vendor', 'On hand',
      'Reorder', 'Unit cost', '90d use', 'Status']
    const rows = filtered.map((p) => [
      p.part_number, p.description, p.category, p.vendor_name,
      p.on_hand || 0, p.reorder_point || 0, p.cost.toFixed(2),
      usage[p.part_number] || 0, isLow(p) ? 'Low' : 'OK',
    ])
    const csv = [head, ...rows]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url; a.download = 'rigsmith-parts.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const partsCount = parts.length
  const shownCount = filtered.length

  return (
    <>
      {partsQ.isFetching && <div className="loadbar" aria-hidden="true" />}

      {/* Cabecera de Parts (eyebrow / h1 / sub + acciones) */}
      <div className="parts-head">
        <div>
          <span className="parts-eyebrow">Shop · Catalog + Inventory</span>
          <h2 className="parts-title">Parts</h2>
          <p className="parts-sub">
            Master catalog and stock. Purchase orders live in the{' '}
            <strong>Purchase Orders</strong> tab.
          </p>
        </div>
        <div className="parts-head-actions">
          <button className="btn btn-ghost btn-sm" onClick={exportCsv}
            disabled={!partsCount}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
              stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
              strokeLinejoin="round">
              <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
            </svg>
            Export CSV
          </button>
          <Button variant="primary" size="sm" onClick={() => setAdding(true)}
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" width="15" height="15" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            }>
            New part
          </Button>
        </div>
      </div>

      {/* KPIs */}
      <StatCluster className="kpi-row" columns="repeat(4, minmax(0, 1fr))">
        <StatCard label="Inventory value" value={money(totalValue)}
          sub={`${partsCount} parts · ${categories.length} categories`}
          tone="info" />
        <StatCard label="Low stock" value={lowParts.length}
          sub="below reorder"
          tone={lowParts.length ? 'danger' : 'ok'}
          progress={partsCount ? lowParts.length / partsCount : 0} />
        <StatCard label="Open POs" value={openPOs}
          sub={openValue ? `${money(openValue)} in flight` : 'none open'}
          tone={openPOs ? 'warn' : 'default'} />
        <StatCard label="Parts blocking WOs" value={blocking.length}
          sub={blocking.length
            ? `${blocking[0].part_number} +${blocking.length - 1} more`
            : 'none'}
          tone={blocking.length ? 'accent' : 'ok'}
          progress={partsCount ? blocking.length / partsCount : 0} />
      </StatCluster>

      {/* Toolbar: sub-vistas + búsqueda + conteo */}
      <div className="parts-toolbar">
        <Tabs
          tabs={[{ id: 'overview', label: 'Overview' },
            { id: 'list', label: 'List' },
            { id: 'grid', label: 'Data grid' }]}
          value={view}
          onChange={(id) => setView(id as PartsView)}
        />
        <span className="head-spacer" />
        {view !== 'overview' && (
          <input className="cell-input parts-search"
            placeholder="Search part, number, vendor…"
            value={q} onChange={(e) => setQ(e.target.value)} />
        )}
        <span className="parts-count mono">
          {shownCount} of {partsCount} parts · {lowParts.length} low
        </span>
      </div>

      {(spendCat || lowOnly) && (
        <div className="parts-active-filters">
          {spendCat && (
            <button className="low-filter-chip" onClick={() => setSpendCat(null)}>
              Category: {spendCat} · clear ✕
            </button>
          )}
          {lowOnly && (
            <button className="low-filter-chip" onClick={() => setLowOnly(false)}>
              Low stock only · clear ✕
            </button>
          )}
        </div>
      )}

      {partsQ.isPending ? (
        <section className="card"><div className="card-body">
          <div className="skel-rows">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} h={40} />)}
          </div>
        </div></section>
      ) : partsCount === 0 ? (
        <section className="card"><div className="card-body">
          <div className="empty mini">
            <p>No parts yet. Add the parts you stock or buy often.</p>
            <button className="btn btn-primary" onClick={() => setAdding(true)}>
              Add the first part
            </button>
          </div>
        </div></section>
      ) : view === 'overview' ? (
        <PartsOverview
          valueByCat={valueByCat} totalCatValue={totalCatValue}
          spendCat={spendCat} onSpendCat={setSpendCat}
          lowParts={lowParts} fastMovers={fastMovers} usage={usage}
          anyUsage={anyUsage}
          onOpenPart={(pn) => { setSelectedPn(pn); setView('list') }}
          onQuickbuyDone={() => {
            qc.invalidateQueries({ queryKey: ['purchase-orders'] })
            refreshInventory()
          }}
        />
      ) : view === 'list' ? (
        <PartsList
          rows={filtered} selectedPn={selectedPn} onSelect={setSelectedPn}
          selected={selected} usage={usage} pos={posQ.data?.purchase_orders ?? []}
          onEdit={setEditing} onAdjust={setAdjusting} onDelete={remove}
          onQuickbuyDone={() => {
            qc.invalidateQueries({ queryKey: ['purchase-orders'] })
            refreshInventory()
          }}
        />
      ) : (
        <PartsDataGrid rows={filtered} usage={usage}
          onOpen={(pn) => { setSelectedPn(pn); setView('list') }} />
      )}

      {(adding || editing) && (
        <PartModal part={editing} vendors={vendors}
          categories={categories}
          onClose={() => { setAdding(false); setEditing(null) }}
          onSaved={() => {
            setAdding(false); setEditing(null)
            refreshInventory()
          }} />
      )}

      {adjusting && (
        <AdjustStockModal part={adjusting}
          onClose={() => setAdjusting(null)}
          onAdjusted={refreshInventory} />
      )}
    </>
  )
}

// ----- Overview: treemap por categoría + bajo stock + fast movers ---------
function PartsOverview({
  valueByCat, totalCatValue, spendCat, onSpendCat, lowParts, fastMovers, usage,
  anyUsage, onOpenPart, onQuickbuyDone,
}: {
  valueByCat: { cat: string; val: number }[]
  totalCatValue: number
  spendCat: string | null
  onSpendCat: (c: string | null) => void
  lowParts: Part[]
  fastMovers: Part[]
  usage: Record<string, number>
  anyUsage: boolean
  onOpenPart: (pn: string) => void
  onQuickbuyDone: () => void
}) {
  return (
    <div className="parts-overview">
      <div className="parts-ov-grid">
        {/* Inventario por categoría — treemap (tira proporcional) */}
        <section className="card">
          <div className="card-head">
            <h2>Inventory by category</h2>
            <span className="head-spacer" />
            <span className="muted mono sm">
              current value · {money(totalCatValue)}
            </span>
          </div>
          <div className="card-body">
            {totalCatValue === 0 ? (
              <div className="empty mini"><p>
                No stock on hand yet — add parts with quantities to see the
                inventory split by category.
              </p></div>
            ) : (
              <div className="treemap">
                {valueByCat.map(({ cat, val }) => {
                  const pct = Math.round((val / totalCatValue) * 100)
                  const active = spendCat === cat
                  return (
                    <button key={cat}
                      className={`treemap-tile${active ? ' is-active' : ''}`}
                      style={{ flexGrow: Math.max(val, totalCatValue * 0.06),
                        background: catColor(cat) }}
                      onClick={() => onSpendCat(active ? null : cat)}
                      title={`${cat} · ${money(val)} · ${pct}%`}>
                      <span className="tm-cat">{cat}</span>
                      <span className="tm-amt mono">{money(val)}</span>
                      <span className="tm-pct mono">{pct}%</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </section>

        {/* Low stock */}
        <section className="card">
          <div className="card-head">
            <h2>Low stock</h2>
            <span className="head-spacer" />
            <span className="badge-soft danger">{lowParts.length}</span>
          </div>
          <div className="card-body">
            {lowParts.length === 0 ? (
              <div className="empty mini"><p>Fully stocked — nothing at or
                under its reorder point.</p></div>
            ) : (
              <ul className="ov-list">
                {lowParts.slice(0, 6).map((p) => (
                  <li key={p.id}>
                    <button className="ov-list-main"
                      onClick={() => onOpenPart(p.part_number)}>
                      <span className="ov-name">{p.description
                        || p.part_number}</span>
                      <span className="ov-sub mono">
                        {p.part_number} · {p.on_hand || 0} on hand ·
                        reorder {p.reorder_point}
                      </span>
                    </button>
                    <QuickBuyButton part={p} onBought={onQuickbuyDone} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      {/* Fast movers (o top por valor si aún no hay uso en WOs) */}
      <section className="card">
        <div className="card-head">
          <h2>{anyUsage ? 'Fast movers' : 'Top parts by value'}</h2>
          <span className="head-spacer" />
          <span className="muted mono sm">
            {anyUsage ? 'most-used parts' : 'by stock value'}
          </span>
        </div>
        <div className="card-body no-pad">
          {fastMovers.length === 0 ? (
            <div className="empty mini" style={{ padding: 20 }}>
              <p>No parts yet.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="defects-table dense">
                <thead><tr>
                  <th>Part</th><th className="num">Used 90d</th>
                  <th className="num">On hand</th><th>Status</th>
                </tr></thead>
                <tbody>
                  {fastMovers.map((p) => (
                    <tr key={p.id} onClick={() => onOpenPart(p.part_number)}>
                      <td><strong>{p.description || p.part_number}</strong>
                        <span className="muted mono sm"> · {p.part_number}</span>
                      </td>
                      <td className="num mono">{usage[p.part_number] || 0}×</td>
                      <td className="num mono">{p.on_hand || 0}</td>
                      <td>{isLow(p)
                        ? <span className="badge-soft danger">Low</span>
                        : <span className="badge-soft ok">In stock</span>}</td>
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

// ----- List: master-detail (lista + ficha de parte) -----------------------
function PartsList({
  rows, selectedPn, onSelect, selected, usage, pos,
  onEdit, onAdjust, onDelete, onQuickbuyDone,
}: {
  rows: Part[]
  selectedPn: string | null
  onSelect: (pn: string) => void
  selected: Part | null
  usage: Record<string, number>
  pos: import('../api').PurchaseOrder[]
  onEdit: (p: Part) => void
  onAdjust: (p: Part) => void
  onDelete: (p: Part) => void
  onQuickbuyDone: () => void
}) {
  return (
    <div className="parts-md">
      {/* Master list */}
      <div className="card parts-md-list">
        <div className="pl-scroll">
          {rows.length === 0 ? (
            <div className="empty mini" style={{ padding: 20 }}>
              <p>No parts match.</p>
            </div>
          ) : rows.map((p) => {
            const low = isLow(p)
            const sel = p.part_number === selectedPn
            return (
              <button key={p.id}
                className={`pl-row${sel ? ' is-sel' : ''}`}
                onClick={() => onSelect(p.part_number)}>
                <span className="pl-row-main">
                  <span className="pl-name">{p.description || p.part_number}</span>
                  <span className="pl-sub mono">{p.part_number}
                    {p.vendor_name ? ` · ${p.vendor_name}` : ''}</span>
                </span>
                <span className="pl-row-meta">
                  <span className={`badge-soft ${low ? 'danger' : 'ok'}`}>
                    {p.on_hand || 0} {low ? 'low' : 'in stock'}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Detail */}
      <div className="parts-md-detail">
        {selected
          ? <PartDetail part={selected} used={usage[selected.part_number] || 0}
              pos={pos.filter((po) => (po.lines || []).some((l) =>
                l.part_number === selected.part_number)
                || po.notes?.includes(selected.part_number))}
              onEdit={onEdit} onAdjust={onAdjust} onDelete={onDelete}
              onQuickbuyDone={onQuickbuyDone} />
          : <div className="card"><div className="empty mini"
              style={{ padding: 30 }}><p>Select a part to see its detail.</p>
            </div></div>}
      </div>
    </div>
  )
}

// Ficha de parte (columna derecha del master-detail).
function PartDetail({ part, used, pos, onEdit, onAdjust, onDelete,
  onQuickbuyDone }: {
  part: Part
  used: number
  pos: import('../api').PurchaseOrder[]
  onEdit: (p: Part) => void
  onAdjust: (p: Part) => void
  onDelete: (p: Part) => void
  onQuickbuyDone: () => void
}) {
  const low = isLow(part)
  const max = part.reorder_point > 0 ? part.reorder_point * 3 : 0
  const fillPct = max ? Math.min(1, (part.on_hand || 0) / max) : 0
  return (
    <div className="card part-detail">
      <div className="pd-head">
        <span className="pd-thumb" style={{ borderColor: catColor(part.category) }}>
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none"
            stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"
            strokeLinejoin="round">
            <path d="M12 2 3 7v10l9 5 9-5V7z" /><path d="M3 7l9 5 9-5M12 12v10" />
          </svg>
        </span>
        <div className="pd-title">
          <h2>{part.description || part.part_number}</h2>
          <span className="pd-pn mono">{part.part_number}</span>
        </div>
        <div className="pd-actions">
          <button className="btn btn-ghost btn-xs" onClick={() => onEdit(part)}>
            Edit</button>
          <button className="btn btn-ghost btn-xs" onClick={() => onAdjust(part)}>
            Adjust</button>
        </div>
      </div>

      <div className="pd-badges">
        {part.vendor_name && <span className="intg-chip">{part.vendor_name}</span>}
        {part.category && <span className="intg-chip"
          style={{ color: catColor(part.category) }}>{part.category}</span>}
        <span className={`badge-soft ${low ? 'danger' : 'ok'}`}>
          {low ? 'LOW STOCK' : 'IN STOCK'}</span>
      </div>

      {/* Mini instrumento: on hand / unit cost / used */}
      <StatCluster className="pd-stats" columns="repeat(3, minmax(0, 1fr))">
        <StatCard label="On hand" value={part.on_hand || 0}
          sub={part.reorder_point ? `reorder ${part.reorder_point}` : 'no reorder'}
          tone={low ? 'danger' : 'ok'} progress={fillPct} />
        <StatCard label="Unit cost" value={money(part.cost)}
          sub="internal" tone="info" />
        <StatCard label="Used 90d" value={used} sub="on work orders"
          tone="default" />
      </StatCluster>

      <div className="pd-cols">
        {/* Vendor & pricing */}
        <section className="pd-sec">
          <h3>Vendor &amp; pricing</h3>
          {part.vendor_name ? (
            <div className="pd-vendor-row">
              <span>{part.vendor_name}</span>
              <span className="mono">{money(part.cost)}</span>
            </div>
          ) : <p className="muted sm">No vendor set for this part.</p>}
          <div className="pd-qb">
            <QuickBuyButton part={part} onBought={onQuickbuyDone} />
          </div>
        </section>

        {/* Purchase history */}
        <section className="pd-sec">
          <h3>Purchase history</h3>
          {pos.length === 0 ? (
            <p className="muted sm">No purchase orders reference this part yet.</p>
          ) : (
            <ul className="pd-po-list">
              {pos.slice(0, 4).map((po) => (
                <li key={po.id}>
                  <span className="mono">PO-{po.id} · {po.vendor}</span>
                  <span className={`badge-soft ${po.status === 'received'
                    ? 'ok' : 'warn'}`}>{po.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {part.notes && <p className="pd-notes">{part.notes}</p>}

      <div className="pd-foot">
        <span className="muted mono sm">
          Source · manual entry {max ? `· suggested max ${max}` : ''}
        </span>
        <button className="icon-x" title="Delete part"
          onClick={() => onDelete(part)}>Delete</button>
      </div>
    </div>
  )
}

// ----- Data grid: tabla ancha de 9 columnas -------------------------------
function PartsDataGrid({ rows, usage, onOpen }: {
  rows: Part[]
  usage: Record<string, number>
  onOpen: (pn: string) => void
}) {
  return (
    <section className="card"><div className="card-body no-pad">
      {rows.length === 0 ? (
        <div className="empty mini" style={{ padding: 20 }}>
          <p>No parts match your search.</p></div>
      ) : (
        <div className="table-wrap">
          <table className="defects-table dense parts-grid">
            <thead><tr>
              <th>Part #</th><th>Name</th><th>Category</th><th>Vendor</th>
              <th className="num">On hand</th><th className="num">Reorder</th>
              <th className="num">Unit cost</th><th className="num">90d use</th>
              <th>Status</th>
            </tr></thead>
            <tbody>
              {rows.map((p) => {
                const low = isLow(p)
                return (
                  <tr key={p.id} className={low ? 'row-low' : undefined}
                    onClick={() => onOpen(p.part_number)}>
                    <td className="mono"><strong>{p.part_number}</strong></td>
                    <td>{p.description || <span className="muted">—</span>}</td>
                    <td>{p.category
                      ? <span className="intg-chip"
                          style={{ color: catColor(p.category) }}>{p.category}</span>
                      : <span className="muted">—</span>}</td>
                    <td>{p.vendor_name || <span className="muted">—</span>}</td>
                    <td className="num mono">{p.on_hand || 0}</td>
                    <td className="num mono">{p.reorder_point || '—'}</td>
                    <td className="num mono">{money(p.cost)}</td>
                    <td className="num mono">{usage[p.part_number] || 0}×</td>
                    <td>{low
                      ? <span className="badge-soft danger">Low</span>
                      : <span className="badge-soft ok">OK</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div></section>
  )
}

// ----- Ajuste manual de stock + bitácora ----------------------------------
// Modal por parte: aplica un delta (+/-) con nota y muestra los movimientos
// recientes (auditoría). El refresh es por invalidación de query (optimista
// vía refetch), siguiendo el patrón TanStack del resto de la página.
function AdjustStockModal({ part, onClose, onAdjusted }: {
  part: Part
  onClose: () => void
  onAdjusted: () => void
}) {
  const [delta, setDelta] = useState('')
  const [note, setNote] = useState('')
  const [onHand, setOnHand] = useState(part.on_hand || 0)
  const [saving, setSaving] = useState(false)

  // Bitácora de movimientos (más reciente primero).
  const movesQ = useQuery({
    queryKey: ['part-movements', part.part_number],
    queryFn: () => listPartMovements(part.part_number),
  })
  const moves: StockMovement[] = movesQ.data ?? []

  // Resultado previsto del ajuste (para mostrar "→ N" antes de aplicar).
  const d = Number(delta)
  const preview = Number.isFinite(d) && delta.trim() !== '' ? onHand + d : null

  async function apply(sign: 1 | -1) {
    const mag = Math.abs(Number(delta))
    if (!mag || !Number.isFinite(mag)) {
      notifyErr('Enter a quantity', 'Type how many units to add or remove')
      return
    }
    setSaving(true)
    try {
      const res = await adjustPartStock(part.part_number, sign * mag, note.trim())
      setOnHand(res.on_hand)
      setDelta(''); setNote('')
      notifyOk('Stock adjusted',
        `${part.part_number} · ${sign > 0 ? '+' : '−'}${mag} → ${res.on_hand}`)
      onAdjusted()
      movesQ.refetch()
    } catch (e) {
      notifyErr("Couldn't adjust stock", e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`Adjust stock · ${part.part_number}`} width={560}
      onClose={onClose}>
      <div className="wo-form">
        <div className="adj-onhand">
          <span className="adj-onhand-label">On hand</span>
          <span className="adj-onhand-val mono">{onHand}</span>
          {part.reorder_point > 0 && (
            <span className="adj-onhand-ro">
              reorder at {part.reorder_point}
              {isLow({ on_hand: onHand, reorder_point: part.reorder_point }) &&
                <span className="low-pill">Low</span>}
            </span>
          )}
        </div>

        <div className="wo-form-row">
          <label className="ud-field">
            <span>Quantity</span>
            <input className="cell-input" type="number" min="0" step="1"
              autoFocus value={delta} placeholder="e.g. 5"
              onChange={(e) => setDelta(e.target.value)} />
          </label>
          <label className="ud-field">
            <span>New on hand</span>
            <input className="cell-input" value={preview ?? onHand} disabled
              title="Preview of on hand after a +quantity adjust" />
          </label>
        </div>
        <label className="ud-field">
          <span>Note (optional)</span>
          <input className="cell-input" value={note}
            placeholder="Cycle count, found in bin, damaged…"
            onChange={(e) => setNote(e.target.value)} />
        </label>

        <div className="adj-actions">
          <button className="btn btn-ghost" onClick={() => apply(-1)}
            disabled={saving} title="Remove from stock">− Remove</button>
          <button className="btn btn-primary" onClick={() => apply(1)}
            disabled={saving} title="Add to stock">+ Add</button>
        </div>

        <section className="ud-sec adj-log">
          <h3>Recent movements</h3>
          {movesQ.isPending ? (
            <div className="skel-rows">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} h={28} />)}
            </div>
          ) : moves.length === 0 ? (
            <p className="muted">No movements yet for this part.</p>
          ) : (
            <div className="table-wrap adj-log-wrap">
              <table className="defects-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Reason</th>
                    <th className="num">Δ</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {moves.map((m) => (
                    <tr key={m.id}>
                      <td className="muted mono">{fmtDate(m.created_at)}</td>
                      <td>
                        <span className="intg-chip">
                          {STOCK_REASON_LABEL[m.reason] ?? m.reason}
                        </span>
                      </td>
                      <td className={`num mono adj-delta ${
                        m.delta < 0 ? 'is-neg' : 'is-pos'}`}>
                        {m.delta > 0 ? `+${m.delta}` : m.delta}
                      </td>
                      <td>{m.note || <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="settings-actions">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </Modal>
  )
}

function PartModal({ part, vendors, categories, onClose, onSaved }: {
  part: Part | null
  vendors: Vendor[]
  categories: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const [f, setF] = useState<PartInput & { id?: number }>(() => ({
    id: part?.id,
    part_number: part?.part_number ?? '',
    description: part?.description ?? '',
    category: part?.category ?? '',
    cost: part?.cost ?? 0,
    vendor_id: part?.vendor_id ?? null,
    on_hand: part?.on_hand ?? 0,
    reorder_point: part?.reorder_point ?? 0,
    notes: part?.notes ?? '',
  }))
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch })

  async function submit() {
    if (!String(f.part_number ?? '').trim()) {
      notifyErr('Missing part number', 'A part number is required')
      return
    }
    setSaving(true)
    try {
      await savePart(f)
      notifyOk(part ? 'Part updated' : 'Part added', f.part_number)
      onSaved()
    } catch (e) {
      notifyErr("Couldn't save part", e)
      setSaving(false)
    }
  }

  return (
    <Modal title={part ? `Edit ${part.part_number}` : 'Add part'} width={520}
      onClose={onClose}>
      <div className="wo-form">
        <div className="wo-form-row">
          <label className="ud-field">
            <span>Part number</span>
            <input className="cell-input" autoFocus value={f.part_number ?? ''}
              placeholder="BRK-100"
              onChange={(e) => set({ part_number: e.target.value })} />
          </label>
          <label className="ud-field">
            <span>Category</span>
            <input className="cell-input" list="part-cats" value={f.category ?? ''}
              placeholder="Brakes" onChange={(e) => set({ category: e.target.value })} />
            <datalist id="part-cats">
              {categories.map((c) => <option key={c} value={c} />)}
            </datalist>
          </label>
        </div>
        <label className="ud-field">
          <span>Description</span>
          <input className="cell-input" value={f.description ?? ''}
            placeholder="Brake pad set, steer axle"
            onChange={(e) => set({ description: e.target.value })} />
        </label>
        <div className="wo-form-row">
          <label className="ud-field">
            <span>Cost (internal)</span>
            <input className="cell-input" type="number" step="0.01"
              value={f.cost ?? 0}
              onChange={(e) => set({ cost: Number(e.target.value) })} />
          </label>
          <label className="ud-field">
            <span>On hand</span>
            <input className="cell-input" type="number"
              value={f.on_hand ?? 0}
              onChange={(e) => set({ on_hand: Number(e.target.value) })} />
          </label>
        </div>
        <label className="ud-field">
          <span>Reorder point</span>
          <input className="cell-input" type="number" min="0"
            value={f.reorder_point ?? 0}
            placeholder="0 = no low-stock alert"
            onChange={(e) => set({ reorder_point: Number(e.target.value) })} />
          <small className="field-hint">
            Flags this part as <strong>Low</strong> when on hand drops to or
            below this number. Leave 0 to disable the alert.
          </small>
        </label>
        <label className="ud-field">
          <span>Vendor</span>
          <select className="cell-input" value={f.vendor_id ?? ''}
            onChange={(e) => set({
              vendor_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">— none —</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </label>
        <label className="ud-field">
          <span>Notes</span>
          <input className="cell-input" value={f.notes ?? ''}
            onChange={(e) => set({ notes: e.target.value })} />
        </label>
        <div className="settings-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : part ? 'Save part' : 'Add part'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ----- Pestaña Vendors -----------------------------------------------------
function VendorsTab() {
  const qc = useQueryClient()
  const vendorsQ = useQuery({ queryKey: ['vendors'], queryFn: listVendors })
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<Vendor | null>(null)
  const [adding, setAdding] = useState(false)
  const vendors = vendorsQ.data ?? []

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return vendors
    return vendors.filter((v) =>
      v.name.toLowerCase().includes(s) ||
      v.contact.toLowerCase().includes(s) ||
      v.phone.toLowerCase().includes(s))
  }, [vendors, q])

  async function remove(v: Vendor) {
    if (!window.confirm(
      `Delete vendor ${v.name}?` +
      (v.parts_count ? ` ${v.parts_count} part(s) will keep no vendor.` : ''))) return
    try {
      await deleteVendor(v.id)
      qc.invalidateQueries({ queryKey: ['vendors'] })
      qc.invalidateQueries({ queryKey: ['parts'] })
      notifyOk('Vendor deleted', v.name)
    } catch (e) {
      notifyErr("Couldn't delete vendor", e)
    }
  }

  return (
    <>
      {vendorsQ.isFetching && <div className="loadbar" aria-hidden="true" />}
      <section className="card">
        <div className="card-head">
          <h2>Vendors</h2>
          <span className="head-spacer" />
          <input className="cell-input" placeholder="Search vendor…"
            value={q} onChange={(e) => setQ(e.target.value)} />
          <Button variant="primary" onClick={() => setAdding(true)}
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" width="16" height="16" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            }>
            Add vendor
          </Button>
        </div>
        <div className="card-body">
          {vendorsQ.isPending ? (
            <div className="skel-rows">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} h={36} />)}
            </div>
          ) : vendors.length === 0 ? (
            <div className="empty mini">
              <p>No vendors yet. Add the shops and suppliers you buy from.</p>
              <button className="btn btn-primary" onClick={() => setAdding(true)}>
                Add the first vendor
              </button>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="defects-table">
                <thead>
                  <tr>
                    <th>Vendor</th>
                    <th>Contact</th>
                    <th>Phone</th>
                    <th>Email</th>
                    <th className="num">Parts</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((v) => (
                    <tr key={v.id} onClick={() => setEditing(v)}>
                      <td><strong>{v.name}</strong></td>
                      <td>{v.contact || <span className="muted">—</span>}</td>
                      <td>{v.phone || <span className="muted">—</span>}</td>
                      <td>{v.email || <span className="muted">—</span>}</td>
                      <td className="num">{v.parts_count || 0}</td>
                      <td className="num" onClick={(e) => e.stopPropagation()}>
                        <button className="icon-x" title="Delete vendor"
                          onClick={() => remove(v)}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {(adding || editing) && (
        <VendorModal vendor={editing}
          onClose={() => { setAdding(false); setEditing(null) }}
          onSaved={() => {
            setAdding(false); setEditing(null)
            qc.invalidateQueries({ queryKey: ['vendors'] })
          }} />
      )}
    </>
  )
}

function VendorModal({ vendor, onClose, onSaved }: {
  vendor: Vendor | null
  onClose: () => void
  onSaved: () => void
}) {
  const [f, setF] = useState<VendorInput & { id?: number }>(() => ({
    id: vendor?.id,
    name: vendor?.name ?? '',
    contact: vendor?.contact ?? '',
    phone: vendor?.phone ?? '',
    email: vendor?.email ?? '',
    address: vendor?.address ?? '',
    account: vendor?.account ?? '',
    notes: vendor?.notes ?? '',
  }))
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch })

  async function submit() {
    if (!String(f.name ?? '').trim()) {
      notifyErr('Missing name', 'A vendor name is required')
      return
    }
    setSaving(true)
    try {
      await saveVendor(f)
      notifyOk(vendor ? 'Vendor updated' : 'Vendor added', f.name)
      onSaved()
    } catch (e) {
      notifyErr("Couldn't save vendor", e)
      setSaving(false)
    }
  }

  return (
    <Modal title={vendor ? `Edit ${vendor.name}` : 'Add vendor'} width={520}
      onClose={onClose}>
      <div className="wo-form">
        <label className="ud-field">
          <span>Name</span>
          <input className="cell-input" autoFocus value={f.name ?? ''}
            placeholder="FleetPride" onChange={(e) => set({ name: e.target.value })} />
        </label>
        <div className="wo-form-row">
          <label className="ud-field">
            <span>Contact</span>
            <input className="cell-input" value={f.contact ?? ''}
              onChange={(e) => set({ contact: e.target.value })} />
          </label>
          <label className="ud-field">
            <span>Account #</span>
            <input className="cell-input" value={f.account ?? ''}
              onChange={(e) => set({ account: e.target.value })} />
          </label>
        </div>
        <div className="wo-form-row">
          <label className="ud-field">
            <span>Phone</span>
            <input className="cell-input" value={f.phone ?? ''}
              onChange={(e) => set({ phone: e.target.value })} />
          </label>
          <label className="ud-field">
            <span>Email</span>
            <input className="cell-input" type="email" value={f.email ?? ''}
              onChange={(e) => set({ email: e.target.value })} />
          </label>
        </div>
        <label className="ud-field">
          <span>Address</span>
          <input className="cell-input" value={f.address ?? ''}
            onChange={(e) => set({ address: e.target.value })} />
        </label>
        <label className="ud-field">
          <span>Notes</span>
          <input className="cell-input" value={f.notes ?? ''}
            onChange={(e) => set({ notes: e.target.value })} />
        </label>
        <div className="settings-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : vendor ? 'Save vendor' : 'Add vendor'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
