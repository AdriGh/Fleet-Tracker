// Terminal (region) de una unidad, deducida del prefijo de su nombre.
//   MEM-RMF1826 -> MEM (Memphis) · MIA-… -> MIA · ATL/SAV/MDW …
//   CF2248 / CI2037 (sin prefijo) -> CHASER
// Las unidades de MCC sin prefijo reconocido caen en 'MCC' (sin terminal).

const MCC_TERMINALS = new Set(['MDW', 'MEM', 'ATL', 'SAV', 'MIA'])

export const TERMINAL_LABEL: Record<string, string> = {
  CHASER: 'Chaser',
  MEM: 'Memphis',
  MIA: 'Miami',
  ATL: 'Atlanta',
  SAV: 'Savannah',
  MDW: 'Chicago',
  MCC: 'MCCI (other)',
}

/** Código de terminal de una unidad. `company` se usa como respaldo. */
export function terminalOf(unit: string, company?: string): string {
  const s = (unit || '').trim().toUpperCase()
  const m = s.match(/^([A-Z]{2,4})[\s-]/)
  if (m && MCC_TERMINALS.has(m[1])) return m[1]
  if ((company || '').toUpperCase() === 'MCC') return 'MCC'
  return 'CHASER'
}

/** Orden de presentación de las terminales. */
const ORDER = ['CHASER', 'MEM', 'MIA', 'ATL', 'SAV', 'MDW', 'MCC']

/** Terminales presentes en un conjunto de unidades, en orden estable. */
export function terminalsPresent(
  units: { unit: string; company?: string }[],
): string[] {
  const set = new Set(units.map((u) => terminalOf(u.unit, u.company)))
  return ORDER.filter((t) => set.has(t))
}
