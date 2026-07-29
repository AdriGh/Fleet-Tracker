// Helpers de conductor compartidos (v2.11).
//
// Vivían dentro de views/DriversPage.tsx (la página "Driver Compliance", que se
// eliminó a favor del buscador + drawer). `docState` en particular era el ÚNICO
// lugar de todo el código donde se calculaba el estado de un vencimiento, así
// que se extrajo acá en vez de perderse: lo usan el drawer del conductor y la
// sección de compliance de Reports.
import type { TmsDriverRow } from './api'

export const ROLE_LABEL: Record<string, string> = {
  owner_operator: 'Owner Operator',
  company_driver: 'Company Driver',
  lease_operator: 'Lease Operator',
}

export const PAY_LABEL: Record<string, string> = {
  percentage: 'Percentage',
  flat: 'Flat pay',
  mileage: 'Mileage',
  hourly: 'Hourly',
}

// Los cuatro documentos de compliance del conductor.
export const DOCS: { key: keyof TmsDriverRow; label: string }[] = [
  { key: 'cdl_exp', label: 'CDL' },
  { key: 'med_exp', label: 'Med/Cert' },
  { key: 'mvr_exp', label: 'MVR' },
  { key: 'chouse_exp', label: 'C/House' },
]

export type DocTone = '' | 'ok' | 'warn' | 'danger'

/** Tono de un vencimiento: vencido = danger, <30 días = warn, si no ok.
 *  Sin fecha devuelve '' (que NO es lo mismo que válido: es dato faltante). */
export function expTone(iso: string): DocTone {
  if (!iso) return ''
  const days = (Date.parse(iso) - Date.now()) / 86_400_000
  if (Number.isNaN(days)) return ''
  if (days < 0) return 'danger'
  if (days < 30) return 'warn'
  return 'ok'
}

/** Texto del estado de un vencimiento, para mostrar junto a la fecha. */
export function expLabel(iso: string): string {
  const tone = expTone(iso)
  if (!iso) return 'No date'
  if (tone === 'danger') return 'EXPIRED'
  if (tone === 'warn') return 'Expiring soon'
  return 'Valid'
}

/** ¿Este conductor necesita atención en algún documento? */
export function needsAttention(d: TmsDriverRow): boolean {
  return DOCS.some(({ key }) => {
    const v = String(d[key] ?? '')
    return !v || expTone(v) !== 'ok'
  })
}

export function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2)
    .map((w) => w[0] ?? '').join('').toUpperCase()
}
