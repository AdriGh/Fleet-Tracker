// Bloque "esqueleto" con shimmer para estados de carga.
export default function Skeleton(
  { w, h = 14, r = 6, className = '' }:
  { w?: number | string; h?: number | string; r?: number; className?: string },
) {
  return (
    <span
      className={`skel ${className}`}
      style={{
        width: typeof w === 'number' ? `${w}px` : (w ?? '100%'),
        height: typeof h === 'number' ? `${h}px` : h,
        borderRadius: r,
      }}
    />
  )
}
