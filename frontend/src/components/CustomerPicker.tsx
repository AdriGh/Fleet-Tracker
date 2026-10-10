// CustomerPicker (v2.22 [C]): combobox de clientes para el "Bill to" de una
// WO. Misma mecánica que VendorPicker (ComboBox: ARIA, teclado, portal).
//
// Contrato con el padre:
//  - `value` es el customer_id (o null); `onChange(c | null)` recibe {id,
//    name} al elegir o null al vaciar el campo.
//  - Fila "+ Quick add customer “<typed>”" al final: mini-form inline
//    (nombre, tipo, teléfono) → quickCreateCustomer → lo elige. Así el
//    mostrador da de alta al owner-operator sin salir de la WO (paridad con
//    el "+" de SquareRigger).
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  listCustomers, quickCreateCustomer,
  type CustomerKind, type CustomerSummary,
} from '../api'
import { notifyErr, notifyOk } from '../toast'
import { CUSTOMER_KIND_LABEL, CUSTOMER_KINDS } from '../customers'
import ComboBox from './ComboBox'

export interface PickedCustomer { id: number; name: string }

interface Props {
  value: number | null
  onChange: (c: PickedCustomer | null) => void
  // Nombre a mostrar si el cliente elegido no está en la lista (inactivo o
  // todavía cargando): p. ej. wo.customer_name.
  fallbackName?: string
  placeholder?: string
  autoFocus?: boolean
  disabled?: boolean
  className?: string
  'aria-label'?: string
  invalid?: boolean
  errorText?: string
  allowCreate?: boolean
}

const norm = (s: string) => s.trim().toLowerCase()

export default function CustomerPicker({
  value, onChange, fallbackName = '', placeholder = 'Select customer…',
  autoFocus, disabled, className = '', 'aria-label': ariaLabel,
  invalid, errorText = 'Pick a customer from the list', allowCreate = true,
}: Props) {
  const qc = useQueryClient()
  const listQ = useQuery({
    queryKey: ['customers', 'picker'],
    queryFn: () => listCustomers({ active: true }),
  })
  const customers = useMemo(
    () => [...(listQ.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [listQ.data])
  const selected = customers.find((c) => c.id === value) ?? null
  // Último elegido: un cliente recién creado todavía no está en la lista
  // (se refresca en segundo plano) y su nombre igual tiene que verse.
  const [picked, setPicked] = useState<PickedCustomer | null>(null)
  const selName = selected?.name
    ?? (value != null && picked?.id === value ? picked.name : '')
  const shownName = selName || (value != null ? fallbackName : '')

  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? shownName

  function pick(c: PickedCustomer) {
    setDraft(null)
    setPicked(c)
    onChange(c)
  }

  function exact(q: string): CustomerSummary | undefined {
    const k = norm(q)
    return k ? customers.find((c) => norm(c.name) === k) : undefined
  }

  function commit() {
    if (draft === null) return
    if (!draft.trim()) {
      if (value != null) onChange(null)
    } else {
      const hit = exact(draft)
      if (hit && hit.id !== value) pick({ id: hit.id, name: hit.name })
    }
    setDraft(null)
  }

  return (
    <ComboBox<CustomerSummary>
      prefix="cp"
      text={text}
      onText={setDraft}
      items={customers}
      loading={listQ.isPending}
      getKey={(c) => c.id}
      filter={(c, q) => norm(c.name).includes(q)
        || norm(c.city ?? '').includes(q) || norm(c.state ?? '') === q}
      exact={exact}
      isSelected={(c) => c.id === value}
      onPick={(c) => pick({ id: c.id, name: c.name })}
      onCommit={commit}
      renderOption={(c) => <CustomerOption c={c} />}
      emptyNote={(q) => (listQ.error
        ? "Couldn't load customers"
        : q ? <>No customer matches “{q}”</> : 'No customers yet')}
      create={allowCreate ? {
        label: (q) => <>Quick add customer “{q}”</>,
        render: (q, done) => (
          <QuickCustomerForm name={q}
            onDone={(c) => {
              // done(c) lo elige (onPick); la lista se refresca aparte.
              if (c) qc.invalidateQueries({ queryKey: ['customers'] })
              setDraft(null)
              done(c)
            }} />
        ),
      } : undefined}
      listLabel="Customers"
      placeholder={placeholder} autoFocus={autoFocus} disabled={disabled}
      className={className}
      aria-label={ariaLabel}
      invalid={invalid} errorText={errorText} />
  )
}

function CustomerOption({ c }: { c: CustomerSummary }) {
  const loc = [c.city, c.state].filter(Boolean).join(', ')
  return (
    <>
      <span className="vp-main">
        <strong className="vp-name">{c.name}</strong>
        {loc && <span className="vp-loc">{loc}</span>}
      </span>
      {c.kind !== 'owner_operator' && (
        <span className="vp-kind">{CUSTOMER_KIND_LABEL[c.kind]}</span>
      )}
    </>
  )
}

// Mini-form inline dentro del desplegable (alta rápida).
function QuickCustomerForm({ name, onDone }: {
  name: string
  onDone: (c: CustomerSummary | null) => void
}) {
  const [f, setF] = useState<{ name: string; kind: CustomerKind; phone: string }>(
    { name, kind: 'owner_operator', phone: '' })
  const [saving, setSaving] = useState(false)

  async function submit() {
    const n = f.name.trim()
    if (!n) {
      notifyErr('Missing name', 'A customer name is required')
      return
    }
    setSaving(true)
    try {
      const c = await quickCreateCustomer({
        name: n, kind: f.kind, phone: f.phone.trim() || undefined,
      })
      notifyOk('Customer added', c.name)
      onDone({
        id: c.id, name: c.name, kind: c.kind ?? f.kind, active: true,
        city: c.city ?? '', state: c.state ?? '', since: c.since ?? null,
        units_count: 0, open_wos: 0, balance: 0,
      })
    } catch (e) {
      notifyErr("Couldn't add the customer", e)
      setSaving(false)
    }
  }

  return (
    <form className="vp-create"
      onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <span className="vp-create-eyebrow">Quick add customer</span>
      <label className="vp-create-field">
        <span>Name</span>
        <input className="cell-input" value={f.name} autoFocus
          onChange={(e) => setF({ ...f, name: e.target.value })} />
      </label>
      <div className="vp-create-row cp-create-row">
        <label className="vp-create-field">
          <span>Type</span>
          <select className="cell-input" value={f.kind}
            onChange={(e) => setF({ ...f, kind: e.target.value as CustomerKind })}>
            {CUSTOMER_KINDS.map((k) => (
              <option key={k} value={k}>{CUSTOMER_KIND_LABEL[k]}</option>
            ))}
          </select>
        </label>
        <label className="vp-create-field">
          <span>Phone</span>
          <input className="cell-input" value={f.phone} inputMode="tel"
            placeholder="optional"
            onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </label>
      </div>
      <div className="vp-create-actions">
        <button type="button" className="btn btn-ghost btn-xs"
          onClick={() => onDone(null)}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary btn-xs"
          disabled={saving}>
          {saving ? 'Adding…' : 'Add & select'}
        </button>
      </div>
    </form>
  )
}
