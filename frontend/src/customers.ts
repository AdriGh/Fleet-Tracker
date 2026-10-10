// Clientes (v2.22 [C]): etiquetas compartidas + mapa unidad → dueño.
//
// Los clientes son, sobre todo, los owner-operators del taller: dueños de
// sus unidades, a los que se les factura partes y labor con su markup. El
// mapa de dueños alimenta el "Bill to" por defecto de una WO nueva y el dato
// "Owner" del perfil de unidad.
import { useCallback, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  getCustomer, listCustomers,
  type CustomerKind, type CustomerTerms,
} from './api'
import { normUnit } from './unitMatch'

export const CUSTOMER_KIND_LABEL: Record<CustomerKind, string> = {
  owner_operator: 'Owner-operator',
  carrier: 'Carrier',
  external: 'External',
}

export const CUSTOMER_KINDS: CustomerKind[] =
  ['owner_operator', 'carrier', 'external']

export const TERMS_LABEL: Record<CustomerTerms, string> = {
  '': 'Not set',
  cod: 'COD',
  net7: 'Net 7',
  net15: 'Net 15',
  net30: 'Net 30',
  '2_10_net30': '2% 10, Net 30',
  prepay: 'Prepay',
}

export const TERMS: CustomerTerms[] =
  ['', 'cod', 'net7', 'net15', 'net30', '2_10_net30', 'prepay']

// El backend enmascara la PII ("j•••@g•••.com") sin pii.view. Un valor
// enmascarado NUNCA se reenvía en un PATCH (pisaría el dato real).
export const isMasked = (v: string | null | undefined) =>
  !!v && v.includes('•')

export const money = (n: number | null | undefined) =>
  (n ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export const pct = (n: number | null | undefined) =>
  `${Math.round((n ?? 0) * 100) / 100}%`

// Año de "Customer since" (YYYY-MM-DD → "2025").
export const sinceYear = (s: string | null | undefined) =>
  s && /^\d{4}/.test(s) ? s.slice(0, 4) : ''

export interface UnitOwner { id: number; name: string }

// Dueño de cada unidad (clave normalizada "MEM77"). Se arma con las
// unidades que trae el listado (`units[]`, una sola llamada); solo si un
// backend viejo no las trae se cae al perfil de cada cliente con unidades.
// Igual que el backend (owner_of), solo cuentan los clientes ACTIVOS. Cache
// de 5 min, compartida por la WO nueva y el perfil de unidad. Si el módulo
// de clientes no responde, el mapa queda vacío (sin default de Bill to).
export function useUnitOwners() {
  const q = useQuery({
    queryKey: ['customers', 'owners'],
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () => {
      const all = await listCustomers({ active: true })
      const withUnits = all.filter((c) => (c.units_count ?? 0) > 0)
      const map: Record<string, UnitOwner> = {}
      const missing = withUnits.filter((c) => !Array.isArray(c.units))
      for (const c of withUnits) {
        for (const u of c.units ?? []) {
          map[normUnit(u)] = { id: c.id, name: c.name }
        }
      }
      // Fallback: concurrencia acotada (6) para no inundar el backend.
      for (let i = 0; i < missing.length; i += 6) {
        const batch = missing.slice(i, i + 6)
        const profiles = await Promise.all(batch.map((c) =>
          getCustomer(c.id).catch(() => null)))
        profiles.forEach((p, j) => {
          if (!p) return
          for (const u of p.units) {
            map[normUnit(u.unit)] = { id: batch[j].id, name: batch[j].name }
          }
        })
      }
      return map
    },
  })
  const map = useMemo(() => q.data ?? {}, [q.data])
  const ownerOf = useCallback(
    (unit: string | null | undefined): UnitOwner | null =>
      (unit ? map[normUnit(unit)] ?? null : null), [map])
  return { ownerOf, loading: q.isPending, ready: q.isSuccess }
}
