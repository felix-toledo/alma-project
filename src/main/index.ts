import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  MessageChannelMain,
  net,
  Notification,
  protocol,
  session,
  shell,
  Tray,
  utilityProcess,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type UtilityProcess
} from 'electron'
import { cpSync, existsSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  CoordinatorToParent,
  HostRequest,
  ParentToCoordinator,
  PublicSettings,
  RemoteSettings,
  SecretProviderId,
  Settings
} from '../shared/types'
import { audit, initAudit } from '../shared/audit'
import { planRemoteChange, stripRemotePatch } from '../shared/remote/confirmations'
import { newCommands } from './guard'
import { connectInstagram, disconnectInstagram, instagramStatus, publishToInstagram } from './instagram'
import { hostConfirmation, mainError, REMOTE_OPEN_URLS, remoteDialog, securityDialog, trayMenu, trayState } from './messages'
import { movedExclusions } from './remote-exclusions'
import { renderSvgToPng } from './render'
import { decrypt, encrypt, SettingsStore } from './settings'

// Separate profile (settings + conversations) for testing or portable use.
if (process.env.ALMA_USER_DATA) app.setPath('userData', process.env.ALMA_USER_DATA)

// Alma used to be called MultiAgente: carry its conversations, settings (with the key that decrypts the API keys)
// and Instagram session over once. Runs before Chromium reads the profile, so nothing there is open yet.
const legacyProfile = join(app.getPath('appData'), 'MultiAgente')
if (!process.env.ALMA_USER_DATA && existsSync(legacyProfile) && !existsSync(join(app.getPath('userData'), 'settings.json'))) {
  try {
    cpSync(legacyProfile, app.getPath('userData'), {
      recursive: true,
      filter: (path) => !/^(lockfile|Singleton\w*|Cache|Code Cache|GPUCache|DawnCache|Crashpad)$/.test(basename(path))
    })
  } catch (error) {
    console.error('[main] could not copy the MultiAgente data:', error)
  }
}

// Routines keep running in the tray, so a second launch should bring up the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

protocol.registerSchemesAsPrivileged([{ scheme: 'alma-vault', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])

const RESOURCES = join(__dirname, '../../resources')
const startHidden = process.argv.includes('--hidden')

let settings: SettingsStore
let coordinator: UtilityProcess | null = null
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
/** Paired device names, owned by the coordinator; the turn-on dialog lists them (spec 026 AC-1.11). */
let dormantDeviceNames: string[] = []

function postToCoordinator(message: ParentToCoordinator, transfer?: Electron.MessagePortMain[]): void {
  coordinator?.postMessage(message, transfer)
}

function pushSettings(updated: Settings): void {
  postToCoordinator({ type: 'settings', settings: updated })
  applyBackgroundSettings(updated)
  applyVoiceHotkey(updated)
}

/** The settings save behind both the window and the tray kill switch (spec 026 T34). */
function updateSettings(patch: Partial<PublicSettings>): PublicSettings {
  // The two changes that hand an agent more power than the person gave it get a native confirmation first.
  const commands = patch.mcpServers ? newCommands(settings.get().mcpServers, patch.mcpServers) : []
  const unlocking = patch.approvalMode === 'always-allow' && settings.get().approvalMode !== 'always-allow'
  if (commands.length || unlocking) {
    const text = securityDialog(settings.get().language, commands.length ? 'mcp' : 'always-allow', commands)
    const answer = dialog.showMessageBoxSync(mainWindow!, {
      type: 'warning',
      buttons: [text.allow, text.cancel],
      defaultId: 1,
      cancelId: 1,
      title: text.title,
      message: text.message,
      detail: text.detail
    })
    if (answer !== 0) {
      audit({ action: 'settings.update', actor: 'user', target: commands.length ? 'mcpServers' : 'approvalMode', outcome: 'denied' })
      throw new Error(mainError(settings.get().language, 'cancelled'))
    }
  }
  // Remote access widenings get one native confirmation each; a refusal saves nothing (spec 026 BR-29, AC-1.4).
  let remote: RemoteSettings | undefined
  if (patch.remote) {
    const planned = planRemoteChange(settings.get().remote, { ...settings.get().remote, ...patch.remote }, dormantDeviceNames, { activeVault: settings.get().activeVault })
    for (const confirmation of planned.confirmations) {
      const text = remoteDialog(settings.get().language, confirmation)
      const answer = dialog.showMessageBoxSync(mainWindow!, {
        type: 'warning',
        buttons: text.buttons,
        defaultId: text.defaultId,
        cancelId: text.defaultId,
        title: text.title,
        message: text.message,
        detail: text.detail
      })
      if (answer !== 0) {
        audit({ action: 'settings.update', actor: 'user', target: 'remote', outcome: 'denied' })
        throw new Error(mainError(settings.get().language, 'cancelled'))
      }
    }
    remote = planned.next
  }
  const effective = remote ? { ...patch, remote } : patch
  const changed = changedKeys(effective as Record<string, unknown>)
  pushSettings(settings.update(effective))
  // The ones that widen what agents may do get their new value in the trail; the rest, just the name.
  if (changed.length) {
    audit({ action: 'settings.update', actor: 'user', target: changed.join(','), outcome: 'ok', ...(changed.includes('approvalMode') ? { detail: { approvalMode: settings.get().approvalMode } } : {}) })
  }
  return settings.getPublic()
}

let voiceHotkey = ''

/** The push-to-talk shortcut works from any app while the voice assistant is on. */
function applyVoiceHotkey(current: Settings): void {
  const wanted = current.voice.enabled ? current.voice.hotkey.trim() : ''
  if (wanted === voiceHotkey) return
  if (voiceHotkey) globalShortcut.unregister(voiceHotkey)
  voiceHotkey = ''
  if (!wanted) return
  try {
    if (globalShortcut.register(wanted, () => postToCoordinator({ type: 'voice.trigger' }))) voiceHotkey = wanted
    else console.error(`[main] the shortcut ${wanted} is already used by another app`)
  } catch (error) {
    console.error(`[main] invalid shortcut ${wanted}:`, error)
  }
}

function showWindow(): void {
  if (!mainWindow) createWindow()
  mainWindow!.show()
  if (mainWindow!.isMinimized()) mainWindow!.restore()
  mainWindow!.focus()
}

function notify(title: string, body: string, threadId?: string, always = false): void {
  if (always && mainWindow) {
    // Windows can silently drop toasts (Focus Assist, an unregistered app id): reminders also show inside Alma.
    mainWindow.webContents.send('app:reminder', { title, body })
    if (!mainWindow.isFocused()) mainWindow.flashFrame(true)
  }
  if (!always && mainWindow?.isVisible() && mainWindow.isFocused()) return
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body, icon: join(RESOURCES, 'icon.png') })
  notification.on('click', () => {
    showWindow()
    if (threadId) mainWindow?.webContents.send('app:openThread', threadId)
  })
  notification.show()
}

async function handleHostRequest(request: HostRequest): Promise<{ ok: boolean; message: string }> {
  switch (request.action) {
    case 'instagram.publish':
      return publishToInstagram(request, settings.get().language).then((result) => {
        audit({ action: 'instagram.publish', actor: 'agent', outcome: result.ok ? 'ok' : 'error' })
        return result
      })
    case 'image.render':
      return renderSvgToPng(request)
    case 'trash': {
      // The coordinator already confined the path; refuse anything outside the active vault anyway.
      const vault = settings.get().activeVault
      if (!vault || !isInside(vault, request.path) || resolve(request.path) === resolve(vault)) {
        return { ok: false, message: 'Ruta fuera del vault.' }
      }
      await shell.trashItem(request.path)
      audit({ action: 'vault.trash', actor: 'agent', outcome: 'ok', detail: { path: relative(vault, request.path) } })
      return { ok: true, message: '' }
    }
    case 'secret.seal':
      return { ok: true, message: encrypt(request.text) }
    case 'secret.open':
      return { ok: true, message: decrypt(request.text) }
    case 'remote.confirm': {
      const confirmation = hostConfirmation(request.kind, request.params)
      if (!confirmation) return { ok: false, message: mainError(settings.get().language, 'missing-data') }
      const text = remoteDialog(settings.get().language, confirmation)
      const answer = dialog.showMessageBoxSync(mainWindow!, {
        type: 'warning',
        buttons: text.buttons,
        defaultId: text.defaultId,
        cancelId: text.defaultId,
        title: text.title,
        message: text.message,
        detail: text.detail
      })
      return { ok: answer === 0, message: '' }
    }
    case 'remote.open': {
      const url = REMOTE_OPEN_URLS[request.target as keyof typeof REMOTE_OPEN_URLS]
      if (!url) return { ok: false, message: mainError(settings.get().language, 'unknown-target') }
      if (request.target === 'tailscale-download') {
        const text = remoteDialog(settings.get().language, { kind: 'download', url })
        const answer = dialog.showMessageBoxSync(mainWindow!, {
          type: 'warning',
          buttons: text.buttons,
          defaultId: text.defaultId,
          cancelId: text.defaultId,
          title: text.title,
          message: text.message,
          detail: text.detail
        })
        if (answer !== 0) return { ok: false, message: '' }
      }
      await shell.openExternal(url)
      return { ok: true, message: '' }
    }
    case 'net.online':
      return { ok: net.isOnline(), message: '' }
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * `alma-vault://file/<vault-relative path>` serves images and attachments of the active vault to the editor,
 * which can't read the disk itself (sandboxed renderer). Only files inside the active vault are served.
 */
function registerVaultProtocol(): void {
  protocol.handle('alma-vault', async (req) => {
    const vault = settings.get().activeVault
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '')
    const target = resolve(vault, rel)
    if (!vault || !isInside(vault, target) || rel.split(/[\\/]/).some((part) => part.startsWith('.'))) {
      return new Response('Not found', { status: 404 })
    }
    // A symlink inside the vault must not lead out of it.
    try {
      if (!isInside(realpathSync(vault), realpathSync(target))) return new Response('Not found', { status: 404 })
    } catch {
      return new Response('Not found', { status: 404 })
    }
    // The window reads drawings embedded in notes with fetch(), which needs CORS; it's the only page this app loads.
    const file = await net.fetch(pathToFileURL(target).toString())
    const headers = new Headers(file.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    return new Response(file.body, { status: file.status, headers })
  })
}

/** Starts the agent coordinator. It owns agent runs, tools, MCP connections, routines and thread storage. */
function startCoordinator(): void {
  coordinator = utilityProcess.fork(join(__dirname, 'coordinator.js'), [], {
    serviceName: 'Alma Coordinator',
    stdio: 'inherit'
  })
  postToCoordinator({ type: 'init', dataDir: app.getPath('userData'), settings: settings.get() })
  coordinator.on('message', (message: CoordinatorToParent) => {
    switch (message.type) {
      case 'alwaysAllow': {
        const current = settings.get().alwaysAllowTools
        if (!current.includes(message.toolName)) {
          audit({ action: 'always-allow.add', actor: 'user', target: message.toolName, outcome: 'ok' })
          pushSettings(settings.update({ alwaysAllowTools: [...current, message.toolName] }))
          mainWindow?.webContents.send('settings:changed')
        }
        break
      }
      case 'host.request':
        void handleHostRequest(message.request)
          .catch((error: Error) => ({ ok: false, message: error.message }))
          .then((result) => postToCoordinator({ type: 'host.result', reqId: message.reqId, ...result }))
        break
      case 'notify':
        notify(message.title, message.body, message.threadId, message.always)
        break
      case 'settings.patch':
        pushSettings(settings.update(stripRemotePatch(message.patch)))
        mainWindow?.webContents.send('settings:changed')
        break
      case 'remote.devices':
        dormantDeviceNames = message.names
        break
    }
  })
  coordinator.on('exit', (code) => {
    coordinator = null
    if (code !== 0 && !quitting) {
      console.error(`[main] coordinator exited with code ${code}; restarting`)
      startCoordinator()
      // Renderers reconnect when they get a fresh port.
      mainWindow?.webContents.send('coordinator:restarted')
    }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: '#05070d',
    title: 'Alma',
    icon: join(RESOURCES, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The voice assistant keeps listening and speaking while the window is hidden in the tray.
      backgroundThrottling: false
    }
  })
  mainWindow.on('ready-to-show', () => {
    if (!startHidden) mainWindow?.show()
  })
  // With the tray enabled, closing the window keeps the app (and its routines) running.
  mainWindow.on('close', (event) => {
    if (!quitting && settings.get().background.runInTray) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => (mainWindow = null))

  // Links from chat messages open in the system browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  const stayHere = (event: { preventDefault(): void }, url: string): void => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault()
  }
  mainWindow.webContents.on('will-navigate', stayHere)
  mainWindow.webContents.on('will-redirect', stayHere)

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function applyBackgroundSettings(current: Settings): void {
  const rule = trayState(current)
  if (rule.icon && !tray) {
    tray = new Tray(join(RESOURCES, 'tray.png'))
    tray.on('click', showWindow)
  } else if (!rule.icon && tray) {
    tray.destroy()
    tray = null
  }
  // Rebuilt on every push, so a change of language shows in the tray at once (spec 025 AC-1.7).
  if (tray) {
    const text = trayMenu(current.language)
    tray.setToolTip(text.tooltip)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: text.open, click: showWindow },
        ...(rule.remoteOff
          ? [
              {
                label: text.remoteOff,
                click: () => updateSettings({ remote: { ...settings.get().remote, enabled: false } })
              } as const
            ]
          : []),
        { type: 'separator' },
        {
          label: text.quit,
          click: () => {
            quitting = true
            app.quit()
          }
        }
      ])
    )
  }
  const openAtLogin = current.background.launchAtLogin
  if (app.getLoginItemSettings().openAtLogin !== openAtLogin) {
    app.setLoginItemSettings({
      openAtLogin,
      path: process.execPath,
      // An unpackaged app needs its folder as the first argument.
      args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden']
    })
  }
}

/**
 * Only the top frame of our own window, still on the page we loaded, may call main: not a sub-frame, not another
 * window. (Navigation away is blocked in createWindow, so the window's current URL is the app's page.)
 */
function isTrusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  const page = mainWindow?.webContents.getURL().split('#')[0]
  return !!frame && !frame.parent && event.sender === mainWindow?.webContents && !!page && frame.url.split('#')[0] === page
}

function handle<A extends unknown[], R>(channel: string, fn: (event: IpcMainInvokeEvent, ...args: A) => R): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrusted(event)) {
      audit({ action: 'ipc.rejected', actor: 'system', target: channel, outcome: 'denied', throttle: true })
      throw new Error(mainError(settings.get().language, 'rejected-origin'))
    }
    return fn(event, ...(args as A))
  })
}

/** What Chromium may ask for: the microphone (voice) and copying to the clipboard. Never the camera, location, USB… */
function lockDownPermissions(): void {
  const allowed = (permission: string, details: object): boolean => {
    const { mediaType, mediaTypes } = details as { mediaType?: string; mediaTypes?: string[] }
    return permission === 'clipboard-sanitized-write' || (permission === 'media' && mediaType !== 'video' && !mediaTypes?.includes('video'))
  }
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === mainWindow?.webContents && allowed(permission, details)))
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => contents === mainWindow?.webContents && allowed(permission, details))
  // No <webview>: it would load content outside the sandbox settings of the window.
  app.on('web-contents-created', (_event, contents) => contents.on('will-attach-webview', (e) => e.preventDefault()))
}

const EXECUTABLE = /\.(exe|bat|cmd|com|msi|msp|scr|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|jar|reg|dll|cpl|pif|appx|msix|sh|command|app|desktop)$/i

/** Names of the settings a patch really changes, for the audit trail. */
function changedKeys(patch: Record<string, unknown>): string[] {
  const current = settings.get() as unknown as Record<string, unknown>
  return Object.keys(patch).filter((key) => JSON.stringify(patch[key]) !== JSON.stringify(current[key]))
}

function registerIpc(): void {
  // Hand the renderer a direct MessagePort to the coordinator.
  ipcMain.on('coordinator:connect', (event) => {
    if (!isTrusted(event)) return
    if (!coordinator) startCoordinator()
    const { port1, port2 } = new MessageChannelMain()
    postToCoordinator({ type: 'client' }, [port1])
    event.sender.postMessage('coordinator:port', null, [port2])
  })

  handle('settings:get', (): PublicSettings => settings.getPublic())

  handle('settings:update', (_event, patch: Partial<PublicSettings>): PublicSettings => updateSettings(patch))

  handle('settings:setApiKey', (_event, provider: SecretProviderId, apiKey: string): PublicSettings => {
    if (!['anthropic', 'xai', 'deepseek', 'vercel', 'meta', 'openai', 'telegram', 'elevenlabs', 'email'].includes(provider)) throw new Error(mainError(settings.get().language, 'unknown-provider'))
    pushSettings(settings.setApiKey(provider, apiKey))
    audit({ action: apiKey ? 'secret.set' : 'secret.clear', actor: 'user', target: provider, outcome: 'ok' })
    return settings.getPublic()
  })

  handle('settings:setCompanySecret', (_event, companyId: string, secret: string): PublicSettings => {
    if (typeof companyId !== 'string' || !settings.get().companies.some((c) => c.id === companyId)) throw new Error(mainError(settings.get().language, 'unknown-company'))
    pushSettings(settings.setCompanySecret(companyId, String(secret ?? '')))
    audit({ action: secret ? 'secret.set' : 'secret.clear', actor: 'user', target: `company:${companyId}`, outcome: 'ok' })
    return settings.getPublic()
  })

  handle('instagram:status', () => instagramStatus())
  handle('instagram:connect', () => {
    audit({ action: 'instagram.connect', actor: 'user', outcome: 'ok' })
    return connectInstagram(settings.get().language, mainWindow ?? undefined)
  })
  handle('instagram:disconnect', () => {
    audit({ action: 'instagram.disconnect', actor: 'user', outcome: 'ok' })
    return disconnectInstagram()
  })

  handle('dialog:pickFolder', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  // Opening a file hands it to the OS, which would run a program: only folders and documents.
  handle('shell:openPath', (_event, path: string): string | Promise<string> => {
    if (typeof path !== 'string' || !isAbsolute(path) || !existsSync(path)) return mainError(settings.get().language, 'path-missing')
    if (statSync(path).isFile() && EXECUTABLE.test(path)) {
      audit({ action: 'shell.openPath', actor: 'user', target: basename(path), outcome: 'denied' })
      return mainError(settings.get().language, 'no-programs')
    }
    return shell.openPath(path)
  })

  handle('vault:defaultPath', () => join(app.getPath('documents'), 'Alma', 'Vault'))

  // A folder renamed in Alma's own vault view keeps its remote exclusion: no dialog, only existing entries move (spec 028 AC-1.11).
  handle('remote:moveExclusions', (_event, args: unknown): void => {
    const vault = settings.get().activeVault
    const onDisk = (rel: string): boolean => {
      const target = resolve(vault, rel)
      return !!vault && isInside(vault, target) && existsSync(target)
    }
    const vaultExcluded = movedExclusions(settings.get().remote, args, onDisk)
    if (!vaultExcluded) return
    pushSettings(settings.update({ remote: { ...settings.get().remote, vaultExcluded } }))
    audit({ action: 'settings.update', actor: 'user', target: 'remote.vaultExcluded', outcome: 'ok' })
    mainWindow?.webContents.send('settings:changed')
  })
}

app.on('second-instance', showWindow)

app.whenReady().then(() => {
  // Windows shows notifications only for apps with an identity.
  app.setAppUserModelId('com.alma.app')
  settings = new SettingsStore(app.getPreferredSystemLanguages())
  initAudit(app.getPath('userData'), 'main')
  audit({ action: 'app.start', actor: 'system', outcome: 'ok', detail: { version: app.getVersion(), packaged: app.isPackaged } })
  lockDownPermissions()
  registerIpc()
  registerVaultProtocol()
  startCoordinator()
  createWindow()
  applyBackgroundSettings(settings.get())
  applyVoiceHotkey(settings.get())
  app.on('activate', showWindow)
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('before-quit', () => {
  quitting = true
  coordinator?.kill()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !settings?.get().background.runInTray) app.quit()
})
