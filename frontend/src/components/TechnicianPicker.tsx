// TechnicianPicker (v2.21): combobox sobre el roster de técnicos
// (['technicians'], solo activos) para asignar el mecánico de una WO.
// WorkOrder.mechanic sigue siendo un NOMBRE (string): `value`/`onChange`
// son el texto (como UnitPicker), así el picker reemplaza 1:1 los inputs
// con <datalist> sin cambiar el contrato con el backend.
//
//  - Elegir una opción → onChange(nombre canónico del roster) + onCommit.
//  - "+ Add “<typed>” as technician" crea el técnico (POST /technicians) y
//    lo elige. Si el nombre ya existe (p. ej. inactivo) queda el texto: el
//    backend igual lo acepta y lo auto-agrega al roster al guardar la WO.
//  - `onCommit(name)`: blur / Enter / elección — para los campos del drawer
//    que guardan al salir (saveField). Texto libre también se acepta: la
//    asignación nunca se bloquea por permisos ni por el roster.
import { useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createTechnician, listTechnicians, type Technician } from '../api'
import { notifyErr, notifyOk } from '../toast'
import { initialsOf } from '../technicians'
import ComboBox from './ComboBox'

interface Props {
  value: string
  onChange: (name: string) => void
  onCommit?: (name: string) => void
  placeholder?: string
  autoFocus?: boolean
  disabled?: boolean
  className?: string
  inputClassName?: string
  'aria-label'?: string
  title?: string
  allowCreate?: boolean
}

const norm = (s: string) => s.trim().toLowerCase()

export default function TechnicianPicker({
  value, onChange, onCommit, placeholder = 'Technician', autoFocus,
  disabled, className = '', inputClassName = '', 'aria-label': ariaLabel,
  title, allowCreate = true,
}: Props) {
  const qc = useQueryClient()
  const techQ = useQuery({
    queryKey: ['technicians'], queryFn: () => listTechnicians(),
  })
  const techs = useMemo(
    () => [...(techQ.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [techQ.data])

  function exact(q: string): Technician | undefined {
    const k = norm(q)
    return k ? techs.find((t) => norm(t.name) === k) : undefined
  }

  async function create(q: string): Promise<Technician | null> {
    try {
      const t = await createTechnician({ name: q.trim() })
      qc.invalidateQueries({ queryKey: ['technicians'] })
      notifyOk('Technician added', t.name)
      return t
    } catch (e) {
      // Ya existe (p. ej. inactivo): se conserva el texto; el backend lo
      // acepta igual al guardar la WO.
      notifyErr("Couldn't add technician", e)
      return null
    }
  }

  return (
    <ComboBox<Technician>
      prefix="tp"
      text={value}
      onText={onChange}
      items={techs}
      loading={techQ.isPending}
      getKey={(t) => t.id}
      filter={(t, q) => norm(t.name).includes(q)}
      exact={exact}
      isSelected={(t) => norm(t.name) === norm(value)}
      onPick={(t) => { onChange(t.name); onCommit?.(t.name) }}
      onCommit={() => {
        // Texto igual a un técnico con otra grafía → nombre canónico.
        const hit = exact(value)
        const final = hit ? hit.name : value.trim()
        if (final !== value) onChange(final)
        onCommit?.(final)
      }}
      renderOption={(t) => (
        <>
          <span className="tp-avatar" aria-hidden="true">{initialsOf(t.name)}</span>
          <span className="tp-name">{t.name}</span>
          {t.user_id != null && <span className="tp-tag">account</span>}
        </>
      )}
      emptyNote={(q) => (techQ.error
        ? "Couldn't load the technician roster"
        : q ? <>No technician matches “{q}”</>
          : 'No technicians yet — type a name to add one')}
      create={allowCreate ? {
        label: (q) => <>Add “{q}” as technician</>,
        onCreate: create,
      } : undefined}
      listLabel="Technicians"
      placeholder={placeholder} autoFocus={autoFocus} disabled={disabled}
      className={className} inputClassName={inputClassName}
      aria-label={ariaLabel} title={title} />
  )
}
