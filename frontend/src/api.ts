// Cliente de la API del backend FastAPI.

export type ReportRow = Record<string, string | boolean> & {
  is_nodvir: boolean
}

export interface ReportGroup {
  truck_merge: boolean
  rows: ReportRow[]
}

// --- Sesión por cookie HttpOnly (SEC-4) ---------------------------------
// El token de sesión vive en una cookie HttpOnly que el navegador envía solo
// (fetch same-origin). El JS YA NO lo guarda ni lo lee → a prueba de robo por
// XSS. getToken/setToken/clearToken quedan como no-op por compatibilidad de
// los llamadores existentes.
export const getToken = () => ''
export const setToken = (_t: string) => { /* SEC-4: no se guarda token en JS */ }
export const clearToken = () => { /* SEC-4: el logout limpia la cookie en server */ }
// SEC-4: barre cualquier token viejo dejado en localStorage por sesiones
// pre-cookie. Ya no se usa para auth (la cookie HttpOnly manda) y no debe
// quedar legible por JS.
try { localStorage.removeItem('ft-token') } catch { /* ignore */ }

// Shadow del fetch global SOLO en este módulo: la cookie de sesión viaja sola
// (credentials same-origin por defecto). Un 401 (sesión vencida/inválida) avisa
// a App para volver al login (evento 'ft-unauthorized').
async function fetch(input: RequestInfo | URL,
                     init?: RequestInit): Promise<Response> {
  const res = await window.fetch(input, init)
  if (res.status === 401) {
    const url = typeof input === 'string' ? input : String(input)
    // No rebotar en los propios endpoints de auth: login/setup devuelven 401
    // por credenciales incorrectas, no por sesión vencida.
    if (!url.includes('/api/auth/')) {
      window.dispatchEvent(new Event('ft-unauthorized'))
    }
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
  template = 'standard',
): Promise<BatchGenerateResponse> {
  const res = await fetch('/api/batch/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batch_id: batchId, blocks, template }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// --- Plantillas de reporte (Standard / Legacy) --------------------------
export interface ReportTemplate { id: string; name: string; pretrip: boolean }

export async function listReportTemplates(): Promise<ReportTemplate[]> {
  const res = await fetch('/api/reporting/templates')
  if (!res.ok) throw new Error(await readError(res))
  return ((await res.json()).templates ?? []) as ReportTemplate[]
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

export async function deleteBlock(id: number): Promise<void> {
  const res = await fetch(`/api/dvir/blocks/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res))
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

// --- Reporting: import desde el ELD (preview/diagnostico) ----------------
export interface EldPreview {
  available: boolean
  detail?: string
  demo?: boolean
  day?: string
  company?: string | null
  dvir_count?: number
  dvir_rows?: Record<string, string>[]
  distance_count?: number
  distance?: Record<string, number>
  pretrip_count?: number
  raw?: { dvir_sample: unknown[]; stats_sample: unknown[]; hos_sample?: unknown[] }
  errors?: string[]
}

export async function eldPreview(
  date: string, company?: string,
): Promise<EldPreview> {
  const q = new URLSearchParams({ date })
  if (company) q.set('company', company)
  const res = await fetch(`/api/reporting/eld/preview?${q.toString()}`)
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as EldPreview
}

export interface EldImportResult {
  ok: boolean
  company: string
  date_label: string
  n_reports: number
  n_no_dvir: number
  n_unsafe: number
}

export async function eldImport(
  date: string, company: string, template = 'standard',
): Promise<EldImportResult> {
  const res = await fetch('/api/reporting/eld/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, company, template }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as EldImportResult
}

// --- Notices: plantillas de mensajes + broadcast ------------------------
export interface MsgTemplate {
  id: string; name: string; subject: string; body: string
}
export interface Recipient {
  name: string; company: string; email: string; phone: string
  has_email: boolean; has_phone: boolean
}
export interface BroadcastResult {
  channels: string[]; sent: number
  email_dry_run: boolean; sms_dry_run: boolean
  results: { driver: string }[]
}

export async function listTemplates(): Promise<MsgTemplate[]> {
  const res = await fetch('/api/notify/templates')
  if (!res.ok) throw new Error(await readError(res))
  return ((await res.json()).templates ?? []) as MsgTemplate[]
}

export async function saveTemplate(
  t: Partial<MsgTemplate>,
): Promise<MsgTemplate> {
  const res = await fetch('/api/notify/templates', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(t),
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as MsgTemplate
}

export async function deleteTemplate(id: string): Promise<void> {
  const res = await fetch(`/api/notify/templates/${encodeURIComponent(id)}`,
    { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res))
}

export async function listRecipients(): Promise<Recipient[]> {
  const res = await fetch('/api/notify/recipients')
  if (!res.ok) throw new Error(await readError(res))
  return ((await res.json()).recipients ?? []) as Recipient[]
}

export async function sendBroadcast(p: {
  drivers: string[]; channels: string[]; subject: string; body: string
}): Promise<BroadcastResult> {
  const res = await fetch('/api/notify/broadcast', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as BroadcastResult
}

// --- Alta manual de unidades (Fleet → Add New Unit) ---------------------
export interface UnitInput {
  unit: string
  unit_type?: string
  subtype?: string
  terminal?: string
  customer?: string
  company?: string
  vin?: string
  year?: string
  make?: string
  model?: string
  fleet_no?: string
  plate?: string
  plate_state?: string
}

export async function addUnit(p: UnitInput): Promise<void> {
  const res = await fetch('/api/units/manual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  })
  if (!res.ok) throw new Error(await readError(res))
}

export interface VinDecode {
  ok: boolean
  vin?: string
  year?: string
  make?: string
  model?: string
  body?: string
  engine?: string
  error?: string
}

// Decodifica un VIN (Year/Make/Model) vía NHTSA vPIC (backend proxy).
export async function decodeVin(vin: string): Promise<VinDecode> {
  const res = await fetch(`/api/vin/${encodeURIComponent(vin)}`)
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as VinDecode
}

export async function fleetArchive(id: string, action: string): Promise<void> {
  const res = await fetch('/api/fleet/archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, action }),
  })
  if (!res.ok) throw new Error(await readError(res))
}

// --- Empresas (Settings → Companies) ----------------------------------
export interface Company { key: string; label: string }

function pickCompanies(j: unknown): Company[] {
  return ((j as { companies?: Company[] })?.companies ?? []) as Company[]
}

export async function listCompanies(): Promise<Company[]> {
  const res = await fetch('/api/companies')
  if (!res.ok) throw new Error(await readError(res))
  return pickCompanies(await res.json())
}

export async function addCompany(label: string, key = ''): Promise<Company[]> {
  const res = await fetch('/api/companies', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, key }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return pickCompanies(await res.json())
}

export async function renameCompany(
  key: string, label: string,
): Promise<Company[]> {
  const res = await fetch('/api/companies/rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, label }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return pickCompanies(await res.json())
}

export async function deleteCompany(key: string): Promise<Company[]> {
  const res = await fetch(`/api/companies/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(await readError(res))
  return pickCompanies(await res.json())
}

// --- Import masivo de unidades por CSV (Settings) ----------------------
export interface UnitImportResult {
  added: number; updated: number; total: number; errors: string[]
}

export async function importUnitsCsv(csv: string): Promise<UnitImportResult> {
  const res = await fetch('/api/units/manual/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csv }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as UnitImportResult
}

export async function unitsCsvTemplate(): Promise<string> {
  const res = await fetch('/api/units/manual/template')
  if (!res.ok) throw new Error(await readError(res))
  return ((await res.json())?.csv ?? '') as string
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

// --- Equipos (Settings → Teams) ----------------------------------------
// Un equipo es un grupo explícito de unidades + una lista de conductores.
// Sin prefijos: una unidad pertenece a un equipo solo si está asignada.
export interface Driver {
  name: string
  email: string
}

export interface TeamDef {
  key: string
  label: string
  drivers: Driver[]
}

export interface TeamsConfig {
  teams: TeamDef[]
  members: Record<string, string>   // unidad → key de equipo
}

export async function listTeams(): Promise<TeamsConfig> {
  const res = await fetch('/api/teams')
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as TeamsConfig
}

export async function saveTeam(t: {
  key?: string; label: string; drivers: Driver[]
}): Promise<TeamsConfig> {
  const res = await fetch('/api/teams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: t.key ?? '', label: t.label,
      drivers: t.drivers }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as TeamsConfig
}

export async function deleteTeam(key: string): Promise<TeamsConfig> {
  const res = await fetch(`/api/teams/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as TeamsConfig
}

export async function assignTeam(
  team: string, units: string[],
): Promise<TeamsConfig> {
  const res = await fetch('/api/teams/assign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ team, units }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as TeamsConfig
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
  scopes: string[]          // H4: scopes del rol del usuario
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

export async function logout(): Promise<void> {
  // SEC-4: limpia la cookie de sesión en el server. Si falla, el caller igual
  // limpia el estado local de la UI.
  try {
    await fetch('/api/auth/logout', { method: 'POST' })
  } catch { /* no-op */ }
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

// --- Driver roster & compliance (ex-TMS) -------------------------------
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

// Vínculo a otra unidad del mismo invoice multi-unidad (review v1.26).
export interface WoLink {
  id: number
  unit: string
  display_no: string        // "4" / "4.1"
}

export interface WoLinks {
  display_no: string
  parent_id: number | null
  child_seq: number
  parent: WoLink | null     // presente si esta orden es una hija
  children: WoLink[]        // otras unidades del mismo invoice
}

export interface WorkOrder {
  id: number
  // Multi-unit (v1.26): número de display ("4" / "4.1") + jerarquía padre/hija.
  display_no: string
  parent_id: number | null
  child_seq: number
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
  // Factura original adjunta (review v1.17): el documento PDF/imagen que dio
  // origen a la WO. Campos calculados en el backend desde el archivo en disco.
  has_invoice_file: boolean
  invoice_file_name: string | null
  total: number
  n_lines: number
  lines?: WoLine[]
  // Vínculos padre/hijas del invoice multi-unidad (solo en getWorkOrder).
  links?: WoLinks
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

// Parts used: una parte usada en una WO de esta unidad (línea kind='part').
export interface PartUsed {
  part_number: string
  description: string
  qty: number
  unit_cost: number
  total: number
  wo_id: number
  wo_no: string
  wo_status: WoStatus
  date: string
}

export interface PartsUsedResult {
  items: PartUsed[]
  total_lines: number
  distinct_parts: number
  total_qty: number
  total_spend: number
}

export async function getUnitPartsUsed(unit: string): Promise<PartsUsedResult> {
  const res = await fetch(
    `/api/units/${encodeURIComponent(unit)}/parts-used`)
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

// --- Factura original adjunta por WO (review v1.17, estilo SquareRigger) ---

// Sube (o reemplaza) la factura original del taller de la WO.
export async function uploadWoInvoiceFile(
  woId: number, file: File,
): Promise<{ has_invoice_file: boolean; invoice_file_name: string }> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch(`/api/workorders/${woId}/invoice-file`, {
    method: 'POST', body: fd,
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function deleteWoInvoiceFile(woId: number): Promise<void> {
  const res = await fetch(`/api/workorders/${woId}/invoice-file`,
    { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res))
}

// La factura es auth-protegida (el middleware exige token), así que un
// <a href>/window.open directo daría 401: se baja por fetch (con Bearer) y
// blob. open=true abre en pestaña nueva (ver); open=false fuerza descarga.
async function fetchWoInvoiceBlobUrl(woId: number): Promise<string> {
  const res = await fetch(`/api/workorders/${woId}/invoice-file`)
  if (!res.ok) throw new Error(await readError(res))
  return URL.createObjectURL(await res.blob())
}

// Miniatura (PNG de la 1a pagina) para el thumbnail del drawer; tambien
// auth-protegida, asi que se baja por fetch+blob (un <img src> daria 401).
export async function fetchWoInvoiceThumbUrl(woId: number): Promise<string> {
  const res = await fetch(`/api/workorders/${woId}/invoice-file/thumb`)
  if (!res.ok) throw new Error(await readError(res))
  return URL.createObjectURL(await res.blob())
}

export async function viewWoInvoiceFile(woId: number): Promise<void> {
  const url = await fetchWoInvoiceBlobUrl(woId)
  window.open(url, '_blank', 'noopener')
  // El object URL queda vivo para que la pestaña lo muestre; se libera tarde.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export async function downloadWoInvoiceFile(
  woId: number, filename: string,
): Promise<void> {
  const url = await fetchWoInvoiceBlobUrl(woId)
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
  // Total impreso del invoice (amount due) para la reconciliación del modal:
  // si la suma de líneas != esto, se avisa. Null si no se detectó.
  grand_total: number | null
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
  shop_invoice?: string; parent_id?: number | null
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
  source?: string            // lynx | thermoking | traccar | demo
  can_control?: boolean      // OEM con tier que habilita two-way
}

export interface ReeferResponse {
  available: boolean
  demo: boolean
  live_empty: boolean
  missing_scopes: string[]
  units: ReeferUnit[]
  source?: string          // lynx | thermoking | traccar | demo (H5/H6)
  error?: string
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

// Control remoto OEM (Carrier Lynx, two-way). Solo unidades 'lynx-' con
// tier >= Monitor and Control; el backend gatea por tier y por scope
// fleet.edit y devuelve 400 con el motivo si no aplica.
export async function setReeferSetpoint(
  unitId: string, setpointF: number,
): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(
    `/api/reefer/${encodeURIComponent(unitId)}/setpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setpoint_f: setpointF }),
    })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function reeferCommand(
  unitId: string,
  body: { command: 'mode' | 'defrost' | 'power'; mode?: string; on?: boolean },
): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(
    `/api/reefer/${encodeURIComponent(unitId)}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
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
  min_severity?: number
}

export interface AlertsSettings {
  rules: {
    speeding: AlertRule
    idle: AlertRule
    low_fuel: AlertRule
    low_def: AlertRule
    no_gps: AlertRule
    reefer_temp: AlertRule
    reefer_fault_wo: AlertRule
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

export interface EldCapabilities {
  fleet: boolean
  drivers: boolean
  defects: boolean
  track: boolean
  reefer: boolean
}

export interface IntegrationProvider {
  id: string
  name: string
  kind: string
  status: IntegrationStatus
  detail: string
  items: { label: string; value: string }[]
  testable: boolean
  configurable: boolean
  // Solo proveedores ELD (registry): capacidades del adapter + estado activo.
  capabilities?: EldCapabilities
  active?: boolean
  previewable?: boolean
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

// Framework ELD: marcar el proveedor activo + previsualizar su flota.
export async function setEldActive(provider: string): Promise<string> {
  const res = await fetch('/api/integrations/eld/active', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return ((await res.json())?.active ?? '') as string
}

export interface EldFleetPreview {
  ok: boolean
  count: number
  detail: string
  sample: {
    unit: string; year: string; make: string; model: string; vin: string
  }[]
}

export async function eldFleetPreview(
  provider: string,
): Promise<EldFleetPreview> {
  const res = await fetch(
    `/api/integrations/eld/${encodeURIComponent(provider)}/fleet-preview`)
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as EldFleetPreview
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
  manufacturer: string
  cost: number
  avg_cost: number        // costo promedio (cae al cost si no se registró)
  vendor_id: number | null
  vendor_name: string
  on_hand: number
  reorder_point: number   // = mínimo; ≤ on_hand → "Low" (0 = sin alerta)
  max_qty: number         // objetivo de stock (para la barra min·max)
  bin: string             // ubicación física
  upc: string
  fits: string            // compatibilidad / a qué unidades entra
  source: string          // origen (manual | scan | …)
  core_charge: number     // depósito de core por unidad (0 = sin core)
  warranty_months: number // ventana de garantía en meses (0 = sin tracking)
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

// --- Inventario de partes (stock, reorder, movimientos) ------------------
// Stock auditable: cada cambio de on_hand genera un movimiento. El backend
// aplica los movimientos referenciados de forma idempotente (PO recibida,
// WO facturada); los ajustes manuales siempre se aplican.

// Razón del movimiento: alta por PO recibida, consumo por WO facturada, o
// ajuste manual desde este catálogo.
export type StockReason = 'po_receive' | 'wo_consume' | 'manual'

export interface StockMovement {
  id: number
  part_number: string
  delta: number             // +/- (positivo = entra, negativo = sale)
  reason: StockReason
  ref_type: string          // 'po_line' | 'wo_line' | '' (manual)
  ref_id: number | null
  note: string
  created_at: string
}

// Parte por debajo (o en) su punto de reorden — vista compacta para reponer.
export interface LowStockPart {
  id: number
  part_number: string
  description: string
  category: string
  on_hand: number
  reorder_point: number
  vendor_id: number | null
}

export interface AdjustResult {
  applied: boolean
  movement: StockMovement | null
  on_hand: number
}

// Ajuste manual de stock (delta +/-). Requiere maint.edit en el backend.
export async function adjustPartStock(
  partNumber: string, delta: number, note: string,
): Promise<AdjustResult> {
  const res = await fetch('/api/parts/adjust', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ part_number: partNumber, delta, note }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// Partes en/bajo su punto de reorden (solo reorder_point > 0).
export async function listLowStock(): Promise<LowStockPart[]> {
  const res = await fetch('/api/parts/low-stock')
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()).parts as LowStockPart[]
}

// Bitácora de movimientos de una parte (más reciente primero).
export async function listPartMovements(
  partNumber: string,
): Promise<StockMovement[]> {
  const res = await fetch(
    `/api/parts/${encodeURIComponent(partNumber)}/movements`)
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()).movements as StockMovement[]
}

// --- Purchase Orders / QuickBuy (Increment B) ----------------------------
// Órdenes de compra de partes a un vendor. Espeja el cliente de work orders.

export type POStatus = 'draft' | 'ordered' | 'received'

export interface POLine {
  id: number
  part_number: string
  description: string
  qty: number
  unit_cost: number
  total: number
  qty_received: number      // acumulado recibido de esta línea
  qty_outstanding: number   // qty - qty_received
}

// Estado DERIVADO de recepción (no es el status del pipeline).
export type ReceivingState = 'none' | 'partial' | 'full'

export interface PurchaseOrder {
  id: number
  created_at: string
  updated_at: string
  vendor: string
  status: POStatus
  notes: string
  total: number
  n_lines: number
  received_at: string | null
  backorder_of_po_id: number | null
  receiving_state: ReceivingState
  lines?: POLine[]
}

export interface POStats {
  draft: number
  ordered: number
  received: number
  open_value: number   // total de las POs no recibidas
}

// Línea de entrada al crear/agregar (sin id ni total: los pone el backend).
export interface POLineInput {
  part_number?: string
  description?: string
  qty?: number
  unit_cost?: number
}

export async function listPurchaseOrders(
  status = '',
): Promise<{ purchase_orders: PurchaseOrder[]; stats: POStats }> {
  const qs = new URLSearchParams()
  if (status) qs.set('status', status)
  const res = await fetch(`/api/purchase-orders?${qs}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function getPurchaseOrder(id: number): Promise<PurchaseOrder> {
  const res = await fetch(`/api/purchase-orders/${id}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function createPurchaseOrder(body: {
  vendor?: string; notes?: string; lines?: POLineInput[]
}): Promise<PurchaseOrder> {
  const res = await fetch('/api/purchase-orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function patchPurchaseOrder(
  id: number, patch: { vendor?: string; notes?: string; status?: POStatus },
): Promise<PurchaseOrder> {
  const res = await fetch(`/api/purchase-orders/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// Recepción por línea (parcial o total). `token` (uno por click) hace la
// operación idempotente. Con createBackorder, el faltante genera una PO draft
// linkeada y cierra esta PO. Devuelve la PO y el backorder (o null).
export async function receivePurchaseOrder(
  id: number,
  receipts: { line_id: number; qty_now: number }[],
  token: string,
  createBackorder = true,
): Promise<{ po: PurchaseOrder; backorder: PurchaseOrder | null }> {
  const res = await fetch(`/api/purchase-orders/${id}/receive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ receipts, token, create_backorder: createBackorder }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function deletePurchaseOrder(id: number): Promise<void> {
  const res = await fetch(`/api/purchase-orders/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res))
}

export async function addPoLine(
  id: number, line: POLineInput,
): Promise<PurchaseOrder> {
  const res = await fetch(`/api/purchase-orders/${id}/lines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(line),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function deletePoLine(
  id: number, lineId: number,
): Promise<PurchaseOrder> {
  const res = await fetch(`/api/purchase-orders/${id}/lines/${lineId}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// --- Parts Requests (cola de faltantes → bundle por vendor → PO, Inc 4) ---
export interface PartsRequest {
  id: number
  part_number: string
  description: string
  qty: number
  unit_cost: number
  total: number
  vendor: string
  source: string          // low_stock | wo | manual
  source_ref: string
  requested_by: string
  status: string          // pending | ordered
  po_id: number | null
  created_at: string
}

export interface RequestStats {
  pending: number
  pending_value: number
  vendors: number
  pos_in_flight: number
  in_flight_value: number
  received_30d_value: number
  received_30d_count: number
}

export async function listPartsRequests(
  status = 'pending',
): Promise<{ requests: PartsRequest[]; stats: RequestStats }> {
  const res = await fetch(
    `/api/parts-requests?status=${encodeURIComponent(status)}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function createPartsRequest(body: {
  part_number?: string; description?: string; qty?: number
  unit_cost?: number; vendor?: string; source?: string; source_ref?: string
}): Promise<PartsRequest> {
  const res = await fetch('/api/parts-requests', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function generateLowStockRequests(): Promise<{ created: number }> {
  const res = await fetch('/api/parts-requests/generate-low-stock',
    { method: 'POST' })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function bundleRequests(
  requestIds: number[],
): Promise<{ po: PurchaseOrder; n: number }> {
  const res = await fetch('/api/parts-requests/bundle', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_ids: requestIds }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function cancelPartsRequest(id: number): Promise<void> {
  const res = await fetch(`/api/parts-requests/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res))
}

// --- Core tracking (banco de cores, v2.5) --------------------------------
// Cores pendientes de devolver al proveedor para recuperar el depósito.
export interface CoreItem {
  id: number
  part_number: string
  description: string
  vendor: string
  core_charge: number     // depósito por unidad
  qty: number
  deposit: number         // core_charge × qty
  po_id: number | null
  status: 'pending' | 'returned'
  created_at: string
  returned_at: string | null
}

export interface CoreStats {
  pending: number
  pending_deposit: number   // $ inmovilizado en depósitos pendientes
  vendors: number
  returned_30d: number
  credited_30d: number      // créditos recuperados en 30 días
}

export async function listCores(
  status = 'pending',
): Promise<{ cores: CoreItem[]; stats: CoreStats }> {
  const res = await fetch(`/api/cores?status=${encodeURIComponent(status)}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function returnCore(id: number): Promise<CoreItem> {
  const res = await fetch(`/api/cores/${id}/return`, { method: 'POST' })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function unreturnCore(id: number): Promise<CoreItem> {
  const res = await fetch(`/api/cores/${id}/unreturn`, { method: 'POST' })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// --- Warranty tracking (reclamos de garantía, v2.6) ----------------------
// La misma parte reusada en la misma unidad dentro de su ventana de garantía.
export type ClaimStatus = 'open' | 'submitted' | 'recovered' | 'dismissed'

export interface WarrantyClaim {
  id: number
  part_number: string
  description: string
  unit: string
  vendor: string
  install_wo: number | null
  install_date: string
  failure_wo: number | null
  failure_date: string
  warranty_until: string
  amount: number          // monto recuperable (costo del reemplazo)
  status: ClaimStatus
}

export interface WarrantyStats {
  open: number
  open_amount: number       // $ recuperable en claims abiertos
  submitted: number
  recovered: number
  recovered_amount: number  // $ ya recuperado
}

export async function listWarranty(
  status = 'open',
): Promise<{ claims: WarrantyClaim[]; stats: WarrantyStats }> {
  const res = await fetch(`/api/warranty?status=${encodeURIComponent(status)}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function setClaimStatus(
  id: number, status: ClaimStatus,
): Promise<WarrantyClaim> {
  const res = await fetch(`/api/warranty/${id}/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// Escanea el historial y materializa claims nuevos (write). Se dispara al
// abrir Purchasing, no en cada lectura, para no mutar en cada GET.
export async function scanWarranty(): Promise<{ created: number }> {
  const res = await fetch('/api/warranty/scan', { method: 'POST' })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// --- Permisos (matriz rol → capacidad, read-only, Inc 5) -----------------
export interface PermMatrix {
  roles: string[]
  scopes: { id: string; label: string }[]
  matrix: Record<string, Record<string, 'view' | 'edit'>>
  editable: boolean
}

export async function getPermissionsMatrix(): Promise<PermMatrix> {
  const res = await fetch('/api/permissions/matrix')
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// Guarda la matriz de la org: { rol: [scopes concedidos] } (admin se ignora).
export async function savePermissionsMatrix(
  grants: Record<string, string[]>,
): Promise<PermMatrix> {
  const res = await fetch('/api/permissions/matrix', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grants }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// --- Marketplace de partes (scaffold, Increment B) -----------------------
// Búsqueda en un marketplace externo (FindItParts/PartsTech). Mientras no
// haya cuenta de API conectada, el backend devuelve datos demo (mock) y
// `configured: false` — la UI muestra el banner de "Demo data". Un resultado
// puede alimentar una línea de QuickBuy/PO. Conectar el real es trabajo de
// backend (un adapter en core/parts_marketplace.py); el frente no cambia.

export type PartAvailability =
  'in_stock' | 'limited' | 'backorder' | 'special_order'

export interface MarketplaceResult {
  part_number: string
  description: string
  brand: string
  price: number            // unitario (USD); 0 = sin precio público
  availability: PartAvailability | string
  vendor: string           // distribuidor/tienda que la vende
}

export interface MarketplaceSearchResponse {
  configured: boolean      // false = datos demo (sin API conectada)
  provider: string         // 'mock' | 'finditparts' | 'partstech'
  results: MarketplaceResult[]
}

export async function searchMarketplace(
  q: string, limit = 20,
): Promise<MarketplaceSearchResponse> {
  const qs = new URLSearchParams({ q, limit: String(limit) })
  const res = await fetch(`/api/parts/marketplace/search?${qs}`)
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as MarketplaceSearchResponse
}

// --- Reports & Analytics: gasto del taller (fase H8) ---------------------
// Reporte de gasto (parts + labor) sobre WOs cerradas (completed/invoiced),
// agregado por categoría / unidad / mes / parte. Lo sirve el backend en
// /api/reports/spend; el frente solo pinta los rankings + KPIs.

// Filtros del reporte (todos opcionales). `from`/`to` en formato ISO
// (YYYY-MM-DD); '' = sin límite. `terminal` = key de terminal en mayúsculas;
// '' = todas. `topUnits`/`topParts` = tamaño de cada ranking (1–100).
export interface SpendReportParams {
  from?: string
  to?: string
  terminal?: string
  topUnits?: number
  topParts?: number
}

// El backend hace eco de los filtros parseados (null = no aplicado).
export interface SpendRange {
  from: string | null
  to: string | null
  terminal: string | null
}

export interface SpendTotals {
  total_spend: number   // parts + labor
  parts_spend: number
  labor_spend: number
  pm_spend: number         // gasto en trabajo planificado (PM/campañas)
  reactive_spend: number   // gasto en fallas/reparaciones
  pm_pct: number           // % del gasto en prevención (planificado)
  wo_count: number      // WOs distintas en rango
  avg_per_wo: number    // total_spend / wo_count (0 si no hay)
  median_per_wo: number    // mediana del total por WO (robusta a outliers)
}

// Fila de un ranking por categoría (key estable + label de display).
export interface SpendCategory {
  key: string
  label: string
  value: number
}

// Fila genérica de ranking (unidad o mes): label + monto.
export interface SpendBar {
  label: string
  value: number
}

// Fila del top de partes (solo líneas de tipo parte con part_number).
export interface SpendPart {
  part_number: string
  description: string
  qty: number
  value: number
}

export interface SpendReport {
  range: SpendRange
  totals: SpendTotals
  by_category: SpendCategory[]
  by_unit: SpendBar[]
  by_month: SpendBar[]
  top_parts: SpendPart[]
}

export async function getSpendReport(
  params: SpendReportParams = {},
): Promise<SpendReport> {
  const qs = new URLSearchParams()
  // 'from' es palabra reservada del backend pero el alias del Query la expone
  // tal cual; el resto son nombres directos.
  if (params.from) qs.set('from', params.from)
  if (params.to) qs.set('to', params.to)
  if (params.terminal) qs.set('terminal', params.terminal)
  if (params.topUnits != null) qs.set('top_units', String(params.topUnits))
  if (params.topParts != null) qs.set('top_parts', String(params.topParts))
  const q = qs.toString()
  const res = await fetch(`/api/reports/spend${q ? `?${q}` : ''}`)
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as SpendReport
}

// --- Cost per mile (v2.8, el número ancla de Dario) ----------------------
// Gasto de mantenimiento / millas manejadas (del odómetro persistido). El
// Fleet CPM solo agrega unidades CON millas; las que tienen gasto pero no
// odómetro se cuentan aparte. `coverage.since` = desde cuándo hay datos.
export interface CpmUnitRow {
  unit: string
  spend: number
  miles: number
  cpm: number | null   // null = la unidad no tiene millas en el rango
}

export interface CpmCoverage {
  readings: number
  since: string | null
  latest: string | null
}

export interface CpmReport {
  range: SpendRange
  fleet_cpm: number | null   // null = todavía no hay millas suficientes
  fleet_miles: number
  fleet_spend: number
  total_spend: number
  units_with_miles: number
  units_without_miles: number
  spend_without_miles: number
  coverage: CpmCoverage
  by_unit: CpmUnitRow[]
}

export async function getCpmReport(
  params: SpendReportParams = {},
): Promise<CpmReport> {
  const qs = new URLSearchParams()
  if (params.from) qs.set('from', params.from)
  if (params.to) qs.set('to', params.to)
  if (params.terminal) qs.set('terminal', params.terminal)
  const q = qs.toString()
  const res = await fetch(`/api/reports/cpm${q ? `?${q}` : ''}`)
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as CpmReport
}

// Materializa la base de millas (backfill de WO/PM + snapshot Samsara).
export async function refreshCpm(): Promise<
  { backfilled: number; snapshot: number; coverage: CpmCoverage }
> {
  const res = await fetch('/api/reports/cpm/refresh', { method: 'POST' })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}
