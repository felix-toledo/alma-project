import * as z from 'zod/v4'
import { formatDateTime } from '../../shared/i18n/format'
import { describeSchedule } from '../../shared/schedule'
import type { Routine, RoutineSchedule } from '../../shared/types'
import { defineTool, ToolError, toolText, type ToolContext, type ToolDefinition } from './types'

const When = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('once'),
    at: z.string().describe('LOCAL date and time without zone, format "YYYY-MM-DDTHH:MM", e.g. "2026-10-21T10:00"')
  }),
  z.object({
    type: z.literal('daily'),
    time: z.string().regex(/^\d{2}:\d{2}$/).describe('Local time "HH:MM"'),
    days: z.array(z.number().int().min(0).max(6)).optional().describe('0 = Sunday … 6 = Saturday; empty or absent = every day')
  }),
  z.object({
    type: z.literal('interval'),
    minutes: z.number().int().min(5).describe('Every how many minutes (minimum 5)')
  })
])

/** Local wall-clock "YYYY-MM-DDTHH:MM" → epoch ms. Strings with a zone are honored as written. */
export function parseLocalDateTime(text: string): number {
  const at = new Date(text.trim().replace(' ', 'T')).getTime()
  if (!Number.isFinite(at)) throw new ToolError('tool.routine.badDate', { text })
  return at
}

function toSchedule(when: z.infer<typeof When>, now = Date.now()): RoutineSchedule {
  if (when.type === 'interval') return { kind: 'interval', minutes: when.minutes }
  if (when.type === 'daily') return { kind: 'daily', time: when.time, days: when.days ?? [] }
  const at = parseLocalDateTime(when.at)
  if (at < now - 60_000) throw new ToolError('tool.routine.pastDate', { date: formatDateTime('en', at, 'short') })
  return { kind: 'once', at }
}

function routines(ctx: ToolContext): Routine[] {
  return ctx.settings.routines
}

function save(ctx: ToolContext, next: Routine[]): void {
  if (!ctx.saveRoutines) throw new ToolError('tool.routine.cannotSave')
  ctx.saveRoutines(next)
}

function newId(): string {
  return `rutina-${Math.random().toString(36).slice(2, 8)}`
}

export const createReminderTool = defineTool({
  name: 'create_reminder',
  description:
    'Schedules a reminder for the user (“remind me…”): at the given time they get a notification with the message (desktop, and Telegram if connected). It does not run any agent. Work out the date from the current date and time in the environment.',
  risk: 'memory',
  standalone: true,
  schema: z.object({
    message: z.string().min(2).describe('What to remind them of, in second person: "Call the dentist"'),
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
    return toolText(ctx, 'tool.routine.reminderCreated', { id: routine.id, message, schedule: describeSchedule(routine, 'en') })
  }
})

export const createRoutineTool = defineTool({
  name: 'create_routine',
  description:
    'Creates a routine: at the given time an agent runs a task on its own, in a new conversation (for example “every Monday at 9 summarize the news in my folder”). For a simple notice use create_reminder. Requires the user\'s approval.',
  risk: 'write',
  standalone: true,
  schema: z.object({
    name: z.string().min(3).describe('Short name for the routine'),
    task: z.string().min(10).describe('Complete, self-contained instructions for the agent: it will not see this conversation'),
    when: When,
    agent: z.string().optional().describe('id of the agent that runs it (default: you)'),
    workspace: z.string().optional().describe('Absolute working folder (default: this conversation\'s)')
  }),
  async run({ name, task, when, agent, workspace }, ctx) {
    const agentId = agent ?? ctx.agentId ?? ctx.settings.defaultAgentId
    if (!ctx.settings.agents.some((a) => a.id === agentId)) throw new ToolError('tool.routine.noAgent', { id: agentId })
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
    return toolText(ctx, 'tool.routine.routineCreated', { id: routine.id, name, schedule: describeSchedule(routine, 'en') })
  }
})

export const listRoutinesTool = defineTool({
  name: 'list_routines',
  description: 'Lists the scheduled reminders and routines, with their id, when they fire and whether they are active.',
  risk: 'read',
  standalone: true,
  schema: z.object({}),
  async run(_input, ctx) {
    const list = routines(ctx)
    if (list.length === 0) return toolText(ctx, 'tool.routine.none')
    return list
      .map((r) => `- ${r.id} · ${r.action === 'reminder' ? 'reminder' : 'routine'} · “${r.name}” · ${describeSchedule(r, 'en')}${r.enabled ? '' : ' · paused'}`)
      .join('\n')
  }
})

export const deleteRoutineTool = defineTool({
  name: 'delete_routine',
  description: 'Deletes a reminder or a routine by its id (get it with list_routines).',
  risk: 'memory',
  standalone: true,
  schema: z.object({ id: z.string().describe('id of the routine, e.g. "rutina-ab12cd"') }),
  async run({ id }, ctx) {
    const target = routines(ctx).find((r) => r.id === id)
    if (!target) throw new ToolError('tool.routine.noRoutine', { id })
    save(ctx, routines(ctx).filter((r) => r.id !== id))
    return toolText(ctx, 'tool.routine.deleted', { name: target.name })
  }
})

/** Available to every agent: scheduling is an app feature, not tied to the workspace. */
export const routineTools: ToolDefinition[] = [createReminderTool, createRoutineTool, listRoutinesTool, deleteRoutineTool]
