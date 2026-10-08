// Helpers del roster de técnicos (v2.21). Módulo sin componentes para
// compartir con TechnicianPicker y la sección Technicians de Settings.

// Iniciales para el avatar ("Juan Pérez" → "JP"; "Mike" → "M").
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  const a = parts[0][0] ?? ''
  const b = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : ''
  return (a + b).toUpperCase()
}
