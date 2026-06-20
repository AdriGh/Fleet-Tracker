import { useState, type CSSProperties } from 'react'
import Modal from './Modal'
import { addUnit, decodeVin, type UnitInput } from '../api'
import { useTerminals } from '../terminal'
import { notifyOk, notifyErr, notifyWarn } from '../toast'

const TYPES = [
  { v: 'truck', label: 'Tractor (truck)' },
  { v: 'trailer', label: 'Trailer' },
  { v: 'chassis', label: 'Chassis' },
]

const grid: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
  gap: '14px 16px', marginBottom: 18,
}
const actions: CSSProperties = {
  display: 'flex', justifyContent: 'flex-end', gap: 10,
}

export default function AddUnitModal({ onClose, onSaved }: {
  onClose: () => void
  onSaved: () => void
}) {
  const { terminals } = useTerminals()
  const [f, setF] = useState<UnitInput>({ unit: '', unit_type: 'truck' })
  const [decoding, setDecoding] = useState(false)
  const [vinMsg, setVinMsg] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set<K extends keyof UnitInput>(k: K, v: UnitInput[K]) {
    setF((s) => ({ ...s, [k]: v }))
  }

  // Smart Fill: decodifica el VIN via NHTSA vPIC y autollena Year/Make/Model.
  // Si vPIC no devuelve nada o el VIN es invalido, NO toca los campos y avisa
  // con un toast (patron de notificaciones de la app).
  async function smartFill() {
    const vin = (f.vin ?? '').trim()
    if (vin.length < 11) {
      setVinMsg(null)
      notifyWarn('Enter a full VIN first', '17-character VIN required')
      return
    }
    setDecoding(true)
    setVinMsg(null)
    try {
      const r = await decodeVin(vin)
      if (r.ok && (r.year || r.make || r.model)) {
        setF((s) => ({
          ...s, year: r.year || s.year,
          make: r.make || s.make, model: r.model || s.model,
        }))
        const summary = [r.year, r.make, r.model].filter(Boolean).join(' ')
        const extra = [r.body, r.engine].filter(Boolean).join(' · ')
        setVinMsg(`Filled from VIN: ${summary}`)
        notifyOk('Smart Fill complete', extra ? `${summary} · ${extra}` : summary)
      } else {
        // vPIC no reconocio el VIN: dejar los campos intactos y avisar.
        setVinMsg(null)
        notifyWarn('VIN not recognized', r.error || 'No specs returned — fields left as-is')
      }
    } catch (e) {
      setVinMsg(null)
      notifyErr('Smart Fill failed', e)
    } finally {
      setDecoding(false)
    }
  }

  async function save() {
    if (!f.unit.trim()) { setError('Unit Number is required'); return }
    setSaving(true)
    setError(null)
    try {
      await addUnit({ ...f, unit: f.unit.trim() })
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save unit')
      setSaving(false)
    }
  }

  return (
    <Modal title="Add New Unit" onClose={onClose} width={760}>
      {error && <div className="banner error"><span>{error}</span></div>}
      <div style={grid}>
        <label>
          <span>Who is the customer?</span>
          <input className="cell-input" value={f.customer ?? ''}
            onChange={(e) => set('customer', e.target.value)}
            placeholder="Customer name" />
        </label>
        <label>
          <span>Chassis type</span>
          <select className="cell-input" value={f.unit_type}
            onChange={(e) => set('unit_type', e.target.value)}>
            {TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
          </select>
        </label>
        <label>
          <span>Unit Subtype</span>
          <input className="cell-input" value={f.subtype ?? ''}
            onChange={(e) => set('subtype', e.target.value)}
            placeholder="Optional" />
        </label>

        <label style={{ gridColumn: '1 / -1' }}>
          <span>VIN — Smart Fill auto-populates Year / Make / Model</span>
          <span style={{ display: 'flex', gap: 8 }}>
            <input className="cell-input mono" style={{ flex: 1 }}
              value={f.vin ?? ''}
              onChange={(e) => set('vin', e.target.value.toUpperCase())}
              placeholder="17-character VIN" maxLength={17} />
            <button type="button" className="btn btn-ghost"
              onClick={smartFill} disabled={decoding}>
              {decoding ? (
                'Decoding…'
              ) : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                    strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 3v4M3 5h4M6 17v4M4 19h4M13 3l2.5 6.5L22 12l-6.5 2.5L13 21l-2.5-6.5L4 12l6.5-2.5z" />
                  </svg>
                  Smart Fill
                </span>
              )}
            </button>
          </span>
          {vinMsg && (
            <small style={{ color: 'var(--st-on-track-ink, var(--text-muted))' }}>
              {vinMsg}
            </small>
          )}
        </label>

        <label>
          <span>Year</span>
          <input className="cell-input" value={f.year ?? ''}
            onChange={(e) => set('year', e.target.value)} />
        </label>
        <label>
          <span>Make</span>
          <input className="cell-input" value={f.make ?? ''}
            onChange={(e) => set('make', e.target.value)} />
        </label>
        <label>
          <span>Model</span>
          <input className="cell-input" value={f.model ?? ''}
            onChange={(e) => set('model', e.target.value)} />
        </label>

        <label>
          <span>Unit Number *</span>
          <input className="cell-input" value={f.unit} autoFocus
            onChange={(e) => set('unit', e.target.value)} />
        </label>
        <label>
          <span>Terminal</span>
          <select className="cell-input" value={f.terminal ?? ''}
            onChange={(e) => set('terminal', e.target.value)}>
            <option value="">— Select terminal —</option>
            {terminals.map((t) => (
              <option key={t.key} value={t.key}>{t.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Fleet #</span>
          <input className="cell-input" value={f.fleet_no ?? ''}
            onChange={(e) => set('fleet_no', e.target.value)} />
        </label>

        <label>
          <span>License Plate State</span>
          <input className="cell-input" value={f.plate_state ?? ''}
            onChange={(e) => set('plate_state', e.target.value.toUpperCase())}
            placeholder="e.g. IL" maxLength={3} />
        </label>
        <label style={{ gridColumn: '2 / -1' }}>
          <span>License Plate</span>
          <input className="cell-input" value={f.plate ?? ''}
            onChange={(e) => set('plate', e.target.value.toUpperCase())} />
        </label>
      </div>

      <div style={actions}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  )
}
