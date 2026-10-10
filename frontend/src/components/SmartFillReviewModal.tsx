// Smart Fill sobre una WO existente (v2.21): revisión de lo que el escáner
// leyó del invoice ANTES de aplicarlo. El backend ya devolvió el extract +
// el match de vendor + una propuesta de campos/líneas; acá el usuario
// decide qué entra (checkboxes), cómo entran las líneas (append/replace) y
// qué pasa con el vendor (usar el match / un candidato / crearlo / elegir
// otro / dejar la WO como está). Todo se aplica en UNA llamada
// (applySmartFill) y el padre funde el detalle devuelto en la caché.
//
// v2.23: el tipo de la WO NUNCA cambia acá (se elige al crearla). En una
// OUTSIDE las opciones de vendor reasignan el taller; en una INSIDE no hay
// opciones de vendor: entran fecha, invoice #, millaje, complaint y líneas
// sin ligar el taller del documento (no se manda vendor_id/vendor_create).
// El escaneo para una WO NUEVA (/workorders/scan, CreateWoModal) sí decide
// inside/outside según el documento.
import { useMemo, useState } from 'react'
import {
  applySmartFill, type SmartFillApplyFields, type SmartFillResult,
  type Vendor, type WoLineInput, type WorkOrder,
} from '../api'
import { notifyErr, notifyOk } from '../toast'
import { vendorLabel, vendorLoc } from '../vendors'
import Modal from './Modal'
import VendorPicker from './VendorPicker'

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

type VendorMode = 'matched' | 'candidate' | 'create' | 'pick' | 'keep'

export default function SmartFillReviewModal({
  wo, result, onClose, onApplied,
}: {
  wo: WorkOrder
  result: SmartFillResult
  onClose: () => void
  onApplied: (updated: WorkOrder) => void
}) {
  const x = result.extract
  const match = result.vendor_match
  const prop = result.proposed
  const scannedVendor = (x.vendor ?? '').trim()
  const scannedLoc = vendorLoc({ city: x.vendor_city, state: x.vendor_state })
  const existing = wo.lines ?? []
  const locked = wo.status === 'invoiced'
  const outside = wo.wo_type === 'outside'

  // Campos de cabecera: se proponen marcados cuando vienen y difieren.
  const pDate = prop.fields.service_date ?? null
  const pInv = prop.fields.shop_invoice ?? null
  const pMi = prop.fields.mileage ?? null
  const [useDate, setUseDate] = useState(!!pDate && pDate !== wo.service_date)
  const [useInv, setUseInv] = useState(!!pInv && pInv !== wo.shop_invoice)
  const [useMi, setUseMi] = useState(pMi != null && pMi !== wo.mileage)
  // Texto de los complaints leídos (opcional, apagado por defecto).
  const complaintText = (x.complaints ?? [])
    .map((c) => (c.detail ?? '').trim()).filter(Boolean).join('\n')
  const [useComplaint, setUseComplaint] = useState(false)

  // Vendor (solo outside): match → usarlo; sin match pero con nombre →
  // crearlo; si no, nada. En una inside siempre 'keep' (no se liga).
  const candidates = match.candidates
    .filter((c) => c.id !== match.vendor?.id).slice(0, 3)
  const [vendorMode, setVendorMode] = useState<VendorMode>(
    !outside ? 'keep'
      : match.vendor ? 'matched' : scannedVendor ? 'create' : 'keep')
  const [candidateId, setCandidateId] = useState<number | null>(
    candidates[0]?.id ?? null)
  const [picked, setPicked] = useState<Vendor | null>(null)

  // Líneas: todas marcadas; append por defecto (replace borra las actuales).
  const [checked, setChecked] = useState<boolean[]>(
    () => prop.lines.map(() => true))
  const [linesMode, setLinesMode] = useState<'append' | 'replace'>('append')
  const [saving, setSaving] = useState(false)

  const chosen = useMemo(
    () => prop.lines.filter((_, i) => checked[i]), [prop.lines, checked])
  const chosenTotal = chosen.reduce((s, l) => s + l.qty * l.unit_cost, 0)
  const existingTotal = existing.reduce((s, l) => s + l.total, 0)
  const grand = x.grand_total
  // Reconciliación (como CreateWoModal): suma de líneas vs total impreso.
  const mismatch = grand != null && chosen.length > 0
    && Math.abs(chosenTotal - grand) > 0.5

  // Taller que quedaría en la WO (solo outside; id null = crearlo) y si
  // cambia el actual: elegir el mismo vendor que ya tiene no es un cambio.
  const nextVendor: { id: number | null; name: string } | null = !outside
    ? null
    : vendorMode === 'matched' && match.vendor
      ? { id: match.vendor.id, name: match.vendor.name }
      : vendorMode === 'candidate' && candidateId != null
        ? { id: candidateId,
            name: candidates.find((c) => c.id === candidateId)?.name ?? '' }
        : vendorMode === 'pick' && picked
          ? { id: picked.id, name: picked.name }
          : vendorMode === 'create' && scannedVendor
            ? { id: null, name: scannedVendor }
            : null
  const vendorChanges = nextVendor != null && nextVendor.id !== wo.vendor_id
  const anyField = (useDate && !!pDate) || (useInv && !!pInv)
    || (useMi && pMi != null) || (useComplaint && !!complaintText)
  const anything = anyField || vendorChanges || chosen.length > 0
    || (linesMode === 'replace' && existing.length > 0)

  async function apply() {
    // Nunca wo_type (el tipo no cambia); vendor solo en una outside.
    const fields: SmartFillApplyFields = {}
    if (useDate && pDate) fields.service_date = pDate
    if (useInv && pInv) fields.shop_invoice = pInv
    if (useMi && pMi != null) fields.mileage = pMi
    if (useComplaint && complaintText) {
      fields.complaint = wo.complaint
        ? `${wo.complaint}\n\n${complaintText}` : complaintText
    }
    let vendor_create: { name: string; city?: string; state?: string } | undefined
    if (outside && vendorChanges && nextVendor) {
      if (nextVendor.id != null) {
        fields.vendor_id = nextVendor.id
      } else {
        vendor_create = {
          name: scannedVendor, city: x.vendor_city ?? '', state: x.vendor_state ?? '',
        }
      }
    }
    const lines: WoLineInput[] = chosen.map((l) => ({
      kind: l.kind, description: l.description.trim(),
      qty: Number(l.qty) || 1, unit_cost: Number(l.unit_cost) || 0,
      part_number: l.part_number ?? '',
    }))
    setSaving(true)
    try {
      const updated = await applySmartFill(wo.id, {
        fields, vendor_create, lines, lines_mode: linesMode,
      })
      // Resumen de lo que entró: líneas, detalles y (outside) el taller.
      const done: string[] = []
      if (lines.length || linesMode === 'replace') {
        done.push(`${lines.length} line${lines.length === 1 ? '' : 's'} ${
          linesMode === 'replace' ? 'replaced' : 'added'}`)
      }
      if (anyField) done.push('details updated')
      if (vendorChanges && nextVendor) {
        done.push(`${nextVendor.id == null ? 'new vendor' : 'shop'}: ${nextVendor.name}`)
      }
      notifyOk('Invoice imported', done.join(' · ') || undefined)
      onApplied(updated)
    } catch (e) {
      notifyErr("Couldn't apply Smart Fill", e)
      setSaving(false)
    }
  }

  // "No change" (solo outside): el taller actual de la orden.
  const keepLabel = `Keep current shop — ${wo.vendor_name || 'Third-party shop'}`

  return (
    <Modal title="Import invoice · Smart Fill" width={780} onClose={onClose}>
      <div className="sf">
        <p className="sf-intro">
          Read with <strong>{result.model}</strong>. Pick what goes into
          WO #{wo.display_no || wo.id} · {wo.unit}; nothing is saved until
          you apply.
        </p>
        {locked && (
          <div className="banner warn">
            <span>This work order is invoiced — un-invoice it before importing.</span>
          </div>
        )}

        {/* ----- Vendor / tipo de trabajo ----- */}
        <section className="sf-sec">
          <h3 className="sf-h">
            Shop on the invoice
            {scannedVendor && (
              <span className="sf-scanned" title="As printed on the invoice">
                {scannedVendor}{scannedLoc ? ` · ${scannedLoc}` : ''}
              </span>
            )}
          </h3>
          {!scannedVendor && !match.vendor && (
            <p className="sf-muted">No shop name was found on the document.</p>
          )}
          {/* Inside: sin opciones de vendor (el tipo no cambia y una inside
              no liga el taller del documento). */}
          {!outside && (scannedVendor || match.vendor) && (
            <p className="sf-note">
              Lines and invoice details are imported; the shop isn’t linked
              because this is <strong>inside work</strong>.
            </p>
          )}
          {outside && (
            <div className="sf-radios" role="radiogroup" aria-label="Vendor">
              {match.vendor && (
                <label className={`sf-radio ${vendorMode === 'matched' ? 'is-on' : ''}`}>
                  <input type="radio" name="sf-vendor" checked={vendorMode === 'matched'}
                    onChange={() => setVendorMode('matched')} />
                  <span className="sf-radio-text">
                    <span className="sf-radio-eyebrow is-ok">Matched vendor</span>
                    <strong>{match.vendor.name}</strong>
                    {vendorLoc(match.vendor) && (
                      <span className="sf-muted"> · {vendorLoc(match.vendor)}</span>
                    )}
                  </span>
                </label>
              )}
              {candidates.length > 0 && (
                <label className={`sf-radio ${vendorMode === 'candidate' ? 'is-on' : ''}`}>
                  <input type="radio" name="sf-vendor"
                    checked={vendorMode === 'candidate'}
                    onChange={() => setVendorMode('candidate')} />
                  <span className="sf-radio-text">
                    <span className="sf-radio-eyebrow">Did you mean</span>
                    <select className="cell-input sf-cand"
                      value={candidateId ?? ''}
                      onClick={() => setVendorMode('candidate')}
                      onChange={(e) => {
                        setCandidateId(Number(e.target.value))
                        setVendorMode('candidate')
                      }}>
                      {candidates.map((c) => (
                        <option key={c.id} value={c.id}>
                          {vendorLabel(c)} · {Math.round(c.score * 100)}%
                        </option>
                      ))}
                    </select>
                  </span>
                </label>
              )}
              {scannedVendor && (
                <label className={`sf-radio ${vendorMode === 'create' ? 'is-on' : ''}`}>
                  <input type="radio" name="sf-vendor" checked={vendorMode === 'create'}
                    onChange={() => setVendorMode('create')} />
                  <span className="sf-radio-text">
                    <span className="sf-radio-eyebrow">Create vendor</span>
                    <strong>{scannedVendor}</strong>
                    {scannedLoc && <span className="sf-muted"> — {scannedLoc}</span>}
                    <span className="sf-muted"> · service shop</span>
                  </span>
                </label>
              )}
              <label className={`sf-radio ${vendorMode === 'pick' ? 'is-on' : ''}`}>
                <input type="radio" name="sf-vendor" checked={vendorMode === 'pick'}
                  onChange={() => setVendorMode('pick')} />
                <span className="sf-radio-text sf-radio-pick">
                  <span className="sf-radio-eyebrow">Another vendor</span>
                  {vendorMode === 'pick' ? (
                    <VendorPicker value={picked?.id ?? null} onChange={setPicked}
                      placeholder="Pick or create a vendor"
                      createDefaults={{ city: x.vendor_city ?? '',
                        state: x.vendor_state ?? '' }} />
                  ) : (
                    <span className="sf-muted">Pick from your vendor list</span>
                  )}
                </span>
              </label>
              <label className={`sf-radio ${vendorMode === 'keep' ? 'is-on' : ''}`}>
                <input type="radio" name="sf-vendor" checked={vendorMode === 'keep'}
                  onChange={() => setVendorMode('keep')} />
                <span className="sf-radio-text">
                  <span className="sf-radio-eyebrow">No change</span>
                  <span>{keepLabel}</span>
                </span>
              </label>
            </div>
          )}
        </section>

        {/* ----- Campos de cabecera ----- */}
        <section className="sf-sec">
          <h3 className="sf-h">Details</h3>
          {!pDate && !pInv && pMi == null && !complaintText ? (
            <p className="sf-muted">No date, invoice number or mileage detected.</p>
          ) : (
            <table className="sf-fields">
              <thead>
                <tr>
                  <th aria-label="Apply" />
                  <th>Field</th>
                  <th>Current</th>
                  <th>From invoice</th>
                </tr>
              </thead>
              <tbody>
                {pDate && (
                  <tr className={useDate ? 'is-on' : ''}>
                    <td><input type="checkbox" checked={useDate}
                      onChange={(e) => setUseDate(e.target.checked)}
                      aria-label="Apply service date" /></td>
                    <td>Service date</td>
                    <td className="sf-cur mono">{wo.service_date || '—'}</td>
                    <td className="mono"><strong>{pDate}</strong></td>
                  </tr>
                )}
                {pInv && (
                  <tr className={useInv ? 'is-on' : ''}>
                    <td><input type="checkbox" checked={useInv}
                      onChange={(e) => setUseInv(e.target.checked)}
                      aria-label="Apply vendor invoice number" /></td>
                    <td>Vendor invoice #</td>
                    <td className="sf-cur mono">{wo.shop_invoice || '—'}</td>
                    <td className="mono"><strong>{pInv}</strong></td>
                  </tr>
                )}
                {pMi != null && (
                  <tr className={useMi ? 'is-on' : ''}>
                    <td><input type="checkbox" checked={useMi}
                      onChange={(e) => setUseMi(e.target.checked)}
                      aria-label="Apply mileage" /></td>
                    <td>Mileage</td>
                    <td className="sf-cur mono">
                      {wo.mileage != null ? wo.mileage.toLocaleString('en-US') : '—'}
                    </td>
                    <td className="mono"><strong>{pMi.toLocaleString('en-US')}</strong></td>
                  </tr>
                )}
                {complaintText && (
                  <tr className={useComplaint ? 'is-on' : ''}>
                    <td><input type="checkbox" checked={useComplaint}
                      onChange={(e) => setUseComplaint(e.target.checked)}
                      aria-label="Append issue text to the complaint" /></td>
                    <td>Complaint</td>
                    <td className="sf-cur">{wo.complaint ? 'keeps current text' : '—'}</td>
                    <td className="sf-complaint" title={complaintText}>
                      append: {complaintText}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </section>

        {/* ----- Líneas ----- */}
        <section className="sf-sec">
          <h3 className="sf-h">
            Parts &amp; labor
            <span className="sf-count">{chosen.length}/{prop.lines.length}</span>
          </h3>
          {existing.length > 0 && (
            <div className="sf-mode" role="radiogroup" aria-label="How to add lines">
              <label className={`sf-chip ${linesMode === 'append' ? 'is-on' : ''}`}>
                <input type="radio" name="sf-mode" checked={linesMode === 'append'}
                  onChange={() => setLinesMode('append')} />
                Append to existing lines
                <span className="sf-muted">
                  {' '}· keeps {existing.length} ({money(existingTotal)})
                </span>
              </label>
              <label className={`sf-chip ${linesMode === 'replace' ? 'is-on' : ''}`}>
                <input type="radio" name="sf-mode" checked={linesMode === 'replace'}
                  onChange={() => setLinesMode('replace')} />
                Replace lines
                <span className="sf-muted"> · removes {existing.length}</span>
              </label>
            </div>
          )}
          {prop.lines.length === 0 ? (
            <p className="sf-muted">
              No line items detected on the document. You can still apply the
              header fields{outside ? ' and vendor' : ''}.
            </p>
          ) : (
            <table className="sf-lines">
              <thead>
                <tr>
                  <th>
                    <input type="checkbox" aria-label="Select all lines"
                      checked={checked.every(Boolean)}
                      onChange={(e) =>
                        setChecked(prop.lines.map(() => e.target.checked))} />
                  </th>
                  <th>Kind</th>
                  <th>Description</th>
                  <th className="num">Qty</th>
                  <th className="num">Unit</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {prop.lines.map((l, i) => (
                  <tr key={i} className={checked[i] ? '' : 'is-off'}
                    onClick={() => setChecked((c) =>
                      c.map((v, j) => (j === i ? !v : v)))}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={!!checked[i]}
                        aria-label={`Include ${l.description}`}
                        onChange={(e) => setChecked((c) =>
                          c.map((v, j) => (j === i ? e.target.checked : v)))} />
                    </td>
                    <td>
                      <span className={`wo-line-kind k-${l.kind}`}>
                        {l.kind === 'part' ? 'Part' : 'Labor'}
                      </span>
                    </td>
                    <td className="sf-desc">
                      {l.part_number && (
                        <span className="wo-line-pn">{l.part_number}</span>
                      )}
                      {l.description}
                    </td>
                    <td className="num mono">{l.qty}</td>
                    <td className="num mono">{money(l.unit_cost)}</td>
                    <td className="num mono">{money(l.qty * l.unit_cost)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5}>
                    Selected lines
                    {grand != null && (
                      <span className="sf-muted"> · invoice total {money(grand)}</span>
                    )}
                  </td>
                  <td className="num mono"><strong>{money(chosenTotal)}</strong></td>
                </tr>
              </tfoot>
            </table>
          )}
          {mismatch && (
            <div className="banner warn wo-recon-warn">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                strokeLinejoin="round">
                <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                <path d="M12 9v4M12 17h.01" />
              </svg>
              <span>
                Selected lines sum to <strong>{money(chosenTotal)}</strong> but
                the invoice grand total is <strong>{money(grand!)}</strong>{' '}
                (off by {money(Math.abs(chosenTotal - grand!))}). The scan may
                have over-read rows — untick the extras or fix the lines after
                importing.
              </span>
            </div>
          )}
        </section>

        <div className="settings-actions sf-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={apply}
            disabled={saving || locked || !anything}>
            {saving ? 'Applying…' : 'Apply to work order'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
