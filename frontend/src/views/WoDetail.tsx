// Detalle de una Work Order (v2.21, layout estilo SquareRigger).
//
//  - <WoDetail woId …>: el panel de detalle en sí — cabecera sticky (nº,
//    unidad + año/marca/modelo, chips), pestañas Info · Parts & Labor ·
//    Invoice · Requests, cuerpo scrolleable y un PIE sticky con la acción
//    primaria del pipeline ("Start work" / "Mark complete" / "Invoice") más
//    un menú ▾ con el resto de transiciones y el toggle "Waiting for parts".
//    Lo monta la página de Work Orders a la derecha de la lista maestra.
//  - <WoDrawer woId onClose>: envoltorio fino (vaul, derecha) alrededor de
//    WoDetail. Lo siguen usando el perfil de unidad y Service Requests sin
//    cambios; WorkOrdersPage lo re-exporta por compatibilidad.
//
// Toda la lógica de negocio (patch de estado, hooks de PM, Smart Fill,
// líneas, factura adjunta, envío) vino del WoDrawer de v2.20 sin cambios.
import {
  Fragment, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react'
import { Drawer } from 'vaul'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addWoLine, createPartsRequest,
  deleteWoInvoiceFile, deleteWoLine,
  deleteWorkOrder, downloadWoInvoiceFile, fetchWoInvoiceThumbUrl,
  getCustomer, getOrg, getWorkOrder, listFleet, listParts,
  patchWorkOrder, sendWoInvoice, smartFillWo, unlinkRequest,
  uploadWoInvoiceFile, viewWoInvoiceFile,
  type EvidencePhoto, type NotifyChannel, type Part, type SmartFillResult,
  type WoLine, type WoPaymentStatus,
  type WorkOrder, type WoPriority, type WoStatus,
} from '../api'
import BillToField from '../components/BillToField'
import { isMasked, TERMS_LABEL } from '../customers'
import { useShell } from '../shell'
import EvidenceGallery, {
  useEvidenceList, useEvidencePhotoUrl,
} from '../components/EvidenceGallery'
import { notifyOk, notifyErr, notifyWarn } from '../toast'
import { usePerms } from '../perms'
import { Badge, Button, Tabs } from '../components/ds'
import Skeleton from '../components/Skeleton'
import VendorPicker from '../components/VendorPicker'
import TechnicianPicker from '../components/TechnicianPicker'
import { WoTypeBadge, WoTypeSwitch } from '../components/WoTypeBadge'
import SmartFillReviewModal from '../components/SmartFillReviewModal'
import WorkOrderInvoice from '../components/WorkOrderInvoice'
import { CreatePoModal } from './PurchaseOrdersPage'
import {
  afterStatusChange, bestAlternative, CAMPAIGN_OPTS, dateOf, findPart,
  invalidateWoLists, mergeWoDetail, money, parseReeferFault, partUnitCost,
  PIPELINE, PRIORITY_META, reachesCompleted, SR_SOURCE_LABEL, stampOf,
  STATUS_META, statusPatch, woTimeline,
} from './woShared'

// Datalist compartido de part numbers (el option muestra la descripción).
export function PartOptions({ id, parts }: { id: string; parts: Part[] }) {
  return (
    <datalist id={id}>
      {parts.map((p) => (
        <option key={p.id} value={p.part_number}>{p.description}</option>
      ))}
    </datalist>
  )
}


// ----- Banner de decisión de stock (Treatment A inline, handoff de Design) -
// Aparece bajo una línea de parte de la WO cuando el catálogo no tiene stock
// suficiente para cubrirla. Dos salidas reales: comprar (QuickBuy → PO) o
// hacer swap por una alternativa en stock de la misma categoría. El stock se
// consume recién al facturar, así que on_hand es fiable mientras la WO está
// activa.
function WoStockBanner({ part, alt, need, onSwap, onBought, onRequest }: {
  part: Part
  alt: Part | null
  need: number
  onSwap: (alt: Part) => Promise<void>
  onBought: () => void
  onRequest: () => Promise<void>
}) {
  const [buyOpen, setBuyOpen] = useState(false)
  const [ordered, setOrdered] = useState(false)
  const [requested, setRequested] = useState(false)
  const [swapping, setSwapping] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const oh = part.on_hand || 0

  if (ordered) {
    return (
      <div className="wo-stock-banner is-ordered">
        <div className="wsb-alert">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            strokeLinejoin="round"><path d="m20 6-11 11-5-5" /></svg>
          <span>
            <strong>Ordered.</strong> A purchase order was created for{' '}
            {part.part_number}. It restocks when the PO is received.
          </span>
        </div>
      </div>
    )
  }

  if (requested) {
    return (
      <div className="wo-stock-banner is-requested">
        <div className="wsb-alert">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            strokeLinejoin="round"><path d="m20 6-11 11-5-5" /></svg>
          <span>
            <strong>Queued as a parts request.</strong> Bundle it into a PO in{' '}
            <strong>Purchasing</strong>.
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="wo-stock-banner">
      <div className="wsb-head">
        <span className="wsb-thumb">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
            stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"
            strokeLinejoin="round">
            <path d="M12 2 3 7v10l9 5 9-5V7z" /><path d="M3 7l9 5 9-5M12 12v10" />
          </svg>
        </span>
        <span className="wsb-title">
          <strong>{part.description || part.part_number}</strong>
          <span className="wsb-sub mono">
            {part.part_number}{part.vendor_name ? ` · ${part.vendor_name}` : ''}
            {' · qty '}{need}
          </span>
        </span>
        <span className="wsb-price">
          <span className="mono">{money(partUnitCost(part))}</span>
          <span className="wsb-out">OUT</span>
        </span>
      </div>

      <div className="wsb-decide">
        <div className="wsb-alert">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            strokeLinejoin="round">
            <path d="M10.3 3.5 1.8 18a1.5 1.5 0 0 0 1.3 2.2h17.8A1.5 1.5 0 0 0 22.2 18L13.7 3.5a1.5 1.5 0 0 0-2.6 0z" />
            <path d="M12 9v4M12 17h.01" />
          </svg>
          <span>
            <strong>{oh} of {need} in stock.</strong>{' '}
            <span className="muted">How do you want to fill it?</span>
          </span>
        </div>

        <div className="wsb-tiles">
          <div className="wsb-tile">
            <span className="wsb-tile-label">Order new</span>
            <span className="wsb-tile-price mono">{money(partUnitCost(part))}</span>
            <span className="wsb-tile-meta mono">
              {part.vendor_name || 'vendor'} · restock
            </span>
            <button className="btn btn-primary btn-xs wsb-buy"
              onClick={() => setBuyOpen(true)}>QuickBuy</button>
          </div>

          {alt ? (
            <div className="wsb-tile is-alt">
              <span className="wsb-tile-label ok">In stock now</span>
              <span className="wsb-tile-price mono ok">{money(partUnitCost(alt))}</span>
              <span className="wsb-tile-meta mono">
                {alt.part_number} · {alt.on_hand} on hand
              </span>
              <button className="btn btn-ghost btn-xs" disabled={swapping}
                onClick={async () => {
                  setSwapping(true)
                  try { await onSwap(alt) } finally { setSwapping(false) }
                }}>
                {swapping ? 'Swapping…' : 'Swap'}
              </button>
            </div>
          ) : (
            <div className="wsb-tile is-empty">
              <span className="wsb-tile-meta mono">
                No in-stock alternative in {part.category || 'this category'}.
                Order it, or queue a request below.
              </span>
            </div>
          )}
        </div>
        <button className="wsb-fallback" disabled={requesting}
          onClick={async () => {
            setRequesting(true)
            try { await onRequest(); setRequested(true) }
            finally { setRequesting(false) }
          }}>
          {requesting ? 'Requesting…' : 'or create a parts request →'}
        </button>
      </div>

      {buyOpen && (
        <CreatePoModal quickPart={part}
          onClose={() => setBuyOpen(false)}
          onCreated={() => { setBuyOpen(false); setOrdered(true); onBought() }} />
      )}
    </div>
  )
}


// ----- Panel de detalle ----------------------------------------------------
export type WoDetailTab = 'info' | 'parts' | 'invoice' | 'requests'

// Acción primaria del pie por estado: a dónde lleva el botón grande. Las
// demás transiciones (y las vueltas atrás) viven en el menú ▾.
const PRIMARY: Partial<Record<WoStatus, { label: string; to: WoStatus }>> = {
  open: { label: 'Start work', to: 'in_progress' },
  assigned: { label: 'Start work', to: 'in_progress' },
  in_progress: { label: 'Mark complete', to: 'completed' },
  completed: { label: 'Invoice', to: 'invoiced' },
}

export function WoDetail({
  woId, onClose, onNavigate, onBack, backLabel = 'Work orders',
  expanded = false, onToggleExpand, variant = 'pane',
}: {
  woId: number
  onClose?: () => void
  // Abrir otra WO ligada (#4 ↔ #4.1) en el mismo panel.
  onNavigate?: (id: number) => void
  // Móvil: volver a la lista maestra.
  onBack?: () => void
  backLabel?: string
  // Panel a todo el ancho (oculta la lista maestra).
  expanded?: boolean
  onToggleExpand?: () => void
  variant?: 'pane' | 'drawer'
}) {
  const qc = useQueryClient()
  const { can } = usePerms()
  const woQ = useQuery({
    queryKey: ['workorder', woId],
    queryFn: () => getWorkOrder(woId),
    // Siempre revalidar al (re)abrir: el estado pudo cambiar desde el Board,
    // el perfil de unidad o service requests mientras el panel no la mostraba.
    staleTime: 0,
  })
  const wo = woQ.data ?? null
  const [tab, setTab] = useState<WoDetailTab>('info')

  const partsQ = useQuery({ queryKey: ['parts'], queryFn: listParts })
  const orgQ = useQuery({ queryKey: ['org'], queryFn: getOrg })
  const fleetQ = useQuery({ queryKey: ['fleet'], queryFn: listFleet })
  const laborRate = orgQ.data?.labor_rate ?? 0
  const catalog = partsQ.data?.parts ?? []
  const org = orgQ.data
  // v2.22 [C]: cliente facturado (Bill to) — markups, términos y contacto de
  // facturación para el documento y el email.
  const custId = wo?.customer_id ?? null
  const custQ = useQuery({
    queryKey: ['customer', custId],
    queryFn: () => getCustomer(custId!),
    enabled: custId != null,
    retry: false,
  })
  const custProfile = custId != null ? custQ.data : undefined
  const { navigate } = useShell()
  // "Customer" elegido en el switch pero todavía sin cliente (muestra el
  // picker sin tocar la WO hasta elegir).
  const [billPick, setBillPick] = useState(false)
  // Datos de la unidad (VIN/año/marca/modelo) para el documento y la
  // cabecera, de la caché de /fleet (no se le pega a Samsara).
  const unitInfo = useMemo(
    () => (fleetQ.data ?? []).find((u) => u.unit === wo?.unit),
    [fleetQ.data, wo?.unit])
  const ymm = unitInfo
    ? [unitInfo.year, unitInfo.make, unitInfo.model]
      .filter(Boolean).join(' ') : ''
  // Increment C: diagnóstico de la falla del reefer parseado del complaint
  // real (solo WOs nacidas de un fault). Si no hay datos, queda null y la
  // tarjeta se omite — sin inventar telemetría.
  const faultDiag = useMemo(
    () => (wo?.source === 'reefer'
      ? parseReeferFault(wo.complaint) : null),
    [wo?.source, wo?.complaint])
  // Increment C: hitos reales del ciclo de vida (timestamps del WO).
  const timeline = useMemo(() => (wo ? woTimeline(wo) : []), [wo])
  const [lineKind, setLineKind] = useState<'part' | 'labor'>('part')
  const [linePart, setLinePart] = useState('')
  const [lineDesc, setLineDesc] = useState('')
  const [lineQty, setLineQty] = useState('1')
  const [lineCost, setLineCost] = useState('')
  const [pmMiles, setPmMiles] = useState('')
  const [busy, setBusy] = useState(false)
  // H3-C: documento imprimible + panel de envío.
  const [showDoc, setShowDoc] = useState(false)
  const [sendOpen, setSendOpen] = useState(false)
  const [toEmail, setToEmail] = useState('')
  const [toPhone, setToPhone] = useState('')
  const [chEmail, setChEmail] = useState(true)
  const [chSms, setChSms] = useState(false)
  const [sending, setSending] = useState(false)
  // Factura original adjunta (review v1.17): subir/ver/descargar/quitar.
  const invFileRef = useRef<HTMLInputElement | null>(null)
  const [invBusy, setInvBusy] = useState(false)
  // Miniatura de la factura (1a pagina renderizada).
  const [invThumb, setInvThumb] = useState<string | null>(null)
  // v2.21 Smart Fill sobre la WO: lee un invoice (nuevo o el ya adjunto) y
  // abre el modal de revisión; el apply funde el detalle devuelto en caché.
  const sfFileRef = useRef<HTMLInputElement | null>(null)
  const [sfBusy, setSfBusy] = useState(false)
  const [sfResult, setSfResult] = useState<SmartFillResult | null>(null)
  const [sfOver, setSfOver] = useState(false)
  // Re-monta las secciones con inputs defaultValue tras aplicar.
  const [sfGen, setSfGen] = useState(0)
  // "Assign" del pie: salta a Info y enfoca el campo de técnico.
  const assignRef = useRef<HTMLDivElement | null>(null)

  // Carga la miniatura de la factura (auth -> blob) cuando hay una adjunta.
  useEffect(() => {
    let alive = true
    let url: string | null = null
    if (wo?.has_invoice_file) {
      fetchWoInvoiceThumbUrl(wo.id)
        .then((u) => { if (alive) { url = u; setInvThumb(u) } })
        .catch(() => { if (alive) setInvThumb(null) })
    } else {
      setInvThumb(null)
    }
    return () => { alive = false; if (url) URL.revokeObjectURL(url) }
  }, [wo?.id, wo?.has_invoice_file, wo?.invoice_file_name])

  // Prefill del destinatario: v2.22 el contacto de facturación del cliente
  // (Bill to), si no el email del cliente; sin cliente, el Bill-To de la
  // empresa (org billing). Un email enmascarado (sin pii.view) no se usa.
  // Se calcula en el render y se copia al campo al ABRIR el panel de envío
  // (sin efecto que sincronice estado).
  const defaultRecipient = (() => {
    if (!wo) return ''
    if (wo.customer_id != null) {
      if (!custProfile) return ''
      const billing = custProfile.contacts.find((c) => c.is_billing && c.email)
      const e = billing?.email || custProfile.customer?.email || ''
      return isMasked(e) ? '' : e
    }
    return org?.billing?.[wo.company]?.email ?? ''
  })()

  // Elegir un part# del catálogo autollena descripción + costo (v2.22:
  // promedio ponderado real si existe; si no, el costo de catálogo).
  function pickPart(pn: string) {
    setLinePart(pn)
    const hit = findPart(catalog, pn)
    if (hit) {
      if (!lineDesc.trim()) setLineDesc(hit.description)
      setLineCost(String(partUnitCost(hit)))
    }
  }

  // Cambiar el tipo de línea; al pasar a labor sin costo, traer la tarifa.
  function changeKind(kind: 'part' | 'labor') {
    setLineKind(kind)
    if (kind === 'labor') {
      setLinePart('')
      if (!lineCost.trim() && laborRate) setLineCost(String(laborRate))
    }
  }

  // Merge (no reemplazo): las respuestas de PATCH/líneas no traen `links`.
  function refreshWo(updated: WorkOrder) {
    mergeWoDetail(qc, updated)
    invalidateWoLists(qc)
  }

  async function setStatus(s: WoStatus) {
    if (!wo) return
    setBusy(true)
    try {
      const updated = await patchWorkOrder(wo.id, statusPatch(wo, s, pmMiles))
      refreshWo(updated)
      afterStatusChange(qc, updated, { from: wo.status, to: s })
    } catch (e) {
      // Los gates del pipeline llegan como 400 con el motivo exacto.
      notifyErr("Can't move there yet", e)
    } finally {
      setBusy(false)
    }
  }

  // WO de PM que ya llegó a completed sin odómetro (p.ej. arrastrada en el
  // Board): guardar pm_miles dispara el hook PM del backend igual que al
  // completar (corre en cada update con estado >= completed).
  async function recordPmMiles() {
    if (!wo) return
    const n = Number(pmMiles.trim())
    if (!pmMiles.trim() || !Number.isFinite(n) || n <= 0) return
    try {
      const updated = await patchWorkOrder(wo.id, { pm_miles: n })
      refreshWo(updated)
      afterStatusChange(qc, updated,
        { from: updated.status, to: updated.status, quiet: true })
      setPmMiles('')
    } catch (e) {
      notifyErr('Could not save', e)
    }
  }

  async function addLine() {
    if (!wo || !lineDesc.trim()) return
    setBusy(true)
    try {
      const updated = await addWoLine(wo.id, {
        kind: lineKind, description: lineDesc.trim(),
        qty: Number(lineQty) || 1, unit_cost: Number(lineCost) || 0,
        part_number: lineKind === 'part' ? linePart.trim() : '',
      })
      refreshWo(updated)
      setLinePart(''); setLineDesc(''); setLineQty('1'); setLineCost('')
    } catch (e) {
      notifyErr('Could not add line', e)
    } finally {
      setBusy(false)
    }
  }

  async function removeLine(lineId: number) {
    if (!wo) return
    try {
      refreshWo(await deleteWoLine(wo.id, lineId))
    } catch (e) {
      notifyErr('Could not delete line', e)
    }
  }

  // Banner de stock: swap de una línea sin stock por una alternativa en stock
  // (borra la línea original + agrega la alternativa con la misma cantidad).
  async function swapLine(line: { id: number; qty: number }, alt: Part) {
    if (!wo) return
    try {
      await deleteWoLine(wo.id, line.id)
      const updated = await addWoLine(wo.id, {
        kind: 'part', description: alt.description || alt.part_number,
        qty: line.qty || 1, unit_cost: partUnitCost(alt),
        part_number: alt.part_number,
      })
      refreshWo(updated)
      qc.invalidateQueries({ queryKey: ['parts'] })
      notifyOk('Swapped', `${alt.part_number} · in stock`)
    } catch (e) {
      notifyErr('Could not swap the part', e)
    }
  }

  async function saveField(patch: Partial<WorkOrder>) {
    if (!wo) return
    try {
      refreshWo(await patchWorkOrder(wo.id, patch))
    } catch (e) {
      notifyErr('Could not save', e)
    }
  }

  // v2.22 [C]: Bill to / estado de cobro. Cambian saldos y WOs del cliente.
  async function saveBilling(patch: Partial<WorkOrder>, ok?: string) {
    if (!wo) return
    try {
      refreshWo(await patchWorkOrder(wo.id, patch))
      qc.invalidateQueries({ queryKey: ['customers'] })
      qc.invalidateQueries({ queryKey: ['customer'] })
      if (ok) notifyOk(ok)
    } catch (e) {
      notifyErr('Could not save', e)
    }
  }

  // v2.20: sacar un service request de esta orden (vuelve al backlog
  // abierto). No toca el texto del complaint.
  const [unlinking, setUnlinking] = useState<number | null>(null)
  async function unlinkSr(id: number) {
    setUnlinking(id)
    try {
      await unlinkRequest(id)
      invalidateWoLists(qc)
      qc.invalidateQueries({ queryKey: ['workorder'] })
      notifyOk('Request unlinked', 'Back in the open service request backlog')
    } catch (e) {
      notifyErr("Couldn't unlink the request", e)
    } finally {
      setUnlinking(null)
    }
  }

  // Factura original adjunta (review v1.17, estilo SquareRigger): subir
  // reemplaza la existente; ver abre en pestaña; descargar baja con su
  // nombre original. Refresca el WO para reflejar has_invoice_file.
  async function uploadInvoiceFile(file: File | undefined) {
    if (!wo || !file) return
    setInvBusy(true)
    try {
      const r = await uploadWoInvoiceFile(wo.id, file)
      qc.setQueryData<WorkOrder>(['workorder', wo.id], (prev) =>
        prev ? { ...prev, has_invoice_file: true,
                 invoice_file_name: r.invoice_file_name } : prev)
      qc.invalidateQueries({ queryKey: ['workorders'] })
      notifyOk('Invoice attached', r.invoice_file_name)
    } catch (e) {
      notifyErr("Couldn't upload invoice", e)
    } finally {
      setInvBusy(false)
      if (invFileRef.current) invFileRef.current.value = ''
    }
  }

  async function removeInvoiceFile() {
    if (!wo) return
    if (!window.confirm('Remove the attached invoice?')) return
    setInvBusy(true)
    try {
      await deleteWoInvoiceFile(wo.id)
      qc.setQueryData<WorkOrder>(['workorder', wo.id], (prev) =>
        prev ? { ...prev, has_invoice_file: false,
                 invoice_file_name: null } : prev)
      qc.invalidateQueries({ queryKey: ['workorders'] })
      notifyOk('Invoice removed')
    } catch (e) {
      notifyErr("Couldn't remove invoice", e)
    } finally {
      setInvBusy(false)
    }
  }

  // v2.21: Smart Fill sobre la WO existente. `file` null re-escanea el
  // invoice ya adjunto; con archivo, el backend lo adjunta y lo lee en la
  // misma llamada. El resultado se revisa en SmartFillReviewModal.
  async function runSmartFill(file: File | null) {
    if (!wo || sfBusy) return
    if (wo.status === 'invoiced') {
      notifyWarn('Work order is invoiced',
        'Un-invoice it before importing an invoice.')
      return
    }
    setSfBusy(true)
    try {
      const r = await smartFillWo(wo.id, file)
      if (file) {
        qc.setQueryData<WorkOrder>(['workorder', wo.id], (prev) =>
          prev ? { ...prev, has_invoice_file: true,
                   invoice_file_name: file.name } : prev)
        qc.invalidateQueries({ queryKey: ['workorders'] })
      }
      setSfResult(r)
    } catch (e) {
      notifyErr("Couldn't read the invoice", e)
      // Re-sincroniza el estado del adjunto con lo que hizo el servidor
      // (nombre/miniatura): nunca dejar el panel con un archivo stale.
      qc.invalidateQueries({ queryKey: ['workorder', wo.id] })
      qc.invalidateQueries({ queryKey: ['workorders'] })
    } finally {
      setSfBusy(false)
      if (sfFileRef.current) sfFileRef.current.value = ''
    }
  }

  // H3-C: enviar el estimate/invoice por email (real) y/o SMS.
  async function sendDoc() {
    if (!wo) return
    const channels: NotifyChannel[] = []
    if (chEmail) channels.push('email')
    if (chSms) channels.push('sms')
    if (!channels.length) {
      notifyErr('Pick a channel', 'Email or SMS')
      return
    }
    setSending(true)
    try {
      const r = await sendWoInvoice(wo.id, {
        channels, email: toEmail.trim(), phone: toPhone.trim(),
        unit_info: unitInfo
          ? { vin: unitInfo.vin, year: unitInfo.year,
              make: unitInfo.make, model: unitInfo.model }
          : {},
      })
      const parts: string[] = []
      const fmt = (c: { ok: boolean; simulated: boolean; to: string;
                        error: string } | undefined, label: string) => {
        if (!c) return
        parts.push(c.ok
          ? (c.simulated ? `${label} simulated (dry run)`
                         : `${label} sent to ${c.to}`)
          : `${label} failed: ${c.error}`)
      }
      fmt(r.results.email, 'Email')
      fmt(r.results.sms, 'SMS')
      const anyFail = (r.results.email && !r.results.email.ok)
        || (r.results.sms && !r.results.sms.ok)
      if (anyFail) notifyErr('Send issue', parts.join(' · '))
      else { notifyOk('Document sent', parts.join(' · ')); setSendOpen(false) }
    } catch (e) {
      notifyErr('Could not send', e)
    } finally {
      setSending(false)
    }
  }

  // "Assign" desde el pie: ir a Info y enfocar el picker de técnico.
  function focusAssign() {
    setTab('info')
    window.setTimeout(() => {
      assignRef.current?.querySelector<HTMLInputElement>('input')?.focus()
    }, 30)
  }

  const rootCls = `wod is-${variant} ${expanded ? 'is-expanded' : ''}`

  if (woQ.isPending) {
    return (
      <div className={`${rootCls} is-loading`} aria-busy="true">
        <div className="wod-head">
          <div className="wod-head-main">
            <Skeleton w="38%" h={22} />
            <Skeleton w="60%" h={14} />
          </div>
        </div>
        <div className="wod-body">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} h={92} r={12} />
          ))}
        </div>
      </div>
    )
  }
  if (!wo) {
    return (
      <div className={`${rootCls} is-empty`}>
        <div className="wod-empty">
          <strong>Work order not found</strong>
          <span>{woQ.error ? String(woQ.error) : 'It may have been deleted.'}</span>
          {onClose && (
            <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
          )}
        </div>
      </div>
    )
  }

  const displayNo = wo.links?.display_no ?? wo.display_no ?? String(wo.id)
  const nLines = wo.lines?.length ?? 0
  const nSr = wo.service_requests?.length ?? 0
  const partsTotal = (wo.lines ?? []).filter((l) => l.kind === 'part')
    .reduce((s, l) => s + l.total, 0)
  const laborTotal = (wo.lines ?? []).filter((l) => l.kind === 'labor')
    .reduce((s, l) => s + l.total, 0)
  const locked = wo.status === 'invoiced'
  // El horómetro aplica si la WO es del PM del reefer O lleva ligado un
  // request "Reefer PM due" (p.ej. DOT + Reefer PM del mismo trailer en una
  // WO con campaña 'dot': al facturar igual se registra el PM del reefer).
  const tracksHours = wo.campaign === 'reefer'
    || (wo.service_requests ?? []).some((r) => r.source === 'reefer')

  // v2.22 [C]: precio al cliente. unit_price = snapshot congelado al
  // facturar; sin snapshot, costo × (1 + markup vigente del cliente).
  const billed = wo.customer_id != null
  const cust = custProfile?.customer
  const markupOf = (l: WoLine) => (!cust ? 0
    : (l.kind === 'part' ? cust.parts_markup_pct : cust.labor_markup_pct) || 0)
  const priceOf = (l: WoLine) =>
    l.unit_price ?? l.unit_cost * (1 + markupOf(l) / 100)
  const r2 = (n: number) => Math.round(n * 100) / 100
  const partsPrice = r2((wo.lines ?? []).filter((l) => l.kind === 'part')
    .reduce((s, l) => s + priceOf(l) * l.qty, 0))
  const laborPrice = r2((wo.lines ?? []).filter((l) => l.kind === 'labor')
    .reduce((s, l) => s + priceOf(l) * l.qty, 0))
  const billableTotal = wo.billable_total ?? r2(partsPrice + laborPrice)
  // Impuesto del cliente sobre las partes (tasa congelada al facturar).
  const taxPct = billed ? (wo.tax_pct ?? 0) : 0
  const billableTax = wo.billable_tax ?? r2(partsPrice * taxPct / 100)
  const amountDue = wo.billable_due ?? r2(billableTotal + billableTax)
  const snapshotted = (wo.lines ?? []).some((l) => l.unit_price != null)
  const payStatus: WoPaymentStatus = wo.payment_status ?? 'unpaid'
  const billMode = billed || billPick ? 'customer' : 'self'

  // Bloque Smart Fill (Parts & Labor e Invoice): importar un archivo nuevo
  // o re-leer el adjunto. Oculto en órdenes facturadas.
  const smartFillBlock = !locked && (
    <div className={`wod-sf ${sfOver ? 'is-over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setSfOver(true) }}
      onDragLeave={() => setSfOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setSfOver(false)
        // Solo un ARCHIVO dispara el escaneo: soltar texto/un enlace no debe
        // re-escanear el adjunto (runSmartFill(null) = use_attached).
        const f = e.dataTransfer.files?.[0]
        if (f) runSmartFill(f)
      }}>
      <span className="wod-sf-ico"><SparkIcon /></span>
      <span className="wod-sf-text">
        <strong>Smart Fill</strong>
        <span>
          {wo.has_invoice_file
            ? 'Read the attached invoice again or import another file. Drop a PDF or photo here too.'
            : 'Import a shop invoice or estimate: date, vendor, invoice # and lines fill in for review. Drop a file here too.'}
        </span>
      </span>
      <span className="wod-sf-actions">
        {wo.has_invoice_file && (
          <Button variant="ghost" size="sm" loading={sfBusy}
            onClick={() => runSmartFill(null)}>
            Re-scan attached
          </Button>
        )}
        <Button variant="primary" size="sm" loading={sfBusy}
          onClick={() => sfFileRef.current?.click()}>
          {wo.has_invoice_file ? 'Import another file' : 'Import invoice'}
        </Button>
      </span>
    </div>
  )

  return (
    <div className={rootCls}>
      {/* ----- Cabecera sticky ----- */}
      <header className="wod-head">
        {onBack && (
          <button type="button" className="sr-back wod-back" onClick={onBack}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
              aria-hidden="true">
              <path d="m15 6-6 6 6 6" />
            </svg>
            {backLabel}
          </button>
        )}
        <div className="wod-head-main">
          <div className="wod-head-l1">
            <span className="wod-no mono">WO #{displayNo}</span>
            <h2 className="wod-unit">{wo.unit}</h2>
            {ymm && <span className="wod-ymm" title={ymm}>{ymm}</span>}
          </div>
          <div className="ud-chiprow wod-chips">
            <span className={`wo-status ${STATUS_META[wo.status].cls}`}>
              {STATUS_META[wo.status].label}
            </span>
            {wo.priority !== 'normal' && (
              <span className={`wo-priority ${PRIORITY_META[wo.priority].cls}`}>
                {PRIORITY_META[wo.priority].label}
              </span>
            )}
            {/* v2.21: INSIDE / OUTSIDE (clic → datos del vendor). */}
            <WoTypeBadge wo={wo} interactive />
            {wo.is_pm && <span className="wo-pm-tag">PM</span>}
            {wo.waiting_parts && (
              <span className="wo-wait-tag" title="Waiting for parts">parts</span>
            )}
            {wo.source === 'defect' && (
              <span className="ud-chip">from defect</span>
            )}
            {wo.source === 'reefer' && (
              <span className="ud-chip">from reefer fault</span>
            )}
            {wo.source === 'request' && (
              <span className="ud-chip">from service request</span>
            )}
            {wo.source === 'scan' && (
              <span className="ud-chip">from scanned invoice</span>
            )}
            {wo.invoiced_at && (
              <span className="ud-chip">Invoiced {dateOf(wo.invoiced_at)}</span>
            )}
          </div>
          {/* Vínculos del invoice multi-unidad (review v1.26): "child of #4"
              + enlaces a las otras unidades. Navega dentro del panel. */}
          {wo.links && (wo.links.parent || wo.links.children.length > 0) && (
            <div className="wo-link-row">
              {wo.links.parent && (
                <button type="button" className="wo-link-chip"
                  title={`Open parent WO #${wo.links.parent.display_no}`}
                  onClick={() => onNavigate?.(wo.links!.parent!.id)}>
                  <span className="wo-link-eyebrow">child of</span>
                  #{wo.links.parent.display_no} · {wo.links.parent.unit}
                </button>
              )}
              {wo.links.children
                .filter((k) => k.id !== wo.id)
                .map((k) => (
                  <button type="button" key={k.id} className="wo-link-chip"
                    title={`Open linked WO #${k.display_no}`}
                    onClick={() => onNavigate?.(k.id)}>
                    <span className="wo-link-eyebrow">linked</span>
                    #{k.display_no} · {k.unit}
                  </button>
                ))}
            </div>
          )}
        </div>
        <div className="wod-head-actions">
          {onToggleExpand && (
            <button type="button" className="icon-btn wod-expand"
              title={expanded ? 'Show the list again' : 'Expand to full width'}
              aria-label={expanded ? 'Show the list again' : 'Expand to full width'}
              aria-pressed={expanded}
              onClick={onToggleExpand}>
              {expanded ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 4v16M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                </svg>
              )}
            </button>
          )}
          {onClose && (
            <button type="button" className="icon-btn" onClick={onClose}
              aria-label="Close">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          )}
        </div>
      </header>

      {/* ----- Pestañas ----- */}
      <div className="wod-tabs">
        <Tabs aria-label="Work order sections"
          tabs={[
            { id: 'info', label: 'Info' },
            { id: 'parts', label: (
              <>Parts &amp; Labor<TabCount n={nLines} /></>
            ) },
            { id: 'invoice', label: 'Invoice' },
            { id: 'requests', label: (
              <>Requests<TabCount n={nSr} /></>
            ) },
          ]}
          value={tab}
          onChange={(id) => setTab(id as WoDetailTab)} />
      </div>

      {/* ----- Cuerpo scrolleable ----- */}
      <div className="wod-body">
        {tab === 'info' && (
          <div className="wod-tab" key={`info:${wo.id}:${sfGen}`}>
            <section className="ud-sec">
              {/* H3: issue y complaint editables inline */}
              <input
                className="wo-title-edit" defaultValue={wo.title}
                title="Edit the issue title"
                onBlur={(e) => {
                  if (e.target.value.trim()
                      && e.target.value !== wo.title) {
                    saveField({ title: e.target.value.trim() })
                  }
                }}
              />
              <textarea
                className="cell-input ud-notes wo-complaint-edit"
                rows={3} defaultValue={wo.complaint}
                placeholder="Complaint / detail"
                onBlur={(e) => {
                  if (e.target.value !== wo.complaint) {
                    saveField({ complaint: e.target.value })
                  }
                }}
              />
            </section>

            <section className="ud-sec" ref={assignRef}>
              <h3>Assignment</h3>
              {/* v2.21: inside (técnico) / outside (vendor). El switch y el
                  campo de asignación viven juntos (WoTypeField). */}
              <WoTypeField wo={wo} onSave={saveField} />
              {/* v2.22 [C]: a quién se factura (Self = flota propia). Una
                  WO facturada ya congeló sus precios: no se cambia. */}
              <BillToField
                mode={billMode}
                customer={billed ? { id: wo.customer_id!,
                  name: wo.customer_name || cust?.name || '' } : null}
                disabled={locked}
                onMode={(m) => {
                  if (m === 'customer') { setBillPick(true); return }
                  setBillPick(false)
                  if (billed) saveBilling({ customer_id: 0 }, 'Billed to Self')
                }}
                onCustomer={(c) => {
                  if (c) {
                    setBillPick(false)
                    if (c.id !== wo.customer_id) {
                      saveBilling({ customer_id: c.id }, `Billed to ${c.name}`)
                    }
                  } else if (billed) {
                    setBillPick(true)
                    saveBilling({ customer_id: 0 })
                  }
                }}
                hint={locked && billed
                  ? 'Invoiced — prices are locked with this customer\'s markup'
                  : billed && cust
                    ? `Markup: parts ${cust.parts_markup_pct || 0}% · labor ${cust.labor_markup_pct || 0}%`
                      + (cust.terms ? ` · ${TERMS_LABEL[cust.terms] ?? cust.terms}` : '')
                    : undefined} />
              {billed && (
                <button type="button" className="link-btn wod-cust-link"
                  onClick={() => navigate('customers',
                    { customer: wo.customer_id! })}>
                  Open {wo.customer_name || cust?.name || 'customer'} profile →
                </button>
              )}
              <div className="wo-meta-row">
                <label className="ud-field">
                  <span>Priority</span>
                  <select className="cell-input" value={wo.priority}
                    onChange={(e) => saveField(
                      { priority: e.target.value as WoPriority })}>
                    <option value="low">Low</option>
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                  </select>
                </label>
                <label className="ud-field">
                  <span>Campaign</span>
                  <select className="cell-input" value={wo.campaign}
                    onChange={(e) =>
                      saveField({ campaign: e.target.value })}>
                    {CAMPAIGN_OPTS.map((c) => (
                      <option key={c.key} value={c.key}>{c.label}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="wo-meta-row">
                <label className="ud-field">
                  <span>Customer PO #</span>
                  <input className="cell-input" defaultValue={wo.po_number}
                    placeholder="optional"
                    onBlur={(e) => {
                      if (e.target.value !== wo.po_number) {
                        saveField({ po_number: e.target.value })
                      }
                    }} />
                </label>
                <label className="ud-field">
                  <span>Authorizer</span>
                  <input className="cell-input" defaultValue={wo.authorizer}
                    placeholder="optional"
                    onBlur={(e) => {
                      if (e.target.value !== wo.authorizer) {
                        saveField({ authorizer: e.target.value })
                      }
                    }} />
                </label>
              </div>
              {/* v2.22 [B]: horómetro del reefer al hacer el PM. Al facturar
                  la WO queda como último servicio + lectura del horómetro
                  (nunca el odómetro). */}
              {tracksHours && (
                <label className="ud-field wo-pm-miles">
                  <span>Reefer engine hours at service</span>
                  <input className="cell-input" type="number" min={0}
                    step="0.1"
                    key={`eh:${wo.id}:${wo.engine_hours ?? ''}`}
                    defaultValue={wo.engine_hours ?? ''}
                    placeholder="hour meter reading"
                    disabled={locked}
                    onBlur={(e) => {
                      const raw = e.target.value.trim()
                      const v = raw === '' ? null : Number(raw)
                      if (v != null && (!Number.isFinite(v) || v < 0)) return
                      if (v !== (wo.engine_hours ?? null)) {
                        // Vaciar = 0: el PATCH ignora los null (0 limpia).
                        saveField({ engine_hours: v ?? 0 })
                      }
                    }} />
                  {!locked && (
                    <small className="muted">
                      {wo.engine_hours == null
                        ? 'Read it off the hour meter: the Reefer PM is '
                          + 'recorded with it when invoiced (or with the '
                          + 'latest meter reading if left empty).'
                        : 'Recorded as the Reefer PM when invoiced; a newer '
                          + 'meter reading wins if it is higher.'}
                    </small>
                  )}
                </label>
              )}
              {/* Antes de completar: viaja con el cambio de estado. Ya
                  completada SIN odómetro (p.ej. movida en el Board): se
                  guarda al salir del campo y registra el PM. */}
              {wo.is_pm && (!reachesCompleted(wo.status)
                || (wo.status === 'completed' && !wo.pm_miles)) && (
                <label className="ud-field wo-pm-miles">
                  <span>Odometer at PM completion (mi)</span>
                  <input className="cell-input" type="number" value={pmMiles}
                    placeholder={wo.mileage ? String(wo.mileage) : '431850'}
                    onChange={(e) => setPmMiles(e.target.value)}
                    onBlur={() => {
                      if (reachesCompleted(wo.status)) recordPmMiles()
                    }} />
                </label>
              )}
            </section>

            {/* Increment C: diagnóstico de la falla (solo WOs de reefer con
                telemetría real capturada en el complaint; si nada se parsea,
                faultDiag es null y la sección no se renderiza). */}
            {faultDiag && (
              <section className="ud-sec">
                <h3>
                  <svg viewBox="0 0 24 24" width="15" height="15"
                    fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                  </svg>
                  Fault diagnostics
                  {faultDiag.source && (
                    <span className="wo-diag-src">{faultDiag.source}</span>
                  )}
                </h3>
                {faultDiag.cells.length > 0 && (
                  <div className="wo-diag-grid">
                    {faultDiag.cells.map((c) => (
                      <div className="wo-diag-cell" key={c.k}>
                        <span className="wo-diag-k">{c.k}</span>
                        <span className="wo-diag-v mono">
                          {c.v}{c.u && <span className="wo-diag-u">{c.u}</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {(faultDiag.code || faultDiag.desc) && (
                  <div className="wo-diag-foot">
                    <svg viewBox="0 0 24 24" width="15" height="15"
                      fill="none" stroke="currentColor" strokeWidth="2"
                      strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                      <path d="M12 9v4M12 17h.01" />
                    </svg>
                    <span>
                      {faultDiag.code && (
                        <span className="wo-diag-code mono">
                          {faultDiag.code}
                        </span>
                      )}
                      {faultDiag.desc && (
                        <span className="wo-diag-desc">
                          {' '}{faultDiag.desc}
                        </span>
                      )}
                    </span>
                  </div>
                )}
                {faultDiag.action && (
                  <p className="ud-muted wo-diag-action">
                    Operator action: {faultDiag.action}
                  </p>
                )}
              </section>
            )}

            {/* Evidencia fotográfica (v2.14): Before / After + comparador. */}
            <WoPhotos woId={wo.id} />

            {/* Increment C: línea de tiempo (solo hitos reales del WO). */}
            {timeline.length > 0 && (
              <section className="ud-sec">
                <h3>
                  <svg viewBox="0 0 24 24" width="15" height="15"
                    fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 8v4l3 2" />
                    <circle cx="12" cy="12" r="9" />
                  </svg>
                  Activity
                  <span className="ud-count">{timeline.length}</span>
                </h3>
                <ol className="wo-timeline">
                  {timeline.map((e, i) => (
                    <li className="wo-tl-row" key={`${e.label}-${i}`}>
                      <span className={`wo-tl-dot t-${e.tone}`} />
                      <span className="wo-tl-when mono">
                        {stampOf(e.when)}
                      </span>
                      <span className="wo-tl-text">
                        {e.label}
                        {e.sub && (
                          <span className="wo-tl-sub mono">{e.sub}</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            <section className="ud-sec">
              <h3>Notes</h3>
              <textarea className="cell-input ud-notes" rows={3}
                defaultValue={wo.notes}
                placeholder="Internal notes, vendor, PO…"
                onBlur={(e) => {
                  if (e.target.value !== wo.notes) {
                    saveField({ notes: e.target.value })
                  }
                }} />
              <p className="ud-muted wo-dates">
                Created {dateOf(wo.created_at)}
                {wo.service_date ? ` · Service ${wo.service_date}` : ''}
                {wo.mileage != null
                  ? ` · ${wo.mileage.toLocaleString('en-US')} mi`
                  : ''}
                {wo.closed_at ? ` · Completed ${dateOf(wo.closed_at)}` : ''}
              </p>
              <button
                className="btn btn-ghost btn-xs wo-delete"
                onClick={async () => {
                  if (!window.confirm(
                    `Delete work order #${wo.id} (${wo.unit})? `
                    + 'This cannot be undone.')) return
                  try {
                    await deleteWorkOrder(wo.id)
                    // Incluye service requests: los ligados vuelven a open.
                    invalidateWoLists(qc)
                    notifyOk(`Work order #${wo.id} deleted`)
                    onClose?.()
                  } catch (e) {
                    notifyErr("Couldn't delete", e)
                  }
                }}
              >
                Delete work order
              </button>
            </section>
          </div>
        )}

        {tab === 'parts' && (
          <div className="wod-tab">
            {/* Líneas: partes + labor */}
            <section className="ud-sec">
              <h3>
                Parts &amp; labor
                <span className="ud-count">{nLines}</span>
              </h3>
              {nLines > 0 ? (
                <table className="wo-lines">
                  <tbody>
                    {(wo.lines ?? []).map((ln) => {
                      // ¿Parte sin stock suficiente en el catálogo? (solo
                      // mientras la WO está activa: al facturar se consume).
                      const cp = ln.kind === 'part' && ln.part_number
                        ? findPart(catalog, ln.part_number) : undefined
                      const short = !!cp
                        && (cp.on_hand ?? 0) < (ln.qty || 1)
                        && !['completed', 'invoiced'].includes(wo.status)
                      const alt = short && cp
                        ? bestAlternative(catalog, cp) : null
                      return (
                        <Fragment key={ln.id}>
                          <tr className={short ? 'wo-line-short' : undefined}>
                            <td>
                              <span className={`wo-line-kind k-${ln.kind}`}>
                                {ln.kind === 'part' ? 'Part' : 'Labor'}
                              </span>
                            </td>
                            <td className="wo-line-desc">
                              {ln.part_number && (
                                <span className="wo-line-pn">{ln.part_number}</span>
                              )}
                              {ln.description}
                            </td>
                            <td className="num mono">
                              {ln.qty} × {money(ln.unit_cost)}
                            </td>
                            <td className="num mono">{money(ln.total)}</td>
                            <td>
                              {!locked && (
                                <button className="icon-x" title="Remove line"
                                  onClick={() => removeLine(ln.id)}>✕</button>
                              )}
                            </td>
                          </tr>
                          {short && cp && (
                            <tr className="wo-line-banner-row">
                              <td colSpan={5}>
                                <WoStockBanner part={cp} alt={alt}
                                  need={ln.qty || 1}
                                  onSwap={(a) => swapLine(ln, a)}
                                  onBought={() => {
                                    qc.invalidateQueries({ queryKey: ['parts'] })
                                    qc.invalidateQueries({ queryKey: ['purchase-orders'] })
                                  }}
                                  onRequest={async () => {
                                    await createPartsRequest({
                                      part_number: cp.part_number,
                                      description: cp.description || cp.part_number,
                                      qty: ln.qty || 1,
                                      // Reposición: último costo recibido.
                                      unit_cost: cp.last_cost ?? cp.cost ?? 0,
                                      vendor: cp.vendor_name || '',
                                      source: 'wo',
                                      source_ref: `WO #${wo.id}`,
                                    })
                                    qc.invalidateQueries({ queryKey: ['parts-requests'] })
                                    notifyOk('Parts request queued',
                                      `${cp.part_number} · see Purchasing`)
                                  }} />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              ) : (
                <p className="wod-hint">
                  {locked
                    ? 'No parts or labor lines on this invoiced order.'
                    : 'No parts or labor yet. Add a line below or import the shop invoice with Smart Fill.'}
                </p>
              )}
              {/* Líneas congeladas en una orden facturada (el backend también
                  lo bloquea): el stock ya se consumió por línea. */}
              {!locked && (
              <div className="wo-line-add">
                <select className="cell-input" value={lineKind}
                  onChange={(e) => changeKind(
                    e.target.value as 'part' | 'labor')}>
                  <option value="part">Part</option>
                  <option value="labor">Labor</option>
                </select>
                {lineKind === 'part' && (
                  <input className="cell-input wo-line-add-pn"
                    list="wo-drawer-parts" title="Part number (catalog)"
                    placeholder="Part #" value={linePart}
                    onChange={(e) => pickPart(e.target.value)} />
                )}
                <input className="cell-input wo-line-add-desc"
                  placeholder={lineKind === 'part'
                    ? 'LED brake lamp' : 'Replace + test'}
                  value={lineDesc}
                  onChange={(e) => setLineDesc(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addLine() }} />
                <input className="cell-input wo-line-add-n" type="number"
                  title={lineKind === 'part' ? 'Quantity' : 'Hours'}
                  placeholder={lineKind === 'part' ? 'qty' : 'hrs'}
                  value={lineQty}
                  onChange={(e) => setLineQty(e.target.value)} />
                <input className="cell-input wo-line-add-n" type="number"
                  title={lineKind === 'part'
                    ? 'Unit cost' : 'Hourly rate'}
                  placeholder="$"
                  value={lineCost}
                  onChange={(e) => setLineCost(e.target.value)} />
                <button className="btn btn-ghost btn-xs" onClick={addLine}
                  disabled={busy || !lineDesc.trim()}>
                  Add
                </button>
                <PartOptions id="wo-drawer-parts" parts={catalog} />
              </div>
              )}
              <div className="wo-total">
                <span>Total</span>
                <strong>{money(wo.total)}</strong>
              </div>
            </section>
            {smartFillBlock && (
              <section className="ud-sec">
                <h3>Import from invoice</h3>
                {smartFillBlock}
              </section>
            )}
          </div>
        )}

        {tab === 'invoice' && (
          <div className="wod-tab" key={`inv:${wo.id}:${sfGen}`}>
            <section className="ud-sec">
              <h3>Totals</h3>
              <div className="wod-totals">
                <div className="wod-total-cell">
                  <span>Parts</span>
                  <strong className="mono">{money(partsTotal)}</strong>
                </div>
                <div className="wod-total-cell">
                  <span>Labor</span>
                  <strong className="mono">{money(laborTotal)}</strong>
                </div>
                <div className="wod-total-cell is-grand">
                  <span>Total · {nLines} line{nLines === 1 ? '' : 's'}</span>
                  <strong className="mono">{money(wo.total)}</strong>
                </div>
              </div>
              {/* H3-C: datos del invoice (van al documento imprimible) */}
              <div className="wo-meta-row">
                <label className="ud-field">
                  <span>Vendor invoice #</span>
                  <input className="cell-input" defaultValue={wo.shop_invoice}
                    placeholder={wo.wo_type === 'outside'
                      ? 'invoice # from the shop' : 'third-party shop'}
                    onBlur={(e) => {
                      if (e.target.value !== wo.shop_invoice) {
                        saveField({ shop_invoice: e.target.value })
                      }
                    }} />
                </label>
                <div className="ud-field">
                  <span>Rigsmith invoice #</span>
                  <span className="wod-ro mono">
                    {wo.invoice_number || '—'}
                  </span>
                </div>
              </div>
              {wo.invoice_number && (
                <p className="ud-muted wo-invnum">
                  Invoice number format in Settings, Company.
                </p>
              )}
            </section>

            {/* v2.22 [C]: facturación al cliente (owner-operator): precio con
                markup, total facturable y estado de cobro. */}
            {billed && (
              <section className="ud-sec wod-bill">
                <h3>Customer billing</h3>
                <div className="wod-bill-head">
                  <span className="wod-bill-to">
                    <span className="wod-bill-k">Bill to</span>
                    <button type="button" className="link-btn"
                      onClick={() => navigate('customers',
                        { customer: wo.customer_id! })}>
                      {wo.customer_name || cust?.name || `Customer #${wo.customer_id}`}
                    </button>
                    {cust?.terms && (
                      <span className="wod-bill-terms">
                        {TERMS_LABEL[cust.terms] ?? cust.terms}
                      </span>
                    )}
                  </span>
                  <div className="bt-seg wod-pay" role="radiogroup"
                    aria-label="Payment status"
                    title={can('wo.invoice') ? undefined
                      : 'Marking payment is a billing action (needs invoicing permission)'}>
                    {(['unpaid', 'paid'] as const).map((ps) => (
                      <label key={ps}
                        className={`bt-opt ${payStatus === ps ? 'is-on' : ''} ${ps === 'paid' ? 'is-paid' : ''}`}>
                        <input type="radio" name={`pay-${wo.id}`} value={ps}
                          checked={payStatus === ps}
                          // Igual que el backend: marcar el cobro es de
                          // facturación (wo.invoice), no de maint.edit.
                          disabled={!can('wo.invoice')}
                          onChange={() => saveBilling({ payment_status: ps },
                            ps === 'paid' ? 'Marked as paid' : 'Marked as unpaid')} />
                        <span>{ps === 'paid' ? 'Paid' : 'Unpaid'}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <table className="wod-bill-table">
                  <thead>
                    <tr>
                      <th scope="col">Billed</th>
                      <th scope="col" className="num">Cost</th>
                      <th scope="col" className="num">Markup</th>
                      <th scope="col" className="num">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row">Parts</th>
                      <td className="num mono">{money(partsTotal)}</td>
                      <td className="num mono">
                        {snapshotted ? 'locked' : `${cust?.parts_markup_pct ?? 0}%`}
                      </td>
                      <td className="num mono">{money(partsPrice)}</td>
                    </tr>
                    <tr>
                      <th scope="row">Labor</th>
                      <td className="num mono">{money(laborTotal)}</td>
                      <td className="num mono">
                        {snapshotted ? 'locked' : `${cust?.labor_markup_pct ?? 0}%`}
                      </td>
                      <td className="num mono">{money(laborPrice)}</td>
                    </tr>
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">Billable total</th>
                      <td className="num mono">{money(wo.total)}</td>
                      <td className="num mono">
                        +{money(Math.max(0, billableTotal - wo.total))}
                      </td>
                      <td className="num mono"><strong>{money(billableTotal)}</strong></td>
                    </tr>
                    {billableTax > 0 && (
                      <>
                        <tr>
                          <th scope="row">Tax ({taxPct}% on parts)</th>
                          <td />
                          <td />
                          <td className="num mono">{money(billableTax)}</td>
                        </tr>
                        <tr>
                          <th scope="row">Amount due</th>
                          <td />
                          <td />
                          <td className="num mono"><strong>{money(amountDue)}</strong></td>
                        </tr>
                      </>
                    )}
                  </tfoot>
                </table>
                <p className="ud-muted wod-bill-note">
                  {snapshotted
                    ? 'Prices were locked when the order was first invoiced — later markup changes don\'t rewrite this invoice.'
                    : 'Prices lock with the customer\'s markup the first time this order is invoiced.'}
                  {payStatus === 'paid' && wo.paid_at
                    ? ` Paid ${dateOf(wo.paid_at)}.` : ''}
                </p>
              </section>
            )}

            <section className="ud-sec">
              <h3>Document</h3>
              {/* H3-C: documento imprimible + envío */}
              <div className="wo-doc-actions">
                <button className="btn btn-ghost btn-xs" disabled={!org}
                  onClick={() => setShowDoc(true)}>
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
                    stroke="currentColor" strokeWidth="1.8"
                    strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M6 14h12v7H6z" />
                  </svg>
                  Print {locked ? 'invoice' : 'estimate'}
                </button>
                {can('wo.invoice') && (
                  <button
                    className={`btn btn-ghost btn-xs ${sendOpen ? 'is-on' : ''}`}
                    aria-expanded={sendOpen}
                    onClick={() => {
                      // Al abrir: prefill con el destinatario por defecto
                      // (contacto de facturación del cliente o Bill-To).
                      if (!sendOpen) setToEmail(defaultRecipient)
                      setSendOpen(!sendOpen)
                    }}>
                    Email / SMS
                  </button>
                )}
              </div>
              {sendOpen && (
                <div className="wo-send-panel">
                  <div className="wo-send-channels">
                    <label className="wo-check">
                      <input type="checkbox" checked={chEmail}
                        onChange={(e) => setChEmail(e.target.checked)} />
                      Email
                    </label>
                    <label className="wo-check">
                      <input type="checkbox" checked={chSms}
                        onChange={(e) => setChSms(e.target.checked)} />
                      SMS
                    </label>
                  </div>
                  {chEmail && (
                    <label className="ud-field">
                      <span>Recipient email</span>
                      <input className="cell-input" type="email" value={toEmail}
                        placeholder="customer@example.com"
                        onChange={(e) => setToEmail(e.target.value)} />
                    </label>
                  )}
                  {chSms && (
                    <label className="ud-field">
                      <span>Recipient phone</span>
                      <input className="cell-input" type="tel" value={toPhone}
                        placeholder="+1 901 555 0142"
                        onChange={(e) => setToPhone(e.target.value)} />
                    </label>
                  )}
                  <div className="settings-actions">
                    <button className="btn btn-primary btn-xs" onClick={sendDoc}
                      disabled={sending}>
                      {sending ? 'Sending…' : 'Send'}
                    </button>
                  </div>
                  <p className="ud-muted wo-send-note">
                    Email sends the full document; SMS sends a short summary.
                    Live or dry run status shows after sending.
                  </p>
                </div>
              )}
            </section>

            <section className="ud-sec">
              <h3>Source invoice</h3>
              {/* Factura original adjunta (review v1.17): el PDF/imagen del
                  taller que dio origen a la WO. Ver/Descargar/Quitar o subir
                  uno (reemplaza). Estilo SquareRigger. */}
              <div className="wo-srcinv wod-srcinv">
                {wo.has_invoice_file ? (
                  <div className="wo-srcinv-card">
                    <button type="button" className="wo-srcinv-thumb"
                      title="View invoice" disabled={invBusy}
                      onClick={() => viewWoInvoiceFile(wo.id)
                        .catch((e) => notifyErr("Couldn't open", e))}>
                      {invThumb ? (
                        <img src={invThumb} alt="Invoice preview" />
                      ) : (
                        <span className="wo-srcinv-thumb-ph">
                          <svg viewBox="0 0 24 24" fill="none"
                            stroke="currentColor" strokeWidth="1.6"
                            strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                            <path d="M14 3v5h5M9 13h6M9 17h6" />
                          </svg>
                        </span>
                      )}
                      <span className="wo-srcinv-thumb-badge">
                        {(wo.invoice_file_name?.split('.').pop() || 'DOC')
                          .toUpperCase()}
                      </span>
                    </button>
                    <div className="wo-srcinv-body">
                      <span className="wo-srcinv-eyebrow">
                        Attached document
                      </span>
                      <span className="wo-srcinv-name" title={
                        wo.invoice_file_name ?? ''}>
                        {wo.invoice_file_name}
                      </span>
                      <div className="wo-srcinv-actions">
                        <Button variant="primary" size="sm"
                          disabled={invBusy}
                          onClick={() => viewWoInvoiceFile(wo.id)
                            .catch((e) => notifyErr("Couldn't open", e))}>
                          View
                        </Button>
                        <Button variant="ghost" size="sm" disabled={invBusy}
                          onClick={() => downloadWoInvoiceFile(
                            wo.id, wo.invoice_file_name ?? `invoice-${wo.id}`)
                            .catch((e) => notifyErr("Couldn't download", e))}>
                          Download
                        </Button>
                        <Button variant="ghost" size="sm" loading={invBusy}
                          className="up-danger" onClick={removeInvoiceFile}>
                          Remove
                        </Button>
                      </div>
                      {!locked && (
                        <div className="wo-srcinv-sf">
                          <button type="button" className="wo-sf-link"
                            disabled={sfBusy}
                            title="Read the attached document again and fill this order"
                            onClick={() => runSmartFill(null)}>
                            <SparkIcon />
                            {sfBusy ? 'Reading…' : 'Re-scan attached invoice (Smart Fill)'}
                          </button>
                          <button type="button" className="wo-sf-link"
                            disabled={sfBusy}
                            title="Attach a different invoice and import it"
                            onClick={() => sfFileRef.current?.click()}>
                            Import another file
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="wo-srcinv-empty">
                    <button type="button" className="wo-srcinv-drop"
                      disabled={invBusy}
                      onClick={() => invFileRef.current?.click()}>
                      <svg viewBox="0 0 24 24" fill="none"
                        stroke="currentColor" strokeWidth="1.6"
                        strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 16V4M7 9l5-5 5 5" />
                        <path d="M5 20h14" />
                      </svg>
                      <span className="wo-srcinv-drop-t">Attach invoice</span>
                      <span className="wo-srcinv-drop-s">
                        PDF or photo of the original shop invoice
                      </span>
                    </button>
                    {smartFillBlock}
                  </div>
                )}
              </div>
            </section>
          </div>
        )}

        {tab === 'requests' && (
          <div className="wod-tab">
            {/* v2.20: service requests que esta orden resuelve. */}
            <section className="ud-sec">
              <h3>
                Service requests
                <span className="ud-count">{nSr}</span>
              </h3>
              {nSr === 0 ? (
                <p className="wod-hint">
                  No service requests are linked to this work order. Dispatch
                  requests from the Service Requests backlog to link them here.
                </p>
              ) : (
                <ul className="sr-wo-list">
                  {(wo.service_requests ?? []).map((r) => (
                    <li key={r.id} className="sr-wo-item">
                      <span className={`sr-wo-src sr-s-${r.source}`}>
                        {SR_SOURCE_LABEL[r.source] ?? r.source}
                      </span>
                      <span className="sr-wo-title" title={r.title}>
                        {r.title}
                      </span>
                      {(r.priority === 'urgent'
                        || r.priority === 'emergency') && (
                        <Badge variant="solid"
                          style={{ background: `var(--sr-${r.priority})` }}>
                          {r.priority === 'urgent' ? 'Urgent' : 'Emergency'}
                        </Badge>
                      )}
                      {r.status === 'done' && (
                        <Badge tone="success">Done</Badge>
                      )}
                      {can('maint.edit') && r.status === 'on_wo' && (
                        <button className="btn btn-ghost btn-xs"
                          disabled={unlinking === r.id}
                          title="Take it off this work order and back to the backlog"
                          onClick={() => unlinkSr(r.id)}>
                          {unlinking === r.id ? 'Unlinking…' : 'Unlink'}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>

      {/* Inputs de archivo compartidos por las pestañas (adjuntar / Smart
          Fill). Viven fuera de las pestañas para que los refs no se pierdan
          al cambiar de tab. */}
      <input ref={invFileRef} type="file" hidden
        accept=".pdf,image/*"
        onChange={(e) => uploadInvoiceFile(e.target.files?.[0])} />
      <input ref={sfFileRef} type="file" hidden
        accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/*"
        onChange={(e) => runSmartFill(e.target.files?.[0] ?? null)} />

      {/* ----- Pie sticky: acción primaria del pipeline ----- */}
      <WoFooter wo={wo} busy={busy} canInvoice={can('wo.invoice')}
        onGo={setStatus}
        onToggleWaiting={() => saveField({ waiting_parts: !wo.waiting_parts })}
        onAssign={focusAssign} />

      {/* v2.21: revisión del Smart Fill. Vive DENTRO del árbol React del
          panel (su portal propio) para que vaul no lo tome como clic afuera
          y cierre el drawer. */}
      {sfResult && (
        <SmartFillReviewModal wo={wo} result={sfResult}
          onClose={() => setSfResult(null)}
          onApplied={(updated) => {
            setSfResult(null)
            setSfGen((g) => g + 1)
            refreshWo(updated)
            qc.invalidateQueries({ queryKey: ['workorder'] })
            qc.invalidateQueries({ queryKey: ['vendors'] })
            qc.invalidateQueries({ queryKey: ['technicians'] })
          }} />
      )}
      {showDoc && org && (
        <WorkOrderInvoice wo={wo} org={org} unit={unitInfo}
          customer={billed ? custProfile : undefined}
          onClose={() => setShowDoc(false)} />
      )}
    </div>
  )
}

// Contador chico dentro de la etiqueta de una pestaña.
function TabCount({ n }: { n: number }) {
  if (!n) return null
  return <em className="wod-tab-n">{n}</em>
}

// ----- Pie sticky: la barra de etapas compactada en UN botón ---------------
// La etapa actual se ve como una pista de 5 segmentos; el botón grande hace
// la transición natural (Start work → Mark complete → Invoice) y el menú ▾
// trae el resto (saltos y vueltas atrás) más el toggle "Waiting for parts".
// Los gates del backend (técnico asignado, líneas antes de facturar) llegan
// como 400 y se muestran en el toast — nada se bloquea por permisos acá,
// salvo Invoice (scope wo.invoice).
function WoFooter({ wo, busy, canInvoice, onGo, onToggleWaiting, onAssign }: {
  wo: WorkOrder
  busy: boolean
  canInvoice: boolean
  onGo: (s: WoStatus) => void
  onToggleWaiting: () => void
  onAssign: () => void
}) {
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!menu) return
    function onDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenu(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const idx = PIPELINE.indexOf(wo.status)
  const primary = PRIMARY[wo.status]
  const primaryBlocked = primary?.to === 'invoiced' && !canInvoice
  const others = PIPELINE.filter((s) => s !== wo.status && s !== primary?.to)
  const outside = wo.wo_type === 'outside'
  const unassigned = !outside && !wo.mechanic.trim()

  let who: ReactNode
  if (outside) {
    who = (
      <>
        <span className="wod-who-k">Vendor</span>
        <span className="wod-who-v">{wo.vendor_name || 'Third-party shop'}</span>
      </>
    )
  } else if (unassigned) {
    who = (
      <>
        <span className="wod-who-k">Technician</span>
        <button type="button" className="wod-who-assign" onClick={onAssign}>
          Assign…
        </button>
      </>
    )
  } else {
    who = (
      <>
        <span className="wod-who-k">Technician</span>
        <span className="wod-who-v">{wo.mechanic}</span>
      </>
    )
  }

  return (
    <footer className="wod-foot">
      <div className="wod-foot-left">
        <span className="wod-steps" role="img"
          aria-label={`Stage ${idx + 1} of ${PIPELINE.length}: ${STATUS_META[wo.status].label}`}
          title={`${STATUS_META[wo.status].label} · stage ${idx + 1} of ${PIPELINE.length}`}>
          {PIPELINE.map((s, i) => (
            <i key={s} className={i < idx ? 'past' : i === idx ? 'now' : ''} />
          ))}
        </span>
        <span className="wod-who">{who}</span>
      </div>
      <div className="wod-foot-actions" ref={menuRef}>
        {primary ? (
          <div className="wod-primary">
            <Button variant="primary" size="sm" className="wod-primary-btn"
              loading={busy} disabled={primaryBlocked}
              title={primaryBlocked
                ? 'Invoicing needs the wo.invoice permission'
                : unassigned && primary.to !== 'invoiced'
                  ? 'Assign a technician first (the shop requires one for inside work)'
                  : `Move to ${STATUS_META[primary.to].label}`}
              onClick={() => onGo(primary.to)}>
              {primary.label}
            </Button>
            <button type="button" className="wod-primary-more"
              aria-label="More status actions" aria-haspopup="menu"
              aria-expanded={menu} disabled={busy}
              onClick={() => setMenu((m) => !m)}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
                stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"
                strokeLinejoin="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          </div>
        ) : (
          <Button variant="ghost" size="sm" disabled={busy}
            aria-haspopup="menu" aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}>
            Status ▾
          </Button>
        )}
        {menu && (
          <div className="wod-menu" role="menu">
            {others.map((s) => {
              const back = PIPELINE.indexOf(s) < idx
              const blocked = s === 'invoiced' && !canInvoice
              return (
                <button type="button" key={s} role="menuitem"
                  className={`wod-menu-item ${back ? 'is-back' : ''}`}
                  disabled={blocked}
                  title={blocked ? 'Needs the wo.invoice permission' : undefined}
                  onClick={() => { setMenu(false); onGo(s) }}>
                  <span className={`wo-col-dot ${STATUS_META[s].cls}`} />
                  {back ? 'Back to ' : 'Move to '}{STATUS_META[s].label}
                </button>
              )
            })}
            <div className="wod-menu-sep" />
            <button type="button" role="menuitemcheckbox"
              aria-checked={wo.waiting_parts}
              className={`wod-menu-item ${wo.waiting_parts ? 'is-on' : ''}`}
              onClick={() => { setMenu(false); onToggleWaiting() }}>
              <span className="wod-menu-check" aria-hidden="true">
                {wo.waiting_parts ? '✓' : ''}
              </span>
              Waiting for parts
            </button>
          </div>
        )}
      </div>
    </footer>
  )
}

// ----- Tipo de trabajo + asignación en el drawer (v2.21) -------------------
// Switch Inside / Outside + el campo que corresponde: Technician (inside,
// WorkOrder.mechanic) o Vendor (outside, vendor_id). Pasar a outside sin
// vendor no se guarda hasta elegir uno (el backend exige vendor_id); el
// estado "pendiente" vive acá y se resetea con la sección (key={wo.id}).
function WoTypeField({ wo, onSave }: {
  wo: WorkOrder
  onSave: (patch: Partial<WorkOrder>) => void
}) {
  const [pending, setPending] = useState(false)
  const outside = wo.wo_type === 'outside'
  const locked = wo.status === 'invoiced'
  return (
    <div className="wot-field">
      <WoTypeSwitch size="sm" value={pending ? 'outside' : wo.wo_type}
        disabled={locked}
        onChange={(t) => {
          if (t === 'inside') {
            setPending(false)
            // vendor_id 0 = quitar el taller (el backend lo admite solo si la
            // WO queda inside): si no, el vínculo seguía contando para el
            // vendor (filtro, wo_count, "reassign them first") sin verse.
            if (outside) onSave({ wo_type: 'inside', vendor_id: 0 })
          } else if (wo.vendor_id) {
            onSave({ wo_type: 'outside' })
          } else {
            setPending(true)
          }
        }} />
      {outside || pending ? (
        <label className="ud-field">
          <span>Vendor · third-party shop</span>
          <VendorPicker value={pending ? null : wo.vendor_id}
            aria-label="Vendor" disabled={locked}
            placeholder={pending ? 'Pick the shop to switch to outside work'
              : 'Pick a vendor'}
            autoFocus={pending}
            onChange={(v) => {
              if (v) {
                setPending(false)
                if (v.id !== wo.vendor_id || !outside) {
                  onSave({ wo_type: 'outside', vendor_id: v.id })
                }
              } else if (outside) {
                notifyWarn('Outside work needs a vendor',
                  'Switch to inside work to drop the third-party shop.')
              }
            }} />
          {pending && (
            <span className="field-hint">
              Nothing changes until you pick a vendor.{' '}
              <button type="button" className="wo-sf-link"
                onClick={() => setPending(false)}>Cancel</button>
            </span>
          )}
        </label>
      ) : (
        <label className="ud-field">
          <span>Technician</span>
          <TechnicianField key={`${wo.id}:${wo.mechanic}`}
            value={wo.mechanic} disabled={locked}
            onSave={(name) => {
              if (name !== wo.mechanic) onSave({ mechanic: name })
            }} />
        </label>
      )}
    </div>
  )
}

// Borrador local del técnico: el picker es controlado y el drawer guarda al
// salir / elegir (onCommit), como el resto de los campos (saveField).
function TechnicianField({ value, onSave, disabled }: {
  value: string
  onSave: (name: string) => void
  disabled?: boolean
}) {
  const [draft, setDraft] = useState(value)
  return (
    <TechnicianPicker value={draft} onChange={setDraft} onCommit={onSave}
      disabled={disabled} aria-label="Technician"
      placeholder="Assign a technician" />
  )
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
      stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.2 2.2M16.2 16.2l2.2 2.2M5.6 18.4l2.2-2.2M16.2 7.8l2.2-2.2" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

// ----- Evidencia fotográfica (v2.14, elemento 01) -------------------------
// Sección "Photos" del drawer: dos galerías por fase (Before = como se
// encontró, After = trabajo terminado). Las galerías comparten la caché de
// react-query con el comparador (misma queryKey), así que no hay fetches
// duplicados.
function WoPhotos({ woId }: { woId: number }) {
  const listQ = useEvidenceList('wo', woId)
  const photos = listQ.data ?? []
  const before = photos.filter((p) => p.phase === 'before')
  const after = photos.filter((p) => p.phase === 'after')
  return (
    <section className="ud-sec">
      <h3>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round"
          strokeLinejoin="round" aria-hidden="true">
          <path d="M4 8h3l2-2h6l2 2h3v11H4z" />
          <circle cx="12" cy="13" r="3.2" />
        </svg>
        Photos
        <span className="ud-count">{photos.length}</span>
      </h3>
      <div className="wo-photos">
        <div className="wo-photos-col">
          <span className="ud-field-label">Before · as found</span>
          <EvidenceGallery parent="wo" parentId={woId} phase="before"
            addLabel="Add before" />
        </div>
        <div className="wo-photos-col">
          <span className="ud-field-label">After · work done</span>
          <EvidenceGallery parent="wo" parentId={woId} phase="after"
            addLabel="Add after" />
        </div>
      </div>
      {before.length > 0 && after.length > 0 && (
        <BeforeAfter before={before[before.length - 1]}
          after={after[after.length - 1]} />
      )}
    </section>
  )
}

// Comparador antes/después (portado del prototipo del board): dos imágenes
// superpuestas, la de arriba recortada con clip-path; el divisor lo mueve
// un <input type="range"> invisible que cubre todo el área (accesible con
// teclado gratis). Usa la última foto de cada fase.
function BeforeAfter({ before, after }: {
  before: EvidencePhoto
  after: EvidencePhoto
}) {
  const [pos, setPos] = useState(50)
  const beforeQ = useEvidencePhotoUrl(before.id)
  const afterQ = useEvidencePhotoUrl(after.id)
  if (!beforeQ.data || !afterQ.data) return null
  return (
    <div className="ev-ba">
      <img src={afterQ.data} alt="After" />
      <div className="ev-ba-clip"
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
        <img src={beforeQ.data} alt="Before" />
      </div>
      <span className="ev-ba-tag is-before">BEFORE</span>
      <span className="ev-ba-tag is-after">AFTER</span>
      <div className="ev-ba-bar" style={{ left: `${pos}%` }}
        aria-hidden="true">
        <span className="ev-ba-knob">⇔</span>
      </div>
      <input type="range" min={2} max={98} value={pos}
        onChange={(e) => setPos(Number(e.target.value))}
        aria-label="Compare before and after" />
    </div>
  )
}


// ----- Drawer de detalle: envoltorio fino de WoDetail (vaul, derecha) -----
// Lo reusan el perfil de unidad (H3) y Service Requests (v2.20) para abrir
// órdenes sin salir de su pantalla. WorkOrdersPage lo usa en Table / Board /
// History (en List la WO va al panel de la derecha, no al drawer).
// Capas internas del drawer que manejan Escape por su cuenta (combobox de
// técnico/vendor, menú de estado, popover del vendor, modales): mientras una
// esté abierta, Escape la cierra a ELLA y no al drawer. Radix escucha Escape
// en captura sobre document, antes que cualquier handler de React, así que el
// único lugar donde se puede frenar es onEscapeKeyDown del Content.
const INNER_LAYERS = '.cb-pop, .wot-pop, .wod-menu, .modal-backdrop'

export function WoDrawer({ woId, onClose }: {
  woId: number | null
  onClose: () => void
}) {
  const open = woId != null
  // Navegación interna entre órdenes ligadas del mismo invoice (review v1.26):
  // al abrir un enlace #4.1 ↔ #4 el drawer cambia de WO sin cerrarse. Se
  // resetea a la WO con la que se abrió cada vez que cambia `woId`.
  const [navId, setNavId] = useState<number | null>(woId)
  useEffect(() => { setNavId(woId) }, [woId])
  const shownId = navId ?? woId
  return (
    /* B1/B2 (review v1.26): `handleOnly` hace que SOLO el handle arrastre el
       panel (vaul-drag), así el click-drag dentro del contenido selecciona
       texto normalmente. `dismissible` + el onOpenChange ya cierran con
       Escape y con clic en el overlay; el botón X llama onClose directo. */
    <Drawer.Root direction="right" open={open} dismissible handleOnly
      onOpenChange={(o) => { if (!o) onClose() }}>
      <Drawer.Portal>
        <Drawer.Overlay className="ud-overlay" />
        <Drawer.Content className="ud-content wo-drawer"
          onEscapeKeyDown={(e) => {
            if (document.querySelector(INNER_LAYERS)) e.preventDefault()
          }}>
          {/* Handle de arrastre (única zona que mueve el panel con vaul). */}
          <Drawer.Handle className="wo-drawer-handle" />
          <Drawer.Title className="sr-only">
            Work order {shownId ?? ''}
          </Drawer.Title>
          <Drawer.Description className="sr-only">
            Work order details
          </Drawer.Description>
          {shownId != null && (
            <WoDetail woId={shownId} variant="drawer" onClose={onClose}
              onNavigate={setNavId} />
          )}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
