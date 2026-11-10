import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../src/shared/defaults'
import { ATTACHMENTS_HEADING, ATTACHMENTS_SYSTEM_SENTENCE } from '../src/shared/attach/compose'
import type { Block, ChatMessage, LiveEvent, Settings, Thread } from '../src/shared/types'
import { buildPng } from './support/attach-fixtures'
import type { Provider, TurnRequest, TurnResult } from '../src/coordinator/providers/types'

// A scripted provider: each test decides what the "model" answers for every turn.
let script: (request: TurnRequest) => Promise<TurnResult> | TurnResult
const fakeProvider: Provider = {
  id: 'anthropic',
  streamTurn: async (request) => script(request),
  review: async () => ({ verdict: 'allow', reason: 'ok' }),
  listModels: async () => []
}
vi.mock('../src/coordinator/providers', () => ({ getProvider: () => fakeProvider }))

const { appTools, runAgent } = await import('../src/coordinator/agent')
const { compactHistory } = await import('../src/coordinator/context')
const { expandAttachments } = await import('../src/coordinator/attachments/expand')
const { AttachmentService, composeUserMessage } = await import('../src/coordinator/attachments/service')
const { ApprovalBroker } = await import('../src/coordinator/approval')
const { McpManager } = await import('../src/coordinator/mcp')
const { AttachmentStore } = await import('../src/coordinator/attachments/store')
const { readAttachmentTool } = await import('../src/coordinator/attachments/read-tool')

const text = (t: string): Block => ({ type: 'text', text: t })
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: 'tool_use', id, name, input })
const turn = (content: Block[]): TurnResult => ({ content, stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', model: 'fake' })
const lastToolResults = (request: TurnRequest): Extract<Block, { type: 'tool_result' }>[] =>
  (request.messages.at(-1)?.content ?? []).filter((b) => b.type === 'tool_result') as Extract<Block, { type: 'tool_result' }>[]

let inbox: string
let store: InstanceType<typeof AttachmentStore>
let settings: Settings
let thread: Thread
let events: LiveEvent[]
let broker: InstanceType<typeof ApprovalBroker>

function context() {
  return {
    getSettings: () => settings,
    language: 'en' as const,
    thread,
    scope: { threadId: thread.id },
    signal: new AbortController().signal,
    depth: 0,
    approvals: broker,
    mcp: new McpManager(() => {}),
    host: { request: async () => ({ ok: true, message: '' }) },
    emit: (event: LiveEvent) => events.push(event),
    persist: () => {},
    rememberAlwaysAllow: () => {},
    knowledge: null,
    saveRoutines: () => {},
    sendTelegram: async () => false,
    whatsapp: null,
    attachments: store
  }
}

const stored = (name: string, content: string | Uint8Array, threadId = 't1') => {
  const data = Buffer.from(content)
  const result = store.store({ threadId, name, size: data.length, base64: data.toString('base64') })
  if (!result.ok) throw new Error(`refused: ${result.reason}`)
  return result.attachment
}

function start(userText: string, agentId = 'general'): Promise<string> {
  thread.messages.push({ role: 'user', content: [text(userText)], ts: Date.now() })
  const profile = settings.agents.find((a) => a.id === agentId)!
  return runAgent(profile, thread.messages, context())
}

beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), 'alma-attach-agent-'))
  store = new AttachmentStore(inbox)
  settings = defaultSettings()
  thread = { id: 't1', title: 'x', agentId: 'general', workspace: '', createdAt: 0, updatedAt: 0, messages: [], subagents: {}, toolStates: {} }
  events = []
  broker = new ApprovalBroker((event) => events.push(event))
})
afterEach(() => rmSync(inbox, { recursive: true, force: true }))

describe('read_attachment registration (spec 030 T27)', () => {
  it('AC-4.6 (030) risk read, standalone, no approval, read-only mode, no workspace', async () => {
    expect(readAttachmentTool).toMatchObject({ name: 'read_attachment', risk: 'read', standalone: true })
    const { id } = stored('notes.txt', 'remember the milk')
    // 'blocked' is the read-only mode; the thread has no working folder in either run
    for (const mode of ['blocked', 'needs-approval'] as const) {
      settings.approvalMode = mode
      events = []
      thread.messages = []
      let seen: Extract<Block, { type: 'tool_result' }> | undefined
      script = (request) => {
        if (lastToolResults(request).length === 0) return turn([toolUse('r1', 'read_attachment', { id })])
        seen = lastToolResults(request)[0]
        return turn([text('done')])
      }
      await start('read it')
      expect(events.some((e) => e.type === 'approval.request'), mode).toBe(false)
      expect(thread.toolStates.r1.status, mode).toBe('done')
      expect(seen?.is_error, mode).toBeUndefined()
      expect(seen?.content, mode).toContain('remember the milk')
    }
  })

  it('AC-4.7 (030) any existing id reads, a sub-agent included, an id from another conversation too', async () => {
    const mine = stored('mine.txt', 'my own note')
    const theirs = stored('theirs.txt', 'a note from another conversation', 'another-thread')

    let ownResults: string[] = []
    script = (request) => {
      const results = lastToolResults(request)
      if (results.length === 0) return turn([toolUse('r1', 'read_attachment', { id: mine.id }), toolUse('r2', 'read_attachment', { id: theirs.id })])
      ownResults = results.map((r) => r.content)
      return turn([text('done')])
    }
    await start('read both')
    expect(ownResults[0]).toContain('my own note')
    expect(ownResults[1]).toContain('a note from another conversation')

    // a sub-agent gets the id in its task text and reads it: the id is the capability
    thread.messages = []
    let subagentTools: string[] = []
    let subagentResult = ''
    script = (request) => {
      if (request.system.includes('You are a subagent')) {
        subagentTools = request.tools.map((t) => t.name)
        const results = lastToolResults(request)
        if (results.length === 0) return turn([toolUse('s1', 'read_attachment', { id: theirs.id })])
        subagentResult = results[0].content
        return turn([text('read it')])
      }
      return lastToolResults(request).length === 0
        ? turn([toolUse('d1', 'delegate_task', { agent: 'investigador', title: 'read', task: `read attachment ${theirs.id}` })])
        : turn([text('fin')])
    }
    await start('delegate it')
    expect(subagentTools).toContain('read_attachment')
    expect(subagentResult).toContain('a note from another conversation')
  })

  it('AC-4.6 (030) read_attachment is in appTools for a normal agent and for a sub-agent', () => {
    for (const depth of [0, 1]) {
      const names = appTools({ ...context(), depth } as never).map((t) => t.name)
      expect(names, `depth ${depth}`).toContain('read_attachment')
    }
  })
})

describe('run-level result cap (spec 030 AC-4.4)', () => {
  const resultOf = async (call: { name: string; input: unknown }, mcp?: unknown): Promise<string> => {
    let seen = ''
    script = (request) => {
      if (lastToolResults(request).length === 0) return turn([toolUse('r1', call.name, call.input)])
      seen = lastToolResults(request)[0].content
      return turn([text('done')])
    }
    settings.approvalMode = 'always-allow'
    const profile = { ...settings.agents.find((a) => a.id === 'general')!, allowMcp: true }
    await runAgent(profile, [{ role: 'user', content: [text('go')], ts: 1 }], { ...context(), ...(mcp ? { mcp } : {}) } as never)
    return seen
  }

  it('AC-4.4 (030) a 50 000-character attachment reaches the model whole through a run', async () => {
    const body = `${'a'.repeat(99)}\n`.repeat(500)
    const note = stored('long.txt', body)
    const result = await resultOf({ name: 'read_attachment', input: { id: note.id } })
    expect(result).not.toContain('characters omitted')
    // every line is there, numbered: nothing was cut in the middle
    expect(result.split('\n').filter((line) => line.includes('a'.repeat(99)))).toHaveLength(500)
  })

  it('AC-4.4 (030) another tool result over 24 000 characters is still cut by the run', async () => {
    const mcp = { toolSpecs: () => [{ name: 'big', description: 'x', inputSchema: {} }], call: async () => ({ text: 'x'.repeat(50_000), isError: false }) }
    const result = await resultOf({ name: 'big', input: {} }, mcp)
    expect(result).toContain('26000 characters omitted')
    expect(result.length).toBeLessThan(25_000)
  })
})

describe('history expansion (spec 030 T29)', () => {
  const PNG = Buffer.from(buildPng({ metadata: false }))
  const pushMessage = (message: ChatMessage) => void thread.messages.push(message)
  const sent = (): ChatMessage[] => requests.at(-1)?.messages ?? []
  let requests: TurnRequest[]
  beforeEach(() => {
    requests = []
    script = (request) => {
      requests.push(request)
      return turn([text('ok')])
    }
  })
  const run = () => runAgent(settings.agents.find((a) => a.id === 'general')!, thread.messages, context())
  const attached = (a: { id: string; name: string; kind: 'text' | 'image'; size: number }, typed = 'look at this'): ChatMessage => ({ role: 'user', content: [text(typed)], attachments: [a], ts: 1 })

  it('AC-4.1 (030) the provider receives the heading, reference lines and the system sentence', async () => {
    const note = stored('notes.txt', 'hello')
    pushMessage(attached({ id: note.id, name: 'notes.txt', kind: 'text', size: 5 }))
    await run()
    const first = sent()[0].content[0] as { type: 'text'; text: string }
    expect(first.text).toBe(`look at this${ATTACHMENTS_HEADING}[1] ${note.id} (notes.txt, 5 B)`)
    expect(requests[0].system).toContain(ATTACHMENTS_SYSTEM_SENTENCE)
  })

  it('AC-4.1 (030) the system sentence is always there, also when no message has attachments', async () => {
    pushMessage({ role: 'user', content: [text('plain')], ts: 1 })
    await run()
    expect(requests[0].system).toContain(ATTACHMENTS_SYSTEM_SENTENCE)
    expect(sent()[0].content).toEqual([text('plain')])
  })

  it('AC-4.1 (030) a picture line carries its path and a removed picture has none', async () => {
    const shot = stored('shot.png', PNG)
    const found = store.lookup(shot.id)
    if (found.state !== 'present') throw new Error('expected the picture')
    pushMessage(attached({ id: shot.id, name: 'shot.png', kind: 'image', size: shot.size }))
    await run()
    expect((sent()[0].content[0] as { text: string }).text).toContain(`[1] ${shot.id} (shot.png, ${shot.size} B) path: ${found.path}`)

    rmSync(found.path)
    requests = []
    await run()
    const line = (sent()[0].content[0] as { text: string }).text
    expect(line).toContain(`[1] ${shot.id} (shot.png`)
    expect(line).not.toContain('path:')
  })

  it('AC-4.2 (030) pictures are never image blocks', async () => {
    const shot = stored('shot.png', PNG)
    pushMessage(attached({ id: shot.id, name: 'shot.png', kind: 'image', size: shot.size }))
    await run()
    for (const message of sent()) expect(message.content.map((b) => b.type)).not.toContain('image')
  })

  it('AC-4.3 (030) a non-picture line carries no content', async () => {
    const note = stored('notes.txt', 'TOP-SECRET-MARKER inside the file')
    pushMessage(attached({ id: note.id, name: 'notes.txt', kind: 'text', size: note.size }))
    await run()
    const sentText = JSON.stringify(sent())
    expect(sentText).toContain(note.id)
    expect(sentText).not.toContain('TOP-SECRET-MARKER')
  })

  it('AC-4.1 (030) an attachment-only message still reaches the provider', async () => {
    const note = stored('notes.txt', 'hello')
    pushMessage(attached({ id: note.id, name: 'notes.txt', kind: 'text', size: 5 }, ''))
    await run()
    expect(requests).toHaveLength(1)
    const first = sent()[0].content[0] as { text: string }
    expect(first.text.trim().length).toBeGreaterThan(0)
    expect(first.text).toContain(`[1] ${note.id} (notes.txt, 5 B)`)
  })

  it('AC-4.1 (030) the stored thread is not modified', async () => {
    const note = stored('notes.txt', 'hello')
    pushMessage(attached({ id: note.id, name: 'notes.txt', kind: 'text', size: 5 }))
    const before = JSON.stringify(thread.messages[0])
    await run()
    expect(JSON.stringify(thread.messages[0])).toBe(before)
    expect(thread.messages[0].content).toEqual([text('look at this')])
  })

  it('AC-4.1 (030) compactHistory still treats an attachment-only message as a real user message', () => {
    const note = stored('notes.txt', 'hello')
    const long = 'x'.repeat(5000)
    const messages: ChatMessage[] = [
      { role: 'user', content: [text('first')], ts: 1 },
      { role: 'assistant', content: [toolUse('u1', 'list_dir', {})], ts: 2 },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: long }], ts: 3 },
      { role: 'assistant', content: [text('done')], ts: 4 },
      attached({ id: note.id, name: 'notes.txt', kind: 'text', size: 5 }, '')
    ]
    const out = compactHistory(expandAttachments(messages, store))
    // the earlier turn's long result is cut to its ends only if the last message counts as the start of the current turn
    const result = out[2].content[0] as { content: string }
    expect(result.content.length).toBeLessThan(long.length)
    expect(messages[2].content[0]).toMatchObject({ content: long })
  })
})

describe('AttachmentService (spec 030 T31)', () => {
  const PNG = Buffer.from(buildPng({ metadata: false }))
  let opened: [string, number][]
  let hostCalls: unknown[]
  let service: InstanceType<typeof AttachmentService>
  const base64 = (data: string | Uint8Array) => Buffer.from(data).toString('base64')
  const storeRequest = (name: string, data: string | Uint8Array, threadId = 't1') => ({ method: 'attachments.store' as const, threadId, name, size: Buffer.from(data).length, base64: base64(data) })
  beforeEach(() => {
    opened = []
    hostCalls = []
    service = new AttachmentService({
      store,
      threads: { get: (id) => (id === 't1' ? thread : (() => { throw new Error('no thread') })()), markOpened: (id, at) => void opened.push([id, at]) },
      settings: () => settings,
      host: { request: async (request) => (hostCalls.push(request), { ok: true, message: '' }) },
      now: () => 99
    })
  })

  it('AC-1.1 (030) attachments.store returns the attachment or a reason', async () => {
    const ok = await service.handle(storeRequest('notes.txt', 'hello'))
    expect(ok).toMatchObject({ ok: true, attachment: { name: 'notes.txt', kind: 'text', size: 5 } })
    expect(await service.handle(storeRequest('tool.exe', 'MZ....'))).toEqual({ ok: false, reason: 'type' })
    expect(await service.handle(storeRequest('empty.txt', ''))).toEqual({ ok: false, reason: 'empty' })
    // storing sends nothing and runs nothing: only the store was touched
    expect(hostCalls).toEqual([])
  })

  it('AC-1.11 (030) a company conversation takes no attachments, whatever the page says', async () => {
    settings.agents.push({ ...settings.agents[0], id: 'staff', companyId: 'acme' })
    thread.agentId = 'staff'
    expect(await service.handle(storeRequest('notes.txt', 'hello'))).toEqual({ ok: false, reason: 'company' })
    await expect(service.handle(storeRequest('notes.txt', 'hello', 'nope'))).rejects.toThrow('no thread')
  })

  it('AC-3.1 (030) readers include the vision provider only when a picture is attached', async () => {
    settings.images.vision = { provider: 'xai', model: 'grok-vision' }
    const agent = settings.agents.find((a) => a.id === 'general')!
    expect(await service.handle({ method: 'attachments.readers', threadId: 't1', images: false })).toEqual([agent.provider])
    expect(await service.handle({ method: 'attachments.readers', threadId: 't1', images: true })).toEqual([...new Set([agent.provider, 'xai'])])
    // the model chosen in the header answers instead of the agent's own
    thread.model = { provider: 'deepseek', model: 'x' }
    expect(await service.handle({ method: 'attachments.readers', threadId: 't1', images: false })).toEqual(['deepseek'])
    expect(await service.handle({ method: 'attachments.readers', threadId: 't1', images: true })).toEqual(['deepseek', 'xai'])
    // the same provider for both reads once
    settings.images.vision.provider = 'deepseek'
    expect(await service.handle({ method: 'attachments.readers', threadId: 't1', images: true })).toEqual(['deepseek'])
  })

  it('AC-7.4 (030) preview returns bytes only for raster pictures and a removed state otherwise', async () => {
    const shot = stored('shot.png', PNG)
    const note = stored('notes.txt', 'hello')
    const preview = (id: string) => service.handle({ method: 'attachments.preview', id })
    const picture = (await preview(shot.id)) as { state: string; mediaType?: string; base64?: string }
    expect(picture).toMatchObject({ state: 'present', mediaType: 'image/png' })
    expect(Buffer.from(picture.base64 as string, 'base64').length).toBe(shot.size)
    // a file that is not a picture is present but carries no bytes
    expect(await preview(note.id)).toEqual({ state: 'present' })
    // deleted from disk: removed; never stored or not an id: unknown
    const found = store.lookup(shot.id)
    if (found.state !== 'present') throw new Error('expected the picture')
    rmSync(found.path)
    expect(await preview(shot.id)).toEqual({ state: 'removed' })
    expect(await preview('0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b')).toEqual({ state: 'unknown' })
    expect(await preview('..\\..\\x')).toEqual({ state: 'unknown' })
  })

  it('AC-7.5 (030) attachments.open refuses types off the list and asks the host with the stored path', async () => {
    const report = stored('report.pdf', '%PDF-1.4 x')
    const script = stored('tool.py', 'print(1)')
    const found = store.lookup(report.id)
    if (found.state !== 'present') throw new Error('expected the file')
    expect(await service.handle({ method: 'attachments.open', id: report.id })).toEqual({ ok: true, message: '' })
    expect(hostCalls).toEqual([{ action: 'attachment.open', path: found.path }])
    for (const id of [script.id, '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b', 'C:\\Windows\\notepad.exe']) {
      await expect(service.handle({ method: 'attachments.open', id })).rejects.toThrow()
    }
    rmSync(found.path)
    await expect(service.handle({ method: 'attachments.open', id: report.id })).rejects.toThrow(/ya no está disponible/)
    expect(hostCalls).toHaveLength(1)
  })

  it('AC-1.2 (030) attachments.remove deletes the file and its record', async () => {
    const note = stored('notes.txt', 'hello')
    expect(await service.handle({ method: 'attachments.remove', id: note.id })).toBeNull()
    expect(store.lookup(note.id).state).toBe('unknown')
  })

  it('AC-6.7 (030) threads.open sets lastOpenedAt', async () => {
    expect(await service.handle({ method: 'threads.open', threadId: 't1' })).toBeNull()
    expect(opened).toEqual([['t1', 99]])
  })
})

describe('chat.send with attachments (spec 030 T30)', () => {
  const compose = (ids: unknown, overrides: Record<string, unknown> = {}) =>
    composeUserMessage({ text: 'see these', ids, threadId: 't1', reader: store, language: 'en', untitled: 'Untitled', now: 42, ...overrides } as never)

  it('AC-1.3 (030) a failed send keeps the stored attachments and a successful one binds them', () => {
    const mine = stored('mine.txt', 'one')
    const other = stored('other.txt', 'two', 'another-thread')
    const gone = stored('gone.txt', 'three')
    const goneFile = store.lookup(gone.id)
    if (goneFile.state !== 'present') throw new Error('expected the file')
    rmSync(goneFile.path)

    // bound: the message carries the structured list the transcript shows, in the order given, once each
    const sentOk = compose([mine.id, mine.id])
    expect(sentOk.message).toEqual({ role: 'user', content: [text('see these')], attachments: [{ id: mine.id, name: 'mine.txt', kind: 'text', size: 3 }], ts: 42 })

    // refused: another conversation's id, a removed file, an id never stored, a path, junk; none of them touches the store
    const refusals: [unknown, RegExp][] = [
      [[mine.id, other.id], /not found in this conversation/],
      [[gone.id], /no longer available/],
      [['0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b'], /not found in this conversation/],
      [['..\\..\\secret.txt'], /not found in this conversation/],
      [[42], /not found in this conversation/],
      ['not-a-list', /not found in this conversation/]
    ]
    for (const [ids, message] of refusals) expect(() => compose(ids)).toThrow(message)
    for (const id of [mine.id, other.id]) expect(store.lookup(id).state).toBe('present')
  })

  it('AC-1.3 (030) a refusal reads in the app language', () => {
    expect(() => compose(['0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b'], { language: 'es' })).toThrow(/No se encontró un adjunto/)
  })

  it('AC-2.3 (030) the coordinator re-checks the per-message count and total before binding anything', () => {
    const files = Array.from({ length: 6 }, (_, i) => stored(`f${i}.txt`, `file ${i}`))
    expect(compose(files.slice(0, 5).map((f) => f.id)).message.attachments).toHaveLength(5)
    expect(() => compose(files.map((f) => f.id))).toThrow(/at most 5 files/)
    expect(() => compose(files.map((f) => f.id), { language: 'es' })).toThrow(/hasta 5 archivos/)
    // a duplicated id is one file, not two
    expect(compose([files[0].id, files[0].id, files[1].id]).message.attachments).toHaveLength(2)

    // 10 MiB + 1 across files the store would each accept (records are trusted here only for their sizes)
    const sized = (id: string, size: number) => ({ state: 'present' as const, path: '', record: { id, threadId: 't1', originalName: `${id}.txt`, storedName: `${id}.txt`, size, kind: 'text' as const, createdAt: 0 } })
    const reader = { lookup: (id: string) => sized(id, 2_097_152) }
    const ids = ['a', 'b', 'c', 'd', 'e'].map((x) => `${x}${x}${x}${x}`)
    expect(() => compose(ids, { reader: { lookup: (id: string) => sized(id, id === 'bbbb' ? 2_097_153 : 2_097_152) } })).toThrow(/10 MiB/)
    expect(() => compose(ids.slice(0, 4), { reader })).not.toThrow()
  })

  it('AC-2.3 (030) too many ids are refused before any of them is looked up, and a duplicate does not count twice', () => {
    const looked: unknown[] = []
    const reader = { lookup: (id: string) => (looked.push(id), { state: 'unknown' as const }) }
    const ids = Array.from({ length: 6 }, (_, i) => `id-${i}`)
    expect(() => compose(ids, { reader })).toThrow(/at most 5 files/)
    expect(looked).toEqual([])
    expect(() => compose([...ids.slice(0, 5), ids[0]], { reader })).toThrow(/not found in this conversation/)
    expect(looked).toEqual(['id-0'])
  })

  it('AC-2.7 (030) an attachment-only message can be sent', () => {
    const report = stored('quarterly report.pdf', '%PDF-1.4 x')
    const sentOnly = compose([report.id], { text: '' })
    expect(sentOnly.message.content).toEqual([text('')])
    expect(sentOnly.message.attachments).toHaveLength(1)
    expect(sentOnly.title).toBe('quarterly report.pdf')
    // typed text keeps the usual title; a message with none of either keeps the untitled one
    expect(compose([report.id], { text: 'Please summarize\nthanks' }).title).toBe('Please summarize')
    expect(compose([], { text: '' }).title).toBe('Untitled')
    expect(compose([], { text: 'plain' }).message).toEqual({ role: 'user', content: [text('plain')], ts: 42 })
  })

  it('AC-1.1 (030) storing an attachment sends nothing to any provider', async () => {
    const calls: TurnRequest[] = []
    script = (request) => {
      calls.push(request)
      return turn([text('ok')])
    }
    const note = stored('notes.txt', 'hello')
    compose([note.id])
    expect(calls).toHaveLength(0)
    thread.messages.push(compose([note.id]).message)
    await runAgent(settings.agents.find((a) => a.id === 'general')!, thread.messages, context())
    expect(calls).toHaveLength(1)
    expect(JSON.stringify(calls[0].messages)).toContain(note.id)
  })
})
