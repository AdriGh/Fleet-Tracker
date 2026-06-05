// Analiza el texto crudo que el driver escribió en el DVIR y propone una
// descripción profesional: expande códigos de posición (LFO, RFI…), deduce la
// ubicación, asigna una severidad y sugiere una acción. Es heurístico
// (reglas), no IA — pensado para correr local sin dependencias.

import type { ZoneId, Kind } from './truckZones'

export type Severity = 'critical' | 'major' | 'minor'

export interface AnalyzedDefect {
  category: string
  location: string        // posiciones/lado expandidos ('' si no hay)
  driverNote: string      // lo que escribió el driver, textual
  description: string     // descripción profesional propuesta
  recommendation: string  // acción sugerida
  severity: Severity
  count: number
  zone: ZoneId | null
}

// Códigos de posición de neumáticos/ejes → texto legible (neutro para camión
// y trailer; el inner/outer aplica a ruedas duales).
const POS: Record<string, string> = {
  LF: 'left front (LF)',
  RF: 'right front (RF)',
  LR: 'left rear (LR)',
  RR: 'right rear (RR)',
  LFO: 'left-front outer (LFO)',
  LFI: 'left-front inner (LFI)',
  RFO: 'right-front outer (RFO)',
  RFI: 'right-front inner (RFI)',
  LRO: 'left-rear outer (LRO)',
  LRI: 'left-rear inner (LRI)',
  RRO: 'right-rear outer (RRO)',
  RRI: 'right-rear inner (RRI)',
}
// Más largos primero para que "LFO" gane sobre "LF".
const POS_RE = /\b(LFO|LFI|RFO|RFI|LRO|LRI|RRO|RRI|LR|RR|LF|RF)\b/g

interface CatMeta { lead: string; rec: string }
const CAT: Record<string, CatMeta> = {
  Tires: { lead: 'Tire condition', rec: 'Inspect tread depth and pressure; replace any unserviceable tire before dispatch.' },
  'Tire Chains': { lead: 'Tire chains', rec: 'Provide or repair tire chains as required for conditions.' },
  Brakes: { lead: 'Braking system', rec: 'Have brakes inspected and adjusted before the next trip.' },
  'Brake Connections': { lead: 'Brake air lines / connections', rec: 'Repair or secure brake air lines and check for leaks.' },
  'Air Lines': { lead: 'Air lines', rec: 'Repair or secure air lines and check for leaks.' },
  Suspension: { lead: 'Suspension', rec: 'Inspect air bags/springs for leaks or damage and repair.' },
  Lights: { lead: 'Lighting', rec: 'Replace bulb/lens to restore required lighting.' },
  'Lights, Front': { lead: 'Front lighting', rec: 'Replace front bulb/lens to restore visibility.' },
  'Lights, Rear': { lead: 'Rear lighting', rec: 'Replace rear bulb/lens to restore visibility.' },
  Reflectors: { lead: 'Reflectors / conspicuity tape', rec: 'Replace damaged or missing reflective tape.' },
  Doors: { lead: 'Door / latch', rec: 'Repair the latch/lock and secure the door.' },
  'Landing Gear': { lead: 'Landing gear', rec: 'Repair/grease the landing gear; ensure it cranks and supports the load.' },
  'Coupling Devices': { lead: 'Coupling / kingpin', rec: 'Inspect the kingpin/coupling for a secure connection.' },
  'Windshield Clean, Intact': { lead: 'Windshield', rec: 'Repair or replace the glass to restore clear visibility.' },
  'Windshield Wipers': { lead: 'Wipers', rec: 'Replace wiper blades or repair the wiper system.' },
  'Windshield Wiper Fluid': { lead: 'Washer system', rec: 'Repair the washer pump and refill fluid.' },
  Windows: { lead: 'Windows', rec: 'Repair or replace the window.' },
  Mirrors: { lead: 'Mirrors', rec: 'Replace or adjust the mirror to restore visibility.' },
  Engine: { lead: 'Engine', rec: 'Have the engine inspected by maintenance.' },
  'Oil Pressure': { lead: 'Oil pressure', rec: 'Check oil level/pressure; have it inspected.' },
  'Fluid Levels': { lead: 'Fluid levels', rec: 'Top up and check for leaks.' },
  Transmission: { lead: 'Transmission', rec: 'Have the transmission inspected by maintenance.' },
  Exhaust: { lead: 'Exhaust', rec: 'Repair the exhaust leak or mounting.' },
  Roof: { lead: 'Roof / body', rec: 'Repair the roof/body panel to prevent water ingress.' },
  Other: { lead: 'General defect', rec: 'Inspect and address as required; document the resolution.' },
}
const DEFAULT_META: CatMeta = {
  lead: 'Defect', rec: 'Inspect and address as required; document the resolution.',
}

const CRITICAL_RE =
  /\bflat\b|blown|separation|no brakes|brake[^.]*\b(to|too)\s+low\b|out of service|cracking|crack(ed)?\b|fell off|missing\s+(brake|lug|wheel|bolt)|\bbald\b|air bag[^.]*leak/i
const MAJOR_RE =
  /\bout\b|missing|broken|leak|low tread|worn|damage|inoperative|not work|loose|hanging|frayed|expired|bolt in/i

function severityOf(note: string): Severity {
  if (CRITICAL_RE.test(note)) return 'critical'
  if (MAJOR_RE.test(note)) return 'major'
  return 'minor'
}

function locationOf(note: string): string {
  const out: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  POS_RE.lastIndex = 0
  while ((m = POS_RE.exec(note))) {
    const c = m[1].toUpperCase()
    if (!seen.has(c)) { seen.add(c); out.push(POS[c]) }
  }
  if (out.length === 0) {
    if (/driver\s*side/i.test(note)) out.push('driver (left) side')
    if (/passenger\s*side/i.test(note)) out.push('passenger (right) side')
    if (out.length === 0 && /\bleft\b/i.test(note)) out.push('left side')
    if (out.length === 0 && /\bright\b/i.test(note)) out.push('right side')
  }
  return out.join(' and ')
}

function cleanNote(s: string): string {
  let t = (s || '').trim()
  if (!t || /^(idk|n\/?a|none)$/i.test(t)) {
    return 'No description provided by the driver'
  }
  t = t
    .replace(/\btrlr\b|\btrl\b/gi, 'trailer')
    .replace(/\bw\/?o\b/gi, 'without')
    .replace(/\bpsi\b/gi, 'PSI')
    .replace(/\b4\s*way\b/gi, 'four-way')
    .replace(/\bdot\b/gi, 'DOT')
    .replace(/\s+/g, ' ')
    .trim()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

function describe(
  category: string, note: string, location: string, severity: Severity,
): string {
  const meta = CAT[category] ?? DEFAULT_META
  const clean = cleanNote(note)
  const loc = location ? ` at the ${location}` : ''
  const tail = /[.!?]$/.test(clean) ? '' : '.'
  const sev =
    severity === 'critical' ? 'Likely out-of-service condition — address immediately.'
      : severity === 'major' ? 'Requires repair before the unit returns to service.'
        : 'Minor issue — schedule for routine maintenance.'
  return `${meta.lead} issue${loc}. ${clean}${tail} ${sev}`
}

export interface RawGroup {
  category: string
  body: string
  count: number
  zone: ZoneId | null
}

export function analyzeGroup(g: RawGroup, _kind: Kind): AnalyzedDefect {
  const note = g.body || g.category
  const location = locationOf(note)
  const severity = severityOf(note)
  const meta = CAT[g.category] ?? DEFAULT_META
  return {
    category: g.category,
    location,
    driverNote: g.body || '(no comment)',
    description: describe(g.category, note, location, severity),
    recommendation: meta.rec,
    severity,
    count: g.count,
    zone: g.zone,
  }
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  major: 'Major',
  minor: 'Minor',
}

const SEV_RANK: Record<Severity, number> = { minor: 1, major: 2, critical: 3 }

// --- Agrupación por categoría (para el PDF) ---------------------------------
// Junta todos los defectos de una misma categoría en un bloque: severidad
// máxima, ubicaciones combinadas, y la lista de notas distintas del driver.
export interface CategoryGroup {
  category: string
  severity: Severity
  totalReports: number
  zone: ZoneId | null
  location: string
  notes: { text: string; count: number }[]
  assessment: string
  recommendation: string
}

function categoryAssessment(category: string, severity: Severity): string {
  const meta = CAT[category] ?? DEFAULT_META
  const sev = severity === 'critical'
    ? 'likely out-of-service — address immediately'
    : severity === 'major'
      ? 'requires repair before the unit returns to service'
      : 'minor — schedule for routine maintenance'
  return `${meta.lead}: ${sev}.`
}

export function groupByCategory(list: AnalyzedDefect[]): CategoryGroup[] {
  const map = new Map<string, CategoryGroup>()
  for (const a of list) {
    let g = map.get(a.category)
    if (!g) {
      g = {
        category: a.category, severity: a.severity, totalReports: 0,
        zone: a.zone, location: '', notes: [], assessment: '',
        recommendation: a.recommendation,
      }
      map.set(a.category, g)
    }
    g.totalReports += a.count
    g.notes.push({ text: a.driverNote, count: a.count })
    if (SEV_RANK[a.severity] > SEV_RANK[g.severity]) g.severity = a.severity
    if (!g.zone) g.zone = a.zone
    if (a.location) {
      const set = new Set(g.location ? g.location.split(' · ') : [])
      set.add(a.location)
      g.location = [...set].join(' · ')
    }
  }
  const out = [...map.values()]
  for (const g of out) {
    g.assessment = categoryAssessment(g.category, g.severity)
    g.notes.sort((x, y) => y.count - x.count)
  }
  out.sort((a, b) =>
    SEV_RANK[b.severity] - SEV_RANK[a.severity] ||
    b.totalReports - a.totalReports ||
    a.category.localeCompare(b.category))
  return out
}
