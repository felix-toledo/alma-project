import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/outfit'
import { App } from './App'
import './pwa.css'

const root = document.getElementById('root')
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>)

if ('serviceWorker' in navigator) void navigator.serviceWorker.register('./sw.js').catch(() => undefined)
