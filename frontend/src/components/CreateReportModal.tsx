import { useRef, useState } from 'react'
import {
  analyzeBatch,
  downloadUrl,
  generateBatch,
  type BatchAnalyzeResponse,
  type BatchGenerateResponse,
} from '../api'
import Modal from './Modal'

interface Props {
  onClose: () => void
  onCreated: () => void
}

interface BlockRow {
  company: string
  date_label: string
  dvir_file_id: string
  activity_file_id: string
}

const COMPANIES = ['CHASER', 'MCC']

export default function CreateReportModal({ onClose, onCreated }: Props) {
  const [analysis, setAnalysis] = useState<BatchAnalyzeResponse | null>(null)
  const [blocks, setBlocks] = useState<BlockRow[]>([])
  const [result, setResult] = useState<BatchGenerateResponse | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)

  const fileInput = useRef<HTMLInputElement>(null)

  const dvirFiles = analysis?.files.filter((f) => f.kind === 'dvir') ?? []
  const activityFiles =
    analysis?.files.filter((f) => f.kind === 'activity') ?? []

  async function handleFiles(files: File[]) {
    const csvs = files.filter((f) => f.name.toLowerCase().endsWith('.csv'))
    if (csvs.length === 0) return
    setAnalyzing(true)
    setError(null)
    try {
      const res = await analyzeBatch(csvs)
      setAnalysis(res)
      setBlocks(
        res.blocks.map((b) => ({
          company: b.company,
          date_label: b.date_label,
          dvir_file_id: b.dvir_file_id,
          activity_file_id: b.activity_file_id,
        })),
      )
    } catch (err) {
      setAnalysis(null)
      setError(err instanceof Error ? err.message : 'Error analyzing')
    } finally {
      setAnalyzing(false)
    }
  }

  function update(i: number, patch: Partial<BlockRow>) {
    setBlocks((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  const complete =
    blocks.length > 0 &&
    blocks.every(
      (b) => b.company && b.date_label.trim() && b.dvir_file_id &&
        b.activity_file_id,
    )

  async function handleGenerate() {
    setGenerating(true)
    setError(null)
    try {
      const res = await generateBatch(
        analysis!.batch_id,
        blocks.map((b) => ({
          company: b.company.trim(),
          date_label: b.date_label.trim(),
          dvir_file_id: b.dvir_file_id,
          activity_file_id: b.activity_file_id,
        })),
      )
      setResult(res)
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error generating')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <Modal title="Create DVIR Report" onClose={onClose} width={760}>
      {result ? (
        <div className="create-result">
          {result.warnings.length > 0 && (
            <div className="banner warn" style={{ marginBottom: 14 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2">
                <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3
                  L13.7 3.9a2 2 0 0 0-3.4 0z" />
                <path d="M12 9v4M12 17h.01" />
              </svg>
              <ul>
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="stats">
            {result.sheets.map((s) => (
              <div className="stat" key={s.sheet_name}>
                <div className="stat-val">{s.blocks}</div>
                <div className="stat-label">
                  {s.sheet_name} · {s.drivers} drivers · {s.no_dvir} NO
                  DVIR
                </div>
              </div>
            ))}
          </div>
          <div className="actions">
            <a className="btn btn-success" href={downloadUrl(result.id)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" width="17" height="17">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <path d="M7 10l5 5 5-5" />
                <path d="M12 15V3" />
              </svg>
              Download {result.filename}
            </a>
            <button className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      ) : (
        <>
          <input
            ref={fileInput}
            type="file"
            accept=".csv"
            multiple
            hidden
            onChange={(e) => handleFiles(Array.from(e.target.files ?? []))}
          />
          <div
            className={`dropzone ${drag ? 'drag' : ''} ${
              analysis ? 'filled' : ''
            }`}
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDrag(true)
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDrag(false)
              handleFiles(Array.from(e.dataTransfer.files))
            }}
          >
            <svg className="dz-icon" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="M17 8l-5-5-5 5" />
              <path d="M12 3v12" />
            </svg>
            {analyzing ? (
              <span className="dz-label">Analyzing…</span>
            ) : analysis ? (
              <>
                <span className="dz-file">
                  {analysis.files.length} files · {dvirFiles.length} DVIR
                  · {activityFiles.length} activity
                </span>
                <span className="dz-hint">Click to replace them</span>
              </>
            ) : (
              <>
                <span className="dz-label">
                  Drag the DVIR and activity CSVs
                </span>
                <span className="dz-hint">
                  One or more days · both companies · .csv only
                </span>
              </>
            )}
          </div>

          {analysis && analysis.warnings.length > 0 && (
            <div className="banner warn" style={{ marginTop: 14 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2">
                <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3
                  L13.7 3.9a2 2 0 0 0-3.4 0z" />
                <path d="M12 9v4M12 17h.01" />
              </svg>
              <ul>
                {analysis.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {error && (
            <div className="banner error" style={{ marginTop: 14 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v5M12 16h.01" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          {analysis && (
            <>
              <p className="modal-note">
                Review the pairing. The <strong>day tag</strong> is
                editable on each row.
              </p>
              <div className="table-wrap" style={{ marginTop: 6 }}>
                <table className="batch-table">
                  <thead>
                    <tr>
                      <th>Company</th>
                      <th>Day</th>
                      <th>DVIR CSV</th>
                      <th>Activity CSV</th>
                    </tr>
                  </thead>
                  <tbody>
                    {blocks.map((b, i) => (
                      <tr key={i}>
                        <td>
                          <select
                            value={b.company}
                            onChange={(e) =>
                              update(i, { company: e.target.value })
                            }
                          >
                            <option value="">—</option>
                            {COMPANIES.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            className="cell-input"
                            value={b.date_label}
                            placeholder="5.18"
                            onChange={(e) =>
                              update(i, { date_label: e.target.value })
                            }
                          />
                        </td>
                        <td>
                          <select
                            value={b.dvir_file_id}
                            onChange={(e) =>
                              update(i, { dvir_file_id: e.target.value })
                            }
                          >
                            <option value="">— unassigned —</option>
                            {dvirFiles.map((f) => (
                              <option key={f.file_id} value={f.file_id}>
                                {f.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select
                            value={b.activity_file_id}
                            onChange={(e) =>
                              update(i, {
                                activity_file_id: e.target.value,
                              })
                            }
                          >
                            <option value="">— unassigned —</option>
                            {activityFiles.map((f) => (
                              <option key={f.file_id} value={f.file_id}>
                                {f.name}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="actions">
                <button
                  className="btn btn-primary"
                  disabled={!complete || generating}
                  onClick={handleGenerate}
                >
                  {generating && <span className="spin" />}
                  {generating ? 'Generating…' : 'Create DVIR Report'}
                </button>
                {!complete && (
                  <span className="field-hint">
                    Complete company, day and both CSVs for each row.
                  </span>
                )}
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  )
}
