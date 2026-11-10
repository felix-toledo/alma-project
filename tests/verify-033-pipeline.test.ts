import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type DreamDeps, type DreamResult, runDream } from '../src/coordinator/dream/runner'
import { DreamService, type DreamServiceDeps } from '../src/coordinator/dream/service'
import { KnowledgeBase } from '../src/coordinator/knowledge/base'
import { EMBEDDING_DIMS } from '../src/coordinator/knowledge/db'
import { PresenceService } from '../src/coordinator/presence'
import { greetingSystem } from '../src/coordinator/prompts/dream'
import type { Provider, TurnRequest, TurnResult } from '../src/coordinator/providers/types'
import { defaultSettings } from '../src/shared/defaults'
import type { ReadableThread } from '../src/shared/dream/input'
import type { EconomyRow } from '../src/shared/dream/model'
import type { BatchOutput } from '../src/shared/dream/output'
import type { ChatMessage, Settings } from '../src/shared/types'

// Adversarial verification of spec 033 (pipeline and service). Written from spec.md only.

let dirs: string[] = []
let bases: KnowledgeBase[] = []
afterEach(async () => {
  await Promise.all(bases.map((b) => b.close()))
  bases = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const START = new Date(2026, 10, 10, 3, 0, 0).getTime()
const ROW: EconomyRow = { provider: 'anthropic', model: 'eco-test', input: 1, output: 5, cacheRead: 0.1, checked: '2026-11-09' }

/** Bag-of-words embedder, so recall has vectors to rank with. */
const embedder = {
  modelId: 'fake',
  state: () => ({ state: 'ready' as const }),
  async embed(texts: string[]) {
    return texts.map((text) => {
      const v = new Float32Array(EMBEDDING_DIMS)
      for (const word of text.toLowerCase().match(/[\p{L}]{3,}/gu) ?? []) {
        let h = 0
        for (const c of word) h = (h * 31 + c.charCodeAt(0)) % EMBEDDING_DIMS
        v[h] += 1
      }
      const norm = Math.hypot(...v) || 1
      return v.map((x) => x / norm)
    })
  }
}

async function vault(files: Record<string, string> = {}) {
  const root = temp('alma-verify-vault-')
  const data = temp('alma-verify-kb-')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const kb = new KnowledgeBase({ root, dataDir: data, embedder, trash: async () => {}, onStatus: () => {}, onChanged: () => {}, language: () => 'es' })
  bases.push(kb)
  const read = (path: string): string => readFileSync(join(root, ...path.split('/')), 'utf8')
  const journals = (): string[] => (existsSync(join(root, 'Alma', 'Sueños')) ? readdirSync(join(root, 'Alma', 'Sueños')) : [])
  return { kb, root, read, journals }
}

const user = (ts: number, text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }], ts })
const thread = (id: string, messages: ChatMessage[]): ReadableThread => ({ id, title: `Charla ${id}`, agentId: 'general', messages })
const batch = (part: Partial<BatchOutput>): BatchOutput => ({ add: [], replace: [], remove: [], speculative: [], ...part })
const reply = (value: unknown, usage = { inputTokens: 1000, outputTokens: 100 }): TurnResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], stopReason: 'end_turn', usage, model: ROW.model })
const isGreeting = (r: TurnRequest): boolean => r.system === greetingSystem('es') || r.system === greetingSystem('en')

function deps(part: Partial<DreamDeps> & Pick<DreamDeps, 'knowledge' | 'provider' | 'threads'>): DreamDeps {
  return { startedAt: START, language: 'es', agents: [{ id: 'general' }], cursors: {}, row: ROW, capUsd: 0.25, spentUsd: 0, audit: () => {}, signal: new AbortController().signal, ...part }
}

const memory = '# Recuerdos\n\n- Toma café\n- Vive en Asunción\n'
const ts = START - 3_600_000
const oneThread = () => [thread('t1', [user(ts, 'Me mudé a Encarnación y dejé el café')])]
const changes = batch({
  add: [{ text: 'Toma mate', why: 'lo dijo', sources: [{ thread: 't1', ts }] }],
  replace: [{ old: 'Vive en Asunción', text: 'Vive en Encarnación', why: 'se mudó', sources: [{ thread: 't1', ts }] }],
  remove: [{ old: 'Toma café', why: 'lo dejó', sources: [{ thread: 't1', ts }] }]
})

describe('verify 033 cost cap', { timeout: 30_000 }, () => {
  it('verify 033 AC-4.3 BR-9 the night never ends above the cap, even when a call answers longer than the estimate', async () => {
    const { kb } = await vault({ 'Alma/Recuerdos.md': memory })
    // The request carries no output limit, so a model may answer far past the 4000 output tokens the estimate assumes.
    const provider: Pick<Provider, 'streamTurn'> = {
      streamTurn: async (r) => (isGreeting(r) ? reply({ greeting: 'Buen día' }) : reply(changes, { inputTokens: 1000, outputTokens: 30_000 }))
    }
    const result = await runDream(deps({ knowledge: kb, provider, threads: oneThread(), capUsd: 0.05 }))
    expect(result.outcome === 'skipped' ? 0 : result.spentUsd).toBeLessThanOrEqual(0.05)
  })

  it('verify 033 AC-4.3 AC-7.11 BR-26 the greeting reserve: a cap that fits the batch plus the reserve still greets, and never crosses', async () => {
    // A probe run measures the batch call the dream makes.
    const probe = await vault({ 'Alma/Recuerdos.md': memory })
    let batchChars = 0
    let greetingChars = 0
    const measuring: Pick<Provider, 'streamTurn'> = {
      streamTurn: async (r) => {
        const chars = r.system.length + r.messages.flatMap((m) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : []))).join('').length
        if (isGreeting(r)) greetingChars = chars
        else batchChars = chars
        return isGreeting(r) ? reply({ greeting: 'Buen día' }) : reply(changes)
      }
    }
    await runDream(deps({ knowledge: probe.kb, provider: measuring, threads: oneThread(), capUsd: 5 }))
    const usd = (chars: number, out: number) => (Math.ceil(chars / 4) * ROW.input + out * ROW.output) / 1e6
    const batchUsd = usd(batchChars, 4000)
    const reserveUsd = usd(greetingSystem('es').length + 12_000, 600)
    expect(usd(greetingChars, 600)).toBeLessThanOrEqual(reserveUsd)

    // The provider reports exactly what was estimated.
    const exact: Pick<Provider, 'streamTurn'> = {
      streamTurn: async (r) => {
        const chars = r.system.length + r.messages.flatMap((m) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : []))).join('').length
        return isGreeting(r) ? reply({ greeting: 'Buen día' }, { inputTokens: Math.ceil(chars / 4), outputTokens: 600 }) : reply(changes, { inputTokens: Math.ceil(chars / 4), outputTokens: 4000 })
      }
    }
    const cap = Math.ceil((batchUsd + reserveUsd) * 1e9) / 1e9
    const fits = await vault({ 'Alma/Recuerdos.md': memory })
    const ok = await runDream(deps({ knowledge: fits.kb, provider: exact, threads: oneThread(), capUsd: cap }))
    expect(ok).toMatchObject({ outcome: 'ok', greeting: { capped: false } })
    expect(ok.outcome === 'ok' && ok.spentUsd).toBeLessThanOrEqual(cap)

    // A hair less: the batch call is not made, no greeting, nothing read, the night is capped.
    const tight = await vault({ 'Alma/Recuerdos.md': memory })
    const calls: TurnRequest[] = []
    const counting: Pick<Provider, 'streamTurn'> = {
      streamTurn: async (r) => {
        calls.push(r)
        return exact.streamTurn(r)
      }
    }
    const capped = await runDream(deps({ knowledge: tight.kb, provider: counting, threads: oneThread(), capUsd: cap - 2e-9 }))
    expect(calls).toHaveLength(0)
    expect(capped).toMatchObject({ outcome: 'capped' })
    expect(capped.outcome === 'capped' && capped.greeting).toBeFalsy()
    expect(await tight.kb.memories()).toEqual(['Toma café', 'Vive en Asunción'])
  })
})

describe('verify 033 all or nothing', { timeout: 30_000 }, () => {
  it('verify 033 AC-4.4 BR-24 a failure on the second batch or on the greeting call applies nothing from the first', async () => {
    const big = 'y'.repeat(50_000)
    const threads = [thread('t1', [user(ts - 10, `${big} uno`)]), thread('t2', [user(ts, `${big} dos`)])]
    const first = batch({ add: [{ text: 'Primer recuerdo', why: 'w', sources: [{ thread: 't1', ts: ts - 10 }] }] })
    for (const failure of ['second-batch', 'greeting'] as const) {
      const { kb, read, journals } = await vault({ 'Alma/Recuerdos.md': memory })
      let batches = 0
      const provider: Pick<Provider, 'streamTurn'> = {
        streamTurn: async (r) => {
          if (isGreeting(r)) return failure === 'greeting' ? reply({ greeting: '' }) : reply({ greeting: 'hola' })
          batches++
          if (batches === 2 && failure === 'second-batch') throw new Error('HTTP 529 overloaded')
          return reply(batches === 1 ? first : batch({}))
        }
      }
      const result = await runDream(deps({ knowledge: kb, provider, threads, capUsd: 5 }))
      expect(batches, failure).toBe(2)
      expect(result, failure).toMatchObject({ outcome: 'failed', reason: 'provider' })
      expect(read('Alma/Recuerdos.md'), failure).toBe(memory)
      expect(journals(), failure).toEqual([])
    }
  })

  it('verify 033 AC-1.4 the switch turned off while the dream writes its result applies nothing', async () => {
    const { kb, read } = await vault({ 'Alma/Recuerdos.md': memory })
    const controller = new AbortController()
    const provider: Pick<Provider, 'streamTurn'> = { streamTurn: async (r) => (isGreeting(r) ? reply({ greeting: 'Buen día' }) : reply(changes)) }
    // The person flips the switch while the journal is being written (the memory writer's turn).
    const knowledge: DreamDeps['knowledge'] = {
      memories: () => kb.memories(),
      writeJournal: (...args) => {
        controller.abort()
        return kb.writeJournal(...args)
      },
      applyDreamChanges: (...args) => kb.applyDreamChanges(...args)
    }
    const result = await runDream(deps({ knowledge, provider, threads: oneThread(), signal: controller.signal }))
    expect(result.outcome).toBe('failed')
    expect(read('Alma/Recuerdos.md')).toBe(memory)
  })
})

describe('verify 033 material and the greeting input', { timeout: 30_000 }, () => {
  it('verify 033 AC-2.5 BR-22 a routine run alone is not a message from the person: no call, skipped', async () => {
    const { kb } = await vault({ 'Alma/Recuerdos.md': memory })
    const calls: TurnRequest[] = []
    const provider: Pick<Provider, 'streamTurn'> = { streamTurn: async (r) => {
        calls.push(r)
        return isGreeting(r) ? reply({ greeting: 'hola' }) : reply(batch({}))
      } }
    // What a routine run leaves: its prompt stored as a user-role message, then the agent's answer. The person wrote nothing.
    const routine: ReadableThread = {
      id: 'r1',
      title: 'Rutina · Resumen del clima',
      agentId: 'general',
      messages: [user(ts, 'Resumí el clima de hoy en Encarnación'), { role: 'assistant', content: [{ type: 'text', text: 'Soleado, 31 °C.' }], ts: ts + 1 }]
    }
    const result = await runDream(deps({ knowledge: kb, provider, threads: [routine] }))
    expect(calls).toHaveLength(0)
    expect(result).toEqual({ outcome: 'skipped' })
  })

  it('verify 033 AC-7.14 the greeting is derived from what was changed: a change skipped at apply is not given to the greeting call', async () => {
    const { kb, root } = await vault({ 'Alma/Recuerdos.md': memory })
    const greetings: string[] = []
    const provider: Pick<Provider, 'streamTurn'> = {
      streamTurn: async (r) => {
        const input = r.messages.flatMap((m) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : []))).join('')
        if (isGreeting(r)) {
          greetings.push(input)
          return reply({ greeting: 'Buen día' })
        }
        // While the dream works, the person edits the line it is about to replace.
        writeFileSync(join(root, 'Alma', 'Recuerdos.md'), '# Recuerdos\n\n- Toma café\n- Vive en Asunción, cerca del río\n')
        return reply(batch({ replace: changes.replace }))
      }
    }
    const result = await runDream(deps({ knowledge: kb, provider, threads: oneThread() }))
    expect(result.outcome).toBe('ok')
    expect(await kb.memories()).toEqual(['Toma café', 'Vive en Asunción, cerca del río'])
    expect(greetings[0]).not.toContain('Vive en Encarnación')
  })
})

describe('verify 033 journal and recall', { timeout: 30_000 }, () => {
  it('verify 033 AC-5.8 BR-5 the journal folder is kept out of recall even when its name on disk differs in case', async () => {
    const note = '# Sueño\n\nTurno con el dentista el martes a las diez.'
    // Windows: a folder the person made as `alma/sueños` is the journal folder (an existing folder wins, case-insensitively).
    const { kb } = await vault({ 'alma/sueños/2026-11-09.md': note, 'Notas/turno.md': note })
    await kb.scan()
    for (let i = 0; i < 200 && kb.status().pending > 0; i++) await new Promise((r) => setTimeout(r, 10))
    const path = await kb.writeJournal('2026-11-10', `${note}\n`, `${note}\n`)
    expect(path.toLowerCase()).toBe('alma/sueños/2026-11-10.md')
    const { fragments } = await kb.recall('¿cuándo es el turno con el dentista?')
    expect(fragments.map((f) => f.path)).toContain('Notas/turno.md')
    expect(fragments.map((f) => f.path.toLowerCase()).filter((p) => p.startsWith('alma/'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The service, over a temp state file and a fake runner.

const at = (day: number, hour: number, minute = 0): Date => new Date(2026, 10, day, hour, minute, 0)
const OK: DreamResult = { outcome: 'ok', spentUsd: 0.01, cursors: { t1: 5 }, greeting: { text: 'Buen día', capped: false } }

function harness(options: { file?: string; now?: Date; answer?: DreamResult | ((d: DreamDeps) => Promise<DreamResult>); deps?: Partial<DreamServiceDeps> } = {}) {
  const world = {
    now: options.now ?? at(10, 3),
    settings: { ...defaultSettings('es'), dream: { enabled: true, capUsd: 0.25 } } as Settings,
    notified: [] as string[],
    pushes: 0,
    telegram: [] as string[],
    created: [] as string[],
    logs: [] as string[],
    runs: 0
  }
  const file = options.file ?? join(temp('alma-verify-dream-'), 'dream-state.json')
  const answer = options.answer ?? OK
  const service = new DreamService({
    file,
    now: () => world.now,
    settings: () => world.settings,
    knowledge: () => ({ memories: async () => [], applyDreamChanges: async () => ({ lines: [], applied: [], skipped: [] }), writeJournal: async () => '' }),
    hasKey: () => true,
    table: [ROW],
    provider: () => ({ streamTurn: async () => { throw new Error('unused') } }),
    online: async () => true,
    threads: () => [],
    run: async (d) => {
      world.runs++
      return typeof answer === 'function' ? answer(d) : answer
    },
    audit: () => {},
    log: (line) => void world.logs.push(line),
    broadcast: () => {},
    notify: (_title, body) => void world.notified.push(body),
    createThread: (_agent, _title, text) => `greeting-${world.created.push(text)}`,
    greetingText: () => 'Buen día',
    telegram: { notify: async (text) => world.telegram.push(text) > 0, append: () => {} },
    push: { notifyGreeting: async () => void world.pushes++ },
    landing: () => {},
    devices: async () => ['phone-1', 'phone-2'],
    ...options.deps
  })
  return { world, file, service }
}
const settle = () => new Promise((r) => setTimeout(r, 20))

describe('verify 033 morning greeting', () => {
  it('verify 033 AC-7.1 AC-7.2 BR-26 an early wake is not used up; the next one delivers once on every channel; never twice, across a restart', async () => {
    const { world, file, service } = harness({ now: at(10, 2, 5) })
    // A message at 02:05 before the night's dream: nothing, and the day is not used up.
    service.personMessage('some-thread', Promise.resolve())
    await settle()
    expect(world.notified).toEqual([])
    await service.check('tick')
    expect(world.created).toEqual(['Buen día'])
    world.now = at(10, 7, 30)
    service.wake()
    await settle()
    expect(world.notified).toEqual(['Buen día'])
    expect(world.pushes).toBe(1)
    expect(world.telegram).toEqual(['Buen día'])
    service.wake()
    service.personMessage('other', Promise.resolve())
    await settle()
    expect(world.notified).toHaveLength(1)
    const again = harness({ file, now: at(10, 18) })
    again.service.wake()
    await settle()
    expect(again.world.notified).toEqual([])
  })

  it('verify 033 AC-7.12 BR-32 a greeting not delivered by 02:00 is dropped, its conversation stays', async () => {
    const { world, service } = harness()
    await service.check('tick')
    world.now = at(11, 2, 0)
    service.wake()
    await settle()
    expect(world.notified).toEqual([])
    expect(world.created).toHaveLength(1)
  })

  it('verify 033 AC-2.2 BR-26 a wake during a catch-up that fails delivers nothing and does not use up the day', async () => {
    let release: (r: DreamResult) => void = () => {}
    let attempt = 0
    const { world, service } = harness({
      now: at(10, 8),
      answer: () => (++attempt === 1 ? new Promise<DreamResult>((r) => (release = r)) : Promise.resolve(OK))
    })
    const running = service.check('start')
    await settle()
    expect(service.canUse()).toBe(true)
    service.wake()
    release({ outcome: 'failed', reason: 'provider', spentUsd: 0.01 })
    await running
    await settle()
    expect(world.notified).toEqual([])
    // The retry (the next opportunity) writes a greeting; the next wake delivers it.
    await service.check('resume')
    service.wake()
    await settle()
    expect(world.notified).toEqual(['Buen día'])
  })

  it('verify 033 AC-1.4 a run aborted by the switch leaves no greeting conversation', async () => {
    let service!: DreamService
    const { world, service: s } = harness({
      answer: async (d) => {
        // The person turns the switch off while the dream is finishing; the pipeline still returns its result.
        world.settings = { ...world.settings, dream: { enabled: false, capUsd: 0.25 } }
        service.settingsChanged()
        expect(d.signal.aborted).toBe(true)
        return OK
      }
    })
    service = s
    await service.check('tick')
    expect(world.created).toEqual([])
  })

  it('verify 033 AC-7.6 AC-8.2 failing channels do not stop the others, are not retried, and log no text', async () => {
    const secret = 'Buen día SECRETO'
    const { world, service } = harness({
      deps: {
        greetingText: () => secret,
        telegram: { notify: async () => { throw new Error(`telegram rejected: ${secret}`) }, append: () => {} },
        push: { notifyGreeting: async () => { throw new Error(`push failed for ${secret}`) } }
      }
    })
    await service.check('tick')
    world.now = at(10, 8)
    service.wake()
    await settle()
    expect(world.notified).toEqual([secret])
    service.wake()
    await settle()
    expect(world.notified).toHaveLength(1)
    expect(world.logs.join('\n')).not.toContain('SECRETO')
  })

  it('verify 033 BR-29 landing: once per surface, only for devices paired at delivery', async () => {
    const { world, service } = harness()
    await service.check('tick')
    world.now = at(10, 8)
    service.wake()
    await settle()
    expect(service.desktopLanding()).toBe('greeting-1')
    service.landingUsed('greeting-1')
    expect(service.desktopLanding()).toBeNull()
    expect(service.phoneLanding('phone-1')).toBe('greeting-1')
    expect(service.phoneLanding('phone-1')).toBeNull()
    expect(service.phoneLanding('phone-2')).toBe('greeting-1')
    expect(service.phoneLanding('phone-3')).toBeNull()
  })

  it('verify 033 AC-7.1 034 BR-12 through a real presence service: an early unlock is not used up, the later one delivers', async () => {
    const { world, service } = harness({ now: at(10, 2, 30) })
    const presence = new PresenceService({ file: join(temp('alma-verify-presence-'), 'presence.json'), now: () => world.now, thresholdMs: 4 * 3_600_000, consumers: () => [service], log: () => {} })
    presence.receive({ kind: 'unlock', absenceMs: 6 * 3_600_000 })
    await settle()
    await service.check('tick')
    world.now = at(10, 9)
    presence.receive({ kind: 'unlock', absenceMs: 5 * 3_600_000 })
    await settle()
    expect(world.notified).toEqual(['Buen día'])
    world.now = at(10, 15)
    presence.receive({ kind: 'unlock', absenceMs: 5 * 3_600_000 })
    await settle()
    expect(world.notified).toHaveLength(1)
  })
})
