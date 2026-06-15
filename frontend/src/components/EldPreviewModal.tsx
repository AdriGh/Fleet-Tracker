import { useState } from 'react'
import Modal from './Modal'
import { eldPreview, type EldPreview } from '../api'

// Herramienta de validacion (fase 2a): trae DVIR + distancia de un dia desde
// el ELD (Samsara) y muestra lo PARSEADO + el raw, para confirmar/ajustar los
// mapeos de campos contra la cuenta real antes de armar el reporte encima.
export default function EldPreviewModal({ onClose }: { onClose: () => void }) {
  const [date, setDate] = useState('')
  const [company, setCompany] = useState('')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<EldPreview | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [showRaw, setShowRaw] = useState(false)

  async function run() {
    if (!date) { setErr('Elegí una fecha'); return }
    setBusy(true)
    setErr(null)
    setRes(null)
    try {
      setRes(await eldPreview(date, company || undefined))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Error')
    } finally {
      setBusy(false)
    }
  }

  const rows = res?.dvir_rows ?? []
  const dist = res?.distance ?? {}

  return (
    <Modal title="Import desde ELD · Preview (beta)" onClose={onClose}
      width={840}>
      <p className="page-sub" style={{ marginTop: 0 }}>
        Trae DVIR + distancia del día desde Samsara y muestra lo que parseó. Si
        algo se ve mal, abrí <b>“Ver raw de Samsara”</b> y pasámelo: con eso
        ajusto los mapeos de campos.
      </p>

      <div style={{
        display: 'flex', gap: 10, alignItems: 'flex-end',
        flexWrap: 'wrap', marginBottom: 14,
      }}>
        <label>
          <span>Fecha</span>
          <input type="date" className="cell-input" value={date}
            onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          <span>Empresa</span>
          <select className="cell-input" value={company}
            onChange={(e) => setCompany(e.target.value)}>
            <option value="">(todas)</option>
            <option value="CHASER">CHASER</option>
            <option value="MCC">MCC</option>
          </select>
        </label>
        <button className="btn btn-primary" onClick={run} disabled={busy}>
          {busy ? 'Trayendo…' : 'Traer'}
        </button>
      </div>

      {err && <div className="banner error"><span>{err}</span></div>}
      {res && !res.available && (
        <div className="banner error">
          <span>{res.detail || 'Samsara no configurado'}</span>
        </div>
      )}
      {res?.errors && res.errors.length > 0 && (
        <div className="banner error"><span>{res.errors.join(' · ')}</span></div>
      )}

      {res?.available && (
        <>
          <div style={{ display: 'flex', gap: 18, margin: '4px 0 10px' }}>
            <b>DVIR: {res.dvir_count}</b>
            <b>Distancia: {res.distance_count} unidades</b>
          </div>
          <div style={{
            maxHeight: 300, overflow: 'auto',
            border: '1px solid var(--border, #e3e7ee)', borderRadius: 8,
          }}>
            <table className="mr-table" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>Vehicle</th><th>Trailer</th><th>Author</th>
                  <th>Status</th><th>Type</th>
                  <th className="num">Distance (mi)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>{r['Vehicle Name'] || '—'}</td>
                    <td>{r['Trailer'] || '—'}</td>
                    <td>{r['Author'] || '—'}</td>
                    <td>{r['Status']}</td>
                    <td>{r['Type'] || '—'}</td>
                    <td className="num">{dist[r['Vehicle Name']] ?? '—'}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={6}
                    style={{ textAlign: 'center', padding: 14 }}>
                    Sin DVIR para ese día / empresa.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          <button className="btn btn-ghost" style={{ marginTop: 10 }}
            onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? 'Ocultar' : 'Ver'} raw de Samsara
          </button>
          {showRaw && (
            <pre style={{
              maxHeight: 260, overflow: 'auto', background: '#0b1020',
              color: '#cbd5e1', padding: 12, borderRadius: 8, fontSize: 11,
              marginTop: 8,
            }}>
              {JSON.stringify(res.raw, null, 2)}
            </pre>
          )}
        </>
      )}
    </Modal>
  )
}
