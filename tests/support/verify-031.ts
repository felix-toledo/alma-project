import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { PhoneFiles } from '../../src/coordinator/attachments/phone'
import { AttachmentStore, type AttachmentIo } from '../../src/coordinator/attachments/store'
import { threadReaders } from '../../src/shared/attach/readers'
import { defaultSettings } from '../../src/shared/defaults'
import type { AuditEvent } from '../../src/shared/audit'
import type { RemoteResponse } from '../../src/shared/remote/api'
import { defaultRemote } from '../../src/shared/remote/settings'
import type { ProviderId, RemoteSettings, Settings, Thread } from '../../src/shared/types'
import { COMPANY_AGENT, HOST, makeThread, openSession, pairDevice, testChannel, type Harness } from './remote-harness'

// Shared by the spec 031 verification tests: a remote channel whose attachment store is the real one (spec 030) in a temp
// folder, so "nothing is stored" is looked for on disk and not in a fake's call list.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

export const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)
export const b64 = (data: Uint8Array): string => Buffer.from(data).toString('base64')

/** The body of a put for these bytes (the real byte count is the size). */
export const putBody = (name: string, data: Uint8Array): { name: string; size: number; base64: string } => ({ name, size: data.length, base64: b64(data) })

/** A text file of exactly this many bytes. */
export const textFile = (size: number): Uint8Array => new Uint8Array(size).fill(0x61)

export const SHARED = 'remote'
export const OPEN = { ...defaultRemote().scopes, chat: true, history: true }

export interface Rig {
  h: Harness
  inbox: string
  store: AttachmentStore
  phone: PhoneFiles
  settings(): Settings
  /** Ids of the providers left unacknowledged: set before a put to make it `notice-needed`. */
  acknowledge(providers: ProviderId[] | 'all'): void
  setSettings(patch: Partial<Settings>): void
  /** The folders of the attachment store on disk (one per stored file), and its record files. */
  onDisk(): { folders: string[]; records: string[] }
  addThread(id: string, agentId?: string, patch?: Partial<Thread>): Thread
  /** A second paired phone with its own session. */
  device(name: string): Promise<{ deviceId: string; headers: Record<string, string>; call(path: string, body?: unknown): Promise<RemoteResponse> }>
  /** Ids the channel asked the store to delete, in order. */
  removed: string[]
}

export async function rig(options: { remote?: Partial<RemoteSettings>; io?: Partial<AttachmentIo>; log?: (event: string, data: Record<string, string | number>) => void; record?: (entry: AuditEvent) => void } = {}): Promise<Rig> {
  const remote = { enabled: true, scopes: OPEN, continueHistory: true, sendFiles: true, ...options.remote }
  // the harness's default random is constant, so two phones would share one session token
  let counter = 0
  const h = await testChannel({ remote, record: options.record, random: (length) => new Uint8Array(length).fill((++counter % 250) + 1) })
  const inbox = mkdtempSync(join(tmpdir(), 'alma-verify031-'))
  dirs.push(inbox)
  const base = defaultSettings()
  let settings: Settings = {
    ...base,
    agents: [...base.agents, { ...base.agents[0], id: COMPANY_AGENT, companyId: 'acme' }],
    attachments: { noticeAcknowledged: [] }
  }
  // the providers every conversation of the rig would read, acknowledged by default
  settings = { ...settings, attachments: { noticeAcknowledged: threadReaders(settings, { agentId: 'general' }, true, {}) } }
  const store = new AttachmentStore(inbox, { io: options.io, log: options.log })
  const phone = new PhoneFiles({ store, threads: { get: (id) => h.threads.get(id) }, settings: () => settings, env: () => ({}) })
  const removed: string[] = []
  h.files.put = (input) => {
    h.files.puts.push(input)
    return phone.put(input)
  }
  h.files.remove = (id) => {
    h.files.removes.push(id)
    removed.push(id)
    phone.remove(id)
  }
  h.files.readersOwed = (threadId, ids) => phone.readersOwed(threadId, ids)
  await h.channel.sync()
  const root = join(inbox, 'attachments')
  return {
    h,
    inbox,
    store,
    phone,
    removed,
    settings: () => settings,
    setSettings: (patch) => {
      settings = { ...settings, ...patch }
    },
    acknowledge: (providers) => {
      const all = threadReaders(settings, { agentId: 'general' }, true, {})
      settings = { ...settings, attachments: { noticeAcknowledged: providers === 'all' ? all : providers } }
    },
    onDisk: () => {
      if (!existsSync(root)) return { folders: [], records: [] }
      const names = readdirSync(root)
      return { folders: names.filter((n) => !n.endsWith('.json')), records: names.filter((n) => n.endsWith('.json')) }
    },
    addThread: (id, agentId = 'general', patch = {}) => {
      const thread = { ...makeThread(id, agentId), ...patch }
      h.chat.threads.push(thread)
      return thread
    },
    device: async (name) => {
      const { deviceId, privateKey } = await pairDevice(h, name)
      const token = await openSession(h, deviceId, privateKey)
      const headers = { ...HOST, authorization: `Bearer ${token}` }
      return { deviceId, headers, call: (path, body) => h.transport.request({ method: 'POST', path, headers, body }) }
    }
  }
}

/** Every stored file's bytes under the store root (for "the metadata is gone from what was kept"). */
export function storedBytes(inbox: string): Buffer[] {
  const root = join(inbox, 'attachments')
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((name) => !name.endsWith('.json'))
    .flatMap((folder) => readdirSync(join(root, folder)).map((file) => readFileSync(join(root, folder, file))))
}

export const errorOf = (response: RemoteResponse): string | undefined => (response.body as { error?: string } | undefined)?.error
export const attachmentOf = (response: RemoteResponse): { id: string; name: string; kind: string; size: number } =>
  (response.body as { attachment: { id: string; name: string; kind: string; size: number } }).attachment

export const idOf = (response: RemoteResponse): string => attachmentOf(response).id
