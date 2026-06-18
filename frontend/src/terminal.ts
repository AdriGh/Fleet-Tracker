// Terminales dinámicas: la config viene de GET /api/terminals (se editan
// en Settings → Terminals). Sin respuesta todavía, se usa el set de
// fábrica (idéntico al hardcodeado histórico) para no parpadear.
//
// Resolución de la terminal de una unidad (espejo de core/terminals.py):
//   1. asignación manual (flota pinneada desde Settings)
//   2. prefijo más largo de las terminales configuradas; el carácter que
//      sigue al prefijo no puede ser letra (MEM matchea "MEM-123", no
//      "MEMPHIS1"; un prefijo CF matchearía "CF2254")
//   3. respaldo por empresa: MCC sin prefijo → 'MCC' (sin chip propio),
//      si no → la primera terminal de la lista (históricamente CHASER)
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  listTerminals, type TerminalDef, type TerminalsConfig,
} from './api'

// Espejo del backend (core/terminals.DEFAULTS): una sola terminal generica.
// El admin crea las suyas desde Settings -> Terminals.
export const FACTORY_TERMINALS: TerminalDef[] = [
  { key: 'MAIN', label: 'Main', prefixes: [] },
]

const FACTORY_CFG: TerminalsConfig = {
  terminals: FACTORY_TERMINALS,
  assignments: {},
}

function resolveTerminal(
  cfg: TerminalsConfig, unit: string, company?: string,
): string {
  const name = (unit || '').trim()
  const assigned = cfg.assignments[name]
  if (assigned) return assigned
  const s = name.toUpperCase()
  let best = ''
  let bestKey = ''
  for (const t of cfg.terminals) {
    for (const p of t.prefixes) {
      if (p.length <= best.length) continue
      if (s.startsWith(p) && (s.length === p.length
          || !/[A-Z]/.test(s[p.length]))) {
        best = p
        bestKey = t.key
      }
    }
  }
  if (bestKey) return bestKey
  if ((company || '').toUpperCase() === 'MCC') return 'MCC'
  return cfg.terminals[0]?.key ?? 'CHASER'
}

export interface TerminalsApi {
  cfg: TerminalsConfig
  terminals: TerminalDef[]
  /** Código de terminal de una unidad. `company` es el respaldo. */
  terminalOf: (unit: string, company?: string) => string
  /** Nombre visible de una terminal ('MCC' = MCCI sin chip propio). */
  labelOf: (key: string) => string
  /** Terminales presentes en un conjunto, en el orden configurado. */
  present: (units: { unit: string; company?: string }[]) => string[]
}

/** Config de terminales + helpers de resolución (cache compartida). */
export function useTerminals(): TerminalsApi {
  const q = useQuery({
    queryKey: ['terminals'],
    queryFn: listTerminals,
    staleTime: 60_000,
  })
  // Una respuesta con `terminals` vacío no debería existir (el backend
  // veta borrar la última), pero si llegara, caer al set de fábrica
  // evita que desaparezcan todos los chips y labels.
  const cfg = q.data && q.data.terminals.length ? q.data : FACTORY_CFG
  return useMemo(() => {
    const labels = new Map(cfg.terminals.map((t) => [t.key, t.label]))
    return {
      cfg,
      terminals: cfg.terminals,
      terminalOf: (unit, company) => resolveTerminal(cfg, unit, company),
      labelOf: (key) => labels.get(key)
        ?? (key === 'MCC' ? 'MCCI (other)' : key),
      present: (units) => {
        const seen = new Set(
          units.map((u) => resolveTerminal(cfg, u.unit, u.company)))
        return cfg.terminals.filter((t) => seen.has(t.key))
          .map((t) => t.key)
      },
    }
  }, [cfg])
}
