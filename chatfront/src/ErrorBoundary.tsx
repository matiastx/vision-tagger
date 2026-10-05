import React from 'react'

/**
 * ErrorBoundary: si el SPA explota (como el bug F5 del loadJSON que dejaba
 * la página negra), en vez de una pantalla vacía mostramos el error y un
 * botón para limpiar los datos locales de la página y reentrar.
 */
interface State {
  error: Error | null
}

export default class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('[ChatLocal] UI crash:', error)
  }

  private reset = () => {
    try {
      // Limpiar TODO el estado local (settings, conversaciones, auth, lockout)
      localStorage.removeItem('chatlocal:settings')
      localStorage.removeItem('chatlocal:conversations')
      localStorage.removeItem('chatlocal:auth')
      localStorage.removeItem('chatlocal:lockout-until')
    } finally {
      window.location.reload()
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-eva-background px-4">
          <div className="w-full max-w-md rounded-2xl border border-eva-error/40 bg-eva-surface p-6 text-center">
            <p className="mb-2 text-4xl">😵</p>
            <h1 className="mb-2 text-lg font-bold text-eva-error">Algo se rompió</h1>
            <p className="mb-4 break-words text-xs text-eva-text-muted">
              {this.state.error.message}
            </p>
            <button
              onClick={this.reset}
              className="w-full rounded-lg bg-eva-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-eva-primary-dark"
            >
              Limpiar datos de la página y reintentar
            </button>
            <p className="mt-3 text-[11px] text-eva-text-faint">
              Esto borra las conversaciones guardadas en este navegador.
            </p>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
