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
  /** Desktop notification + Telegram, for the board (the user). */
  notify(title: string, body: string): void
  emit(event: LiveEvent): void
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

  start(): void {
    this.timer = setInterval(() => this.tick(), TICK_MS)
    setTimeout(() => this.tick(), 8_000)
  }

  stop(): void {
    clearInterval(this.timer)
  }

  company(companyId: string): Company {
    const company = this.deps.settings().companies.find((c) => c.id === companyId)
    if (!company) throw new Error('Esa empresa no existe.')
    return company
  }

  private name(company: Company, actor: CompanyActor): string {
    return actorName(company, actor, this.deps.settings())
  }

  private changed(companyId: string): void {
    this.deps.store.save(companyId)
    this.deps.emit({ type: 'company.changed', companyId })
  }

  private log(company: Company, actor: CompanyActor, text: string, refs: { taskId?: string; meetingId?: string } = {}): void {
    this.deps.store.log(company.id, { actor, text, ...refs })
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
    if (company.budgetUsd > 0 && spend.totalUsd >= company.budgetUsd) return `la empresa llegó a su presupuesto del mes (USD ${company.budgetUsd})`
    if (member && member.budgetUsd > 0 && (spend.byMember[memberId] ?? 0) >= member.budgetUsd) return `${member.title} llegó a su presupuesto del mes (USD ${member.budgetUsd})`
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
          this.deps.notify(
            level === '100' ? `${company.name}: presupuesto agotado` : `${company.name}: 80 % del presupuesto`,
            `${who} gastó USD ${used.toFixed(2)} de ${cap} este mes${level === '100' ? '. Se pausa hasta que lo amplíes en Configuración → Equipos.' : '.'}`
          )
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
    if (input.assignee !== 'user' && !company.members.some((m) => m.id === input.assignee)) throw new Error(`No hay nadie con id «${input.assignee}» en ${company.name}.`)
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
    this.log(company, input.createdBy, `asignó «${task.title}» a ${this.name(company, task.assignee)}`, { taskId: task.id })
    this.changed(company.id)
    this.pump(company)
    return task
  }

  task(company: Company, taskId: string): CompanyTask {
    const task = this.deps.store.data(company.id).tasks.find((t) => t.id === taskId)
    if (!task) throw new Error(`No existe la tarea ${taskId}.`)
    return task
  }

  comment(company: Company, taskId: string, author: CompanyActor, text: string): void {
    const task = this.task(company, taskId)
    task.comments.push({ author, text, at: Date.now() })
    task.updatedAt = Date.now()
    this.log(company, author, `comentó en «${task.title}»`, { taskId })
    // A comment wakes the assignee (unless they wrote it): back to the queue if it was waiting or blocked.
    if (author !== task.assignee && task.assignee !== 'user' && (task.status === 'blocked' || task.status === 'review' || task.status === 'done')) task.status = 'todo'
    this.changed(company.id)
    this.pump(company)
  }

  move(company: Company, taskId: string, status: TaskStatus, actor: CompanyActor): void {
    const task = this.task(company, taskId)
    task.status = status
    task.updatedAt = Date.now()
    this.log(company, actor, `movió «${task.title}» a ${STATUS_NAMES[status]}`, { taskId })
    this.changed(company.id)
    this.pump(company)
  }

  remove(company: Company, taskId: string): void {
    const data = this.deps.store.data(company.id)
    data.tasks = data.tasks.filter((t) => t.id !== taskId)
    this.changed(company.id)
  }

  /** The assignee reports: delivered (review), finished (done when nobody else has to check), or blocked. */
  report(company: Company, taskId: string, memberId: string, status: 'review' | 'done' | 'blocked', text: string): string {
    const task = this.task(company, taskId)
    if (task.assignee !== memberId) throw new Error('Esa tarea no es tuya.')
    task.result = text
    task.updatedAt = Date.now()
    const needsReview = status !== 'blocked' && task.createdBy !== memberId
    task.status = status === 'blocked' ? 'blocked' : needsReview ? 'review' : 'done'
    this.log(company, memberId, status === 'blocked' ? `se trabó en «${task.title}»: ${text.slice(0, 120)}` : `entregó «${task.title}»`, { taskId })
    if (task.status === 'blocked') this.escalate(company, memberId, `Estoy trabado en «${task.title}»: ${text}`, taskId)
    this.changed(company.id)
    if (task.status === 'review') this.queueReview(company, task)
    return task.status === 'review' ? `Entregada; la revisa ${this.name(company, task.createdBy)}.` : task.status === 'done' ? 'Marcada como hecha.' : 'Marcada como trabada; avisé a tu jefe.'
  }

  /** The creator reviews: approve (done) or send back with what to change (at most twice, then it goes up). */
  review(company: Company, taskId: string, reviewer: CompanyActor, approve: boolean, comment = ''): string {
    const task = this.task(company, taskId)
    if (task.status !== 'review') throw new Error('Esa tarea no está esperando revisión.')
    if (reviewer !== 'user' && reviewer !== task.createdBy && !chainOfCommand(company, task.assignee).some((m) => m.id === reviewer))
      throw new Error('Solo quien la pidió o un jefe de quien la hizo puede revisarla.')
    if (comment) task.comments.push({ author: reviewer, text: comment, at: Date.now() })
    task.updatedAt = Date.now()
    if (approve) {
      task.status = 'done'
      this.log(company, reviewer, `aprobó «${task.title}»`, { taskId })
      this.changed(company.id)
      return 'Aprobada.'
    }
    task.revisions++
    if (task.revisions > MAX_REVISIONS) {
      task.status = 'blocked'
      this.log(company, reviewer, `devolvió «${task.title}» por ${task.revisions}ª vez: pasa al Directorio`, { taskId })
      this.deps.notify(`${company.name}: una tarea no sale`, `«${task.title}» volvió ${task.revisions} veces de revisión. Miralo en el tablero.`)
      this.changed(company.id)
      return 'Ya volvió demasiadas veces: quedó trabada y le avisé al Directorio.'
    }
    task.status = 'todo'
    this.log(company, reviewer, `pidió cambios en «${task.title}»`, { taskId })
    this.changed(company.id)
    this.pump(company)
    return 'Devuelta con tus comentarios.'
  }

  /** Something for the boss (or the board): a comment on the task, or a new task for them. */
  escalate(company: Company, memberId: string, message: string, taskId?: string): string {
    const boss = company.members.find((m) => m.id === company.members.find((x) => x.id === memberId)?.reportsTo)
    if (!boss) {
      this.log(company, memberId, `le escribió al Directorio: ${message.slice(0, 140)}`, { taskId })
      this.deps.notify(`${company.name}: ${this.name(company, memberId)}`, message)
      this.changed(company.id)
      return 'Le avisé al Directorio (el usuario).'
    }
    this.createTask(company, { title: `Consulta de ${this.name(company, memberId)}`, description: message + (taskId ? `\n\n(Sobre la tarea ${taskId})` : ''), assignee: boss.id, createdBy: memberId })
    return `Se lo pasé a ${this.name(company, boss.id)}.`
  }

  private reviewing = new Set<string>()

  private queueReview(company: Company, task: CompanyTask): void {
    if (task.createdBy === 'user') {
      this.deps.notify(`${company.name}: entrega para revisar`, `«${task.title}» de ${this.name(company, task.assignee)}`)
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
        return void this.comment(company, task.id, 'system', `No se pudo revisar: ${why}.`)
      }
      this.setWorking(company.id, reviewer, true)
      this.changed(company.id)
      const prompt = [
        `Revisá esta entrega de tu equipo y decidí con review_task (approve, o changes con qué corregir).`,
        `Tarea ${task.id}: ${task.title}`,
        task.description && `Pedido:\n${task.description}`,
        `Entrega de ${this.name(company, task.assignee)}:\n${task.result ?? '(sin texto)'}`,
        task.comments.length ? `Comentarios:\n${task.comments.map((c) => `- ${this.name(company, c.author)}: ${c.text}`).join('\n')}` : '',
        'Controlá que cumpla el pedido y el objetivo de la empresa, que los datos tengan fuente y que no haya nada inventado. Si está bien, aprobala sin vueltas.'
      ]
        .filter(Boolean)
        .join('\n\n')
      const { done } = this.deps.runMember(company, reviewer, `Revisión · ${task.title}`, prompt)
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
    this.log(company, task.assignee, `empezó «${task.title}»`, { taskId: task.id })
    const prompt = [
      `Tenés esta tarea del tablero de ${company.name}:`,
      `Tarea ${task.id}: ${task.title}`,
      task.description,
      task.due ? `Para: ${task.due}` : '',
      `La pidió ${this.name(company, task.createdBy)}.`,
      task.result ? `Tu entrega anterior:\n${task.result}` : '',
      task.comments.length ? `Comentarios (lo último manda):\n${task.comments.map((c) => `- ${this.name(company, c.author)}: ${c.text}`).join('\n')}` : '',
      'Hacela de punta a punta con tus herramientas. Al terminar, llamá a update_task con status "review" (o "done" si te la asignaste vos) y en result un resumen de lo que hiciste y dónde quedó (rutas del vault). Si no podés avanzar, update_task con status "blocked" y por qué.'
    ]
      .filter(Boolean)
      .join('\n\n')
    const { threadId, done } = this.deps.runMember(company, task.assignee, `Tarea · ${task.title}`, prompt)
    task.threadId = threadId
    this.changed(company.id)
    void done
      .then((answer) => {
        // The agent finished without reporting: what it said is the delivery.
        if (task.status === 'in_progress') this.report(company, task.id, task.assignee, 'review', answer || '(terminó sin un resumen)')
      })
      .catch((error: Error) => {
        task.status = 'blocked'
        task.comments.push({ author: 'system', text: `Falló: ${error.message}`, at: Date.now() })
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
      throw new Error('Solo podés consultar a tu jefe, a tu equipo y a tus colegas de línea punteada.')
    }
    const why = this.overBudget(company, to)
    if (why) throw new Error(`No puede responder: ${why}.`)
    const { done } = this.deps.runMember(company, to, `Consulta de ${this.name(company, from)}`, `${this.name(company, from)} te pregunta:\n\n${question}\n\nRespondé concreto y con fuentes si das datos.`, { noAsk: true })
    this.log(company, from, `le consultó a ${this.name(company, to)}`)
    this.changed(company.id)
    return done
  }

  // ---------------------------------------------------------------------------
  // Meetings

  createMeeting(company: Company, input: Omit<Meeting, 'id' | 'companyId' | 'status' | 'prep' | 'transcript'>): Meeting {
    const participants = [...new Set([input.chair, ...input.participants])].filter((id) => company.members.some((m) => m.id === id))
    if (!participants.includes(input.chair)) throw new Error('Quien modera tiene que ser de la empresa.')
    const meeting: Meeting = { ...input, participants, id: newId('m'), companyId: company.id, status: 'scheduled', prep: {}, transcript: [] }
    this.deps.store.data(company.id).meetings.push(meeting)
    this.log(company, input.createdBy, `convocó la reunión «${meeting.topic}» para el ${new Date(meeting.at).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })}`, { meetingId: meeting.id })
    this.changed(company.id)
    return meeting
  }

  meeting(company: Company, meetingId: string): Meeting {
    const meeting = this.deps.store.data(company.id).meetings.find((m) => m.id === meetingId)
    if (!meeting) throw new Error('Esa reunión no existe.')
    return meeting
  }

  say(company: Company, meetingId: string, text: string): void {
    const meeting = this.meeting(company, meetingId)
    if (meeting.status !== 'live') throw new Error('La reunión no está en curso.')
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
    this.log(company, 'user', `canceló la reunión «${meeting.topic}»`, { meetingId })
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
    this.log(company, 'system', `los participantes preparan «${meeting.topic}»`, { meetingId: meeting.id })
    this.changed(company.id)
    for (const memberId of meeting.participants) {
      if (meeting.prep[memberId] || this.ending.has(meeting.id)) continue
      const why = this.overBudget(company, memberId)
      if (why) {
        meeting.prep[memberId] = `(No preparó: ${why}.)`
        continue
      }
      this.setWorking(company.id, memberId, true)
      this.changed(company.id)
      const prompt = [
        `El ${new Date(meeting.at).toLocaleString('es', { dateStyle: 'full', timeStyle: 'short' })} hay reunión de ${company.name}: «${meeting.topic}».`,
        `Orden del día:\n${meeting.agenda.map((a, i) => `${i + 1}. ${a}`).join('\n')}`,
        `Participan: ${meeting.participants.map((id) => this.name(company, id)).join(', ')}.`,
        'Prepará tu parte: averiguá con tus herramientas lo que necesites (tareas, datos, vault, web) y respondé con tus puntos para la reunión en no más de 12 líneas: avances, datos con su fuente, problemas y propuestas concretas. No hace falta que hagas el trabajo ahora.'
      ].join('\n\n')
      try {
        const { done } = this.deps.runMember(company, memberId, `Preparación · ${meeting.topic}`, prompt, { noAsk: true })
        meeting.prep[memberId] = (await done) || '(sin notas)'
      } catch (error) {
        meeting.prep[memberId] = `(No pudo preparar: ${(error as Error).message})`
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
    this.log(company, 'system', `empezó la reunión «${meeting.topic}»`, { meetingId: meeting.id })
    this.changed(company.id)
    this.deps.notify(`${company.name}: empezó la reunión`, `«${meeting.topic}». Podés entrar desde Empresas → Reuniones.`)
    const others = meeting.participants.filter((id) => id !== meeting.chair)
    const maxTurns = Math.min(60, meeting.agenda.length * (others.length + 1) + 6)
    let turns = 0

    const speak = async (memberId: string, instruction: string): Promise<void> => {
      const profile = this.deps.settings().agents.find((a) => a.id === memberId)
      if (!profile || this.overBudget(company, memberId)) return
      const transcript = meeting.transcript.map((t) => `${this.name(company, t.speaker)}: ${t.text}`).join('\n\n')
      const system = `${profile.systemPrompt}\n\nEstás en una reunión de ${company.name} como ${this.name(company, memberId)}. Hablás en primera persona, breve (máximo 120 palabras), sin repetir lo que ya se dijo y sin saludos de cortesía. Si el Directorio (el usuario) habló, respondele primero.`
      const prompt = [
        `Reunión: «${meeting.topic}». Orden del día:\n${meeting.agenda.map((a, i) => `${i + 1}. ${a}`).join('\n')}`,
        meeting.prep[memberId] ? `Lo que preparaste:\n${meeting.prep[memberId]}` : '',
        transcript ? `Lo dicho hasta ahora:\n${transcript}` : '',
        instruction
      ]
        .filter(Boolean)
        .join('\n\n')
      this.setWorking(company.id, memberId, true)
      this.changed(company.id)
      try {
        const { text, usage } = await this.deps.complete(profile, system, prompt)
        if (usage) this.recordUsage(company, memberId, profile.provider, usage)
        if (text.trim()) meeting.transcript.push({ speaker: memberId, text: text.trim(), at: Date.now() })
      } catch (error) {
        meeting.transcript.push({ speaker: 'system', text: `${this.name(company, memberId)} no pudo hablar: ${(error as Error).message}`, at: Date.now() })
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
        await speak(meeting.chair, 'El Directorio acaba de hablar: respondele y, si cambia algo de la reunión, decilo.')
      }
    }

    const stop = (): boolean => this.ending.has(meeting.id) || turns >= maxTurns
    try {
      await speak(meeting.chair, 'Abrí la reunión: objetivo en una frase y arrancá con el primer punto.')
      for (let i = 0; i < meeting.agenda.length && !stop(); i++) {
        if (i > 0) await speak(meeting.chair, `Pasá al punto ${i + 1}: «${meeting.agenda[i]}».`)
        for (const memberId of others) {
          await hearUser()
          if (stop()) break
          await speak(memberId, `Punto ${i + 1}: «${meeting.agenda[i]}». Aportá lo tuyo.`)
        }
        await hearUser()
        if (!stop()) await speak(meeting.chair, `Cerrá el punto ${i + 1}: qué se decide y quién hace qué.`)
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
          'Escribís el acta de una reunión. Respondé SOLO con JSON válido, sin texto alrededor.',
          `Reunión «${meeting.topic}» de ${company.name}.\nParticipantes (id = nombre):\n${roster}\n\nTranscripción:\n${transcript}\n\nDevolvé {"summary": "3-5 frases", "decisions": ["…"], "actions": [{"owner": "id de un participante", "title": "…", "description": "qué hacer exactamente", "due": "fecha o vacío"}]}. Solo acciones que se acordaron.`
        )
        if (usage) this.recordUsage(company, chair.id, chair.provider, usage)
        parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
      } catch (error) {
        parsed = { summary: `No se pudo resumir: ${(error as Error).message}` }
      }
    }
    meeting.decisions = parsed.decisions ?? []
    const actions = (parsed.actions ?? []).filter((a) => meeting.participants.includes(a.owner) && a.title)
    const date = new Date(meeting.at)
    const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    const path = `Reuniones/${stamp} ${meeting.topic.replace(/[\\/:*?"<>|]/g, '-').slice(0, 60)}.md`
    const note = [
      `# ${meeting.topic}`,
      `${date.toLocaleString('es', { dateStyle: 'full', timeStyle: 'short' })} · Modera: ${this.name(company, meeting.chair)}`,
      `Participantes: ${meeting.participants.map((id) => this.name(company, id)).join(', ')}`,
      '## Resumen',
      parsed.summary ?? '',
      '## Decisiones',
      ...(meeting.decisions.length ? meeting.decisions.map((d) => `- ${d}`) : ['- (ninguna)']),
      '## Tareas',
      ...(actions.length ? actions.map((a) => `- [ ] ${a.title} — ${this.name(company, a.owner)}${a.due ? ` (para ${a.due})` : ''}`) : ['- (ninguna)']),
      '## Preparación',
      ...meeting.participants.map((id) => `### ${this.name(company, id)}\n${meeting.prep[id] ?? '(no preparó)'}`),
      '## Transcripción',
      ...meeting.transcript.map((t) => `**${this.name(company, t.speaker)}:** ${t.text}`)
    ].join('\n\n')
    try {
      await this.deps.writeNote(company, path, note)
      meeting.minutesPath = path
    } catch (error) {
      console.error('[company] minutes:', error)
    }
    meeting.status = 'done'
    this.log(company, meeting.chair, `cerró «${meeting.topic}»: ${meeting.decisions.length} decisiones, ${actions.length} tareas`, { meetingId: meeting.id })
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

export const STATUS_NAMES: Record<TaskStatus, string> = { todo: 'Por hacer', in_progress: 'En curso', review: 'En revisión', done: 'Hecho', blocked: 'Trabada' }
