// Publishing to Instagram through the website, with the session the user opened in the app's browser.
// The password is typed by the user into Instagram's own page; the app only keeps the session cookies,
// in a partition separate from the rest of the app.
import { app, BrowserWindow, session, type Debugger } from 'electron'
import type { Language } from '../shared/i18n/language'
import type { InstagramStatus } from '../shared/types'
import { instagramLabels } from './instagram-labels'
import { instagramTitle } from './messages'

/** A step of the page driver that failed; its message goes into the result the model reads. */
class StepError extends Error {}

export const INSTAGRAM_PARTITION = 'persist:instagram'
// Overridable only to test the automation against a local stand-in page.
const BASE_URL = (process.env.ALMA_INSTAGRAM_URL ?? 'https://www.instagram.com').replace(/\/$/, '')

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
export function connectInstagram(language: Language, parent?: BrowserWindow): Promise<InstagramStatus> {
  const win = browserWindow(instagramTitle(language, 'connect'), 520, 780, parent)
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
  constructor(
    private dbg: Debugger,
    private language: Language
  ) {}

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
    throw new StepError(`${what} did not appear`)
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
        'a change on the screen'
      ).then(
        () => true,
        () => false
      )
      if (advanced) return
    }
    throw new StepError(`${what} did not respond`)
  }

  async dismissPopups(): Promise<void> {
    for (let i = 0; i < 2; i++) {
      await this.ensureHelpers()
      const point = await this.find('byText', instagramLabels('dismiss', this.language), true)
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
      'the file picker'
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
export async function publishToInstagram(request: PublishRequest, language: Language): Promise<{ ok: boolean; message: string }> {
  if (!(await instagramStatus()).connected) {
    return { ok: false, message: 'There is no Instagram session. Connect it in Settings → Instagram.' }
  }
  const win = browserWindow(instagramTitle(language, request.testMode ? 'test' : 'publishing'), 1180, 900)
  const dbg = win.webContents.debugger
  let step = 'open Instagram'
  let keepOpen = true
  try {
    await win.loadURL(`${BASE_URL}/`)
    dbg.attach('1.3')
    const page = new PageDriver(dbg, language)

    step = 'find the “Create” button'
    await page.waitFor(() => page.evaluate<boolean>('document.readyState === "complete"'), 30_000, 'the page')
    await page.dismissPopups()
    await page.clickAndAdvance('byLabel', instagramLabels('create', language), 30_000, 'the “Create” button')
    await sleep(600)
    // Newer layouts open a small menu (Post / Live / …) before the upload dialog.
    if (await page.find('byText', instagramLabels('post', language))) await page.clickAndAdvance('byText', instagramLabels('post', language), 5_000, 'the “Post” option')

    step = 'upload the image'
    await page.uploadFile(request.imagePath, 20_000)

    step = 'move on to the text'
    for (const stage of ['crop', 'filters']) {
      await page.clickAndAdvance('byText', instagramLabels('next', language), 30_000, `the “Next” button (${stage})`, true)
      await sleep(800)
    }

    step = 'write the text'
    const box = await page.waitFor(() => page.evaluate<{ x: number; y: number } | null>('window.__ma.caption()'), 20_000, 'the text box')
    await page.clickAt(box)
    await dbg.sendCommand('Input.insertText', { text: request.caption })
    await sleep(800)

    if (request.testMode) {
      return {
        ok: true,
        message:
          'Test mode: I left the complete post in the Instagram window without sharing it. Review it; if it is fine, you can click “Share” yourself or close the window. To publish automatically, turn off test mode in Settings → Instagram.'
      }
    }

    step = 'click “Share”'
    // A single click: retrying here could publish the post twice if Instagram is just slow.
    await page.clickAt(await page.stablePoint('byText', instagramLabels('share', language), true, 20_000, 'the “Share” button'))

    step = 'confirm it was published'
    await page.waitFor(() => page.evaluate<boolean>(`window.__ma.succeeded(${JSON.stringify(instagramLabels('success', language))})`), 180_000, "Instagram's confirmation")
    keepOpen = false
    return { ok: true, message: 'Published on Instagram.' }
  } catch (error) {
    const reason = win.isDestroyed() ? 'the window was closed' : (error as Error).message
    return {
      ok: false,
      message: `I could not ${step}: ${reason}. ${win.isDestroyed() ? '' : 'The Instagram window was left open so you can finish by hand. '}Instagram may have changed its page.`
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
