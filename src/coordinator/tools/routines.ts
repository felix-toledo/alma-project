import * as z from 'zod/v4'
import { describeSchedule } from '../../shared/schedule'
import type { Routine, RoutineSchedule } from '../../shared/types'
import { defineTool, ToolError, type ToolContext, type ToolDefinition } from './types'

const When = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('once'),
    at: z.string().describe('Fecha y hora LOCAL sin zona, formato "AAAA-MM-DDTHH:MM", p. ej. "2026-10-21T10:00"')
  }),
  z.object({
    type: z.literal('daily'),
    time: z.string().regex(/^\d{2}:\d{2}$/).describe('Hora local "HH:MM"'),
    days: z.array(z.number().int().min(0).max(6)).optional().describe('0 = domingo … 6 = sábado; vacío o ausente = todos los días')
  }),
  z.object({
    type: z.literal('interval'),
    minutes: z.number().int().min(5).describe('Cada cuántos minutos (mínimo 5)')
  })
])

/** Local wall-clock "YYYY-MM-DDTHH:MM" → epoch ms. Strings with a zone are honored as written. */
export function parseLocalDateTime(text: string): number {
  const at = new Date(text.trim().replace(' ', 'T')).getTime()
  if (!Number.isFinite(at)) throw new ToolError(`Fecha inválida: «${text}». Usá "AAAA-MM-DDTHH:MM".`)
  return at
}

function toSchedule(when: z.infer<typeof When>, now = Date.now()): RoutineSchedule {
  if (when.type === 'interval') return { kind: 'interval', minutes: when.minutes }
  if (when.type === 'daily') return { kind: 'daily', time: when.time, days: when.days ?? [] }
  const at = parseLocalDateTime(when.at)
  if (at < now - 60_000) throw new ToolError(`Esa fecha ya pasó (${new Date(at).toLocaleString('es')}). Revisá la fecha actual en el entorno.`)
  return { kind: 'once', at }
}

function routines(ctx: ToolContext): Routine[] {
  return ctx.settings.routines
}

function save(ctx: ToolContext, next: Routine[]): void {
  if (!ctx.saveRoutines) throw new ToolError('No se pueden guardar rutinas desde acá.')
  ctx.saveRoutines(next)
}

function newId(): string {
  return `rutina-${Math.random().toString(36).slice(2, 8)}`
}

export const createReminderTool = defineTool({
  name: 'create_reminder',
  description:
    'Programa un recordatorio para el usuario («haceme acordar…»): a la hora indicada le llega una notificación con el mensaje (escritorio y Telegram si está conectado). No ejecuta ningún agente. Calculá la fecha a partir de la fecha y hora actuales del entorno.',
  risk: 'memory',
  standalone: true,
  schema: z.object({
    message: z.string().min(2).describe('Lo que hay que recordarle, en segunda persona: "Llamar al dentista"'),
    when: When
  }),
  async run({ message, when }, ctx) {
    const schedule = toSchedule(when)
    const routine: Routine = {
      id: newId(),
      name: message.length > 60 ? `${message.slice(0, 57)}…` : message,
      agentId: ctx.agentId ?? ctx.settings.defaultAgentId,
      workspace: '',
      prompt: message,
      schedule,
      enabled: true,
      createdAt: Date.now(),
      action: 'reminder'
    }
    save(ctx, [...routines(ctx), routine])
    return `Recordatorio creado (${routine.id}): «${message}», ${describeSchedule(routine)}.`
  }
})

export const createRoutineTool = defineTool({
  name: 'create_routine',
  description:
    'Crea una rutina: a la hora indicada un agente ejecuta solo una tarea, en una conversación nueva (por ejemplo «todos los lunes a las 9 resumime las novedades de mi carpeta»). Para un simple aviso usá create_reminder. Requiere la aprobación del usuario.',
  risk: 'write',
  standalone: true,
  schema: z.object({
    name: z.string().min(3).describe('Nombre corto de la rutina'),
    task: z.string().min(10).describe('Instrucciones completas y autosuficientes para el agente: no verá esta conversación'),
    when: When,
    agent: z.string().optional().describe('id del agente que la ejecuta (por defecto, vos)'),
    workspace: z.string().optional().describe('Carpeta de trabajo absoluta (por defecto, la de esta conversación)')
  }),
  async run({ name, task, when, agent, workspace }, ctx) {
    const agentId = agent ?? ctx.agentId ?? ctx.settings.defaultAgentId
    if (!ctx.settings.agents.some((a) => a.id === agentId)) throw new ToolError(`No existe el agente "${agentId}".`)
    const routine: Routine = {
      id: newId(),
      name,
      agentId,
      workspace: workspace ?? ctx.workspace,
      prompt: task,
      schedule: toSchedule(when),
      enabled: true,
      createdAt: Date.now(),
      action: 'task'
    }
    save(ctx, [...routines(ctx), routine])
    return `Rutina creada (${routine.id}): «${name}», ${describeSchedule(routine)}.`
  }
})

export const listRoutinesTool = defineTool({
  name: 'list_routines',
  description: 'Lista los recordatorios y rutinas programados, con su id, cuándo suenan y si están activos.',
  risk: 'read',
  standalone: true,
  schema: z.object({}),
  async run(_input, ctx) {
    const list = routines(ctx)
    if (list.length === 0) return 'No hay recordatorios ni rutinas.'
    return list
      .map((r) => `- ${r.id} · ${r.action === 'reminder' ? 'recordatorio' : 'rutina'} · «${r.name}» · ${describeSchedule(r)}${r.enabled ? '' : ' · pausada'}`)
      .join('\n')
  }
})

export const deleteRoutineTool = defineTool({
  name: 'delete_routine',
  description: 'Borra un recordatorio o una rutina por su id (obtenelo con list_routines).',
  risk: 'memory',
  standalone: true,
  schema: z.object({ id: z.string().describe('id de la rutina, p. ej. "rutina-ab12cd"') }),
  async run({ id }, ctx) {
    const target = routines(ctx).find((r) => r.id === id)
    if (!target) throw new ToolError(`No existe la rutina ${id}. Usá list_routines para ver los ids.`)
    save(ctx, routines(ctx).filter((r) => r.id !== id))
    return `Borrado: «${target.name}».`
  }
})

/** Available to every agent: scheduling is an app feature, not tied to the workspace. */
export const routineTools: ToolDefinition[] = [createReminderTool, createRoutineTool, listRoutinesTool, deleteRoutineTool]
