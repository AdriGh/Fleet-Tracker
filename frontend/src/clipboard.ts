// Copia un bloque DVIR al portapapeles con formato (HTML) y como
// texto tabulado (fallback). Replica los colores exactos del DVIR Report
// para que al pegar en Excel/Sheets conserve el formato.

import type { ReportGroup } from './api'

const TRUCK_SIDE = new Set([
  'Trk#', 'DVIR trk', 'Duration trk', 'DOT Issues trk', 'Fullbay trk',
])
const DUR_COLS = new Set(['Duration trk', 'Duration trl'])
const DOT_COLS = new Set(['DOT Issues trk', 'DOT Issues trl'])
const FB_COLS = new Set(['Fullbay trk', 'Fullbay trl'])
const STATUS_COLS = new Set(['DVIR trk', 'DVIR trl'])

const GREEN = 'background:#C6EFCE;color:#276221;font-weight:bold;'
const RESOLVED = 'background:#C6EFCE;color:#006100;font-weight:bold;'
const RED = 'background:#FFC7CE;color:#9C0006;font-weight:bold;'
const BLUE = 'background:#D6E8F7;color:#1A1A1A;'
const NODVIR = 'background:#FFE0B2;color:#BF360C;font-weight:bold;'

function durSecs(text: string): number {
  let total = 0
  const unit: Record<string, number> = { h: 3600, m: 60, s: 1 }
  for (const m of text.matchAll(/(\d+)\s*([hms])/g)) {
    total += Number(m[1]) * (unit[m[2]] ?? 0)
  }
  return total
}

function cellStyle(col: string, value: string): string {
  const base =
    'border:1px solid #d9d9d9;padding:2px 6px;' +
    (col === 'Driver' ? 'text-align:left;' : 'text-align:center;')
  let s = ''
  if (value === '-') s = BLUE
  else if (DUR_COLS.has(col) && value) s = durSecs(value) < 600 ? RED : GREEN
  else if (DOT_COLS.has(col) && value) s = value === 'NO' ? GREEN : RED
  else if (FB_COLS.has(col) && value) s = value === 'YES' ? GREEN : RED
  else if (STATUS_COLS.has(col) && value) {
    if (value.includes('NO DVIR')) s = NODVIR
    else if (value === 'Safe') s = GREEN
    else if (value === 'Resolved') s = RESOLVED
    else if (value === 'Unsafe') s = RED
  }
  return base + s
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function buildBlock(
  columns: string[],
  groups: ReportGroup[],
  dateLabel: string,
): { html: string; tsv: string } {
  const rows: string[] = []
  rows.push(
    `<tr><td colspan="${columns.length}" style="background:#1F4E79;` +
      `color:#ffffff;font-weight:bold;text-align:center;` +
      `border:1px solid #d9d9d9;">${esc(dateLabel)}</td></tr>`,
  )
  for (const g of groups) {
    g.rows.forEach((row, ri) => {
      const tds: string[] = []
      for (const col of columns) {
        const value = String(row[col] ?? '')
        const mergedDriver = col === 'Driver'
        const mergedTruck = g.truck_merge && TRUCK_SIDE.has(col)
        if ((mergedDriver || mergedTruck) && ri > 0) continue
        const span =
          (mergedDriver || mergedTruck) && g.rows.length > 1
            ? ` rowspan="${g.rows.length}"`
            : ''
        tds.push(`<td${span} style="${cellStyle(col, value)}">${esc(value)}</td>`)
      }
      rows.push(`<tr>${tds.join('')}</tr>`)
    })
  }
  const html =
    `<table style="border-collapse:collapse;font-family:Calibri,` +
    `sans-serif;font-size:11pt;">${rows.join('')}</table>`

  const lines = [dateLabel]
  for (const g of groups) {
    for (const row of g.rows) {
      lines.push(columns.map((c) => String(row[c] ?? '')).join('\t'))
    }
  }
  return { html, tsv: lines.join('\n') }
}

export async function copyBlock(
  columns: string[],
  groups: ReportGroup[],
  dateLabel: string,
): Promise<void> {
  const { html, tsv } = buildBlock(columns, groups, dateLabel)
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([tsv], { type: 'text/plain' }),
      }),
    ])
  } catch {
    await navigator.clipboard.writeText(tsv)
  }
}
