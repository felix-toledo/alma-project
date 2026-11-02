import * as z from 'zod/v4'
import { colleagues, subordinates } from '../../shared/company'
import { STATUS_NAMES } from '../company/engine'
import { parseLocalDateTime } from './routines'
import { defineTool, ToolError, type ToolContext, type ToolDefinition } from './types'

function seat(ctx: ToolContext): NonNullable<ToolContext['company']> {
  if (!ctx.company) throw new ToolError('Esta herramienta es solo para agentes de una empresa.')
  return ctx.company
}

const wrap = <T>(work: () => T): T => {
  try {
    return work()
  } catch (error) {
    throw new ToolError((error as Error).message)
  }
}

const assignTaskTool = defineTool({
  name: 'assign_task',
  description:
    'Le asigna una tarea a alguien de tu equipo (cualquiera que esté debajo tuyo en el organigrama). Se despierta y la hace por su cuenta; cuando la entrega te llega para revisar. Escribí la tarea completa: qué, para qué, dónde dejar el resultado y para cuándo.',
  risk: 'memory',
  standalone: true,
  schema: z.object({
    to: z.string().describe('id del integrante (ver tu equipo en el contexto)'),
    title: z.string().min(3),
    description: z.string().min(10),
    due: z.string().optional().describe('Para cuándo, si importa')
  }),
  async run({ to, title, description, due }, ctx) {
    const { company, memberId, engine } = seat(ctx)
    if (!subordinates(company, memberId).some((m) => m.id === to)) throw new ToolError('Solo podés asignarle tareas a tu equipo. Para tu jefe o un colega usá ask_colleague o escalate.')
    const task = wrap(() => engine.createTask(company, { title, description, assignee: to, createdBy: memberId, due }))
    return `Tarea ${task.id} asignada. Te llega para revisar cuando la entregue.`
  }
})

const updateTaskTool = defineTool({
  name: 'update_task',
  description: 'Reportá una tarea tuya: "review" cuando la entregás (la revisa quien la pidió), "done" si era tuya y ya está, "blocked" si no podés seguir (avisa a tu jefe). En result poné qué hiciste y dónde quedó.',
  risk: 'memory',
  standalone: true,
  schema: z.object({ id: z.string(), status: z.enum(['review', 'done', 'blocked']), result: z.string().min(3) }),
  async run({ id, status, result }, ctx) {
    const { company, memberId, engine } = seat(ctx)
    return wrap(() => engine.report(company, id, memberId, status, result))
  }
})

const reviewTaskTool = defineTool({
  name: 'review_task',
  description: 'Revisá una entrega de tu equipo: approve la da por terminada; changes la devuelve con qué corregir (sé concreto).',
  risk: 'memory',
  standalone: true,
  schema: z.object({ id: z.string(), decision: z.enum(['approve', 'changes']), comment: z.string().optional() }),
  async run({ id, decision, comment }, ctx) {
    const { company, memberId, engine } = seat(ctx)
    return wrap(() => engine.review(company, id, memberId, decision === 'approve', comment))
  }
})

const listTasksTool = defineTool({
  name: 'list_tasks',
  description: 'Lista tareas del tablero: las tuyas, las de tu equipo o las de toda la empresa (sin las terminadas, salvo que lo pidas).',
  risk: 'read',
  standalone: true,
  schema: z.object({ scope: z.enum(['mine', 'team', 'company']).optional(), include_done: z.boolean().optional() }),
  async run({ scope = 'mine', include_done = false }, ctx) {
    const { company, memberId, engine } = seat(ctx)
    const team = new Set([memberId, ...subordinates(company, memberId).map((m) => m.id)])
    const tasks = engine
      .snapshot(company.id)
      .tasks.filter((t) => include_done || t.status !== 'done')
      .filter((t) => scope === 'company' || (scope === 'mine' ? t.assignee === memberId : team.has(t.assignee)))
    if (!tasks.length) return 'No hay tareas.'
    const who = (id: string): string => (id === 'user' ? 'Directorio' : (company.members.find((m) => m.id === id)?.title ?? id))
    return tasks
      .map((t) => `- ${t.id} [${STATUS_NAMES[t.status]}] «${t.title}» → ${who(t.assignee)} (pidió ${t.createdBy === 'user' ? 'Directorio' : who(t.createdBy)})${t.due ? ` · para ${t.due}` : ''}`)
      .join('\n')
  }
})

const askColleagueTool = defineTool({
  name: 'ask_colleague',
  description: 'Le hacés una pregunta a tu jefe, a alguien de tu equipo o a un colega de línea punteada, y te responde ahora (sin crear una tarea). Para pedir trabajo usá assign_task.',
  risk: 'memory',
  standalone: true,
  schema: z.object({ to: z.string().describe('id del integrante'), question: z.string().min(5) }),
  async run({ to, question }, ctx) {
    const { company, memberId, engine, noAsk } = seat(ctx)
    if (noAsk) throw new ToolError('Ahora estás respondiendo una consulta: contestá con lo que sabés en vez de preguntarle a otro.')
    try {
      return (await engine.ask(company, memberId, to, question)) || '(no respondió)'
    } catch (error) {
      throw new ToolError((error as Error).message)
    }
  }
})

const escalateTool = defineTool({
  name: 'escalate',
  description: 'Le pasás algo a tu jefe (o al Directorio, el usuario, si no tenés jefe): una decisión que no te corresponde, un problema, un pedido de aprobación de un plan o un gasto.',
  risk: 'memory',
  standalone: true,
  schema: z.object({ message: z.string().min(10), task_id: z.string().optional() }),
  async run({ message, task_id }, ctx) {
    const { company, memberId, engine } = seat(ctx)
    return wrap(() => engine.escalate(company, memberId, message, task_id))
  }
})

const scheduleMeetingTool = defineTool({
  name: 'schedule_meeting',
  description:
    'Convoca una reunión: cada participante se prepara unas horas antes (por defecto 2) y a la hora se reúnen; vos moderás. Al final queda un acta en el vault y las tareas acordadas se asignan solas. Usala para decisiones que necesitan a varios, no para lo que se resuelve con una tarea.',
  risk: 'memory',
  standalone: true,
  schema: z.object({
    topic: z.string().min(3),
    agenda: z.array(z.string()).min(1).max(8),
    participants: z.array(z.string()).min(1).describe('ids de los participantes'),
    at: z.string().describe('Fecha y hora LOCAL "AAAA-MM-DDTHH:MM"'),
    prep_hours: z.number().min(0).max(48).optional()
  }),
  async run({ topic, agenda, participants, at, prep_hours = 2 }, ctx) {
    const { company, memberId, engine } = seat(ctx)
    const allowed = new Set([memberId, ...colleagues(company, memberId).map((m) => m.id), ...subordinates(company, memberId).map((m) => m.id)])
    const invalid = participants.filter((id) => !allowed.has(id))
    if (invalid.length) throw new ToolError(`No podés convocar a ${invalid.join(', ')}: solo a tu jefe, tu equipo y tus colegas.`)
    const meeting = wrap(() => engine.createMeeting(company, { topic, agenda, participants, chair: memberId, at: parseLocalDateTime(at), prepHours: prep_hours, createdBy: memberId }))
    return `Reunión ${meeting.id} convocada.`
  }
})

export const companyTools: ToolDefinition[] = [assignTaskTool, updateTaskTool, reviewTaskTool, listTasksTool, askColleagueTool, escalateTool, scheduleMeetingTool]
