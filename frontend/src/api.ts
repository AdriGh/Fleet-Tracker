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
  minMiles: number
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
  fd.append('min_miles', String(input.minMiles))

  const res = await fetch('/api/reports', { method: 'POST', body: fd })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export function downloadUrl(reportId: string): string {
  return `/api/reports/${reportId}/download`
}
