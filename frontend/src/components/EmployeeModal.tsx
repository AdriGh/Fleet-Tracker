// Alta / edición de empleado (técnico del roster) — v2.22 [F]. Amplía la
// versión base del shell (agente F1) con rol, contacto, tarifa por hora,
// fecha de ingreso y notas (PATCH /api/technicians/{id}).
//
// Contrato de props que usa el shell (CreateHost):
//   onClose()                       cerrar sin guardar
//   onSaved?(t: {id, name})         alta/edición OK → el shell navega a
//                                   Employees con intent {technician: id}
//   technician?: Technician | null  edición (sin él = alta)
//
// PII: teléfono/email llegan enmascarados sin pii.view → bloqueados y no se
// reenvían.
import { useId, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  createTechnician, patchTechnician,
  type Technician, type TechnicianInput,
} from '../api'
import { notifyErr, notifyOk } from '../toast'
import { isMasked } from '../customers'
import { Button } from './ds'
import Modal from './Modal'

export interface EmployeeModalProps {
  technician?: Technician | null
  onClose: () => void
  onSaved?: (t: { id: number; name: string }) => void
}

// Roles sugeridos (texto libre: el taller puede escribir el suyo).
const ROLES = ['Technician', 'Lead technician', 'Shop manager', 'Parts manager',
  'Service writer', 'Tire technician', 'Apprentice']

export default function EmployeeModal(
  { technician, onClose, onSaved }: EmployeeModalProps,
) {
  const qc = useQueryClient()
  const uid = useId()
  const t = technician ?? null
  const clean = (v?: string) => (v && !isMasked(v) ? v : '')
  const [f, setF] = useState({
    name: t?.name ?? '',
    role: t?.role ?? '',
    phone: clean(t?.phone),
    email: clean(t?.email),
    hourly_rate: t?.hourly_rate != null ? String(t.hourly_rate) : '',
    hire_date: t?.hire_date ?? '',
    notes: t?.notes ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [touched, setTouched] = useState(false)
  const phoneMasked = !!t && isMasked(t.phone)
  const emailMasked = !!t && isMasked(t.email)
  const rateErr = f.hourly_rate.trim() !== ''
    && (!Number.isFinite(Number(f.hourly_rate)) || Number(f.hourly_rate) < 0)
    ? 'Enter a rate of 0 or more' : ''
  const nameErr = touched && !f.name.trim() ? 'A name is required' : ''

  async function save() {
    setTouched(true)
    if (!f.name.trim() || rateErr || saving) return
    setSaving(true)
    try {
      const extras: TechnicianInput = {
        role: f.role.trim(),
        hourly_rate: f.hourly_rate.trim() === '' ? null : Number(f.hourly_rate),
        hire_date: f.hire_date,
        notes: f.notes.trim(),
        ...(phoneMasked ? {} : { phone: f.phone.trim() }),
        ...(emailMasked ? {} : { email: f.email.trim() }),
      }
      let saved: Technician
      if (t) {
        const body: TechnicianInput = { ...extras }
        if (f.name.trim() !== t.name) body.name = f.name.trim()
        saved = await patchTechnician(t.id, body)
      } else {
        saved = await createTechnician({ name: f.name.trim() })
        const hasExtras = Object.values(extras).some(
          (v) => v !== '' && v != null)
        if (hasExtras) saved = await patchTechnician(saved.id, extras)
      }
      // El roster alimenta el picker y las WOs muestran el nombre.
      qc.invalidateQueries({ queryKey: ['technicians'] })
      qc.invalidateQueries({ queryKey: ['technician'] })
      if (t && f.name.trim() !== t.name) {
        qc.invalidateQueries({ queryKey: ['workorders'] })
        qc.invalidateQueries({ queryKey: ['workorder'] })
      }
      notifyOk(t ? 'Employee saved' : 'Employee added', saved.name)
      onSaved?.({ id: saved.id, name: saved.name })
    } catch (e) {
      notifyErr(t ? "Couldn't save the employee" : "Couldn't add the employee", e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={t ? `Edit ${t.name}` : 'New employee'} onClose={onClose}
      width={600}>
      <form className="cf-form" noValidate
        onSubmit={(e) => { e.preventDefault(); void save() }}>
        <div className="cf-grid">
          <label className="ud-field cf-field is-wide">
            <span>Full name *</span>
            <input className="cell-input" value={f.name} autoFocus
              maxLength={80} placeholder="e.g. Carlos Mendoza"
              aria-invalid={!!nameErr}
              onChange={(e) => setF({ ...f, name: e.target.value })} />
            {nameErr && <span className="field-hint cf-err" role="alert">{nameErr}</span>}
            {t && (
              <span className="field-hint">
                Renaming updates the technician on their work orders.
              </span>
            )}
          </label>
          <label className="ud-field cf-field">
            <span>Role</span>
            <input className="cell-input" value={f.role} list={`${uid}-roles`}
              maxLength={60} placeholder="Technician"
              onChange={(e) => setF({ ...f, role: e.target.value })} />
            <datalist id={`${uid}-roles`}>
              {ROLES.map((r) => <option key={r} value={r} />)}
            </datalist>
          </label>
          <label className="ud-field cf-field">
            <span>Hire date</span>
            <input className="cell-input" type="date" value={f.hire_date}
              onChange={(e) => setF({ ...f, hire_date: e.target.value })} />
          </label>
          <label className="ud-field cf-field">
            <span>Phone</span>
            <input className="cell-input" inputMode="tel" value={f.phone}
              disabled={phoneMasked}
              placeholder={phoneMasked ? 'Hidden' : '(901) 555-0142'}
              onChange={(e) => setF({ ...f, phone: e.target.value })} />
          </label>
          <label className="ud-field cf-field">
            <span>Email</span>
            <input className="cell-input" type="email" value={f.email}
              disabled={emailMasked}
              placeholder={emailMasked ? 'Hidden' : 'name@shop.com'}
              onChange={(e) => setF({ ...f, email: e.target.value })} />
          </label>
          <label className="ud-field cf-field">
            <span>Hourly rate ($)</span>
            <input className="cell-input" type="number" min={0} step="0.01"
              inputMode="decimal" value={f.hourly_rate} placeholder="0.00"
              aria-invalid={!!rateErr}
              onChange={(e) => setF({ ...f, hourly_rate: e.target.value })} />
            {rateErr
              ? <span className="field-hint cf-err" role="alert">{rateErr}</span>
              : <span className="field-hint">Internal labor cost per hour.</span>}
          </label>
          <label className="ud-field cf-field is-wide">
            <span>Notes</span>
            <textarea className="cell-input ud-notes" rows={2} value={f.notes}
              placeholder="Certifications, shift, specialties…"
              onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </label>
        </div>
        {!t && (
          <p className="field-hint">
            Employees are the technicians you assign to inside work orders.
          </p>
        )}
        <div className="sr-form-actions cf-actions">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" loading={saving}>
            {t ? 'Save employee' : 'Add employee'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
