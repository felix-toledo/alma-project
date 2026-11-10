// The dream's scheduler and state (spec 033): when to dream, what the night left, and the status line.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import * as z from 'zod/v4'
import type { AuditEvent } from '../../shared/audit'
import type { ReadableThread } from '../../shared/dream/input'
import { ECONOMY_MODELS, type EconomyRow, pickDreamModel } from '../../shared/dream/model'
import { type DreamFailure, DreamScheduleSchema, type DreamTrigger, isDreamDue } from '../../shared/dream/schedule'
import { DreamFailureRecordSchema, DreamLastSchema, type DreamStatusView } from '../../shared/dream/settings'
import { canUseWake, GreetingStateSchema, greetingDue } from '../../shared/dream/greeting'
import { translate } from '../../shared/i18n/messages'
import { dayKey } from '../../shared/presence'
import type { ProviderId, Settings } from '../../shared/types'
import { greetingThreadTitle } from '../generated'
import type { PresenceConsumer } from '../presence'
import type { Provider } from '../providers/types'
import { type DreamDeps, type DreamResult, runDream } from './runner'

/** dream-state.json: ids, timestamps and amounts only, never message, memory or greeting text. */
const StateSchema = z.object({
  schedule: DreamScheduleSchema,
  cursors: z.record(z.string(), z.number()),
  last: DreamLastSchema.optional(),
  failure: DreamFailureRecordSchema.optional(),
  greeting: GreetingStateSchema.optional(),
  /** The next opening lands in the greeting: on the desktop, and on each of these paired devices (BR-29). */
  landing: z.object({ threadId: z.string(), desktop: z.boolean(), devices: z.array(z.string()) }).optional()
})
type DreamState = z.infer<typeof StateSchema>
const EMPTY: DreamState = { schedule: {}, cursors: {} }
/** The scheduler's check, as routines tick (plan §9 D-3). */
const TICK_MS = 30_000
/** The start check waits for the rest of the coordinator to come up. */
const START_DELAY_MS = 5_000

export interface DreamServiceDeps {
  /** <userData>/dream-state.json */
  file: string
  now(): Date
  settings(): Settings
  /** The active vault, or null. */
  knowledge(): DreamDeps['knowledge'] | null
  hasKey(provider: ProviderId): boolean
  /** The economy table (ECONOMY_MODELS when not given). */
  table?: readonly EconomyRow[]
  provider(row: EconomyRow): Pick<Provider, 'streamTurn'>
  online(): Promise<boolean>
  /** The threads as they are now. */
  threads(): readonly ReadableThread[]
  /** The pipeline (runDream when not given). */
  run?(deps: DreamDeps): Promise<DreamResult>
  audit(event: AuditEvent): void
  /** Identifiers and outcomes only (AC-8.2). */
  log(line: string): void
  /** The `dream.status` live event. */
  broadcast(status: DreamStatusView): void
  /** A desktop notification sent with `always`; never for a failure (AC-1.5). */
  notify(title: string, body: string, threadId: string): void
  /** A new conversation of `agentId` with one assistant message; returns its id. */
  createThread(agentId: string, title: string, text: string): string
  /** The greeting as written in its conversation; undefined when the conversation is gone. */
  greetingText(threadId: string): string | undefined
  /** Telegram's bound chat; `notify` is false when not connected or not bound. `append` adds it to the Telegram thread. */
  telegram: { notify(text: string): Promise<boolean>; append(text: string): void }
  /** The content-free greeting push to each paired phone (AC-7.13). */
  push: { notifyGreeting(): Promise<void> }
  /** Tells main the next opening of the window lands in this conversation. */
  landing(threadId: string): void
  /** The paired devices' ids. */
  devices(): Promise<readonly string[]>
}

export class DreamService implements PresenceConsumer {
  private state: DreamState
  private running: Promise<void> | null = null
  /** The check under way, set before its first await: two checks never both start a dream. */
  private checking: Promise<void> | null = null
  private timers: NodeJS.Timeout[] = []
  private controller: AbortController | null = null
  /** The running dream was aborted by the switch: never retried that day (BR-24). */
  private switchedOff = false
  /** The running dream is a catch-up, which a wake signal waits for (BR-26). */
  private catchUp = false
  /** A wake signal that came during a catch-up dream; `telegramAfter` as in personMessage. */
  private waiting: { telegramAfter: Promise<void> | null } | null = null
  /** Bumped by clear(): a dream that started before an erase saves nothing. */
  private epoch = 0

  constructor(private readonly deps: DreamServiceDeps) {
    this.state = this.load()
  }

  private get on(): boolean {
    return this.deps.settings().dream.enabled
  }

  // ---------------------------------------------------------------------------
  // 034's consumer, and the person's first message (BR-12)

  enabled(): boolean {
    return this.on
  }

  canUse(): boolean {
    return canUseWake(this.state.greeting, this.deps.now(), this.running !== null && this.catchUp)
  }

  /** A wake signal of 034. Never throws. */
  wake(): void {
    void this.woke()
  }

  /**
   * The person wrote in some conversation; `answered` settles with the answer to it. Never throws. Over Telegram, the
   * greeting goes there after that answer, the single thread by design (BR-28, plan §9 D-2).
   */
  personMessage(threadId: string, answered: Promise<void>): void {
    void this.woke(this.deps.settings().telegram.threadId === threadId ? answered : null)
  }

  private async woke(telegramAfter: Promise<void> | null = null): Promise<void> {
    try {
      const due = greetingDue({ now: this.deps.now(), enabled: this.on, greeting: this.state.greeting, catchUpRunning: this.running !== null && this.catchUp })
      if (due === 'deliver') await this.deliver(telegramAfter)
      // Delivered when the catch-up dream ends with a greeting; dropped, and the day not used up, when it does not (AC-2.2).
      if (due === 'wait') this.waiting = { telegramAfter }
    } catch (error) {
      this.deps.log(`[dream] the greeting could not be delivered: ${error instanceof Error ? error.name : 'error'}`)
    }
  }

  /** Once, as written, with no model call, on every channel; a failing one is logged and not retried (AC-7.1, AC-7.6). */
  private async deliver(telegramAfter: Promise<void> | null): Promise<void> {
    const greeting = this.state.greeting
    if (!greeting) return
    const now = this.deps.now().getTime()
    const text = this.deps.greetingText(greeting.threadId)
    // Marked before any await: whatever happens next, it is not delivered twice (AC-7.2).
    this.save({ ...this.state, greeting: { ...greeting, deliveredAt: now } })
    if (text === undefined) return
    let devices: string[] = []
    await this.channel('devices', async () => {
      devices = [...(await this.deps.devices())]
    })
    this.save({ ...this.state, landing: { threadId: greeting.threadId, desktop: true, devices } })
    const settings = this.deps.settings()
    await this.channel('desktop', () => this.deps.notify(translate(settings.language, 'dream.greeting.notifyTitle'), text, greeting.threadId))
    await this.channel('landing', () => this.deps.landing(greeting.threadId))
    await this.channel('push', () => this.deps.push.notifyGreeting())
    const telegram = (): Promise<void> =>
      this.channel('telegram', async () => {
        if (await this.deps.telegram.notify(text)) this.deps.telegram.append(text)
      })
    if (telegramAfter) void telegramAfter.catch(() => {}).then(telegram)
    else await telegram()
  }

  private async channel(name: string, task: () => unknown): Promise<void> {
    try {
      await task()
    } catch (error) {
      this.deps.log(`[dream] the greeting did not reach ${name}: ${error instanceof Error ? error.name : 'error'}`)
    }
  }

  private row(): EconomyRow | null {
    return pickDreamModel((provider) => this.deps.hasKey(provider), this.deps.table ?? ECONOMY_MODELS)
  }

  status(): DreamStatusView {
    const row = this.row()
    const { last, failure } = this.state
    return { enabled: this.on, choice: row ? { provider: row.provider, model: row.model } : null, ...(last ? { last } : {}), ...(failure ? { failure } : {}), running: this.running !== null }
  }

  /** Why a due dream cannot start; these are not attempts (AC-4.2, AC-4.5, AC-5.5; plan §10 G12). */
  private async precondition(row: EconomyRow | null, knowledge: DreamDeps['knowledge'] | null): Promise<DreamFailure | null> {
    if (this.deps.settings().approvalMode === 'blocked') return 'read-only'
    if (!row) return 'no-key'
    if (!knowledge) return 'no-vault'
    return (await this.deps.online()) ? null : 'offline'
  }

  private failed(now: Date, reason: DreamFailure): void {
    const same = this.state.failure?.reason === reason && dayKey(new Date(this.state.failure.at)) === dayKey(now)
    // Checked every tick inside the window: written once a day per reason, not every 30 s.
    if (!same) this.save({ ...this.state, failure: { at: now.getTime(), reason } })
  }

  /** The 30 s tick, and the start check a few seconds after boot (BR-11). A second start replaces the first. */
  start(): void {
    this.stop()
    const run = (trigger: DreamTrigger) => () =>
      void this.check(trigger).catch((error: unknown) => this.deps.log(`[dream] the ${trigger} check failed: ${error instanceof Error ? error.name : 'error'}`))
    this.timers = [setInterval(run('tick'), TICK_MS).unref(), setTimeout(run('start'), START_DELAY_MS).unref()]
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
  }

  /** The conversation the desktop window still has to land in, if any (BR-29). */
  desktopLanding(): string | null {
    return this.state.landing?.desktop ? this.state.landing.threadId : null
  }

  /** The window opened on the greeting: later openings behave as today (BR-29). */
  landingUsed(threadId: string): void {
    const landing = this.state.landing
    if (landing?.desktop && landing.threadId === threadId) this.save({ ...this.state, landing: { ...landing, desktop: false } })
  }

  /** A phone's landing, consumed by asking: its first status call after delivery (BR-29, plan §10 G7). */
  phoneLanding(deviceId: string): string | null {
    const landing = this.state.landing
    if (!landing?.devices.includes(deviceId)) return null
    this.save({ ...this.state, landing: { ...landing, devices: landing.devices.filter((id) => id !== deviceId) } })
    return landing.threadId
  }

  /** «Borrar mi historial»: the state points at erased conversations, so it goes too (plan §10 G9). */
  clear(): void {
    this.epoch++
    this.controller?.abort()
    this.waiting = null
    this.state = EMPTY
    // The file and a leftover temp file; one that cannot go does not stop the other.
    for (const path of [this.deps.file, `${this.deps.file}.tmp`]) {
      try {
        rmSync(path, { force: true })
      } catch (error) {
        this.deps.log(`[dream] could not erase a state file: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`)
      }
    }
    this.deps.broadcast(this.status())
  }

  /** The PC resumed (034): a running dream was interrupted by the sleep, then the resume is a catch-up moment (AC-4.4). */
  async resumed(): Promise<void> {
    this.controller?.abort()
    await this.checking
    await this.check('resume')
  }

  /** The switch turned off aborts a running dream; nothing is applied and it is not retried (AC-1.4). */
  settingsChanged(): void {
    if (!this.on && this.controller) {
      this.switchedOff = true
      this.controller.abort()
    }
    this.deps.broadcast(this.status())
  }

  /** A scheduler tick, Alma starting, or the PC resuming: dreams when one is due (AC-2.1, AC-2.2, AC-2.3). */
  check(trigger: DreamTrigger): Promise<void> {
    this.checking ??= this.checkNow(trigger).finally(() => {
      this.checking = null
    })
    return this.checking
  }

  private async checkNow(trigger: DreamTrigger): Promise<void> {
    const now = this.deps.now()
    const due = isDreamDue({ now, trigger, enabled: this.on, schedule: this.state.schedule })
    if (!due.due) return
    const row = this.row()
    const knowledge = this.deps.knowledge()
    const blocked = await this.precondition(row, knowledge)
    if (blocked || !row || !knowledge) return this.failed(now, blocked ?? 'no-key')
    this.catchUp = due.catchUp
    this.running = this.dream(now, row, knowledge)
    this.deps.broadcast(this.status())
    try {
      await this.running
    } finally {
      this.running = null
      this.deps.broadcast(this.status())
    }
    const waiting = this.waiting
    this.waiting = null
    if (waiting) await this.woke(waiting.telegramAfter)
  }

  private async dream(now: Date, row: EconomyRow, knowledge: DreamDeps['knowledge']): Promise<void> {
    const settings = this.deps.settings()
    const today = dayKey(now)
    const attempt = this.state.schedule.attempt?.day === today ? this.state.schedule.attempt : undefined
    const controller = new AbortController()
    const epoch = this.epoch
    this.controller = controller
    this.switchedOff = false
    let result: DreamResult
    try {
      result = await (this.deps.run ?? runDream)({
        startedAt: now.getTime(),
        language: settings.language,
        threads: this.deps.threads(),
        agents: settings.agents,
        cursors: this.state.cursors,
        knowledge,
        provider: this.deps.provider(row),
        row,
        capUsd: settings.dream.capUsd,
        // The cap is the night's: a retry carries what the failed attempt spent (AC-4.6).
        spentUsd: attempt?.spentUsd ?? 0,
        signal: controller.signal,
        audit: this.deps.audit
      })
    } catch (error) {
      // A failed attempt like any other, so the tick does not run (and pay) again at once; its own spend is unknown.
      this.deps.log(`[dream] the dream failed: ${error instanceof Error ? error.name : 'error'}`)
      result = { outcome: 'failed', reason: 'provider', spentUsd: attempt?.spentUsd ?? 0 }
    } finally {
      this.controller = null
    }
    if (epoch !== this.epoch) return
    if (result.outcome === 'failed') {
      const failures = (attempt?.failures ?? 0) + (this.switchedOff ? 0 : 1)
      const schedule = { ...this.state.schedule, attempt: { day: today, failures, spentUsd: result.spentUsd, aborted: this.switchedOff } }
      // The person turned it off: not a failure to report.
      this.save({ ...this.state, schedule, ...(this.switchedOff ? {} : { failure: { at: now.getTime(), reason: result.reason } }) })
      return
    }
    const schedule = { ...this.state.schedule, doneDay: today }
    if (result.outcome === 'skipped') this.save({ ...this.state, schedule, last: { at: now.getTime(), costUsd: 0, outcome: 'skipped' } })
    else {
      // One new conversation per greeting, answered by the main agent (AC-7.10); the state keeps only its id. A run the
      // switch turned off after its commit point keeps its changes but greets no one (AC-1.4).
      const threadId = result.greeting && !this.switchedOff ? this.greetingThread(settings, now, result.greeting.text) : undefined
      const greeting = threadId && result.greeting ? { day: today, threadId, capped: result.greeting.capped } : this.state.greeting
      this.save({ ...this.state, schedule, cursors: result.cursors, last: { at: now.getTime(), costUsd: result.spentUsd, outcome: result.outcome }, ...(greeting ? { greeting } : {}) })
    }
  }

  private greetingThread(settings: Settings, now: Date, text: string): string | undefined {
    try {
      return this.deps.createThread(settings.defaultAgentId, greetingThreadTitle(settings.language, now), text)
    } catch (error) {
      this.deps.log(`[dream] the greeting conversation could not be created: ${error instanceof Error ? error.name : 'error'}`)
      return undefined
    }
  }

  private load(): DreamState {
    if (!existsSync(this.deps.file)) return EMPTY
    try {
      const parsed = StateSchema.safeParse(JSON.parse(readFileSync(this.deps.file, 'utf8')))
      if (parsed.success) return parsed.data
    } catch {
      // Unreadable JSON: same as an invalid shape.
    }
    this.deps.log('[dream] ignored an unreadable state file')
    return EMPTY
  }

  private save(state: DreamState): void {
    this.state = state
    this.deps.broadcast(this.status())
    const tmp = `${this.deps.file}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.deps.file)
    } catch (error) {
      // Kept in memory; the next change tries again.
      this.deps.log(`[dream] could not save the state: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`)
    }
  }
}
