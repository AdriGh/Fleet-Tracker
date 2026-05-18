import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// El backend FastAPI corre en el puerto 8765. En desarrollo, Vite
// redirige /api hacia el para evitar problemas de CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8765',
    },
  },
})
