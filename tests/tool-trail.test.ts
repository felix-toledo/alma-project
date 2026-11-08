import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initAudit } from '../src/shared/audit'
import { defaultSettings } from '../src/shared/defaults'
import type { Block, LiveEvent, Settings, Thread } from '../src/shared/types'
import type { Provider, TurnRequest, TurnResult } from '../src/coordinator/providers/types'

// Characterization of the tool audit trail (spec 026 T22): first against executeTool's
// output through runAgent (this file, before the refactor), then against toolTrail itself.
let script: (request: TurnRequest) => Promise<TurnResult> | TurnResult
const fakeProvider: Provider = {
  id: 'anthropic',
  streamTurn: async (request) => script(request),
  review: async () => ({ verdict: 'allow', reason: 'ok' }),
  listModels: async () => []
}
vi.mock('../src/coordinator/providers', () => ({ getProvider: () => fakeProvider }))

const { runAgent } = await import('../src/coordinator/agent')
const { ApprovalBroker } = await import('../src/coordinator/approval')
const { McpManager } = await import('../src/coordinator/mcp')
const { toolTrail } = await import('../src/coordinator/tool-trail')

const text = (t: string): Block => ({ type: 'text', text: t })
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: 'tool_use', id, name, input })
const turn = (content: Block[], stopReason: TurnResult['stopReason'] = 'end_turn'): TurnResult => ({
  content,
  stopReason: content.some((b) => b.type === 'tool_use') && stopReason === 'end_turn' ? 'tool_use' : stopReason,
  model: 'fake'
})
const lastToolResults = (request: TurnRequest): Extract<Block, { type: 'tool_result' }>[] =>
  (request.messages.at(-1)?.content ?? []).filter((b) => b.type === 'tool_result') as Extract<Block, { type: 'tool_result' }>[]

let workspace: string
let dataDir: string
let settings: Settings
let thread: Thread
let events: LiveEvent[]
let broker: InstanceType<typeof ApprovalBroker>

function context() {
  return {
    getSettings: () => settings,
    language: 'es' as const,
    thread,
    scope: { threadId: thread.id },
    signal: new AbortController().signal,
    depth: 0,
    approvals: broker,
    mcp: new McpManager(() => {}),
    host: { request: async () => ({ ok: true, message: 'ok' }) },
    emit: (event: LiveEvent) => events.push(event),
    persist: () => {},
    rememberAlwaysAllow: () => {},
    knowledge: null,
    saveRoutines: () => {},
    sendTelegram: async () => false,
    whatsapp: null
  }
}

function trailLines(): Record<string, unknown>[] {
  const month = new Date().toISOString().slice(0, 7)
  const file = join(dataDir, 'audit', `coordinator-${month}.jsonl`)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'alma-trail-'))
  dataDir = mkdtempSync(join(tmpdir(), 'alma-trail-audit-'))
  initAudit(dataDir, 'coordinator')
  settings = defaultSettings()
  thread = { id: 't1', title: 'x', agentId: 'general', workspace, createdAt: 0, updatedAt: 0, messages: [], subagents: {}, toolStates: {} }
  events = []
  broker = new ApprovalBroker((event) => events.push(event))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

describe('tool audit trail (spec 026 T22)', () => {
  it('the trail entry carries risk, thread, agent, decision and argument names, and the command text for run_command', async () => {
    const original = events.push.bind(events)
    events.push = (...items: LiveEvent[]) => {
      for (const item of items) {
        if (item.type === 'approval.request') queueMicrotask(() => broker.respond(item.approval.approvalId, 'allow'))
      }
      return original(...items)
    }
    script = (request) =>
      lastToolResults(request).length === 0
        ? turn([toolUse('c1', 'run_command', { command: 'echo hola' })])
        : turn([text('listo')])
    thread.messages.push({ role: 'user', content: [text('corré algo')], ts: Date.now() })
    const profile = settings.agents.find((a) => a.id === 'general')!
    await runAgent(profile, thread.messages, context())
    const entries = trailLines().filter((entry) => entry['target'] === 'run_command')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      action: 'tool.run',
      actor: 'agent',
      target: 'run_command',
      outcome: 'ok',
      detail: { risk: 'exec', thread: 't1', agent: 'general', args: 'command', command: 'echo hola' }
    })
    expect(typeof (entries[0]?.['detail'] as Record<string, unknown>)?.['decision']).toBe('string')
  })

  it('reads are not trailed', async () => {
    writeFileSync(join(workspace, 'nota.txt'), 'hola')
    script = (request) =>
      lastToolResults(request).length === 0
        ? turn([toolUse('r1', 'read_file', { path: 'nota.txt' })])
        : turn([text('listo')])
    thread.messages.push({ role: 'user', content: [text('leé')], ts: Date.now() })
    const profile = settings.agents.find((a) => a.id === 'general')!
    await runAgent(profile, thread.messages, context())
    expect(thread.toolStates.r1?.status).toBe('done')
    expect(trailLines().filter((entry) => entry['target'] === 'read_file')).toEqual([])
  })
})

describe('toolTrail (extracted)', () => {
  const call = { risk: 'exec' as const, name: 'run_command', input: { command: 'echo hola' }, threadId: 't1', agentId: 'general', note: 'Aprobado por vos' }

  it('writes the entry with risk, thread, agent, decision, argument names and command', () => {
    toolTrail(call, 'ok', 'tool.run')
    expect(trailLines()).toHaveLength(1)
    expect(trailLines()[0]).toMatchObject({
      action: 'tool.run',
      actor: 'agent',
      target: 'run_command',
      outcome: 'ok',
      detail: { risk: 'exec', thread: 't1', agent: 'general', decision: 'Aprobado por vos', args: 'command', command: 'echo hola' }
    })
  })

  it('writes denied authorizations and errored runs with their action', () => {
    toolTrail({ ...call, name: 'write_file', input: { path: 'x' } }, 'denied', 'tool.authorize')
    toolTrail(call, 'error', 'tool.run')
    expect(trailLines().map((entry) => [entry['action'], entry['outcome']])).toEqual([
      ['tool.authorize', 'denied'],
      ['tool.run', 'error']
    ])
  })

  it('skips reads and keeps no command text for other tools', () => {
    toolTrail({ ...call, risk: 'read', name: 'read_file', input: { path: 'n.txt' } }, 'ok', 'tool.run')
    toolTrail({ ...call, name: 'write_file', input: { path: 'x.txt', content: 'x' } }, 'ok', 'tool.run')
    const entries = trailLines()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.['detail']).toMatchObject({ args: 'path,content' })
    expect(entries[0]?.['detail']).not.toHaveProperty('command')
  })

  it('a non-object input trails with empty argument names', () => {
    toolTrail({ ...call, input: 'echo hola' }, 'ok', 'tool.run')
    expect(trailLines()[0]?.['detail']).toMatchObject({ args: '' })
    expect(trailLines()[0]?.['detail']).not.toHaveProperty('command')
  })
})
