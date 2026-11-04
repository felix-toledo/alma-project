// The home engine: a Home Assistant that Alma installs, starts and watches by itself inside a hidden WSL2 distro
// ("alma-home"), so the user never sees it. The rootfs is the official Home Assistant container image, exported
// with crane (no Docker needed) and imported as a distro; Alma then runs `python -m homeassistant` in it.
// External mode skips all that and just remembers the URL and token of a Home Assistant the user already runs.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import type { HomeEngineStatus, HomeSettings } from '../../shared/home'
import { HaClient, HaError, onboard, waitForHa } from './ha'
import { type MessageKey, type ParamsArg, translate } from '../../shared/i18n/messages'
import type { Language } from '../../shared/i18n/language'
import { shownError } from '../tools/types'

export const HA_VERSION = '2026.10.1'
const HA_IMAGE = `ghcr.io/home-assistant/home-assistant:${HA_VERSION}`
const CRANE_URL = 'https://github.com/google/go-containerregistry/releases/download/v0.22.1/go-containerregistry_Windows_x86_64.tar.gz'
const CRANE_SHA256 = '0e073ea8192c3b8442ec8aaf44d53c1050a09084669fae3a6ceb0f2026cf8b21'
const SONOFF_URL = 'https://github.com/AlexxIT/SonoffLAN/archive/refs/tags/v3.13.1.zip'
/** Size of the exported rootfs, to draw a progress bar while crane works. */
const ROOTFS_BYTES = 2_600_000_000
/** The tar plus the distro's disk image. */
const NEEDED_BYTES = 6_500_000_000
const DEFAULT_PORT = 8123
const ALT_PORT = 18123
const BOOT_TIMEOUT_MS = 8 * 60_000

export const distroName = (): string => process.env.ALMA_HOME_DISTRO || 'alma-home'

interface Auth {
  mode: 'managed' | 'external'
  url: string
  /** Encrypted with the OS keychain (see Host secret.seal). */
  token: string
  password?: string
}

export interface EngineDeps {
  dataDir: string
  settings(): { home: HomeSettings; language?: Language }
  /** Encrypts / decrypts with the OS keychain (main process). */
  seal(text: string): Promise<string>
  open(text: string): Promise<string>
  onStatus(status: HomeEngineStatus): void
}

interface RunResult {
  code: number | null
  stdout: Buffer
  stderr: Buffer
}

/** wsl.exe's own messages are UTF-16; what a Linux command prints is UTF-8. */
export function decodeWsl(buffer: Buffer): string {
  if (buffer.includes(0)) return buffer.toString('utf16le').replace(/^﻿/, '')
  return buffer.toString('utf8')
}

function run(command: string, args: string[], options: { input?: string | Buffer; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, signal: options.signal })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : undefined
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(options.input)
  })
}

const wsl = (args: string[], options?: Parameters<typeof run>[2]): Promise<RunResult> => run('wsl.exe', args, options)

/** A command inside the distro, without a shell (arguments reach it untouched). */
const inDistro = (args: string[], options?: Parameters<typeof run>[2]): Promise<RunResult> => wsl(['-d', distroName(), '--exec', ...args], options)

/** Creates a file inside the distro unless it exists already. */
async function ensureInDistro(path: string, content: string): Promise<void> {
  if ((await inDistro(['/bin/ls', path])).code !== 0) await writeInDistro(path, content)
}

/** Writes a file inside the distro (dd takes the path as one argument, so no quoting is involved). */
async function writeInDistro(path: string, content: string): Promise<void> {
  const result = await inDistro(['/bin/dd', `of=${path}`], { input: content })
  if (result.code !== 0) throw new HaError('home.engine.writeFailed', { path, error: decodeWsl(result.stderr).slice(0, 200) })
}

export async function wslAvailable(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  try {
    return (await wsl(['--status'], { timeoutMs: 15_000 })).code === 0
  } catch {
    return false
  }
}

export async function distroExists(): Promise<boolean> {
  const result = await wsl(['-l', '-q'], { timeoutMs: 15_000 }).catch(() => null)
  if (!result || result.code !== 0) return false
  return decodeWsl(result.stdout)
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, '').trim())
    .includes(distroName())
}

function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    socket.once('connect', () => (socket.destroy(), resolve(true)))
    socket.once('error', () => resolve(false))
    socket.setTimeout(1500, () => (socket.destroy(), resolve(false)))
  })
}

/** The managed configuration.yaml: rewritten at every start, so the port and time zone always match. */
export function managedConfig(port: number, timeZone: string, language: Language = 'es'): string {
  return [
    '# Written by Alma on every start; changes are made from the app.',
    'default_config:',
    // Scenes, automations and scripts made from Alma (or the window) are saved in these files.
    'automation: !include automations.yaml',
    'scene: !include scenes.yaml',
    'script: !include scripts.yaml',
    ...(process.env.ALMA_HOME_DEMO ? ['demo:'] : []),
    'homeassistant:',
    '  name: Casa',
    '  unit_system: metric',
    `  time_zone: ${timeZone}`,
    `  language: ${language}`,
    'http:',
    '  server_host: 0.0.0.0',
    `  server_port: ${port}`,
    // RTSP cameras: see FFMPEG_SCRIPT.
    'ffmpeg:',
    `  ffmpeg_bin: ${FFMPEG_PATH}`,
    'recorder:',
    '  purge_keep_days: 7',
    'logger:',
    '  default: warning',
    ''
  ].join('\n')
}

const RUN_SCRIPT = `#!/bin/sh
cd /config || exit 1
exec env -i HOME=/root PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 PYTHONMALLOC=mimalloc python3 -P -m homeassistant --config /config
`

const FFMPEG_PATH = '/usr/local/bin/alma-ffmpeg'

// WSL's NAT swallows the UDP video a camera sends back, so ffmpeg's default RTSP transport hangs until Home Assistant gives up.
const FFMPEG_SCRIPT = `#!/bin/sh
for a in "$@"; do
  case "$a" in rtsp://*|rtsps://*) exec /usr/bin/ffmpeg -rtsp_transport tcp "$@" ;; esac
done
exec /usr/bin/ffmpeg "$@"
`

const SONOFF_INSTALL = `import io, os, shutil, urllib.request, zipfile
data = urllib.request.urlopen(${JSON.stringify(SONOFF_URL)}, timeout=60).read()
zf = zipfile.ZipFile(io.BytesIO(data))
tmp = '/tmp/sonoff-src'
shutil.rmtree(tmp, ignore_errors=True)
zf.extractall(tmp)
src = [os.path.join(tmp, d, 'custom_components', 'sonoff') for d in os.listdir(tmp)][0]
dst = '/config/custom_components/sonoff'
shutil.rmtree(dst, ignore_errors=True)
os.makedirs('/config/custom_components', exist_ok=True)
shutil.copytree(src, dst)
print('ok')
`

export class HomeEngine {
  private current: HomeEngineStatus
  private proc: ChildProcess | null = null
  private tail: string[] = []
  private stopping = false
  private busy: Promise<void> | null = null
  private restarts: number[] = []
  private abort: AbortController | null = null
  private dir: string
  private authFile: string
  private port = DEFAULT_PORT
  private auth: Auth | null = null
  /** An engine a previous session left running (Alma was killed): used as it is instead of starting a second one. */
  private adopted = false

  constructor(private deps: EngineDeps) {
    this.dir = join(deps.dataDir, 'home')
    mkdirSync(this.dir, { recursive: true })
    this.authFile = join(this.dir, 'auth.json')
    this.current = { state: 'off', mode: deps.settings().home.mode }
    const saved = this.readJson<{ port?: number }>(join(this.dir, 'engine.json'))
    if (saved?.port) this.port = saved.port
  }

  status(): HomeEngineStatus {
    return this.current
  }

  /** The status text the Home view shows, in the app language. */
  private text<K extends MessageKey>(key: K, ...params: ParamsArg<K>): string {
    return translate(this.deps.settings().language ?? 'es', key, ...params)
  }

  private shown(error: Error): string {
    return shownError(error, this.deps.settings().language ?? 'es')
  }

  private set(patch: Partial<HomeEngineStatus> & { state: HomeEngineStatus['state'] }): void {
    this.current = { mode: this.deps.settings().home.mode, url: this.current.url, version: this.current.version, ...patch }
    if (patch.state !== 'error') delete this.current.error
    this.deps.onStatus(this.current)
  }

  private readJson<T>(file: string): T | null {
    try {
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null
    } catch {
      return null
    }
  }

  /** The URL and token the hub connects with, once there is an account. */
  async credentials(): Promise<{ url: string; token: string } | null> {
    this.auth ??= this.readJson<Auth>(this.authFile)
    if (!this.auth) return null
    const token = await this.deps.open(this.auth.token)
    return token ? { url: this.auth.url, token } : null
  }

  /** The owner account Alma made for itself, for someone who wants to open Home Assistant's own screen. */
  async ownerLogin(): Promise<{ url: string; username: string; password: string } | null> {
    this.auth ??= this.readJson<Auth>(this.authFile)
    if (!this.auth || this.auth.mode !== 'managed' || !this.auth.password) return null
    return { url: this.auth.url, username: 'alma', password: await this.deps.open(this.auth.password) }
  }

  private async saveAuth(auth: Omit<Auth, 'token'> & { token: string }): Promise<void> {
    this.auth = { ...auth, token: await this.deps.seal(auth.token), ...(auth.password ? { password: await this.deps.seal(auth.password) } : {}) }
    writeFileSync(this.authFile, JSON.stringify(this.auth), 'utf8')
  }

  /** Serializes the heavy operations: two installs or starts at once would corrupt each other. */
  private exclusive(work: () => Promise<void>): Promise<void> {
    if (this.busy) return this.busy
    this.busy = work().finally(() => (this.busy = null))
    return this.busy
  }

  /** Brings the engine in line with the settings: starts it when it should run, stops it when it shouldn't. */
  async sync(): Promise<void> {
    const { enabled, mode } = this.deps.settings().home
    if (!enabled) {
      if (this.current.state !== 'off') await this.stop()
      this.set({ state: 'off' })
      return
    }
    if (this.busy || ['installing', 'ready', 'starting', 'error'].includes(this.current.state)) return
    if (mode === 'external') return this.exclusive(() => this.connectExternal())
    return this.exclusive(() => this.bringUp())
  }

  /** Starts a managed engine that's already installed (the "Reintentar" button, and sync). */
  start(): Promise<void> {
    this.restarts = []
    if (this.deps.settings().home.mode === 'external') return this.exclusive(() => this.connectExternal())
    return this.exclusive(() => this.bringUp())
  }

  private async bringUp(): Promise<void> {
    if (!(await wslAvailable())) {
      this.set({ state: 'unsupported', error: this.text('home.engine.noWslHint') })
      return
    }
    if (!(await distroExists())) return this.set({ state: 'missing' })
    try {
      await this.startManaged()
    } catch (error) {
      if (!this.stopping) this.set({ state: 'error', error: this.shown(error as Error) })
    }
  }

  // ---------------------------------------------------------------------------
  // External

  /** Verifies the saved URL and token of a Home Assistant the user already has. */
  private async connectExternal(): Promise<void> {
    const { externalUrl } = this.deps.settings().home
    const creds = await this.credentials()
    if (!externalUrl || !creds || creds.url !== externalUrl.replace(/\/+$/, '')) {
      this.set({ state: 'missing', error: undefined })
      return
    }
    this.set({ state: 'starting', step: this.text('home.engine.step.connecting'), url: creds.url })
    try {
      const version = await new HaClient(creds.url, creds.token).rest<{ version: string }>('GET', '/api/config')
      this.set({ state: 'ready', url: creds.url, version: version.version })
    } catch (error) {
      this.set({ state: 'error', error: this.shown(error as Error), url: creds.url })
    }
  }

  async connectExternalWith(url: string, token: string): Promise<void> {
    const clean = url.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//.test(clean)) throw new HaError('home.engine.badUrl')
    const version = await new HaClient(clean, token.trim()).rest<{ version: string }>('GET', '/api/config').catch((error: Error) => {
      throw new HaError('home.engine.cannotEnter', { url: clean, error: error.message })
    })
    await this.saveAuth({ mode: 'external', url: clean, token: token.trim() })
    this.set({ state: 'ready', url: clean, version: version.version })
  }

  // ---------------------------------------------------------------------------
  // Managed: install

  install(): Promise<void> {
    return this.exclusive(async () => {
      if (!(await wslAvailable())) {
        this.set({ state: 'unsupported', error: this.text('home.engine.noWslAdmin') })
        throw new HaError('home.engine.noWsl')
      }
      this.abort = new AbortController()
      this.stopping = false
      try {
        if (!(await distroExists())) await this.installDistro(this.abort.signal)
        await this.startManaged()
      } catch (error) {
        if (this.stopping) return this.set({ state: 'missing' })
        this.set({ state: 'error', error: this.shown(error as Error) })
        throw error
      } finally {
        this.abort = null
      }
    })
  }

  private async installDistro(signal: AbortSignal): Promise<void> {
    const free = (() => {
      try {
        const stats = statfsSync(this.dir)
        return Number(stats.bavail) * Number(stats.bsize)
      } catch {
        return Infinity
      }
    })()
    if (free < NEEDED_BYTES) throw new HaError('home.engine.noSpace', { need: Math.ceil(NEEDED_BYTES / 1e9), free: (free / 1e9).toFixed(1) })

    const crane = join(this.dir, 'crane.exe')
    if (!existsSync(crane)) {
      this.set({ state: 'installing', step: this.text('home.engine.step.downloadingTools'), progress: 0.01 })
      const response = await fetch(CRANE_URL, { signal })
      if (!response.ok) throw new HaError('home.engine.craneDownload', { status: response.status })
      const archive = Buffer.from(await response.arrayBuffer())
      if (createHash('sha256').update(archive).digest('hex') !== CRANE_SHA256) throw new HaError('home.engine.craneChecksum')
      const tgz = join(this.dir, 'crane.tgz')
      writeFileSync(tgz, archive)
      // Windows' own bsdtar by full path: a GNU tar earlier in PATH (Git for Windows) reads "C:" as a remote host.
      const unpacked = await run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xzf', tgz, '-C', this.dir, 'crane.exe'], { timeoutMs: 60_000 })
      rmSync(tgz, { force: true })
      if (unpacked.code !== 0 || !existsSync(crane)) throw new HaError('home.engine.craneUnpack')
    }

    const rootfs = join(this.dir, 'rootfs.tar')
    rmSync(rootfs, { force: true })
    this.set({ state: 'installing', step: this.text('home.engine.step.downloadingHa', { version: HA_VERSION }), progress: 0.03 })
    const ticker = setInterval(() => {
      try {
        this.set({ state: 'installing', step: this.text('home.engine.step.downloadingHa', { version: HA_VERSION }), progress: 0.03 + Math.min(statSync(rootfs).size / ROOTFS_BYTES, 1) * 0.57 })
      } catch {
        // not created yet
      }
    }, 1500)
    try {
      const exported = await run(crane, ['export', '--platform', 'linux/amd64', HA_IMAGE, rootfs], { signal })
      if (exported.code !== 0) throw new HaError('home.engine.haDownload', { error: exported.stderr.toString('utf8').slice(0, 300) })
    } finally {
      clearInterval(ticker)
    }

    // The import has no progress output; it takes a few minutes, so the bar creeps on its own estimate.
    const started = Date.now()
    const creep = setInterval(() => this.set({ state: 'installing', step: this.text('home.engine.step.installing'), progress: 0.6 + Math.min((Date.now() - started) / 240_000, 1) * 0.25 }), 2000)
    try {
      const vm = join(this.dir, 'vm')
      mkdirSync(vm, { recursive: true })
      const imported = await wsl(['--import', distroName(), vm, rootfs, '--version', '2'], { signal })
      if (imported.code !== 0) throw new HaError('home.engine.wslImport', { error: decodeWsl(imported.stderr || imported.stdout).slice(0, 300) })
    } finally {
      clearInterval(creep)
      rmSync(rootfs, { force: true })
    }

    this.set({ state: 'installing', step: this.text('home.engine.step.configuring'), progress: 0.9 })
    await writeInDistro('/usr/local/bin/alma-ha.sh', RUN_SCRIPT)
    await inDistro(['/bin/mkdir', '-p', '/config/custom_components'])
    const sonoff = await inDistro(['/usr/local/bin/python3', '-c', SONOFF_INSTALL], { timeoutMs: 120_000 })
    // eWeLink is optional: the engine works without it, and the user can retry later.
    if (!decodeWsl(sonoff.stdout).includes('ok')) console.error('[home] could not install SonoffLAN:', decodeWsl(sonoff.stderr).slice(0, 300))
  }

  // ---------------------------------------------------------------------------
  // Managed: run

  private async startManaged(): Promise<void> {
    if (this.proc) return
    this.stopping = false
    this.set({ state: 'starting', step: this.text('home.engine.step.starting'), progress: undefined })
    if (await portBusy(this.port)) {
      const creds = await this.credentials()
      if (creds?.url === `http://127.0.0.1:${this.port}`) {
        const config = await new HaClient(creds.url, creds.token).rest<{ version: string }>('GET', '/api/config').catch(() => null)
        if (config) {
          this.adopted = true
          this.set({ state: 'ready', url: creds.url, version: config.version })
          return
        }
      }
    }
    this.port = (await portBusy(this.port)) ? (this.port === DEFAULT_PORT ? ALT_PORT : this.port) : this.port
    if (await portBusy(this.port)) throw new HaError('home.engine.portBusy', { port: this.port })
    writeFileSync(join(this.dir, 'engine.json'), JSON.stringify({ port: this.port }), 'utf8')
    const url = `http://127.0.0.1:${this.port}`
    await writeInDistro('/usr/local/bin/alma-ha.sh', RUN_SCRIPT)
    await writeInDistro(FFMPEG_PATH, FFMPEG_SCRIPT)
    await inDistro(['/bin/chmod', '+x', FFMPEG_PATH])
    await writeInDistro('/config/configuration.yaml', managedConfig(this.port, Intl.DateTimeFormat().resolvedOptions().timeZone, this.deps.settings().language ?? 'es'))
    for (const file of ['automations', 'scenes', 'scripts']) await ensureInDistro(`/config/${file}.yaml`, '[]\n')

    this.tail = []
    const child = spawn('wsl.exe', ['-d', distroName(), '--exec', '/bin/sh', '/usr/local/bin/alma-ha.sh'], { windowsHide: true })
    this.proc = child
    const keep = (chunk: Buffer): void => {
      this.tail.push(...decodeWsl(chunk).split(/\r?\n/).filter(Boolean))
      if (this.tail.length > 80) this.tail.splice(0, this.tail.length - 80)
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.on('exit', (code) => this.onExit(child, code))

    try {
      await waitForHa(url, BOOT_TIMEOUT_MS, this.abort?.signal)
      if (this.proc !== child) throw new HaError('home.engine.stopped')
      await this.ensureAccount(url)
      const creds = await this.credentials()
      if (!creds) throw new HaError('home.engine.noAccount')
      const config = await new HaClient(url, creds.token).rest<{ version: string }>('GET', '/api/config')
      this.set({ state: 'ready', url, version: config.version })
    } catch (error) {
      if (this.proc === child) await this.kill()
      throw error
    }
  }

  /** First start: creates Alma's own account. Later starts already have it. */
  private async ensureAccount(url: string): Promise<void> {
    if (await this.credentials()) return
    const steps = (await (await fetch(`${url}/api/onboarding`)).json().catch(() => [])) as { step: string; done: boolean }[]
    if (steps.find((s) => s.step === 'user')?.done) {
      throw new HaError('home.engine.unknownAccount')
    }
    const password = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('')
    const account = await onboard(url, password, this.deps.settings().language ?? 'es')
    await this.saveAuth({ mode: 'managed', url, token: account.token, password })
  }

  private onExit(child: ChildProcess, code: number | null): void {
    if (this.proc !== child) return
    this.proc = null
    if (this.stopping) return
    const now = Date.now()
    this.restarts = this.restarts.filter((t) => now - t < 10 * 60_000)
    if (this.restarts.length >= 3) {
      this.set({ state: 'error', error: this.text('home.engine.crashed', { code: String(code), tail: this.tail.slice(-3).join(' ') }).trim() })
      return
    }
    this.restarts.push(now)
    this.set({ state: 'starting', step: this.text('home.engine.step.restarting') })
    void this.exclusive(() => this.startManaged()).catch((error: Error) => this.set({ state: 'error', error: error.message }))
  }

  private async kill(): Promise<void> {
    const child = this.proc
    this.proc = null
    child?.kill()
    await wsl(['--terminate', distroName()], { timeoutMs: 20_000 }).catch(() => undefined)
  }

  /** Stops Home Assistant cleanly (its own stop service, so the database closes properly). */
  async stop(): Promise<void> {
    this.abort?.abort()
    this.stopping = true
    const child = this.proc
    if (this.deps.settings().home.mode === 'managed' && (child || this.adopted)) {
      const creds = await this.credentials().catch(() => null)
      if (creds) await new HaClient(creds.url, creds.token).rest('POST', '/api/services/homeassistant/stop', {}, { timeoutMs: 5000 }).catch(() => undefined)
      if (child) {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 20_000))])
        if (this.proc === child) await this.kill()
      } else await new Promise<void>((resolve) => setTimeout(resolve, 8000))
    }
    this.adopted = false
    this.proc = null
    if (this.current.state !== 'off') this.set({ state: this.deps.settings().home.enabled ? 'missing' : 'off' })
  }

  /** Removes the distro and the account; the plan and the rules stay (they're Alma's). */
  async uninstall(): Promise<void> {
    await this.stop()
    this.stopping = true
    if (await distroExists()) await wsl(['--unregister', distroName()], { timeoutMs: 120_000 })
    for (const name of ['vm', 'auth.json', 'engine.json']) rmSync(join(this.dir, name), { recursive: true, force: true })
    this.auth = null
    this.set({ state: this.deps.settings().home.enabled ? 'missing' : 'off', url: undefined, version: undefined })
  }

  /** The last lines Home Assistant printed, for the error screen. */
  logTail(): string {
    return this.tail.join('\n')
  }
}
