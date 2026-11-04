import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canReportTo, colleagues, subordinates } from '../src/shared/company'
import { CompanyEngine, type EngineDeps } from '../src/coordinator/company/engine'
import { CompanyStore } from '../src/coordinator/company/store'
import { defaultSettings } from '../src/shared/defaults'
import type { Company, Settings } from '../src/shared/types'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20))

function setup(budgetUsd = 0) {
  const company: Company = {
    id: 'acme',
    name: 'Acme',
    mission: 'Vender cosas',
    goals: 'Vender más',
    vault: join(tmpdir(), 'acme-vault'),
    color: '#000',
    budgetUsd,
    members: [
      { id: 'ceo', title: 'CEO', reportsTo: null, collaborates: [], budgetUsd: 0 },
      { id: 'ana', title: 'Analista', reportsTo: 'ceo', collaborates: [], budgetUsd: 0 },
      { id: 'mkt', title: 'Marketing', reportsTo: 'ceo', collaborates: ['ana'], budgetUsd: 0 }
    ],
    email: { address: '', imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465 },
    whatsapp: false,
    createdAt: 0
  }
  const settings: Settings = { ...defaultSettings(), companies: [company] }
  const runs: { member: string; title: string; prompt: string }[] = []
  const notes: Record<string, string> = {}
  let engine!: CompanyEngine
  const deps: EngineDeps = {
    settings: () => settings,
    store: new CompanyStore(mkdtempSync(join(tmpdir(), 'alma-company-'))),
    runMember: (_c, member, title, prompt) => {
      runs.push({ member, title, prompt })
      const id = /Task (t-\w+)/.exec(prompt)?.[1]
      // Fake agents: the assignee delivers; a boss reviewing approves.
      const done = Promise.resolve().then(() => {
        if (title.startsWith('Tarea') && id) engine.report(company, id, member, 'review', `hecho por ${member}`)
        if (title.startsWith('Revisión') && id) engine.review(company, id, member, true, 'bien')
        return `respuesta de ${member}`
      })
      return { threadId: `th-${runs.length}`, done }
    },
    complete: async (profile, _system, prompt) =>
      prompt.includes('Return {') ? { text: JSON.stringify({ summary: 'ok', decisions: ['Lanzar'], actions: [{ owner: 'mkt', title: 'Campaña', description: 'Armar la campaña' }] }) } : { text: `habla ${profile.id}` },
    writeNote: async (_c, path, content) => void (notes[path] = content),
    notify: () => {},
    emit: () => {}
  }
  settings.agents = [...settings.agents, ...company.members.map((m) => ({ ...settings.agents[0], id: m.id, name: m.title, companyId: company.id }))]
  engine = new CompanyEngine(deps)
  return { company, engine, runs, notes, deps }
}

describe('org chart', () => {
  it('knows who is below, who can be asked, and refuses loops', () => {
    const { company } = setup()
    expect(subordinates(company, 'ceo').map((m) => m.id)).toEqual(['ana', 'mkt'])
    expect(colleagues(company, 'ana').map((m) => m.id).sort()).toEqual(['ceo', 'mkt'])
    expect(canReportTo(company, 'ceo', 'ana')).toBe(false)
    expect(canReportTo(company, 'ana', 'mkt')).toBe(true)
  })
})

describe('company engine', () => {
  it('a boss assigns, the assignee delivers once, the boss reviews and approves', async () => {
    const { company, engine, runs } = setup()
    const task = engine.createTask(company, { title: 'Informe', description: 'Ventas de octubre', assignee: 'ana', createdBy: 'ceo' })
    await flush()
    await flush()
    expect(runs.map((r) => `${r.member}:${r.title}`)).toEqual(['ana:Tarea · Informe', 'ceo:Revisión · Informe'])
    expect(engine.task(company, task.id).status).toBe('done')
    expect(engine.task(company, task.id).result).toBe('hecho por ana')
  })

  it("the board's own tasks wait for the user's review, and changes send it back", async () => {
    const { company, engine, runs } = setup()
    const task = engine.createTask(company, { title: 'Plan', description: 'Plan del mes', assignee: 'ceo', createdBy: 'user' })
    await flush()
    expect(engine.task(company, task.id).status).toBe('review')
    engine.review(company, task.id, 'user', false, 'Más detalle')
    await flush()
    expect(runs.filter((r) => r.member === 'ceo')).toHaveLength(2)
    expect(engine.task(company, task.id).revisions).toBe(1)
  })

  it('stops waking agents once the budget is spent', async () => {
    const { company, engine, runs } = setup(1)
    engine.recordUsage(company, 'ana', 'anthropic', { inputTokens: 1_000_000, outputTokens: 100_000 })
    expect(engine.overBudget(company, 'ana')).toContain('presupuesto')
    engine.createTask(company, { title: 'Otra', description: 'x', assignee: 'ana', createdBy: 'ceo' })
    await flush()
    expect(runs).toHaveLength(0)
  })

  it('a meeting prepares, talks by turns and leaves minutes and tasks', async () => {
    const { company, engine, notes } = setup()
    const meeting = engine.createMeeting(company, { topic: 'Noviembre', agenda: ['Ventas', 'Campaña'], participants: ['ana', 'mkt'], chair: 'ceo', at: Date.now(), prepHours: 2, createdBy: 'user' })
    engine.startNow(company, meeting.id)
    for (let i = 0; i < 10; i++) await flush()
    const done = engine.meeting(company, meeting.id)
    expect(done.status).toBe('done')
    expect(Object.keys(done.prep).sort()).toEqual(['ana', 'ceo', 'mkt'])
    expect(done.transcript.map((t) => t.speaker)).toEqual(['ceo', 'ana', 'mkt', 'ceo', 'ceo', 'ana', 'mkt', 'ceo'])
    expect(Object.keys(notes)[0]).toMatch(/^Reuniones\/.* Noviembre\.md$/)
    expect(engine.snapshot(company.id).tasks.some((t) => t.title === 'Campaña' && t.assignee === 'mkt' && t.meetingId === meeting.id)).toBe(true)
  })
})
