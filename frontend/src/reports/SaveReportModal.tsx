// Guardar un reporte (v2.22 [G]): "Save as mine" desde el viewer, "Save
// report" desde el builder y "Edit details" de un guardado propio. Mine =
// solo yo; Organization = toda la org (requiere maint.edit, igual que el
// server). Usa las clases de formulario de Resources (cf-*).
import { useState } from 'react'
import {
  patchSavedReport, saveReport, type ReportSpec, type SavedReport,
} from '../api'
import Modal from '../components/Modal'
import { Button } from '../components/ds'
import { usePerms } from '../perms'
import { notifyErr, notifyOk } from '../toast'

export interface SaveReportModalProps {
  title?: string
  // Guardado existente que se edita (PATCH); sin él se crea uno nuevo.
  savedId?: number | null
  initial: { name: string; description?: string; visibility?: 'mine' | 'org' }
  // Spec a guardar (omitida = solo se editan nombre/descr./visibilidad).
  spec?: ReportSpec | null
  basedOn?: string
  note?: string
  onClose: () => void
  onSaved: (r: SavedReport) => void
}

export default function SaveReportModal({
  title, savedId = null, initial, spec, basedOn = '', note, onClose, onSaved,
}: SaveReportModalProps) {
  const { can } = usePerms()
  const canOrg = can('maint.edit')
  const [name, setName] = useState(initial.name)
  const [desc, setDesc] = useState(initial.description ?? '')
  const [vis, setVis] = useState<'mine' | 'org'>(
    initial.visibility === 'org' && canOrg ? 'org' : initial.visibility ?? 'mine')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    const n = name.trim()
    if (!n) { setErr('Give the report a name.'); return }
    setBusy(true)
    setErr(null)
    try {
      const r = savedId != null
        ? await patchSavedReport(savedId, {
          name: n, description: desc.trim(), visibility: vis,
          ...(spec ? { spec } : {}),
        })
        : await saveReport({
          name: n, description: desc.trim(), visibility: vis,
          spec: spec!, based_on: basedOn,
        })
      notifyOk(savedId != null ? 'Report updated' : 'Report saved',
        vis === 'org' ? 'Shared with your organization' : 'In your reports (Mine)')
      onSaved(r)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Couldn’t save the report')
      notifyErr('Couldn’t save the report', e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={title ?? (savedId != null ? 'Report details' : 'Save report')}
      onClose={onClose} width={520}>
      <form className="cf-form" noValidate
        onSubmit={(e) => { e.preventDefault(); void save() }}>
        <div className="cf-grid">
          <label className="ud-field cf-field is-wide">
            <span>Name *</span>
            <input className="cell-input" value={name} autoFocus maxLength={160}
              aria-invalid={!!err && !name.trim()}
              placeholder="e.g. Brake spend by unit — YTD"
              onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="ud-field cf-field is-wide">
            <span>Description</span>
            <textarea className="cell-input ud-notes" rows={2} value={desc}
              maxLength={400} placeholder="What this report answers (optional)"
              onChange={(e) => setDesc(e.target.value)} />
          </label>
          <div className="ud-field cf-field is-wide" role="radiogroup"
            aria-label="Who can see it">
            <span>Who can see it</span>
            <div className="bt-seg rpx-vis">
              <label className={`bt-opt${vis === 'mine' ? ' is-on' : ''}`}>
                <input type="radio" name="rpt-vis" checked={vis === 'mine'}
                  onChange={() => setVis('mine')} />
                Only me
              </label>
              <label className={`bt-opt${vis === 'org' ? ' is-on' : ''}`}
                title={canOrg ? undefined : 'Sharing with the organization needs work-order edit permission'}>
                <input type="radio" name="rpt-vis" checked={vis === 'org'}
                  disabled={!canOrg} onChange={() => setVis('org')} />
                Organization
              </label>
            </div>
            <span className="field-hint">
              {vis === 'org'
                ? 'Everyone in your organization sees it under Org.'
                : 'Only you see it, under Mine.'}
              {!canOrg && ' Sharing with the organization needs work-order edit permission.'}
            </span>
          </div>
        </div>
        {note && <p className="field-hint rpx-save-note">{note}</p>}
        {err && <p className="field-hint cf-err" role="alert">{err}</p>}
        <div className="sr-form-actions cf-actions">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy}>
            {savedId != null ? 'Save changes' : 'Save report'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
