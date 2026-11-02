import { cpSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/**
 * Excalidraw loads its fonts from a CDN unless told otherwise: copy them into the renderer's public folder so drawings
 * work offline (the window sets EXCALIDRAW_ASSET_PATH to ./excalidraw/). Xiaolai (13 MB of CJK glyphs) is left out.
 */
function excalidrawFonts(): Plugin {
  return {
    name: 'alma-excalidraw-fonts',
    buildStart() {
      const target = resolve(__dirname, 'src/renderer/public/excalidraw/fonts')
      if (existsSync(target)) return
      const source = resolve(__dirname, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts')
      cpSync(source, target, { recursive: true, filter: (path) => !/[\\/]Xiaolai([\\/]|$)/.test(path) })
    }
  }
}

export default defineConfig({
  main: {
    build: {
      rolldownOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // The agent coordinator runs as an Electron utilityProcess.
          coordinator: resolve(__dirname, 'src/coordinator/index.ts'),
          // bge-m3 runs in a worker thread of the coordinator (see knowledge/embedder.ts).
          embedWorker: resolve(__dirname, 'src/coordinator/knowledge/embed-worker.ts'),
          // Wake word, Whisper, speaker check and Kokoro (see voice/assistant.ts).
          voiceWorker: resolve(__dirname, 'src/coordinator/voice/voice-worker.ts')
        }
      }
    }
  },
  preload: {},
  renderer: {
    plugins: [react(), excalidrawFonts()],
    // Excalidraw loads lazily; without this, dev mode discovered it on the first drawing, re-optimized mid-import and
    // the import failed (the whole window went black).
    optimizeDeps: { include: ['@excalidraw/excalidraw', '@excalidraw/mermaid-to-excalidraw'] }
  }
})
