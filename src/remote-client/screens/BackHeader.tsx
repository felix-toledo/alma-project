// The header of a drilled view (a folder, a note, a conversation): a back control, the title and where it sits.
import { ChevronLeft } from 'lucide-react'
import { translatePwa, type PwaLanguage } from '../i18n'

export function BackHeader({ language, title, subtitle, onBack, action }: { language: PwaLanguage; title: string; subtitle?: string; onBack(): void; action?: React.ReactNode }): React.JSX.Element {
  return (
    <header className="pwa-backbar">
      <button type="button" className="pwa-back ghost" aria-label={translatePwa(language, 'remote.pwa.back')} onClick={onBack}>
        <ChevronLeft size={20} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <div className="pwa-backtitle">
        <h1>{title}</h1>
        {subtitle && <p className="pwa-muted">{subtitle}</p>}
      </div>
      {action}
    </header>
  )
}
