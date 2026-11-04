import * as z from 'zod/v4'
import { colleagues, subordinates } from '../../shared/company'
import { translate } from '../../shared/i18n/messages'
import { parseLocalDateTime } from './routines'
import { defineTool, sayText, ToolError, toolText, type ToolContext, type ToolDefinition } from './types'

function seat(ctx: ToolContext): NonNullable<ToolContext['company']> {
  if (!ctx.company) throw new ToolError('tool.company.notMember')
  return ctx.company
}

const wrap = <T>(work: () => T): T => {
  try {
    return work()
  } catch (error) {
    throw error instanceof ToolError ? error : new ToolError('tool.error', { data: (error as Error).message })
  }
}

const assignTaskTool = defineTool({
  name: 'assign_task',
  description:
    'Assigns a task to someone on your team (anyone below you in the org chart). They wake up and do it on their own; when they deliver it, it comes to you for review. Write the whole task: what, what for, where to leave the result and by when.',
  risk: 'memory',
  standalone: true,
  schema: z.object({
    to: z.string().describe('id of the team member (see your team in the context)'),
    title: z.string().min(3),
    description: z.string().min(10),
    due: z.string().optional().describe('By when, if it matters')
  }),
  async run({ to, title, description, due }, ctx) {
    const { company, memberId, engine } = seat(ctx)
    if (!subordinates(company, memberId).some((m) => m.id === to)) throw new ToolError('tool.company.assignOnlyTeam')
    const task = wrap(() => engine.createTask(company, { title, description, assignee: to, createdBy: memberId, due }))
    return toolText(ctx, 'tool.company.assigned', { id: task.id })
  }
})

const updateTaskTool = defineTool({
  name: 'update_task',
  description: 'Report one of your tasks: "review" when you deliver it (whoever asked for it reviews it), "done" if it was yours and it is finished, "blocked" if you cannot go on (it notifies your boss). In result put what you did and where it ended up.',
  risk: 'memory',
  standalone: true,
  schema: z.object({ id: z.string(), status: z.enum(['review', 'done', 'blocked']), result: z.string().min(3) }),
  async run({ id, status, result }, ctx) {
    const { company, memberId, engine } = seat(ctx)
    return sayText(ctx, wrap(() => engine.report(company, id, memberId, status, result)))
  }
})

const reviewTaskTool = defineTool({
  name: 'review_task',
  description: 'Review a delivery from your team: approve marks it as finished; changes sends it back with what to fix (be specific).',
  risk: 'memory',
  standalone: true,
  schema: z.object({ id: z.string(), decision: z.enum(['approve', 'changes']), comment: z.string().optional() }),
  async run({ id, decision, comment }, ctx) {
    const { company, memberId, engine } = seat(ctx)
    return sayText(ctx, wrap(() => engine.review(company, id, memberId, decision === 'approve', comment)))
  }
})

const listTasksTool = defineTool({
  name: 'list_tasks',
  description: "Lists tasks on the board: yours, your team's or the whole company's (without the finished ones, unless you ask).",
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
    if (!tasks.length) return toolText(ctx, 'tool.company.noTasks')
    const who = (id: string): string => (id === 'user' ? 'Board' : (company.members.find((m) => m.id === id)?.title ?? id))
    return tasks
      .map((t) => `- ${t.id} [${translate('en', `task.status.${t.status}`)}] “${t.title}” → ${who(t.assignee)} (asked by ${t.createdBy === 'user' ? 'Board' : who(t.createdBy)})${t.due ? ` · for ${t.due}` : ''}`)
      .join('\n')
  }
})

const askColleagueTool = defineTool({
  name: 'ask_colleague',
  description: 'You ask a question to your boss, someone on your team or a dotted-line colleague, and they answer right now (without creating a task). To ask for work use assign_task.',
  risk: 'memory',
  standalone: true,
  schema: z.object({ to: z.string().describe('id of the member'), question: z.string().min(5) }),
  async run({ to, question }, ctx) {
    const { company, memberId, engine, noAsk } = seat(ctx)
    if (noAsk) throw new ToolError('tool.company.noAsk')
    try {
      return (await engine.ask(company, memberId, to, question)) || '(no answer)'
    } catch (error) {
      throw error instanceof ToolError ? error : new ToolError('tool.error', { data: (error as Error).message })
    }
  }
})

const escalateTool = defineTool({
  name: 'escalate',
  description: 'You pass something to your boss (or to the Board, the user, if you have no boss): a decision that is not yours to make, a problem, a request to approve a plan or an expense.',
  risk: 'memory',
  standalone: true,
  schema: z.object({ message: z.string().min(10), task_id: z.string().optional() }),
  async run({ message, task_id }, ctx) {
    const { company, memberId, engine } = seat(ctx)
    return sayText(ctx, wrap(() => engine.escalate(company, memberId, message, task_id)))
  }
})

const scheduleMeetingTool = defineTool({
  name: 'schedule_meeting',
  description:
    'Calls a meeting: each participant prepares a few hours before (2 by default) and at the time they meet; you moderate. At the end the minutes are left in the vault and the agreed tasks are assigned automatically. Use it for decisions that need several people, not for what a task can solve.',
  risk: 'memory',
  standalone: true,
  schema: z.object({
    topic: z.string().min(3),
    agenda: z.array(z.string()).min(1).max(8),
    participants: z.array(z.string()).min(1).describe('ids of the participants'),
    at: z.string().describe('LOCAL date and time "YYYY-MM-DDTHH:MM"'),
    prep_hours: z.number().min(0).max(48).optional()
  }),
  async run({ topic, agenda, participants, at, prep_hours = 2 }, ctx) {
    const { company, memberId, engine } = seat(ctx)
    const allowed = new Set([memberId, ...colleagues(company, memberId).map((m) => m.id), ...subordinates(company, memberId).map((m) => m.id)])
    const invalid = participants.filter((id) => !allowed.has(id))
    if (invalid.length) throw new ToolError('tool.company.noInvite', { names: invalid.join(', ') })
    const meeting = wrap(() => engine.createMeeting(company, { topic, agenda, participants, chair: memberId, at: parseLocalDateTime(at), prepHours: prep_hours, createdBy: memberId }))
    return toolText(ctx, 'tool.company.meetingScheduled', { id: meeting.id })
  }
})

export const companyTools: ToolDefinition[] = [assignTaskTool, updateTaskTool, reviewTaskTool, listTasksTool, askColleagueTool, escalateTool, scheduleMeetingTool]
