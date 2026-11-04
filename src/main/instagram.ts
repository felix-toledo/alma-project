// Publishing to Instagram through the website, with the session the user opened in the app's browser.
// The password is typed by the user into Instagram's own page; the app only keeps the session cookies,
// in a partition separate from the rest of the app.
import { app, BrowserWindow, session, type Debugger } from 'electron'
import type { InstagramStatus } from '../shared/types'

export const INSTAGRAM_PARTITION = 'persist:instagram'
// Overridable only to test the automation against a local stand-in page.
const BASE_URL = (process.env.ALMA_INSTAGRAM_URL ?? 'https://www.instagram.com').replace(/\/$/, '')

// Instagram's interface strings in the languages the user is likely to have (en, es, pt).
const CREATE_LABELS = ['New post', 'Create', 'Nueva publicación', 'Crear', 'Nova publicação', 'Criar']
const POST_LABELS = ['Post', 'Publicación', 'Publicar', 'Publicação']
const NEXT_LABELS = ['Next', 'Siguiente', 'Avançar']
const SHARE_LABELS = ['Share', 'Compartir', 'Compartilhar']
const DISMISS_LABELS = ['Not Now', 'Not now', 'Ahora no', 'Agora não', 'OK']
const SUCCESS_TEXTS = [
  'your post has been shared',
  'post shared',
  'se compartió tu publicación',
  'se ha compartido tu publicación',
  'tu publicación se ha compartido',
  'publicación compartida',
  'seu post foi compartilhado',
  'publicação compartilhada'
]

function instagramSession(): Electron.Session {
  const ses = session.fromPartition(INSTAGRAM_PARTITION)
  // Present as the plain Chrome this is, without the app and Electron tokens.
  ses.setUserAgent(app.userAgentFallback.replace(/\s(Alma|alma|Electron)\/\S+/g, ''))
  return ses
}

export async function instagramStatus(): Promise<InstagramStatus> {
  const cookies = await instagramSession().cookies.get({ url: BASE_URL, name: 'sessionid' })
  return { connected: cookies.some((cookie) => !!cookie.value) }
}

function browserWindow(title: string, width: number, height: number, parent?: BrowserWindow): BrowserWindow {
  return new BrowserWindow({
    width,
    height,
    title,
    parent,
    autoHideMenuBar: true,
    webPreferences: { session: instagramSession(), contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
}

/** Opens Instagram's login page; the window closes by itself once the session exists. */
export function connectInstagram(parent?: BrowserWindow): Promise<InstagramStatus> {
  const win = browserWindow('Conectar Instagram', 520, 780, parent)
  void win.loadURL(`${BASE_URL}/accounts/login/`)
  const timer = setInterval(async () => {
    if (win.isDestroyed()) return
    if ((await instagramStatus()).connected) {
      clearInterval(timer)
      setTimeout(() => !win.isDestroyed() && win.close(), 1200)
    }
  }, 1500)
  return new Promise((resolve) => {
    win.on('closed', () => {
      clearInterval(timer)
      void instagramStatus().then(resolve)
    })
  })
}

export async function disconnectInstagram(): Promise<InstagramStatus> {
  await instagramSession().clearStorageData()
  return instagramStatus()
}

// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Helpers injected into the page. They only read the DOM and report positions; clicks come from CDP input. */
const PAGE_HELPERS = `
window.__ma = {
  visible(el) {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'
  },
  center(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  },
  scope(inDialog) {
    if (!inDialog) return document
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((d) => this.visible(d))
    return dialogs[dialogs.length - 1] || document
  },
  byText(texts, inDialog) {
    const wanted = texts.map((t) => t.toLowerCase())
    const nodes = [...this.scope(inDialog).querySelectorAll('button, [role="button"], a, div, span')]
    const matches = nodes.filter((el) => wanted.includes((el.textContent || '').trim().toLowerCase()) && this.visible(el))
    const target = matches.find((el) => el.matches('button, [role="button"], a')) || matches[matches.length - 1]
    return target ? this.center(target) : null
  },
  byLabel(labels) {
    const icon = [...document.querySelectorAll('svg[aria-label]')].find(
      (svg) => labels.includes(svg.getAttribute('aria-label')) && this.visible(svg)
    )
    const target = icon && (icon.closest('a, [role="button"], button') || icon)
    return target ? this.center(target) : null
  },
  caption() {
    const box = this.scope(true).querySelector('div[contenteditable="true"], textarea')
    if (!box) return null
    box.focus()
    return this.center(box)
  },
  succeeded(texts) {
    const body = (document.body.innerText || '').toLowerCase()
    return texts.some((t) => body.includes(t))
  },
  /** What the user currently sees: the open dialog, or the whole page. Used to confirm a click advanced. */
  screenText() {
    const scope = this.scope(true)
    return (scope === document ? document.body : scope).innerText || ''
  }
}
true
`

class PageDriver {
  constructor(private dbg: Debugger) {}

  async evaluate<T>(expression: string): Promise<T> {
    const result = (await this.dbg.sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })) as { result: { value: T }; exceptionDetails?: { text: string } }
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }

  async ensureHelpers(): Promise<void> {
    if (!(await this.evaluate<boolean>('!!window.__ma'))) await this.evaluate(PAGE_HELPERS)
  }

  async waitFor<T>(probe: () => Promise<T | null | false>, timeoutMs: number, what: string): Promise<T> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await this.ensureHelpers()
      const value = await probe()
      if (value) return value
      await sleep(500)
    }
    throw new Error(`no apareció ${what}`)
  }

  async clickAt(point: { x: number; y: number }): Promise<void> {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
      await this.dbg.sendCommand('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
    }
  }

  find(kind: 'byText' | 'byLabel', labels: string[], inDialog = false): Promise<{ x: number; y: number } | null> {
    return this.evaluate(`window.__ma.${kind}(${JSON.stringify(labels)}, ${inDialog})`)
  }

  /** Waits until the element is visible and stops moving (images loading above it shift the layout). */
  stablePoint(kind: 'byText' | 'byLabel', labels: string[], inDialog: boolean, timeoutMs: number, what: string): Promise<{ x: number; y: number }> {
    return this.waitFor(
      async () => {
        const first = await this.find(kind, labels, inDialog)
        if (!first) return null
        await sleep(300)
        const second = await this.find(kind, labels, inDialog)
        return second && Math.abs(first.x - second.x) < 2 && Math.abs(first.y - second.y) < 2 ? second : null
      },
      timeoutMs,
      what
    )
  }

  /** Clicks and confirms the screen moved on; retries a click that didn't take. */
  async clickAndAdvance(kind: 'byText' | 'byLabel', labels: string[], timeoutMs: number, what: string, inDialog = false): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.ensureHelpers()
      const before = await this.evaluate<string>('window.__ma.screenText()')
      await this.clickAt(await this.stablePoint(kind, labels, inDialog, timeoutMs, what))
      const advanced = await this.waitFor(
        async () => (await this.evaluate<string>('window.__ma.screenText()')) !== before,
        6_000,
        'un cambio en la pantalla'
      ).then(
        () => true,
        () => false
      )
      if (advanced) return
    }
    throw new Error(`${what} no respondió`)
  }

  async dismissPopups(): Promise<void> {
    for (let i = 0; i < 2; i++) {
      await this.ensureHelpers()
      const point = await this.find('byText', DISMISS_LABELS, true)
      if (!point) return
      await this.clickAt(point)
      await sleep(600)
    }
  }

  /** Sets a file on the page's file input, the way choosing it in the system dialog would. */
  async uploadFile(path: string, timeoutMs: number): Promise<void> {
    const nodeId = await this.waitFor(
      async () => {
        const { root } = (await this.dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true })) as { root: { nodeId: number } }
        const { nodeId } = (await this.dbg.sendCommand('DOM.querySelector', {
          nodeId: root.nodeId,
          selector: 'input[type="file"]'
        })) as { nodeId: number }
        return nodeId || null
      },
      timeoutMs,
      'el selector de archivos'
    )
    await this.dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: [path] })
  }
}

export interface PublishRequest {
  imagePath: string
  caption: string
  /** Fill in everything but never click "Compartir". */
  testMode: boolean
}

/**
 * Publishes one post through the Instagram website in a visible window, so the user can watch it.
 * On failure the window stays open at the step that failed, so the user can finish by hand.
 */
export async function publishToInstagram(request: PublishRequest): Promise<{ ok: boolean; message: string }> {
  if (!(await instagramStatus()).connected) {
    return { ok: false, message: 'No hay una sesión de Instagram. Conectala en Configuración → Instagram.' }
  }
  const win = browserWindow(request.testMode ? 'Instagram · modo de prueba' : 'Instagram · publicando…', 1180, 900)
  const dbg = win.webContents.debugger
  let step = 'abrir Instagram'
  let keepOpen = true
  try {
    await win.loadURL(`${BASE_URL}/`)
    dbg.attach('1.3')
    const page = new PageDriver(dbg)

    step = 'encontrar el botón «Crear»'
    await page.waitFor(() => page.evaluate<boolean>('document.readyState === "complete"'), 30_000, 'la página')
    await page.dismissPopups()
    await page.clickAndAdvance('byLabel', CREATE_LABELS, 30_000, 'el botón «Crear»')
    await sleep(600)
    // Newer layouts open a small menu (Post / Live / …) before the upload dialog.
    if (await page.find('byText', POST_LABELS)) await page.clickAndAdvance('byText', POST_LABELS, 5_000, 'la opción «Publicación»')

    step = 'subir la imagen'
    await page.uploadFile(request.imagePath, 20_000)

    step = 'avanzar al texto'
    for (const stage of ['recorte', 'filtros']) {
      await page.clickAndAdvance('byText', NEXT_LABELS, 30_000, `el botón «Siguiente» (${stage})`, true)
      await sleep(800)
    }

    step = 'escribir el texto'
    const box = await page.waitFor(() => page.evaluate<{ x: number; y: number } | null>('window.__ma.caption()'), 20_000, 'el cuadro de texto')
    await page.clickAt(box)
    await dbg.sendCommand('Input.insertText', { text: request.caption })
    await sleep(800)

    if (request.testMode) {
      return {
        ok: true,
        message:
          'Modo de prueba: dejé el post completo en la ventana de Instagram sin compartirlo. Revisalo; si está bien, podés tocar «Compartir» vos mismo o cerrar la ventana. Para publicar automáticamente, desactivá el modo de prueba en Configuración → Instagram.'
      }
    }

    step = 'tocar «Compartir»'
    // A single click: retrying here could publish the post twice if Instagram is just slow.
    await page.clickAt(await page.stablePoint('byText', SHARE_LABELS, true, 20_000, 'el botón «Compartir»'))

    step = 'confirmar que se publicó'
    await page.waitFor(() => page.evaluate<boolean>(`window.__ma.succeeded(${JSON.stringify(SUCCESS_TEXTS)})`), 180_000, 'la confirmación de Instagram')
    keepOpen = false
    return { ok: true, message: 'Publicado en Instagram.' }
  } catch (error) {
    const reason = win.isDestroyed() ? 'se cerró la ventana' : (error as Error).message
    return {
      ok: false,
      message: `No pude ${step}: ${reason}. ${win.isDestroyed() ? '' : 'La ventana de Instagram quedó abierta para que termines a mano. '}Instagram puede haber cambiado su página.`
    }
  } finally {
    if (!win.isDestroyed()) {
      try {
        dbg.detach()
      } catch {
        // already detached
      }
      if (!keepOpen) setTimeout(() => !win.isDestroyed() && win.close(), 2500)
    }
  }
}
