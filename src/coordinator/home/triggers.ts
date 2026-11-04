// Rules that need judgment. Simple rules ("a las 23 apagá todo") live in Home Assistant as automations and cost
// nothing; these wake Alma up when something happens so she can look and decide, and camera watches that look at a
// camera now and then for a limited time. Both are saved next to the plan.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractJson, newId, ruleMatches, type CameraWatch, type HomeRules, type JudgmentRule } from '../../shared/home'
import type { Language } from '../../shared/i18n/language'
import { watchEndedNotice, watchMatchNotice } from '../notices'
import { watchQuestion } from '../prompts/vision'
import type { Picture } from '../vision'
import type { HomeHub, StateChange } from './hub'

const MIN_EVERY_SEC = 10
const MAX_HOURS = 6

export interface TriggerDeps {
  dataDir: string
  hub: HomeHub
  /** Starts an agent run for a rule that fired. */
  launch(rule: JudgmentRule, change: StateChange, thingName: string): void
  /** Tells the user (desktop and Telegram), with a picture when there is one. */
  notify(title: string, body: string, photo?: Buffer): void
  look(pictures: Picture[], question: string): Promise<{ text: string }>
  onChange(rules: HomeRules): void
  /** The app language when an alert goes out (Spanish when the caller does not say). */
  language?(): Language
}

export class HomeTriggers {
  private file: string
  private data: HomeRules = { judgment: [], watches: [] }
  private timers = new Map<string, NodeJS.Timeout>()
  private running = new Set<string>()
  private off?: () => void

  constructor(private deps: TriggerDeps) {
    const dir = join(deps.dataDir, 'home')
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'rules.json')
    if (existsSync(this.file)) {
      try {
        const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<HomeRules>
        this.data = { judgment: saved.judgment ?? [], watches: saved.watches ?? [] }
      } catch {
        // start empty
      }
    }
  }

  start(): void {
    this.off = this.deps.hub.onChange((change) => this.onChange(change))
    for (const watch of this.data.watches) this.schedule(watch, 5000)
  }

  stop(): void {
    this.off?.()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  rules(): HomeRules {
    return this.data
  }

  private save(): void {
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    renameSync(tmp, this.file)
    this.deps.onChange(this.data)
  }

  // ---------------------------------------------------------------------------
  // Judgment rules

  addJudgment(rule: Omit<JudgmentRule, 'id' | 'enabled'>): JudgmentRule {
    const full: JudgmentRule = { ...rule, id: newId('regla'), enabled: true, cooldownMin: Math.max(1, rule.cooldownMin || 10) }
    this.data = { ...this.data, judgment: [...this.data.judgment, full] }
    this.save()
    return full
  }

  toggleJudgment(id: string, enabled: boolean): void {
    this.data = { ...this.data, judgment: this.data.judgment.map((r) => (r.id === id ? { ...r, enabled } : r)) }
    this.save()
  }

  removeJudgment(id: string): boolean {
    const before = this.data.judgment.length
    this.data = { ...this.data, judgment: this.data.judgment.filter((r) => r.id !== id) }
    this.save()
    return this.data.judgment.length < before
  }

  private onChange(change: StateChange): void {
    const now = new Date()
    for (const rule of this.data.judgment) {
      if (!ruleMatches(rule, change, now)) continue
      rule.lastFiredAt = now.getTime()
      this.save()
      const name = this.deps.hub.thing(change.entityId)?.name ?? (change.attributes.friendly_name as string | undefined) ?? change.entityId
      this.deps.launch(rule, change, name)
    }
  }

  // ---------------------------------------------------------------------------
  // Camera watches

  startWatch(input: { entityId: string; cameraName: string; condition: string; everySec: number; minutes: number; repeat: boolean }): CameraWatch {
    const everySec = Math.max(MIN_EVERY_SEC, Math.round(input.everySec))
    const minutes = Math.min(Math.max(1, input.minutes), MAX_HOURS * 60)
    const watch: CameraWatch = { id: newId('vigia'), entityId: input.entityId, cameraName: input.cameraName, condition: input.condition, everySec, until: Date.now() + minutes * 60_000, startedAt: Date.now(), checks: 0, repeat: input.repeat }
    this.data = { ...this.data, watches: [...this.data.watches, watch] }
    this.save()
    this.schedule(watch, 1000)
    return watch
  }

  stopWatch(id: string): boolean {
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
    const before = this.data.watches.length
    this.data = { ...this.data, watches: this.data.watches.filter((w) => w.id !== id) }
    this.save()
    return this.data.watches.length < before
  }

  private schedule(watch: CameraWatch, delayMs: number): void {
    clearTimeout(this.timers.get(watch.id))
    this.timers.set(watch.id, setTimeout(() => void this.check(watch.id), delayMs))
  }

  private async check(id: string): Promise<void> {
    const watch = this.data.watches.find((w) => w.id === id)
    if (!watch) return
    if (Date.now() >= watch.until) {
      const ended = watchEndedNotice(this.deps.language?.() ?? 'es', watch.cameraName, watch.checks, watch.condition)
      this.deps.notify(ended.title, ended.body)
      this.stopWatch(id)
      return
    }
    if (this.running.has(id)) return
    this.running.add(id)
    let nextMs = watch.everySec * 1000
    try {
      if (this.deps.hub.ready) {
        const photo = await this.deps.hub.cameraSnapshot(watch.entityId)
        const answer = await this.deps.look(
          [{ mediaType: 'image/jpeg', data: photo.toString('base64') }],
          watchQuestion(watch.cameraName, watch.condition)
        )
        watch.checks++
        let verdict: { match?: boolean; note?: string } = {}
        try {
          verdict = extractJson(answer.text) as typeof verdict
        } catch {
          verdict = { match: false, note: answer.text.slice(0, 120) }
        }
        watch.lastNote = verdict.note
        if (verdict.match) {
          const matched = watchMatchNotice(this.deps.language?.() ?? 'es', watch.cameraName, watch.condition, verdict.note)
          this.deps.notify(matched.title, matched.body, photo)
          if (!watch.repeat) {
            this.stopWatch(id)
            return
          }
          // Keep watching, but don't send the same thing every few seconds.
          nextMs = Math.max(nextMs * 5, 120_000)
        }
        this.save()
      }
    } catch (error) {
      watch.lastNote = `Error: ${(error as Error).message}`.slice(0, 160)
    } finally {
      this.running.delete(id)
    }
    if (this.data.watches.some((w) => w.id === id)) this.schedule(watch, nextMs)
  }
}
