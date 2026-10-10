// Shell v2.22 (sin router): navegación por sección + "intent" opcional y
// creación global ("+" Add New / command palette). App provee el contexto;
// cualquier vista puede navegar o abrir un modal de alta sin prop-drilling.
//
// Intent = qué abrir/filtrar al llegar a la sección. App re-monta la página
// cuando la navegación trae un intent (key nueva), así cada página lo lee en
// sus inicializadores de useState — sin efectos que encadenen setState.
import { createContext, useContext } from 'react'

// Tipos de alta del menú "+" / palette. Los ids son estables: los usan
// CreateHost, el palette y el intent {create: kind}.
export type CreateKind =
  | 'service_request' | 'work_order' | 'outside_work' | 'purchase_order'
  | 'parts_request' | 'customer' | 'employee' | 'equipment' | 'location'
  | 'part' | 'vendor'

// Filtro de la lista de Work Orders (KPIs de Home, búsqueda).
export interface WoFilterIntent {
  status?: string | string[]
  wo_type?: 'inside' | 'outside'
  waiting_parts?: boolean
  // Rangos YYYY-MM-DD (TZ de la org): fecha de cierre / fecha efectiva.
  closed_from?: string
  closed_to?: string
  worked_from?: string
  worked_to?: string
  // Incluir las facturadas en la lista (los KPIs de Home las cuentan).
  include_invoiced?: boolean
  [k: string]: unknown
}

// Contrato v2.22: {wo:id} | {unit} | {customer:id} | {vendor:id} |
// {technician:id} | {filter:{…}} | {create:kind}. Campos extra (part, po, sr,
// driver, tab…) los usan páginas puntuales; el backend de /api/search puede
// mandar cualquiera de estos objetos tal cual.
export interface NavIntent {
  wo?: number
  unit?: string
  customer?: number
  vendor?: number
  technician?: number
  part?: number
  po?: number
  sr?: number
  driver?: string
  location?: string
  tab?: string
  filter?: WoFilterIntent
  create?: CreateKind
  [k: string]: unknown
}

// Lo que devuelve un alta (para navegar al registro nuevo).
export interface CreatedRecord {
  kind: CreateKind
  id?: number | string
  label?: string
}

export interface CreateOpts {
  // Unidad sugerida (alta de Service Request / WO desde un contexto).
  unit?: string
  // Callback extra además de la navegación por defecto.
  onCreated?: (r: CreatedRecord) => void
  // false = no navegar a la sección del registro creado (quick-add inline).
  navigate?: boolean
}

export type ThemePref = 'light' | 'dark' | 'system'

// Modificador del atajo del palette según la plataforma (⌘ en Mac).
export const IS_MAC = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)
export const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl'

export interface ShellApi {
  section: string
  navigate: (section: string, intent?: NavIntent) => void
  openCreate: (kind: CreateKind, opts?: CreateOpts) => void
  openSearch: () => void
}

export const ShellContext = createContext<ShellApi>({
  section: 'dashboard',
  navigate: () => {},
  openCreate: () => {},
  openSearch: () => {},
})

export const useShell = () => useContext(ShellContext)

// Normaliza un intent que llega del backend (/api/search) — Record<string,
// unknown> — a NavIntent: ids numéricos como number y strings como string.
export function toIntent(raw: Record<string, unknown> | null | undefined):
  NavIntent | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: NavIntent = {}
  for (const [k, v] of Object.entries(raw)) {
    if (['wo', 'customer', 'vendor', 'technician', 'part', 'po', 'sr']
      .includes(k)) {
      const n = typeof v === 'number' ? v : Number(v)
      if (Number.isFinite(n)) out[k] = n
    } else {
      out[k] = v
    }
  }
  return out
}

// Iniciales para avatares ("Adrian Ramirez" → "AR").
export function initialsOf(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2)
    .map((w) => w[0] ?? '').join('').toUpperCase() || 'U'
}
