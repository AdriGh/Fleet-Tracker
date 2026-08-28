// Export del reporte PM compliance (v2.19): PDF imprimible (mismo pipeline
// .print-root que MaintReport — el navegador lo guarda como PDF con el donut
// SVG intacto), CSV plano y XLSX real (exceljs, cargado lazy) con el gráfico
// embebido como imagen dibujada en canvas (los .xlsx no aceptan SVG).
//
// El gráfico es ELEGIBLE (withChart): el checkbox del popover de export
// aplica a PDF y XLSX; el CSV es solo datos por naturaleza del formato.
import { useEffect, useMemo, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import PieChart from './PieChart'
import type { PmComplianceGroup, PmComplianceRow } from '../api'

export const PM_RPT_STATUS: Record<string, {
  label: string; color: string; rank: number
}> = {
  overdue: { label: 'Overdue', color: '#dc2626', rank: 0 },
  upcoming: { label: 'Upcoming', color: '#d99a00', rank: 1 },
  never: { label: 'Never', color: '#0891b2', rank: 2 },
  no_meter: { label: 'No odometer', color: '#a1a1aa', rank: 3 },
  in_shop: { label: 'In shop', color: '#2563eb', rank: 4 },
  out_of_service: { label: 'Out of service', color: '#52525b', rank: 5 },
  on_track: { label: 'On track', color: '#16a34a', rank: 6 },
}
const STATUS_ORDER = Object.entries(PM_RPT_STATUS)
  .sort((a, b) => a[1].rank - b[1].rank).map(([k]) => k)

export const PM_PROG_LABEL: Record<string, string> = {
  pm_dd: 'PM · DD13/DD15', pm_isx: 'PM · ISX', pm_generic: 'PM · other',
  dot: 'DOT inspection',
}

export type PmRow = PmComplianceRow & { gkey: string }

export function noBaseline(g: PmComplianceGroup): number {
  return g.never + g.no_meter
}

function fmtMi(n: number | null | undefined): string {
  return n == null ? '' : n.toLocaleString('en-US')
}
function nextDue(r: PmComplianceRow): string {
  if (r.next_due_miles != null) return `${fmtMi(r.next_due_miles)} mi`
  return r.next_due_date ?? '—'
}
function toDue(r: PmComplianceRow): string {
  return r.to_due == null ? '—' : `${fmtMi(r.to_due)} ${r.to_due_unit}`
}
function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '')
  return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${a})`
}
function stamp(): string {
  const t = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}`
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

// ---- CSV (solo datos: el formato no admite gráficos) ----------------------
export function exportPmCsv(groups: PmComplianceGroup[], rows: PmRow[]) {
  const esc = (c: string | number) =>
    `"${String(c).replace(/"/g, '""')}"`
  const lines: string[] = []
  lines.push(['Program', 'Units', 'Overdue', 'Upcoming', 'On track',
    'No baseline'].map(esc).join(','))
  for (const g of groups) {
    lines.push([PM_PROG_LABEL[g.key] ?? g.label, g.units, g.overdue,
      g.upcoming, g.on_track, noBaseline(g)].map(esc).join(','))
  }
  lines.push('')
  lines.push(['Unit', 'Program', 'Model', 'Driver', 'Last done', 'Next due',
    'To due', 'Status'].map(esc).join(','))
  for (const r of rows) {
    lines.push([r.unit, PM_PROG_LABEL[r.gkey] ?? r.gkey, r.model,
      r.driver || '', r.last_date ?? 'Never', nextDue(r), toDue(r),
      PM_RPT_STATUS[r.status]?.label ?? r.status].map(esc).join(','))
  }
  download(new Blob(['﻿' + lines.join('\n')],
    { type: 'text/csv;charset=utf-8' }), `pm-compliance-${stamp()}.csv`)
}

// ---- Donut a canvas (para embeber en XLSX como PNG) -----------------------
function donutPng(rows: PmRow[]): string {
  const counts: Record<string, number> = {}
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1
  const entries = STATUS_ORDER.filter((s) => counts[s])
  const total = rows.length || 1
  const S = 420
  const canvas = document.createElement('canvas')
  canvas.width = S + 260
  canvas.height = S
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const cx = S / 2, cy = S / 2, R = S * 0.38, W = S * 0.16
  let ang = -Math.PI / 2
  for (const st of entries) {
    const frac = counts[st] / total
    ctx.beginPath()
    ctx.strokeStyle = PM_RPT_STATUS[st].color
    ctx.lineWidth = W
    ctx.arc(cx, cy, R, ang, ang + frac * 2 * Math.PI)
    ctx.stroke()
    ang += frac * 2 * Math.PI
  }
  ctx.fillStyle = '#18181b'
  ctx.font = `700 ${S * 0.12}px sans-serif`
  ctx.textAlign = 'center'
  ctx.fillText(String(rows.length), cx, cy + S * 0.04)
  // Leyenda a la derecha
  ctx.textAlign = 'left'
  ctx.font = `500 ${S * 0.055}px sans-serif`
  let y = S * 0.2
  for (const st of entries) {
    ctx.fillStyle = PM_RPT_STATUS[st].color
    ctx.fillRect(S + 10, y - S * 0.04, S * 0.05, S * 0.05)
    ctx.fillStyle = '#18181b'
    const pct = Math.round((counts[st] / total) * 100)
    ctx.fillText(`${PM_RPT_STATUS[st].label} — ${counts[st]} (${pct}%)`,
      S + 10 + S * 0.08, y)
    y += S * 0.09
  }
  return canvas.toDataURL('image/png')
}

// ---- XLSX (exceljs lazy: ~250 kB que solo paga quien exporta) -------------
export async function exportPmXlsx(groups: PmComplianceGroup[],
                                   rows: PmRow[], withChart: boolean) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()

  const sum = wb.addWorksheet('Summary')
  sum.columns = [
    { header: 'Program', key: 'p', width: 24 },
    { header: 'Units', key: 'u', width: 9 },
    { header: 'Overdue', key: 'o', width: 10 },
    { header: 'Upcoming', key: 'up', width: 11 },
    { header: 'On track', key: 'ok', width: 10 },
    { header: 'No baseline', key: 'nb', width: 12 },
  ]
  sum.getRow(1).font = { bold: true }
  for (const g of groups) {
    sum.addRow({ p: PM_PROG_LABEL[g.key] ?? g.label, u: g.units,
      o: g.overdue, up: g.upcoming, ok: g.on_track, nb: noBaseline(g) })
  }
  const t = sum.addRow({
    p: 'TOTAL',
    u: groups.reduce((s, g) => s + g.units, 0),
    o: groups.reduce((s, g) => s + g.overdue, 0),
    up: groups.reduce((s, g) => s + g.upcoming, 0),
    ok: groups.reduce((s, g) => s + g.on_track, 0),
    nb: groups.reduce((s, g) => s + noBaseline(g), 0),
  })
  t.font = { bold: true }

  if (withChart && rows.length) {
    const img = wb.addImage({
      base64: donutPng(rows), extension: 'png',
    })
    sum.addImage(img, {
      tl: { col: 0, row: groups.length + 3 },
      ext: { width: 420, height: 260 },
    })
  }

  const det = wb.addWorksheet('Units')
  det.columns = [
    { header: 'Unit', key: 'unit', width: 10 },
    { header: 'Program', key: 'prog', width: 18 },
    { header: 'Model', key: 'model', width: 26 },
    { header: 'Driver', key: 'driver', width: 18 },
    { header: 'Last done', key: 'last', width: 12 },
    { header: 'Next due', key: 'next', width: 14 },
    { header: 'To due', key: 'due', width: 12 },
    { header: 'Status', key: 'st', width: 14 },
  ]
  det.getRow(1).font = { bold: true }
  for (const r of rows) {
    const row = det.addRow({
      unit: r.unit, prog: PM_PROG_LABEL[r.gkey] ?? r.gkey, model: r.model,
      driver: r.driver || '', last: r.last_date ?? 'Never', next: nextDue(r),
      due: toDue(r), st: PM_RPT_STATUS[r.status]?.label ?? r.status,
    })
    const color = (PM_RPT_STATUS[r.status]?.color ?? '#a1a1aa')
      .replace('#', 'FF')
    row.getCell('st').font = { color: { argb: color }, bold: true }
  }

  const buf = await wb.xlsx.writeBuffer()
  download(new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }), `pm-compliance-${stamp()}.xlsx`)
}

// ---- PDF: portal imprimible (mismo pipeline que MaintReport) --------------
export default function PmCompliancePrint({ groups, rows, withChart, onClose }: {
  groups: PmComplianceGroup[]
  rows: PmRow[]
  withChart: boolean
  onClose: () => void
}) {
  const generated = useMemo(() => new Date().toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }), [])

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1
    return c
  }, [rows])
  const total = rows.length
  const pieData = useMemo(() =>
    STATUS_ORDER.filter((st) => counts[st]).map((st) => ({
      label: PM_RPT_STATUS[st].label, value: counts[st],
      color: PM_RPT_STATUS[st].color,
    })), [counts])

  useEffect(() => {
    const done = () => onClose()
    window.addEventListener('afterprint', done, { once: true })
    const t = window.setTimeout(() => window.print(), 150)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('afterprint', done)
    }
  }, [onClose])

  return createPortal(
    <div className="print-root">
      <div className="maint-report" data-theme="light">
        <header className="ur-head">
          <div className="ur-brand">
            <img src="/favicon.svg" alt="" className="ur-logo" />
            <div>
              <span className="ur-brand-name">Rigsmith</span>
              <span className="ur-brand-sub">PM compliance</span>
            </div>
          </div>
          <div className="ur-title">
            <h1>PM compliance · by engine program</h1>
            <span className="ur-gen">
              {groups.map((g) => PM_PROG_LABEL[g.key] ?? g.label).join(' + ')}
              {' '}· {total} unit{total === 1 ? '' : 's'} ·
              {' '}Generated {generated}
            </span>
          </div>
        </header>

        {/* Resumen por PROGRAMA (el corazón del reporte) + donut elegible */}
        <section className="mr-overview">
          <div className="mr-cards">
            {groups.map((g) => (
              <div className="mr-card" key={g.key} style={{
                borderLeftColor: g.overdue
                  ? PM_RPT_STATUS.overdue.color
                  : PM_RPT_STATUS.on_track.color,
              } as CSSProperties}>
                <div className="mr-card-top">
                  <span className="mr-card-label">
                    {PM_PROG_LABEL[g.key] ?? g.label}
                  </span>
                  <span className="mr-card-pct">
                    {g.units ? Math.round((g.on_track / g.units) * 100) : 0}%
                    {' '}on track
                  </span>
                </div>
                <span className="mr-card-n">{g.units}</span>
                <span className="mr-card-bar">
                  <i style={{
                    width: `${g.units ? (g.on_track / g.units) * 100 : 0}%`,
                    background: PM_RPT_STATUS.on_track.color,
                  }} />
                </span>
              </div>
            ))}
          </div>
          {withChart && (
            <div className="mr-donut">
              <PieChart data={pieData} size={172} centerUnit="units" />
            </div>
          )}
        </section>

        <div className="mr-section">
          Units
          <span className="mr-section-n">{total}</span>
        </div>

        <table className="mr-table">
          <thead>
            <tr>
              <th>Unit</th>
              <th>Program</th>
              <th>Model</th>
              <th className="num">Last done</th>
              <th className="num">Next due</th>
              <th className="num">To due</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const sm = PM_RPT_STATUS[r.status] ?? PM_RPT_STATUS.never
              return (
                <tr key={`${r.gkey}-${r.unit}`} className="mr-row"
                  style={{ background: hexA(sm.color, 0.06) }}>
                  <td style={{ boxShadow: `inset 3px 0 0 ${sm.color}` }}>
                    <strong style={{ color: sm.color }}>{r.unit}</strong>
                  </td>
                  <td>{PM_PROG_LABEL[r.gkey] ?? r.gkey}</td>
                  <td>{r.model || '—'}</td>
                  <td className="num">{r.last_date ?? 'Never'}</td>
                  <td className="num">{nextDue(r)}</td>
                  <td className="num">{toDue(r)}</td>
                  <td>
                    <span className="mr-pill" style={{
                      color: sm.color, background: hexA(sm.color, 0.12),
                    }}>{sm.label}</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>,
    document.body,
  )
}
