// URL de la app autenticada (a futuro: app.fleettracker.com). Hoy apunta al
// deploy vivo en el VPS. El CTA "Start free" y "Log in" mandan aca.
export const APP_URL =
  'https://fleet-tracker-fleettracker-pov0zh-95b032-187-77-255-150.sslip.io'

// Fotos reales de flota (Unsplash) que la app ya usa en el login: on-brand y
// permitidas por la CSP (images.unsplash.com). Se reusan en el sitio.
export const PHOTOS = {
  // El hero la renderiza al 16% de opacidad como fondo: no hace falta 1600px/q80
  highway:
    'https://images.unsplash.com/photo-1601584115197-04ecc0da31d7?auto=format&fit=crop&w=1200&q=60',
  terminal:
    'https://images.unsplash.com/photo-1519003722824-194d4455a60c?auto=format&fit=crop&w=1600&q=80',
  cab:
    'https://images.unsplash.com/photo-1586191582151-f73872dfd183?auto=format&fit=crop&w=1600&q=80',
  fleet:
    'https://images.unsplash.com/photo-1591768793355-74d04bb6608f?auto=format&fit=crop&w=1600&q=80',
}
