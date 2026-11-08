import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../src/shared/defaults'
import type { Block, Company, LiveEvent, Settings, Thread } from '../src/shared/types'
import type { CompanyEngine } from '../src/coordinator/company/engine'
import type { Provider, ReviewVerdict, TurnRequest, TurnResult } from '../src/coordinator/providers/types'

// A scripted provider: each test decides what the "model" answers for every turn.
let script: (request: TurnRequest) => Promise<TurnResult> | TurnResult
let reviewVerdict: ReviewVerdict = { verdict: 'allow', reason: 'ok' }
const fakeProvider: Provider = {
  id: 'anthropic',
  streamTurn: async (request) => script(request),
  review: async () => reviewVerdict,
  listModels: async () => []
}
vi.mock('../src/coordinator/providers', () => ({ getProvider: () => fakeProvider }))

const { repairDanglingToolUses, runAgent } = await import('../src/coordinator/agent')
const { ApprovalBroker } = await import('../src/coordinator/approval')
const { McpManager } = await import('../src/coordinator/mcp')

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
let settings: Settings
let thread: Thread
let events: LiveEvent[]
let broker: InstanceType<typeof ApprovalBroker>
let remembered: string[]

function context(signal = new AbortController().signal) {
  return {
    getSettings: () => settings,
    language: 'es' as const,
    thread,
    scope: { threadId: thread.id },
    signal,
    depth: 0,
    approvals: broker,
    mcp: new McpManager(() => {}),
    host: { request: async () => ({ ok: true, message: 'Publicado en Instagram.' }) },
    emit: (event: LiveEvent) => events.push(event),
    persist: () => {},
    rememberAlwaysAllow: (name: string) => remembered.push(name),
    knowledge: null,
    saveRoutines: () => {},
    sendTelegram: async () => false,
    whatsapp: null
  }
}

function start(userText: string, agentId = 'general'): Promise<string> {
  thread.messages.push({ role: 'user', content: [text(userText)], ts: Date.now() })
  const profile = settings.agents.find((a) => a.id === agentId)!
  return runAgent(profile, thread.messages, context())
}

/** Answers every approval request the moment it appears. */
function autoRespond(decision: 'allow' | 'deny' | 'always'): void {
  const original = events.push.bind(events)
  events.push = (...items: LiveEvent[]) => {
    for (const item of items) {
      if (item.type === 'approval.request') queueMicrotask(() => broker.respond(item.approval.approvalId, decision))
    }
    return original(...items)
  }
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'alma-agent-'))
  settings = defaultSettings()
  thread = { id: 't1', title: 'x', agentId: 'general', workspace, createdAt: 0, updatedAt: 0, messages: [], subagents: {}, toolStates: {} }
  events = []
  remembered = []
  broker = new ApprovalBroker((event) => events.push(event))
  reviewVerdict = { verdict: 'allow', reason: 'ok' }
})
afterEach(() => rmSync(workspace, { recursive: true, force: true }))

describe('agent loop', () => {
  it('asks for approval, runs the tool and feeds the result back', async () => {
    autoRespond('allow')
    script = (request) => {
      const results = lastToolResults(request)
      if (results.length === 0) return turn([text('Creo el archivo.'), toolUse('w1', 'write_file', { path: 'hola.txt', content: 'hola' })])
      expect(results[0].is_error).toBeUndefined()
      return turn([text('Listo.')])
    }
    const final = await start('creá hola.txt')
    expect(final).toBe('Listo.')
    expect(readFileSync(join(workspace, 'hola.txt'), 'utf8')).toBe('hola')
    expect(thread.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(events.some((e) => e.type === 'approval.request')).toBe(true)
    expect(thread.toolStates.w1).toMatchObject({ status: 'done', note: 'Aprobado por vos' })
  })

  it('returns an error result when the user denies', async () => {
    autoRespond('deny')
    script = (request) =>
      lastToolResults(request).length === 0
        ? turn([toolUse('c1', 'run_command', { command: 'echo no' })])
        : turn([text(lastToolResults(request)[0].content)])
    const final = await start('corré algo')
    expect(final).toMatch(/Rejected by the user/)
    expect(thread.toolStates.c1.status).toBe('denied')
  })

  it('never asks for read-only tools and blocks writes in read-only mode', async () => {
    settings.approvalMode = 'blocked'
    script = (request) =>
      lastToolResults(request).length === 0
        ? turn([toolUse('r1', 'list_dir', {}), toolUse('w1', 'write_file', { path: 'x.txt', content: 'x' })])
        : turn([text('fin')])
    await start('mirá y escribí')
    expect(events.some((e) => e.type === 'approval.request')).toBe(false)
    expect(thread.toolStates.r1.status).toBe('done')
    expect(thread.toolStates.w1).toMatchObject({ status: 'denied', note: 'Bloqueado por el modo de aprobación' })
    expect(existsSync(join(workspace, 'x.txt'))).toBe(false)
  })

  it('does not ask for approval when there is no workspace', async () => {
    thread.workspace = ''
    let seen: Extract<Block, { type: 'tool_result' }> | undefined
    script = (request) => {
      if (lastToolResults(request).length === 0) return turn([toolUse('w1', 'write_file', { path: 'x.txt', content: 'x' })])
      seen = lastToolResults(request)[0]
      return turn([text('ok')])
    }
    await start('escribí')
    expect(events.some((e) => e.type === 'approval.request')).toBe(false)
    expect(seen).toMatchObject({ is_error: true, content: expect.stringContaining('No working folder is selected') })
  })

  it('rejects invalid tool input without running it', async () => {
    settings.approvalMode = 'always-allow'
    let seen: Extract<Block, { type: 'tool_result' }> | undefined
    script = (request) => {
      if (lastToolResults(request).length === 0) return turn([toolUse('w1', 'write_file', { path: 'x.txt' })])
      seen = lastToolResults(request)[0]
      return turn([text('ok')])
    }
    await start('escribí')
    expect(seen?.is_error).toBe(true)
    expect(seen?.content).toContain('INVALID_JSON')
    expect(existsSync(join(workspace, 'x.txt'))).toBe(false)
  })

  it('does not run tools from a turn cut off by max_tokens', async () => {
    settings.approvalMode = 'always-allow'
    let calls = 0
    script = () => {
      calls++
      return calls === 1
        ? turn([toolUse('w1', 'write_file', { path: 'x.txt', content: 'parcial' })], 'max_tokens')
        : turn([text('reintento')])
    }
    await start('escribí')
    expect(existsSync(join(workspace, 'x.txt'))).toBe(false)
    expect(thread.messages[2].content[0]).toMatchObject({ type: 'tool_result', is_error: true })
  })

  it('auto-review runs safe actions and asks about flagged ones', async () => {
    settings.approvalMode = 'auto-review'
    autoRespond('deny')
    reviewVerdict = { verdict: 'allow', reason: 'edición acotada' }
    script = (request) =>
      lastToolResults(request).length === 0 ? turn([toolUse('w1', 'write_file', { path: 'a.txt', content: 'a' })]) : turn([text('ok')])
    await start('escribí a')
    expect(thread.toolStates.w1).toMatchObject({ status: 'done', note: 'Auto-review: edición acotada' })

    reviewVerdict = { verdict: 'flag', reason: 'borra todo' }
    script = (request) =>
      lastToolResults(request).length === 0 || request.messages.at(-1)?.content[0].type === 'text'
        ? turn([toolUse('c1', 'run_command', { command: 'rm -rf /' })])
        : turn([text('ok')])
    thread.messages.push({ role: 'user', content: [text('borrá')], ts: 0 })
    await runAgent(settings.agents[0], thread.messages, context())
    const request = events.find((e) => e.type === 'approval.request' && e.approval.toolUseId === 'c1')
    expect(request).toMatchObject({ approval: { flagged: true, reason: 'borra todo' } })
    expect(thread.toolStates.c1.status).toBe('denied')
  })

  it('remembers "siempre permitir"', async () => {
    autoRespond('always')
    script = (request) =>
      lastToolResults(request).length === 0 ? turn([toolUse('w1', 'write_file', { path: 'a.txt', content: 'a' })]) : turn([text('ok')])
    await start('escribí')
    expect(remembered).toEqual(['write_file'])
  })

  it('runs delegated subagents in parallel and returns their results', async () => {
    settings.approvalMode = 'always-allow'
    let active = 0
    let maxActive = 0
    script = async (request) => {
      if (request.system.includes('You are a subagent')) {
        const task = (request.messages[0].content[0] as { text: string }).text
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 50))
        active--
        return turn([text(`resultado de: ${task}`)])
      }
      const results = lastToolResults(request)
      if (results.length === 0) {
        expect(request.tools.map((t) => t.name)).toContain('delegate_task')
        return turn([
          toolUse('d1', 'delegate_task', { agent: 'investigador', title: 'Parte A', task: 'investigar A' }),
          toolUse('d2', 'delegate_task', { agent: 'revisor', title: 'Parte B', task: 'revisar B' })
        ])
      }
      return turn([text(results.map((r) => r.content).join(' | '))])
    }
    const final = await start('dividí el trabajo')
    expect(maxActive).toBe(2)
    expect(final).toBe('resultado de: investigar A | resultado de: revisar B')
    expect(thread.subagents.d1).toMatchObject({ agentName: 'Investigador', status: 'done', title: 'Parte A' })
    expect(thread.subagents.d2.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(events.filter((e) => e.type === 'subagent.started')).toHaveLength(2)
  })

  it('does not let subagents delegate further', async () => {
    let subagentTools: string[] = []
    script = (request) => {
      if (request.system.includes('You are a subagent')) {
        subagentTools = request.tools.map((t) => t.name)
        return turn([text('hecho')])
      }
      return lastToolResults(request).length === 0
        ? turn([toolUse('d1', 'delegate_task', { agent: 'programador', title: 'x', task: 'y' })])
        : turn([text('fin')])
    }
    settings.agents.find((a) => a.id === 'programador')!.canDelegate = true
    await start('delegá')
    expect(subagentTools).not.toContain('delegate_task')
    expect(subagentTools).toContain('run_command')
  })

  it('denies pending approvals when the run is cancelled', async () => {
    const controller = new AbortController()
    script = (request) =>
      lastToolResults(request).length === 0 ? turn([toolUse('w1', 'write_file', { path: 'a.txt', content: 'a' })]) : turn([text('ok')])
    thread.messages.push({ role: 'user', content: [text('escribí')], ts: 0 })
    const run = runAgent(settings.agents[0], thread.messages, context(controller.signal))
    await vi.waitFor(() => expect(broker.pending()).toHaveLength(1))
    controller.abort()
    await run
    expect(thread.toolStates.w1).toMatchObject({ status: 'denied', note: 'Cancelado' })
    expect(existsSync(join(workspace, 'a.txt'))).toBe(false)
    expect(thread.messages.at(-1)?.role).toBe('user')
  })

  it('always asks before publishing, even when everything else is allowed', async () => {
    settings.approvalMode = 'always-allow'
    settings.alwaysAllowTools = ['instagram_publish']
    autoRespond('always')
    writeFileSync(join(workspace, 'post.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'))
    script = (request) =>
      lastToolResults(request).length === 0
        ? turn([toolUse('p1', 'instagram_publish', { image_path: 'post.png', caption: 'Hola' })])
        : turn([text(lastToolResults(request)[0].content)])
    const final = await start('publicá', 'community-manager')
    const request = events.find((e) => e.type === 'approval.request')
    expect(request).toMatchObject({ approval: { toolName: 'instagram_publish', allowAlways: false, preview: { caption: 'Hola' } } })
    expect(final).toBe('Publicado en Instagram.')
    // "always" on a publish approval counts once and is never remembered.
    expect(remembered).toEqual([])
  })

  it('lets an agent run its own auto-approved tools without asking', async () => {
    settings.approvalMode = 'needs-approval'
    script = (request) =>
      lastToolResults(request).length === 0
        ? turn([toolUse('w1', 'write_file', { path: 'publicaciones.md', content: '- post' })])
        : turn([text('ok')])
    await start('anotá', 'community-manager')
    expect(events.some((e) => e.type === 'approval.request')).toBe(false)
    expect(thread.toolStates.w1).toMatchObject({ status: 'done', note: 'Permitido para este agente' })
  })

  it('blocks publishing in read-only mode', async () => {
    settings.approvalMode = 'blocked'
    script = (request) =>
      lastToolResults(request).length === 0
        ? turn([toolUse('p1', 'instagram_publish', { image_path: 'post.png', caption: 'Hola' })])
        : turn([text('ok')])
    await start('publicá', 'community-manager')
    expect(thread.toolStates.p1).toMatchObject({ status: 'denied' })
  })
})

describe('repairDanglingToolUses', () => {
  it('closes tool calls left without results', () => {
    const messages = [
      { role: 'user' as const, content: [text('hola')], ts: 0 },
      { role: 'assistant' as const, content: [text('voy'), toolUse('a', 'run_command', {}), toolUse('b', 'read_file', {})], ts: 0 }
    ]
    expect(repairDanglingToolUses(messages)).toBe(true)
    expect(messages[2]).toMatchObject({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', is_error: true },
        { type: 'tool_result', tool_use_id: 'b', is_error: true }
      ]
    })
    expect(repairDanglingToolUses(messages)).toBe(false)
  })
})

describe('voice conversation tool (spec 024)', () => {
  const offered = async (channel: Thread['channel'], depth = 0): Promise<string[]> => {
    thread.channel = channel
    let names: string[] = []
    script = (request) => {
      names = request.tools.map((t) => t.name)
      return turn([text('ok')])
    }
    thread.messages.push({ role: 'user', content: [text('hola')], ts: 0 })
    await runAgent(settings.agents.find((a) => a.id === 'general')!, thread.messages, { ...context(), depth })
    return names
  }

  it('AC-2.1 is offered in a voice conversation, not in other channels or to subagents', async () => {
    expect(await offered('voice')).toContain('end_voice_conversation')
    expect(await offered(undefined)).not.toContain('end_voice_conversation')
    expect(await offered('telegram')).not.toContain('end_voice_conversation')
    expect(await offered('voice', 1)).not.toContain('end_voice_conversation')
  })

  it('AC-2.1 runs without asking and tells the model to say goodbye briefly', async () => {
    thread.channel = 'voice'
    script = (request) =>
      lastToolResults(request).length === 0 ? turn([toolUse('e1', 'end_voice_conversation', {})]) : turn([text('Chau.')])
    await start('gracias, nada más')
    expect(events.some((e) => e.type === 'approval.request')).toBe(false)
    expect(thread.toolStates.e1.status).toBe('done')
  })
})

describe('a company head agent in a chat the user opened', () => {
  async function headRun(): Promise<{ system: string; tools: string[]; engine: InstanceType<typeof CompanyEngine>; company: Company }> {
    const { CompanyEngine } = await import('../src/coordinator/company/engine')
    const { CompanyStore } = await import('../src/coordinator/company/store')
    const base = settings.agents[0]
    const company: Company = {
      id: 'acme',
      name: 'Acme',
      mission: '',
      goals: '',
      vault: workspace,
      color: '#000',
      budgetUsd: 0,
      members: [
        { id: 'general', title: 'CEO', reportsTo: null, collaborates: [], budgetUsd: 0 },
        { id: 'ana', title: 'Analista', reportsTo: 'general', collaborates: [], budgetUsd: 0 }
      ],
      email: { address: '', imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465 },
      whatsapp: false,
      createdAt: 0
    }
    settings.companies = [company]
    settings.agents = [
      { ...base, id: 'general', name: 'La general', companyId: company.id },
      { ...base, id: 'ana', name: 'Ana', companyId: company.id }
    ]
    const engine = new CompanyEngine({
      settings: () => settings,
      store: new CompanyStore(workspace),
      runMember: () => ({ threadId: 'x', done: Promise.resolve('') }),
      complete: async () => ({ text: '' }),
      writeNote: async () => {},
      notify: () => {},
      emit: () => {}
    })
    let system = ''
    let tools: string[] = []
    script = (request) => {
      if (lastToolResults(request).length > 0) return turn([text('Listo.')])
      system = request.system
      tools = request.tools.map((t) => t.name)
      return turn([toolUse('m1', 'schedule_meeting', { topic: 'Plan de X', agenda: ['X'], participants: ['ana'], at: '2030-05-14T15:00' })])
    }
    thread.messages.push({ role: 'user', content: [text('creá una reunión mañana a las 3pm para hablar de X')], ts: 0 })
    const profile = settings.agents.find((a) => a.id === 'general')!
    await runAgent(profile, thread.messages, { ...context(), company: { company, memberId: 'general', engine } })
    return { system, tools, engine, company }
  }

  it('is offered schedule_meeting, knows the local date and its team ids, and schedules without asking', async () => {
    const { system, tools, engine, company } = await headRun()
    expect(tools).toContain('schedule_meeting')
    expect(system).toMatch(/Local date and time: \w+day, /)
    expect(system).toContain('(id ana)')
    expect(events.some((e) => e.type === 'approval.request')).toBe(false)
    expect(thread.toolStates.m1.status).toBe('done')
    const [meeting] = engine.snapshot(company.id).meetings
    expect(meeting).toMatchObject({ topic: 'Plan de X', chair: 'general', participants: ['general', 'ana'], at: new Date('2030-05-14T15:00').getTime() })
  })
})
