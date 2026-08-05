import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Modal from './Modal'
import {
  eldImport, eldPreview, listCompanies, type EldPreview,
} from '../api'

// Import desde el ELD: trae DVIR + distancia de un dia, muestra lo
// PARSEADO (preview de validacion) y permite importarlo a Recent DVIRs. El
// pre-trip llega en 2c; por ahora arma el reporte sin esa columna.
export default function EldPreviewModal(
  { onClose, onImported }: { onClose: () => void; onImported?: () => void },
) {
  // Arranca en HOY: antes nacia vacia y habia que tipear la fecha entera.
  const [date, setDate] = useState(
    () => new Date().toISOString().slice(0, 10))
  const [company, setCompany] = useState('')
  const [template, setTemplate] = useState('standard')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<EldPreview | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const [importing, setImporting] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  // Empresas REALES de la app. Antes el selector tenia dos hardcodeadas
  // ('Demo Co', 'Demo Logistics') que no existian en ningun dato: elegir
  // cualquiera de las dos filtraba por una empresa inexistente y el preview
  // devolvia 0 DVIR / 0 distancia / 0 pre-trip sin decir por que.
  const companiesQ = useQuery({
    queryKey: ['companies'], queryFn: listCompanies,
  })
  const companies = companiesQ.data ?? []

  async function run() {
    if (!date) { setErr('Elegí una fecha'); return }
    setBusy(true)
    setErr(null)
    setRes(null)
    setDone(null)
    try {
      setRes(await eldPreview(date, company || undefined))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Error')
    } finally {
      setBusy(false)
    }
  }

  async function doImport() {
    if (!company) { setErr('Elegí una empresa para importar'); return }
    setImporting(true)
    setErr(null)
    try {
      const r = await eldImport(date, company, template)
      setDone(`Importado: ${r.company} ${r.date_label} · `
        + `${r.n_reports} con DVIR · ${r.n_no_dvir} NO DVIR`)
      onImported?.()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'No se pudo importar')
    } finally {
      setImporting(false)
    }
  }

  const hasData = !!res?.available
    && ((res.dvir_count ?? 0) > 0 || (res.distance_count ?? 0) > 0)

  const rows = res?.dvir_rows ?? []
  const dist = res?.distance ?? {}

  return (
    <Modal title="Import desde ELD · Preview (beta)" onClose={onClose}
      width={840}>
      <p className="page-sub" style={{ marginTop: 0 }}>
        Trae DVIR + distancia del día desde el ELD y muestra lo que parseó. Si
        algo se ve mal, abrí <b>“Ver raw del ELD”</b> y pasámelo: con eso
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
            {companies.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Plantilla</span>
          <select className="cell-input" value={template}
            onChange={(e) => setTemplate(e.target.value)}>
            <option value="standard">Standard (con Pre-trip)</option>
            <option value="legacy">Legacy (DVIR + Activity)</option>
          </select>
        </label>
        <button className="btn btn-primary" onClick={run} disabled={busy}>
          {busy ? 'Trayendo…' : 'Traer'}
        </button>
      </div>

      {err && <div className="banner error"><span>{err}</span></div>}
      {res && !res.available && (
        <div className="banner error">
          <span>{res.detail || 'ELD no configurado'}</span>
        </div>
      )}
      {res?.errors && res.errors.length > 0 && (
        <div className="banner error"><span>{res.errors.join(' · ')}</span></div>
      )}

      {done && <div className="banner success"><span>{done}</span></div>}

      {res?.available && !hasData && (
        <div className="banner">
          <span>
            El ELD no devolvió datos de {company || 'esa empresa'} para ese
            día. Si la empresa no está en el ELD, usá{' '}
            <b>Create DVIR Report</b> con los archivos.
          </span>
        </div>
      )}

      {res?.demo && (
        <div className="banner warn">
          <span>Datos <b>demo</b> (sintéticos) — no hay un ELD real
            conectado.</span>
        </div>
      )}

      {res?.available && (
        <>
          <div style={{
            display: 'flex', gap: 18, margin: '4px 0 10px',
            alignItems: 'center',
          }}>
            <b>DVIR: {res.dvir_count}</b>
            <b>Distancia: {res.distance_count} unidades</b>
            <b>Pre-trip: {res.pretrip_count ?? 0}</b>
            <button className="btn btn-primary"
              style={{ marginLeft: 'auto' }}
              onClick={doImport}
              disabled={importing || !hasData || !company}
              title={!company ? 'Elegí una empresa para importar' : ''}>
              {importing ? 'Importando…' : 'Importar a Recent DVIRs'}
            </button>
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
            {showRaw ? 'Ocultar' : 'Ver'} raw del ELD
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
