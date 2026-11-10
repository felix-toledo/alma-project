import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { ApprovalBroker, authorize, type Decision } from '../../src/coordinator/approval'
import { RemoteChannel, type RemoteDeps } from '../../src/coordinator/channels/remote/channel'
import type { RemoteTransport } from '../../src/coordinator/channels/remote/transport'
import { ToolError } from '../../src/coordinator/tools/types'
import {
  DeviceStore,
  RemoteStateStore,
  type DeviceStore as DeviceStoreType,
  type SealBox
} from '../../src/coordinator/channels/remote/store'
import { defaultSettings } from '../../src/shared/defaults'
import { b64u } from '../../src/shared/remote/crypto'
import type { MessageAttachment } from '../../src/shared/attach/compose'
import type { Refusal, RemoteResponse } from '../../src/shared/remote/api'
import { defaultRemote } from '../../src/shared/remote/settings'
import type { AuditEvent } from '../../src/shared/audit'
import type { HomeThing } from '../../src/shared/home'
import type { ApprovalMode, ChatMessage, DeviceView, LiveEvent, PairingView, PendingApproval, ProviderId, RemoteSettings, RemoteStatus, Thread, ThreadSummary, VaultEntry } from '../../src/shared/types'
import { RelayPairTransport } from './relay-pair'
import { LocalTestTransport } from './remote-local-transport'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const sealBox: SealBox = {
  seal: async (plain: string) => `sealed:${plain}`,
  open: async (sealed: string) => sealed.slice('sealed:'.length)
}

export type ConfirmAnswer = boolean | ((kind: string, params: Record<string, string>) => boolean | Promise<boolean>)

export interface FakeChat {
  threads: Thread[]
  askCalls: { threadId: string; text: string; attachments?: string[] }[]
  pending: { threadId: string; promise: Promise<void>; settled: boolean; resolve(): void; reject(error: unknown): void }[]
  cancelCalls: string[]
  approvals: { id: string; denied: boolean }[]
  throwSync: boolean
  resolveAsk(index: number, text: string): void
  rejectAsk(index: number, error: unknown): void
  seed(messages: ChatMessage[]): void
}

export interface HarnessApprovals {
  broker: ApprovalBroker
  events: LiveEvent[]
  /** The answers the phone actually sent to the broker (proves ignored answers never arrive). */
  answered: { approvalId: string; decision: 'allow' | 'deny' }[]
  askApproval(input: Omit<PendingApproval, 'approvalId'>): { approvalId: string; decision: Promise<Decision> }
}

export interface FakeHome {
  things: HomeThing[]
  calls: { entityId: string; service: string; data: unknown }[]
  snapshotCalls: string[]
  snapshotBytes: Buffer
  snapshotError: Error | null
  inbox: string
  ready: boolean
  enabled: boolean
  engineState: string
  remembered: string[]
}

/**
 * An in-memory vault shaped like the KnowledgeBase surface the phone reads through. `put` with `listed: false`
 * stores bytes the tree never shows (a hidden folder, a junction target, an 8.3 alias), which is what the
 * reachability checks must refuse even though the "disk" would serve them.
 */
export interface FakeVault {
  active: 'none' | 'ready'
  entries: VaultEntry[]
  reads: { tree: number; readText: number; readBytes: number }
  put(path: string, content: string | Uint8Array, options?: { listed?: boolean; mtime?: number }): void
  remove(path: string): void
  state(): 'none' | 'ready'
  tree(): Promise<VaultEntry[]>
  readText(path: string): Promise<{ content: string; mtime: number }>
  readBytes(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; mtime: number }>
}

export function fakeVault(): FakeVault {
  const files = new Map<string, { bytes: Uint8Array; mtime: number }>()
  const vault: FakeVault = {
    active: 'ready',
    entries: [],
    reads: { tree: 0, readText: 0, readBytes: 0 },
    put(path, content, options = {}) {
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
      const mtime = options.mtime ?? 1
      files.set(path, { bytes, mtime })
      vault.entries = vault.entries.filter((entry) => entry.path !== path)
      if (options.listed === false) return
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++) {
        const folder = parts.slice(0, i).join('/')
        if (!vault.entries.some((entry) => entry.path === folder)) vault.entries.push({ path: folder, kind: 'folder', size: 0, mtime: 0 })
      }
      vault.entries.push({ path, kind: 'file', size: bytes.length, mtime })
    },
    remove(path) {
      files.delete(path)
      vault.entries = vault.entries.filter((entry) => entry.path !== path)
    },
    state: () => vault.active,
    async tree() {
      vault.reads.tree++
      return vault.entries.map((entry) => ({ ...entry }))
    },
    async readText(path) {
      vault.reads.readText++
      const file = files.get(path)
      if (!file) throw new ToolError('tool.kb.noNote', { path })
      if (file.bytes.length > 5 * 1024 * 1024) throw new ToolError('tool.kb.tooBig', { path, bytes: file.bytes.length })
      return { content: new TextDecoder().decode(file.bytes), mtime: file.mtime }
    },
    async readBytes(path, maxBytes) {
      vault.reads.readBytes++
      const file = files.get(path)
      if (!file) throw new ToolError('tool.kb.noNote', { path })
      if (file.bytes.length > maxBytes) throw new ToolError('tool.kb.tooBig', { path, bytes: file.bytes.length })
      return { bytes: file.bytes, mtime: file.mtime }
    }
  }
  return vault
}

/** The attachment store as the remote module reaches it (spec 031): records every call, hands out ids, and can be told to refuse. */
export interface FakeFiles {
  puts: { threadId: string; name: string; size: number; base64: string }[]
  removes: string[]
  /** Refuses every put with this reason until set back to null. */
  refuse: Refusal | null
  /** Providers a send still owes a notice to (what the real store derives from the conversation as it is at send). */
  owed: ProviderId[]
  /** What the fake store holds: a put adds an entry, a remove drops it. */
  stored: Map<string, MessageAttachment>
  put(input: { threadId: string; name: string; size: number; base64: string }): { ok: true; attachment: MessageAttachment } | { ok: false; reason: Refusal }
  remove(id: string): void
  readersOwed(threadId: string, ids: readonly string[]): ProviderId[]
}

/** Timers on the harness clock (`setNow`): nothing fires by itself, `fireDue` runs what is due. */
export interface FakeTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
  /** Timers waiting to fire. */
  active(): number
  fireDue(): void
}

/** Conversations as the coordinator's store exposes them to the remote channel, backed by `chat.threads`. */
export interface FakeThreads {
  /** Ids a run is in progress on, as the PC would report them. */
  running: Set<string>
  list(): ThreadSummary[]
  get(id: string): Thread | undefined
  isRunning(id: string): boolean
  /** The `markOpened` calls the phone's reads made, in order. */
  opened: { id: string; at: number }[]
  markOpened(id: string, at: number): void
}

/** A fake attachment store: records every call, hands out ids, and refuses with `refuse` while it is set. */
export function fakeFiles(): FakeFiles {
  let count = 0
  const files: FakeFiles = {
    puts: [],
    removes: [],
    refuse: null,
    owed: [],
    stored: new Map(),
    put: (input) => {
      files.puts.push(input)
      if (files.refuse) return { ok: false, reason: files.refuse }
      count++
      const attachment: MessageAttachment = { id: `att-${count}`, name: input.name, kind: input.name.endsWith('.png') ? 'image' : 'text', size: input.size }
      files.stored.set(attachment.id, attachment)
      return { ok: true, attachment }
    },
    remove: (id) => {
      files.removes.push(id)
      files.stored.delete(id)
    },
    readersOwed: () => files.owed
  }
  return files
}

/** Fake timers that read the clock they are given (the harness's `setNow`); `fireDue` runs what is due. */
export function fakeTimers(clock: () => number): FakeTimers {
  const waiting: { fn: () => void; due: number }[] = []
  return {
    set: (fn, ms) => {
      const timer = { fn, due: clock() + ms }
      waiting.push(timer)
      return timer
    },
    clear: (handle) => {
      const at = waiting.indexOf(handle as (typeof waiting)[number])
      if (at >= 0) waiting.splice(at, 1)
    },
    active: () => waiting.length,
    fireDue: () => {
      for (const timer of waiting.filter((known) => known.due <= clock())) {
        waiting.splice(waiting.indexOf(timer), 1)
        timer.fn()
      }
    }
  }
}

/** The agent of a company: its conversations are never listed or reachable from the phone. */
export const COMPANY_AGENT = 'ceo'

export interface Harness {
  channel: RemoteChannel
  transport: LocalTestTransport
  store: DeviceStoreType
  state: RemoteStateStore
  /** The temp dir the stores use; devices.json lives directly under it. */
  dir: string
  /** Outbound push posts the channel made. */
  posts: { url: string; headers: Record<string, string>; body: Uint8Array }[]
  /** Makes the next push posts throw (AC-11.5). */
  failPost(): void
  /** The endpoints of the posts that threw: one each means nothing was retried (033 AC-7.6). */
  refused: string[]
  chat: FakeChat
  approvals: HarnessApprovals
  home: FakeHome
  vault: FakeVault
  threads: FakeThreads
  files: FakeFiles
  timers: FakeTimers
  /** A coordinator event as the channel hears it (the broker's own approval events already arrive this way). */
  emit(event: LiveEvent): void
  /** A device paired and in session on first use; the later calls reuse it. Remote must be enabled and synced by the test. */
  phone(): Promise<{ deviceId: string; headers: Record<string, string> }>
  /** An authenticated POST as that device. */
  call(path: string, body?: unknown): Promise<RemoteResponse>
  records: AuditEvent[]
  testResults: { deviceId: string; ok: boolean }[]
  factoryCalls: () => number
  statuses: RemoteStatus[]
  pairings: (PairingView | null)[]
  deviceLists: DeviceView[][]
  confirmCalls: { kind: string; params: Record<string, string> }[]
  setConfirm: (answer: ConfirmAnswer) => void
  setRemote: (patch: Partial<RemoteSettings>) => void
  setNow: (now: number) => void
  setApprovalMode: (mode: ApprovalMode) => void
  setAlwaysAllowTools: (tools: string[]) => void
}

export function makeThread(id: string, agentId = 'general'): Thread {
  return { id, title: id, agentId, workspace: '', createdAt: 0, updatedAt: 0, messages: [], subagents: {}, toolStates: {} }
}

export async function testChannel(overrides?: {
  remote?: Partial<RemoteSettings>
  failStart?: unknown
  failTransport?: unknown
  /** Run the channel over another transport (the relay pair) instead of the in-process one. */
  transport?: RemoteTransport
  confirm?: ConfirmAnswer
  random?: (length: number) => Uint8Array
  record?: (entry: AuditEvent) => void
  /** The dream service's one-time phone landing (spec 033 BR-29). */
  landing?: (deviceId: string) => string | null
}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'alma-remote-channel-'))
  dirs.push(dir)
  let remote = { ...defaultRemote(), ...overrides?.remote }
  let approvalMode: ApprovalMode = 'needs-approval'
  let alwaysAllowTools: string[] = []
  const home: FakeHome = {
    things: [
      { id: 'l1', name: 'Luz techo', kind: 'light', areaId: 'cocina', entityId: 'light.techo', state: 'off', on: false, available: true, attrs: {}, sensors: [] },
      { id: 'k1', name: 'Puerta', kind: 'lock', areaId: null, entityId: 'lock.puerta', state: 'locked', on: false, available: true, attrs: {}, sensors: [] },
      { id: 'g1', name: 'Portón', kind: 'cover', areaId: null, entityId: 'cover.porton', state: 'closed', on: false, available: true, attrs: {}, sensors: [], deviceClass: 'garage' },
      { id: 'b1', name: 'Persiana', kind: 'cover', areaId: null, entityId: 'cover.persiana', state: 'open', on: true, available: true, attrs: {}, sensors: [], deviceClass: 'shutter' },
      { id: 'a1', name: 'Alarma', kind: 'alarm', areaId: null, entityId: 'alarm.casa', state: 'disarmed', on: false, available: true, attrs: {}, sensors: [] },
      { id: 's1', name: 'Sirena', kind: 'alarm', areaId: null, entityId: 'siren.patio', state: 'idle', on: null, available: true, attrs: {}, sensors: [] },
      { id: 'c1', name: 'Cámara patio', kind: 'camera', areaId: null, entityId: 'camera.patio', state: 'idle', on: null, available: true, attrs: {}, sensors: [] },
      { id: 'c2', name: 'Cámara techo', kind: 'camera', areaId: null, entityId: 'camera.techo', state: 'idle', on: null, available: true, attrs: {}, sensors: [] }
    ],
    calls: [],
    snapshotCalls: [],
    snapshotBytes: Buffer.from('jpeg'),
    snapshotError: null,
    inbox: mkdtempSync(join(tmpdir(), 'alma-remote-inbox-')),
    ready: true,
    enabled: true,
    engineState: 'ready',
    remembered: []
  }
  const records: AuditEvent[] = []
  const testResults: Harness['testResults'] = []
  const posts: Harness['posts'] = []
  let postBroken = false
  const refused: string[] = []
  let now = 0
  let answer = overrides?.confirm ?? true
  const statuses: RemoteStatus[] = []
  const pairings: (PairingView | null)[] = []
  const deviceLists: DeviceView[][] = []
  const confirmCalls: Harness['confirmCalls'] = []
  // The 026 suites rerun over the relay pair when this is set (spec 027 T17); nothing else about them changes.
  const transport = process.env['ALMA_TEST_TRANSPORT'] === 'relay' ? new RelayPairTransport() : new LocalTestTransport()
  if (overrides?.failStart !== undefined) transport.startError = overrides.failStart
  let calls = 0
  const store = await DeviceStore.load({ dir, now: () => now, sealBox })
  const state = await RemoteStateStore.load({ dir, sealBox })
  const threads = [makeThread('remote')]
  let current = 0
  const askCalls: FakeChat['askCalls'] = []
  const pending: FakeChat['pending'] = []
  const cancelCalls: string[] = []
  const chat: FakeChat = {
    threads,
    askCalls,
    pending,
    cancelCalls,
    approvals: [{ id: 'a1', denied: false }],
    throwSync: false,
    resolveAsk(index, text) {
      const ask = pending[index]
      if (!ask || ask.settled) return
      ask.settled = true
      threads.find((thread) => thread.id === ask.threadId)?.messages.push({ role: 'assistant', content: [{ type: 'text', text }], ts: now })
      ask.resolve()
    },
    rejectAsk(index, error) {
      const ask = pending[index]
      if (!ask || ask.settled) return
      ask.settled = true
      ask.reject(error)
    },
    seed(messages) {
      threads[current]?.messages.push(...messages)
    }
  }
  let channelListener: ((event: LiveEvent) => void) | null = null
  const events: LiveEvent[] = []
  const answered: HarnessApprovals['answered'] = []
  const broker = new ApprovalBroker((event) => {
    events.push(event)
    channelListener?.(event)
  })
  const aborter = new AbortController()
  const approvals: HarnessApprovals = {
    broker,
    events,
    answered,
    askApproval(input) {
      let approvalId = ''
      const decision = broker.ask(input, aborter.signal, (given) => {
        approvalId = given
      })
      return { approvalId, decision }
    }
  }
  const hub = {
    get ready(): boolean {
      return home.ready
    },
    snapshot: () => ({ things: home.things, areas: [{ id: 'cocina', name: 'Cocina' }], scenes: [], automations: [] }),
    find: (query: string) => home.things.filter((thing) => thing.id === query || thing.entityId === query),
    thing: (id: string) => home.things.find((thing) => thing.id === id || thing.entityId === id),
    control: async (entityId: string, service: string, data: Record<string, unknown> = {}) => {
      home.calls.push({ entityId, service, data })
      const thing = home.things.find((known) => known.entityId === entityId)
      if (thing && service === 'light/turn_on') {
        thing.on = true
        thing.state = 'on'
      }
      if (thing && service === 'light/turn_off') {
        thing.on = false
        thing.state = 'off'
      }
    },
    callService: async () => undefined,
    cameraSnapshot: async (entityId: string) => {
      home.snapshotCalls.push(entityId)
      if (home.snapshotError) throw home.snapshotError
      return home.snapshotBytes
    }
  }
  dirs.push(home.inbox)
  const service = {
    hub,
    engine: { status: () => ({ state: home.engineState }) },
    inbox: home.inbox,
    saveStill: () => {
      throw new Error('saveStill must not be called for a remote still')
    }
  } as never
  const vault = fakeVault()
  // The real vault announces its changes; the notes tree cache listens for them.
  for (const change of ['put', 'remove'] as const) {
    const original = vault[change] as (...args: never[]) => void
    vault[change] = ((...args: never[]) => {
      original(...args)
      channelListener?.({ type: 'vault.changed' })
    }) as never
  }
  const fakeThreads: FakeThreads = {
    running: new Set(),
    list: () => threads.map(({ id, title, agentId, model, workspace, updatedAt, channel }) => ({ id, title, agentId, model, workspace, updatedAt, channel })),
    get: (id) => threads.find((thread) => thread.id === id),
    isRunning: (id) => fakeThreads.running.has(id) || pending.some((ask) => ask.threadId === id && !ask.settled),
    opened: [],
    markOpened: (id, at) => {
      fakeThreads.opened.push({ id, at })
    }
  }
  const files = fakeFiles()
  const timers = fakeTimers(() => now)
  const deps: RemoteDeps = {
    vault: () => vault,
    threads: fakeThreads,
    files,
    timers,
    settings: () => {
      const base = defaultSettings()
      return {
        ...base,
        agents: [...base.agents, { ...base.agents[0], id: COMPANY_AGENT, companyId: 'acme' }],
        approvalMode,
        alwaysAllowTools,
        remote,
        home: { ...base.home, enabled: home.enabled }
      }
    },
    now: () => now,
    random: overrides?.random ?? ((length: number) => new Uint8Array(length).fill(1)),
    store,
    state,
    transport: () => {
      calls++
      if (overrides?.failTransport !== undefined) throw overrides.failTransport
      return overrides?.transport ?? transport
    },
    onStatus: (status: RemoteStatus) => statuses.push(status),
    onPairing: (view: PairingView | null) => pairings.push(view),
    onDevices: (devices: DeviceView[]) => deviceLists.push(devices),
    host: {
      confirm: async (kind: string, params: Record<string, string>) => {
        confirmCalls.push({ kind, params })
        return typeof answer === 'function' ? answer(kind, params) : answer
      }
    },
    conversation: (fresh?: boolean) => {
      if (fresh) {
        threads.push(makeThread(`remote-${threads.length}`))
        current = threads.length - 1
      }
      return threads[current] ?? threads[0] ?? makeThread('remote')
    },
    ask: (threadId: string, text: string, attachments?: string[]) => {
      askCalls.push({ threadId, text, ...(attachments ? { attachments } : {}) })
      if (chat.throwSync) throw new Error('ask failed')
      threads.find((thread) => thread.id === threadId)?.messages.push({ role: 'user', content: [{ type: 'text', text }], ts: now })
      const entry: FakeChat['pending'][number] = {
        threadId,
        promise: Promise.resolve(),
        settled: false,
        resolve: () => {},
        reject: () => {}
      }
      entry.promise = new Promise<void>((resolve, reject) => {
        entry.resolve = resolve
        entry.reject = reject
      })
      pending.push(entry)
      return entry.promise
    },
    cancel: (threadId: string) => {
      cancelCalls.push(threadId)
      for (const approval of chat.approvals) approval.denied = true
      pending.forEach((ask, index) => {
        if (!ask.settled) chat.rejectAsk(index, new Error('aborted'))
      })
    },
    pendingApprovals: () => approvals.broker.pending(),
    respondApproval: (approvalId: string, decision: 'allow' | 'deny') => {
      approvals.answered.push({ approvalId, decision })
      approvals.broker.respond(approvalId, decision, 'phone')
    },
    onEvent: (listener: (event: LiveEvent) => void) => {
      channelListener = listener
      return () => {
        if (channelListener === listener) channelListener = null
      }
    },
    direct: {
      home: service,
      toolContext: () => ({
        workspace: '',
        signal: new AbortController().signal,
        settings: deps.settings(),
        language: deps.settings().language,
        host: { request: async () => ({ ok: false, message: 'no host in test' }) },
        home: service
      }),
      authorize: (request) => authorize({ ...request, broker, rememberAlwaysAllow: (name: string) => home.remembered.push(name) })
    },
    landing: overrides?.landing,
    record: overrides?.record ?? ((entry: AuditEvent) => {
      records.push(entry)
    }),
    onTestResult: (deviceId: string, ok: boolean) => {
      testResults.push({ deviceId, ok })
    },
    post: async (url: string, headers: Record<string, string>, body: Uint8Array) => {
      if (postBroken) {
        refused.push(url)
        throw new Error('push service is down')
      }
      posts.push({ url, headers, body })
      return { ok: true }
    }
  }
  let session: Promise<{ deviceId: string; headers: Record<string, string> }> | null = null
  const harness: Harness = {
    channel: new RemoteChannel(deps),
    transport,
    store,
    state,
    chat,
    approvals,
    home,
    vault,
    threads: fakeThreads,
    files,
    timers,
    emit: (event) => channelListener?.(event),
    phone: () => {
      session ??= (async () => {
        const { deviceId, privateKey } = await pairDevice(harness)
        const token = await openSession(harness, deviceId, privateKey)
        return { deviceId, headers: { ...HOST, authorization: `Bearer ${token}` } }
      })()
      return session
    },
    call: async (path, body) => {
      const { headers } = await harness.phone()
      return transport.request({ method: 'POST', path, headers, body })
    },
    records,
    testResults,
    factoryCalls: () => calls,
    statuses,
    pairings,
    deviceLists,
    confirmCalls,
    setConfirm: (next) => {
      answer = next
    },
    setRemote: (patch) => {
      remote = { ...remote, ...patch }
    },
    setNow: (next) => {
      now = next
    },
    setApprovalMode: (mode) => {
      approvalMode = mode
    },
    setAlwaysAllowTools: (tools) => {
      alwaysAllowTools = tools
    },
    dir,
    posts,
    refused,
    failPost: () => {
      postBroken = true
    }
  }
  return harness
}

export const HOST = { host: 'test.invalid' }

export async function signBytes(key: CryptoKey, bytes: Uint8Array): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes as unknown as ArrayBuffer)
  return new Uint8Array(signature)
}

export async function pairDevice(t: Harness, name = 'phone'): Promise<{ deviceId: string; privateKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const added = await t.store.add({ name, publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey) })
  if (!added) throw new Error('store full in test')
  return { deviceId: added.id, privateKey: pair.privateKey }
}

export async function openSession(t: Harness, deviceId: string, privateKey: CryptoKey): Promise<string> {
  const challenge = await t.transport.request({ method: 'POST', path: '/api/session/challenge', headers: HOST, body: { deviceId } })
  if (challenge.status !== 200) throw new Error(`challenge failed: ${challenge.status}`)
  const nonce = (challenge.body as { nonce: string }).nonce
  const signature = await signBytes(privateKey, b64u.decode(nonce))
  const session = await t.transport.request({
    method: 'POST',
    path: '/api/session',
    headers: HOST,
    body: { deviceId, signature: b64u.encode(signature) }
  })
  if (session.status !== 200) throw new Error(`session failed: ${session.status}`)
  return (session.body as { token: string }).token
}
