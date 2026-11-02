import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Changing it clears the error (e.g. the open file), so another view can render. */
  resetKey?: string
}

/** A failing view shows its error with a retry instead of taking the whole window down (it went black). */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidUpdate(previous: Props): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="vault-empty">
        <p className="text-danger">Algo falló al mostrar esto: {this.state.error.message}</p>
        <div className="row">
          <button className="ghost" onClick={() => this.setState({ error: null })}>
            Reintentar
          </button>
          <button className="ghost" onClick={() => location.reload()}>
            Recargar la ventana
          </button>
        </div>
      </div>
    )
  }
}
