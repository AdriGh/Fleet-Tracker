// Alta / edición de cliente (v2.22 [C]/[F]). Reemplaza el placeholder del
// shell (agente F1). Mismo contrato de props que usa CreateHost:
//   onClose()                     cerrar sin guardar
//   onSaved?(c: {id, name})       alta/edición OK
//   customer?: Customer | null    edición (sin él = alta)
//
// <CustomerForm> se exporta aparte: la pestaña Settings del perfil lo usa
// inline (sin modal). Campos (paridad SquareRigger + lo que SR no tiene):
// nombre*, tipo, cliente desde, activo, contacto, dirección, términos,
// markups de partes/labor, impuestos, ID contable, conductor vinculado,
// notas y tags.
//
// PII: sin pii.view el backend manda email/teléfono/dirección enmascarados
// ("•••"). Esos campos se muestran bloqueados y NUNCA se reenvían (un PATCH
// con el texto enmascarado pisaría el dato real).
import { useId, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createCustomer, listTmsDrivers, patchCustomer,
  type Customer, type CustomerInput, type CustomerKind, type CustomerTerms,
} from '../api'
import { notifyErr, notifyOk } from '../toast'
import {
  CUSTOMER_KIND_LABEL, CUSTOMER_KINDS, isMasked, TERMS, TERMS_LABEL,
} from '../customers'
import { Button } from './ds'
import Modal from './Modal'

export interface CustomerModalProps {
  customer?: Customer | null
  onClose: () => void
  onSaved?: (c: { id: number; name: string }) => void
}

export default function CustomerModal(
  { customer, onClose, onSaved }: CustomerModalProps,
) {
  return (
    <Modal title={customer ? `Edit ${customer.name}` : 'New customer'}
      onClose={onClose} width={720}>
      <CustomerForm customer={customer ?? null} onCancel={onClose}
        onSaved={(c) => onSaved?.({ id: c.id, name: c.name })} />
    </Modal>
  )
}

type Draft = {
  name: string; kind: CustomerKind; active: boolean; since: string
  email: string; phone: string; address: string; city: string
  state: string; zip: string; terms: CustomerTerms
  parts_markup_pct: string; labor_markup_pct: string
  tax_exempt: boolean; tax_rate_pct: string; accounting_id: string
  driver_name: string; notes: string; tags: string
}

// Campos de texto que el backend puede enmascarar.
const PII_FIELDS = ['email', 'phone', 'address', 'city', 'state', 'zip'] as const
type PiiField = (typeof PII_FIELDS)[number]

function toDraft(c: Customer | null): Draft {
  const s = (v: string | null | undefined) => (v && !isMasked(v) ? v : '')
  const n = (v: number | null | undefined) => (v ? String(v) : '')
  return {
    name: c?.name ?? '',
    kind: c?.kind ?? 'owner_operator',
    active: c?.active ?? true,
    since: c?.since ?? '',
    email: s(c?.email), phone: s(c?.phone), address: s(c?.address),
    city: s(c?.city), state: s(c?.state), zip: s(c?.zip),
    terms: c?.terms ?? '',
    parts_markup_pct: n(c?.parts_markup_pct),
    labor_markup_pct: n(c?.labor_markup_pct),
    tax_exempt: c?.tax_exempt ?? false,
    tax_rate_pct: n(c?.tax_rate_pct),
    accounting_id: c?.accounting_id ?? '',
    driver_name: c?.driver_name ?? '',
    notes: c?.notes ?? '',
    tags: c?.tags ?? '',
  }
}

const numOf = (s: string) => {
  const v = Number(s)
  return s.trim() === '' || !Number.isFinite(v) ? 0 : v
}

const pctErr = (s: string, max = 500) =>
  s.trim() !== '' && (!Number.isFinite(Number(s)) || Number(s) < 0
    || Number(s) > max) ? `Enter 0–${max}%` : ''

export function CustomerForm({
  customer, onSaved, onCancel, submitLabel, autoFocus = true,
}: {
  customer: Customer | null
  onSaved: (c: Customer) => void
  onCancel?: () => void
  submitLabel?: string
  autoFocus?: boolean
}) {
  const qc = useQueryClient()
  const uid = useId()
  const [d, setD] = useState<Draft>(() => toDraft(customer))
  const [saving, setSaving] = useState(false)
  const [touched, setTouched] = useState(false)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setD((x) => ({ ...x, [k]: v }))
  // Campos enmascarados (sin pii.view): bloqueados, no se envían.
  const masked = (k: PiiField) => !!customer && isMasked(customer[k])

  const driversQ = useQuery({
    queryKey: ['tms-drivers'], queryFn: listTmsDrivers, retry: false,
  })
  const driverNames = [...new Set(
    (driversQ.data ?? []).map((x) => x.name).filter(Boolean))]

  const nameErr = touched && !d.name.trim() ? 'A customer name is required' : ''
  const partsErr = pctErr(d.parts_markup_pct)
  const laborErr = pctErr(d.labor_markup_pct)
  const taxErr = d.tax_exempt ? '' : pctErr(d.tax_rate_pct, 100)

  function payload(): CustomerInput {
    const full: CustomerInput = {
      name: d.name.trim(), kind: d.kind, active: d.active,
      since: d.since || null,
      terms: d.terms,
      parts_markup_pct: numOf(d.parts_markup_pct),
      labor_markup_pct: numOf(d.labor_markup_pct),
      tax_exempt: d.tax_exempt,
      tax_rate_pct: d.tax_exempt ? 0 : numOf(d.tax_rate_pct),
      accounting_id: d.accounting_id.trim(),
      driver_name: d.driver_name.trim(),
      notes: d.notes.trim(),
      tags: d.tags.split(',').map((t) => t.trim()).filter(Boolean).join(', '),
    }
    for (const k of PII_FIELDS) {
      if (!masked(k)) full[k] = d[k].trim()
    }
    if (!customer) return full
    // Edición: solo lo que cambió.
    const out: Record<string, unknown> = {}
    const base = customer as unknown as Record<string, unknown>
    for (const [k, v] of Object.entries(full)) {
      const old = base[k]
      const same = typeof v === 'number'
        ? Number(old ?? 0) === v
        : (old ?? '') === (v ?? '')
      if (!same) out[k] = v
    }
    return out as CustomerInput
  }

  async function submit() {
    setTouched(true)
    if (!d.name.trim() || saving || partsErr || laborErr || taxErr) return
    setSaving(true)
    try {
      const body = payload()
      let saved: Customer
      if (customer) {
        if (Object.keys(body).length === 0) {
          onSaved(customer)
          return
        }
        saved = await patchCustomer(customer.id, body)
      } else {
        saved = await createCustomer({ ...body, name: d.name.trim() })
      }
      qc.invalidateQueries({ queryKey: ['customers'] })
      qc.invalidateQueries({ queryKey: ['customer'] })
      // Las WOs muestran customer_name desnormalizado.
      if (customer) {
        qc.invalidateQueries({ queryKey: ['workorders'] })
        qc.invalidateQueries({ queryKey: ['workorder'] })
      }
      notifyOk(customer ? 'Customer saved' : 'Customer added',
        saved?.name ?? d.name.trim())
      onSaved(saved ?? { ...(customer as Customer), ...body })
    } catch (e) {
      notifyErr(customer ? "Couldn't save the customer"
        : "Couldn't add the customer", e)
    } finally {
      setSaving(false)
    }
  }

  const field = (label: string, input: ReactNode, opts: {
    hint?: string; err?: string; wide?: boolean
  } = {}) => (
    <label className={`ud-field cf-field ${opts.wide ? 'is-wide' : ''}`}>
      <span>{label}</span>
      {input}
      {opts.err
        ? <span className="field-hint cf-err" role="alert">{opts.err}</span>
        : opts.hint ? <span className="field-hint">{opts.hint}</span> : null}
    </label>
  )
  const piiInput = (k: PiiField, props: {
    type?: string; placeholder?: string; inputMode?: 'tel' | 'email' | 'text'
    maxLength?: number
  } = {}) => (masked(k) ? (
    <input className="cell-input" disabled value={customer?.[k] ?? ''}
      title="Hidden — needs permission to view personal data" />
  ) : (
    <input className="cell-input" value={d[k]}
      type={props.type ?? 'text'} inputMode={props.inputMode}
      placeholder={props.placeholder} maxLength={props.maxLength}
      autoComplete="off"
      onChange={(e) => set(k, k === 'state'
        ? e.target.value.toUpperCase() : e.target.value)} />
  ))
  const anyMasked = PII_FIELDS.some((k) => masked(k))

  return (
    <form className="cf-form" noValidate
      onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <section className="cf-sec" aria-labelledby={`${uid}-p`}>
        <h3 id={`${uid}-p`}>Profile</h3>
        <div className="cf-grid">
          {field('Name *', (
            <input className="cell-input" value={d.name} autoFocus={autoFocus}
              maxLength={160} aria-invalid={!!nameErr}
              placeholder="e.g. Northline Transport LLC"
              onChange={(e) => set('name', e.target.value)} />
          ), { err: nameErr, wide: true })}
          {field('Customer type', (
            <select className="cell-input" value={d.kind}
              onChange={(e) => set('kind', e.target.value as CustomerKind)}>
              {CUSTOMER_KINDS.map((k) => (
                <option key={k} value={k}>{CUSTOMER_KIND_LABEL[k]}</option>
              ))}
            </select>
          ))}
          {field('Customer since', (
            <input className="cell-input" type="date" value={d.since}
              onChange={(e) => set('since', e.target.value)} />
          ))}
          {field('Linked driver', (
            <>
              <input className="cell-input" value={d.driver_name}
                list={`${uid}-drivers`} maxLength={120}
                placeholder="Driver from the roster (optional)"
                onChange={(e) => set('driver_name', e.target.value)} />
              <datalist id={`${uid}-drivers`}>
                {driverNames.map((n) => <option key={n} value={n} />)}
              </datalist>
            </>
          ), { hint: 'Owner-operators usually drive their own unit.' })}
          {field('Tags', (
            <input className="cell-input" value={d.tags} maxLength={200}
              placeholder="e.g. reefer, weekly settlement"
              onChange={(e) => set('tags', e.target.value)} />
          ), { hint: 'Comma separated.' })}
          {customer && (
            <label className="cf-check is-wide">
              <input type="checkbox" checked={d.active}
                onChange={(e) => set('active', e.target.checked)} />
              <span>
                <strong>Active</strong>
                <span className="field-hint">
                  Inactive customers keep their history but leave the Bill to
                  picker.
                </span>
              </span>
            </label>
          )}
        </div>
      </section>

      <section className="cf-sec" aria-labelledby={`${uid}-c`}>
        <h3 id={`${uid}-c`}>Contact &amp; address</h3>
        {anyMasked && (
          <p className="field-hint cf-pii">
            Some contact details are hidden. Ask an admin for permission to
            view personal data to edit them.
          </p>
        )}
        <div className="cf-grid">
          {field('Email', piiInput('email', {
            type: 'email', inputMode: 'email', placeholder: 'billing@carrier.com',
          }))}
          {field('Phone', piiInput('phone', {
            inputMode: 'tel', placeholder: '(312) 555-0142',
          }))}
          {field('Address', piiInput('address', {
            placeholder: 'Street and number',
          }), { wide: true })}
          {field('City', piiInput('city'))}
          <div className="cf-pair">
            {field('State', piiInput('state', { maxLength: 2, placeholder: 'IL' }))}
            {field('ZIP', piiInput('zip', { maxLength: 10 }))}
          </div>
        </div>
      </section>

      <section className="cf-sec" aria-labelledby={`${uid}-b`}>
        <h3 id={`${uid}-b`}>Billing</h3>
        <div className="cf-grid">
          {field('Payment terms', (
            <select className="cell-input" value={d.terms}
              onChange={(e) => set('terms', e.target.value as CustomerTerms)}>
              {TERMS.map((t) => (
                <option key={t || 'none'} value={t}>{TERMS_LABEL[t]}</option>
              ))}
            </select>
          ))}
          {field('Accounting ID', (
            <input className="cell-input" value={d.accounting_id}
              maxLength={60} placeholder="e.g. McLeod / QuickBooks ID"
              onChange={(e) => set('accounting_id', e.target.value)} />
          ))}
          {field('Parts markup %', (
            <input className="cell-input" type="number" min={0} max={500}
              step="0.1" inputMode="decimal" value={d.parts_markup_pct}
              placeholder="0" aria-invalid={!!partsErr}
              onChange={(e) => set('parts_markup_pct', e.target.value)} />
          ), {
            err: partsErr,
            hint: 'Added on top of the part cost when the order is invoiced.',
          })}
          {field('Labor markup %', (
            <input className="cell-input" type="number" min={0} max={500}
              step="0.1" inputMode="decimal" value={d.labor_markup_pct}
              placeholder="0" aria-invalid={!!laborErr}
              onChange={(e) => set('labor_markup_pct', e.target.value)} />
          ), { err: laborErr, hint: 'Added on top of the labor rate.' })}
          <label className="cf-check">
            <input type="checkbox" checked={d.tax_exempt}
              onChange={(e) => set('tax_exempt', e.target.checked)} />
            <span><strong>Tax exempt</strong></span>
          </label>
          {field('Tax rate %', (
            <input className="cell-input" type="number" min={0} max={100}
              step="0.01" inputMode="decimal" value={d.tax_rate_pct}
              disabled={d.tax_exempt} placeholder="0" aria-invalid={!!taxErr}
              onChange={(e) => set('tax_rate_pct', e.target.value)} />
          ), {
            err: taxErr,
            hint: 'Charged on billed parts; the rate locks when the order is invoiced.',
          })}
        </div>
      </section>

      <section className="cf-sec" aria-labelledby={`${uid}-n`}>
        <h3 id={`${uid}-n`}>Notes</h3>
        <textarea className="cell-input ud-notes" rows={3} value={d.notes}
          aria-labelledby={`${uid}-n`}
          placeholder="Settlement day, who approves repairs, anything the counter should know"
          onChange={(e) => set('notes', e.target.value)} />
      </section>

      <div className="sr-form-actions cf-actions">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        )}
        <Button variant="primary" type="submit" loading={saving}>
          {submitLabel ?? (customer ? 'Save customer' : 'Add customer')}
        </Button>
      </div>
    </form>
  )
}
