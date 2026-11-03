// Rasterizes Alma's composed SVGs to PNG. The SVG is drawn as an image onto a canvas of the exact size, in a
// hidden window with no network: the SVG's own content never runs code, and the result doesn't depend on the
// screen (a window taller than the screen would be clipped).
import { BrowserWindow, session } from 'electron'
import { writeFile } from 'node:fs/promises'
import type { HostRequest } from '../shared/types'

// Runs inside the render window. ponytail: fixed 300 ms wait so the embedded fonts are applied before drawing.
const RASTERIZE = `async (svg, width, height) => {
  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await img.decode()
  await new Promise((resolve) => setTimeout(resolve, 300))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d').drawImage(img, 0, 0, width, height)
  return canvas.toDataURL('image/png')
}`

let sessionReady = false

export async function renderSvgToPng(request: Extract<HostRequest, { action: 'image.render' }>): Promise<{ ok: boolean; message: string }> {
  const { svg, width, height, outPath } = request
  const ses = session.fromPartition('alma-render')
  if (!sessionReady) {
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(data|about):/.test(details.url) }))
    sessionReady = true
  }
  // A window per render: a hidden window left open would keep the app from quitting when its last window closes.
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  try {
    await win.loadURL('about:blank')
    let dataUrl: string
    try {
      dataUrl = await win.webContents.executeJavaScript(`(${RASTERIZE})(${JSON.stringify(svg)}, ${width}, ${height})`)
    } catch {
      return { ok: false, message: 'el SVG no es válido (si usaste svg_overlay, revisá que esté bien formado)' }
    }
    await writeFile(outPath, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
    return { ok: true, message: outPath }
  } finally {
    win.destroy()
  }
}
