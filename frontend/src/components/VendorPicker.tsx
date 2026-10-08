// VendorPicker (v2.21, outside work): combobox sobre ['vendors'] para elegir
// el taller externo (Vendor) de una WO. Misma mecánica que UnitPicker
// (ARIA, teclado, portal), construido sobre ComboBox.
//
// Contrato con el padre:
//  - `value` es el vendor_id (o null); `onChange(vendor | null)` recibe el
//    Vendor completo al elegir (el padre guarda vendor.id y puede mostrar
//    nombre/ciudad sin otro fetch) o null al vaciar el campo.
//  - El texto del input es local: muestra el nombre del vendor elegido; al
//    escribir filtra por nombre/ciudad; texto que no coincide vuelve al
//    nombre elegido al salir (vaciar el campo = quitar el vendor).
//  - Fila "+ Create vendor “<typed>”" al final: abre un mini-form inline
//    (nombre prellenado, ciudad, estado) → saveVendor kind 'shop' → lo elige.
//    `createDefaults` prellena ciudad/estado (p. ej. del escaneo).
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { listVendors, saveVendor, type Vendor, type VendorKind } from '../api'
import { notifyErr, notifyOk } from '../toast'
import { VENDOR_KIND_SHORT, vendorLoc } from '../vendors'
import ComboBox from './ComboBox'

interface Props {
  value: number | null
  onChange: (vendor: Vendor | null) => void
  placeholder?: string
  autoFocus?: boolean
  disabled?: boolean
  className?: string
  inputClassName?: string
  'aria-label'?: string
  title?: string
  // Marca el campo como requerido-sin-valor (outside work sin vendor).
  invalid?: boolean
  errorText?: string
  allowCreate?: boolean
  createDefaults?: { city?: string; state?: string }
  // Solo estos tipos (los sin tipo '' siempre entran). Default: todos.
  kinds?: VendorKind[]
}

const norm = (s: string) => s.trim().toLowerCase()

export default function VendorPicker({
  value, onChange, placeholder = 'Pick a vendor', autoFocus, disabled,
  className = '', inputClassName = '', 'aria-label': ariaLabel, title,
  invalid, errorText = 'Pick a vendor from the list', allowCreate = true,
  createDefaults, kinds,
}: Props) {
  const qc = useQueryClient()
  const vendorsQ = useQuery({ queryKey: ['vendors'], queryFn: listVendors })
  const vendors = useMemo(() => {
    const all = vendorsQ.data ?? []
    const list = kinds
      ? all.filter((v) => !v.kind || kinds.includes(v.kind)) : all
    return [...list].sort((a, b) => a.name.localeCompare(b.name))
  }, [vendorsQ.data, kinds])
  const selected = vendors.find((v) => v.id === value)
    ?? (vendorsQ.data ?? []).find((v) => v.id === value) ?? null

  // Texto local: mientras se escribe manda `draft`; si no, el vendor elegido.
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? selected?.name ?? ''

  function exact(q: string): Vendor | undefined {
    const k = norm(q)
    return k ? vendors.find((v) => norm(v.name) === k) : undefined
  }

  function commit() {
    if (draft === null) return
    if (!draft.trim()) {
      if (selected) onChange(null)
    } else {
      // Texto exacto de un vendor → elegirlo; si no, revertir al elegido.
      const hit = exact(draft)
      if (hit && hit.id !== value) onChange(hit)
    }
    setDraft(null)
  }

  return (
    <ComboBox<Vendor>
      prefix="vp"
      text={text}
      onText={setDraft}
      items={vendors}
      loading={vendorsQ.isPending}
      getKey={(v) => v.id}
      filter={(v, q) => norm(v.name).includes(q)
        || norm(v.city).includes(q) || norm(v.state) === q}
      exact={exact}
      isSelected={(v) => v.id === value}
      onPick={(v) => { setDraft(null); onChange(v) }}
      onCommit={commit}
      renderOption={(v) => <VendorOption v={v} />}
      emptyNote={(q) => (vendorsQ.error
        ? "Couldn't load vendors"
        : q ? <>No vendor matches “{q}”</> : 'No vendors yet')}
      create={allowCreate ? {
        label: (q) => <>Create vendor “{q}”</>,
        render: (q, done) => (
          <VendorCreateForm name={q}
            city={createDefaults?.city ?? ''}
            state={createDefaults?.state ?? ''}
            onDone={(v) => {
              if (v) qc.invalidateQueries({ queryKey: ['vendors'] })
              setDraft(null)
              done(v)
            }} />
        ),
      } : undefined}
      listLabel="Vendors"
      placeholder={placeholder} autoFocus={autoFocus} disabled={disabled}
      className={className} inputClassName={inputClassName}
      aria-label={ariaLabel} title={title}
      invalid={invalid} errorText={errorText} />
  )
}

function VendorOption({ v }: { v: Vendor }) {
  const loc = vendorLoc(v)
  return (
    <>
      <span className="vp-main">
        <strong className="vp-name">{v.name}</strong>
        {loc && <span className="vp-loc">{loc}</span>}
      </span>
      {v.kind && (
        <span className={`vp-kind vp-k-${v.kind}`}>
          {VENDOR_KIND_SHORT[v.kind]}
        </span>
      )}
    </>
  )
}

// Mini-form inline dentro del desplegable: crea el vendor como taller de
// servicio (kind 'shop') y lo devuelve ya elegido.
export function VendorCreateForm({ name, city, state, onDone }: {
  name: string
  city?: string
  state?: string
  onDone: (vendor: Vendor | null) => void
}) {
  const [f, setF] = useState({ name, city: city ?? '', state: state ?? '' })
  const [saving, setSaving] = useState(false)

  async function submit() {
    const n = f.name.trim()
    if (!n) {
      notifyErr('Missing name', 'A vendor name is required')
      return
    }
    setSaving(true)
    try {
      const v = await saveVendor({
        name: n, city: f.city.trim(), state: f.state.trim().toUpperCase(),
        kind: 'shop',
      })
      notifyOk('Vendor created', v.name)
      onDone(v)
    } catch (e) {
      notifyErr("Couldn't create vendor", e)
      setSaving(false)
    }
  }

  return (
    <form className="vp-create"
      onSubmit={(e) => { e.preventDefault(); submit() }}>
      <span className="vp-create-eyebrow">New vendor · service shop</span>
      <label className="vp-create-field">
        <span>Name</span>
        <input className="cell-input" value={f.name} autoFocus
          onChange={(e) => setF({ ...f, name: e.target.value })} />
      </label>
      <div className="vp-create-row">
        <label className="vp-create-field">
          <span>City</span>
          <input className="cell-input" value={f.city}
            onChange={(e) => setF({ ...f, city: e.target.value })} />
        </label>
        <label className="vp-create-field vp-create-state">
          <span>State</span>
          <input className="cell-input" value={f.state} maxLength={2}
            placeholder="TN"
            onChange={(e) =>
              setF({ ...f, state: e.target.value.toUpperCase() })} />
        </label>
      </div>
      <div className="vp-create-actions">
        <button type="button" className="btn btn-ghost btn-xs"
          onClick={() => onDone(null)}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary btn-xs"
          disabled={saving}>
          {saving ? 'Creating…' : 'Create & select'}
        </button>
      </div>
    </form>
  )
}
