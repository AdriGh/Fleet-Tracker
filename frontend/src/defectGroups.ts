// Helpers compartidos para agrupar y analizar los defectos de una unidad.
// Usado por DefectsPage (panel expandible) y por UnitReport (PDF).

import type { Defect } from './api'
import { zoneOfCategory, type Kind, type ZoneId } from './truckZones'

export function items(detail: string): string[] {
  return (detail || '').split(';').map((s) => s.trim()).filter(Boolean)
}
export function categoryOf(item: string): string {
  const i = item.indexOf(' - ')
  return (i > 0 ? item.slice(0, i) : 'Other').trim()
}
export function bodyOf(item: string): string {
  const i = item.indexOf(' - ')
  return (i > 0 ? item.slice(i + 3) : item).trim()
}

// Ruido del DVIR que no es un defecto real (re-reportes sin cambios).
const NOISE =
  /^(previous inspection|nothing\s*(has\s*)?chang|same(\s|$|,|\.)|no\s*chang|still the same|everything still|all (still )?the same|same as before|same issues|same status)/i
export function isNoise(item: string): boolean {
  return NOISE.test(bodyOf(item))
}
export function normKey(item: string): string {
  return item.toLowerCase().replace(/\s+/g, ' ').replace(/[.,;]+$/, '').trim()
}

// Agrupa los defectos repetidos de una unidad y cuenta cuántas veces se reportó
// cada uno; además acumula la cantidad por zona del diagrama.
export interface DefectGroup {
  text: string
  body: string
  category: string
  zone: ZoneId | null
  count: number
}

export function analyzeUnit(records: Defect[], kind: Kind): {
  groups: DefectGroup[]
  zones: Record<string, number>
} {
  const map = new Map<string, DefectGroup>()
  const zones: Record<string, number> = {}
  for (const d of records) {
    // Cada fila ya viene deduplicada del backend; `reports` dice cuántas veces
    // se reportó realmente ese defecto.
    const reps = d.reports ?? 1
    for (const raw of items(d.detail)) {
      if (isNoise(raw)) continue
      const cat = categoryOf(raw)
      const zone = zoneOfCategory(cat, kind)
      const key = normKey(raw)
      let g = map.get(key)
      if (!g) {
        g = { text: raw, body: bodyOf(raw), category: cat, zone, count: 0 }
        map.set(key, g)
      }
      g.count += reps
      if (zone) zones[zone] = (zones[zone] ?? 0) + 1
    }
  }
  const groups = [...map.values()].sort(
    (a, b) => b.count - a.count || a.text.localeCompare(b.text),
  )
  return { groups, zones }
}
