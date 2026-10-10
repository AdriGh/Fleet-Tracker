// Ubicaciones (v2.22 [C]): las terminales de Settings como recurso, con
// tipo (taller / yard / terminal), código y dirección.
import type { LocationType } from './api'

export const LOCATION_TYPE_LABEL: Record<Exclude<LocationType, ''>, string> = {
  shop: 'Shop',
  yard: 'Yard',
  terminal: 'Terminal',
}

export const locationTypeLabel = (t?: LocationType) =>
  (t ? LOCATION_TYPE_LABEL[t] : '') || 'Terminal'
