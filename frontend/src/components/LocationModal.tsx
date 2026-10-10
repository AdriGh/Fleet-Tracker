// Alta / edición de ubicación (taller / yard / terminal) — v2.22 [F].
// Amplía la versión base del shell (agente F1): las ubicaciones son las
// terminales de Settings, ahora con tipo, código, dirección y teléfono.
//
// Contrato de props que usa el shell (CreateHost):
//   onClose()               cerrar sin guardar
//   onSaved?(key: string)   alta/edición OK → el shell navega a Locations
//   terminal?: TerminalDef  edición (sin él = alta)
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  saveTerminal, type LocationType, type TerminalDef,
} from '../api'
import { notifyErr, notifyOk } from '../toast'
import { LOCATION_TYPE_LABEL } from '../locations'
import { Button } from './ds'
import Modal from './Modal'

export interface LocationModalProps {
  terminal?: TerminalDef | null
  onClose: () => void
  onSaved?: (key: string) => void
}

export default function LocationModal(
  { terminal, onClose, onSaved }: LocationModalProps,
) {
  const qc = useQueryClient()
  const t = terminal ?? null
  const [f, setF] = useState({
    label: t?.label ?? '',
    type: (t?.type ?? 'terminal') as LocationType,
    code: t?.code ?? '',
    address: t?.address ?? '',
    city: t?.city ?? '',
    state: t?.state ?? '',
    zip: t?.zip ?? '',
    phone: t?.phone ?? '',
    prefixes: (t?.prefixes ?? []).join(', '),
  })
  const [saving, setSaving] = useState(false)
  const [touched, setTouched] = useState(false)
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))
  const nameErr = touched && !f.label.trim() ? 'A name is required' : ''

  async function save() {
    setTouched(true)
    if (!f.label.trim() || saving) return
    setSaving(true)
    try {
      const cfg = await saveTerminal({
        key: t?.key,
        label: f.label.trim(),
        prefixes: f.prefixes.split(',').map((p) => p.trim().toUpperCase())
          .filter(Boolean),
        type: f.type, code: f.code.trim().toUpperCase(),
        address: f.address.trim(), city: f.city.trim(),
        state: f.state.trim().toUpperCase(), zip: f.zip.trim(),
        phone: f.phone.trim(),
      })
      qc.setQueryData(['terminals'], cfg)
      qc.invalidateQueries({ queryKey: ['terminals'] })
      const saved = t?.key
        ? cfg.terminals.find((x) => x.key === t.key)
        : cfg.terminals.find(
          (x) => x.label.toLowerCase() === f.label.trim().toLowerCase())
      notifyOk(t ? 'Location saved' : 'Location added', f.label.trim())
      onSaved?.(saved?.key ?? t?.key ?? '')
    } catch (e) {
      notifyErr(t ? "Couldn't save the location" : "Couldn't add the location", e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={t ? `Edit ${t.label}` : 'New location'} onClose={onClose}
      width={600}>
      <form className="cf-form" noValidate
        onSubmit={(e) => { e.preventDefault(); void save() }}>
        <div className="cf-grid">
          <label className="ud-field cf-field is-wide">
            <span>Name *</span>
            <input className="cell-input" value={f.label} autoFocus
              maxLength={60} placeholder="e.g. Memphis shop"
              aria-invalid={!!nameErr}
              onChange={(e) => set('label', e.target.value)} />
            {nameErr && <span className="field-hint cf-err" role="alert">{nameErr}</span>}
          </label>
          <label className="ud-field cf-field">
            <span>Type</span>
            <select className="cell-input" value={f.type}
              onChange={(e) => set('type', e.target.value)}>
              {(Object.keys(LOCATION_TYPE_LABEL) as (keyof typeof LOCATION_TYPE_LABEL)[])
                .map((k) => (
                  <option key={k} value={k}>{LOCATION_TYPE_LABEL[k]}</option>
                ))}
            </select>
          </label>
          <label className="ud-field cf-field">
            <span>Code</span>
            <input className="cell-input" value={f.code} maxLength={12}
              placeholder="e.g. HQ, MEM"
              onChange={(e) => set('code', e.target.value)} />
          </label>
          <label className="ud-field cf-field is-wide">
            <span>Address</span>
            <input className="cell-input" value={f.address}
              placeholder="Street and number"
              onChange={(e) => set('address', e.target.value)} />
          </label>
          <label className="ud-field cf-field">
            <span>City</span>
            <input className="cell-input" value={f.city}
              onChange={(e) => set('city', e.target.value)} />
          </label>
          <div className="cf-pair">
            <label className="ud-field cf-field">
              <span>State</span>
              <input className="cell-input" value={f.state} maxLength={2}
                placeholder="TN"
                onChange={(e) => set('state', e.target.value.toUpperCase())} />
            </label>
            <label className="ud-field cf-field">
              <span>ZIP</span>
              <input className="cell-input" value={f.zip} maxLength={10}
                onChange={(e) => set('zip', e.target.value)} />
            </label>
          </div>
          <label className="ud-field cf-field">
            <span>Phone</span>
            <input className="cell-input" inputMode="tel" value={f.phone}
              onChange={(e) => set('phone', e.target.value)} />
          </label>
          <label className="ud-field cf-field">
            <span>Unit prefixes</span>
            <input className="cell-input" value={f.prefixes}
              placeholder="e.g. MEM, TN"
              onChange={(e) => set('prefixes', e.target.value)} />
            <span className="field-hint">
              Units whose number starts with a prefix belong here.
            </span>
          </label>
        </div>
        <div className="sr-form-actions cf-actions">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" loading={saving}>
            {t ? 'Save location' : 'Add location'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
