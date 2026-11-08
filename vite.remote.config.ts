import { copyFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * The phone PWA (PD-4): built independent of its origin (base './', no hard-coded
 * host, AC-3.8) into out/remote, served by the coordinator over Tailscale Serve.
 */

/** The manifest icon lives in resources/ with the app's other art; copy it next to the build. */
function brandIcon(): Plugin {
  let outDir = resolve(__dirname, 'out/remote')
  return {
    name: 'alma-pwa-icon',
    configResolved(config) {
      if (config.build?.outDir) outDir = config.build.outDir
    },
    closeBundle() {
      copyFileSync(resolve(__dirname, 'resources/logo.svg'), resolve(outDir, 'logo.svg'))
    }
  }
}

export default defineConfig({
  root: resolve(__dirname, 'src/remote-client'),
  base: './',
  define: { __APP_VERSION__: JSON.stringify((JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }).version) },
  plugins: [react(), brandIcon()],
  build: {
    outDir: resolve(__dirname, 'out/remote'),
    emptyOutDir: true
  }
})
