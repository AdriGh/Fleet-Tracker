// Mapeo de categorías de defecto (prefijo antes de " - " en el detalle del DVIR)
// a zonas físicas del camión, para colorear el diagrama y agrupar la lista.

export type ZoneId =
  | 'engine'
  | 'glass'
  | 'lightsFront'
  | 'lightsRear'
  | 'cab'
  | 'tires'
  | 'brakes'
  | 'suspension'
  | 'trailer'

export interface Zone {
  id: ZoneId
  label: string
}

export const ZONES: Zone[] = [
  { id: 'engine', label: 'Motor' },
  { id: 'glass', label: 'Parabrisas / espejos' },
  { id: 'lightsFront', label: 'Luces delanteras' },
  { id: 'lightsRear', label: 'Luces traseras' },
  { id: 'cab', label: 'Cabina / puertas' },
  { id: 'tires', label: 'Neumáticos / llantas' },
  { id: 'brakes', label: 'Frenos' },
  { id: 'suspension', label: 'Suspensión' },
  { id: 'trailer', label: 'Tráiler / tren de rodaje' },
]

export const ZONE_LABEL: Record<ZoneId, string> = ZONES.reduce(
  (acc, z) => ((acc[z.id] = z.label), acc),
  {} as Record<ZoneId, string>,
)

// Categoría exacta (como aparece en el DVIR) → zona del camión.
const CATEGORY_ZONE: Record<string, ZoneId> = {
  Engine: 'engine',
  'Oil Pressure': 'engine',
  'Fluid Levels': 'engine',
  Exhaust: 'engine',
  Transmission: 'engine',

  'Windshield Clean, Intact': 'glass',
  'Windshield Wipers': 'glass',
  'Windshield Wiper Fluid': 'glass',
  Windows: 'glass',
  Mirrors: 'glass',

  'Lights, Front': 'lightsFront',
  Lights: 'lightsFront',

  'Lights, Rear': 'lightsRear',
  Reflectors: 'lightsRear',

  Doors: 'cab',
  'Air Conditioner': 'cab',

  Tires: 'tires',
  'Wheels Rims': 'tires',
  'Tire Chains': 'tires',

  Brakes: 'brakes',
  'Brake Connections': 'brakes',
  'Air Lines': 'brakes',

  Suspension: 'suspension',

  'Landing Gear': 'trailer',
  'Rear End': 'trailer',
}

export function zoneOfCategory(cat: string): ZoneId | null {
  return CATEGORY_ZONE[cat] ?? null
}
