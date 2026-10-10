// "Bill to: Self | Customer" (v2.22 [C]) — paridad con el radio CUSTOMER de
// la WO de SquareRigger, más el default automático desde el dueño de la
// unidad. Self = la flota propia (sin customer_id); Customer = un cliente
// (owner-operator) al que se le factura con su markup.
import { useId } from 'react'
import CustomerPicker, { type PickedCustomer } from './CustomerPicker'

export type BillMode = 'self' | 'customer'

export default function BillToField({
  mode, customer, onMode, onCustomer, hint, disabled, invalid,
  className = '',
}: {
  mode: BillMode
  customer: PickedCustomer | null
  onMode: (m: BillMode) => void
  onCustomer: (c: PickedCustomer | null) => void
  hint?: string
  disabled?: boolean
  invalid?: boolean
  className?: string
}) {
  const id = useId()
  const opt = (m: BillMode, label: string) => (
    <label className={`bt-opt ${mode === m ? 'is-on' : ''}`}>
      <input type="radio" name={`${id}-bill`} value={m}
        checked={mode === m} disabled={disabled}
        onChange={() => onMode(m)} />
      <span>{label}</span>
    </label>
  )
  return (
    <div className={`ud-field bt-field ${className}`}>
      <span id={`${id}-l`}>Bill to</span>
      <div className="bt-row">
        <div className="bt-seg" role="radiogroup" aria-labelledby={`${id}-l`}>
          {opt('self', 'Self')}
          {opt('customer', 'Customer')}
        </div>
        {mode === 'customer' && (
          <CustomerPicker className="bt-picker"
            value={customer?.id ?? null}
            fallbackName={customer?.name ?? ''}
            disabled={disabled}
            aria-label="Customer to bill"
            invalid={invalid}
            errorText="Pick the customer to bill"
            onChange={onCustomer} />
        )}
      </div>
      {hint && <span className="field-hint bt-hint">{hint}</span>}
    </div>
  )
}
