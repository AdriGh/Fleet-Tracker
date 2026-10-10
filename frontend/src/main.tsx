import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@fontsource-variable/geist/index.css'
import '@fontsource-variable/geist-mono/index.css'
import '@fontsource-variable/space-grotesk/index.css'
import './index.css'
// v2.22: shell (sidebar, palette, menús) + Home — después de index.css.
import './shell.css'
// v2.22 [F]: Resources, Bill to, horómetro y el drawer de POs editable.
import './resources.css'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,        // 1 min "fresco" antes de revalidar
      gcTime: 5 * 60_000,       // 5 min en caché tras dejar de usarse
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </QueryClientProvider>
  </StrictMode>,
)
