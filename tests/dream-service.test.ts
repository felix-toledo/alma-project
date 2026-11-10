import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type DreamDeps, type DreamResult, runDream } from '../src/coordinator/dream/runner'
import { DreamService, type DreamServiceDeps } from '../src/coordinator/dream/service'
import { greetingThreadTitle } from '../src/coordinator/generated'
import { PresenceService } from '../src/coordinator/presence'
import { greetingSystem } from '../src/coordinator/prompts/dream'
import type { TurnRequest, TurnResult } from '../src/coordinator/providers/types'
import { defaultSettings } from '../src/shared/defaults'
import { translate } from '../src/shared/i18n/messages'
import type { EconomyRow } from '../src/shared/dream/model'
import { DREAM_FAILURES } from '../src/shared/dream/schedule'
import type { ReadableThread } from '../src/shared/dream/input'
import type { Settings } from '../src/shared/types'

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'alma-dream-service-'))
  dirs.push(dir)
  return dir
}

const ROW: EconomyRow = { provider: 'anthropic', model: 'eco-test', input: 1, output: 5, cacheRead: 0.1, checked: '2026-11-09' }
const at = (day: number, hour: number, minute = 0): Date => new Date(2026, 10, day, hour, minute, 0)
const OK: DreamResult = { outcome: 'ok', spentUsd: 0.01, cursors: { t1: 5 }, greeting: { text: 'Buen día', capped: false } }

type Answer = DreamResult | ((deps: DreamDeps) => Promise<DreamResult>)

/** A service over a temp state file, a fake clock and a fake runner; `world` records everything it does. */
function harness(options: { file?: string; now?: Date; enabled?: boolean; settings?: Partial<Settings>; answer?: Answer; deps?: Partial<DreamServiceDeps> } = {}) {
  const world = {
    now: options.now ?? at(10, 3),
    settings: { ...defaultSettings('es'), dream: { enabled: options.enabled ?? true, capUsd: 0.25 }, ...options.settings } as Settings,
    answer: options.answer ?? OK,
    runs: [] as DreamDeps[],
    threadReads: 0,
    threads: [] as ReadableThread[]
  }
  const file = options.file ?? join(temp(), 'dream-state.json')
  const deps: DreamServiceDeps = {
    file,
    now: () => world.now,
    settings: () => world.settings,
    knowledge: () => ({ memories: async () => [], applyDreamChanges: async () => ({ lines: [], applied: [], skipped: [] }), writeJournal: async () => '' }),
    hasKey: () => true,
    table: [ROW],
    provider: () => ({ streamTurn: async () => { throw new Error('no provider in this test') } }),
    online: async () => true,
    threads: () => {
      world.threadReads++
      return world.threads
    },
    run: async (deps) => {
      world.runs.push(deps)
      return typeof world.answer === 'function' ? world.answer(deps) : world.answer
    },
    audit: () => {},
    log: () => {},
    broadcast: () => {},
    notify: () => {},
    createThread: () => 'greeting-thread',
    greetingText: () => 'Buen día',
    telegram: { notify: async () => false, append: () => {} },
    push: { notifyGreeting: async () => {} },
    landing: () => {},
    devices: async () => [],
    ...options.deps
  }
  return { world, file, service: new DreamService(deps) }
}

describe('dream service: preconditions and status (spec 033)', () => {
  it('AC-4.2 (033) no key: no call, status no-key', async () => {
    let keyed = false
    const { world, service } = harness({ deps: { hasKey: () => keyed } })
    await service.check('tick')
    expect(world.runs).toHaveLength(0)
    expect(world.threadReads).toBe(0)
    expect(service.status()).toMatchObject({ choice: null, failure: { reason: 'no-key', at: at(10, 3).getTime() } })
    // A precondition is not an attempt: the next tick with a key dreams.
    keyed = true
    world.now = at(10, 3, 1)
    await service.check('tick')
    await service.check('tick')
    expect(world.runs).toHaveLength(1)
  })

  it('AC-4.5 (033) read-only mode: no dream at all', async () => {
    const { world, service } = harness({ settings: { approvalMode: 'blocked' } })
    await service.check('tick')
    await service.check('start')
    expect(world.runs).toHaveLength(0)
    expect(world.threadReads).toBe(0)
    expect(service.status().failure).toMatchObject({ reason: 'read-only' })
  })

  it('AC-5.5 (033) no vault: no call, status no-vault', async () => {
    const { world, service } = harness({ deps: { knowledge: () => null } })
    await service.check('start')
    expect(world.runs).toHaveLength(0)
    expect(service.status().failure).toMatchObject({ reason: 'no-vault' })
  })

  it('AC-1.5 (033) the status view: provider and model only, nothing it does not have', async () => {
    const { world, service } = harness()
    // Only identifiers, dates, amounts and the model name: no prices or other row fields leak into the view.
    expect(service.status()).toEqual({ enabled: true, choice: { provider: 'anthropic', model: 'eco-test' }, running: false })
    expect(harness({ deps: { hasKey: () => false } }).service.status().choice).toBeNull()
    for (const outcome of ['ok', 'capped'] as const) {
      world.answer = { ...OK, outcome }
      world.now = at(world.now.getDate() + 1, 3)
      await service.check('tick')
      expect(service.status().last).toEqual({ at: world.now.getTime(), costUsd: 0.01, outcome })
    }
    expect(DREAM_FAILURES).toEqual(['no-key', 'no-vault', 'read-only', 'offline', 'provider', 'interrupted'])
  })

  it('AC-1.5 (033) the status holds date, cost and the last failure; no notification', async () => {
    const reasons = ['offline', 'provider', 'interrupted'] as const
    for (const reason of reasons) {
      const notified: unknown[] = []
      const { service } = harness({ answer: { outcome: 'failed', reason, spentUsd: 0.002 }, deps: { notify: (...args) => void notified.push(args) } })
      await service.check('tick')
      expect(service.status().failure).toEqual({ at: at(10, 3).getTime(), reason })
      expect(notified).toHaveLength(0)
    }
    // Offline before starting is a failure too, with no call.
    const offline = harness({ deps: { online: async () => false } })
    await offline.service.check('tick')
    expect(offline.world.runs).toHaveLength(0)
    expect(offline.service.status().failure).toMatchObject({ reason: 'offline' })

    // The live event follows every change; after a later dream the last failure stays next to its date and cost (BR-34).
    const statuses: unknown[] = []
    const notified: unknown[] = []
    const { world, service } = harness({ answer: { outcome: 'failed', reason: 'provider', spentUsd: 0.002 }, deps: { broadcast: (status) => void statuses.push(status), notify: (...args) => void notified.push(args) } })
    await service.check('tick')
    expect(statuses.length).toBeGreaterThan(0)
    world.answer = OK
    world.now = at(11, 3)
    await service.check('tick')
    expect(service.status()).toMatchObject({ enabled: true, running: false, choice: { provider: 'anthropic', model: 'eco-test' }, last: { at: at(11, 3).getTime(), costUsd: 0.01, outcome: 'ok' }, failure: { at: at(10, 3).getTime(), reason: 'provider' } })
    expect(statuses.at(-1)).toEqual(service.status())
    expect(notified).toHaveLength(0)
  })
})

/** A runner that waits until its signal aborts, then fails as the real one does. */
const untilAborted = (spentUsd = 0.003) => (deps: DreamDeps): Promise<DreamResult> =>
  new Promise((resolve) => deps.signal.addEventListener('abort', () => resolve({ outcome: 'failed', reason: 'interrupted', spentUsd: deps.spentUsd + spentUsd })))
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('dream service: switch, retry and the night spend (spec 033)', () => {
  it('AC-1.4 (033) turning the switch off aborts and applies nothing', async () => {
    const { world, service } = harness({ answer: untilAborted() })
    const dreaming = service.check('tick')
    await tick()
    expect(service.status().running).toBe(true)
    world.settings = { ...world.settings, dream: { ...world.settings.dream, enabled: false } }
    service.settingsChanged()
    await dreaming
    expect(world.runs[0].signal.aborted).toBe(true)
    expect(service.status()).toMatchObject({ running: false })
    expect(service.status().failure).toBeUndefined()
    // Not retried that day, even with the switch back on.
    world.settings = { ...world.settings, dream: { ...world.settings.dream, enabled: true } }
    world.now = at(10, 9)
    await service.check('start')
    await service.check('resume')
    expect(world.runs).toHaveLength(1)
    world.answer = OK
    world.now = at(11, 3)
    await service.check('tick')
    expect(world.runs).toHaveLength(2)
  })

  it('AC-2.8 (033) a failed dream is retried once', async () => {
    const failure: DreamResult = { outcome: 'failed', reason: 'provider', spentUsd: 0.01 }
    // By a later tick inside the window.
    const byTick = harness({ answer: failure })
    await byTick.service.check('tick')
    byTick.world.now = at(10, 3, 1)
    await byTick.service.check('tick')
    byTick.world.now = at(10, 3, 2)
    await byTick.service.check('tick')
    expect(byTick.world.runs).toHaveLength(2)
    // By a start or a resume after the window; a second failure stops for the day.
    for (const trigger of ['start', 'resume'] as const) {
      const { world, service } = harness({ answer: failure })
      await service.check('tick')
      world.now = at(10, 9)
      await service.check(trigger)
      await service.check('start')
      await service.check('resume')
      expect(world.runs).toHaveLength(2)
      world.now = at(11, 3)
      await service.check('tick')
      expect(world.runs).toHaveLength(3)
    }
  })

  it("AC-4.6 (033) the retry shares the night's cap", async () => {
    const { world, service } = harness({ answer: { outcome: 'failed', reason: 'offline', spentUsd: 0.07 } })
    await service.check('tick')
    expect(world.runs[0].spentUsd).toBe(0)
    world.answer = async (deps) => ({ ...OK, spentUsd: deps.spentUsd + 0.05 })
    world.now = at(10, 9)
    await service.check('start')
    expect(world.runs[1].spentUsd).toBe(0.07)
    expect(world.runs[1].capUsd).toBe(0.25)
    expect(service.status().last?.costUsd).toBeCloseTo(0.12)
    // The next night starts from zero.
    world.now = at(11, 3)
    await service.check('tick')
    expect(world.runs[2].spentUsd).toBe(0)
  })

  it('AC-4.4 (033) a resume during a dream interrupts it', async () => {
    const { world, service } = harness({ answer: untilAborted(0.004) })
    const dreaming = service.check('tick')
    await tick()
    world.answer = OK
    world.now = at(10, 8)
    await service.resumed()
    await dreaming
    expect(world.runs[0].signal.aborted).toBe(true)
    // The resume check retried at once, carrying the spend.
    expect(world.runs).toHaveLength(2)
    expect(world.runs[1].spentUsd).toBe(0.004)
    expect(service.status()).toMatchObject({ last: { outcome: 'ok' }, failure: { reason: 'interrupted' } })
  })
})

describe('dream service: the greeting conversation (spec 033)', () => {
  it('AC-7.10 (033) one new conversation titled by key, answered by the main agent', async () => {
    const created: { agentId: string; title: string; text: string }[] = []
    const createThread = (agentId: string, title: string, text: string): string => {
      created.push({ agentId, title, text })
      return `greeting-${created.length}`
    }
    const { world, file, service } = harness({ settings: { defaultAgentId: 'general' }, deps: { createThread } })
    await service.check('tick')
    expect(created).toEqual([{ agentId: 'general', title: greetingThreadTitle('es', at(10, 3)), text: 'Buen día' }])
    expect(created[0].title).toContain('Buen día ·')
    // The state keeps only its id, never the text.
    const state = readFileSync(file, 'utf8')
    expect(state).toContain('greeting-1')
    expect(state).not.toContain('Buen día')
    // No greeting written, no conversation: a skipped night, a failed one.
    for (const answer of [{ outcome: 'skipped' }, { outcome: 'failed', reason: 'provider', spentUsd: 0 }, { ...OK, greeting: undefined }] as DreamResult[]) {
      const other = harness({ answer, deps: { createThread } })
      await other.service.check('tick')
    }
    expect(created).toHaveLength(1)
    expect(world.runs).toHaveLength(1)
  })

  it('AC-7.7 (033) greeting in the app language, prompt in English', async () => {
    const systems: string[] = []
    const ts = at(10, 1).getTime()
    const answer = JSON.stringify({ add: [{ text: 'Vive en Encarnación', why: 'Lo dijo', sources: [{ thread: 't1', ts }] }], replace: [], remove: [], speculative: [] })
    const provider = {
      streamTurn: async (request: TurnRequest): Promise<TurnResult> => {
        systems.push(request.system)
        const text = request.system === greetingSystem('en') ? JSON.stringify({ greeting: 'Good morning' }) : answer
        return { content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 }, model: ROW.model }
      }
    }
    const knowledge: DreamDeps['knowledge'] = {
      memories: async () => [],
      applyDreamChanges: async (_snapshot, changes, journal) => {
        const result = { lines: [], applied: changes, skipped: [] }
        await journal(result)
        return result
      },
      writeJournal: async () => ''
    }
    const { service, world } = harness({ settings: { language: 'en' }, deps: { run: runDream, provider: () => provider, knowledge: () => knowledge } })
    world.threads = [{ id: 't1', title: 'Mudanza', agentId: 'general', messages: [{ role: 'user', content: [{ type: 'text', text: 'Me mudé a Encarnación, che' }], ts }] }]
    await service.check('tick')
    expect(systems).toHaveLength(2)
    expect(systems[1]).toBe(greetingSystem('en'))
    expect(systems[1]).toContain('in English')
    for (const system of systems) expect(system).not.toMatch(/[áéíóúñ¿¡]/)
  })
})

/** A harness whose delivery channels are recorded. */
function delivering(options: Parameters<typeof harness>[0] = {}) {
  const out = {
    notified: [] as [string, string, string][],
    telegram: [] as string[],
    appended: [] as string[],
    pushes: 0,
    landings: [] as string[],
    logs: [] as string[],
    telegramUp: true as boolean | 'throws',
    pushThrows: false
  }
  const made = harness({
    ...options,
    deps: {
      createThread: () => 'greeting-thread',
      greetingText: (id) => (id === 'greeting-thread' ? 'Buen día, GREETING-TEXT' : undefined),
      notify: (title, body, threadId) => void out.notified.push([title, body, threadId]),
      telegram: {
        notify: async (text) => {
          if (out.telegramUp === 'throws') throw new Error('telegram down')
          if (out.telegramUp) out.telegram.push(text)
          return out.telegramUp
        },
        append: (text) => void out.appended.push(text)
      },
      push: {
        notifyGreeting: async () => {
          if (out.pushThrows) throw new Error('push down')
          out.pushes++
        }
      },
      landing: (threadId) => void out.landings.push(threadId),
      devices: async () => ['phone-1', 'phone-2'],
      log: (line) => void out.logs.push(line),
      ...options.deps
    }
  })
  return { ...made, out }
}

describe('dream service: delivery (spec 033)', () => {
  it('AC-7.1 (033) the first wake signal delivers once on every channel', async () => {
    const { world, file, service, out } = delivering()
    await service.check('tick')
    expect(out.notified).toHaveLength(0)
    world.now = at(10, 8)
    expect(service.canUse()).toBe(true)
    service.wake()
    await tick()
    expect(out.notified).toEqual([[translate('es', 'dream.greeting.notifyTitle'), 'Buen día, GREETING-TEXT', 'greeting-thread']])
    expect(out.telegram).toEqual(['Buen día, GREETING-TEXT'])
    expect(out.appended).toEqual(['Buen día, GREETING-TEXT'])
    expect(out.pushes).toBe(1)
    expect(out.landings).toEqual(['greeting-thread'])
    expect(JSON.parse(readFileSync(file, 'utf8')).landing).toEqual({ threadId: 'greeting-thread', desktop: true, devices: ['phone-1', 'phone-2'] })
    // No model call at wake time.
    expect(world.runs).toHaveLength(1)
    expect(service.canUse()).toBe(false)
  })

  it('AC-7.2 (033) once a day, across restarts', async () => {
    const { world, file, service, out } = delivering()
    await service.check('tick')
    world.now = at(10, 8)
    service.wake()
    await tick()
    service.wake()
    service.personMessage('t9', Promise.resolve())
    await tick()
    expect(out.notified).toHaveLength(1)
    const again = delivering({ file, now: at(10, 12) })
    again.service.wake()
    again.service.personMessage('t9', Promise.resolve())
    await tick()
    expect(again.out.notified).toHaveLength(0)
    expect(again.out.telegram).toHaveLength(0)
    expect(again.out.pushes).toBe(0)
  })

  it('AC-7.6 (033) a failing channel does not stop the others and is not retried', async () => {
    for (const telegramUp of [false, 'throws'] as const) {
      for (const pushThrows of [false, true]) {
        const { world, service, out } = delivering()
        out.telegramUp = telegramUp
        out.pushThrows = pushThrows
        await service.check('tick')
        world.now = at(10, 8)
        service.wake()
        await tick()
        expect(out.notified).toHaveLength(1)
        expect(out.appended).toHaveLength(0)
        expect(out.pushes).toBe(pushThrows ? 0 : 1)
        expect(out.landings).toEqual(['greeting-thread'])
        // Not retried at the next signal; the log names the channel and never the text.
        service.wake()
        await tick()
        expect(out.notified).toHaveLength(1)
        expect(out.logs.join('\n')).not.toContain('GREETING-TEXT')
        if (telegramUp === 'throws') expect(out.logs.some((line) => line.includes('telegram'))).toBe(true)
        if (pushThrows) expect(out.logs.some((line) => line.includes('push'))).toBe(true)
      }
    }
  })

  it('AC-7.12 (033) an undelivered greeting is dropped at 02:00', async () => {
    let made = 0
    const { world, service, out } = delivering({ deps: { createThread: () => `greeting-thread${made++ ? made : ''}` } })
    await service.check('tick')
    // No wake that day; at 01:59 it is still the same day, at 02:00 the next one.
    world.now = at(11, 2, 0)
    world.answer = { outcome: 'skipped' }
    expect(service.canUse()).toBe(false)
    service.wake()
    await tick()
    expect(out.notified).toHaveLength(0)
    expect(made).toBe(1)
  })
})

/** A promise and its resolver, to hold a run or an answer open. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('dream service: first message, Telegram and presence (spec 033)', () => {
  it('AC-7.4 (033) the first message is answered in its own conversation', async () => {
    const { world, service, out } = delivering({ settings: { telegram: { ...defaultSettings().telegram, threadId: 'tg' } } })
    await service.check('tick')
    world.now = at(10, 8)
    const answer = deferred<void>()
    // The person writes in the desktop conversation t9; its answer is still running.
    service.personMessage('t9', answer.promise)
    await tick()
    expect(out.notified).toHaveLength(1)
    expect(out.pushes).toBe(1)
    expect(out.telegram).toHaveLength(1)
    // Only the Telegram thread gets the greeting appended; the person's conversation gets nothing.
    expect(out.appended).toEqual(['Buen día, GREETING-TEXT'])
    expect(out.notified[0][2]).toBe('greeting-thread')
  })

  it('AC-7.4 (033) on Telegram the greeting follows the answer', async () => {
    for (const outcome of ['answered', 'failed'] as const) {
      const { world, service, out } = delivering({ settings: { telegram: { ...defaultSettings().telegram, threadId: 'tg' } } })
      await service.check('tick')
      world.now = at(10, 8)
      const answer = deferred<void>()
      const run = outcome === 'answered' ? answer.promise : answer.promise.then(() => Promise.reject(new Error('run failed')))
      service.personMessage('tg', run)
      await tick()
      // Desktop and phone at once; Telegram waits for the answer to the person's message (plan §9 D-2).
      expect(out.notified).toHaveLength(1)
      expect(out.pushes).toBe(1)
      expect(out.telegram).toHaveLength(0)
      answer.resolve()
      await tick()
      await tick()
      expect(out.telegram).toEqual(['Buen día, GREETING-TEXT'])
      expect(out.appended).toEqual(['Buen día, GREETING-TEXT'])
    }
  })

  it('AC-7.3 (033) without presence events the first message and the boot catch-up still work', async () => {
    const { world, service, out } = delivering({ now: at(10, 9) })
    await service.check('start')
    expect(world.runs).toHaveLength(1)
    world.now = at(10, 9, 5)
    service.personMessage('t9', Promise.resolve())
    await tick()
    expect(out.notified).toHaveLength(1)
  })

  it('AC-2.2 (033) a wake signal during a catch-up dream waits for it', async () => {
    // The dream ends with a greeting: the waiting signal delivers it then.
    const run = deferred<DreamResult>()
    const { world, service, out } = delivering({ now: at(10, 9), answer: () => run.promise })
    const dreaming = service.check('start')
    await tick()
    expect(service.canUse()).toBe(true)
    service.wake()
    await tick()
    expect(out.notified).toHaveLength(0)
    run.resolve(OK)
    await dreaming
    await tick()
    expect(out.notified).toHaveLength(1)
    expect(world.runs).toHaveLength(1)

    // The catch-up fails: nothing is delivered and the day is not used up; the retry's greeting reaches the next signal.
    const failing = deferred<DreamResult>()
    const second = delivering({ now: at(10, 9), answer: () => failing.promise })
    const first = second.service.check('start')
    await tick()
    second.service.wake()
    failing.resolve({ outcome: 'failed', reason: 'provider', spentUsd: 0 })
    await first
    await tick()
    expect(second.out.notified).toHaveLength(0)
    expect(second.service.canUse()).toBe(false)
    second.world.answer = OK
    await second.service.resumed()
    await tick()
    expect(second.out.notified).toHaveLength(0)
    second.service.personMessage('t9', Promise.resolve())
    await tick()
    expect(second.out.notified).toHaveLength(1)

    // A first attempt by a tick in the window is not a catch-up: a signal then is of no use and is not kept.
    const night = deferred<DreamResult>()
    const third = delivering({ now: at(10, 3), answer: () => night.promise })
    const nightly = third.service.check('tick')
    await tick()
    expect(third.service.canUse()).toBe(false)
    third.service.wake()
    night.resolve(OK)
    await nightly
    await tick()
    expect(third.out.notified).toHaveLength(0)
  })

  it('AC-7.1 (033) the consumer follows canUseWake through a real presence service (034 AC-2.13)', async () => {
    const { world, service, out } = delivering({ now: at(10, 3) })
    const presence = new PresenceService({ file: join(temp(), 'presence.json'), now: () => world.now, thresholdMs: 4 * 3_600_000, consumers: () => [service], log: () => {} })
    // An unlock at 02:30 before the night's dream: nothing to deliver, and the day is not used up.
    world.now = at(10, 2, 30)
    presence.receive({ kind: 'unlock', absenceMs: 5 * 3_600_000 })
    await tick()
    expect(out.notified).toHaveLength(0)
    world.now = at(10, 3)
    await service.check('tick')
    world.now = at(10, 8)
    presence.receive({ kind: 'unlock', absenceMs: 5 * 3_600_000 })
    await tick()
    expect(out.notified).toHaveLength(1)
    // With the dream off the consumer is off: presence offers nothing.
    world.settings = { ...world.settings, dream: { ...world.settings.dream, enabled: false } }
    expect(service.enabled()).toBe(false)
  })
})

describe('dream service: what the coordinator wires (spec 033)', () => {
  it('BR-29 (033) the desktop landing is posted until the window opens on it', async () => {
    const { world, file, service } = delivering()
    expect(service.desktopLanding()).toBeNull()
    await service.check('tick')
    world.now = at(10, 8)
    service.wake()
    await tick()
    expect(service.desktopLanding()).toBe('greeting-thread')
    service.landingUsed('another-thread')
    expect(delivering({ file }).service.desktopLanding()).toBe('greeting-thread')
    service.landingUsed('greeting-thread')
    expect(service.desktopLanding()).toBeNull()
    expect(delivering({ file }).service.desktopLanding()).toBeNull()
    // The phones keep theirs.
    expect(JSON.parse(readFileSync(file, 'utf8')).landing.devices).toEqual(['phone-1', 'phone-2'])
  })

  it('AC-7.5 (033) each phone lands once, across restarts', async () => {
    const { world, file, service } = delivering()
    expect(service.phoneLanding('phone-1')).toBeNull()
    await service.check('tick')
    world.now = at(10, 8)
    service.wake()
    await tick()
    expect(service.phoneLanding('phone-1')).toBe('greeting-thread')
    expect(service.phoneLanding('phone-1')).toBeNull()
    expect(delivering({ file }).service.phoneLanding('phone-1')).toBeNull()
    // A device paired after the delivery has none; the other phone and the desktop keep theirs.
    expect(service.phoneLanding('phone-3')).toBeNull()
    expect(delivering({ file }).service.phoneLanding('phone-2')).toBe('greeting-thread')
    expect(service.desktopLanding()).toBe('greeting-thread')
  })

  it('BR-23 (033) erasing the history deletes the dream state (plan §10 G9)', async () => {
    const { world, file, service } = harness({ answer: untilAborted() })
    const dreaming = service.check('tick')
    await tick()
    service.clear()
    await dreaming
    expect(world.runs[0].signal.aborted).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(service.status().last).toBeUndefined()
    expect(service.status().failure).toBeUndefined()
  })
})

describe('dream service: scheduler and state (spec 033)', () => {
  it('AC-1.1 (033) with the dream off nothing is read, called, written or sent', async () => {
    const { world, file, service } = harness({ enabled: false })
    for (const trigger of ['tick', 'start', 'resume'] as const) await service.check(trigger)
    world.now = at(10, 9)
    await service.check('start')
    expect(world.runs).toHaveLength(0)
    expect(world.threadReads).toBe(0)
    expect(existsSync(file)).toBe(false)
  })

  it('AC-2.1 (033) a tick inside the window starts one dream', async () => {
    const { world, service } = harness({ now: at(10, 1, 59) })
    await service.check('tick')
    expect(world.runs).toHaveLength(0)
    world.now = at(10, 2, 0)
    await service.check('tick')
    expect(world.runs).toHaveLength(1)
    world.now = at(10, 2, 30)
    await service.check('tick')
    expect(world.runs).toHaveLength(1)
    expect(world.runs[0].startedAt).toBe(at(10, 2, 0).getTime())
  })

  it('AC-2.2 (033) start and resume catch up a missed night', async () => {
    for (const trigger of ['start', 'resume'] as const) {
      const { world, service } = harness({ now: at(10, 9) })
      await service.check('tick')
      expect(world.runs).toHaveLength(0)
      await service.check(trigger)
      expect(world.runs).toHaveLength(1)
    }
  })

  it('AC-2.3 (033) a done night survives a restart', async () => {
    const first = harness()
    await first.service.check('tick')
    expect(first.world.runs).toHaveLength(1)
    // State: ids, timestamps and amounts only.
    const state = JSON.parse(readFileSync(first.file, 'utf8'))
    expect(JSON.stringify(state)).not.toContain('Buen día')
    const again = harness({ file: first.file, now: at(10, 9) })
    await again.service.check('start')
    await again.service.check('resume')
    expect(again.world.runs).toHaveLength(0)
    // The cursors carry over to the next night's dream.
    again.world.now = at(11, 3)
    await again.service.check('tick')
    expect(again.world.runs[0].cursors).toEqual({ t1: 5 })
    // A corrupt file reads as empty.
    writeFileSync(first.file, '{not json')
    const corrupt = harness({ file: first.file, now: at(11, 9) })
    await corrupt.service.check('start')
    expect(corrupt.world.runs).toHaveLength(1)
    expect(corrupt.world.runs[0].cursors).toEqual({})
  })

  it('AC-2.5 (033) no material: no call, and the night counts as dreamt', async () => {
    const { world, service } = harness({ answer: { outcome: 'skipped' } })
    await service.check('tick')
    expect(world.runs).toHaveLength(1)
    // A message at 07:00 the same day waits for the next night: no catch-up runs for it.
    world.now = at(10, 7)
    await service.check('start')
    await service.check('resume')
    expect(world.runs).toHaveLength(1)
    expect(service.status().last).toMatchObject({ outcome: 'skipped' })
    world.now = at(11, 2)
    await service.check('tick')
    expect(world.runs).toHaveLength(2)
  })
})

describe('dream service: robustness (spec 033)', () => {
  it('AC-2.3 (033) two checks at once start one dream: the slot is taken before the online check', async () => {
    const { world, service } = harness({ now: at(10, 3) })
    await Promise.all([service.check('tick'), service.check('resume')])
    expect(world.runs).toHaveLength(1)
  })

  it('AC-2.8 (033) a pipeline that throws counts as a failed attempt, keeps the night spend and is retried once', async () => {
    let calls = 0
    const { world, service } = harness({
      now: at(10, 3),
      answer: async () => {
        calls++
        if (calls === 1) return { outcome: 'failed', reason: 'provider', spentUsd: 0.04 }
        throw new Error('disk gone')
      }
    })
    await service.check('tick')
    await expect(service.check('tick')).resolves.toBeUndefined()
    expect(world.runs[1].spentUsd).toBe(0.04)
    expect(service.status()).toMatchObject({ running: false, failure: { reason: 'provider' } })
    // Two failures: not retried that day.
    await service.check('tick')
    expect(world.runs).toHaveLength(2)
  })

  it('BR-23 (033) erasing removes a leftover temp file and completes even when a removal fails', () => {
    const logs: string[] = []
    const dir = temp()
    const file = join(dir, 'dream-state.json')
    // A directory where the state file should be: its removal throws.
    mkdirSync(file)
    writeFileSync(`${file}.tmp`, '{}')
    const { service } = harness({ file, deps: { log: (line) => void logs.push(line) } })
    expect(() => service.clear()).not.toThrow()
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(logs.some((line) => line.startsWith('[dream] could not erase'))).toBe(true)
  })

  it('AC-2.1 (033) start twice keeps one tick; stop clears the timers', () => {
    vi.useFakeTimers()
    try {
      const { service } = harness()
      service.start()
      service.start()
      expect(vi.getTimerCount()).toBe(2)
      service.stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
