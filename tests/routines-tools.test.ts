import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../src/shared/defaults'
import type { Routine } from '../src/shared/types'
import { createReminderTool, createRoutineTool, deleteRoutineTool, listRoutinesTool } from '../src/coordinator/tools/routines'
import type { ToolContext } from '../src/coordinator/tools/types'

function context(): ToolContext & { saved: Routine[][] } {
  const saved: Routine[][] = []
  const ctx = {
    workspace: 'C:/trabajo',
    signal: new AbortController().signal,
    settings: defaultSettings(),
    host: { request: async () => ({ ok: true, message: '' }) },
    agentId: 'general',
    saved,
    saveRoutines(routines: Routine[]) {
      saved.push(routines)
      ctx.settings = { ...ctx.settings, routines }
    }
  }
  return ctx
}

describe('routine tools', () => {
  it('creates a one-off reminder from local time, lists it and deletes it', async () => {
    const ctx = context()
    const result = await createReminderTool.run({ message: 'Llamar al dentista', when: { type: 'once', at: '2099-10-21T10:00' } }, ctx)
    const [created] = ctx.saved[0]
    expect(created).toMatchObject({ action: 'reminder', prompt: 'Llamar al dentista', schedule: { kind: 'once', at: new Date(2099, 9, 21, 10, 0).getTime() } })
    expect(result).toContain(created.id)
    expect(await listRoutinesTool.run({}, ctx)).toContain('recordatorio · «Llamar al dentista»')
    await deleteRoutineTool.run({ id: created.id }, ctx)
    expect(ctx.settings.routines).toEqual([])
  })

  it('rejects dates in the past and unknown agents', async () => {
    const ctx = context()
    await expect(createReminderTool.run({ message: 'x', when: { type: 'once', at: '2001-01-01T10:00' } }, ctx)).rejects.toThrow(/ya pasó/)
    await expect(
      createRoutineTool.run({ name: 'Resumen', task: 'Resumí las novedades de la carpeta', when: { type: 'daily', time: '09:00' }, agent: 'nadie' }, ctx)
    ).rejects.toThrow(/No existe el agente/)
  })

  it('creates an agent routine in the conversation workspace that needs approval', async () => {
    const ctx = context()
    await createRoutineTool.run({ name: 'Resumen', task: 'Resumí las novedades de la carpeta', when: { type: 'daily', time: '09:00', days: [1] } }, ctx)
    expect(ctx.saved[0][0]).toMatchObject({ action: 'task', agentId: 'general', workspace: 'C:/trabajo', schedule: { kind: 'daily', time: '09:00', days: [1] } })
    expect(createRoutineTool.risk).toBe('write')
    expect(createReminderTool.risk).toBe('memory')
  })
})
