import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { hasError: boolean }

/**
 * Error Boundary (FE-2): captura excepciones de render para no mostrar una
 * pantalla en blanco total. Sin esto, un error en cualquier componente tumba
 * toda la app sin rastro para el usuario. Muestra un fallback con "Recargar".
 * Hasta tener Sentry (OBS-1, ver docs/AUDITORIA.md) al menos loguea a consola.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Error de render no capturado:', error, info)
  }

  render() {
    if (!this.state.hasError) return this.props.children
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          padding: 24,
          textAlign: 'center',
          fontFamily: 'system-ui, sans-serif',
          color: '#e5e7eb',
          background: '#0a0a0a',
        }}
      >
        <h1 style={{ fontSize: 20, margin: 0 }}>Algo salió mal</h1>
        <p style={{ opacity: 0.7, margin: 0 }}>
          La aplicación encontró un error inesperado.
        </p>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '10px 20px',
            borderRadius: 8,
            border: 'none',
            background: '#e11900',
            color: 'white',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Recargar
        </button>
      </div>
    )
  }
}
