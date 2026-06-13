// Cliente de la API del backend FastAPI.

export type ReportRow = Record<string, string | boolean> & {
  is_nodvir: boolean
}

export interface ReportGroup {
  truck_merge: boolean
  rows: ReportRow[]
}

// --- Token + fetch autenticado (fase G7) --------------------------------
const TOKEN_KEY = 'ft-token'
export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? ''
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t)
export const clearToken = () => localStorage.removeItem(TOKEN_KEY)

// Shadow del fetch global SOLO en este módulo: toda llamada a la API
// lleva Authorization, y un 401 limpia el token y avisa a App para
// volver al login (evento 'ft-unauthorized').
async function fetch(input: RequestInfo | URL,
                     init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  const tok = getToken()
  if (tok && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${tok}`)
  }
  const res = await window.fetch(input, { ...init, headers })
  if (res.status === 401 && tok) {
    clearToken()
    window.dispatchEvent(new Event('ft-unauthorized'))
  }
  return res
}

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json()
    if (typeof data?.detail === 'string') return data.detail
    if (Array.isArray(data?.detail)) {
      return data.detail.map((d: { msg?: string }) => d.msg).join('; ')
    }
  } catch {
    /* respuesta no-JSON */
  }
  return `Error ${res.status}`
}

export async function getHealth(): Promise<{ status: string; version: string }> {
  const res = await fetch('/api/health')
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export function downloadUrl(reportId: string): string {
  return `/api/reports/${reportId}/download`
}

export function downloadBlockUrl(blockId: number): string {
  return `/api/dvir/blocks/${blockId}/download`
}

// --- Lote (Crear DVIR Report) -----------------------------------------

export interface BatchFile {
  file_id: string
  name: string
  kind: string
  company: string
  error: string | null
}

export interface BatchBlock {
  company: string
  date_label: string
  month: number | null
  dvir_file_id: string
  dvir_name: string
  activity_file_id: string
  activity_name: string
  pretrip_file_id: string
  pretrip_name: string
  status: string
}

export interface BatchAnalyzeResponse {
  batch_id: string
  blocks: BatchBlock[]
  files: BatchFile[]
  warnings: string[]
}

export interface BatchBlockInput {
  company: string
  date_label: string
  dvir_file_id: string
  activity_file_id: string
  pretrip_file_id: string
}

export interface BatchSheetStat {
  company: string
  sheet_name: string
  blocks: number
  drivers: number
  no_dvir: number
}

export interface BatchGenerateResponse {
  id: string
  filename: string
  sheets: BatchSheetStat[]
  warnings: string[]
}

export async function analyzeBatch(
  files: File[],
): Promise<BatchAnalyzeResponse> {
  const fd = new FormData()
  for (const f of files) fd.append('files', f)
  const res = await fetch('/api/batch/analyze', { method: 'POST', body: fd })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function generateBatch(
  batchId: string,
  blocks: BatchBlockInput[],
): Promise<BatchGenerateResponse> {
  const res = await fetch('/api/batch/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batch_id: batchId, blocks }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// --- Panel DVIR -------------------------------------------------------

export interface RecentBlock {
  id: number
  company: string
  date_label: string
  block_date: string
  created_at: string
  n_reports: number
  n_no_dvir: number
  n_unsafe: number
  fleet_safe_pct: number
}

export interface MissingDriver {
  driver: string
  misses: number
}

export interface MissingResponse {
  month: string | null
  drivers: MissingDriver[]
}

export interface BlockDetail {
  id: number
  company: string
  date_label: string
  fleet_safe_pct: number
  columns: string[]
  groups: ReportGroup[]
}

export type RecentSort =
  | 'created_at'
  | 'n_reports'
  | 'n_no_dvir'
  | 'n_unsafe'
  | 'fleet_safe_pct'

export async function recentBlocks(
  sort: RecentSort = 'created_at',
  limit = 10,
): Promise<RecentBlock[]> {
  const res = await fetch(`/api/dvir/recent?sort=${sort}&limit=${limit}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function missingDrivers(): Promise<MissingResponse> {
  const res = await fetch('/api/dvir/missing')
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export interface MonthSummary {
  month: string | null
  fleet_safe_pct: number | null
  n_blocks: number
}

export async function monthSummary(): Promise<MonthSummary> {
  const res = await fetch('/api/dvir/summary')
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function getBlock(id: number): Promise<BlockDetail> {
  const res = await fetch(`/api/dvir/blocks/${id}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// --- Defectos ---------------------------------------------------------

export interface Defect {
  date_label: string
  block_date: string
  company: string
  driver: string
  unit: string
  unit_kind: string
  dvir_type: string
  status: string
  detail: string
  // Cuántas veces se reportó este defecto (re-reportes deduplicados). 1 si no aplica.
  reports?: number
  mechanic: string
  mechanic_notes: string
}

export async function listDefects(filters: {
  company?: string
  status?: string
  unit?: string
}): Promise<Defect[]> {
  const qs = new URLSearchParams()
  if (filters.company) qs.set('company', filters.company)
  if (filters.status) qs.set('status', filters.status)
  if (filters.unit) qs.set('unit', filters.unit)
  const res = await fetch(`/api/dvir/defects?${qs}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// Defectos ABIERTOS (Samsara en vivo + CSV de empresas fuera del org). Misma
// forma que Defect, con status = "Open". Alimenta la tabla "Summary by unit".
export async function listOpenDefects(): Promise<Defect[]> {
  const res = await fetch('/api/dvir/open-defects')
  if (!res.ok) throw new Error(await readError(res))
  const data = await res.json()
  return (data.defects ?? []) as Defect[]
}

// Estadísticas de defectos (abiertos + resueltos) creados en los últimos
// `days` días, para el dashboard. status = "Unsafe" (abierto) / "Resolved".
export async function listDefectStats(days: number): Promise<Defect[]> {
  const res = await fetch(`/api/dvir/defect-stats?days=${days}`)
  if (!res.ok) throw new Error(await readError(res))
  const data = await res.json()
  return (data.defects ?? []) as Defect[]
}

// --- Flota (inventario de unidades desde Samsara) ---------------------
export interface FleetUnit {
  id: string            // id único del asset en Samsara
  unit: string
  kind: string          // truck | trailer
  unit_type: string     // truck | trailer | chassis
  asset_type: string    // vehicle | trailer | unpowered
  company: string
  make: string
  model: string
  year: number | string
  vin: string
  plate: string
  open_defects: number
  last_dvir: string | null
  archived: boolean
  archive_reason: string | null   // manual | auto | null
}

export async function listFleet(): Promise<FleetUnit[]> {
  const res = await fetch('/api/fleet')
  if (!res.ok) throw new Error(await readError(res))
  const data = await res.json()
  return (data.units ?? []) as FleetUnit[]
}

export async function fleetArchive(id: string, action: string): Promise<void> {
  const res = await fetch('/api/fleet/archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, action }),
  })
  if (!res.ok) throw new Error(await readError(res))
}

// --- Configuración de la app (Settings) -------------------------------
export interface AppSettings {
  auto_archive_enabled: boolean
  auto_archive_days: number
}

export async function getSettings(): Promise<AppSettings> {
  const res = await fetch('/api/settings')
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as AppSettings
}

export async function saveSettings(s: AppSettings): Promise<AppSettings> {
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(s),
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as AppSettings
}

// --- Terminales dinámicas (Settings → Terminals) -----------------------
export interface TerminalDef {
  key: string
  label: string
  prefixes: string[]
}

export interface TerminalsConfig {
  terminals: TerminalDef[]
  assignments: Record<string, string>   // unidad → key de terminal
}

export async function listTerminals(): Promise<TerminalsConfig> {
  const res = await fetch('/api/terminals')
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as TerminalsConfig
}

export async function saveTerminal(t: {
  key?: string; label: string; prefixes: string[]
}): Promise<TerminalsConfig> {
  const res = await fetch('/api/terminals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: t.key ?? '', label: t.label,
      prefixes: t.prefixes }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as TerminalsConfig
}

export async function deleteTerminal(key: string): Promise<TerminalsConfig> {
  const res = await fetch(`/api/terminals/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as TerminalsConfig
}

export async function assignTerminal(
  terminal: string, units: string[],
): Promise<TerminalsConfig> {
  const res = await fetch('/api/terminals/assign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ terminal, units }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as TerminalsConfig
}

// --- Live Map (tracking en vivo, fase G1) -------------------------------
export interface TrackVehicle {
  id: string
  unit: string
  company: string
  lat: number
  lng: number
  heading: number | null
  speed_mph: number
  stale: boolean           // GPS sin reportar >15 min
  location: string
  gps_time: string
  engine: string            // On | Off | Idle | ''
  fuel_pct: number | null
  def_pct: number | null
  odometer_mi: number | null
  driver: string
  duty: string              // driving | onDuty | sleeperBed | offDuty | ...
  moving_for_s: number | null
}

export interface TrackSummary {
  drivers: number
  vehicles: number
  moving: number
  unknown: number
  driving: number
  onDuty: number
  sleeperBed: number
  offDuty: number
  yardMove: number
  personalConveyance: number
}

export interface TrackResponse {
  available: boolean
  missing_scopes: string[]
  error: string
  hos_available: boolean
  generated_at: string
  vehicles: TrackVehicle[]
  summary: TrackSummary
}

export async function getTrack(): Promise<TrackResponse> {
  const res = await fetch('/api/track')
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// --- POIs del mapa (talleres, dealers, básculas — fase G2) --------------
export type PoiKind = 'repair' | 'dealer_truck' | 'dealer_trailer' | 'scale'

export interface Poi {
  id: string
  kind: PoiKind
  subtype: string        // 'enforcement' en básculas DOT
  name: string
  lat: number
  lng: number
  address: string
  phone: string
  brand: string
  source: string
}

export async function listPois(): Promise<{ attribution: string; pois: Poi[] }> {
  const res = await fetch('/api/pois')
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// --- Auth (fase G7) -------------------------------------------------------
export interface AuthUser {
  id: number
  username: string
  name: string
  role: string             // admin | dispatcher | mechanic | viewer
}

export interface OrgBranding {
  app_name: string
  tagline: string
  accent: string           // '' = rojo de fábrica
}

export interface AuthStatus {
  setup_needed: boolean
  authenticated: boolean
  user: AuthUser | null
  branding: OrgBranding
}

export async function authStatus(): Promise<AuthStatus> {
  const res = await fetch('/api/auth/status')
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function authLogin(
  username: string, password: string,
): Promise<{ token: string; user: AuthUser }> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function authSetup(
  name: string, username: string, password: string,
): Promise<{ token: string; user: AuthUser }> {
  const res = await fetch('/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, username, password }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export interface AppUser extends AuthUser {
  active: boolean
  created_at: string
}

export async function listAppUsers(): Promise<AppUser[]> {
  const res = await fetch('/api/auth/users')
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()).users as AppUser[]
}

export async function createAppUser(body: {
  name: string; username: string; password: string; role: string
}): Promise<AppUser> {
  const res = await fetch('/api/auth/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function patchAppUser(
  id: number,
  patch: { role?: string; active?: boolean; password?: string
           name?: string },
): Promise<AppUser> {
  const res = await fetch(`/api/auth/users/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// --- Configuración de empresa (fase G7) -----------------------------------
export interface ShopIdentity {
  name: string; address: string; city: string; state: string
  zip: string; phone: string; email: string
}

export interface BillingAddress {
  name?: string; address?: string; city?: string; state?: string
  zip?: string; phone?: string; email?: string
}

export interface InvoiceConfig {
  next_number: number; prefix: string; terms: string; footer: string
}

export interface OrgConfig {
  branding: OrgBranding
  thresholds: {
    dvir_min_minutes: number
    pm_interval_miles: number
    pm_upcoming_miles: number
    defect_lookback_days: number
  }
  labor_rate: number
  cc: Record<string, string[]>
  always_cc: string[]
  // H3-C: identidad del taller (From) + Bill-To por empresa + invoice.
  shop: ShopIdentity
  billing: Record<string, BillingAddress>
  invoice: InvoiceConfig
}

export async function getOrg(): Promise<OrgConfig> {
  const res = await fetch('/api/org')
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function saveOrg(
  partial: Partial<OrgConfig>,
): Promise<OrgConfig> {
  const res = await fetch('/api/org', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(partial),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// --- TMS: Drivers & Loads (fase G-TMS, referencia QuickManage) -----------
export interface TmsDriverRow {
  name: string
  company: string
  phone: string
  email: string
  license_number: string
  license_state: string
  has_profile: boolean
  driver_company: string
  role: string            // owner_operator | company_driver | lease_operator
  pay_type: string        // percentage | flat | mileage | hourly
  pay_pct: number
  truck: string
  trailer: string
  hired_date: string
  emergency_name: string
  emergency_phone: string
  cdl_exp: string
  med_exp: string
  mvr_exp: string
  chouse_exp: string
  notes: string
}

export async function listTmsDrivers(): Promise<TmsDriverRow[]> {
  const res = await fetch('/api/tms/drivers')
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()).drivers as TmsDriverRow[]
}

export async function saveTmsDriver(
  body: Partial<TmsDriverRow> & { name: string },
): Promise<Partial<TmsDriverRow>> {
  const res = await fetch('/api/tms/drivers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export type LoadStatus =
  | 'upcoming' | 'dispatched' | 'in_transit'
  | 'delivered' | 'invoiced' | 'closed'

export interface LoadStop {
  id: number
  seq: number
  kind: 'pickup' | 'delivery'
  name: string
  city: string
  state: string
  appt: string
}

export interface Load {
  id: number
  created_at: string
  updated_at: string
  status: LoadStatus
  broker: string
  ref: string
  driver: string
  unit: string
  hauling_rate: number
  accessorials: number
  pay_pct: number
  miles: number | null
  rate_per_mile: number | null
  tags: string[]
  docs: { rc: boolean; bol: boolean; pod: boolean }
  notes: string
  total: number
  payout: number
  n_stops: number
  origin: LoadStop | null
  destination: LoadStop | null
  stops?: LoadStop[]
}

export interface LoadStats {
  active: number
  in_transit: number
  delivered_30d: number
  revenue_30d: number
}

export async function listLoads(
  status = '', driver = '',
): Promise<{ loads: Load[]; stats: LoadStats }> {
  const qs = new URLSearchParams()
  if (status) qs.set('status', status)
  if (driver) qs.set('driver', driver)
  const res = await fetch(`/api/tms/loads?${qs}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function createLoad(body: {
  broker: string; ref?: string; driver?: string; unit?: string
  hauling_rate?: number; accessorials?: number; pay_pct?: number
  miles?: number | null
  stops?: { kind: string; name: string; city: string; state: string
            appt: string }[]
}): Promise<Load> {
  const res = await fetch('/api/tms/loads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function getLoad(id: number): Promise<Load> {
  const res = await fetch(`/api/tms/loads/${id}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function patchLoad(
  id: number, patch: Record<string, unknown>,
): Promise<Load> {
  const res = await fetch(`/api/tms/loads/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// --- Work Orders (fase G5 — reemplazo de Fullbay) ------------------------
export type WoStatus =
  'open' | 'assigned' | 'in_progress' | 'completed' | 'invoiced'
export type WoPriority = 'low' | 'normal' | 'high'

export interface WoLine {
  id: number
  kind: 'part' | 'labor'
  description: string
  part_number?: string
  qty: number
  unit_cost: number
  total: number
}

export interface WorkOrder {
  id: number
  created_at: string
  updated_at: string
  closed_at: string | null
  unit: string
  company: string
  status: WoStatus
  priority: WoPriority
  title: string
  complaint: string
  mechanic: string
  notes: string
  is_pm: boolean
  pm_miles: number | null
  campaign: string
  mileage: number | null
  service_date: string | null
  waiting_parts: boolean
  invoiced_at: string | null
  source: string
  // H3-C: datos del estimate/invoice imprimible.
  invoice_number: string
  po_number: string
  authorizer: string
  shop_invoice: string        // nº de invoice del TALLER externo (del escaneo)
  total: number
  n_lines: number
  lines?: WoLine[]
  // Presente solo si el PATCH disparo una notificacion de Telegram.
  telegram?: { sent: boolean; simulated?: boolean; detail?: string }
}

export interface WoStats {
  open: number
  assigned: number
  in_progress: number
  completed: number
  invoiced: number
  waiting_parts: number
  completed_30d: number
  cost_30d: number
}

export async function listWorkOrders(
  status = '', unit = '',
): Promise<{ workorders: WorkOrder[]; stats: WoStats; mechanics: string[] }> {
  const qs = new URLSearchParams()
  if (status) qs.set('status', status)
  if (unit) qs.set('unit', unit)
  const res = await fetch(`/api/workorders?${qs}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function deleteWorkOrder(id: number): Promise<void> {
  const res = await fetch(`/api/workorders/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res))
}

// --- Perfil de unidad (fase H3) ----------------------------------------
export interface UnitCampaign {
  key: string
  label: string
  due: 'miles' | 'days' | 'none'
  default: boolean
  last_date: string | null
  last_miles: number | null
  next_due_miles?: number | null
  next_due_date?: string | null
  to_due: number | null
  status: string
  records: { id: number; date: string; mileage: number | null
             notes: string }[]
}

export interface UnitCampaignsResult {
  unit: string
  model: string
  current_miles: number | null
  current_source: string | null
  campaigns: UnitCampaign[]
  available: { key: string; label: string }[]
}

export async function getUnitCampaigns(
  unit: string, model = '',
): Promise<UnitCampaignsResult> {
  const qs = model ? `?model=${encodeURIComponent(model)}` : ''
  const res = await fetch(
    `/api/units/${encodeURIComponent(unit)}/campaigns${qs}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function toggleUnitCampaign(
  unit: string, key: string, enabled: boolean,
): Promise<void> {
  const res = await fetch(
    `/api/units/${encodeURIComponent(unit)}/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, enabled }),
    })
  if (!res.ok) throw new Error(await readError(res))
}

export interface UnitDoc {
  id: number
  unit: string
  kind: string
  kind_label: string
  filename: string
  size: number
  note: string
  uploaded_at: string
}

export async function listUnitDocs(unit: string): Promise<{
  docs: UnitDoc[]
  kinds: { key: string; label: string }[]
}> {
  const res = await fetch(`/api/units/${encodeURIComponent(unit)}/docs`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function uploadUnitDocs(
  unit: string, kind: string, files: File[],
): Promise<{ saved: UnitDoc[]; errors: string[] }> {
  const fd = new FormData()
  for (const f of files) fd.append('files', f)
  const res = await fetch(
    `/api/units/${encodeURIComponent(unit)}/docs?kind=${encodeURIComponent(kind)}`,
    { method: 'POST', body: fd })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function deleteUnitDoc(id: number): Promise<void> {
  const res = await fetch(`/api/units/docs/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res))
}

// Descarga autenticada: un <a href> directo no llevaría el Bearer token
// (el middleware lo exige), así que se baja por fetch y blob.
export async function downloadUnitDoc(
  id: number, filename: string,
): Promise<void> {
  const res = await fetch(`/api/units/docs/${id}/download`)
  if (!res.ok) throw new Error(await readError(res))
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// --- Escáner AI de documentos (fase H2.5) ------------------------------
export interface WoScanLine {
  kind: 'part' | 'labor'
  description: string
  qty: number
  unit_cost: number
  part_number?: string
}

export interface WoScanComplaint {
  unit: string | null
  mileage: number | null
  detail: string
  is_pm: boolean
}

export interface WoScanExtract {
  service_date: string | null
  vendor: string | null
  vendor_city: string | null
  vendor_state: string | null
  invoice_number: string | null
  mechanic: string | null
  complaints: WoScanComplaint[]
  lines: WoScanLine[]
}

export async function scanWoDocument(file: File): Promise<{
  extract: WoScanExtract
  model: string
  tokens: { input: number; output: number }
}> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch('/api/workorders/scan', {
    method: 'POST',
    body: fd,
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function createWorkOrder(body: {
  unit: string; title: string; complaint?: string; company?: string
  mechanic?: string; priority?: WoPriority; is_pm?: boolean; source?: string
  mileage?: number | null; service_date?: string; campaign?: string
  shop_invoice?: string
}): Promise<WorkOrder> {
  const res = await fetch('/api/workorders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function getWorkOrder(id: number): Promise<WorkOrder> {
  const res = await fetch(`/api/workorders/${id}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function patchWorkOrder(
  id: number, patch: Partial<WorkOrder>,
): Promise<WorkOrder> {
  const res = await fetch(`/api/workorders/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function addWoLine(
  id: number,
  line: { kind: 'part' | 'labor'; description: string; qty: number
          unit_cost: number; part_number?: string },
): Promise<WorkOrder> {
  const res = await fetch(`/api/workorders/${id}/lines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(line),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function deleteWoLine(
  id: number, lineId: number,
): Promise<WorkOrder> {
  const res = await fetch(`/api/workorders/${id}/lines/${lineId}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// H3-C: enviar el estimate/invoice por email (real) y/o SMS. `unit_info`
// (VIN/año/marca/modelo) sale de la caché de /fleet para no pegarle a Samsara.
export interface WoSendResult {
  to: string
  ok: boolean
  simulated: boolean
  error: string
}

export interface WoSendResponse {
  channels: string[]
  email_dry_run: boolean
  sms_dry_run: boolean
  results: { email?: WoSendResult; sms?: WoSendResult }
}

export async function sendWoInvoice(
  id: number,
  body: {
    channels: NotifyChannel[]
    email?: string
    phone?: string
    unit_info?: Record<string, unknown>
  },
): Promise<WoSendResponse> {
  const res = await fetch(`/api/workorders/${id}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// --- Cold chain / reefers (fase G4) --------------------------------------
export interface ReeferAlarm {
  code: number | string
  description: string
  severity: number          // 1 ok-to-run · 2 check · 3 immediate
  operator_action: string
}

export interface ReeferUnit {
  id: string
  unit: string
  company: string
  setpoint_f: number | null
  return_f: number | null
  supply_f: number | null
  ambient_f: number | null
  run_mode: string
  state: string
  fuel_pct: number | null
  door: string
  alarms: ReeferAlarm[]
  updated: string
  demo: boolean
}

export interface ReeferResponse {
  available: boolean
  demo: boolean
  live_empty: boolean
  missing_scopes: string[]
  units: ReeferUnit[]
}

export interface ReeferPoint {
  time: string
  setpoint_f: number | null
  return_f: number | null
  supply_f: number | null
}

export async function getReefer(): Promise<ReeferResponse> {
  const res = await fetch('/api/reefer')
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function getReeferHistory(
  id: string, hours = 24,
): Promise<{ demo: boolean; points: ReeferPoint[] }> {
  const res = await fetch(
    `/api/reefer/history?id=${encodeURIComponent(id)}&hours=${hours}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// --- Alertas de flota (fase G3) -----------------------------------------
export interface AlertRule {
  enabled: boolean
  mph?: number
  minutes?: number
  pct?: number
  hours?: number
  deviation_f?: number
}

export interface AlertsSettings {
  rules: {
    speeding: AlertRule
    idle: AlertRule
    low_fuel: AlertRule
    low_def: AlertRule
    no_gps: AlertRule
    reefer_temp: AlertRule
  }
  channels: { email: boolean; sms: boolean }
  recipients: { emails: string[]; phones: string[] }
}

export interface AlertEvent {
  id: number
  ts: string
  unit: string
  company: string
  rule: string
  rule_label: string
  value: string
  message: string
  acked: boolean
}

export async function getAlertsSettings(): Promise<AlertsSettings> {
  const res = await fetch('/api/alerts/settings')
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function saveAlertsSettings(
  s: Partial<AlertsSettings>,
): Promise<AlertsSettings> {
  const res = await fetch('/api/alerts/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(s),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function listAlertEvents(
  limit = 50, unackedOnly = false,
): Promise<AlertEvent[]> {
  const res = await fetch(
    `/api/alerts/events?limit=${limit}&unacked=${unackedOnly ? 1 : 0}`)
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()).events as AlertEvent[]
}

export async function ackAlertEvents(ids?: number[]): Promise<number> {
  const res = await fetch('/api/alerts/ack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: ids ?? null }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()).acked
}

// --- Device settings por unidad (fase G3) -------------------------------
export interface UnitSettings {
  nickname: string
  group: string
  muted: boolean
  notes: string
}

export async function getUnitSettings(unit: string): Promise<UnitSettings> {
  const res = await fetch(`/api/units/settings?unit=${encodeURIComponent(unit)}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function saveUnitSettings(
  unit: string, s: UnitSettings,
): Promise<UnitSettings> {
  const res = await fetch('/api/units/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unit, ...s }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// --- Conectividad (hub de integraciones en Settings) -------------------
export type IntegrationStatus =
  | 'connected' | 'live' | 'dry_run' | 'not_configured'
  | 'available' | 'planned'

export interface IntegrationProvider {
  id: string
  name: string
  kind: string
  status: IntegrationStatus
  detail: string
  items: { label: string; value: string }[]
  testable: boolean
  configurable: boolean
}

export interface IntegrationField {
  key: string
  label: string
  kind: 'text' | 'password' | 'toggle'
  tail?: string
  value?: boolean
}

export interface IntegrationSpec {
  title: string
  help: string
  danger?: boolean
  fields?: IntegrationField[]
  orgs?: { company: string; token_tail: string; trailer_dvirs: boolean }[]
}

export async function getIntegrationSpecs(): Promise<Record<string, IntegrationSpec>> {
  const res = await fetch('/api/integrations/specs')
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function testIntegration(
  provider: string,
): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch('/api/integrations/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function saveIntegrationConfig(
  provider: string, values: Record<string, unknown>,
): Promise<void> {
  const res = await fetch('/api/integrations/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, values }),
  })
  if (!res.ok) throw new Error(await readError(res))
}

export interface IntegrationGroup {
  id: string
  label: string
  note: string
  providers: IntegrationProvider[]
}

export async function getIntegrations(): Promise<{ groups: IntegrationGroup[] }> {
  const res = await fetch('/api/integrations')
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// --- Roster (conductores activos de Samsara) --------------------------
export interface RosterDriver {
  id: string
  name: string
  company: string
  phone: string
  email: string
  username: string
  license_number: string
  license_state: string
}

export async function listRoster(): Promise<RosterDriver[]> {
  const res = await fetch('/api/drivers')
  if (!res.ok) throw new Error(await readError(res))
  const data = await res.json()
  return (data.drivers ?? []) as RosterDriver[]
}

// Sincroniza el snapshot local de emails desde la hoja "Driver info".
export async function syncDriverContacts(): Promise<
  { count: number; with_email: number; source: string }
> {
  const res = await fetch('/api/drivers/sync-contacts', { method: 'POST' })
  if (!res.ok) throw new Error(await readError(res))
  return await res.json()
}

// Override manual del email de un conductor (sobrevive a la sync).
export async function setDriverEmail(name: string, email: string): Promise<void> {
  const res = await fetch('/api/drivers/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email }),
  })
  if (!res.ok) throw new Error(await readError(res))
}

// --- PM tracker (mantenimiento preventivo) ----------------------------
export interface PMUnit {
  unit: string
  model: string
  pm_type: string | null
  last_pm_date: string | null
  last_pm_miles: number | null
  last_pm_overridden: boolean
  report_miles: number | null
  current_miles: number | null
  current_source: string | null    // obd | gps | report | manual
  current_overridden: boolean
  next_due_miles: number | null
  remaining: number | null
}

export interface PMResult {
  available: boolean
  interval: number
  upcoming_miles: number
  units: PMUnit[]
  excluded: { unit: string; model: string }[]
}

export async function listPM(): Promise<PMResult> {
  const res = await fetch('/api/pm')
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as PMResult
}

export async function setPMOverride(
  unit: string, field: 'current_miles' | 'last_pm_miles', value: number | null,
): Promise<void> {
  const res = await fetch('/api/pm/override', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unit, field, value }),
  })
  if (!res.ok) throw new Error(await readError(res))
}

export async function setPMExcluded(
  unit: string, excluded: boolean,
): Promise<void> {
  const res = await fetch('/api/pm/exclude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unit, excluded }),
  })
  if (!res.ok) throw new Error(await readError(res))
}

// --- Tableros gemelos PM / DOT (fase H1) -------------------------------
export type MaintKind = 'pm' | 'dot'
export type OpsStatus = '' | 'out_of_service' | 'in_shop'

export interface MaintRow {
  unit: string
  model: string
  driver: string
  current_miles: number | null
  current_source: string | null      // obd | gps | report | manual
  current_overridden: boolean
  ops_status: OpsStatus
  notes: string
  last_date: string | null           // YYYY-MM-DD
  last_miles: number | null
  last_overridden?: boolean          // solo pm
  next_due_miles?: number | null     // pm
  next_due_date?: string | null      // dot
  to_due: number | null              // pm: millas · dot: días
  status: string   // on_track|upcoming|overdue|never|no_meter|out_of_service|in_shop
}

export interface MaintBoardResult {
  available: boolean
  kind: MaintKind
  interval_miles: number
  upcoming_miles: number
  interval_days: number
  upcoming_days: number
  units: MaintRow[]
  excluded: { unit: string; model: string }[]
}

export async function getMaintBoard(
  kind: MaintKind,
): Promise<MaintBoardResult> {
  const res = await fetch(`/api/maint/${kind}`)
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as MaintBoardResult
}

export async function addMaintRecord(p: {
  kind: MaintKind; unit: string; date: string;
  mileage?: number | null; notes?: string
}): Promise<void> {
  const res = await fetch('/api/maint/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  })
  if (!res.ok) throw new Error(await readError(res))
}

export async function setOpsStatus(
  unit: string, status: OpsStatus,
): Promise<void> {
  const res = await fetch('/api/maint/ops-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unit, status }),
  })
  if (!res.ok) throw new Error(await readError(res))
}

export async function getUnitOdometer(
  unit: string,
): Promise<{ unit: string; miles: number | null; source: string | null }> {
  const res = await fetch(`/api/maint/odometer/${encodeURIComponent(unit)}`)
  if (!res.ok) throw new Error(await readError(res))
  return await res.json()
}

// --- Tendencias -------------------------------------------------------

export interface TrendPoint {
  date_label: string
  company: string
  fleet_safe_pct: number
  n_no_dvir: number
  n_unsafe: number
  n_reports: number
}

export interface TrendsResponse {
  month: string | null
  points: TrendPoint[]
}

export async function getTrends(): Promise<TrendsResponse> {
  const res = await fetch('/api/dvir/trends')
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// --- Ficha de conductor ----------------------------------------------

export interface DriverDay {
  date_label: string
  block_date: string
  company: string
  missed: boolean
}

export interface DriverDefect {
  date_label: string
  unit: string
  unit_kind: string
  status: string
  detail: string
}

export interface DriverHistory {
  driver: string
  total_days: number
  ok_days: number
  missed_days: number
  compliance_pct: number
  days: DriverDay[]
  defects: DriverDefect[]
}

export async function getDriverHistory(
  name: string,
): Promise<DriverHistory> {
  const res = await fetch(`/api/dvir/drivers/${encodeURIComponent(name)}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// --- Avisos (NO DVIR) -------------------------------------------------

export interface NotifyReason {
  unit: string
  kind: string
  type: string
  detail: string
}

export interface Notice {
  driver: string
  company: string
  region: string | null
  email: string
  cc: string[]
  phone: string
  sms_phone: string | null
  units: string[]
  reasons: NotifyReason[]
  review_reason: string
  subject: string
  body: string
  sms_text: string
}

export interface NotifyBlock {
  sheet: string
  company: string
  date_labels: string[]
}

export interface NotifyBlocksResponse {
  mode: string
  spreadsheet: string | null
  live_error: string
  gmail_configured: boolean
  dry_run: boolean
  sender: string
  sms_configured: boolean
  sms_dry_run: boolean
  blocks: NotifyBlock[]
}

export interface NotifyScanResponse {
  sheet: string
  company: string
  date_label: string
  notices: Notice[]
  review: Notice[]
}

export interface ChannelResult {
  to: string
  cc?: string[]
  ok: boolean
  error: string
  simulated: boolean
}

export interface SendResult {
  driver: string
  email?: ChannelResult
  sms?: ChannelResult
}

export type NotifyChannel = 'email' | 'sms'

export interface NotifySendResponse {
  channels: NotifyChannel[]
  email_dry_run: boolean
  sms_dry_run: boolean
  results: SendResult[]
}

export interface NotifyMedia {
  type: string       // image | video
  url: string        // pública (SMS/MMS)
}

export interface NotifyMediaResponse {
  ok: boolean
  error: string
  media_type: string
  media_url: string
  url_simulated: boolean
  filename: string
  size: number
}

export async function notifyBlocks(): Promise<NotifyBlocksResponse> {
  const res = await fetch('/api/notify/blocks')
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function notifyScan(
  sheet: string,
  date: string,
): Promise<NotifyScanResponse> {
  const qs = new URLSearchParams({ sheet, date })
  const res = await fetch(`/api/notify/scan?${qs}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function notifySend(
  sheet: string,
  dateLabel: string,
  drivers: string[],
  channels: NotifyChannel[],
  media?: NotifyMedia | null,
): Promise<NotifySendResponse> {
  const res = await fetch('/api/notify/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sheet, date_label: dateLabel, drivers, channels,
      media_type: media?.type ?? '',
      media_url: media?.url ?? '',
    }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function uploadNotifyMedia(
  file: File,
): Promise<NotifyMediaResponse> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch('/api/notify/media', { method: 'POST', body: fd })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// --- Catálogo de Partes + Vendors (fase H3, estilo Fullbay) -------------

export interface Vendor {
  id: number
  name: string
  contact: string
  phone: string
  email: string
  address: string
  account: string
  notes: string
  parts_count: number
}

export interface Part {
  id: number
  part_number: string
  description: string
  category: string
  cost: number
  vendor_id: number | null
  vendor_name: string
  on_hand: number
  notes: string
}

export type VendorInput = Partial<Omit<Vendor, 'id' | 'parts_count'>>
export type PartInput = Partial<Omit<Part, 'id' | 'vendor_name'>>

export async function listVendors(): Promise<Vendor[]> {
  const res = await fetch('/api/vendors')
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()).vendors as Vendor[]
}

export async function saveVendor(
  v: VendorInput & { id?: number },
): Promise<Vendor> {
  const res = await fetch(
    v.id ? `/api/vendors/${v.id}` : '/api/vendors',
    {
      method: v.id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(v),
    })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function deleteVendor(id: number): Promise<void> {
  const res = await fetch(`/api/vendors/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res))
}

export interface PartsResponse {
  parts: Part[]
  categories: string[]
  usage: Record<string, number>   // part_number → nº de líneas de WO
}

export async function listParts(): Promise<PartsResponse> {
  const res = await fetch('/api/parts')
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function savePart(
  p: PartInput & { id?: number },
): Promise<Part> {
  const res = await fetch(
    p.id ? `/api/parts/${p.id}` : '/api/parts',
    {
      method: p.id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function deletePart(id: number): Promise<void> {
  const res = await fetch(`/api/parts/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res))
}
