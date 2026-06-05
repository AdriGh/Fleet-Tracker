// Mapeo de categorías de defecto (prefijo antes de " - " en el detalle del DVIR)
// a zonas físicas, según el tipo de unidad (camión / tráiler). El tractor y el
// tráiler tienen zonas distintas: un tráiler no tiene motor ni parabrisas, y
// sus "Doors" son las puertas traseras de carga, no la cabina.

export type Kind = 'truck' | 'trailer'

export type TruckZoneId =
  | 'engine'
  | 'glass'
  | 'lightsFront'
  | 'lightsRear'
  | 'cab'
  | 'tires'
  | 'brakes'
  | 'suspension'

export type TrailerZoneId =
  | 'body'
  | 'doors'
  | 'lights'
  | 'tires'
  | 'brakes'
  | 'suspension'
  | 'landingGear'

export type ZoneId = TruckZoneId | TrailerZoneId

export const ZONE_LABEL: Record<ZoneId, string> = {
  engine: 'Engine',
  glass: 'Windshield / mirrors',
  lightsFront: 'Front lights',
  lightsRear: 'Rear lights',
  cab: 'Cab / doors',
  tires: 'Tires / wheels',
  brakes: 'Brakes',
  suspension: 'Suspension',
  body: 'Box',
  doors: 'Rear doors',
  lights: 'Lights',
  landingGear: 'Landing gear',
}

export const TRUCK_ZONES: { id: TruckZoneId; label: string }[] = [
  'engine', 'glass', 'lightsFront', 'lightsRear',
  'cab', 'tires', 'brakes', 'suspension',
].map((id) => ({ id: id as TruckZoneId, label: ZONE_LABEL[id as ZoneId] }))

export const TRAILER_ZONES: { id: TrailerZoneId; label: string }[] = [
  'body', 'doors', 'lights', 'tires', 'brakes', 'suspension', 'landingGear',
].map((id) => ({ id: id as TrailerZoneId, label: ZONE_LABEL[id as ZoneId] }))

// Mapeo común para ambos tipos.
const SHARED: Record<string, ZoneId> = {
  Tires: 'tires',
  'Wheels Rims': 'tires',
  'Tire Chains': 'tires',
  Brakes: 'brakes',
  'Brake Connections': 'brakes',
  'Air Lines': 'brakes',
  Suspension: 'suspension',
}

const TRUCK_MAP: Record<string, ZoneId> = {
  ...SHARED,
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
}

const TRAILER_MAP: Record<string, ZoneId> = {
  ...SHARED,
  Doors: 'doors', // puertas traseras de carga
  'Landing Gear': 'landingGear',
  'Coupling Devices': 'landingGear', // kingpin / acople, en el frente bajo
  'Rear End': 'body',
  Roof: 'body',
  // El tráiler solo tiene luces traseras / de posición.
  Lights: 'lights',
  'Lights, Front': 'lights',
  'Lights, Rear': 'lights',
  Reflectors: 'lights',
}

export function zoneOfCategory(cat: string, kind: Kind): ZoneId | null {
  const map = kind === 'trailer' ? TRAILER_MAP : TRUCK_MAP
  return map[cat] ?? null
}
