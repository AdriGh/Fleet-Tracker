// Cliente de la API del backend FastAPI.

export type ReportRow = Record<string, string | boolean> & {
  is_nodvir: boolean
}

export interface ReportGroup {
  truck_merge: boolean
  rows: ReportRow[]
}

export interface ReportStats {
  drivers: number
  rows: number
  no_dvir: number
}

export interface ReportResponse {
  id: string
  company: string
  date_label: string
  columns: string[]
  stats: ReportStats
  groups: ReportGroup[]
  filename: string
}

export interface CreateReportInput {
  dvirFile: File
  activityFile: File
  rosterFile: File | null
  company: string
  dateLabel: string
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

export async function createReport(
  input: CreateReportInput,
): Promise<ReportResponse> {
  const fd = new FormData()
  fd.append('dvir_file', input.dvirFile)
  fd.append('activity_file', input.activityFile)
  if (input.rosterFile) fd.append('roster_file', input.rosterFile)
  fd.append('company', input.company)
  fd.append('date_label', input.dateLabel)

  const res = await fetch('/api/reports', { method: 'POST', body: fd })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export function downloadUrl(reportId: string): string {
  return `/api/reports/${reportId}/download`
}

// --- Lote multi-día / multi-empresa -----------------------------------

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
