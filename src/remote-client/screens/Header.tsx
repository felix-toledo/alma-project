// The brand header every phone screen starts with: the Alma mark, served next to
// the shell (vite copies resources/logo.svg into out/remote) and precached by the
// service worker, so it renders offline too.
import { translatePwa, type PwaLanguage } from '../i18n'

export function PwaHeader({ language, title, action }: { language: PwaLanguage; title?: string; action?: React.ReactNode }): React.JSX.Element {
  return (
    <header className="pwa-header">
      <img className="pwa-logo" src="./logo.svg" alt={translatePwa(language, 'remote.pwa.logo.alt')} width={40} height={40} />
      {title && <h1 className="pwa-title">{title}</h1>}
      {action && <div className="pwa-header-action">{action}</div>}
    </header>
  )
}
