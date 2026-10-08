// Helpers de vendors (v2.21, outside work). Módulo sin componentes para que
// VendorPicker, PartsPage y el badge de la WO compartan etiquetas sin
// disparar el warning de react-refresh por exports mixtos.
import type { VendorKind } from './api'

export const VENDOR_KIND_LABEL: Record<VendorKind, string> = {
  '': '',
  parts: 'Parts supplier',
  shop: 'Service shop',
  both: 'Parts & service',
}

// Etiqueta corta para chips (listas, picker).
export const VENDOR_KIND_SHORT: Record<VendorKind, string> = {
  '': '',
  parts: 'Parts',
  shop: 'Shop',
  both: 'Both',
}

export const VENDOR_KIND_OPTS: { key: VendorKind; label: string }[] = [
  { key: '', label: 'Not set' },
  { key: 'parts', label: VENDOR_KIND_LABEL.parts },
  { key: 'shop', label: VENDOR_KIND_LABEL.shop },
  { key: 'both', label: VENDOR_KIND_LABEL.both },
]

// "Memphis, TN" / "Memphis" / "TN" / "".
export function vendorLoc(v: { city?: string | null; state?: string | null }): string {
  return [v.city?.trim(), v.state?.trim()].filter(Boolean).join(', ')
}

// "Love's Truck Care — Memphis, TN" (para chips de "Create vendor…").
export function vendorLabel(v: {
  name: string; city?: string | null; state?: string | null
}): string {
  const loc = vendorLoc(v)
  return loc ? `${v.name} — ${loc}` : v.name
}
