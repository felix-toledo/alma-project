import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { I18nProvider } from './i18n/I18nProvider'
import { playUISound } from './umbra/useUISound'
import { FocusProvider } from './umbra/FocusManager'
import './styles.css'
import './umbra/base.css'
import './umbra/plain-app.css'
import './vault/vault.css'

// Global sounds: any button/link/tab fires hover and select (audio files in umbra/sounds.config.ts)
const INTERACTIVE = 'button:not(:disabled), [role="button"], [role="tab"], a[href]'
document.addEventListener('pointerover', (e) => {
  const el = (e.target as Element).closest(INTERACTIVE)
  if (el && !el.contains(e.relatedTarget as Node | null)) playUISound('hover')
})
document.addEventListener('click', (e) => {
  if ((e.target as Element).closest(INTERACTIVE)) playUISound('select')
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <FocusProvider>
        <App />
      </FocusProvider>
    </I18nProvider>
  </StrictMode>
)
