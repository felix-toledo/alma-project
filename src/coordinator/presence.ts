// Presence signals, the coordinator side (spec 034): applies the once-a-day rule and offers the wake signal.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { absenceBetween, decideWake, type PresenceEvent, PresenceEventSchema, type PresenceState, PresenceStateSchema } from '../shared/presence'

/** A feature inside the coordinator that wants to know when the person is back (033 first). */
export interface PresenceConsumer {
  /** Is the feature on (033: the dream switch). */
  enabled(): boolean
  /** Could it use a signal right now (BR-12). */
  canUse(): boolean
  /** "The person is back now": no kind, time or length (BR-7). */
  wake(): void
}

export interface PresenceDeps {
  /** <userData>/presence.json */
  file: string
  now(): Date
  thresholdMs: number
  consumers(): readonly PresenceConsumer[]
  /** Identifiers only, never the payload (AC-1.3). */
  log(line: string): void
}

export class PresenceService {
  private state: PresenceState

  constructor(private readonly deps: PresenceDeps) {
    this.state = this.load()
  }

  /** Validates, keeps the last activity, decides and offers; answers the kind accepted, null for a malformed message. Never throws. */
  receive(raw: unknown): PresenceEvent['kind'] | null {
    const parsed = PresenceEventSchema.safeParse(raw)
    if (!parsed.success) {
      this.deps.log('[presence] ignored a malformed presence message')
      return null
    }
    const event = parsed.data
    const now = this.deps.now()
    const on = this.deps.consumers().filter((consumer) => this.guarded(() => consumer.enabled(), false))
    // Nothing is kept or offered while no consumer is on (BR-8).
    if (on.length === 0) return event.kind
    if (event.kind !== 'active') {
      const usable = on.filter((consumer) => this.guarded(() => consumer.canUse(), false))
      const absenceMs = event.kind === 'start' ? absenceBetween(this.state.lastActivityAt, now.getTime()) : event.absenceMs
      const decision = decideWake({ event: event.kind, absenceMs, now, state: this.state, canUse: usable.length > 0, thresholdMs: this.deps.thresholdMs })
      this.state = decision.state
      if (decision.wake) for (const consumer of usable) this.guarded(() => consumer.wake(), undefined)
    }
    this.state = { ...this.state, lastActivityAt: now.getTime() }
    this.save()
    return event.kind
  }

  /** A consumer's call; one that throws is logged by name and gives `fallback`, and the others still run. */
  private guarded<T>(call: () => T, fallback: T): T {
    try {
      return call()
    } catch (error) {
      this.deps.log(`[presence] a consumer failed: ${error instanceof Error ? error.name : 'error'}`)
      return fallback
    }
  }

  /** Deletes the state when no consumer is on (AC-2.11, AC-3.1); called on every settings push. */
  consumersChanged(): void {
    if (!this.deps.consumers().some((consumer) => this.guarded(() => consumer.enabled(), false))) this.clear()
  }

  /** «Borrar mi historial» (AC-3.3): the file and a leftover temp file; one that cannot go does not stop the other. */
  clear(): void {
    this.state = {}
    for (const path of [this.deps.file, `${this.deps.file}.tmp`]) {
      try {
        rmSync(path, { force: true })
      } catch (error) {
        this.deps.log(`[presence] could not erase a state file: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`)
      }
    }
  }

  private load(): PresenceState {
    if (!existsSync(this.deps.file)) return {}
    try {
      const parsed = PresenceStateSchema.safeParse(JSON.parse(readFileSync(this.deps.file, 'utf8')))
      if (parsed.success) return parsed.data
    } catch {
      // Unreadable JSON: same as an invalid shape.
    }
    this.deps.log('[presence] ignored an unreadable state file')
    return {}
  }

  private save(): void {
    const tmp = `${this.deps.file}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(this.state), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.deps.file)
    } catch (error) {
      // Kept in memory; the next event tries again.
      this.deps.log(`[presence] could not save the state: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`)
    }
  }
}
