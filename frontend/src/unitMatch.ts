// Unidades canónicas (v2.20 addendum): el mismo camión escrito distinto
// ("MEM 77" vs "MEM77") partía el backlog en dos filas. Este módulo es la
// fuente única para elegir una unidad EXISTENTE: normaliza, busca y valida
// contra la lista de la flota. Lo usan <UnitPicker> y los formularios que
// lo contienen (para saber si pueden guardar), así nunca se desfasan.
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  fleetIsPartial, getMaintBoard, listFleet, listServiceRequests,
  type FleetUnit,
} from './api'

// Lo mínimo que necesita el picker de una unidad. FleetUnit encaja tal cual;
// otras listas (p. ej. las filas del board de PM/DOT) pasan solo lo que tienen.
export type PickerUnit = Pick<FleetUnit, 'unit'> & Partial<Pick<FleetUnit,
  'company' | 'make' | 'model' | 'year' | 'kind' | 'unit_type' | 'archived'>>

// Misma normalización que el backend (_norm_unit): mayúsculas, sin espacios.
export const normUnit = (s: string) => s.trim().toUpperCase().replace(/\s+/g, '')

// loading = la flota todavía no llegó (no se puede validar: no se guarda).
// strict  = hay lista: solo vale una unidad de la lista.
// free    = la flota falló, está vacía o vino parcial (Samsara caído: solo
//           las manuales; el backend acepta cualquiera): texto libre.
export type UnitMatchMode = 'loading' | 'strict' | 'free'

export interface UnitMatcher {
  mode: UnitMatchMode
  units: PickerUnit[]                          // activas primero, orden natural
  find: (text: string) => PickerUnit | null    // match exacto normalizado
  isValid: (text: string) => boolean
  canonical: (text: string) => string          // nombre de la flota o el texto
}

const byUnit = (a: PickerUnit, b: PickerUnit) =>
  Number(!!a.archived) - Number(!!b.archived)
  || a.unit.localeCompare(b.unit, 'en', { numeric: true })

// `override` reemplaza la flota (y entonces no se pide /api/fleet). Sin él,
// usa la query ['fleet'] — la misma key que el resto de la app: caché única.
// `extra` = unidades que la app YA muestra aunque no estén en /api/fleet
// (las del backlog de Service Requests — p. ej. defectos del CSV de MCC —,
// las filas del board de PM/DOT): se suman como opciones válidas. La flota
// gana: una extra que normaliza igual que una unidad de la flota no agrega
// otra grafía. No cambian el modo (eso lo decide la flota).
// `extraWins`: al revés, la grafía de `extra` gana (Add PM / Add DOT del
// board: el registro tiene que caer en la fila del board — 'CAN1' del CSV —
// aunque la flota la escriba 'CAN 1'; si no, el board abre otra fila).
export function useUnitMatcher(
  override?: PickerUnit[], extra?: PickerUnit[], extraWins = false,
): UnitMatcher {
  const fleetQ = useQuery({
    queryKey: ['fleet'], queryFn: listFleet, enabled: !override,
  })
  const source: PickerUnit[] | undefined = override ?? fleetQ.data
  const failed = !override && fleetQ.isError
  // Lista parcial: exigir elegir de ella bloquearía las unidades de Samsara.
  const partial = !override && fleetQ.data != null && fleetIsPartial()
  return useMemo<UnitMatcher>(() => {
    const base = (source ?? []).filter((u) => u.unit && u.unit.trim())
      .slice().sort(byUnit)
    const index = new Map<string, PickerUnit>()
    // Extras solo si hay lista base (con la flota cargando o caída no
    // suman nada: el modo es loading / free).
    const extras: PickerUnit[] = []
    if (base.length) {
      for (const u of extra ?? []) {
        const name = u.unit?.trim()
        if (name) extras.push({ ...u, unit: name })
      }
    }
    // Primero la lista que gana; la otra solo agrega lo que falta. La base
    // ya viene ordenada: ante dos grafías de la misma unidad gana la activa.
    const [first, second] = extraWins ? [extras, base] : [base, extras]
    const units: PickerUnit[] = []
    for (const u of [...first, ...second]) {
      const k = normUnit(u.unit)
      if (index.has(k)) continue
      index.set(k, u)
      units.push(u)
    }
    units.sort(byUnit)
    const mode: UnitMatchMode = source
      ? (units.length && !partial ? 'strict' : 'free')
      : failed ? 'free' : 'loading'
    const find = (text: string) =>
      (mode === 'strict' ? index.get(normUnit(text)) ?? null : null)
    return {
      mode,
      units,
      find,
      isValid: (text: string) => {
        if (!text.trim()) return false
        if (mode === 'free') return true
        return mode === 'strict' && find(text) != null
      },
      canonical: (text: string) => find(text)?.unit ?? text.trim(),
    }
  }, [source, extra, extraWins, failed, partial])
}

// Unidades que la app YA muestra fuera de /api/fleet, para `extra`: las del
// backlog de Service Requests (misma key que el badge del nav) y las filas
// de los boards de PM / DOT (mismas keys que MaintBoardPage: caché
// compartida). Cubre p. ej. los defectos del CSV de MCC y los camiones que
// solo están en el CSV de PM. Si alguna falla, simplemente no suma.
export function useKnownUnits(): PickerUnit[] {
  const srQ = useQuery({
    queryKey: ['service-requests', 'open', '', ''],
    queryFn: () => listServiceRequests({ status: 'open' }),
    staleTime: 60_000,
  })
  const pmQ = useQuery({
    queryKey: ['maint', 'pm'], queryFn: () => getMaintBoard('pm'),
    staleTime: 5 * 60_000,
  })
  const dotQ = useQuery({
    queryKey: ['maint', 'dot'], queryFn: () => getMaintBoard('dot'),
    staleTime: 5 * 60_000,
  })
  return useMemo(() => unitsFromNames([
    ...(srQ.data?.units ?? []).map((u) => u.unit),
    ...(srQ.data?.requests ?? []).map((r) => r.unit),
    ...(pmQ.data?.units ?? []).map((u) => u.unit),
    ...(dotQ.data?.units ?? []).map((u) => u.unit),
  ]), [srQ.data, pmQ.data, dotQ.data])
}

// Lista de unidades para `extra` a partir de nombres sueltos (sin datos del
// asset). Deduplica por unidad normalizada.
export function unitsFromNames(names: Iterable<string>): PickerUnit[] {
  const seen = new Set<string>()
  const out: PickerUnit[] = []
  for (const n of names) {
    const name = (n ?? '').trim()
    const k = normUnit(name)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push({ unit: name })
  }
  return out
}

// "2021 Freightliner Cascadia" (o el model suelto si no hay más datos).
export function unitDescription(u: PickerUnit): string {
  return [u.year, u.make, u.model]
    .filter((x) => x != null && String(x).trim()).join(' ')
}

// Filtro del combobox. Vacío → solo activas. Con texto: por número de unidad
// normalizado (exacto > empieza con > contiene) y después por año/marca/
// modelo/compañía (todas las palabras tienen que aparecer). Las archivadas
// solo salen buscándolas, al final de su grupo.
export function filterUnits(units: PickerUnit[], query: string): PickerUnit[] {
  const q = query.trim()
  if (!q) return units.filter((u) => !u.archived)
  const nq = normUnit(q)
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const scored: { u: PickerUnit; s: number }[] = []
  for (const u of units) {
    const nu = normUnit(u.unit)
    let s = -1
    if (nu === nq) s = 0
    else if (nu.startsWith(nq)) s = 1
    else if (nu.includes(nq)) s = 2
    else {
      const hay = `${unitDescription(u)} ${u.company ?? ''}`.toLowerCase()
      if (words.every((w) => hay.includes(w))) s = 3
    }
    if (s >= 0) scored.push({ u, s })
  }
  scored.sort((a, b) => a.s - b.s || byUnit(a.u, b.u))
  return scored.map((x) => x.u)
}
