// Alta rápida de un Parts Request (v2.22, menú "+" Add New): un faltante que
// entra a la cola de Purchasing (pending → bundle por vendor → PO). Elegir
// una parte del catálogo precarga descripción, costo (avg_cost) y vendor.
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createPartsRequest, listParts, listVendors, type PartsRequest,
} from '../api'
import { notifyErr, notifyOk } from '../toast'
import { Button } from './ds'
import Modal from './Modal'

export default function PartsRequestModal({ onClose, onCreated }: {
  onClose: () => void
  onCreated: (r: PartsRequest) => void
}) {
  const qc = useQueryClient()
  const partsQ = useQuery({ queryKey: ['parts'], queryFn: listParts })
  const vendorsQ = useQuery({ queryKey: ['vendors'], queryFn: listVendors })
  const parts = useMemo(() => partsQ.data?.parts ?? [], [partsQ.data])
  const vendors = vendorsQ.data ?? []

  const [pn, setPn] = useState('')
  const [desc, setDesc] = useState('')
  const [qty, setQty] = useState('1')
  const [cost, setCost] = useState('')
  const [vendor, setVendor] = useState('')
  const [saving, setSaving] = useState(false)

  const qtyN = Number(qty)
  const costN = cost.trim() === '' ? 0 : Number(cost)
  const valid = (!!pn.trim() || !!desc.trim())
    && Number.isFinite(qtyN) && qtyN > 0
    && Number.isFinite(costN) && costN >= 0

  // Parte del catálogo: precarga lo que falte (sin pisar lo ya escrito).
  function onPn(v: string) {
    setPn(v)
    const hit = parts.find(
      (p) => p.part_number.toLowerCase() === v.trim().toLowerCase())
    if (!hit) return
    if (!desc.trim()) setDesc(hit.description)
    if (!cost.trim()) {
      const c = hit.avg_cost > 0 ? hit.avg_cost : hit.cost
      if (c > 0) setCost(String(Math.round(c * 100) / 100))
    }
    if (!vendor.trim() && hit.vendor_name) setVendor(hit.vendor_name)
  }

  async function save() {
    if (!valid || saving) return
    setSaving(true)
    try {
      const r = await createPartsRequest({
        part_number: pn.trim(),
        description: desc.trim() || pn.trim(),
        qty: qtyN,
        unit_cost: costN,
        vendor: vendor.trim(),
        source: 'manual',
      })
      qc.invalidateQueries({ queryKey: ['parts-requests'] })
      notifyOk('Parts request added',
        `${r.qty} × ${r.part_number || r.description}`)
      onCreated(r)
    } catch (e) {
      notifyErr("Couldn't add the parts request", e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="New parts request" onClose={onClose} width={540}>
      <form className="sr-form"
        onSubmit={(e) => { e.preventDefault(); save() }}>
        <p className="sr-form-lead-title">
          Lands in Purchasing → Requests, ready to bundle into a purchase
          order with other parts from the same vendor.
        </p>
        <div className="sr-form-row">
          <label className="ud-field">
            <span>Part number</span>
            <input className="cell-input" value={pn} autoFocus
              list="prm-parts" placeholder="Pick from catalog or type"
              onChange={(e) => onPn(e.target.value)} />
            <datalist id="prm-parts">
              {parts.slice(0, 400).map((p) => (
                <option key={p.id} value={p.part_number}>
                  {p.description}
                </option>
              ))}
            </datalist>
          </label>
          <label className="ud-field">
            <span>Vendor</span>
            <input className="cell-input" value={vendor} list="prm-vendors"
              placeholder="Optional"
              onChange={(e) => setVendor(e.target.value)} />
            <datalist id="prm-vendors">
              {vendors.map((v) => <option key={v.id} value={v.name} />)}
            </datalist>
          </label>
        </div>
        <label className="ud-field">
          <span>Description {pn.trim() ? '' : '*'}</span>
          <input className="cell-input" value={desc} maxLength={200}
            placeholder="e.g. Fuel filter, Freightliner Cascadia"
            onChange={(e) => setDesc(e.target.value)} />
        </label>
        <div className="sr-form-row">
          <label className="ud-field">
            <span>Quantity *</span>
            <input className="cell-input" inputMode="decimal" value={qty}
              onChange={(e) => setQty(e.target.value)} />
          </label>
          <label className="ud-field">
            <span>Unit cost</span>
            <input className="cell-input" inputMode="decimal" value={cost}
              placeholder="0.00"
              onChange={(e) => setCost(e.target.value)} />
          </label>
        </div>
        <div className="sr-form-actions">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" loading={saving}
            disabled={!valid}>
            Add request
          </Button>
        </div>
      </form>
    </Modal>
  )
}
