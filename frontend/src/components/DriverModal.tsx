import { useEffect, useState } from 'react'
import { getDriverHistory, type DriverHistory } from '../api'
import Modal from './Modal'

interface Props {
  name: string
  onClose: () => void
}

function statusClass(status: string): string {
  if (status === 'Safe') return 'safe'
  if (status === 'Resolved') return 'resolved'
  if (status === 'Unsafe') return 'unsafe'
  return ''
}

export default function DriverModal({ name, onClose }: Props) {
  const [data, setData] = useState<DriverHistory | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getDriverHistory(name)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Error'))
  }, [name])

  return (
    <Modal title={`Driver · ${name}`} onClose={onClose} width={620}>
      {error ? (
        <div className="banner error">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v5M12 16h.01" />
          </svg>
          <span>{error}</span>
        </div>
      ) : !data ? (
        <p className="modal-note">Loading…</p>
      ) : (
        <>
          <div className="stats">
            <div className="stat">
              <div className="stat-val">{data.compliance_pct.toFixed(0)}%</div>
              <div className="stat-label">Compliance</div>
            </div>
            <div className="stat">
              <div className="stat-val">{data.ok_days}</div>
              <div className="stat-label">Days with DVIR</div>
            </div>
            <div className="stat warn">
              <div className="stat-val">{data.missed_days}</div>
              <div className="stat-label">Days without DVIR</div>
            </div>
          </div>

          <h3 className="modal-section">Recorded days</h3>
          {data.days.length === 0 ? (
            <p className="modal-note">No records.</p>
          ) : (
            <div className="driver-days">
              {data.days.map((d) => (
                <div className="driver-day" key={`${d.company}-${d.date_label}`}>
                  <span className="dd-date">{d.date_label}</span>
                  <span className="dd-company">{d.company}</span>
                  <span className={`dd-tag ${d.missed ? 'bad' : 'ok'}`}>
                    {d.missed ? '⚠ No DVIR' : '✓ DVIR'}
                  </span>
                </div>
              ))}
            </div>
          )}

          <h3 className="modal-section">
            Reported defects ({data.defects.length})
          </h3>
          {data.defects.length === 0 ? (
            <p className="modal-note">No reported defects.</p>
          ) : (
            <div className="driver-defects">
              {data.defects.map((d, i) => (
                <div className="driver-defect" key={i}>
                  <div className="ddf-head">
                    <span className="ddf-date">{d.date_label}</span>
                    <span className="ddf-unit">{d.unit}</span>
                    <span className={`status-pill ${statusClass(d.status)}`}>
                      {d.status}
                    </span>
                  </div>
                  {d.detail && <p className="ddf-detail">{d.detail}</p>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  )
}
