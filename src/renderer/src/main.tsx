import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { playUISound } from './umbra/useUISound'
import { FocusProvider } from './umbra/FocusManager'
import './styles.css'
import './umbra/base.css'
import './umbra/plain-app.css'
import './vault/vault.css'

// Sonidos globales: cualquier botón/link/tab dispara hover y select (audios en umbra/sounds.config.ts)
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
    <FocusProvider>
      <App />
    </FocusProvider>
  </StrictMode>
)
