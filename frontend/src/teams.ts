// Equipos: la config viene de GET /api/teams (se editan en Settings →
// Teams). Un equipo es un grupo explícito de unidades + conductores; no
// hay prefijos ni resolución automática como en las terminales: una
// unidad pertenece a un equipo solo si está pinneada (cfg.members).
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listTeams, type TeamDef, type TeamsConfig } from './api'

const EMPTY_CFG: TeamsConfig = { teams: [], members: {} }

export interface TeamsApi {
  cfg: TeamsConfig
  teams: TeamDef[]
  /** Equipo de una unidad, o '' si no pertenece a ninguno. */
  teamOf: (unit: string) => string
  /** Nombre visible de un equipo (la key si no se encuentra). */
  labelOf: (key: string) => string
  /** Equipos presentes en un conjunto de unidades, en orden configurado. */
  present: (units: { unit: string }[]) => string[]
}

/** Config de equipos + helpers (cache compartida con react-query). */
export function useTeams(): TeamsApi {
  const q = useQuery({
    queryKey: ['teams'],
    queryFn: listTeams,
    staleTime: 60_000,
  })
  const cfg = q.data ?? EMPTY_CFG
  return useMemo(() => {
    const labels = new Map(cfg.teams.map((t) => [t.key, t.label]))
    return {
      cfg,
      teams: cfg.teams,
      teamOf: (unit) => cfg.members[(unit || '').trim()] ?? '',
      labelOf: (key) => labels.get(key) ?? key,
      present: (units) => {
        const seen = new Set(
          units.map((u) => cfg.members[(u.unit || '').trim()] ?? ''))
        return cfg.teams.filter((t) => seen.has(t.key)).map((t) => t.key)
      },
    }
  }, [cfg])
}
