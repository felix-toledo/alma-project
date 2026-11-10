import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as z from 'zod/v4'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initAudit } from '../src/shared/audit'
import { defaultSettings } from '../src/shared/defaults'
import { translateText } from '../src/shared/i18n/messages'
import type { Block, Company, LiveEvent, Settings, Thread } from '../src/shared/types'
import type { CompanyEngine } from '../src/coordinator/company/engine'
import type { Provider, TurnRequest, TurnResult } from '../src/coordinator/providers/types'
import type { CompanyAuthoringHost, ToolDefinition } from '../src/coordinator/tools/types'

// Spec 029 — the company authoring tools: the gate, the validate hook, the run and the audit (plan §6, file T).
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
const companyTools = await import('../src/coordinator/tools/company-authoring')
const { ToolError } = await import('../src/coordinator/tools/types')

const text = (t: string): Block => ({ type: 'text', text: t })
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: 'tool_use', id, name, input })
const turn = (content: Block[]): TurnResult => ({
  content,
  stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
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
let authoring: CompanyAuthoringHost & { saved: unknown[]; inited: string[] }

function fakeHost(): typeof authoring {
  const saved: unknown[] = []
  const inited: string[] = []
  return {
    defaultVaultPath: 'C:\\Users\\x\\Documents\\Alma\\Vault',
    folderHasFiles: async () => false,
    initVault: async (path) => void inited.push(path),
    save: (update) => void saved.push(update(settings)),
    calls: { create: 0 },
    saved,
    inited
  }
}

function context(overrides: Record<string, unknown> = {}) {
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
    whatsapp: null,
    authoring,
    ...overrides
  }
}

/** The tool names the model is offered on one turn. */
async function offered(agentId: string, overrides: Record<string, unknown> = {}): Promise<string[]> {
  let names: string[] = []
  script = (request) => {
    names = request.tools.map((t) => t.name)
    return turn([text('ok')])
  }
  thread.messages.push({ role: 'user', content: [text('hola')], ts: 0 })
  await runAgent(settings.agents.find((a) => a.id === agentId)!, thread.messages, context(overrides))
  return names
}

const seat = (): unknown => {
  const company: Company = {
    id: 'acme', name: 'Acme', mission: '', goals: '', vault: workspace, color: '#000', budgetUsd: 0,
    members: [{ id: 'general', title: 'CEO', reportsTo: null, collaborates: [], budgetUsd: 0 }],
    email: { address: '', imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465 }, whatsapp: false, createdAt: 0
  }
  return { company, memberId: 'general', engine: {} as CompanyEngine }
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'alma-company-tools-'))
  dataDir = mkdtempSync(join(tmpdir(), 'alma-company-audit-'))
  initAudit(dataDir, 'coordinator')
  settings = defaultSettings()
  thread = { id: 't1', title: 'x', agentId: 'general', workspace, createdAt: 0, updatedAt: 0, messages: [], subagents: {}, toolStates: {} }
  events = []
  broker = new ApprovalBroker((event) => events.push(event))
  authoring = fakeHost()
})
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

describe('offering the tools (spec 029)', () => {
  it('AC-1.1 (029) offers create_company (edit_company is withheld, G-1) to an attended depth-0 run without a seat on desktop, telegram and remote', async () => {
    for (const channel of [undefined, 'telegram', 'remote'] as const) {
      thread.channel = channel
      for (const agentId of ['general', 'programador', 'investigador']) {
        expect(await offered(agentId), `${agentId} on ${channel}`).toEqual(expect.arrayContaining(['create_company']))
        expect(await offered(agentId), `${agentId} on ${channel}`).not.toContain('edit_company')
      }
    }
  })

  it('AC-1.1 (029) without a host (no authoring in the run) the tools are not offered', async () => {
    expect(await offered('general', { authoring: null })).not.toEqual(expect.arrayContaining(['create_company']))
    expect(await offered('general', { authoring: undefined })).not.toContain('create_company')
  })

  it('AC-1.2 (029) a company agent is not offered the tools and a forced call is refused with no approval', async () => {
    expect(await offered('general', { company: seat() })).not.toContain('create_company')
    let result: Extract<Block, { type: 'tool_result' }> | undefined
    script = (request) => {
      if (lastToolResults(request).length === 0) return turn([toolUse('f1', 'create_company', { name: 'X' })])
      result = lastToolResults(request)[0]
      return turn([text('ok')])
    }
    thread.messages.push({ role: 'user', content: [text('creá una empresa')], ts: 0 })
    await runAgent(settings.agents.find((a) => a.id === 'general')!, thread.messages, context({ company: seat() }))
    expect(result).toMatchObject({ is_error: true, content: expect.stringContaining('not available') })
    expect(thread.toolStates.f1.status).toBe('error')
    expect(broker.pending()).toEqual([])
    expect(events.some((e) => e.type === 'approval.request')).toBe(false)
    expect(authoring.saved).toEqual([])
    expect(authoring.inited).toEqual([])
  })

  it('AC-1.3 (029) voice and whatsapp threads are not offered the tools', async () => {
    // 'company' is a task thread; 'sms' stands for a channel that does not exist yet (the gate is an allow-list).
    for (const channel of ['voice', 'whatsapp', 'company', 'sms'] as const) {
      thread.channel = channel as Thread['channel']
      const names = await offered('general')
      expect(names, channel).not.toContain('create_company')
      expect(names, channel).not.toContain('edit_company')
    }
  })

  it('AC-1.4 (029) sub-agents and unattended runs are not offered the tools', async () => {
    expect(await offered('general', { depth: 1 })).not.toContain('create_company')
    expect(await offered('general', { unattended: true })).not.toContain('create_company')
    expect(await offered('general', { unattended: true })).not.toContain('edit_company')
  })
})

describe('validate and previewRequired hooks (spec 029)', () => {
  const { companyAuthoringTools } = companyTools
  const realTools = [...companyAuthoringTools]
  let stubTool: ToolDefinition
  const create = (): ToolDefinition => stubTool
  // These tests are about the hooks, not about a creation: a bare tool of its own, taking an empty input. The real create_company is only swapped out of the offered list, never changed.
  beforeEach(() => {
    stubTool = { ...realTools.find((t) => t.name === 'create_company')!, schema: z.strictObject({}), validate: undefined, preview: undefined, previewRequired: undefined, auditAction: undefined }
    companyAuthoringTools.splice(0, companyAuthoringTools.length, stubTool)
  })
  afterEach(() => {
    companyAuthoringTools.splice(0, companyAuthoringTools.length, ...realTools)
  })

  /** Calls create_company once and returns what the model read back. */
  async function callOnce(): Promise<Extract<Block, { type: 'tool_result' }>> {
    const original = events.push.bind(events)
    events.push = (...items: LiveEvent[]) => {
      for (const item of items) {
        if (item.type === 'approval.request') queueMicrotask(() => broker.respond(item.approval.approvalId, 'deny', 'desktop'))
      }
      return original(...items)
    }
    let result: Extract<Block, { type: 'tool_result' }> | undefined
    script = (request) => {
      if (lastToolResults(request).length === 0) return turn([toolUse('c1', 'create_company', {})])
      result = lastToolResults(request)[0]
      return turn([text('ok')])
    }
    thread.messages.push({ role: 'user', content: [text('creá una empresa')], ts: 0 })
    await runAgent(settings.agents.find((a) => a.id === 'general')!, thread.messages, context())
    return result!
  }
  const asked = (): boolean => events.some((e) => e.type === 'approval.request')

  it('AC-5.1 (029) a failing validate hook shows no card and the call errors', async () => {
    const tool = create()
    const validate = vi.fn(async () => {
      throw new ToolError('tool.cwd.notSelected')
    })
    const preview = vi.fn(async () => ({ note: 'x' }))
    const run = vi.fn(async () => 'ran')
    Object.assign(tool, { validate, preview, run })
    const result = await callOnce()
    expect(validate).toHaveBeenCalledWith({}, expect.objectContaining({ authoring }))
    expect(result).toMatchObject({ is_error: true, content: expect.stringContaining('No working folder is selected') })
    expect(asked()).toBe(false)
    expect(preview).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(thread.toolStates.c1).toMatchObject({ status: 'error', note: 'Entrada inválida' })
  })

  it('AC-5.1 (029) a validate hook that throws anything else also errors before any card, and the card does not call it invalid input', async () => {
    const run = vi.fn(async () => 'ran')
    Object.assign(create(), { validate: async () => { throw new Error('boom') }, run })
    const result = await callOnce()
    expect(result).toMatchObject({ is_error: true, content: 'Error: boom' })
    expect(asked()).toBe(false)
    expect(run).not.toHaveBeenCalled()
    expect(thread.toolStates.c1).toMatchObject({ status: 'error', note: 'Falló la herramienta' })
  })

  it('AC-5.1 (029) a passing validate hook lets the call reach the card', async () => {
    Object.assign(create(), { validate: async () => {} })
    await callOnce()
    expect(asked()).toBe(true)
  })

  it('AC-2.1 (029) a missing preview aborts the call', async () => {
    const run = vi.fn(async () => 'ran')
    // an absent preview and one that throws are the same to a previewRequired tool
    for (const preview of [undefined, async () => { throw new Error('no card') }]) {
      events.length = 0
      thread.messages.length = 0
      Object.assign(create(), { previewRequired: true, preview, run })
      const result = await callOnce()
      expect(result).toMatchObject({ is_error: true, content: expect.stringContaining('could not be shown') })
      expect(asked()).toBe(false)
      expect(thread.toolStates.c1).toMatchObject({ status: 'error', note: 'Falló la herramienta' })
    }
    expect(run).not.toHaveBeenCalled()
  })

  it('AC-2.1 (029) a previewRequired tool with a preview still asks, and the card carries it', async () => {
    Object.assign(create(), { previewRequired: true, preview: async () => ({ note: 'shown' }) })
    await callOnce()
    expect(events.find((e) => e.type === 'approval.request')).toMatchObject({ approval: { toolName: 'create_company', preview: { note: 'shown' } } })
  })
})

describe('the audit of the company tools (spec 029 AC-6.4)', () => {
  const { companyAuthoringTools } = companyTools
  const realTools = [...companyAuthoringTools]
  let stubTool: ToolDefinition
  const create = (): ToolDefinition => stubTool
  const SECRETS = ['Zafiro-Corp', 'MISSION-needle', 'INSTRUCTIONS-needle']
  const input = { name: SECRETS[0], mission: SECRETS[1], instructions: SECRETS[2] }
  afterEach(() => {
    companyAuthoringTools.splice(0, companyAuthoringTools.length, ...realTools)
  })

  const auditFile = (): string => join(dataDir, 'audit', `coordinator-${new Date().toISOString().slice(0, 7)}.jsonl`)
  const entries = (): Record<string, unknown>[] =>
    existsSync(auditFile()) ? readFileSync(auditFile(), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
  const forTool = (): Record<string, unknown>[] => entries().filter((entry) => entry['target'] === 'create_company')

  /** A create_company stub that reports 3 positions while validating and a company id when it runs. */
  function stub(run: () => Promise<string>): void {
    stubTool = {
      ...realTools.find((t) => t.name === 'create_company')!,
      auditAction: 'company.create',
      schema: z.object({ name: z.string(), mission: z.string(), instructions: z.string() }),
      validate: async (_input: unknown, ctx: { reportAudit?: (detail: Record<string, string | number | boolean | null>) => void }) => ctx.reportAudit?.({ positions: 3 }),
      preview: async () => ({ note: 'shown' }),
      run: async (_input: unknown, ctx: { reportAudit?: (detail: Record<string, string | number | boolean | null>) => void }) => {
        const text = await run()
        ctx.reportAudit?.({ companyId: 'empresa-1' })
        return text
      }
    }
    companyAuthoringTools.splice(0, companyAuthoringTools.length, stubTool)
  }

  async function call(answer: { decision: 'allow' | 'deny'; via: 'desktop' | 'telegram' | 'phone' } | null): Promise<void> {
    if (answer) {
      const original = events.push.bind(events)
      events.push = (...items: LiveEvent[]) => {
        for (const item of items) {
          if (item.type === 'approval.request') queueMicrotask(() => broker.respond(item.approval.approvalId, answer.decision, answer.via))
        }
        return original(...items)
      }
    }
    script = (request) => (lastToolResults(request).length === 0 ? turn([toolUse('c1', 'create_company', input)]) : turn([text('ok')]))
    thread.messages.push({ role: 'user', content: [text('creá una empresa')], ts: 0 })
    await runAgent(settings.agents.find((a) => a.id === 'general')!, thread.messages, context())
  }

  it('AC-6.4 (029) audit entry per outcome with ids and counts only', async () => {
    // ok
    stub(async () => 'created')
    await call({ decision: 'allow', via: 'telegram' })
    expect(forTool()).toHaveLength(1)
    expect(forTool()[0]).toMatchObject({ action: 'company.create', actor: 'agent', target: 'create_company', outcome: 'ok', detail: { companyId: 'empresa-1', positions: 3, via: 'telegram' } })

    // denied before anything exists: no company id
    await call({ decision: 'deny', via: 'desktop' })
    expect(forTool()).toHaveLength(2)
    expect(forTool()[1]).toMatchObject({ action: 'company.create', outcome: 'denied', detail: { positions: 3, via: 'desktop' } })
    expect(forTool()[1]['detail']).not.toHaveProperty('companyId')

    // error after approval
    stub(async () => {
      throw new Error('disk full')
    })
    await call({ decision: 'allow', via: 'phone' })
    expect(forTool()).toHaveLength(3)
    expect(forTool()[2]).toMatchObject({ action: 'company.create', outcome: 'error', detail: { positions: 3, via: 'phone' } })

    // read-only mode: nobody answered, so no channel
    settings.approvalMode = 'blocked'
    await call(null)
    expect(forTool()).toHaveLength(4)
    expect(forTool()[3]).toMatchObject({ action: 'company.create', outcome: 'denied', detail: { positions: 3 } })
    expect(forTool()[3]['detail']).not.toHaveProperty('via')

    // the generic pair is replaced, and nothing the person wrote reaches the file
    expect(forTool().map((entry) => entry['action'])).toEqual(['company.create', 'company.create', 'company.create', 'company.create'])
    const raw = readFileSync(auditFile(), 'utf8')
    for (const secret of SECRETS) expect(raw, secret).not.toContain(secret)
  })

  it('AC-6.4 (029) a call refused by validate or left without its required preview is audited as an error, ids and counts only', async () => {
    stub(async () => 'created')
    Object.assign(create(), {
      validate: async (_input: unknown, ctx: { reportAudit?: (detail: Record<string, string | number | boolean | null>) => void }) => {
        ctx.reportAudit?.({ positions: 3 })
        throw new Error('refused')
      }
    })
    await call(null)
    expect(forTool()).toHaveLength(1)
    expect(forTool()[0]).toMatchObject({ action: 'company.create', outcome: 'error', detail: { positions: 3 } })

    stub(async () => 'created')
    Object.assign(create(), { previewRequired: true, preview: async () => Promise.reject(new Error('no preview')) })
    await call(null)
    expect(forTool()).toHaveLength(2)
    expect(forTool()[1]).toMatchObject({ action: 'company.create', outcome: 'error', detail: { positions: 3 } })
    expect(forTool()[1]['detail']).not.toHaveProperty('via')
    const raw = readFileSync(auditFile(), 'utf8')
    for (const secret of SECRETS) expect(raw, secret).not.toContain(secret)
  })

  it('AC-6.4 (029) toolTrail writes the override action and detail only', async () => {
    const { toolTrail } = await import('../src/coordinator/tool-trail')
    toolTrail(
      { risk: 'publish', name: 'edit_company', input, threadId: 't1', agentId: 'general', note: 'Aprobado por vos' },
      'ok',
      'tool.run',
      { action: 'company.edit', detail: { companyId: 'empresa-1', positions: 2 } }
    )
    const [entry] = entries()
    expect(entry).toMatchObject({ action: 'company.edit', actor: 'agent', target: 'edit_company', outcome: 'ok', detail: { companyId: 'empresa-1', positions: 2 } })
    expect(Object.keys(entry['detail'] as object).sort()).toEqual(['companyId', 'positions'])
  })
})

describe('create_company: validation before any card (spec 029 T22)', () => {
  const VAULT = 'C:\\Users\\x\\Documents\\Alma\\Empresas\\Acme'
  const tool = (): ToolDefinition => companyTools.companyAuthoringTools.find((t) => t.name === 'create_company')!
  const position = (key: string, reportsTo: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    key, title: key.toUpperCase(), reportsTo, description: 'does things', instructions: 'be useful', tools: ['read_file'], canDelegate: false, ...extra
  })
  type Input = { positions: Record<string, unknown>[] } & Record<string, unknown>
  const valid = (): Input => ({
    name: 'Acme',
    mission: 'sell',
    goals: 'grow',
    vault: VAULT,
    positions: [position('ceo', null, { canDelegate: true }), position('dev', 'ceo', { tools: ['read_file', 'run_command'], autoApproveTools: ['run_command'] })]
  })

  /** Calls create_company once, answers the card as asked and reports what the model read and what existed when the card appeared. */
  async function call(input: unknown, answer: 'allow' | 'deny' = 'deny', whileCardWaits?: () => void) {
    events = []
    thread.messages.length = 0
    thread.toolStates = {}
    authoring.calls.create = 0 // every call here is a run of its own
    const cards: Extract<LiveEvent, { type: 'approval.request' }>[] = []
    const atCard: { saved: unknown[]; inited: string[] }[] = []
    const original = events.push.bind(events)
    events.push = (...items: LiveEvent[]) => {
      for (const item of items) {
        if (item.type !== 'approval.request') continue
        cards.push(item)
        atCard.push({ saved: [...authoring.saved], inited: [...authoring.inited] })
        queueMicrotask(() => {
          whileCardWaits?.()
          broker.respond(item.approval.approvalId, answer, 'desktop')
        })
      }
      return original(...items)
    }
    let result: Extract<Block, { type: 'tool_result' }> | undefined
    script = (request) => {
      if (lastToolResults(request).length === 0) return turn([toolUse('c1', 'create_company', input)])
      result = lastToolResults(request)[0]
      return turn([text('ok')])
    }
    thread.messages.push({ role: 'user', content: [text('creá una empresa')], ts: 0 })
    await runAgent(settings.agents.find((a) => a.id === 'general')!, thread.messages, context())
    return { result: result!, cards, atCard }
  }
  const untouched = (): void => {
    expect(authoring.saved).toEqual([])
    expect(authoring.inited).toEqual([])
  }

  it('AC-5.1 (029) invalid creation is rejected before any card', async () => {
    const withCompany = (name: string, vault: string): Company => ({ ...(seat() as { company: Company }).company, id: 'other', name, vault })
    const cases: [string, (i: Input) => void, string][] = [
      ['a boss that is not a position', (i) => void (i.positions[1].reportsTo = 'nobody'), 'reports to a key that is not a position'],
      ['a reporting loop', (i) => void i.positions.push(position('a', 'b'), position('b', 'a')), 'would report, directly or not, to itself'],
      ['an unknown tool', (i) => void (i.positions[1].tools = ['mcp__x__y']), 'does not exist: mcp__x__y'],
      ['an auto-approved tool that is unknown', (i) => void (i.positions[1].autoApproveTools = ['create_company']), 'does not exist: create_company'],
      ['nine positions', (i) => void i.positions.push(...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((key) => position(key, 'ceo'))), 'more than 8 positions'],
      ['a vault outside Empresas', (i) => void (i.vault = 'C:\\Users\\x\\Documents\\Alma\\Vault'), 'directly under the Empresas folder'],
      ['a vault with dot segments', (i) => void (i.vault = `${VAULT}\\..\\..\\Vault`), 'must not contain'],
      ['no head', (i) => void (i.positions[0].reportsTo = 'dev'), 'report to the board'],
      ['a budget above the ceiling', (i) => void (i.budgetUsd = 100.5), 'budget must be above 0'],
      ['a budget of zero', (i) => void (i.positions[0].budgetUsd = 0), 'budget must be above 0'],
      ['an empty name', (i) => void (i.name = '  '), 'name is empty'],
      ['a name that is taken', (i) => void (i.name = ' acme '), 'already exists']
    ]
    // a control: the same input, valid, reaches the card
    expect((await call(valid(), 'deny')).cards).toHaveLength(1)
    for (const [label, change, message] of cases) {
      const input = valid()
      settings.companies = label === 'a name that is taken' ? [withCompany('Acme', 'C:\\x\\Empresas\\Other')] : []
      change(input)
      const { result, cards } = await call(input)
      expect(result, label).toMatchObject({ is_error: true, content: expect.stringContaining(message) })
      expect(cards, label).toEqual([])
      expect(thread.toolStates.c1.status, label).toBe('error')
      untouched()
    }
  })

  it('AC-5.1 (029) a vault that is occupied or in use by another company fails; the disk is asked only about a folder the rules accept', async () => {
    settings.companies = [{ ...(seat() as { company: Company }).company, id: 'other', name: 'Other', vault: VAULT.toUpperCase() }]
    const probed = vi.fn(async () => true)
    authoring.folderHasFiles = probed
    let { result, cards } = await call(valid())
    expect(result).toMatchObject({ is_error: true, content: expect.stringContaining('already in use') })
    expect(cards).toEqual([])
    expect(probed).not.toHaveBeenCalled()

    settings.companies = []
    ;({ result, cards } = await call(valid()))
    expect(result).toMatchObject({ is_error: true, content: expect.stringContaining('has files in it') })
    expect(cards).toEqual([])
    expect(probed).toHaveBeenCalledOnce()

    probed.mockClear()
    await call({ ...valid(), vault: 'C:\\Windows\\System32' })
    expect(probed).not.toHaveBeenCalled()
    untouched()
  })

  it('AC-5.1 (029) a malformed field fails the schema with no card', async () => {
    for (const bad of [{ ...valid(), name: 5 }, { ...valid(), positions: 'ceo' }, { ...valid(), positions: [{ ...position('ceo', null), canDelegate: 'yes' }] }, { name: 'x' }]) {
      const { result, cards } = await call(bad)
      expect(result).toMatchObject({ is_error: true, content: expect.stringContaining('INVALID_JSON') })
      expect(cards).toEqual([])
    }
    untouched()
  })

  it('AC-4.1 (029) no deletion path exists', async () => {
    const schema = tool().schema
    expect(schema.safeParse(valid()).success).toBe(true)
    for (const key of ['delete', 'remove_company', 'trash', 'deleteCompany', 'provider', 'model', 'effort']) {
      expect(schema.safeParse({ ...valid(), [key]: true }).success, key).toBe(false)
      const input = valid()
      input.positions[0][key] = 'x'
      expect(schema.safeParse(input).success, `position ${key}`).toBe(false)
    }
    // the tools Alma is offered for companies are the two, and none of them is a deletion
    const names = (await offered('general')).filter((name) => /compan/.test(name))
    expect(names.sort()).toEqual(['create_company'])
  })

  it('AC-2.1 (029) nothing exists until the answer', async () => {
    const { result, cards, atCard } = await call(valid(), 'deny')
    expect(cards).toHaveLength(1)
    expect(cards[0].approval).toMatchObject({
      toolName: 'create_company',
      allowAlways: false,
      preview: {
        company: {
          kind: 'create',
          company: 'Acme',
          vault: VAULT,
          budgetUsd: 20,
          positions: [
            { title: 'CEO', boss: null, instructions: 'be useful', runsCommandsUnasked: false },
            { title: 'DEV', boss: 'CEO', tools: ['read_file', 'run_command'], autoApprove: ['run_command'], runsCommandsUnasked: true }
          ]
        }
      }
    })
    expect(atCard).toEqual([{ saved: [], inited: [] }])
    expect(result).toMatchObject({ is_error: true })
    untouched()
    expect(thread.toolStates.c1.status).toBe('denied')
  })

  it('AC-3.6 (029) an omitted vault is the default path under Empresas', async () => {
    const { vault: _omitted, ...input } = valid()
    const { cards } = await call(input, 'deny')
    expect(cards[0].approval.preview?.company).toMatchObject({ vault: 'C:\\Users\\x\\Documents\\Alma\\Empresas\\Acme', budgetUsd: 20 })
  })

  /** Several create_company calls in one run: one per turn, or all in the first turn. Returns what the model read for each. */
  async function callMany(inputs: unknown[], answer: 'allow' | 'deny', sameTurn = false) {
    events = []
    thread.messages.length = 0
    thread.toolStates = {}
    authoring.calls.create = 0 // every call here is a run of its own
    const original = events.push.bind(events)
    events.push = (...items: LiveEvent[]) => {
      for (const item of items) if (item.type === 'approval.request') queueMicrotask(() => broker.respond(item.approval.approvalId, answer, 'desktop'))
      return original(...items)
    }
    const results: Extract<Block, { type: 'tool_result' }>[] = []
    let turns = 0
    script = (request) => {
      results.push(...lastToolResults(request))
      const next = sameTurn ? (turns === 0 ? inputs : []) : inputs.slice(turns, turns + 1)
      turns++
      return next.length ? turn(next.map((input, i) => toolUse(`c${turns}-${i}`, 'create_company', input))) : turn([text('ok')])
    }
    thread.messages.push({ role: 'user', content: [text('creá una empresa')], ts: 0 })
    await runAgent(settings.agents.find((a) => a.id === 'general')!, thread.messages, context())
    return { results, cards: events.filter((e) => e.type === 'approval.request') }
  }
  const named = (name: string, vault: string): Input => ({ ...valid(), name, vault: `C:\\Users\\x\\Documents\\Alma\\Empresas\\${vault}` })

  it('AC-5.9 (029) one creation per run and ten companies at most', async () => {
    // the second call of a run fails with no card, whether the first was allowed ...
    let { results, cards } = await callMany([named('A', 'A'), named('B', 'B')], 'allow')
    expect(results[0].is_error).toBeUndefined()
    expect(results[1]).toMatchObject({ is_error: true, content: expect.stringContaining('one company') })
    expect(cards).toHaveLength(1)
    expect(authoring.saved).toHaveLength(1)

    // ... or denied (the literal reading, plan G-5)
    authoring.saved.length = 0
    ;({ results, cards } = await callMany([named('A', 'A'), named('B', 'B')], 'deny'))
    expect(results[1]).toMatchObject({ is_error: true, content: expect.stringContaining('one company') })
    expect(cards).toHaveLength(1)

    // ... or in the same turn as the first
    authoring.saved.length = 0
    ;({ results, cards } = await callMany([named('A', 'A'), named('B', 'B')], 'allow', true))
    expect(results.filter((result) => result.is_error)).toHaveLength(1)
    expect(cards).toHaveLength(1)

    // a call refused by validation (no card, nothing created) does not use the run: the model fixes it and calls again
    authoring.saved.length = 0
    ;({ results, cards } = await callMany([{ ...named('A', 'A'), name: '' }, named('B', 'B')], 'allow'))
    expect(results[0]).toMatchObject({ is_error: true, content: expect.stringContaining('name is empty') })
    expect(results[1].is_error).toBeUndefined()
    expect(cards).toHaveLength(1)
    expect(authoring.saved).toHaveLength(1)

    // ... however many times it is refused, and the corrected one still gets exactly one card
    authoring.saved.length = 0
    ;({ results, cards } = await callMany([{ ...named('A', 'A'), name: '' }, { ...named('A', 'A'), budgetUsd: 500 }, named('B', 'B'), named('C', 'C')], 'allow'))
    expect(results.map((result) => result.is_error === true)).toEqual([true, true, false, true])
    expect(results[3]).toMatchObject({ content: expect.stringContaining('one company') })
    expect(cards).toHaveLength(1)
    expect(authoring.saved).toHaveLength(1)

    // ... in the same turn too: the refused call does not take the place of the valid one
    authoring.saved.length = 0
    ;({ results, cards } = await callMany([{ ...named('A', 'A'), name: '' }, named('B', 'B')], 'allow', true))
    expect(results.map((result) => result.is_error === true)).toEqual([true, false])
    expect(cards).toHaveLength(1)

    // once a card was shown the run is spent, even if the person denied it
    ;({ results, cards } = await callMany([{ ...named('A', 'A'), name: '' }, named('B', 'B'), named('C', 'C')], 'deny'))
    expect(results.map((result) => result.is_error === true)).toEqual([true, true, true])
    expect(results[2]).toMatchObject({ content: expect.stringContaining('one company') })
    expect(cards).toHaveLength(1)

    // a new run has a fresh counter
    authoring.saved.length = 0
    ;({ results } = await callMany([named('C', 'C')], 'allow'))
    expect(results[0].is_error).toBeUndefined()
    expect(authoring.saved).toHaveLength(1)

    // ten companies already: no card
    settings.companies = Array.from({ length: 10 }, (_, i) => ({ ...(seat() as { company: Company }).company, id: `c${i}`, name: `C${i}`, vault: `C:\\x\\Empresas\\C${i}` }))
    ;({ results, cards } = await callMany([named('Eleven', 'Eleven')], 'allow'))
    expect(results[0]).toMatchObject({ is_error: true, content: expect.stringContaining('already 10 companies') })
    expect(cards).toEqual([])
  })

  /** Records the order in which the shell is used. */
  function ordered(): string[] {
    const order: string[] = []
    const { initVault, save } = authoring
    authoring.initVault = async (path) => {
      order.push('initVault')
      return initVault(path)
    }
    authoring.save = (change) => {
      order.push('save')
      return save(change)
    }
    return order
  }
  type Saved = { companies: Company[]; agents: { id: string; companyId?: string; tools: string[]; autoApproveTools?: string[]; canDelegate: boolean; allowMcp: boolean }[]; vaults: string[] }

  it('AC-3.1 (029) approval initialises the vault then saves company, agents and vault list', async () => {
    const order = ordered()
    const other: Company = { ...(seat() as { company: Company }).company, id: 'other', name: 'Other', vault: 'C:\\x\\Empresas\\Other' }
    settings.companies = [other]
    settings.vaults = ['C:\\x\\Vault', VAULT]
    const { result, cards } = await call(valid(), 'allow')
    expect(result.is_error).toBeUndefined()
    expect(cards).toHaveLength(1)
    expect(order).toEqual(['initVault', 'save'])
    expect(authoring.inited).toEqual([VAULT])
    const [saved] = authoring.saved as Saved[]
    expect(saved.companies).toHaveLength(2)
    expect(saved.companies[0]).toBe(other)
    const company = saved.companies[1]
    expect(company).toMatchObject({ name: 'Acme', mission: 'sell', goals: 'grow', vault: VAULT, budgetUsd: 20, whatsapp: false, email: { address: '' } })
    expect(company.members.map((m) => m.title)).toEqual(['CEO', 'DEV'])
    // the reports are wired by member id, and the head reports to the board
    expect(company.members[0].reportsTo).toBeNull()
    expect(company.members[1].reportsTo).toBe(company.members[0].id)
    // one agent per position, the existing ones kept, each in the company
    const created = saved.agents.slice(settings.agents.length)
    expect(saved.agents.slice(0, settings.agents.length)).toEqual(settings.agents)
    expect(created.map((a) => a.id)).toEqual(company.members.map((m) => m.id))
    expect(created.every((a) => a.companyId === company.id)).toBe(true)
    // the vault list has no duplicates
    expect(saved.vaults).toEqual(['C:\\x\\Vault', VAULT])
  })

  it('AC-3.2 (029) the result carries name, id, member ids and vault only', async () => {
    const { result } = await call(valid(), 'allow')
    const company = (authoring.saved as Saved[])[0].companies[0]
    expect(result.content).toBe(`Company “Acme” created (id ${company.id}).\nVault: ${VAULT}\nPositions:\n- CEO (${company.members[0].id})\n- DEV (${company.members[1].id})`)
    expect(result.content).not.toContain('be useful')
    expect(result.content).not.toContain('run_command')
    expect(result.i18n).toMatchObject({ key: 'tool.company.created', params: { name: 'Acme', id: company.id, vault: VAULT } })
    expect(thread.toolStates.c1.status).toBe('done')
  })

  it('AC-3.5 (029) the saved change is only companies, agents and vaults', async () => {
    await call(valid(), 'allow')
    expect(authoring.saved).toHaveLength(1)
    expect(Object.keys(authoring.saved[0] as object).sort()).toEqual(['agents', 'companies', 'vaults'])
  })

  it('AC-6.1 (029) what is saved is what the proposal showed', async () => {
    const input = valid()
    input.budgetUsd = 55
    input.positions[1].allowMcp = true
    input.positions[1].budgetUsd = 7.5
    const { cards } = await call(input, 'allow')
    const shown = cards[0].approval.preview!.company!
    const [saved] = authoring.saved as Saved[]
    const company = saved.companies[0]
    expect(company).toMatchObject({ name: shown.company, vault: shown.vault, budgetUsd: shown.budgetUsd })
    shown.positions.forEach((row, i) => {
      const agent = saved.agents.find((a) => a.id === company.members[i].id)!
      expect(company.members[i]).toMatchObject({ title: row.title })
      expect(agent.tools).toEqual(row.tools)
      expect(agent.autoApproveTools ?? []).toEqual(row.autoApprove)
      expect(agent.canDelegate).toBe(row.canDelegate)
      expect(agent.allowMcp).toBe(row.allowMcp)
    })
    expect(company.members[1].budgetUsd).toBe(7.5)
    expect(shown.positions[1].allowMcp).toBe(true)
    // the model's input was not changed between the card and the write
    expect(input).toEqual({ ...valid(), budgetUsd: 55, positions: [valid().positions[0], { ...valid().positions[1], allowMcp: true, budgetUsd: 7.5 }] })
  })

  it('AC-5.2 (029) a vault that cannot be initialised saves nothing', async () => {
    authoring.initVault = async () => {
      throw new Error('EPERM: operation not permitted')
    }
    const { result } = await call(valid(), 'allow')
    expect(result).toMatchObject({ is_error: true, content: expect.stringContaining('EPERM: operation not permitted') })
    expect(result.content).toContain('nothing was created')
    expect(authoring.saved).toEqual([])
    expect(thread.toolStates.c1.status).toBe('error')
  })

  it('AC-5.2 (029) what changed while the card waited is checked again before anything is written', async () => {
    const taken = { ...(seat() as { company: Company }).company, id: 'late', name: 'ACME', vault: 'C:\\x\\Empresas\\Late' }
    let { result } = await call(valid(), 'allow', () => void (settings.companies = [taken]))
    expect(result).toMatchObject({ is_error: true, content: expect.stringContaining('already exists') })
    // the card was shown, so the run is spent and the text says so instead of inviting a retry
    expect(result.content).toContain('run is spent')
    untouched()

    // ten companies appeared meanwhile
    settings.companies = []
    ;({ result } = await call(valid(), 'allow', () => void (settings.companies = Array.from({ length: 10 }, (_, i) => ({ ...taken, id: `c${i}`, name: `C${i}`, vault: `C:\\x\\Empresas\\C${i}` })))))
    expect(result).toMatchObject({ is_error: true, content: expect.stringContaining('already 10 companies') })
    untouched()

    // the folder was filled meanwhile
    settings.companies = []
    ;({ result } = await call(valid(), 'allow', () => void (authoring.folderHasFiles = async () => true)))
    expect(result).toMatchObject({ is_error: true, content: expect.stringContaining('has files in it') })
    untouched()
  })

  it('AC-6.4 (029) the real tool audits the company id and the count, never what the person wrote', async () => {
    const needle = ['Zafiro-Corp', 'MISSION-needle', 'INSTRUCTIONS-needle']
    const input = valid()
    Object.assign(input, { name: needle[0], mission: needle[1], vault: 'C:\\Users\\x\\Documents\\Alma\\Empresas\\Zafiro-Corp' })
    input.positions[0].instructions = needle[2]
    await call(input, 'allow')
    const file = join(dataDir, 'audit', `coordinator-${new Date().toISOString().slice(0, 7)}.jsonl`)
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry['target'] === 'create_company')
    const company = (authoring.saved as Saved[])[0].companies[0]
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ action: 'company.create', outcome: 'ok', detail: { companyId: company.id, positions: 2, via: 'desktop' } })
    for (const word of needle) expect(lines.join('\n'), word).not.toContain(word)
  })

  it('AC-7.1 (029) every issue code reads in both languages', () => {
    for (const issue of [
      { code: 'name.empty' }, { code: 'name.long' }, { code: 'name.taken' }, { code: 'color.unknown' }, { code: 'mission.long' }, { code: 'goals.long' },
      { code: 'budget.range', scope: 'company', max: 100 }, { code: 'companies.full', max: 10 }, { code: 'positions.none' }, { code: 'positions.many', max: 8 }, { code: 'key.empty' },
      { code: 'org.noHead' }, { code: 'org.manyHeads' }, { code: 'org.loop', at: 'a' }, { code: 'org.deep', at: 'a' }, { code: 'org.unknownBoss', at: 'a' }, { code: 'org.duplicateKey', at: 'a' },
      { code: 'brief.long', at: 'a', max: 2000 }, { code: 'tool.unknown', at: 'a', tool: 't' },
      { code: 'vault.outside' }, { code: 'vault.chars' }, { code: 'vault.notEmpty' }, { code: 'vault.reserved' }, { code: 'vault.dots' }
    ] as const) {
      const shown = companyTools.issueText(issue)
      for (const language of ['es', 'en'] as const) {
        const line = translateText(language, shown)
        expect(line, `${issue.code} ${language}`).not.toMatch(/^tool\.company|\{\w+\}/)
      }
    }
  })
})

describe('create_company: creations approved close together (spec 029 AC-3.1)', () => {
  it('both persist: the save is applied to the live settings, not to the snapshot the run started with', async () => {
    let live = defaultSettings()
    const stale = live
    const gates: (() => void)[] = []
    const host = (): CompanyAuthoringHost => ({
      defaultVaultPath: 'C:\\Users\\x\\Documents\\Alma\\Vault',
      folderHasFiles: async () => false,
      initVault: () => new Promise<void>((resolve) => void gates.push(resolve)),
      save: (update) => {
        live = { ...live, ...update(live) }
      },
      calls: { create: 0 }
    })
    const tool = companyTools.companyAuthoringTools[0]
    const run = (name: string) => {
      const input = tool.schema.parse({ name, positions: [{ key: 'ceo', title: 'CEO', reportsTo: null, description: 'd', instructions: 'i', tools: ['read_file'], canDelegate: false }] })
      // Both runs hold the same old snapshot, as two runs that started before either was saved would.
      return tool.run(input, { workspace: '', signal: new AbortController().signal, settings: stale, host: { request: async () => ({ ok: true, message: '' }) }, authoring: host(), language: 'en' })
    }
    const first = run('Alfa')
    const second = run('Beta')
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    gates[1]()
    gates[0]()
    await Promise.all([first, second])
    expect(live.companies.map((company) => company.name).sort()).toEqual(['Alfa', 'Beta'])
    expect(live.agents).toHaveLength(stale.agents.length + 2)
    expect(live.vaults).toEqual(expect.arrayContaining([live.companies[0].vault, live.companies[1].vault]))
  })
})

describe('the company tool names (spec 029)', () => {
  it('AC-2.12 (029) the approval rule knows every offered tool and the only name it holds ahead is edit_company', async () => {
    const { COMPANY_AUTHORING_TOOLS } = await import('../src/shared/companyAuthoring')
    const offeredNames = companyTools.companyAuthoringTools.map((tool) => tool.name)
    const known: readonly string[] = COMPANY_AUTHORING_TOOLS
    for (const name of offeredNames) expect(known, name).toContain(name)
    // WITHHELD (G-1): its approval rule is ready before the tool exists.
    expect(known.filter((name) => !offeredNames.includes(name))).toEqual(['edit_company'])
  })
})
