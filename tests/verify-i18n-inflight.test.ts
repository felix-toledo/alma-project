// Independent verification of spec 025: in-flight language change (AC-1.8) and the reply-language rule (AC-5.1, AC-5.3).
import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as z from 'zod/v4'
import type { Provider, TurnRequest, TurnResult } from '../src/coordinator/providers/types'
import { defineTool } from '../src/coordinator/tools/types'
import { defaultSettings } from '../src/shared/defaults'
import type { AgentProfile, Language, Settings, Thread } from '../src/shared/types'

let requests: TurnRequest[] = []
let turns: TurnResult[] = []
let beforeTurn: (index: number) => void = () => {}
let index = 0
const fakeProvider: Provider = {
  id: 'anthropic',
  streamTurn: async (request) => {
    requests.push(request)
    beforeTurn(index++)
    const next = turns.shift()
    if (!next) throw new Error('script ran out of turns')
    return next
  },
  review: async () => ({ verdict: 'allow', reason: 'ok' }),
  listModels: async () => []
}
vi.mock('../src/coordinator/providers', () => ({ getProvider: () => fakeProvider }))
vi.mock('electron', () => ({ app: { getPath: () => '' }, safeStorage: { isEncryptionAvailable: () => false } }))

const { runAgent } = await import('../src/coordinator/agent')
const { ApprovalBroker } = await import('../src/coordinator/approval')
const { McpManager } = await import('../src/coordinator/mcp')
const { builtinToolsByName } = await import('../src/coordinator/tools')

const call = (id: string, name: string, input: unknown): TurnResult => ({ content: [{ type: 'tool_use', id, name, input }], stopReason: 'tool_use', model: 'fake' })
const done: TurnResult = { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', model: 'fake' }

let live: Settings
const events: { type: string; toolUseId?: string; state?: { note?: string } }[] = []

const thread = (): Thread => ({ id: 't', title: 'x', agentId: 'p', workspace: '', createdAt: 0, updatedAt: 0, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], ts: 0 }], subagents: {}, toolStates: {} })
const context = (t: Thread, language: Language, extra: Record<string, unknown> = {}) => ({
  getSettings: () => live,
  language,
  thread: t,
  scope: { threadId: t.id },
  signal: new AbortController().signal,
  depth: 0,
  approvals: new ApprovalBroker(() => {}),
  mcp: new McpManager(() => {}),
  host: { request: async () => ({ ok: true, message: '' }) },
  emit: (e: never) => void events.push(e),
  persist: () => {},
  rememberAlwaysAllow: () => {},
  knowledge: null,
  saveRoutines: () => {},
  sendTelegram: async () => false,
  whatsapp: null,
  ...extra
})
const profile = (id: string, extra: Partial<AgentProfile> = {}): AgentProfile => ({ ...live.agents[0], id, tools: ['probe'], canDelegate: false, companyId: undefined, ...extra })

beforeEach(() => {
  live = { ...defaultSettings(), language: 'es' }
  requests = []
  turns = []
  index = 0
  beforeTurn = () => {}
  events.length = 0
  builtinToolsByName.set('probe', defineTool({ name: 'probe', description: 'x', risk: 'read', standalone: true, schema: z.object({}), run: async () => 'ok' }))
})

describe('AC-1.8 a run finishes in the language it started in', () => {
  it('AC-1.8 the notes the run writes on its tool cards stay in the language the run started with', async () => {
    const t = thread()
    turns = [call('a', 'probe', {}), call('b', 'probe', {}), done]
    beforeTurn = (i) => {
      if (i === 1) live = { ...live, language: 'en' }
    }
    await runAgent(profile('p'), t.messages, context(t, 'es'))
    const notes = events.filter((e) => e.type === 'tool.state' && e.state?.note).map((e) => `${e.toolUseId}:${e.state!.note}`)
    // Both calls belong to a run that started in es, so both notes are Spanish.
    const b = notes.filter((n) => n.startsWith('b:'))
    expect(b.length).toBeGreaterThan(0)
    for (const n of b) expect(n).toBe(`${n.split(':')[0]}:Solo lectura`)
  })

  it('AC-1.8 the next run uses the new language for those notes', async () => {
    const t = thread()
    live = { ...live, language: 'en' }
    turns = [call('a', 'probe', {}), done]
    await runAgent(profile('p'), t.messages, context(t, 'en'))
    const notes = events.filter((e) => e.type === 'tool.state' && e.state?.note).map((e) => e.state!.note!)
    expect(notes.length).toBeGreaterThan(0)
    expect(notes.join(' ')).not.toMatch(/[áéíóúñ]/i)
  })
})

describe('AC-5.1 and AC-5.3 reply-language rule across run kinds', () => {
  const RULE = 'Answer in the language the person speaks to you in.'

  it('AC-5.3 a subagent of an unattended run keeps the fallback, a subagent of an attended run does not get one', async () => {
    live = { ...live, agents: [profile('p', { canDelegate: true, tools: [] }), profile('c')] }
    const systems = async (unattended: boolean, language: Language): Promise<string[]> => {
      requests = []
      index = 0
      turns = [call('d', 'delegate_task', { agent: 'c', title: 't', task: 'x' }), done, done]
      const t = thread()
      await runAgent(live.agents[0], t.messages, context(t, language, { unattended }))
      return requests.map((r) => r.system)
    }
    for (const language of ['es', 'en'] as const) {
      const attended = await systems(false, language)
      expect(attended.length).toBeGreaterThanOrEqual(2)
      for (const s of attended) {
        expect(s).toContain(RULE)
        expect(s).not.toContain('Nobody is writing')
      }
      const unattended = await systems(true, language)
      const name = language === 'es' ? 'Spanish' : 'English'
      for (const s of unattended) expect(s).toContain(`write in ${name} (the language set in the app)`)
    }
  })

  it('AC-5.1 a channel (telegram, whatsapp, voice) and a company turn add no language directive of their own', async () => {
    for (const channel of ['telegram', 'whatsapp', 'voice'] as const) {
      for (const language of ['es', 'en'] as const) {
        requests = []
        index = 0
        turns = [done]
        const t = { ...thread(), channel } as Thread
        await runAgent(profile('p'), t.messages, context(t, language))
        const system = requests[0].system
        expect(system, `${channel}/${language}`).toContain(RULE)
        // the only mention of a language name may be the fallback, and an attended turn has none
        expect(system, `${channel}/${language}`).not.toMatch(/\b(in|into) (Spanish|English)\b/i)
        expect(system, `${channel}/${language}`).not.toMatch(/Rioplatense|español|inglés/i)
      }
    }
  })

  it('AC-5.1 the system prompt of an attended run is identical under es and en (no per-language directive)', async () => {
    const out: string[] = []
    for (const language of ['es', 'en'] as const) {
      requests = []
      index = 0
      turns = [done]
      live = { ...defaultSettings('es'), language }
      const t = thread()
      // same profile for both, so only the language could make a difference
      await runAgent({ ...profile('p'), systemPrompt: 'X' }, t.messages, context(t, language))
      out.push(requests[0].system.replace(/Local date and time:.*$/m, ''))
    }
    expect(out[0]).toBe(out[1])
  })
})
