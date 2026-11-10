import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as z from 'zod/v4'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authorize, ApprovalBroker, type AuthorizationRequest } from '../src/coordinator/approval'
import { runAgent } from '../src/coordinator/agent'
import { McpManager } from '../src/coordinator/mcp'
import type { Provider, TurnRequest, TurnResult } from '../src/coordinator/providers/types'
import { companyAuthoringTools } from '../src/coordinator/tools/company-authoring'
import type { ToolDefinition } from '../src/coordinator/tools/types'
import { defaultSettings } from '../src/shared/defaults'
import type { AgentProfile, Block, LiveEvent, Settings, Thread } from '../src/shared/types'

// Spec 029 — approvals of the company tools: the broker, the answering channel and the chain (plan §6, file A).
let script: (request: TurnRequest) => TurnResult
let reviews: string[] = []
const fakeProvider: Provider = {
  id: 'anthropic',
  streamTurn: async (request) => script(request),
  review: async (request) => {
    reviews.push(request.system)
    return { verdict: 'allow', reason: 'looks fine' }
  },
  listModels: async () => []
}
vi.mock('../src/coordinator/providers', () => ({ getProvider: () => fakeProvider }))

const newBroker = (): { broker: ApprovalBroker; events: LiveEvent[] } => {
  const events: LiveEvent[] = []
  return { broker: new ApprovalBroker((event) => events.push(event)), events }
}

const base = (broker: ApprovalBroker, overrides: Partial<AuthorizationRequest> = {}): AuthorizationRequest => ({
  settings: defaultSettings(),
  threadId: 't1',
  toolUseId: 'u1',
  toolName: 'create_company',
  risk: 'publish',
  input: { name: 'Acme' },
  workspace: '',
  taskContext: '',
  autoApprove: [],
  signal: new AbortController().signal,
  broker,
  setState: () => {},
  rememberAlwaysAllow: () => {},
  ...overrides
})

const approval = (toolName: string, input: unknown) => ({ threadId: 't1', toolUseId: 'u1', toolName, input, flagged: false, allowAlways: false })
/** 1500 characters of JSON.stringify(input, null, 1) are the most a channel shows (BR-23). */
const inputOf = (chars: number): { body: string } => {
  const empty = JSON.stringify({ body: '' }, null, 1).length
  return { body: 'x'.repeat(chars - empty) }
}

describe('the broker and the answering channel (spec 029)', () => {
  it('AC-2.12 (029) the broker refuses allow from telegram and phone when the input does not fit', async () => {
    const { broker, events } = newBroker()
    const signal = new AbortController().signal
    const big = inputOf(1501)
    expect(JSON.stringify(big, null, 1)).toHaveLength(1501)
    const answered = broker.askAnswer(approval('create_company', big), signal)
    const [{ approvalId }] = broker.pending()

    for (const via of ['telegram', 'phone'] as const) {
      broker.respond(approvalId, 'allow', via)
      broker.respond(approvalId, 'always', via)
    }
    expect(broker.pending()).toHaveLength(1)
    expect(events.some((e) => e.type === 'approval.resolved')).toBe(false)

    // the desktop (complete) card still answers it
    broker.respond(approvalId, 'allow', 'desktop')
    await expect(answered).resolves.toMatchObject({ decision: 'allow', via: 'desktop' })
    expect(broker.pending()).toEqual([])
  })

  it('AC-2.12 (029) deny is never refused, and what fits or belongs to another tool still answers', async () => {
    const { broker } = newBroker()
    const signal = new AbortController().signal
    const denied = broker.askAnswer(approval('create_company', inputOf(5000)), signal)
    broker.respond(broker.pending()[0].approvalId, 'deny', 'telegram')
    await expect(denied).resolves.toMatchObject({ decision: 'deny', via: 'telegram' })

    const fits = broker.askAnswer(approval('create_company', inputOf(1500)), signal)
    broker.respond(broker.pending()[0].approvalId, 'allow', 'phone')
    await expect(fits).resolves.toMatchObject({ decision: 'allow', via: 'phone' })

    const other = broker.askAnswer(approval('run_command', inputOf(5000)), signal)
    broker.respond(broker.pending()[0].approvalId, 'allow', 'telegram')
    await expect(other).resolves.toMatchObject({ decision: 'allow', via: 'telegram' })

    // WhatsApp and voice name themselves and show no input at all: they keep answering every other tool as before, never a company proposal
    for (const via of ['whatsapp', 'voice'] as const) {
      const shown = broker.askAnswer(approval('run_command', inputOf(5000)), signal)
      broker.respond(broker.pending()[0].approvalId, 'allow', via)
      await expect(shown).resolves.toMatchObject({ decision: 'allow', via })
      const proposal = broker.askAnswer(approval('create_company', inputOf(100)), signal)
      broker.respond(broker.pending()[0].approvalId, 'allow', via)
      expect(broker.pending()).toHaveLength(1)
      broker.respond(broker.pending()[0].approvalId, 'deny', via)
      await expect(proposal).resolves.toMatchObject({ decision: 'deny', via })
    }
  })

  it('AC-6.4 (029) the answer carries the channel', async () => {
    for (const via of ['desktop', 'telegram', 'phone'] as const) {
      const { broker } = newBroker()
      const run = authorize(base(broker))
      await Promise.resolve()
      broker.respond(broker.pending()[0].approvalId, 'allow', via)
      await expect(run).resolves.toMatchObject({ allowed: true, via })
    }
    const { broker } = newBroker()
    const run = authorize(base(broker))
    await Promise.resolve()
    broker.respond(broker.pending()[0].approvalId, 'deny', 'telegram')
    await expect(run).resolves.toMatchObject({ allowed: false, via: 'telegram' })
  })

  it('AC-6.4 (029) nobody answered: no channel is recorded (cancelled, read-only)', async () => {
    const { broker } = newBroker()
    const controller = new AbortController()
    const run = authorize(base(broker, { signal: controller.signal }))
    await Promise.resolve()
    controller.abort()
    const cancelled = await run
    expect(cancelled.allowed).toBe(false)
    expect(cancelled).not.toHaveProperty('via')
    const blocked = await authorize(base(broker, { settings: { ...defaultSettings(), approvalMode: 'blocked' } }))
    expect(blocked).not.toHaveProperty('via')
  })
})

// ---- The chain, characterized against a stub with risk 'publish' (T21): nothing here changes approval.ts ----
describe('the approval chain for publish tools (spec 029)', () => {
  const text = (t: string): Block => ({ type: 'text', text: t })
  const turn = (content: Block[]): TurnResult => ({ content, stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', model: 'fake' })
  const results = (request: TurnRequest): Extract<Block, { type: 'tool_result' }>[] =>
    (request.messages.at(-1)?.content ?? []).filter((b) => b.type === 'tool_result') as Extract<Block, { type: 'tool_result' }>[]
  const realTools = [...companyAuthoringTools]

  let workspace: string
  let settings: Settings
  let thread: Thread
  let events: LiveEvent[]
  let broker: ApprovalBroker
  let remembered: string[]
  let ran: number
  // A bare publish tool with its own object: the real create_company is only swapped out of the offered list, never changed.
  const stubTool: ToolDefinition = {
    ...(realTools.find((t) => t.name === 'create_company') as ToolDefinition),
    schema: z.strictObject({}),
    validate: undefined,
    preview: undefined,
    previewRequired: undefined,
    run: async () => `ran${++ran}`
  }

  const context = (signal = new AbortController().signal, extra: Record<string, unknown> = {}) => ({
    getSettings: () => settings,
    language: 'es' as const,
    thread,
    scope: { threadId: thread.id },
    signal,
    depth: 0,
    approvals: broker,
    mcp: new McpManager(() => {}),
    host: { request: async () => ({ ok: true, message: 'ok' }) },
    emit: (event: LiveEvent) => events.push(event),
    persist: () => {},
    rememberAlwaysAllow: (name: string) => remembered.push(name),
    knowledge: null,
    saveRoutines: () => {},
    sendTelegram: async () => false,
    whatsapp: null,
    authoring: { defaultVaultPath: '', folderHasFiles: async () => false, initVault: async () => {}, save: () => {}, calls: { create: 0 } },
    ...extra
  })
  const general = (): AgentProfile => settings.agents.find((a) => a.id === 'general') as AgentProfile

  /** One create_company call from the model, ending the turn after the result. */
  function modelCalls(): void {
    script = (request) => (results(request).length === 0 ? turn([{ type: 'tool_use', id: 'c1', name: 'create_company', input: {} }]) : turn([text('ok')]))
  }
  const run = (agent = general(), ctx = context()): Promise<string> => {
    thread.messages.push({ role: 'user', content: [text('creá una empresa')], ts: 0 })
    return runAgent(agent, thread.messages, ctx)
  }
  const requests = (): LiveEvent[] => events.filter((e) => e.type === 'approval.request')
  /** Answers every approval card as soon as it appears. */
  function answerWith(decision: 'allow' | 'deny' | 'always'): void {
    const push = events.push.bind(events)
    events.push = (...items: LiveEvent[]) => {
      for (const item of items) if (item.type === 'approval.request') queueMicrotask(() => broker.respond(item.approval.approvalId, decision, 'desktop'))
      return push(...items)
    }
  }

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'alma-company-approval-'))
    settings = defaultSettings()
    thread = { id: 't1', title: 'x', agentId: 'general', workspace, createdAt: 0, updatedAt: 0, messages: [], subagents: {}, toolStates: {} }
    events = []
    remembered = []
    ran = 0
    reviews = []
    broker = new ApprovalBroker((event) => events.push(event))
    // These tests are about the approval chain, not about a creation.
    companyAuthoringTools.splice(0, companyAuthoringTools.length, stubTool)
    modelCalls()
  })
  afterEach(() => {
    companyAuthoringTools.splice(0, companyAuthoringTools.length, ...realTools)
    rmSync(workspace, { recursive: true, force: true })
  })

  it('AC-2.3 (029) publish tools always ask in every mode and cannot be remembered', async () => {
    settings.alwaysAllowTools = ['create_company']
    general().autoApproveTools = ['create_company']
    for (const approvalMode of ['needs-approval', 'auto-review', 'always-allow'] as const) {
      settings.approvalMode = approvalMode
      events.length = 0
      answerWith('always')
      thread.messages.length = 0
      await run(general(), context(undefined, { autoApprove: ['create_company'] }))
      // exactly one card, with no "Siempre" button, and the answer "always" counts once
      expect(requests(), approvalMode).toHaveLength(1)
      expect(requests()[0], approvalMode).toMatchObject({ approval: { toolName: 'create_company', allowAlways: false } })
      expect(thread.toolStates.c1, approvalMode).toMatchObject({ status: 'done', note: 'Aprobado por vos' })
    }
    expect(remembered).toEqual([])
    expect(ran).toBe(3)
  })

  it('AC-2.4 (029) read-only mode denies without asking', async () => {
    settings.approvalMode = 'blocked'
    await run()
    expect(requests()).toEqual([])
    expect(broker.pending()).toEqual([])
    expect(thread.toolStates.c1).toMatchObject({ status: 'denied', note: 'Bloqueado por el modo de aprobación' })
    expect(ran).toBe(0)
  })

  it('AC-2.5 (029) a denial changes nothing and tells the model not to retry', async () => {
    answerWith('deny')
    let told = ''
    script = (request) => {
      if (results(request).length === 0) return turn([{ type: 'tool_use', id: 'c1', name: 'create_company', input: {} }])
      told = results(request)[0].content
      return turn([text('ok')])
    }
    await run()
    expect(thread.toolStates.c1.status).toBe('denied')
    expect(told).toContain('Rejected by the user. Do not retry the same action')
    expect(ran).toBe(0)
  })

  it('AC-2.6 (029) stopping the run while pending denies with Cancelado', async () => {
    const controller = new AbortController()
    const running = run(general(), context(controller.signal))
    await vi.waitFor(() => expect(broker.pending()).toHaveLength(1))
    controller.abort()
    await running
    expect(thread.toolStates.c1).toMatchObject({ status: 'denied', note: 'Cancelado' })
    expect(broker.pending()).toEqual([])
    expect(ran).toBe(0)
  })

  it('AC-2.10 (029) no boss review for these tools', async () => {
    for (const approvalMode of ['needs-approval', 'auto-review'] as const) {
      settings.approvalMode = approvalMode
      events.length = 0
      answerWith('allow')
      thread.messages.length = 0
      await run()
      expect(requests(), approvalMode).toHaveLength(1)
    }
    // neither the boss nor the auto-reviewer is consulted: only the person
    expect(reviews).toEqual([])
  })

  it('AC-6.2 (029) a listed publish tool still goes to boss then person', async () => {
    const boss: AgentProfile = { ...general(), id: 'jefa', name: 'La jefa', systemPrompt: 'Revisá todo.' }
    const { broker: own } = newBroker()
    const pending = authorize(base(own, { toolName: 'instagram_publish', autoApprove: ['instagram_publish'], boss: { name: 'La jefa (CEO)', profile: boss } }))
    await vi.waitFor(() => expect(own.pending()).toHaveLength(1))
    // the boss reviewed first, then the person was asked, with no "Siempre"
    expect(reviews).toHaveLength(1)
    expect(own.pending()[0]).toMatchObject({ toolName: 'instagram_publish', allowAlways: false })
    own.respond(own.pending()[0].approvalId, 'allow', 'desktop')
    await expect(pending).resolves.toMatchObject({ allowed: true })
  })
})
