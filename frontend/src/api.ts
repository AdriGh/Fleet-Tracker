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
  limit = 5,
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

export async function getBlock(id: number): Promise<BlockDetail> {
  const res = await fetch(`/api/dvir/blocks/${id}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}
