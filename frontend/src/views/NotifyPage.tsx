import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  notifyBlocks,
  notifyScan,
  notifySend,
  uploadNotifyMedia,
  type NotifyBlocksResponse,
  type NotifyScanResponse,
  type Notice,
  type NotifyChannel,
  type NotifySendResponse,
} from '../api'
import { notifyOk, notifyErr } from '../toast'

type Media = { type: string; url: string; filename: string }
const ALL_CHANNELS: NotifyChannel[] = ['email', 'sms']
const CHANNEL_LABEL: Record<NotifyChannel, string> = {
  email: '✉ Email', sms: '💬 SMS',
}

export default function NotifyPage() {
  const [sheet, setSheet] = useState('')
  const [date, setDate] = useState('')
  const [scan, setScan] = useState<NotifyScanResponse | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [focused, setFocused] = useState<Notice | null>(null)
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [sendResult, setSendResult] = useState<NotifySendResponse | null>(null)
  const [channels, setChannels] = useState<Set<NotifyChannel>>(
    () => new Set<NotifyChannel>(['sms']))
  const [media, setMedia] = useState<Media | null>(null)
  const [uploadingMedia, setUploadingMedia] = useState(false)

  function toggleChannel(c: NotifyChannel) {
    setChannels((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      if (next.size === 0) next.add(c)   // al menos uno
      return next
    })
  }

  const blocksQuery = useQuery({
    queryKey: ['notify-blocks'], queryFn: notifyBlocks })
  const status: NotifyBlocksResponse | null = blocksQuery.data ?? null
  const busy = blocksQuery.isFetching || loading || sending

  // Al cargar los bloques, seleccionar empresa/día por defecto.
  useEffect(() => {
    if (status && !sheet && status.blocks.length) {
      const first = status.blocks[0]
      setSheet(first.sheet)
      setDate(first.date_labels[first.date_labels.length - 1] ?? '')
    }
  }, [status, sheet])

  const dateOptions = useMemo(() => {
    const blk = status?.blocks.find((b) => b.sheet === sheet)
    return blk?.date_labels ?? []
  }, [status, sheet])

  async function runScan() {
    if (!sheet || !date) return
    setLoading(true)
    setError('')
    setScan(null)
    setSendResult(null)
    setFocused(null)
    try {
      const r = await notifyScan(sheet, date)
      setScan(r)
      setSelected(new Set(r.notices.map((n) => n.driver)))
      setFocused(r.notices[0] ?? r.review[0] ?? null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  function toggle(driver: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(driver)) next.delete(driver)
      else next.add(driver)
      return next
    })
  }

  function toggleAll() {
    if (!scan) return
    setSelected((prev) =>
      prev.size === scan.notices.length
        ? new Set()
        : new Set(scan.notices.map((n) => n.driver)),
    )
  }

  async function onMediaPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploadingMedia(true)
    try {
      const r = await uploadNotifyMedia(file)
      if (r.ok) {
        setMedia({ type: r.media_type, url: r.media_url,
          filename: r.filename })
        notifyOk('Adjunto cargado', r.url_simulated ? '(simulado)' : r.filename)
      } else {
        notifyErr('No se pudo subir el adjunto', r.error)
      }
    } catch (err) {
      notifyErr('No se pudo subir el adjunto', err)
    } finally {
      setUploadingMedia(false)
    }
  }

  async function runSend() {
    if (!scan || selected.size === 0 || channels.size === 0) return
    setSending(true)
    setError('')
    const chans = [...channels]
    try {
      const r = await notifySend(
        sheet, date, [...selected], chans,
        media ? { type: media.type, url: media.url } : null)
      setSendResult(r)
      const sim = chans.every((c) => c === 'email'
        ? r.email_dry_run : r.sms_dry_run)
      notifyOk(
        sim ? 'Simulación completada' : 'Avisos enviados',
        `${selected.size} conductor${selected.size === 1 ? '' : 'es'} · ${chans.join('+')}`,
      )
    } catch (e) {
      setError(String(e))
      notifyErr('No se pudieron enviar los avisos', e)
    } finally {
      setSending(false)
    }
  }

  const emailSim = status ? status.dry_run : true
  const smsSim = status ? status.sms_dry_run : true
  const wantEmail = channels.has('email')
  const wantSms = channels.has('sms')
  const wantPhone = wantSms
  const channelSim = [...channels].every((c) => c === 'email' ? emailSim
    : smsSim)

  return (
    <div className="page page-wide">
      {busy && <div className="loadbar" aria-hidden="true" />}
      <div className="page-head">
        <div>
          <h1>NO DVIR Notices</h1>
          <p className="page-sub">
            Detects NO DVIR and DVIR &lt; 15 min, and sends the notice to the
            driver with a copy to their terminal.
          </p>
        </div>
      </div>

      {status && (
        <div className={`banner ${channelSim ? 'warn' : ''}`}>
          <span>
            {status.mode === 'live'
              ? `🔗 Reading live: ${status.spreadsheet}. `
              : '🧪 Demo mode: sample data. '}
            {wantEmail && (emailSim
              ? '✉ Email: SIMULADO. '
              : `✉ Email: EN VIVO (${status.sender}). `)}
            {wantSms && (smsSim
              ? '💬 SMS: SIMULADO (configurá twilio.local.json). '
              : '💬 SMS: EN VIVO. ')}
          </span>
        </div>
      )}

      {status?.live_error && (
        <div className="banner error">
          Could not read the live spreadsheet (using demo mode):{' '}
          {status.live_error}
        </div>
      )}

      {(error || blocksQuery.error) && (
        <div className="banner error">
          {error || String(blocksQuery.error)}
        </div>
      )}

      <div className="card">
        <div className="card-body avisos-controls">
          <label>
            Company
            <select
              value={sheet}
              onChange={(e) => {
                setSheet(e.target.value)
                const blk = status?.blocks.find(
                  (b) => b.sheet === e.target.value,
                )
                setDate(blk?.date_labels[blk.date_labels.length - 1] ?? '')
              }}
            >
              {status?.blocks.map((b) => (
                <option key={b.sheet} value={b.sheet}>
                  {b.company} ({b.sheet})
                </option>
              ))}
            </select>
          </label>
          <label>
            Day
            <select value={date} onChange={(e) => setDate(e.target.value)}>
              {dateOptions.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn btn-primary"
            onClick={runScan}
            disabled={loading || !sheet || !date}
          >
            {loading ? 'Scanning…' : 'Scan'}
          </button>
        </div>
      </div>

      {scan && (
        <div className="avisos-grid">
          <div className="avisos-main">
            <div className="card">
              <div className="card-head">
                <h2>To send ({scan.notices.length})</h2>
                <span className="sub">
                  Selected: {selected.size}
                </span>
              </div>
              <div className="card-body">
                {scan.notices.length === 0 ? (
                  <p className="empty">No notices to send.</p>
                ) : (
                  <table className="avisos-table">
                    <thead>
                      <tr>
                        <th>
                          <input
                            type="checkbox"
                            checked={selected.size === scan.notices.length}
                            onChange={toggleAll}
                          />
                        </th>
                        <th>Driver</th>
                        <th>Email</th>
                        <th>Teléfono</th>
                        <th>Terminal</th>
                        <th>CC</th>
                        <th>Units</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scan.notices.map((n) => (
                        <tr
                          key={n.driver}
                          className={
                            focused?.driver === n.driver ? 'focused' : ''
                          }
                          onClick={() => setFocused(n)}
                        >
                          <td onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={selected.has(n.driver)}
                              onChange={() => toggle(n.driver)}
                            />
                          </td>
                          <td>{n.driver}</td>
                          <td className="mono">{n.email || '—'}</td>
                          <td className="mono">
                            {n.sms_phone
                              ? n.sms_phone
                              : <span className="muted">— sin tel.</span>}
                          </td>
                          <td>
                            <span className="chip">{n.region}</span>
                          </td>
                          <td>{n.cc.length}</td>
                          <td className="units">{n.units.join('; ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {scan.review.length > 0 && (
              <div className="card">
                <div className="card-head">
                  <h2>To review ({scan.review.length})</h2>
                  <span className="sub">Not sent until corrected</span>
                </div>
                <div className="card-body">
                  <table className="avisos-table review">
                    <thead>
                      <tr>
                        <th>Driver</th>
                        <th>Reason</th>
                        <th>Units</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scan.review.map((n, i) => (
                        <tr key={`${n.driver}-${i}`}>
                          <td>{n.driver}</td>
                          <td className="reason">{n.review_reason}</td>
                          <td className="units">{n.units.join('; ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="avisos-actions">
              <div className="company-tabs" role="group" aria-label="Channels">
                {ALL_CHANNELS.map((c) => (
                  <button key={c}
                    className={`tab-btn ${channels.has(c) ? 'active' : ''}`}
                    onClick={() => toggleChannel(c)}>{CHANNEL_LABEL[c]}</button>
                ))}
              </div>

              {wantPhone && (
                <div className="wa-attach">
                  {media ? (
                    <span className="wa-attach-file">
                      📎 {media.filename}
                      <button className="icon-x" title="Quitar adjunto"
                        onClick={() => setMedia(null)}>✕</button>
                    </span>
                  ) : (
                    <label className="btn btn-ghost">
                      {uploadingMedia ? 'Subiendo…' : '📎 Adjuntar imagen/video'}
                      <input type="file" accept="image/*,video/*" hidden
                        disabled={uploadingMedia} onChange={onMediaPick} />
                    </label>
                  )}
                </div>
              )}

              <span className="head-spacer" />
              <button
                className="btn btn-success"
                onClick={runSend}
                disabled={sending || selected.size === 0}
              >
                {sending
                  ? 'Sending…'
                  : channelSim
                    ? `Send ${selected.size} (simulated)`
                    : `Send ${selected.size}`}
              </button>
            </div>

            {sendResult && (
              <div className="banner">
                <div>
                  <strong>
                    {channelSim ? 'Simulation completed' : 'Sending completed'}
                  </strong>
                  <ul className="send-results">
                    {sendResult.results.map((r) => (
                      <li key={r.driver}>
                        <span className="sr-driver">{r.driver}</span>
                        {r.email && (
                          <span className="sr-ch">
                            ✉ {r.email.ok ? '✅' : '❌'} {r.email.to || '—'}
                            {r.email.simulated ? ' (sim)' : ''}
                            {r.email.error ? ` — ${r.email.error}` : ''}
                          </span>
                        )}
                        {r.sms && (
                          <span className="sr-ch">
                            💬 {r.sms.ok ? '✅' : '❌'} {r.sms.to || '—'}
                            {r.sms.simulated ? ' (sim)' : ''}
                            {r.sms.error ? ` — ${r.sms.error}` : ''}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </div>

          <aside className="card avisos-preview">
            <div className="card-head">
              <h2>Preview</h2>
            </div>
            <div className="card-body">
              {focused ? (
                <>
                  {wantSms && (
                    <div className="wa-preview">
                      <div className="wa-preview-head">
                        <span className="sms-badge">SMS</span>
                        <span className="mono">{focused.sms_phone || '— sin teléfono'}</span>
                      </div>
                      {media && (
                        <div className="wa-media-chip">
                          {media.type === 'video'
                            ? '🎬 video (link en el texto)'
                            : '🖼 imagen (MMS)'} · {media.filename}
                        </div>
                      )}
                      <div className="sms-bubble">
                        {focused.sms_text}
                        {media && media.type === 'video'
                          ? `\nVideo: ${media.url}` : ''}
                      </div>
                    </div>
                  )}
                  {wantEmail && (
                    <>
                      <div className="prev-row">
                        <span>To</span>
                        <span className="mono">{focused.email || '—'}</span>
                      </div>
                      <div className="prev-row">
                        <span>CC</span>
                        <span className="mono">{focused.cc.join(', ') || '—'}</span>
                      </div>
                      <div className="prev-row">
                        <span>Subject</span>
                        <span>{focused.subject}</span>
                      </div>
                      <pre className="prev-body">{focused.body}</pre>
                    </>
                  )}
                </>
              ) : (
                <p className="empty">Select a driver to view the notice.</p>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
