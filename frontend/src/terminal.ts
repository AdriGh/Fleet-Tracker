// Terminal (region) de una unidad, deducida del prefijo de su nombre.
//   MEM-… -> Memphis · MDW-… -> Chicago · MIA-… -> Miami
//   ATL-… / SAV-… -> Georgia (Atlanta + Savannah agrupadas)
//   CF2248 / CI2037 (sin prefijo) -> Chaser
// Las unidades de MCC sin prefijo reconocido caen en 'MCC' (sin chip propio;
// solo aparecen bajo "All terminals").

const PREFIX_TO_TERMINAL: Record<string, string> = {
  MEM: 'MEM', MDW: 'MDW', MIA: 'MIA', ATL: 'GA', SAV: 'GA',
}

export const TERMINAL_LABEL: Record<string, string> = {
  CHASER: 'Chaser',
  MEM: 'Memphis',
  MDW: 'Chicago',
  MIA: 'Miami',
  GA: 'Georgia',
  MCC: 'MCCI (other)',
}

/** Código de terminal de una unidad. `company` se usa como respaldo. */
export function terminalOf(unit: string, company?: string): string {
  const s = (unit || '').trim().toUpperCase()
  const m = s.match(/^([A-Z]{2,4})[\s-]/)
  if (m && PREFIX_TO_TERMINAL[m[1]]) return PREFIX_TO_TERMINAL[m[1]]
  if ((company || '').toUpperCase() === 'MCC') return 'MCC'
  return 'CHASER'
}

// Orden de presentación. 'MCC' (other) no se muestra como chip a propósito.
const ORDER = ['CHASER', 'MEM', 'MDW', 'MIA', 'GA']

/** Terminales presentes en un conjunto de unidades, en orden estable. */
export function terminalsPresent(
  units: { unit: string; company?: string }[],
): string[] {
  const set = new Set(units.map((u) => terminalOf(u.unit, u.company)))
  return ORDER.filter((t) => set.has(t))
}
