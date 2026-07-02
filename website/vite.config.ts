import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Sitio de marketing (separado de /frontend, que es la app autenticada).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5175 },
})
