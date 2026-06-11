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

// --- Iconos (familia SVG propia, stroke 1.8) ---------------------------
const STROKE = {
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

const IcoMail = (
  <svg viewBox="0 0 24 24" {...STROKE}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m4 7 8 6 8-6" />
  </svg>
)
const IcoSms = (
  <svg viewBox="0 0 24 24" {...STROKE}>
    <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.6 0-3.1-.4-4.4-1.2L3 20l1.2-5.1A8.5 8.5 0 1 1 21 11.5z" />
  </svg>
)
const IcoClip = (
  <svg viewBox="0 0 24 24" {...STROKE}>
    <path d="m21 11.5-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8L13 4a3.7 3.7 0 0 1 5.2 5.2l-8.2 8.2a1.8 1.8 0 0 1-2.6-2.6L15 7.3" />
  </svg>
)
const IcoSend = (
  <svg viewBox="0 0 24 24" {...STROKE}>
    <path d="M21.5 2.5 10.8 13.2M21.5 2.5l-7 19-3.7-8.3L2.5 9.5z" />
  </svg>
)

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase()
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
  const [previewTab, setPreviewTab] = useState<NotifyChannel>('sms')

  function toggleChannel(c: NotifyChannel) {
    setChannels((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      if (next.size === 0) next.add(c)   // al menos uno
      return next
    })
  }

  // La pestaña de preview siempre apunta a un canal activo.
  useEffect(() => {
    if (!channels.has(previewTab)) {
      setPreviewTab([...channels][0] ?? 'sms')
    }
  }, [channels, previewTab])

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
  const channelSim = [...channels].every((c) => c === 'email' ? emailSim
    : smsSim)
  const showTabs = wantEmail && wantSms

  return (
    <div className="page page-wide">
      {busy && <div className="loadbar" aria-hidden="true" />}
      <div className="page-head">
        <div>
          <h1>Notices</h1>
          <p className="page-sub">
            NO DVIR and pre-trips under 15 min, notified to the driver with a
            copy to their terminal.
          </p>
        </div>
        {status && (
          <div className="head-actions nf-status">
            <span className={`nf-pill ${status.mode === 'live' ? 'is-on' : 'is-demo'}`}>
              <span className="nf-dot" />
              {status.mode === 'live' ? 'Live sheet' : 'Demo data'}
            </span>
            <span className={`nf-pill ${emailSim ? 'is-sim' : 'is-real'}`}>
              <span className="nf-pill-ico">{IcoMail}</span>
              {emailSim ? 'Email: simulated' : 'Email: LIVE'}
            </span>
            <span className={`nf-pill ${smsSim ? 'is-sim' : 'is-real'}`}>
              <span className="nf-pill-ico">{IcoSms}</span>
              {smsSim ? 'SMS: simulated' : 'SMS: LIVE'}
            </span>
          </div>
        )}
      </div>

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

      {/* ----- Paso 1: alcance ----- */}
      <div className="card">
        <div className="card-body nf-scope">
          <span className="nf-step" aria-hidden="true">1</span>
          <div className="nf-scope-text">
            <strong>Pick the day</strong>
            <span>Company and report day to scan for offenders.</span>
          </div>
          <label className="nf-field">
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
          <label className="nf-field">
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
            {/* ----- Paso 2: destinatarios ----- */}
            <div className="card">
              <div className="card-head">
                <span className="nf-step" aria-hidden="true">2</span>
                <h2>Recipients</h2>
                <span className="sub">
                  {selected.size} of {scan.notices.length} selected
                </span>
              </div>
              <div className="card-body">
                {scan.notices.length === 0 ? (
                  <div className="empty mini">
                    <p>
                      Clean day: nobody to notify for {date}. Try another day
                      or company.
                    </p>
                  </div>
                ) : (
                  <table className="avisos-table nf-table">
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
                        <th>Contact</th>
                        <th>Terminal</th>
                        <th className="num">CC</th>
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
                          <td>
                            <span className="nf-driver">
                              <span className="nf-avatar">
                                {initials(n.driver)}
                              </span>
                              <span className="nf-driver-text">
                                <strong>{n.driver}</strong>
                                <span className="nf-units">
                                  {n.units.join(' · ')}
                                </span>
                              </span>
                            </span>
                          </td>
                          <td>
                            <span className="nf-contact">
                              <span className={n.email ? '' : 'muted'}>
                                <i className="nf-ci">{IcoMail}</i>
                                {n.email || 'no email'}
                              </span>
                              <span className={n.sms_phone ? '' : 'muted'}>
                                <i className="nf-ci">{IcoSms}</i>
                                {n.sms_phone || 'no phone'}
                              </span>
                            </span>
                          </td>
                          <td>
                            <span className="chip">{n.region}</span>
                          </td>
                          <td className="num">{n.cc.length}</td>
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

            {/* ----- Paso 3: envío ----- */}
            <div className="card nf-dock">
              <div className="card-body nf-dock-row">
                <span className="nf-step" aria-hidden="true">3</span>
                <div className="nf-channels" role="group" aria-label="Channels">
                  {ALL_CHANNELS.map((c) => (
                    <button
                      key={c}
                      className={`nf-channel ${channels.has(c) ? 'on' : ''}`}
                      onClick={() => toggleChannel(c)}
                      aria-pressed={channels.has(c)}
                    >
                      <i>{c === 'email' ? IcoMail : IcoSms}</i>
                      {c === 'email' ? 'Email' : 'SMS'}
                      {channels.has(c) && (
                        <em>{(c === 'email' ? emailSim : smsSim)
                          ? 'sim' : 'LIVE'}</em>
                      )}
                    </button>
                  ))}
                </div>

                {wantSms && (
                  media ? (
                    <span className="nf-attach">
                      <i>{IcoClip}</i>
                      {media.filename}
                      <button className="icon-x" title="Quitar adjunto"
                        onClick={() => setMedia(null)}>✕</button>
                    </span>
                  ) : (
                    <label className="btn btn-ghost nf-attach-btn">
                      <i className="nf-btn-ico">{IcoClip}</i>
                      {uploadingMedia ? 'Subiendo…' : 'Attach image/video'}
                      <input type="file" accept="image/*,video/*" hidden
                        disabled={uploadingMedia} onChange={onMediaPick} />
                    </label>
                  )
                )}

                <span className="head-spacer" />
                <button
                  className={`btn ${channelSim ? 'btn-primary' : 'btn-success'} nf-send`}
                  onClick={runSend}
                  disabled={sending || selected.size === 0}
                >
                  <i className="nf-btn-ico">{IcoSend}</i>
                  {sending
                    ? 'Sending…'
                    : channelSim
                      ? `Simulate ${selected.size}`
                      : `Send ${selected.size}`}
                </button>
              </div>
            </div>

            {sendResult && (
              <div className="card nf-results">
                <div className="card-head">
                  <h2>
                    {channelSim ? 'Simulation completed' : 'Sending completed'}
                  </h2>
                  <span className="sub">{sendResult.results.length} drivers</span>
                </div>
                <div className="card-body">
                  <ul className="nf-result-list">
                    {sendResult.results.map((r) => (
                      <li key={r.driver}>
                        <span className="nf-avatar sm">{initials(r.driver)}</span>
                        <span className="nf-result-driver">{r.driver}</span>
                        <span className="nf-result-chs">
                          {r.email && (
                            <span className={`nf-result-ch ${r.email.ok ? 'ok' : 'fail'}`}>
                              <i>{IcoMail}</i>
                              {r.email.to || 'no address'}
                              {r.email.simulated && <em>sim</em>}
                              {r.email.error ? `: ${r.email.error}` : ''}
                            </span>
                          )}
                          {r.sms && (
                            <span className={`nf-result-ch ${r.sms.ok ? 'ok' : 'fail'}`}>
                              <i>{IcoSms}</i>
                              {r.sms.to || 'no phone'}
                              {r.sms.simulated && <em>sim</em>}
                              {r.sms.error ? `: ${r.sms.error}` : ''}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </div>

          {/* ----- Preview ----- */}
          <aside className="card avisos-preview">
            <div className="card-head">
              <h2>Preview</h2>
              {showTabs && focused && (
                <div className="prev-tabs" role="tablist">
                  {(['sms', 'email'] as NotifyChannel[]).map((c) => (
                    <button
                      key={c}
                      role="tab"
                      aria-selected={previewTab === c}
                      className={`prev-tab ${previewTab === c ? 'on' : ''}`}
                      onClick={() => setPreviewTab(c)}
                    >
                      {c === 'sms' ? 'SMS' : 'Email'}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="card-body">
              {!focused ? (
                <div className="empty mini">
                  <p>Select a driver to preview their notice.</p>
                </div>
              ) : previewTab === 'sms' && wantSms ? (
                <div className="phone-frame">
                  <div className="phone-head">
                    <span className="nf-avatar sm">
                      {initials(focused.driver)}
                    </span>
                    <span className="phone-meta">
                      <strong>{focused.driver}</strong>
                      <span className="mono">
                        {focused.sms_phone || 'sin teléfono'}
                      </span>
                    </span>
                    <span className="sms-badge">SMS</span>
                  </div>
                  {media && (
                    <div className="wa-media-chip">
                      <i className="nf-ci">{IcoClip}</i>
                      {media.type === 'video'
                        ? 'video (link en el texto)'
                        : 'imagen (MMS)'} · {media.filename}
                    </div>
                  )}
                  <div className="sms-bubble">
                    {focused.sms_text}
                    {media && media.type === 'video'
                      ? `\nVideo: ${media.url}` : ''}
                  </div>
                  <span className="phone-foot">
                    Delivered as text message via Twilio
                  </span>
                </div>
              ) : (
                <div className="mail-card">
                  <div className="mail-head">
                    <span className="mail-avatar">SM</span>
                    <div className="mail-meta">
                      <strong>Safety &amp; Maintenance</strong>
                      <span>
                        to <span className="mono">{focused.email || 'sin email'}</span>
                      </span>
                      {focused.cc.length > 0 && (
                        <span className="mail-cc">
                          cc <span className="mono">{focused.cc.join(', ')}</span>
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="mail-subject">{focused.subject}</div>
                  <pre className="prev-body">{focused.body}</pre>
                </div>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
