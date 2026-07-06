// Marketplace de partes (scaffold, Increment B). Caja de búsqueda + lista de
// resultados contra un marketplace externo (FindItParts/PartsTech). Mientras
// no haya cuenta de API conectada, el backend responde con datos DEMO (mock)
// y `configured: false`; este panel muestra un banner claro avisándolo. Un
// resultado se puede mandar a una PO con QuickBuy (reusa CreatePoModal). Vive
// como pestaña dentro de Parts & Vendors.
//
// Conectar el API real es trabajo de backend (un adapter en
// core/parts_marketplace.py + credenciales en Settings); este panel no cambia.
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  searchMarketplace,
  type MarketplaceResult, type Part,
} from '../api'
import { notifyErr } from '../toast'
import { Button } from '../components/ds'
import Skeleton from '../components/Skeleton'
import { CreatePoModal } from './PurchaseOrdersPage'

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

// Etiqueta + clase de pastilla por disponibilidad. Reusa las clases wo-status
// del design system (verde / ámbar / azul) — sin CSS nuevo.
const AVAIL_META: Record<string, { label: string; cls: string }> = {
  in_stock: { label: 'In stock', cls: 'wo-done' },
  limited: { label: 'Limited', cls: 'wo-progress' },
  backorder: { label: 'Backorder', cls: 'wo-open' },
  special_order: { label: 'Special order', cls: 'wo-open' },
}
const availMeta = (a: string) =>
  AVAIL_META[a] ?? { label: a || '—', cls: 'wo-open' }

// Un resultado del marketplace se adapta a la forma `Part` que espera el
// modal de QuickBuy (part_number + description + cost + vendor_name). Es un
// Part SINTÉTICO: no existe en el catálogo, solo precarga la línea de PO.
function resultToPart(r: MarketplaceResult): Part {
  return {
    id: -1,
    part_number: r.part_number,
    description: r.brand ? `${r.description} (${r.brand})` : r.description,
    category: '',
    cost: r.price,
    vendor_id: null,
    vendor_name: r.vendor,
    on_hand: 0,
    reorder_point: 0,
    notes: '',
  }
}

export default function MarketplacePanel() {
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [results, setResults] = useState<MarketplaceResult[]>([])
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [quick, setQuick] = useState<Part | null>(null)
  // Token de petición: descarta respuestas viejas si el usuario sigue tecleando.
  const reqId = useRef(0)

  async function run(query: string) {
    const mine = ++reqId.current
    setLoading(true)
    try {
      const res = await searchMarketplace(query, 25)
      if (mine !== reqId.current) return       // respuesta obsoleta
      setResults(res.results)
      setConfigured(res.configured)
      setSearched(true)
    } catch (e) {
      if (mine !== reqId.current) return
      notifyErr("Couldn't search the marketplace", e)
    } finally {
      if (mine === reqId.current) setLoading(false)
    }
  }

  // Carga inicial: una búsqueda vacía trae muestras para que el panel no nazca
  // en blanco (y se vea el banner de demo de una vez).
  useEffect(() => { run('') }, [])

  // Debounce al teclear (350 ms).
  useEffect(() => {
    const t = setTimeout(() => { run(q) }, 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  return (
    <>
      {loading && <div className="loadbar" aria-hidden="true" />}

      {/* Banner: datos demo hasta conectar un proveedor real. Se oculta solo
          cuando el backend reporta configured=true (hay API conectada). */}
      {configured === false && (
        <div className="banner warn" role="status">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 9v4M12 17h.01" />
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7
              3.9a2 2 0 0 0-3.4 0z" />
          </svg>
          <span>
            <strong>Demo data</strong> — connect a parts supplier API
            (FindItParts / PartsTech) in <strong>Settings → Integrations</strong>
            {' '}to get live pricing &amp; availability.
          </span>
        </div>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Marketplace search</h2>
          <span className="head-spacer" />
          <input className="cell-input" autoFocus
            placeholder="Search part #, description, brand…"
            value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') run(q) }}
            style={{ minWidth: 260 }} />
          <Button variant="ghost" onClick={() => run(q)}
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" width="16" height="16" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            }>
            Search
          </Button>
        </div>
        <div className="card-body">
          {loading && !searched ? (
            <div className="skel-rows">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} h={36} />)}
            </div>
          ) : results.length === 0 ? (
            <div className="empty mini">
              <p>No results{q.trim() ? ` for “${q.trim()}”` : ''}.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="defects-table">
                <thead>
                  <tr>
                    <th>Part #</th>
                    <th>Description</th>
                    <th>Brand</th>
                    <th>Vendor</th>
                    <th className="num">Price</th>
                    <th>Availability</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => {
                    const av = availMeta(r.availability)
                    return (
                      <tr key={`${r.part_number}-${i}`}>
                        <td className="mono"><strong>{r.part_number}</strong></td>
                        <td>{r.description
                          || <span className="muted">—</span>}</td>
                        <td>{r.brand || <span className="muted">—</span>}</td>
                        <td>{r.vendor || <span className="muted">—</span>}</td>
                        <td className="num mono">
                          {r.price ? money(r.price) : '—'}
                        </td>
                        <td>
                          <span className={`wo-status ${av.cls}`}>{av.label}</span>
                        </td>
                        <td className="num"
                          onClick={(e) => e.stopPropagation()}>
                          <button className="btn btn-ghost btn-xs"
                            title={`QuickBuy ${r.part_number}`}
                            onClick={() => setQuick(resultToPart(r))}>
                            QuickBuy
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {quick && (
        <CreatePoModal quickPart={quick}
          onClose={() => setQuick(null)}
          onCreated={() => {
            setQuick(null)
            qc.invalidateQueries({ queryKey: ['purchase-orders'] })
          }} />
      )}
    </>
  )
}
