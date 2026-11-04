// Runs companies: a task wakes its assignee for one run, the boss reviews, meetings prepare and then talk.
// Agents are asleep otherwise (nothing polls a model): they cost only when there is something concrete to do.
import { chainOfCommand, colleagues, costOf, head, newId, subordinates } from '../../shared/company'
import type {
  AgentProfile,
  Company,
  CompanyActor,
  CompanySnapshot,
  CompanyTask,
  LiveEvent,
  Meeting,
  ProviderId,
  Settings,
  TaskStatus,
  Usage
} from '../../shared/types'
import { formatDateTime } from '../../shared/i18n/format'
import type { Language } from '../../shared/i18n/language'
import { type MessageKey, type ParamsArg, translate } from '../../shared/i18n/messages'
import { namesOf, resolveName } from '../../shared/i18n/names'
import { askPrompt, MEETING_BOARD_SPOKE, MEETING_OPEN, MINUTES_SYSTEM, meetingClosePoint, meetingMemberPoint, meetingNextPoint, meetingPrepPrompt, meetingSystem, meetingTurnPrompt, minutesPrompt, reviewPrompt, taskPrompt } from '../prompts/company'
import type { ToolText } from '../../shared/types'
import { ToolError } from '../tools/types'
import { companyLog, minutesNote, summaryFailed, type CompanyLog } from '../generated'
import { companyNotice, type CompanyNotice } from '../notices'
import type { CompanyStore } from './store'

const MAX_REVISIONS = 2
const TICK_MS = 30_000
const HOUR = 3_600_000

export interface EngineDeps {
  settings(): Settings
  store: CompanyStore
  /** Runs a member's agent on a new conversation and resolves with its final answer. */
  runMember(company: Company, memberId: string, title: string, prompt: string, options?: { noAsk?: boolean }): { threadId: string; done: Promise<string> }
  /** One model call without tools (meeting turns, minutes); usage is recorded by the caller through `recordUsage`. */
  complete(profile: AgentProfile, system: string, prompt: string): Promise<{ text: string; usage?: Usage }>
  writeNote(company: Company, path: string, content: string): Promise<void>
  /** Whether a path already exists in the company's vault; without it the minutes folder takes the language's name. */
  noteExists?(company: Company, path: string): boolean
  /** Desktop notification + Telegram, for the board (the user). */
  notify(title: string, body: string): void
  emit(event: LiveEvent): void
}

/** `Reuniones/<date> <topic>.md` or `Meetings/…`: the folder that exists, the language's own when neither does (spec 025 BR-23). */
export function minutesPath(language: Language, date: Date, topic: string, exists: (name: string) => boolean): string {
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const folder = resolveName(language, namesOf('names.meetingsDir'), exists)
  // Windows rejects these characters and every control character (a topic may hold a line break).
  const safe = Array.from(topic, (c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? '-' : c)).join('')
  return `${folder}/${stamp} ${safe.slice(0, 60)}.md`
}

const actorName = (company: Company, actor: CompanyActor, settings: Settings): string => {
  if (actor === 'user') return 'el Directorio'
  if (actor === 'system') return 'Alma'
  const member = company.members.find((m) => m.id === actor)
  const agent = settings.agents.find((a) => a.id === actor)
  return member ? `${agent?.name ?? member.title} (${member.title})` : actor
}

export class CompanyEngine {
  private working = new Map<string, Set<string>>()
  private meetingInbox = new Map<string, string[]>()
  private ending = new Set<string>()
  private timer?: NodeJS.Timeout

  constructor(private deps: EngineDeps) {}

  /** Tells the person, in the app language of the moment. */
  private notice(notice: CompanyNotice): void {
    const { title, body } = companyNotice(this.deps.settings().language, notice)
    this.deps.notify(title, body)
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), TICK_MS)
    setTimeout(() => this.tick(), 8_000)
  }

  stop(): void {
    clearInterval(this.timer)
  }

  company(companyId: string): Company {
    const company = this.deps.settings().companies.find((c) => c.id === companyId)
    if (!company) throw new ToolError('tool.company.noCompany')
    return company
  }

  /** Text Alma writes into the company's own records: the language in effect when it is written, never rewritten. */
  private text<K extends MessageKey>(key: K, ...params: ParamsArg<K>): string {
    return translate(this.deps.settings().language, key, ...params)
  }

  private name(company: Company, actor: CompanyActor): string {
    return actorName(company, actor, this.deps.settings())
  }

  private changed(companyId: string): void {
    this.deps.store.save(companyId)
    this.deps.emit({ type: 'company.changed', companyId })
  }

  private log(company: Company, actor: CompanyActor, entry: CompanyLog, refs: { taskId?: string; meetingId?: string } = {}): void {
    this.deps.store.log(company.id, { actor, text: companyLog(this.deps.settings().language, entry), ...refs })
  }

  snapshot(companyId: string): CompanySnapshot {
    const data = this.deps.store.data(companyId)
    return {
      tasks: data.tasks,
      meetings: data.meetings,
      activity: data.activity.slice(-150),
      spend: this.deps.store.spend(companyId),
      working: [...(this.working.get(companyId) ?? [])]
    }
  }

  private setWorking(companyId: string, memberId: string, on: boolean): void {
    let set = this.working.get(companyId)
    if (!set) this.working.set(companyId, (set = new Set()))
    if (on) set.add(memberId)
    else set.delete(memberId)
  }

  isWorking(companyId: string, memberId: string): boolean {
    return this.working.get(companyId)?.has(memberId) ?? false
  }

  // ---------------------------------------------------------------------------
  // Budgets

  /** Why this member can't spend more this month, or null. */
  overBudget(company: Company, memberId: string): string | null {
    const spend = this.deps.store.spend(company.id)
    const member = company.members.find((m) => m.id === memberId)
    if (company.budgetUsd > 0 && spend.totalUsd >= company.budgetUsd) return this.text('company.budgetCompany', { amount: company.budgetUsd })
    if (member && member.budgetUsd > 0 && (spend.byMember[memberId] ?? 0) >= member.budgetUsd) return this.text('company.budgetMember', { title: member.title, amount: member.budgetUsd })
    return null
  }

  recordUsage(company: Company, memberId: string, provider: ProviderId, usage: Usage): void {
    const spend = this.deps.store.addSpend(company.id, memberId, costOf(provider, usage))
    const data = this.deps.store.data(company.id)
    const warn = (key: string, used: number, cap: number, who: string): void => {
      if (cap <= 0) return
      for (const [level, ratio] of [['100', 1], ['80', 0.8]] as const) {
        const id = `${spend.month}:${key}:${level}`
        if (used >= cap * ratio && !data.warned.includes(id)) {
          data.warned.push(id)
          this.notice({ kind: 'budget', level, company: company.name, who, used, cap })
          break
        }
      }
    }
    warn('company', spend.totalUsd, company.budgetUsd, 'La empresa')
    const member = company.members.find((m) => m.id === memberId)
    if (member) warn(member.id, spend.byMember[member.id] ?? 0, member.budgetUsd, member.title)
    this.changed(company.id)
  }

  // ---------------------------------------------------------------------------
  // Tasks

  createTask(company: Company, input: { title: string; description: string; assignee: string; createdBy: CompanyActor; due?: string; meetingId?: string }): CompanyTask {
    if (input.assignee !== 'user' && !company.members.some((m) => m.id === input.assignee)) throw new ToolError('tool.company.noMember', { id: input.assignee, company: company.name })
    const task: CompanyTask = {
      id: newId('t'),
      companyId: company.id,
      title: input.title.trim(),
      description: input.description.trim(),
      assignee: input.assignee,
      createdBy: input.createdBy,
      status: 'todo',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      due: input.due,
      comments: [],
      revisions: 0,
      meetingId: input.meetingId
    }
    this.deps.store.data(company.id).tasks.push(task)
    this.log(company, input.createdBy, { kind: 'assigned', title: task.title, assignee: this.name(company, task.assignee) }, { taskId: task.id })
    this.changed(company.id)
    this.pump(company)
    return task
  }

  task(company: Company, taskId: string): CompanyTask {
    const task = this.deps.store.data(company.id).tasks.find((t) => t.id === taskId)
    if (!task) throw new ToolError('tool.company.noTask', { id: taskId })
    return task
  }

  comment(company: Company, taskId: string, author: CompanyActor, text: string): void {
    const task = this.task(company, taskId)
    task.comments.push({ author, text, at: Date.now() })
    task.updatedAt = Date.now()
    this.log(company, author, { kind: 'commented', title: task.title }, { taskId })
    // A comment wakes the assignee (unless they wrote it): back to the queue if it was waiting or blocked.
    if (author !== task.assignee && task.assignee !== 'user' && (task.status === 'blocked' || task.status === 'review' || task.status === 'done')) task.status = 'todo'
    this.changed(company.id)
    this.pump(company)
  }

  move(company: Company, taskId: string, status: TaskStatus, actor: CompanyActor): void {
    const task = this.task(company, taskId)
    task.status = status
    task.updatedAt = Date.now()
    this.log(company, actor, { kind: 'moved', title: task.title, status }, { taskId })
    this.changed(company.id)
    this.pump(company)
  }

  remove(company: Company, taskId: string): void {
    const data = this.deps.store.data(company.id)
    data.tasks = data.tasks.filter((t) => t.id !== taskId)
    this.changed(company.id)
  }

  /** The assignee reports: delivered (review), finished (done when nobody else has to check), or blocked. */
  report(company: Company, taskId: string, memberId: string, status: 'review' | 'done' | 'blocked', text: string): ToolText {
    const task = this.task(company, taskId)
    if (task.assignee !== memberId) throw new ToolError('tool.company.notYours')
    task.result = text
    task.updatedAt = Date.now()
    const needsReview = status !== 'blocked' && task.createdBy !== memberId
    task.status = status === 'blocked' ? 'blocked' : needsReview ? 'review' : 'done'
    this.log(company, memberId, status === 'blocked' ? { kind: 'blocked', title: task.title, text: text.slice(0, 120) } : { kind: 'delivered', title: task.title }, { taskId })
    if (task.status === 'blocked') this.escalate(company, memberId, this.text('company.stuck', { title: task.title, text }), taskId)
    this.changed(company.id)
    if (task.status === 'review') this.queueReview(company, task)
    return task.status === 'review' ? { key: 'tool.company.reportReview', params: { name: this.name(company, task.createdBy) } } : task.status === 'done' ? { key: 'tool.company.reportDone' } : { key: 'tool.company.reportBlocked' }
  }

  /** The creator reviews: approve (done) or send back with what to change (at most twice, then it goes up). */
  review(company: Company, taskId: string, reviewer: CompanyActor, approve: boolean, comment = ''): ToolText {
    const task = this.task(company, taskId)
    if (task.status !== 'review') throw new ToolError('tool.company.notInReview')
    if (reviewer !== 'user' && reviewer !== task.createdBy && !chainOfCommand(company, task.assignee).some((m) => m.id === reviewer))
      throw new ToolError('tool.company.cannotReview')
    if (comment) task.comments.push({ author: reviewer, text: comment, at: Date.now() })
    task.updatedAt = Date.now()
    if (approve) {
      task.status = 'done'
      this.log(company, reviewer, { kind: 'approved', title: task.title }, { taskId })
      this.changed(company.id)
      return { key: 'tool.company.reviewApproved' }
    }
    task.revisions++
    if (task.revisions > MAX_REVISIONS) {
      task.status = 'blocked'
      this.log(company, reviewer, { kind: 'returnedToBoard', title: task.title, revisions: task.revisions }, { taskId })
      this.notice({ kind: 'stuck', company: company.name, title: task.title, revisions: task.revisions })
      this.changed(company.id)
      return { key: 'tool.company.reviewTooMany' }
    }
    task.status = 'todo'
    this.log(company, reviewer, { kind: 'changesRequested', title: task.title }, { taskId })
    this.changed(company.id)
    this.pump(company)
    return { key: 'tool.company.reviewChanges' }
  }

  /** Something for the boss (or the board): a comment on the task, or a new task for them. */
  escalate(company: Company, memberId: string, message: string, taskId?: string): ToolText {
    const boss = company.members.find((m) => m.id === company.members.find((x) => x.id === memberId)?.reportsTo)
    if (!boss) {
      this.log(company, memberId, { kind: 'escalated', message: message.slice(0, 140) }, { taskId })
      this.deps.notify(`${company.name}: ${this.name(company, memberId)}`, message)
      this.changed(company.id)
      return { key: 'tool.company.escalatedBoard' }
    }
    this.createTask(company, { title: this.text('company.title.ask', { name: this.name(company, memberId) }), description: message + (taskId ? `\n\n${this.text('company.aboutTask', { id: taskId })}` : ''), assignee: boss.id, createdBy: memberId })
    return { key: 'tool.company.escalatedTo', params: { name: this.name(company, boss.id) } }
  }

  private reviewing = new Set<string>()

  private queueReview(company: Company, task: CompanyTask): void {
    if (task.createdBy === 'user') {
      this.notice({ kind: 'delivery', company: company.name, title: task.title, who: this.name(company, task.assignee) })
      return
    }
    if (task.createdBy === 'system' || !company.members.some((m) => m.id === task.createdBy)) return
    if (this.reviewing.has(task.id)) return
    this.reviewing.add(task.id)
    const reviewer = task.createdBy
    const run = (): void => {
      if (this.isWorking(company.id, reviewer)) return void setTimeout(run, 15_000)
      const why = this.overBudget(company, reviewer)
      if (why) {
        this.reviewing.delete(task.id)
        return void this.comment(company, task.id, 'system', this.text('company.reviewSkipped', { why }))
      }
      this.setWorking(company.id, reviewer, true)
      this.changed(company.id)
      const prompt = reviewPrompt({
        id: task.id,
        title: task.title,
        description: task.description,
        assignee: this.name(company, task.assignee),
        result: task.result,
        comments: task.comments.map((c) => ({ author: this.name(company, c.author), text: c.text }))
      })
      const { done } = this.deps.runMember(company, reviewer, this.text('company.title.review', { title: task.title }), prompt)
      void done
        .catch(() => '')
        .finally(() => {
          this.reviewing.delete(task.id)
          this.setWorking(company.id, reviewer, false)
          this.changed(company.id)
          this.pump(company)
        })
    }
    run()
  }

  /** Starts the next queued task of every member who is free (one run per member at a time). */
  pump(company: Company): void {
    const data = this.deps.store.data(company.id)
    for (const task of data.tasks) {
      if (task.status !== 'todo' || task.assignee === 'user' || this.isWorking(company.id, task.assignee)) continue
      if (!company.members.some((m) => m.id === task.assignee)) continue
      const why = this.overBudget(company, task.assignee)
      if (why) {
        if (!task.comments.some((c) => c.author === 'system' && c.text.includes('presupuesto'))) {
          task.comments.push({ author: 'system', text: `En pausa: ${why}.`, at: Date.now() })
          this.changed(company.id)
        }
        continue
      }
      this.work(company, task)
    }
  }

  private work(company: Company, task: CompanyTask): void {
    task.status = 'in_progress'
    task.updatedAt = Date.now()
    this.setWorking(company.id, task.assignee, true)
    this.log(company, task.assignee, { kind: 'started', title: task.title }, { taskId: task.id })
    const prompt = taskPrompt({
      company: company.name,
      id: task.id,
      title: task.title,
      description: task.description,
      due: task.due,
      askedBy: this.name(company, task.createdBy),
      previousResult: task.result,
      comments: task.comments.map((c) => ({ author: this.name(company, c.author), text: c.text }))
    })
    const { threadId, done } = this.deps.runMember(company, task.assignee, this.text('company.title.task', { title: task.title }), prompt)
    task.threadId = threadId
    this.changed(company.id)
    void done
      .then((answer) => {
        // The agent finished without reporting: what it said is the delivery.
        if (task.status === 'in_progress') this.report(company, task.id, task.assignee, 'review', answer || this.text('company.noSummary'))
      })
      .catch((error: Error) => {
        task.status = 'blocked'
        task.comments.push({ author: 'system', text: this.text('company.failed', { error: error.message }), at: Date.now() })
      })
      .finally(() => {
        this.setWorking(company.id, task.assignee, false)
        this.changed(company.id)
        this.pump(company)
      })
  }

  /** ask_colleague: one run of the colleague, answered right away (they can't ask anyone else in turn). */
  async ask(company: Company, from: string, to: string, question: string): Promise<string> {
    if (!colleagues(company, from).some((m) => m.id === to) && !subordinates(company, from).some((m) => m.id === to)) {
      throw new ToolError('tool.company.cannotAsk')
    }
    const why = this.overBudget(company, to)
    if (why) throw new ToolError('tool.company.cannotAnswer', { why })
    const { done } = this.deps.runMember(company, to, this.text('company.title.ask', { name: this.name(company, from) }), askPrompt(this.name(company, from), question), { noAsk: true })
    this.log(company, from, { kind: 'consulted', to: this.name(company, to) })
    this.changed(company.id)
    return done
  }

  // ---------------------------------------------------------------------------
  // Meetings

  createMeeting(company: Company, input: Omit<Meeting, 'id' | 'companyId' | 'status' | 'prep' | 'transcript'>): Meeting {
    const participants = [...new Set([input.chair, ...input.participants])].filter((id) => company.members.some((m) => m.id === id))
    if (!participants.includes(input.chair)) throw new ToolError('tool.company.chair')
    const meeting: Meeting = { ...input, participants, id: newId('m'), companyId: company.id, status: 'scheduled', prep: {}, transcript: [] }
    this.deps.store.data(company.id).meetings.push(meeting)
    this.log(company, input.createdBy, { kind: 'meetingScheduled', topic: meeting.topic, date: formatDateTime(this.deps.settings().language, meeting.at, 'short') }, { meetingId: meeting.id })
    this.changed(company.id)
    return meeting
  }

  meeting(company: Company, meetingId: string): Meeting {
    const meeting = this.deps.store.data(company.id).meetings.find((m) => m.id === meetingId)
    if (!meeting) throw new ToolError('tool.company.noMeeting')
    return meeting
  }

  say(company: Company, meetingId: string, text: string): void {
    const meeting = this.meeting(company, meetingId)
    if (meeting.status !== 'live') throw new ToolError('tool.company.notLive')
    const inbox = this.meetingInbox.get(meetingId) ?? []
    inbox.push(text)
    this.meetingInbox.set(meetingId, inbox)
  }

  end(company: Company, meetingId: string): void {
    this.ending.add(meetingId)
  }

  cancel(company: Company, meetingId: string): void {
    const meeting = this.meeting(company, meetingId)
    if (meeting.status === 'done') return
    meeting.status = 'cancelled'
    this.ending.add(meetingId)
    this.log(company, 'user', { kind: 'meetingCancelled', topic: meeting.topic }, { meetingId })
    this.changed(company.id)
  }

  /** "Empezar ahora": prepare whoever hasn't, then meet. */
  startNow(company: Company, meetingId: string): void {
    const meeting = this.meeting(company, meetingId)
    if (meeting.status !== 'scheduled') return
    meeting.at = Date.now()
    void this.prepare(company, meeting).then(() => this.live(company, meeting))
  }

  tick(now = Date.now()): void {
    for (const company of this.deps.settings().companies) {
      for (const meeting of this.deps.store.data(company.id).meetings) {
        if (meeting.status !== 'scheduled') continue
        const prepared = meeting.participants.every((id) => meeting.prep[id])
        if (now >= meeting.at && prepared) void this.live(company, meeting)
        else if (now >= meeting.at - meeting.prepHours * HOUR && !prepared) void this.prepare(company, meeting)
      }
      this.pump(company)
    }
  }

  /** Each participant wakes up once, looks into what they'll bring (with tools), and writes it down. */
  private async prepare(company: Company, meeting: Meeting): Promise<void> {
    if (meeting.status !== 'scheduled') return
    meeting.status = 'preparing'
    this.log(company, 'system', { kind: 'meetingPreparing', topic: meeting.topic }, { meetingId: meeting.id })
    this.changed(company.id)
    for (const memberId of meeting.participants) {
      if (meeting.prep[memberId] || this.ending.has(meeting.id)) continue
      const why = this.overBudget(company, memberId)
      if (why) {
        meeting.prep[memberId] = this.text('company.prepSkipped', { why })
        continue
      }
      this.setWorking(company.id, memberId, true)
      this.changed(company.id)
      const prompt = meetingPrepPrompt({
        when: formatDateTime('en', meeting.at, 'long'),
        company: company.name,
        topic: meeting.topic,
        agenda: meeting.agenda,
        participants: meeting.participants.map((id) => this.name(company, id))
      })
      try {
        const { done } = this.deps.runMember(company, memberId, this.text('company.title.prep', { title: meeting.topic }), prompt, { noAsk: true })
        meeting.prep[memberId] = (await done) || this.text('company.noNotes')
      } catch (error) {
        meeting.prep[memberId] = this.text('company.prepFailed', { error: (error as Error).message })
      } finally {
        this.setWorking(company.id, memberId, false)
        this.changed(company.id)
      }
    }
    if (meeting.status === 'preparing') meeting.status = 'scheduled'
    this.changed(company.id)
  }

  /**
   * The meeting itself: no tools (cheap and quick). The chair opens, everyone speaks once per agenda item in org
   * order, the chair closes each item; whatever the user writes gets the floor next. Then the chair writes the
   * minutes: decisions, and action items that become tasks.
   */
  private async live(company: Company, meeting: Meeting): Promise<void> {
    if (meeting.status !== 'scheduled') return
    meeting.status = 'live'
    this.log(company, 'system', { kind: 'meetingStarted', topic: meeting.topic }, { meetingId: meeting.id })
    this.changed(company.id)
    this.notice({ kind: 'meeting', company: company.name, topic: meeting.topic })
    const others = meeting.participants.filter((id) => id !== meeting.chair)
    const maxTurns = Math.min(60, meeting.agenda.length * (others.length + 1) + 6)
    let turns = 0

    const speak = async (memberId: string, instruction: string): Promise<void> => {
      const profile = this.deps.settings().agents.find((a) => a.id === memberId)
      if (!profile || this.overBudget(company, memberId)) return
      const transcript = meeting.transcript.map((t) => `${this.name(company, t.speaker)}: ${t.text}`).join('\n\n')
      const system = meetingSystem(profile.systemPrompt, company.name, this.name(company, memberId), this.deps.settings().language)
      const prompt = meetingTurnPrompt({ topic: meeting.topic, agenda: meeting.agenda, prepared: meeting.prep[memberId], transcript, instruction })
      this.setWorking(company.id, memberId, true)
      this.changed(company.id)
      try {
        const { text, usage } = await this.deps.complete(profile, system, prompt)
        if (usage) this.recordUsage(company, memberId, profile.provider, usage)
        if (text.trim()) meeting.transcript.push({ speaker: memberId, text: text.trim(), at: Date.now() })
      } catch (error) {
        meeting.transcript.push({ speaker: 'system', text: this.text('company.speakFailed', { name: this.name(company, memberId), error: (error as Error).message }), at: Date.now() })
      } finally {
        this.setWorking(company.id, memberId, false)
        turns++
        this.changed(company.id)
      }
    }

    /** The user's interventions get the floor (the chair answers). */
    const hearUser = async (): Promise<void> => {
      const inbox = this.meetingInbox.get(meeting.id)
      while (inbox?.length && !this.ending.has(meeting.id)) {
        meeting.transcript.push({ speaker: 'user', text: inbox.shift()!, at: Date.now() })
        this.changed(company.id)
        await speak(meeting.chair, MEETING_BOARD_SPOKE)
      }
    }

    const stop = (): boolean => this.ending.has(meeting.id) || turns >= maxTurns
    try {
      await speak(meeting.chair, MEETING_OPEN)
      for (let i = 0; i < meeting.agenda.length && !stop(); i++) {
        if (i > 0) await speak(meeting.chair, meetingNextPoint(i + 1, meeting.agenda[i]))
        for (const memberId of others) {
          await hearUser()
          if (stop()) break
          await speak(memberId, meetingMemberPoint(i + 1, meeting.agenda[i]))
        }
        await hearUser()
        if (!stop()) await speak(meeting.chair, meetingClosePoint(i + 1))
      }
      await hearUser()
    } finally {
      this.ending.delete(meeting.id)
      this.meetingInbox.delete(meeting.id)
    }
    if ((meeting.status as Meeting['status']) === 'cancelled') return
    await this.minutes(company, meeting)
  }

  private async minutes(company: Company, meeting: Meeting): Promise<void> {
    const chair = this.deps.settings().agents.find((a) => a.id === meeting.chair)
    const roster = meeting.participants.map((id) => `${id} = ${this.name(company, id)}`).join('\n')
    const transcript = meeting.transcript.map((t) => `${this.name(company, t.speaker)}: ${t.text}`).join('\n\n')
    let parsed: { summary?: string; decisions?: string[]; actions?: { owner: string; title: string; description?: string; due?: string }[] } = {}
    if (chair) {
      try {
        const { text, usage } = await this.deps.complete(
          chair,
          MINUTES_SYSTEM,
          minutesPrompt({ topic: meeting.topic, company: company.name, roster, transcript })
        )
        if (usage) this.recordUsage(company, chair.id, chair.provider, usage)
        parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
      } catch (error) {
        parsed = { summary: summaryFailed(this.deps.settings().language, (error as Error).message) }
      }
    }
    meeting.decisions = parsed.decisions ?? []
    const actions = (parsed.actions ?? []).filter((a) => meeting.participants.includes(a.owner) && a.title)
    const date = new Date(meeting.at)
    const path = minutesPath(this.deps.settings().language, date, meeting.topic, (name) => this.deps.noteExists?.(company, name) ?? false)
    const note = minutesNote(this.deps.settings().language, {
      topic: meeting.topic,
      date: formatDateTime(this.deps.settings().language, date, 'long'),
      chair: this.name(company, meeting.chair),
      participants: meeting.participants.map((id) => ({ name: this.name(company, id), prep: meeting.prep[id] })),
      summary: parsed.summary ?? '',
      decisions: meeting.decisions,
      actions: actions.map((a) => ({ title: a.title, owner: this.name(company, a.owner), due: a.due })),
      transcript: meeting.transcript.map((t) => ({ speaker: this.name(company, t.speaker), text: t.text }))
    })
    try {
      await this.deps.writeNote(company, path, note)
      meeting.minutesPath = path
    } catch (error) {
      console.error('[company] minutes:', error)
    }
    meeting.status = 'done'
    this.log(company, meeting.chair, { kind: 'meetingClosed', topic: meeting.topic, decisions: meeting.decisions.length, actions: actions.length }, { meetingId: meeting.id })
    this.changed(company.id)
    for (const action of actions) {
      this.createTask(company, { title: action.title, description: action.description ?? action.title, assignee: action.owner, createdBy: meeting.chair, due: action.due || undefined, meetingId: meeting.id })
    }
  }

  /** Who runs the company's WhatsApp and chairs by default. */
  head(company: Company): string | undefined {
    return head(company)?.id
  }
}


