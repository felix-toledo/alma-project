import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import http, { type IncomingHttpHeaders } from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PortAllocationError, TailscaleController } from '../src/coordinator/channels/remote/tailscale'
import { bindAddress, notBuiltPage, resolveAssetPath, TailscaleTransport } from '../src/coordinator/channels/remote/tailscale-transport'
import { MONITOR_MS, TailscaleMonitor } from '../src/coordinator/channels/remote/monitor'
import { TransportStartError } from '../src/coordinator/channels/remote/transport'
import { ROUTES, type RemoteHandler, type RemoteResponse } from '../src/shared/remote/api'
import { HOST, testChannel } from './support/remote-harness'
import { bareDnsName, daysToExpiry, isHostRenamed, isValidPort, parseStatus, serveCommand, serveOwner, serveRemoveCommand, TAILSCALE_EXE } from '../src/shared/remote/tailscale'

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'tailscale', name), 'utf8')
const DAY = 86_400_000

describe('T29 Tailscale parsers (AC-2.1, 2.8, 2.10, 2.12, 2.13, 2.15)', () => {
  it('AC-2.1 parseStatus reads a running node', () => {
    expect(parseStatus(fixture('status-running.json'))).toEqual({
      backendState: 'Running',
      online: true,
      hostName: 'ALMA-PC',
      dnsName: 'alma-pc.tail0000.ts.net',
      magicDNSSuffix: 'tail0000.ts.net',
      magicDNSEnabled: true,
      certDomains: ['alma-pc.tail0000.ts.net'],
      keyExpiry: '2027-05-06T05:16:34Z'
    })
  })

  it('AC-2.1 parseStatus reads a stopped node', () => {
    const status = parseStatus(fixture('status-stopped.json'))
    expect(status?.backendState).toBe('Stopped')
    expect(status?.online).toBe(false)
    expect(status?.dnsName).toBe('alma-pc.tail0000.ts.net')
  })

  it('AC-2.1 parseStatus refuses garbage and empty input', () => {
    expect(parseStatus('')).toBeNull()
    expect(parseStatus('not json')).toBeNull()
    expect(parseStatus('[]')).toBeNull()
    expect(parseStatus('[1]')).toBeNull()
    expect(parseStatus('42')).toBeNull()
  })

  it('AC-2.1 parseStatus reads a logged-out node (hand-written fake: S2 did not capture NeedsLogin)', () => {
    const status = parseStatus(JSON.stringify({ BackendState: 'NeedsLogin', Self: { HostName: 'ALMA-PC', DNSName: '', Online: false } }))
    expect(status?.backendState).toBe('NeedsLogin')
    expect(status?.online).toBe(false)
    expect(status?.hostName).toBe('ALMA-PC')
  })

  it('AC-2.8 serveCommand builds serve --bg for any valid port, never funnel', () => {
    for (const port of [1, 80, 443, 8000, 8443, 8444, 65535]) {
      const cmd = serveCommand(port)
      expect(cmd.argv).toEqual(['serve', '--bg', String(port)])
      expect(cmd.argv).not.toContain('funnel')
      expect(cmd.display).toBe(cmd.argv.join(' '))
      expect(cmd.display).not.toContain('funnel')
    }
  })

  it('AC-2.8 serveCommand throws out of range', () => {
    for (const port of [0, -1, 65536, 1.5, NaN]) {
      expect(() => serveCommand(port)).toThrow(RangeError)
    }
  })

  it('AC-2.12 serveRemoveCommand removes one path, never reset, never funnel', () => {
    const cmd = serveRemoveCommand()
    expect(cmd.argv).toEqual(['serve', '--https=443', '--set-path', '/', 'off'])
    expect(cmd.display).toBe(cmd.argv.join(' '))
    expect(cmd.argv).not.toContain('reset')
    expect(cmd.argv).not.toContain('funnel')
    expect(cmd.display).not.toMatch(/reset|funnel/)
  })

  it('AC-2.11 isValidPort accepts integers 1-65535 only', () => {
    expect([1, 80, 8443, 65535].every(isValidPort)).toBe(true)
    expect([0, -1, 65536, 1.5, NaN, '8443', null, undefined].every((port) => !isValidPort(port))).toBe(true)
  })

  it('AC-2.12/AC-2.13 serveOwner tells none, mine and other apart', () => {
    const self = { dnsName: 'alma-pc.tail0000.ts.net.', port: 8443 }
    expect(serveOwner(fixture('serve-empty.json'), self)).toBe('none')
    expect(serveOwner(fixture('serve-alma.json'), self)).toBe('mine')
    expect(serveOwner(fixture('serve-alma.json'), { dnsName: 'alma-pc.tail0000.ts.net', port: 8443 })).toBe('mine')
    expect(serveOwner(fixture('serve-alma-other-port.json'), self)).toBe('other')
    expect(serveOwner(fixture('serve-alma-other-port.json'), { dnsName: 'alma-pc.tail0000.ts.net.', port: 8444 })).toBe('mine')
    expect(serveOwner(fixture('serve-with-foreign-path.json'), self)).toBe('mine')
    expect(serveOwner(fixture('serve-with-foreign-port.json'), self)).toBe('mine')
    expect(serveOwner(fixture('serve-alma.json'), { dnsName: 'other-pc.tail0000.ts.net.', port: 8443 })).toBe('none')
  })

  it('AC-2.13 serveOwner fails closed on garbage', () => {
    expect(serveOwner('not json', { dnsName: 'a.', port: 1 })).toBe('other')
    expect(serveOwner('', { dnsName: 'a.', port: 1 })).toBe('other')
  })

  it('AC-2.10 daysToExpiry counts whole days, null stays null', () => {
    const now = Date.parse('2026-11-07T00:00:00Z')
    expect(daysToExpiry(null, now)).toBeNull()
    expect(daysToExpiry('not a date', now)).toBeNull()
    expect(daysToExpiry(new Date(now + 13 * DAY).toISOString(), now)).toBe(13)
    expect(daysToExpiry(new Date(now + 14 * DAY).toISOString(), now)).toBe(14)
    expect(daysToExpiry(new Date(now + 15 * DAY).toISOString(), now)).toBe(15)
    expect(daysToExpiry(new Date(now - DAY).toISOString(), now)).toBeLessThan(0)
  })

  it('AC-2.15 host-name comparison ignores case and the trailing dot', () => {
    expect(isHostRenamed(null, 'alma-pc.tail0000.ts.net.')).toBe(false)
    expect(isHostRenamed('alma-pc.tail0000.ts.net.', null)).toBe(false)
    expect(isHostRenamed(null, null)).toBe(false)
    expect(isHostRenamed('alma-pc.tail0000.ts.net.', 'alma-pc.tail0000.ts.net.')).toBe(false)
    expect(isHostRenamed('alma-pc.tail0000.ts.net.', 'ALMA-PC.tail0000.ts.net')).toBe(false)
    expect(isHostRenamed('alma-pc.tail0000.ts.net.', 'new-pc.tail0000.ts.net.')).toBe(true)
  })

  it('bareDnsName strips the one DNS root dot, and nothing else', () => {
    expect(bareDnsName('alma-pc.tail0000.ts.net.')).toBe('alma-pc.tail0000.ts.net')
    expect(bareDnsName('alma-pc.tail0000.ts.net')).toBe('alma-pc.tail0000.ts.net')
    expect(bareDnsName('odd..')).toBe('odd.')
  })
})

type ExecResult = { code: number; stdout: string; stderr: string }
type ExecCall = { file: string; args: string[] }
type ConfirmCall = { kind: string; params: Record<string, string> }
const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' })
const missing = (): ExecResult => ({ code: 127, stdout: '', stderr: 'not found' })

function fakeExec(outputs: Record<string, ExecResult>, calls: ExecCall[] = []): (file: string, args: string[]) => Promise<ExecResult> {
  return async (file, args) => {
    calls.push({ file, args })
    return outputs[`${file} ${args.join(' ')}`] ?? missing()
  }
}

function fakeStore(port: number | null = null): {
  state: { port: number | null; hostName: string | null }
  update(patch: { port?: number | null; hostName?: string | null }): Promise<void>
} {
  const state = { port, hostName: null as string | null }
  return {
    state,
    update: async (patch) => {
      Object.assign(state, patch)
    }
  }
}

function controller(over: {
  outputs?: Record<string, ExecResult>
  calls?: ExecCall[]
  port?: number | null
  online?: boolean
  opened?: string[]
  allowOpen?: boolean
  picked?: number[]
  confirmCalls?: ConfirmCall[]
  allowConfirm?: boolean
} = {}): { tailscale: TailscaleController; calls: ExecCall[]; opened: string[]; store: { port: number | null; hostName: string | null } } {
  const calls = over.calls ?? []
  const opened = over.opened ?? []
  const picked = over.picked ?? []
  const confirmCalls = over.confirmCalls ?? []
  const allowOpen = over.allowOpen ?? true
  const allowConfirm = over.allowConfirm ?? true
  const store = fakeStore(over.port ?? null)
  const tailscale = new TailscaleController({
    exec: fakeExec(over.outputs ?? {}, calls),
    openExternal: async (target) => {
      opened.push(target)
      return allowOpen
    },
    online: async () => over.online ?? true,
    pickPort: async () => picked.shift() ?? 8443,
    store,
    now: () => 0,
    confirm: async (kind, params) => {
      confirmCalls.push({ kind, params })
      return allowConfirm
    }
  })
  return { tailscale, calls, opened, store: store.state }
}

const STATUS = 'status --json'
const SERVE_STATUS = 'serve status --json'

describe('T30 TailscaleController part 1: detect, download, test (AC-2.1 to 2.4, 2.3, PD-13)', () => {

  it('AC-2.1 detect maps running to connected with https and serving', async () => {
    const { tailscale } = controller({
      port: 8443,
      outputs: { [`tailscale ${STATUS}`]: ok(fixture('status-running.json')), [`tailscale ${SERVE_STATUS}`]: ok(fixture('serve-alma.json')) }
    })
    const found = await tailscale.detect({ listenerUp: true })
    expect(found.tailscale).toEqual({ state: 'connected', https: true, serving: true })
    expect(found.failure).toBeNull()
  })

  it('AC-2.1 detect maps stopped to disconnected, keeping the saved serve entry visible', async () => {
    const { tailscale } = controller({
      port: 8443,
      outputs: { [`tailscale ${STATUS}`]: ok(fixture('status-stopped.json')), [`tailscale ${SERVE_STATUS}`]: ok(fixture('serve-alma.json')) }
    })
    const found = await tailscale.detect({ listenerUp: true })
    expect(found.tailscale).toEqual({ state: 'disconnected', https: true, serving: true })
    expect(found.failure).toEqual({ failure: 'tailscaleDown' })
  })

  it('AC-2.1 detect maps a missing binary to missing after trying the absolute path', async () => {
    const { tailscale, calls } = controller()
    const found = await tailscale.detect({ listenerUp: true })
    expect(found.tailscale).toEqual({ state: 'missing', https: false, serving: false })
    expect(found.failure).toEqual({ failure: 'tailscaleDown' })
    expect(calls.map((call) => call.file)).toEqual(['tailscale', TAILSCALE_EXE, 'tailscale', TAILSCALE_EXE])
  })

  it('AC-2.1 detect maps logged-out and garbage to disconnected (marked fakes)', async () => {
    const loggedOut = controller({ outputs: { [`tailscale ${STATUS}`]: ok(JSON.stringify({ BackendState: 'NeedsLogin', Self: { Online: false } })) } })
    expect((await loggedOut.tailscale.detect({ listenerUp: true })).tailscale.state).toBe('disconnected')
    const garbage = controller({ outputs: { [`tailscale ${STATUS}`]: ok('xxx'), [`tailscale ${SERVE_STATUS}`]: ok('xxx') } })
    const found = await garbage.tailscale.detect({ listenerUp: true })
    expect(found.tailscale.state).toBe('disconnected')
    expect(found.tailscale.serving).toBe(false)
  })

  it('AC-2.4 the connection check runs online, tailscale, https and listener in order', async () => {
    const running = { [`tailscale ${STATUS}`]: ok(fixture('status-running.json')), [`tailscale ${SERVE_STATUS}`]: ok(fixture('serve-alma.json')) }
    const offline = controller({ port: 8443, online: false, outputs: running })
    expect((await offline.tailscale.detect({ listenerUp: true })).failure).toEqual({ failure: 'noInternet' })
    const down = controller({
      port: 8443,
      outputs: { [`tailscale ${STATUS}`]: ok(fixture('status-stopped.json')), [`tailscale ${SERVE_STATUS}`]: ok(fixture('serve-alma.json')) }
    })
    expect((await down.tailscale.detect({ listenerUp: true })).failure).toEqual({ failure: 'tailscaleDown' })
    // Hand-written fake: S2 did not capture the HTTPS-off output.
    const noHttps = JSON.parse(fixture('status-running.json')) as Record<string, unknown>
    noHttps.CertDomains = []
    ;(noHttps.CurrentTailnet as Record<string, unknown>).MagicDNSEnabled = false
    const off = controller({ port: 8443, outputs: { [`tailscale ${STATUS}`]: ok(JSON.stringify(noHttps)), [`tailscale ${SERVE_STATUS}`]: ok('{}') } })
    const offFound = await off.tailscale.detect({ listenerUp: true })
    expect(offFound.tailscale.https).toBe(false)
    expect(offFound.failure).toEqual({ failure: 'httpsOff' })
    const fine = controller({ port: 8443, outputs: running })
    expect((await fine.tailscale.detect({ listenerUp: false, listenerDetail: 'boom' })).failure).toEqual({ failure: 'listener', detail: 'boom' })
    expect((await fine.tailscale.detect({ listenerUp: true })).failure).toBeNull()
  })

  it('AC-2.4 the internet check probes nothing: no fetch, http or net call', async () => {
    const { tailscale } = controller({
      port: 8443,
      outputs: { [`tailscale ${STATUS}`]: ok(fixture('status-running.json')), [`tailscale ${SERVE_STATUS}`]: ok(fixture('serve-alma.json')) }
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const requestSpy = vi.spyOn(http, 'request')
    const getSpy = vi.spyOn(http, 'get')
    const connectSpy = vi.spyOn(net, 'connect')
    try {
      await tailscale.detect({ listenerUp: true })
    } finally {
      vi.restoreAllMocks()
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(requestSpy).not.toHaveBeenCalled()
    expect(getSpy).not.toHaveBeenCalled()
    expect(connectSpy).not.toHaveBeenCalled()
  })

  it('AC-2.4 a channel portTaken or serveBusy survives as the listener cause', async () => {
    const running = { [`tailscale ${STATUS}`]: ok(fixture('status-running.json')), [`tailscale ${SERVE_STATUS}`]: ok(fixture('serve-alma.json')) }
    const taken = controller({ port: 8443, outputs: running })
    expect((await taken.tailscale.detect({ listenerUp: false, listenerDetail: '8443', channelFailure: 'portTaken' })).failure).toEqual({
      failure: 'portTaken',
      detail: '8443'
    })
    const busy = controller({ port: 8443, outputs: running })
    expect((await busy.tailscale.detect({ listenerUp: false, channelFailure: 'serveBusy' })).failure).toEqual({ failure: 'serveBusy' })
  })

  it('AC-2.2 download asks main to open the fixed download id, and cancel opens nothing', async () => {
    const allowed = controller({ allowOpen: true })
    await expect(allowed.tailscale.download()).resolves.toBe(true)
    expect(allowed.opened).toEqual(['tailscale-download'])
    const cancelled = controller({ allowOpen: false })
    await expect(cancelled.tailscale.download()).resolves.toBe(false)
    expect(cancelled.opened).toEqual(['tailscale-download'])
  })

  it('AC-2.3 no Tailscale call is an installer or a package manager', async () => {
    const { tailscale, calls } = controller({
      port: 8443,
      outputs: { [`tailscale ${STATUS}`]: ok(fixture('status-running.json')), [`tailscale ${SERVE_STATUS}`]: ok(fixture('serve-alma.json')) }
    })
    await tailscale.detect({ listenerUp: true })
    await tailscale.download()
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect([call.file]).toEqual([expect.stringMatching(/^(tailscale|C:\\Program Files\\Tailscale\\tailscale\.exe)$/)])
      expect(['status', 'serve']).toContain(call.args[0])
      expect(`${call.file} ${call.args.join(' ')}`).not.toMatch(/winget|msiexec|npm|install/i)
    }
  })
})

describe('T31 TailscaleController part 2: serve (AC-2.8, 2.11, 2.12, 2.13, 2.16, PD-3)', () => {
  const running = (serve: string): Record<string, ExecResult> => ({
    [`tailscale ${STATUS}`]: ok(fixture('status-running.json')),
    [`tailscale ${SERVE_STATUS}`]: ok(fixture(serve))
  })

  it('port allocation failure carries no prose: a named error the user never reads', () => {
    const error = new PortAllocationError()
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('PortAllocationError')
    expect(error.message).toBe('')
  })

  it('AC-2.11 first start picks a free port and saves it, later starts reuse it', async () => {
    const first = controller({ picked: [8444] })
    await expect(first.tailscale.ensurePort()).resolves.toBe(8444)
    expect(first.store.port).toBe(8444)
    await expect(first.tailscale.ensurePort()).resolves.toBe(8444)
    const second = controller({ port: 8443, picked: [8444] })
    await expect(second.tailscale.ensurePort()).resolves.toBe(8443)
    expect(second.store.port).toBe(8443)
    const corrupt = controller({ port: 99999, picked: [8444] })
    await expect(corrupt.tailscale.ensurePort()).resolves.toBe(8444)
    expect(corrupt.store.port).toBe(8444)
  })

  it('AC-2.8 serve asks the native confirmation with the exact command, then runs it', async () => {
    const confirmCalls: ConfirmCall[] = []
    const calls: ExecCall[] = []
    const t = controller({
      port: 8443,
      calls,
      confirmCalls,
      outputs: { ...running('serve-empty.json'), 'tailscale serve --bg 8443': ok('') }
    })
    await expect(t.tailscale.serve()).resolves.toEqual({ ok: true })
    expect(confirmCalls).toEqual([{ kind: 'serve', params: { command: 'serve --bg 8443' } }])
    expect(calls.map((call) => `${call.file} ${call.args.join(' ')}`)).toEqual([`tailscale ${STATUS}`, `tailscale ${SERVE_STATUS}`, 'tailscale serve --bg 8443'])
  })

  it('AC-2.8 a cancelled serve runs nothing', async () => {
    const calls: ExecCall[] = []
    const t = controller({ port: 8443, calls, allowConfirm: false, outputs: running('serve-empty.json') })
    await expect(t.tailscale.serve()).resolves.toEqual({ ok: false, failure: 'denied' })
    expect(calls.filter((call) => call.args.join(' ') === 'serve --bg 8443')).toEqual([])
  })

  it('AC-2.13 serve refuses a foreign entry and overwrites nothing', async () => {
    const confirmCalls: ConfirmCall[] = []
    const calls: ExecCall[] = []
    const t = controller({ port: 8443, calls, confirmCalls, outputs: running('serve-alma-other-port.json') })
    await expect(t.tailscale.serve()).resolves.toEqual({ ok: false, failure: 'serveBusy' })
    expect(confirmCalls).toEqual([])
    expect(calls.filter((call) => call.args[0] === 'serve' && call.args[1] === '--bg')).toEqual([])
  })

  it('AC-2.13 detect reports serveBusy while someone else holds our path', async () => {
    const t = controller({ port: 8443, outputs: running('serve-alma-other-port.json') })
    const found = await t.tailscale.detect({ listenerUp: true })
    expect(found.tailscale).toEqual({ state: 'connected', https: true, serving: false })
    expect(found.failure).toEqual({ failure: 'serveBusy' })
  })

  it('AC-2.16 pickPort picks another port, saves it and asks again with the new command', async () => {
    const confirmCalls: ConfirmCall[] = []
    const calls: ExecCall[] = []
    const t = controller({
      port: 8443,
      picked: [8444],
      calls,
      confirmCalls,
      outputs: { ...running('serve-alma.json'), 'tailscale serve --bg 8444': ok('') }
    })
    await expect(t.tailscale.pickPort()).resolves.toEqual({ ok: true })
    expect(t.store.port).toBe(8444)
    expect(confirmCalls).toEqual([{ kind: 'serve', params: { command: 'serve --bg 8444' } }])
    expect(calls.map((call) => `${call.file} ${call.args.join(' ')}`)).toContain('tailscale serve --bg 8444')
  })

  it('AC-2.8 a failed serve reads as tailscaleDown with the reason', async () => {
    const t = controller({
      port: 8443,
      outputs: { ...running('serve-empty.json'), 'tailscale serve --bg 8443': { code: 1, stdout: '', stderr: 'boom' } }
    })
    await expect(t.tailscale.serve()).resolves.toEqual({ ok: false, failure: 'tailscaleDown', detail: 'boom' })
  })

  it('AC-2.8 serve with no Tailscale fails safe without asking', async () => {
    const confirmCalls: ConfirmCall[] = []
    const t = controller({ port: 8443, confirmCalls })
    await expect(t.tailscale.serve()).resolves.toEqual({ ok: false, failure: 'tailscaleDown' })
    expect(confirmCalls).toEqual([])
  })

  it('T32 dnsName reads the current DNS name, null when unknown', async () => {
    const t = controller({ outputs: { [`tailscale ${STATUS}`]: ok(fixture('status-running.json')) } })
    await expect(t.tailscale.dnsName()).resolves.toBe('alma-pc.tail0000.ts.net')
    const missingBinary = controller()
    await expect(missingBinary.tailscale.dnsName()).resolves.toBeNull()
  })

  it('AC-2.12 unserve removes only a mine entry, with no dialog', async () => {
    const calls: ExecCall[] = []
    const confirmCalls: ConfirmCall[] = []
    const t = controller({
      port: 8443,
      calls,
      confirmCalls,
      outputs: { ...running('serve-alma.json'), 'tailscale serve --https=443 --set-path / off': ok('') }
    })
    await t.tailscale.unserve()
    expect(confirmCalls).toEqual([])
    expect(calls.map((call) => `${call.file} ${call.args.join(' ')}`)).toEqual([
      `tailscale ${STATUS}`,
      `tailscale ${SERVE_STATUS}`,
      'tailscale serve --https=443 --set-path / off'
    ])
  })

  it('AC-2.12 unserve never touches a foreign, missing or unreadable entry', async () => {
    for (const serve of ['serve-alma-other-port.json', 'serve-empty.json']) {
      const calls: ExecCall[] = []
      const t = controller({ port: 8443, calls, outputs: running(serve) })
      await t.tailscale.unserve()
      expect(calls.filter((call) => call.args.includes('off'))).toEqual([])
    }
    const noPortCalls: ExecCall[] = []
    const noPort = controller({ calls: noPortCalls, outputs: {} })
    await noPort.tailscale.unserve()
    expect(noPortCalls).toEqual([])
    const garbageCalls: ExecCall[] = []
    const garbage = controller({ port: 8443, calls: garbageCalls, outputs: { [`tailscale ${STATUS}`]: ok('xxx') } })
    await garbage.tailscale.unserve()
    expect(garbageCalls.filter((call) => call.args.includes('off'))).toEqual([])
  })

  it('AC-2.12 a failed removal resolves: the entry self-heals on the next serve', async () => {
    const t = controller({
      port: 8443,
      outputs: { ...running('serve-alma.json'), 'tailscale serve --https=443 --set-path / off': { code: 1, stdout: '', stderr: 'boom' } }
    })
    await expect(t.tailscale.unserve()).resolves.toBeUndefined()
  })

  it('AC-2.3 serve flows add no installer or package-manager call', async () => {
    const { tailscale, calls } = controller({
      port: 8443,
      picked: [8444],
      outputs: {
        ...running('serve-empty.json'),
        'tailscale serve --bg 8443': ok(''),
        'tailscale serve --bg 8444': ok('')
      }
    })
    await tailscale.serve()
    await tailscale.pickPort()
    for (const call of calls) {
      expect([call.file]).toEqual([expect.stringMatching(/^(tailscale|C:\\Program Files\\Tailscale\\tailscale\.exe)$/)])
      expect(['status', 'serve']).toContain(call.args[0])
      expect(`${call.file} ${call.args.join(' ')}`).not.toMatch(/winget|msiexec|npm|install/i)
    }
  })
})

describe('T32 TailscaleTransport (AC-3.1, 3.3, 3.4, PD-8)', () => {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  it('T32 the not-built notice renders in both PC languages', () => {
    expect(notBuiltPage()).toContain('Alma remote is not built yet.')
    expect(notBuiltPage()).toContain('El acceso remoto de Alma aún no está listo.')
  })

  function writeAssets(): string {
    const dir = mkdtempSync(join(tmpdir(), 'alma-pwa-'))
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Alma</title>')
    writeFileSync(join(dir, 'app.js'), 'console.log(1)')
    writeFileSync(join(dir, 'style.css'), 'body{}')
    writeFileSync(join(dir, 'sw.js'), '/* worker */')
    writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"Alma"}')
    return dir
  }

  async function serve(
    handler: RemoteHandler,
    assetsDir?: string
  ): Promise<{ transport: TailscaleTransport; port: number }> {
    const transport = new TailscaleTransport({ port: 0, assetsDir: assetsDir ?? writeAssets(), dnsName: 'alma-pc.tail0000.ts.net.' })
    const started = await transport.start(handler)
    expect(started.address).toBe('https://alma-pc.tail0000.ts.net')
    const port = transport.localPort()
    if (port === null) throw new Error('no local port')
    return { transport, port }
  }

  function httpRequest(
    port: number,
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: string
  ): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
    return new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, method, path, headers }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }))
      })
      request.on('error', reject)
      if (body !== undefined) request.write(body)
      request.end()
    })
  }

  it('AC-3.4 bindAddress accepts only loopback', () => {
    expect(bindAddress('127.0.0.1')).toBe('127.0.0.1')
    expect(() => bindAddress('0.0.0.0')).toThrow(RangeError)
    expect(() => bindAddress('::')).toThrow(RangeError)
    expect(() => bindAddress('')).toThrow(RangeError)
  })

  it('AC-3.4 the server really listens on loopback', async () => {
    const { transport, port } = await serve(async () => ({ status: 200, body: { ok: true } }))
    try {
      const response = await httpRequest(port, 'GET', '/api/hello', { host: 'alma-pc.tail0000.ts.net' })
      expect(response.status).toBe(200)
    } finally {
      await transport.stop()
    }
  })

  it('AC-3.1 every session route refuses a request without credentials over real HTTP', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const { transport, port } = await serve(t.channel.handle)
    try {
      const sessionRoutes = ROUTES.filter((r) => r.auth === 'session')
      expect(sessionRoutes.length).toBeGreaterThan(10)
      const seen = new Set<string>()
      for (const route of sessionRoutes) {
        const response = await httpRequest(port, route.method, route.path, { ...HOST })
        expect(response.status, route.path).toBe(401)
        expect(response.text, route.path).toBe(JSON.stringify({ error: 'unknown-device' }))
        seen.add(response.text)
      }
      expect([...seen]).toEqual([JSON.stringify({ error: 'unknown-device' })])
    } finally {
      await transport.stop()
    }
  })

  it('T32 API responses carry Cache-Control: no-store', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const { transport, port } = await serve(t.channel.handle)
    try {
      const okResponse = await httpRequest(port, 'GET', '/api/hello', { ...HOST })
      expect(okResponse.status).toBe(200)
      expect(okResponse.headers['cache-control']).toBe('no-store')
      const refused = await httpRequest(port, 'GET', '/api/approvals', { ...HOST })
      expect(refused.status).toBe(401)
      expect(refused.headers['cache-control']).toBe('no-store')
    } finally {
      await transport.stop()
    }
  })

  it('T32 a body over 1 MB is refused before the handler runs', async () => {
    let called = false
    const { transport, port } = await serve(async () => {
      called = true
      return { status: 200 }
    })
    try {
      const response = await httpRequest(port, 'POST', '/api/chat/send', { host: 'alma-pc.tail0000.ts.net' }, 'x'.repeat(1024 * 1024 + 1))
      expect(response.status).toBe(413)
      expect(response.text).toBe(JSON.stringify({ error: 'too-large' }))
      expect(called).toBe(false)
    } finally {
      await transport.stop()
    }
  })

  it('T32 static files serve with types and the PWA CSP', async () => {
    const { transport, port } = await serve(async () => ({ status: 200 }))
    try {
      const csp = "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"
      const index = await httpRequest(port, 'GET', '/')
      expect(index.status).toBe(200)
      expect(index.headers['content-type']).toContain('text/html')
      expect(index.headers['content-security-policy']).toBe(csp)
      expect(index.headers['x-content-type-options']).toBe('nosniff')
      expect(index.text).toContain('<title>Alma</title>')
      const js = await httpRequest(port, 'GET', '/app.js')
      expect(js.headers['content-type']).toContain('text/javascript')
      expect(js.headers['content-security-policy']).toBe(csp)
      expect((await httpRequest(port, 'GET', '/style.css')).headers['content-type']).toContain('text/css')
      expect((await httpRequest(port, 'GET', '/sw.js')).headers['content-type']).toContain('text/javascript')
      expect((await httpRequest(port, 'GET', '/manifest.webmanifest')).headers['content-type']).toContain('application/manifest+json')
      expect((await httpRequest(port, 'GET', '/nope.js')).status).toBe(404)
    } finally {
      await transport.stop()
    }
  })

  // Headless Chrome (2026-11-08): under `default-src 'self'` alone a data: image fires a CSP violation, so camera stills
  // (026 T44) and note images (028 AC-2.11, sent as base64) never rendered. Only data: is added, and only for images.
  it('AC-2.11 (028) the PWA CSP lets data: images load (stills and note images are base64) and loosens nothing else', async () => {
    const { transport, port } = await serve(async () => ({ status: 200 }))
    try {
      const header = (await httpRequest(port, 'GET', '/')).headers['content-security-policy'] as string
      const directives = Object.fromEntries(header.split(';').map((part) => part.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources]))
      expect(directives).toEqual({
        'default-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
        'object-src': ["'none'"]
      })
      expect(header).not.toMatch(/https?:|blob:|\*|unsafe-/)
    } finally {
      await transport.stop()
    }
  })

  it('T32 resolveAssetPath refuses traversal, absolute paths and null bytes', () => {
    const root = join('C:', 'app', 'remote')
    expect(resolveAssetPath(root, '/')).toBe(join(root, 'index.html'))
    expect(resolveAssetPath(root, '/app.js')).toBe(join(root, 'app.js'))
    expect(resolveAssetPath(root, '//secret')).toBe(join(root, 'secret'))
    for (const evil of ['/../secret', '/%2e%2e/secret', '/%2E%2E/secret', '/a/../../secret', '/%5c..%5csecret', '/a\\..\\x', '/C:/secret', '/a:b', '/a%00b']) {
      expect(resolveAssetPath(root, evil), evil).toBeNull()
    }
    expect(resolveAssetPath(root, '/%zz')).toBeNull()
  })

  it('T32 traversal over real HTTP never leaves the assets directory', async () => {
    const dir = writeAssets()
    const { transport, port } = await serve(async () => ({ status: 200 }), dir)
    try {
      for (const evil of ['/../secret', '/%2e%2e/secret', '/a/../../secret', '/%5c..%5csecret']) {
        expect((await httpRequest(port, 'GET', evil)).status, evil).toBe(404)
      }
      const outside = join(tmpdir(), `alma-pwa-outside-${Date.now()}.txt`)
      writeFileSync(outside, 'outside-marker')
      try {
        symlinkSync(outside, join(dir, 'link.txt'))
      } catch {
        return // No symlink rights on this machine (Windows): the unit cases above still pin the resolver.
      }
      const linked = await httpRequest(port, 'GET', '/link.txt')
      expect(linked.status).toBe(404)
      expect(linked.text).not.toContain('outside-marker')
    } finally {
      await transport.stop()
    }
  })

  it('T32 a missing assets directory serves the not-built notice, and the API still works', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const { transport, port } = await serve(t.channel.handle, join(tmpdir(), `alma-pwa-missing-${Date.now()}`))
    try {
      const notice = await httpRequest(port, 'GET', '/')
      expect(notice.status).toBe(503)
      expect(notice.text).toContain('Alma remote is not built yet.')
      expect(notice.text).toContain('El acceso remoto de Alma aún no está listo.')
      const api = await httpRequest(port, 'GET', '/api/hello', { ...HOST })
      expect(api.status).toBe(200)
    } finally {
      await transport.stop()
    }
  })

  it('AC-3.3 loopback passes with our origin or none, foreign origins are refused', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const { transport, port } = await serve(t.channel.handle)
    try {
      const loopback = `127.0.0.1:${port}`
      expect((await httpRequest(port, 'GET', '/api/hello', { host: loopback, origin: 'https://test.invalid' })).status).toBe(200)
      expect((await httpRequest(port, 'GET', '/api/hello', { host: loopback })).status).toBe(200)
      expect((await httpRequest(port, 'GET', '/api/hello', { host: loopback, origin: 'https://evil.com' })).status).toBe(400)
      expect((await httpRequest(port, 'GET', '/api/hello', { host: 'evil.ts.net' })).status).toBe(400)
    } finally {
      await transport.stop()
    }
  })

  it('AC-3.4 loopback without credentials is refused like any other', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const { transport, port } = await serve(t.channel.handle)
    try {
      const response = await httpRequest(port, 'GET', '/api/approvals', { host: `127.0.0.1:${port}` })
      expect(response.status).toBe(401)
      expect(response.text).toBe(JSON.stringify({ error: 'unknown-device' }))
    } finally {
      await transport.stop()
    }
  })

  it("T32 closeDevice destroys that device's sockets", async () => {
    let arrived = 0
    const { transport, port } = await serve(async () => {
      arrived++
      return new Promise<RemoteResponse>(() => {})
    })
    try {
      transport.track('tok-a', 'a')
      transport.track('tok-b', 'b')
      const closed: string[] = []
      const open = (token: string): Promise<void> =>
        new Promise((resolve) => {
          const request = http.request(
            { host: '127.0.0.1', port, method: 'GET', path: '/api/status', headers: { host: 'a.', authorization: `Bearer ${token}` } },
            (response) => {
              response.on('close', () => {
                closed.push(token)
                resolve()
              })
            }
          )
          request.on('error', () => {
            closed.push(token)
            resolve()
          })
          request.end()
        })
      const first = open('tok-a')
      const second = open('tok-b')
      await vi.waitFor(() => expect(arrived).toBe(2))
      transport.closeDevice('a')
      await first
      await sleep(50)
      expect(closed).toEqual(['tok-a'])
      transport.closeDevice('b')
      await second
      expect(closed).toEqual(['tok-a', 'tok-b'])
    } finally {
      await transport.stop()
    }
  })

  it('T32 a taken port fails with portTaken and changes nothing', async () => {
    const occupier = net.createServer()
    await new Promise<void>((resolve) => occupier.listen(0, '127.0.0.1', resolve))
    const address = occupier.address()
    const taken = typeof address === 'object' && address !== null ? address.port : 0
    expect(taken).toBeGreaterThan(0)
    const transport = new TailscaleTransport({ port: taken, assetsDir: writeAssets(), dnsName: 'a.' })
    const failure = await transport.start(async () => ({ status: 200 })).then(
      () => null,
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(TransportStartError)
    expect((failure as TransportStartError).failure).toBe('portTaken')
    expect((failure as TransportStartError).message).toContain(String(taken))
    await transport.stop()
    occupier.close()
  })
})

describe('T33 TailscaleMonitor (AC-8.2, 2.10, 2.15, 7.4, BR-6)', () => {
  const DAY = 86_400_000
  const NOW = Date.parse('2026-11-07T00:00:00Z')
  type Probe = { connected: boolean; keyExpiry: string | null; dnsName: string | null }
  const up: Probe = { connected: true, keyExpiry: null, dnsName: 'alma-pc.tail0000.ts.net.' }
  const down: Probe = { connected: false, keyExpiry: null, dnsName: 'alma-pc.tail0000.ts.net.' }

  function monitor(over: {
    reads?: Probe[]
    hostName?: string | null
    now?: number
  } = {}): {
    monitor: TailscaleMonitor
    outages: number
    recoveries: number
    facts: { keyExpiresInDays?: number; renamed?: boolean }[]
    notices: number
    store: { hostName: string | null }
  } {
    const reads = over.reads ?? []
    let index = 0
    let outages = 0
    let recoveries = 0
    let notices = 0
    const facts: { keyExpiresInDays?: number; renamed?: boolean }[] = []
    const store = { hostName: over.hostName ?? null }
    const self = {
      monitor: new TailscaleMonitor({
        read: async () => reads[Math.min(index++, reads.length - 1)] ?? up,
        now: () => over.now ?? NOW,
        store: {
          state: store,
          update: async (patch) => {
            Object.assign(store, patch)
          }
        },
        channel: {
          reportOutage: () => {
            outages++
          },
          reportRecovery: async () => {
            recoveries++
          },
          reportFacts: (next) => {
            facts.push(next)
          }
        },
        notify: () => {
          notices++
        }
      }),
      get outages() {
        return outages
      },
      get recoveries() {
        return recoveries
      },
      facts,
      get notices() {
        return notices
      },
      store
    }
    return self
  }

  it('AC-8.2 connected stays online without outage or notice', async () => {
    const m = monitor({ reads: [up, up, up] })
    await m.monitor.poll()
    await m.monitor.poll()
    await m.monitor.poll()
    expect(m.outages).toBe(0)
    expect(m.recoveries).toBe(0)
    expect(m.notices).toBe(0)
  })

  it('AC-8.2 stays down on a fresh start without notifying', async () => {
    const m = monitor({ reads: [down, down] })
    await m.monitor.poll()
    await m.monitor.poll()
    expect(m.outages).toBe(0)
    expect(m.recoveries).toBe(0)
    expect(m.notices).toBe(0)
  })

  it('AC-8.2 goes down on the first disconnected read, exactly one notice per outage', async () => {
    const m = monitor({ reads: [up, down, down, up, down] })
    await m.monitor.poll()
    expect(m.outages).toBe(0)
    await m.monitor.poll()
    expect(m.outages).toBe(1)
    expect(m.notices).toBe(1)
    await m.monitor.poll()
    expect(m.outages).toBe(1)
    expect(m.notices).toBe(1)
    await m.monitor.poll()
    expect(m.recoveries).toBe(1)
    expect(m.notices).toBe(1)
    await m.monitor.poll()
    expect(m.outages).toBe(2)
    expect(m.notices).toBe(2)
  })

  it('AC-8.2 a restarted monitor does not re-notify an ongoing outage', async () => {
    const first = monitor({ reads: [up, down] })
    await first.monitor.poll()
    await first.monitor.poll()
    expect(first.notices).toBe(1)
    const second = monitor({ reads: [down, up, down] })
    await second.monitor.poll()
    expect(second.outages).toBe(0)
    expect(second.notices).toBe(0)
    await second.monitor.poll()
    expect(second.recoveries).toBe(1)
    await second.monitor.poll()
    expect(second.outages).toBe(1)
    expect(second.notices).toBe(1)
  })

  it('AC-2.10 the key countdown shows at 14 days and under, nothing beyond or missing', async () => {
    const expiry = (days: number): string => new Date(NOW + days * DAY).toISOString()
    const m = monitor({ reads: [{ ...up, keyExpiry: expiry(15) }, { ...up, keyExpiry: expiry(14) }, { ...up, keyExpiry: expiry(3) }, up] })
    await m.monitor.poll()
    expect(m.facts.at(-1)).toEqual({ keyExpiresInDays: undefined, renamed: undefined })
    await m.monitor.poll()
    expect(m.facts.at(-1)?.keyExpiresInDays).toBe(14)
    await m.monitor.poll()
    expect(m.facts.at(-1)?.keyExpiresInDays).toBe(3)
    await m.monitor.poll()
    expect(m.facts.at(-1)?.keyExpiresInDays).toBeUndefined()
  })

  it('AC-2.15 equal and missing names are not renames, first sight stores the baseline', async () => {
    const same = monitor({ reads: [up], hostName: 'alma-pc.tail0000.ts.net.' })
    await same.monitor.poll()
    expect(same.facts.at(-1)?.renamed).toBeUndefined()
    expect(same.store.hostName).toBe('alma-pc.tail0000.ts.net.')
    const unknown = monitor({ reads: [{ ...up, dnsName: null }], hostName: 'alma-pc.tail0000.ts.net.' })
    await unknown.monitor.poll()
    expect(unknown.facts.at(-1)?.renamed).toBeUndefined()
    expect(unknown.store.hostName).toBe('alma-pc.tail0000.ts.net.')
    const first = monitor({ reads: [up] })
    await first.monitor.poll()
    expect(first.facts.at(-1)?.renamed).toBeUndefined()
    expect(first.store.hostName).toBe('alma-pc.tail0000.ts.net.')
  })

  it('AC-2.15 a changed name marks renamed, stores the new name and latches', async () => {
    const m = monitor({ reads: [{ ...up, dnsName: 'new-pc.tail0000.ts.net.' }], hostName: 'alma-pc.tail0000.ts.net.' })
    await m.monitor.poll()
    expect(m.facts.at(-1)?.renamed).toBe(true)
    expect(m.store.hostName).toBe('new-pc.tail0000.ts.net.')
    await m.monitor.poll()
    expect(m.facts.at(-1)?.renamed).toBe(true)
  })

  it('T33 the outage is audited for the channel underneath, once', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    expect(t.channel.currentStatus().state).toBe('online')
    const reads: Probe[] = [up, down, down, up]
    let index = 0
    const notified: number[] = []
    const watcher = new TailscaleMonitor({
      read: async () => reads[Math.min(index++, reads.length - 1)] ?? up,
      now: () => NOW,
      store: { state: { hostName: null }, update: async () => undefined },
      channel: t.channel,
      notify: () => {
        notified.push(1)
      }
    })
    await watcher.poll()
    await watcher.poll()
    expect(t.channel.currentStatus()).toMatchObject({ state: 'error', failure: 'tailscaleDown' })
    t.channel.reportOutage()
    const outages = t.records.filter((entry) => entry.action === 'remote.tailscale.down')
    expect(outages).toHaveLength(1)
    expect(outages[0]).toMatchObject({ actor: 'remote', outcome: 'error' })
    expect(notified).toHaveLength(1)
    await watcher.poll()
    await watcher.poll()
    expect(t.channel.currentStatus().state).toBe('online')
    expect(t.records.filter((entry) => entry.action === 'remote.tailscale.down')).toHaveLength(1)
  })

  it('T33 recovery restarts the listener when it never started', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.reportRecovery()
    expect(t.channel.currentStatus().state).toBe('online')
  })

  it('T33 the monitor polls every 30 seconds', async () => {
    expect(MONITOR_MS).toBe(30_000)
    const m = monitor({ reads: [up] })
    vi.useFakeTimers()
    try {
      m.monitor.start()
      expect(m.facts).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(m.facts).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(m.facts).toHaveLength(2)
      m.monitor.stop()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(m.facts).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('T33 probe maps status to connected, expiry and dnsName', async () => {
    const running = controller({ outputs: { [`tailscale ${STATUS}`]: ok(fixture('status-running.json')) } })
    await expect(running.tailscale.probe()).resolves.toEqual({
      connected: true,
      keyExpiry: '2027-05-06T05:16:34Z',
      dnsName: 'alma-pc.tail0000.ts.net'
    })
    const stopped = controller({ outputs: { [`tailscale ${STATUS}`]: ok(fixture('status-stopped.json')) } })
    await expect(stopped.tailscale.probe()).resolves.toMatchObject({ connected: false })
    const gone = controller()
    await expect(gone.tailscale.probe()).resolves.toEqual({ connected: false, keyExpiry: null, dnsName: null })
  })
})
