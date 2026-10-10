// Envíos programados por email (v2.22 [G]): modal de alta/edición
// (diario / semanal / mensual, hora de la org, destinatarios, CSV o XLSX) y
// la lista "Scheduled" con el último estado REAL (sent / dry run / error —
// el mailer en modo prueba no se disfraza de enviado), próximo envío y
// "Send now". Escribir requiere maint.edit (como el server).
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  deleteSchedule, listSchedules, patchSchedule, saveSchedule, sendScheduleNow,
  type ReportCadence, type ReportFormat, type ReportSchedule,
  type ReportVersion,
} from '../api'
import Modal from '../components/Modal'
import { Button } from '../components/ds'
import Skeleton from '../components/Skeleton'
import { usePerms } from '../perms'
import { notifyErr, notifyOk, notifyWarn } from '../toast'
import { fmtDateTime } from './model'
import { IcClock, IcEdit, IcMail, IcTrash } from './icons'

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
  'Saturday', 'Sunday']
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

function hourLabel(h: number): string {
  const ap = h >= 12 ? 'PM' : 'AM'
  return `${h % 12 || 12}:00 ${ap}`
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`
}

function describeWhen(s: Pick<ReportSchedule, 'cadence' | 'weekday' | 'day_of_month' | 'hour'>): string {
  const at = hourLabel(s.hour)
  if (s.cadence === 'daily') return `Daily at ${at}`
  if (s.cadence === 'weekly') return `Every ${WEEKDAYS[s.weekday ?? 0]} at ${at}`
  return `Monthly on the ${ordinal(s.day_of_month ?? 1)} at ${at}`
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1)
}

function splitEmails(raw: string): string[] {
  return raw.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)
}

// ---------------------------------------------------------------------------
// Alta / edición
// ---------------------------------------------------------------------------
export interface ScheduleModalProps {
  schedule?: ReportSchedule | null
  reportRef: string
  reportName: string
  version?: string
  versions?: ReportVersion[]
  onClose: () => void
  onSaved?: (s: ReportSchedule) => void
}

export default function ScheduleModal({
  schedule, reportRef, reportName, version = '', versions = [], onClose, onSaved,
}: ScheduleModalProps) {
  const qc = useQueryClient()
  const { can } = usePerms()
  const canEdit = can('maint.edit')
  const [name, setName] = useState(schedule?.name ?? '')
  const [ver, setVer] = useState(schedule?.version ?? version)
  const [cadence, setCadence] = useState<ReportCadence>(schedule?.cadence ?? 'weekly')
  const [weekday, setWeekday] = useState(schedule?.weekday ?? 0)
  const [dom, setDom] = useState(schedule?.day_of_month ?? 1)
  const [hour, setHour] = useState(schedule?.hour ?? 7)
  const [recips, setRecips] = useState((schedule?.recipients ?? []).join(', '))
  const [format, setFormat] = useState<ReportFormat>(schedule?.format ?? 'xlsx')
  const [active, setActive] = useState(schedule?.active ?? true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const emails = splitEmails(recips)
  const bad = emails.filter((e) => !EMAIL_RE.test(e))
  const verLabel = versions.find((v) => v.key === ver)?.label

  async function save() {
    if (!emails.length) { setErr('Add at least one recipient email.'); return }
    if (bad.length) { setErr(`Check this email: ${bad[0]}`); return }
    setBusy(true)
    setErr(null)
    const body = {
      report_ref: reportRef,
      version: ver,
      name: name.trim(),
      cadence,
      weekday: cadence === 'weekly' ? weekday : null,
      day_of_month: cadence === 'monthly' ? dom : null,
      hour,
      recipients: emails,
      format,
      active,
    }
    try {
      // Editar: el reporte solo viaja si cambió (el server re-valida su
      // visibilidad con QUIEN edita; un schedule de un reporte privado de
      // otro usuario igual se puede cambiar de destinatarios / hora).
      const sameReport = !!schedule && schedule.report_ref === reportRef
        && (schedule.version ?? '') === (ver ?? '')
      const rest: Partial<typeof body> = { ...body }
      delete rest.report_ref
      delete rest.version
      const s = schedule
        ? await patchSchedule(schedule.id, sameReport ? rest : body)
        : await saveSchedule(body)
      qc.invalidateQueries({ queryKey: ['report-schedules'] })
      notifyOk(schedule ? 'Schedule updated' : 'Report scheduled',
        `${describeWhen(s)} · ${s.recipients.length} recipient${s.recipients.length === 1 ? '' : 's'}`)
      onSaved?.(s)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Couldn’t save the schedule')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={schedule ? 'Edit scheduled email' : 'Schedule email'}
      onClose={onClose} width={560}>
      <form className="cf-form" noValidate
        onSubmit={(e) => { e.preventDefault(); void save() }}>
        <p className="rpx-sched-for">
          <IcMail size={15} />
          <span><strong>{reportName}</strong>{verLabel ? ` · ${verLabel}` : ''}</span>
        </p>
        {!canEdit && (
          <p className="cf-pii">Scheduling emails needs work-order edit permission.</p>
        )}
        <div className="cf-grid">
          <label className="ud-field cf-field is-wide">
            <span>Email subject / name</span>
            <input className="cell-input" value={name} maxLength={160}
              placeholder={`${reportName}${verLabel ? ` — ${verLabel}` : ''}`}
              onChange={(e) => setName(e.target.value)} />
          </label>
          {versions.length > 1 && (
            <label className="ud-field cf-field is-wide">
              <span>Version</span>
              <select className="cell-input" value={ver}
                onChange={(e) => setVer(e.target.value)}>
                {versions.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
              </select>
            </label>
          )}
          <div className="ud-field cf-field is-wide" role="radiogroup" aria-label="Repeats">
            <span>Repeats</span>
            <div className="bt-seg">
              {(['daily', 'weekly', 'monthly'] as ReportCadence[]).map((c) => (
                <label key={c} className={`bt-opt${cadence === c ? ' is-on' : ''}`}>
                  <input type="radio" name="rpt-cad" checked={cadence === c}
                    onChange={() => setCadence(c)} />
                  {c === 'daily' ? 'Daily' : c === 'weekly' ? 'Weekly' : 'Monthly'}
                </label>
              ))}
            </div>
          </div>
          {cadence === 'weekly' && (
            <label className="ud-field cf-field">
              <span>On</span>
              <select className="cell-input" value={weekday}
                onChange={(e) => setWeekday(Number(e.target.value))}>
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </label>
          )}
          {cadence === 'monthly' && (
            <label className="ud-field cf-field">
              <span>Day of month</span>
              <select className="cell-input" value={dom}
                onChange={(e) => setDom(Number(e.target.value))}>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>{ordinal(d)}{d > 28 ? ' (or last day)' : ''}</option>
                ))}
              </select>
            </label>
          )}
          <label className="ud-field cf-field">
            <span>At</span>
            <select className="cell-input" value={hour}
              onChange={(e) => setHour(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{hourLabel(h)}</option>
              ))}
            </select>
            <span className="field-hint">Your organization’s time zone.</span>
          </label>
          <label className="ud-field cf-field is-wide">
            <span>Recipients *</span>
            <textarea className="cell-input ud-notes" rows={2} value={recips}
              placeholder="owner@shop.com, accounting@shop.com"
              aria-invalid={!!err && (bad.length > 0 || !emails.length)}
              onChange={(e) => setRecips(e.target.value)} />
            <span className={`field-hint${bad.length ? ' cf-err' : ''}`}>
              {bad.length
                ? `Not an email: ${bad.join(', ')}`
                : emails.length
                  ? `${emails.length} recipient${emails.length === 1 ? '' : 's'} · separate with commas`
                  : 'Separate several emails with commas.'}
            </span>
          </label>
          <div className="ud-field cf-field" role="radiogroup" aria-label="Attachment">
            <span>Attachment</span>
            <div className="bt-seg">
              {(['xlsx', 'csv'] as ReportFormat[]).map((f) => (
                <label key={f} className={`bt-opt${format === f ? ' is-on' : ''}`}>
                  <input type="radio" name="rpt-fmt" checked={format === f}
                    onChange={() => setFormat(f)} />
                  {f === 'xlsx' ? 'Excel (.xlsx)' : 'CSV'}
                </label>
              ))}
            </div>
          </div>
          <label className="cf-check">
            <input type="checkbox" checked={active}
              onChange={(e) => setActive(e.target.checked)} />
            <span>
              <strong>Active</strong>
              <span className="field-hint">Pause it any time without deleting.</span>
            </span>
          </label>
        </div>
        <p className="field-hint">
          Sends <strong>{lowerFirst(describeWhen({ cadence, weekday, day_of_month: dom, hour }))}</strong>.
          The report runs fresh each time with its version’s date range.
        </p>
        {err && <p className="field-hint cf-err" role="alert">{err}</p>}
        <div className="sr-form-actions cf-actions">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy} disabled={!canEdit}>
            {schedule ? 'Save changes' : 'Schedule'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Lista "Scheduled"
// ---------------------------------------------------------------------------
const STATUS_LBL: Record<string, { label: string; tone: string }> = {
  sent: { label: 'Sent', tone: 'ok' },
  dry_run: { label: 'Test mode — not sent', tone: 'warn' },
  error: { label: 'Failed', tone: 'danger' },
  '': { label: 'Not sent yet', tone: 'neutral' },
}

export function SchedulesModal({ nameOf, versionsOf, exists, onClose }: {
  nameOf: (ref: string) => string
  versionsOf: (ref: string) => ReportVersion[]
  // ¿El reporte está en la biblioteca de quien mira? (no = borrado, o
  // privado de otro usuario: el server igual lo envía).
  exists?: (ref: string) => boolean
  onClose: () => void
}) {
  const qc = useQueryClient()
  const { can } = usePerms()
  const canEdit = can('maint.edit')
  const q = useQuery({ queryKey: ['report-schedules'], queryFn: () => listSchedules() })
  const [editing, setEditing] = useState<ReportSchedule | null>(null)
  const [sending, setSending] = useState<number | null>(null)

  const list = useMemo(() => [...(q.data ?? [])].sort(
    (a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)), [q.data])

  const toggle = useMutation({
    mutationFn: (s: ReportSchedule) => patchSchedule(s.id, { active: !s.active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['report-schedules'] }),
    onError: (e) => notifyErr('Couldn’t update the schedule', e),
  })
  const remove = useMutation({
    mutationFn: (s: ReportSchedule) => deleteSchedule(s.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['report-schedules'] })
      notifyOk('Schedule deleted')
    },
    onError: (e) => notifyErr('Couldn’t delete the schedule', e),
  })

  async function sendNow(s: ReportSchedule) {
    setSending(s.id)
    try {
      const r = await sendScheduleNow(s.id)
      qc.invalidateQueries({ queryKey: ['report-schedules'] })
      const rows = r.rows != null ? `${r.rows.toLocaleString('en-US')} rows · ` : ''
      if (r.last_status === 'sent') {
        notifyOk('Email sent', `${rows}${r.recipients.join(', ')}`)
      } else if (r.last_status === 'dry_run') {
        notifyWarn('Email not sent — mail is in test mode',
          `${rows}Set up outgoing email in Settings → Integrations to deliver it.`)
      } else {
        notifyErr('The email failed', new Error(r.last_error || 'Unknown error'))
      }
    } catch (e) {
      notifyErr('Couldn’t send the report', e)
    } finally {
      setSending(null)
    }
  }

  return (
    <Modal title="Scheduled emails" onClose={onClose} width={760}>
      {q.isPending ? (
        <div className="skel-rows">
          {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} h={64} />)}
        </div>
      ) : q.error ? (
        <div className="banner error"><span>{(q.error as Error).message}</span></div>
      ) : list.length === 0 ? (
        <div className="rpx-empty">
          <IcClock size={34} />
          <h3>No scheduled emails yet</h3>
          <p>Open any report and choose <strong>⋮ → Schedule email…</strong> to send it
            daily, weekly or monthly as CSV or Excel.</p>
        </div>
      ) : (
        <ul className="rpx-sched-list">
          {list.map((s) => {
            const st = STATUS_LBL[s.last_status] ?? STATUS_LBL['']
            const missing = exists ? !exists(s.report_ref) : false
            return (
              <li key={s.id} className={`rpx-sched${s.active ? '' : ' is-paused'}`}>
                <div className="rpx-sched-main">
                  <strong>{s.name || nameOf(s.report_ref)}</strong>
                  <span className="rpx-sched-sub">
                    {missing ? (
                      <span className="rpx-sched-missing"
                        title="The report was deleted, or it is private to another user">
                        Report not in your library
                      </span>
                    ) : nameOf(s.report_ref)}
                    {s.version && ` · ${versionsOf(s.report_ref).find((v) => v.key === s.version)?.label ?? s.version}`}
                    {' · '}{s.format.toUpperCase()}
                  </span>
                  <span className="rpx-sched-sub">
                    {describeWhen(s)} · {s.recipients.join(', ')}
                  </span>
                </div>
                <div className="rpx-sched-state">
                  <span className={`rpt-chip t-${s.active ? st.tone : 'neutral'}`}>
                    {s.active ? st.label : 'Paused'}
                  </span>
                  <span className="rpx-sched-sub">
                    {s.last_run_at ? `Last ${fmtDateTime(s.last_run_at)}` : 'Never run'}
                  </span>
                  {s.active && s.next_run_at && (
                    <span className="rpx-sched-sub">Next {fmtDateTime(s.next_run_at)}</span>
                  )}
                  {s.last_status === 'error' && s.last_error && (
                    <span className="rpx-sched-err" title={s.last_error}>{s.last_error}</span>
                  )}
                </div>
                <div className="rpx-sched-actions">
                  <Button variant="ghost" size="sm" loading={sending === s.id}
                    disabled={!canEdit} onClick={() => void sendNow(s)}>
                    Send now
                  </Button>
                  <button type="button" className="rpx-icon-btn" disabled={!canEdit}
                    aria-label={s.active ? `Pause ${s.name}` : `Resume ${s.name}`}
                    title={s.active ? 'Pause' : 'Resume'}
                    onClick={() => toggle.mutate(s)}>
                    {s.active ? '❚❚' : '▶'}
                  </button>
                  <button type="button" className="rpx-icon-btn" disabled={!canEdit}
                    aria-label={`Edit ${s.name}`} title="Edit"
                    onClick={() => setEditing(s)}>
                    <IcEdit size={15} />
                  </button>
                  <button type="button" className="rpx-icon-btn is-danger" disabled={!canEdit}
                    aria-label={`Delete ${s.name}`} title="Delete"
                    onClick={() => {
                      if (window.confirm(`Delete the schedule “${s.name}”?`)) remove.mutate(s)
                    }}>
                    <IcTrash size={15} />
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {!canEdit && list.length > 0 && (
        <p className="field-hint">Changing schedules needs work-order edit permission.</p>
      )}
      {editing && (
        <ScheduleModal schedule={editing} reportRef={editing.report_ref}
          reportName={nameOf(editing.report_ref)} version={editing.version}
          versions={versionsOf(editing.report_ref)}
          onClose={() => setEditing(null)} />
      )}
    </Modal>
  )
}
