// Galería de evidencia fotográfica (v2.14, elemento 01 del board): grid de
// thumbnails + subir varios + lightbox + borrar. Reutilizable: la misma
// galería vive en la fila de defecto (DefectsPage) y en el drawer de la WO
// (con `phase` para separar Before/After).
//
// Las imágenes bajan por fetch → blob → objectURL (patrón UnitPhoto: un
// <img src="/api/..."> pelado no pasa por el wrapper de fetch de api.ts) y
// el objectURL se cachea por sesión con react-query.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  deleteEvidencePhoto, fetchEvidencePhotoUrl, listEvidencePhotos,
  uploadEvidencePhotos,
  type EvidenceParent, type EvidencePhase, type EvidencePhoto,
} from '../api'
import { notifyErr, notifyOk } from '../toast'
import { usePerms } from '../perms'

// Hooks exportados para que otros consumidores (el comparador Before/After
// del WoDrawer) compartan exactamente la misma caché que la galería.
export function useEvidenceList(
  parent: EvidenceParent, parentId: number, enabled = true,
) {
  return useQuery({
    queryKey: ['evidence', parent, parentId],
    queryFn: () => listEvidencePhotos(parent, parentId),
    enabled,
  })
}

export function useEvidencePhotoUrl(photoId: number | null) {
  return useQuery({
    queryKey: ['evidence-photo', photoId],
    queryFn: () => fetchEvidencePhotoUrl(photoId!),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
    enabled: photoId != null,
  })
}

function Thumb({ photo, onOpen, onDelete }: {
  photo: EvidencePhoto
  onOpen: () => void
  onDelete?: () => void
}) {
  const q = useEvidencePhotoUrl(photo.id)
  return (
    <span className="ev-thumb-wrap">
      <button type="button" className="ev-thumb" onClick={onOpen}
        title={photo.note || photo.filename}>
        {q.data ? (
          <img src={q.data} alt={photo.note || photo.filename} />
        ) : (
          <span className="ev-thumb-ph" aria-hidden="true" />
        )}
        {photo.phase !== 'report' && (
          <span className={`ev-phase p-${photo.phase}`}>{photo.phase}</span>
        )}
      </button>
      {onDelete && (
        <button type="button" className="ev-del" title="Delete photo"
          aria-label="Delete photo"
          onClick={(e) => { e.stopPropagation(); onDelete() }}>
          ✕
        </button>
      )}
    </span>
  )
}

// Lightbox por portal: el WoDrawer (vaul) transforma su contenido y un
// position:fixed adentro quedaría atrapado en el panel — en <body> cubre
// la pantalla de verdad. Click en cualquier lado o Esc cierran.
function Lightbox({ photo, onClose }: {
  photo: EvidencePhoto
  onClose: () => void
}) {
  const q = useEvidencePhotoUrl(photo.id)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="ev-lightbox" role="dialog" aria-modal="true"
      aria-label={photo.filename} onClick={onClose}>
      <div className="ev-lightbox-inner">
        {q.data && <img src={q.data} alt={photo.note || photo.filename} />}
        <div className="ev-lightbox-cap">
          <strong>{photo.filename}</strong>
          {photo.phase !== 'report' && (
            <span className={`ev-phase p-${photo.phase}`}>{photo.phase}</span>
          )}
          <span className="ev-lightbox-date mono">
            {photo.uploaded_at.slice(0, 10)}
          </span>
          {photo.note && <span className="ev-lightbox-note">{photo.note}</span>}
        </div>
      </div>
    </div>,
    document.body,
  )
}

export default function EvidenceGallery({
  parent, parentId, phase, addLabel,
}: {
  parent: EvidenceParent
  parentId: number
  /** Si viene, la galería muestra y sube SOLO esa fase (Before/After). */
  phase?: EvidencePhase
  addLabel?: string
}) {
  const qc = useQueryClient()
  const { can } = usePerms()
  const canEdit = can('maint.edit')
  const listQ = useEvidenceList(parent, parentId)
  const photos = (listQ.data ?? [])
    .filter((p) => !phase || p.phase === phase)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [lightbox, setLightbox] = useState<EvidencePhoto | null>(null)

  function refresh() {
    qc.invalidateQueries({ queryKey: ['evidence', parent, parentId] })
    // Los chips de la lista de defectos comparten este prefijo de caché.
    qc.invalidateQueries({ queryKey: ['evidence-counts'] })
  }

  async function onPick(list: FileList | null) {
    if (!list || list.length === 0) return
    setBusy(true)
    try {
      await uploadEvidencePhotos(parent, parentId, [...list],
        phase ?? 'report')
      refresh()
      notifyOk(list.length > 1
        ? `${list.length} photos added` : 'Photo added')
    } catch (e) {
      notifyErr("Couldn't upload photo", e)
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function onDelete(p: EvidencePhoto) {
    if (!window.confirm('Delete this photo?')) return
    try {
      await deleteEvidencePhoto(p.id)
      if (lightbox?.id === p.id) setLightbox(null)
      refresh()
    } catch (e) {
      notifyErr("Couldn't delete photo", e)
    }
  }

  return (
    <div className="ev-gallery">
      {photos.map((p) => (
        <Thumb key={p.id} photo={p} onOpen={() => setLightbox(p)}
          onDelete={canEdit ? () => onDelete(p) : undefined} />
      ))}
      {canEdit && (
        <button type="button" className="ev-add" disabled={busy}
          onClick={() => fileRef.current?.click()}
          title="JPG, PNG or WEBP · max 12 MB each">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
            width="16" height="16" aria-hidden="true">
            <path d="M4 8h3l2-2h6l2 2h3v11H4z" />
            <circle cx="12" cy="13" r="3.2" />
          </svg>
          <span>{busy ? 'Uploading…' : (addLabel ?? 'Add photo')}</span>
        </button>
      )}
      {!canEdit && photos.length === 0 && (
        <span className="ev-empty">No photos</span>
      )}
      <input ref={fileRef} type="file" hidden multiple
        accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
        onChange={(e) => onPick(e.target.files)} />
      {lightbox && (
        <Lightbox photo={lightbox} onClose={() => setLightbox(null)} />
      )}
    </div>
  )
}
