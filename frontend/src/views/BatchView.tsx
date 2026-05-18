import { useRef, useState, type DragEvent } from 'react'
import {
  analyzeBatch,
  downloadUrl,
  generateBatch,
  type BatchAnalyzeResponse,
  type BatchGenerateResponse,
} from '../api'

interface BlockRow {
  company: string
  date_label: string
  dvir_file_id: string
  activity_file_id: string
}

const COMPANIES = ['CHASER', 'MCC']

export default function BatchView() {
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
    setResult(null)
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
      setError(err instanceof Error ? err.message : 'Error al analizar')
    } finally {
      setAnalyzing(false)
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDrag(false)
    handleFiles(Array.from(e.dataTransfer.files))
  }

  function updateBlock(i: number, patch: Partial<BlockRow>) {
    setBlocks((rows) =>
      rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)),
    )
  }

  function removeBlock(i: number) {
    setBlocks((rows) => rows.filter((_, idx) => idx !== i))
  }

  function addBlock() {
    setBlocks((rows) => [
      ...rows,
      {
        company: 'CHASER',
        date_label: '',
        dvir_file_id: '',
        activity_file_id: '',
      },
    ])
  }

  const blocksComplete =
    blocks.length > 0 &&
    blocks.every(
      (b) =>
        b.company &&
        b.date_label.trim() &&
        b.dvir_file_id &&
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
    } catch (err) {
      setResult(null)
      setError(err instanceof Error ? err.message : 'Error al generar')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <>
      {/* ---- Paso 1: archivos del periodo ------------------------- */}
      <section className="card">
        <div className="card-head">
          <span className="step">1</span>
          <h2>Archivos del periodo</h2>
          <span className="sub">Todos los CSV del mes, de una vez</span>
        </div>
        <div className="card-body">
          <input
            ref={fileInput}
            type="file"
            accept=".csv"
            multiple
            hidden
            onChange={(e) =>
              handleFiles(Array.from(e.target.files ?? []))
            }
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
            onDrop={onDrop}
          >
            <svg
              className="dz-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="M17 8l-5-5-5 5" />
              <path d="M12 3v12" />
            </svg>
            {analyzing ? (
              <span className="dz-label">Analizando…</span>
            ) : analysis ? (
              <>
                <span className="dz-file">
                  {analysis.files.length} archivos · {dvirFiles.length} DVIR
                  · {activityFiles.length} actividad
                </span>
                <span className="dz-hint">
                  Haz clic para sustituirlos por otros
                </span>
              </>
            ) : (
              <>
                <span className="dz-label">
                  Arrastra los CSV de DVIR y de actividad
                </span>
                <span className="dz-hint">
                  Varios días y empresas a la vez · solo .csv
                </span>
              </>
            )}
          </div>

          {analysis && analysis.warnings.length > 0 && (
            <div className="banner warn" style={{ marginTop: 16 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2">
                <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0
                  1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
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
            <div className="banner error" style={{ marginTop: 16 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v5M12 16h.01" />
              </svg>
              <span>{error}</span>
            </div>
          )}
        </div>
      </section>

      {/* ---- Paso 2: emparejado y generación ---------------------- */}
      <section className="card">
        <div className="card-head">
          <span className="step">2</span>
          <h2>Emparejado y workbook</h2>
          {analysis && (
            <span className="sub">{blocks.length} bloques</span>
          )}
        </div>
        <div className="card-body">
          {!analysis ? (
            <div className="empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.6">
                <path d="M3 3h18v4H3zM3 10h18v4H3zM3 17h18v4H3z" />
              </svg>
              <p>
                Sube los CSV del periodo y aquí aparecerá el emparejado
                propuesto, día por día y por empresa.
              </p>
            </div>
          ) : (
            <>
              <div className="table-wrap">
                <table className="batch-table">
                  <thead>
                    <tr>
                      <th>Empresa</th>
                      <th>Día</th>
                      <th>CSV de DVIR</th>
                      <th>CSV de actividad</th>
                      <th aria-label="Quitar" />
                    </tr>
                  </thead>
                  <tbody>
                    {blocks.map((b, i) => (
                      <tr key={i}>
                        <td>
                          <select
                            value={b.company}
                            onChange={(e) =>
                              updateBlock(i, { company: e.target.value })
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
                              updateBlock(i, {
                                date_label: e.target.value,
                              })
                            }
                          />
                        </td>
                        <td>
                          <select
                            value={b.dvir_file_id}
                            onChange={(e) =>
                              updateBlock(i, {
                                dvir_file_id: e.target.value,
                              })
                            }
                          >
                            <option value="">— sin asignar —</option>
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
                              updateBlock(i, {
                                activity_file_id: e.target.value,
                              })
                            }
                          >
                            <option value="">— sin asignar —</option>
                            {activityFiles.map((f) => (
                              <option key={f.file_id} value={f.file_id}>
                                {f.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <button
                            className="row-del"
                            title="Quitar bloque"
                            onClick={() => removeBlock(i)}
                          >
                            <svg viewBox="0 0 24 24" fill="none"
                              stroke="currentColor" strokeWidth="2">
                              <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <button className="linkbtn add-block" onClick={addBlock}>
                + Añadir bloque
              </button>

              <div className="actions">
                <button
                  className="btn btn-primary"
                  disabled={!blocksComplete || generating}
                  onClick={handleGenerate}
                >
                  {generating && <span className="spin" />}
                  {generating ? 'Generando…' : 'Generar workbook'}
                </button>
                {!blocksComplete && (
                  <span className="field-hint">
                    Completa empresa, día y los dos CSV de cada bloque.
                  </span>
                )}
              </div>

              {result && (
                <div className="result-box">
                  <div className="stats">
                    {result.sheets.map((s) => (
                      <div className="stat" key={s.sheet_name}>
                        <div className="stat-val">{s.blocks}</div>
                        <div className="stat-label">
                          {s.sheet_name} · {s.drivers} conductores ·{' '}
                          {s.no_dvir} NO DVIR
                        </div>
                      </div>
                    ))}
                  </div>
                  <a
                    className="btn btn-success"
                    href={downloadUrl(result.id)}
                  >
                    <svg viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth="2" width="17"
                      height="17">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <path d="M7 10l5 5 5-5" />
                      <path d="M12 15V3" />
                    </svg>
                    Descargar {result.filename}
                  </a>
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </>
  )
}
