import { useEffect, useMemo, useState } from 'react'
import {
  notifyBlocks,
  notifyScan,
  notifySend,
  type NotifyBlocksResponse,
  type NotifyScanResponse,
  type Notice,
  type NotifySendResponse,
} from '../api'

export default function NotifyPage() {
  const [status, setStatus] = useState<NotifyBlocksResponse | null>(null)
  const [sheet, setSheet] = useState('')
  const [date, setDate] = useState('')
  const [scan, setScan] = useState<NotifyScanResponse | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [focused, setFocused] = useState<Notice | null>(null)
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [sendResult, setSendResult] = useState<NotifySendResponse | null>(null)

  useEffect(() => {
    notifyBlocks()
      .then((b) => {
        setStatus(b)
        if (b.blocks.length) {
          const first = b.blocks[0]
          setSheet(first.sheet)
          setDate(first.date_labels[first.date_labels.length - 1] ?? '')
        }
      })
      .catch((e) => setError(String(e)))
  }, [])

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

  async function runSend() {
    if (!scan || selected.size === 0) return
    setSending(true)
    setError('')
    try {
      const r = await notifySend(sheet, date, [...selected])
      setSendResult(r)
    } catch (e) {
      setError(String(e))
    } finally {
      setSending(false)
    }
  }

  const simulated = status ? status.dry_run : true

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Avisos de NO DVIR</h1>
          <p className="page-sub">
            Detecta NO DVIR y DVIR &lt; 15 min, y manda el aviso al conductor
            con copia a su terminal.
          </p>
        </div>
      </div>

      {status && (
        <div className={`banner ${simulated ? 'warn' : ''}`}>
          <span>
            {status.mode === 'live'
              ? `🔗 Leyendo en vivo: ${status.spreadsheet}. `
              : '🧪 Modo demo: datos de ejemplo de tu planilla. '}
            {simulated
              ? 'Envío SIMULADO (no se mandan correos todavía).'
              : `Envío real activo como ${status.sender}.`}
          </span>
        </div>
      )}

      {status?.live_error && (
        <div className="banner error">
          No se pudo leer la planilla en vivo (se usa el modo demo):{' '}
          {status.live_error}
        </div>
      )}

      {error && <div className="banner error">{error}</div>}

      <div className="card">
        <div className="card-body avisos-controls">
          <label>
            Empresa
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
            Día
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
            {loading ? 'Escaneando…' : 'Escanear'}
          </button>
        </div>
      </div>

      {scan && (
        <div className="avisos-grid">
          <div className="avisos-main">
            <div className="card">
              <div className="card-head">
                <h2>A enviar ({scan.notices.length})</h2>
                <span className="sub">
                  Seleccionados: {selected.size}
                </span>
              </div>
              <div className="card-body">
                {scan.notices.length === 0 ? (
                  <p className="empty">Ningún aviso para enviar.</p>
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
                        <th>Conductor</th>
                        <th>Email</th>
                        <th>Terminal</th>
                        <th>CC</th>
                        <th>Unidades</th>
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
                          <td className="mono">{n.email}</td>
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
                  <h2>A revisar ({scan.review.length})</h2>
                  <span className="sub">No se envían hasta corregir</span>
                </div>
                <div className="card-body">
                  <table className="avisos-table review">
                    <thead>
                      <tr>
                        <th>Conductor</th>
                        <th>Motivo</th>
                        <th>Unidades</th>
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
              <button
                className="btn btn-success"
                onClick={runSend}
                disabled={sending || selected.size === 0}
              >
                {sending
                  ? 'Enviando…'
                  : simulated
                    ? `Enviar ${selected.size} (simulado)`
                    : `Enviar ${selected.size}`}
              </button>
            </div>

            {sendResult && (
              <div className="banner">
                <div>
                  <strong>
                    {sendResult.dry_run
                      ? 'Simulación completada'
                      : 'Envío completado'}
                  </strong>
                  <ul>
                    {sendResult.results.map((r) => (
                      <li key={r.driver}>
                        {r.ok ? '✅' : '❌'} {r.driver} → {r.to}
                        {r.simulated ? ' (simulado)' : ''}
                        {r.error ? ` — ${r.error}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </div>

          <aside className="card avisos-preview">
            <div className="card-head">
              <h2>Vista previa</h2>
            </div>
            <div className="card-body">
              {focused ? (
                <>
                  <div className="prev-row">
                    <span>Para</span>
                    <span className="mono">{focused.email || '—'}</span>
                  </div>
                  <div className="prev-row">
                    <span>CC</span>
                    <span className="mono">{focused.cc.join(', ') || '—'}</span>
                  </div>
                  <div className="prev-row">
                    <span>Asunto</span>
                    <span>{focused.subject}</span>
                  </div>
                  <pre className="prev-body">{focused.body}</pre>
                </>
              ) : (
                <p className="empty">Elegí un conductor para ver el correo.</p>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
