// Cliente de la API del backend FastAPI.

export type ReportRow = Record<string, string | boolean> & {
  is_nodvir: boolean
}

export interface ReportGroup {
  truck_merge: boolean
  rows: ReportRow[]
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
  units: string[]
  reasons: NotifyReason[]
  review_reason: string
  subject: string
  body: string
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
  blocks: NotifyBlock[]
}

export interface NotifyScanResponse {
  sheet: string
  company: string
  date_label: string
  notices: Notice[]
  review: Notice[]
}

export interface SendResult {
  driver: string
  to: string
  cc: string[]
  ok: boolean
  error: string
  simulated: boolean
}

export interface NotifySendResponse {
  dry_run: boolean
  results: SendResult[]
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
): Promise<NotifySendResponse> {
  const res = await fetch('/api/notify/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sheet, date_label: dateLabel, drivers }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}
