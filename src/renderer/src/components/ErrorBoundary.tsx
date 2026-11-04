import { Component, type ReactNode } from 'react'
import { translate } from '../../../shared/i18n/messages'
import { I18nContext } from '../i18n/I18nProvider'

interface Props {
  children: ReactNode
  /** Changing it clears the error (e.g. the open file), so another view can render. */
  resetKey?: string
}

/** A failing view shows its error with a retry instead of taking the whole window down (it went black). */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  // A class component cannot use the useT hook: it reads the language from the context directly.
  static contextType = I18nContext
  declare context: React.ContextType<typeof I18nContext>
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidUpdate(previous: Props): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    const t = (key: 'error.shown' | 'error.retry' | 'error.reload'): string => translate(this.context.language, key)
    return (
      <div className="vault-empty">
        <p className="text-danger">{t('error.shown')} {this.state.error.message}</p>
        <div className="row">
          <button className="ghost" onClick={() => this.setState({ error: null })}>
            {t('error.retry')}
          </button>
          <button className="ghost" onClick={() => location.reload()}>
            {t('error.reload')}
          </button>
        </div>
      </div>
    )
  }
}
