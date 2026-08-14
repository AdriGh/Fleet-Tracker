// Foto de identidad de una unidad (v2.13). El <img> no puede apuntar directo
// al endpoint (no llevaría el Bearer del middleware), así que se baja por
// fetch → blob y el objectURL se cachea por sesión con react-query. Si la
// unidad no tiene foto (o el fetch falla) se muestra un placeholder honesto:
// superficie neutra + icono de cámara, nada de siluetas dibujadas.
import { useQuery } from '@tanstack/react-query'
import { fetchUnitPhotoUrl } from '../api'

export default function UnitPhoto({ unit, alt, className, enabled = true }: {
  unit: string
  alt?: string
  className?: string
  /** false = ni intenta el fetch (la unidad no está en el índice de fotos):
   *  placeholder directo, cero requests. */
  enabled?: boolean
}) {
  const q = useQuery({
    queryKey: ['unit-photo', unit],
    queryFn: () => fetchUnitPhotoUrl(unit),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
    enabled,
  })
  if (!q.data) {
    return (
      <div className={`unit-photo-ph ${className ?? ''}`} aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
          width="22" height="22">
          <path d="M4 8h3l2-2h6l2 2h3v11H4z" />
          <circle cx="12" cy="13" r="3.2" />
        </svg>
      </div>
    )
  }
  return <img className={className} src={q.data} alt={alt ?? `Unit ${unit}`} />
}
