import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod/v4'
import type { Provider, TurnResult } from '../src/coordinator/providers/types'
import { createReminderTool } from '../src/coordinator/tools/routines'
import { emailSendTool } from '../src/coordinator/tools/email'
import { instagramPublishTool } from '../src/coordinator/tools/media'
import { defineTool, type ToolContext, type ToolError } from '../src/coordinator/tools/types'
import { sendWhatsAppTool, whatsAppRecentTool } from '../src/coordinator/tools/whatsapp'
import { describeSchedule } from '../src/shared/schedule'
import { defaultSettings } from '../src/shared/defaults'
import type { AgentProfile, Language, Routine, Settings, Thread } from '../src/shared/types'

const electron = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => electron.userData },
  safeStorage: { isEncryptionAvailable: () => false }
}))

import { approvalNotice, companyNotice, reminderNotice, routineNotice, ruleFailedNotice, watchEndedNotice, watchMatchNotice } from '../src/coordinator/notices'
import { localNow } from '../src/coordinator/agent'
import { authorize } from '../src/coordinator/approval'
import { companyLog, houseThreadTitle, memoryHeader, minutesNote, routineThreadTitle, summaryFailed } from '../src/coordinator/generated'
import { KnowledgeBase, MEMORY_FILE } from '../src/coordinator/knowledge/base'
import { ThreadStore } from '../src/coordinator/store'
import { approvalButtons, approvalPrompt, approvalToast, describeTelegramError } from '../src/coordinator/channels/texts'
import { translate, translateText } from '../src/shared/i18n/messages'
import { XaiProvider, DEEPSEEK } from '../src/coordinator/providers/xai'
import { mainError, securityDialog, trayMenu } from '../src/main/messages'
import { SettingsStore } from '../src/main/settings'

const file = (): string => join(electron.userData, 'settings.json')
const onDisk = (): Record<string, unknown> => JSON.parse(readFileSync(file(), 'utf8'))

beforeEach(() => {
  electron.userData = mkdtempSync(join(tmpdir(), 'alma-i18n-'))
})
afterEach(() => rmSync(electron.userData, { recursive: true, force: true }))

describe('the language setting in the store', () => {
  it('AC-1.1 with nothing saved the language is the resolved system language', () => {
    expect(new SettingsStore(['es-MX']).get().language).toBe('es')
    expect(new SettingsStore(['en-GB']).get().language).toBe('en')
    expect(new SettingsStore(['fr']).get().language).toBe('en')
    expect(new SettingsStore([]).get().language).toBe('en')
  })

  it('AC-8.1 on a first load the shipped agents and review instructions are written in the language in effect', () => {
    const en = new SettingsStore(['en-US']).get()
    expect(en.agents.find((a) => a.id === 'investigador')?.name).toBe('Researcher')
    expect(en.autoReview.instructions).toMatch(/^Flag as dangerous/)
    const es = new SettingsStore(['es-AR']).get()
    expect(es.agents.find((a) => a.id === 'investigador')?.name).toBe('Investigador')
    expect(es.autoReview.instructions).toMatch(/^Marcá como peligrosa/)
  })

  it('AC-8.2 changing the language migrates the default agents nobody edited and leaves the edited ones as they are', () => {
    const store = new SettingsStore(['es'])
    store.update({ agents: store.get().agents.map((a) => (a.id === 'revisor' ? { ...a, systemPrompt: `${a.systemPrompt}\nNunca revises tests.` } : a)) })
    store.update({ language: 'en' })
    const agents = store.get().agents
    expect(agents.find((a) => a.id === 'investigador')?.name).toBe('Researcher')
    expect(agents.find((a) => a.id === 'revisor')?.systemPrompt).toMatch(/^Sos un revisor de código[\s\S]*Nunca revises tests\.$/)
    expect(store.get().autoReview.instructions).toMatch(/^Flag as dangerous/)
    expect((onDisk().agents as { id: string; name: string }[]).find((a) => a.id === 'investigador')?.name).toBe('Researcher')
    store.update({ language: 'es' })
    expect(store.get().agents.find((a) => a.id === 'investigador')?.name).toBe('Investigador')
  })

  it('AC-1.4 choosing a language saves it, carries it in the public settings and keeps it across a restart', () => {
    const store = new SettingsStore(['es'])
    const updated = store.update({ language: 'en' })
    expect(updated.language).toBe('en')
    expect(store.get().language).toBe('en')
    expect(store.getPublic().language).toBe('en')
    expect(onDisk().language).toBe('en')
    // AC-1.5: the window, the tray and the coordinator all read it from here on the next start
    expect(new SettingsStore(['es']).get().language).toBe('en')
  })

  it('AC-1.2 a saved language wins whatever the system language is', () => {
    writeFileSync(file(), JSON.stringify({ language: 'es' }))
    expect(new SettingsStore(['en-US']).get().language).toBe('es')
    writeFileSync(file(), JSON.stringify({ language: 'en' }))
    expect(new SettingsStore(['es-AR']).get().language).toBe('en')
  })

  it('AC-1.5 with no explicit choice the language keeps following the system and is never written', () => {
    const first = new SettingsStore(['es'])
    first.update({ approvalMode: 'always-allow' })
    expect('language' in onDisk()).toBe(false)
    expect(new SettingsStore(['en']).get().language).toBe('en')
    expect(new SettingsStore(['es']).get().language).toBe('es')
  })

  it('AC-1.3 an invalid saved value does not throw and reads as if none was saved', () => {
    for (const bad of ['fr', 7, null, {}, '']) {
      writeFileSync(file(), JSON.stringify({ language: bad, approvalMode: 'always-allow' }))
      const store = new SettingsStore(['es'])
      expect(store.get().language).toBe('es')
      // the rest of the file still loads
      expect(store.get().approvalMode).toBe('always-allow')
      store.update({ defaultWorkspace: 'x' })
      expect('language' in onDisk()).toBe(false)
    }
  })

  it('AC-3.3 the rejection of a bad language is worded in the language in effect', () => {
    expect(() => new SettingsStore(['en']).update({ language: 'fr' as never })).toThrow('Invalid language')
  })

  it('AC-1.4 an invalid value is rejected at the boundary and changes nothing', () => {
    const store = new SettingsStore(['es'])
    for (const bad of ['fr', 7, null, {}, 'EN']) {
      expect(() => store.update({ language: bad as never })).toThrow('Idioma no válido')
      expect(store.get().language).toBe('es')
    }
    expect(() => store.update({ language: 'en', approvalMode: 'always-allow' })).not.toThrow()
    expect(() => store.update({ language: 'fr' as never, defaultWorkspace: 'nope' })).toThrow()
    expect(store.get().defaultWorkspace).toBe('')
    expect(store.get().language).toBe('en')
  })
})

// A scripted provider, as in tests/agent.test.ts: every model turn pops the next prepared answer.
let turns: TurnResult[] = []
let beforeTurn: (index: number) => void = () => {}
let turnIndex = 0
const fakeProvider: Provider = {
  id: 'anthropic',
  streamTurn: async () => {
    beforeTurn(turnIndex++)
    const next = turns.shift()
    if (!next) throw new Error('script ran out of turns')
    return next
  },
  review: async () => ({ verdict: 'allow', reason: 'ok' }),
  listModels: async () => []
}
vi.mock('../src/coordinator/providers', () => ({ getProvider: () => fakeProvider }))

const { runAgent } = await import('../src/coordinator/agent')
const { ApprovalBroker } = await import('../src/coordinator/approval')
const { McpManager } = await import('../src/coordinator/mcp')
const { builtinToolsByName } = await import('../src/coordinator/tools')

const call = (id: string, name: string, input: unknown): TurnResult => ({
  content: [{ type: 'tool_use', id, name, input }],
  stopReason: 'tool_use',
  model: 'fake'
})
const done: TurnResult = { content: [{ type: 'text', text: 'listo' }], stopReason: 'end_turn', model: 'fake' }

describe('the language of a run in progress', () => {
  let seen: unknown[]
  let live: Settings

  beforeEach(() => {
    seen = []
    live = { ...defaultSettings(), language: 'es' }
    turns = []
    turnIndex = 0
    beforeTurn = () => {}
    builtinToolsByName.set(
      'language_probe',
      defineTool({
        name: 'language_probe',
        description: 'records the language of the run it runs in',
        risk: 'read',
        standalone: true,
        schema: z.object({}),
        run: async (_input, ctx) => {
          seen.push(ctx.language)
          return 'ok'
        }
      })
    )
  })
  afterEach(() => builtinToolsByName.delete('language_probe'))

  const thread = (): Thread => ({ id: 't', title: 'x', agentId: 'p', workspace: '', createdAt: 0, updatedAt: 0, messages: [], subagents: {}, toolStates: {} })
  const contextFor = (t: Thread, language: Language) => ({
    getSettings: () => live,
    language,
    thread: t,
    scope: { threadId: t.id },
    signal: new AbortController().signal,
    depth: 0,
    approvals: new ApprovalBroker(() => {}),
    mcp: new McpManager(() => {}),
    host: { request: async () => ({ ok: true, message: '' }) },
    emit: () => {},
    persist: () => {},
    rememberAlwaysAllow: () => {},
    knowledge: null,
    saveRoutines: () => {},
    sendTelegram: async () => false,
    whatsapp: null
  })
  const agent = (id: string, tools: string[], canDelegate = false): AgentProfile => ({ ...live.agents[0], id, tools, canDelegate, companyId: undefined })

  it('AC-1.8 a run that started in es keeps es when the settings change to en under it', async () => {
    const t = thread()
    t.messages.push({ role: 'user', content: [{ type: 'text', text: 'hola' }], ts: 0 })
    turns = [call('a', 'language_probe', {}), call('b', 'language_probe', {}), done]
    // the `settings` message from main arrives while the model is thinking about the second call
    beforeTurn = (index) => {
      if (index === 1) live = { ...live, language: 'en' }
    }
    await runAgent(agent('p', ['language_probe']), t.messages, contextFor(t, live.language))
    expect(live.language).toBe('en')
    expect(seen).toEqual(['es', 'es'])
  })

  it('AC-1.8 a subagent works in the language its parent run started in', async () => {
    live = { ...live, agents: [agent('p', [], true), agent('c', ['language_probe'])] }
    const t = thread()
    t.messages.push({ role: 'user', content: [{ type: 'text', text: 'hola' }], ts: 0 })
    turns = [call('d', 'delegate_task', { agent: 'c', title: 't', task: 'x' }), call('a', 'language_probe', {}), call('b', 'language_probe', {}), done, done]
    beforeTurn = (index) => {
      if (index === 2) live = { ...live, language: 'en' }
    }
    await runAgent(live.agents[0], t.messages, contextFor(t, 'es'))
    expect(seen).toEqual(['es', 'es'])
  })

  it('AC-1.7 a run whose context carries en reaches its tools in en', async () => {
    live = { ...live, language: 'en' }
    const t = thread()
    t.messages.push({ role: 'user', content: [{ type: 'text', text: 'hi' }], ts: 0 })
    turns = [call('a', 'language_probe', {}), done]
    // startRun in coordinator/index.ts builds the context from the settings it holds at that moment
    await runAgent(agent('p', ['language_probe']), t.messages, contextFor(t, live.language))
    expect(seen).toEqual(['en'])
  })
})

describe('what main shows outside the window', () => {
  it('AC-3.1 the tray menu and tooltip follow the language', () => {
    expect(trayMenu('es')).toEqual({ open: 'Abrir Alma', quit: 'Salir', tooltip: 'Alma' })
    expect(trayMenu('en')).toEqual({ open: 'Open Alma', quit: 'Quit', tooltip: 'Alma' })
  })

  it('AC-3.1 the security confirmation names the programs and speaks the language', () => {
    expect(securityDialog('es', 'mcp', ['git: npx git', 'web: npx web'])).toEqual({
      title: 'Confirmar cambio de seguridad',
      message: 'Alma va a ejecutar estos programas en tu computadora:',
      detail: 'git: npx git\nweb: npx web',
      allow: 'Permitir',
      cancel: 'Cancelar'
    })
    expect(securityDialog('en', 'mcp', ['git: npx git'])).toEqual({
      title: 'Confirm security change',
      message: 'Alma is going to run these programs on your computer:',
      detail: 'git: npx git',
      allow: 'Allow',
      cancel: 'Cancel'
    })
  })

  it('AC-3.1 the always-allow confirmation ignores the program list', () => {
    expect(securityDialog('es', 'always-allow', ['ignored'])).toMatchObject({
      message: 'Los agentes van a ejecutar todo sin pedirte aprobación.',
      detail: 'Es el modo «Siempre permitir». Las publicaciones siguen pidiendo aprobación.'
    })
    expect(securityDialog('en', 'always-allow', [])).toMatchObject({
      message: 'Agents are going to run everything without asking you for approval.',
      detail: 'This is the “Always allow” mode. Publishing still asks for approval.'
    })
  })

  it('AC-3.3 errors that reach the window are in the app language', () => {
    const es = (['rejected-origin', 'cancelled', 'unknown-provider', 'unknown-company', 'path-missing', 'no-programs', 'invalid-language'] as const).map((e) => mainError('es', e))
    const en = (['rejected-origin', 'cancelled', 'unknown-provider', 'unknown-company', 'path-missing', 'no-programs', 'invalid-language'] as const).map((e) => mainError('en', e))
    expect(es).toEqual(['Origen no autorizado', 'Cambio cancelado.', 'Proveedor desconocido', 'Empresa desconocida', 'La ruta no existe.', 'Alma no abre programas ni scripts.', 'Idioma no válido'])
    expect(en).toEqual(['Unauthorized origin', 'Change cancelled.', 'Unknown provider', 'Unknown company', 'The path does not exist.', 'Alma does not open programs or scripts.', 'Invalid language'])
  })
})

describe('the preview of an outgoing action on the approval card', () => {
  const ctx = (language: Language | undefined, over: Record<string, unknown> = {}): ToolContext =>
    ({ workspace: '', signal: new AbortController().signal, settings: { ...defaultSettings(), language: language ?? 'es' }, ...(language ? { language } : {}), ...over }) as never

  it('AC-3.2 approval preview: an email shows its header lines in the language', async () => {
    const input = { to: 'a@b.c', cc: 'x@y.z', subject: 'Hola', body: 'cuerpo' }
    expect((await emailSendTool.preview!(input, ctx('es')))?.note).toBe('Para: a@b.c\nCc: x@y.z\nAsunto: Hola\n\ncuerpo')
    expect((await emailSendTool.preview!({ ...input, subject: 'Hello', body: 'body' }, ctx('en')))?.note).toBe('To: a@b.c\nCc: x@y.z\nSubject: Hello\n\nbody')
    expect((await emailSendTool.preview!({ to: 'a@b.c', subject: 's', body: 'b' }, ctx('en')))?.note).toBe('To: a@b.c\nSubject: s\n\nb')
  })

  it('AC-3.2 approval preview: a WhatsApp message names the contact it resolves, or the raw target', async () => {
    const whatsapp = { resolve: async () => ({ jid: 'j', label: 'Ana' }), send: async () => {}, recentMessages: () => [] }
    expect((await sendWhatsAppTool.preview!({ to: 'ana', text: 'hola' }, ctx('es', { whatsapp })))?.note).toBe('Para: Ana\n\nhola')
    expect((await sendWhatsAppTool.preview!({ to: 'ana', text: 'hi' }, ctx('en', { whatsapp })))?.note).toBe('To: Ana\n\nhi')
    const unknown = { ...whatsapp, resolve: async () => Promise.reject(new Error('x')) }
    expect((await sendWhatsAppTool.preview!({ to: '5491', text: 'hi' }, ctx('en', { whatsapp: unknown })))?.note).toBe('To: 5491\n\nhi')
  })

  it('AC-3.2 approval preview: Instagram says when it is in test mode, in the language', async () => {
    const test = (language: Language) => instagramPublishTool.preview!({ image_path: 'none.png', caption: 'Hola' }, ctx(language, { workspace: tmpdir() }))
    expect((await test('es'))?.note).toBe('Modo de prueba activo: se completa todo menos el clic en «Compartir».')
    expect((await test('en'))?.note).toBe('Test mode is on: everything is filled in except the click on “Share”.')
    const live = await instagramPublishTool.preview!({ image_path: 'none.png', caption: 'Hola' }, ctx('en', { workspace: tmpdir(), settings: { ...defaultSettings(), language: 'en', instagram: { testMode: false } } }))
    expect(live?.note).toBeUndefined()
  })

  it('AC-3.2 approval preview: a hand-built context without a language reads as Spanish, as before', async () => {
    const bare = { workspace: '', signal: new AbortController().signal } as unknown as ToolContext
    expect((await emailSendTool.preview!({ to: 'a@b.c', subject: 's', body: 'b' }, bare))?.note).toBe('Para: a@b.c\nAsunto: s\n\nb')
  })
})

describe('dates and numbers the coordinator writes', () => {
  const monday = new Date(2026, 9, 12, 15, 30)
  const routine = (schedule: Routine['schedule']): Routine => ({ id: 'r', name: 'r', agentId: 'general', workspace: '', prompt: 'x', schedule, enabled: true, createdAt: 0 })

  it('AC-4.3 the date line of the system prompt is English and 24-hour, the same under both languages', () => {
    expect(localNow(monday)).toMatch(/^Monday, 10\/12\/2026, 15:30 \(.+\)$/)
  })

  it('AC-3.6 wiring: a routine is described in the language, days and dates included', () => {
    const weekdays = routine({ kind: 'daily', time: '10:00', days: [1, 2, 3, 4, 5] })
    expect(describeSchedule(weekdays, 'es')).toBe('lun, mar, mié, jue, vie a las 10:00')
    expect(describeSchedule(weekdays, 'en')).toBe('Mon, Tue, Wed, Thu, Fri at 10:00')
    expect(describeSchedule(routine({ kind: 'daily', time: '09:00', days: [] }), 'en')).toBe('every day at 09:00')
    expect(describeSchedule(routine({ kind: 'interval', minutes: 180 }), 'en')).toBe('every 3 h')
    expect(describeSchedule(routine({ kind: 'interval', minutes: 45 }), 'en')).toBe('every 45 min')
    expect(describeSchedule(routine({ kind: 'once', at: monday.getTime() }), 'es')).toBe('una vez, el lun 12-10, 15:30')
    expect(describeSchedule(routine({ kind: 'once', at: monday.getTime() }), 'en')).toBe('once, on Mon, 10/12, 15:30')
    // Without a language the description stays Spanish, as before.
    expect(describeSchedule(weekdays)).toBe('lun, mar, mié, jue, vie a las 10:00')
  })

  it('AC-4.3 the WhatsApp message list dates each message the same way under both languages', async () => {
    const whatsapp = { resolve: async () => ({ jid: 'j', label: 'Ana' }), send: async () => {}, recentMessages: () => [{ chat: 'x@s.whatsapp.net', from: 'Ana', text: 'hola', at: monday.getTime() }] }
    const ctx = (language: Language) => ({ workspace: '', signal: new AbortController().signal, settings: defaultSettings(), language, whatsapp }) as never
    expect(await whatsAppRecentTool.run({}, ctx('es'))).toContain('10/12/26, 15:30 · Ana: hola')
    expect(await whatsAppRecentTool.run({}, ctx('en'))).toContain('10/12/26, 15:30 · Ana: hola')
  })

  it('AC-4.3 a reminder set in the past names the date the same way for the model in both languages, and the card says it in the language', async () => {
    const run = (language: Language) =>
      createReminderTool.run({ message: 'x', when: { type: 'once', at: '2020-01-02T03:04' } } as never, { workspace: '', signal: new AbortController().signal, settings: defaultSettings(), language, saveRoutines: () => {} } as never)
    for (const language of ['es', 'en'] as const) {
      const error = (await run(language).catch((e: ToolError) => e)) as ToolError
      expect(error.message).toBe('That date has already passed (1/2/20, 03:04). Check the current date in the environment.')
    }
    const card = ((await run('es').catch((e: ToolError) => e)) as ToolError).text!
    expect(translateText('es', card)).toBe('Esa fecha ya pasó (1/2/20, 03:04). Revisá la fecha actual en el entorno.')
  })
})

describe('text Alma generates and stores', () => {
  it('AC-9.1 a language change writes no thread file', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'alma-threads-'))
    try {
      const threads = new ThreadStore(dataDir)
      const thread = threads.create('general', '')
      thread.title = 'Rutina · Informe'
      threads.save(thread.id)
      threads.flushAll()
      const snapshot = (): string => readdirSync(dataDir, { recursive: true }).map((f) => `${f}:${statSync(join(dataDir, String(f))).isFile() ? readFileSync(join(dataDir, String(f)), 'utf8') : ''}`).join('|')
      const before = snapshot()
      // The only thing a language change touches is the settings file; stored conversations are never rewritten.
      new SettingsStore(['es']).update({ language: 'en' })
      new SettingsStore(['en']).update({ language: 'es' })
      expect(snapshot()).toBe(before)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('AC-9.2 thread titles of routines and house rules carry the prefix of the language in effect', () => {
    expect(routineThreadTitle('es', 'Informe', '12/10 09:00')).toBe('Rutina · Informe · 12/10 09:00')
    expect(routineThreadTitle('en', 'Report', '10/12 09:00')).toBe('Routine · Report · 10/12 09:00')
    expect(houseThreadTitle('es', 'Noche', '12/10 23:00')).toBe('Casa · Noche · 12/10 23:00')
    expect(houseThreadTitle('en', 'Night', '10/12 23:00')).toBe('Home · Night · 10/12 23:00')
  })

  it('AC-9.2 company task logs are written in the language in effect and say each thing once', () => {
    const logs: [Parameters<typeof companyLog>[1], string, string][] = [
      [{ kind: 'assigned', title: 'Informe', assignee: 'Ana' }, 'asignó «Informe» a Ana', 'assigned “Informe” to Ana'],
      [{ kind: 'commented', title: 'Informe' }, 'comentó en «Informe»', 'commented on “Informe”'],
      [{ kind: 'moved', title: 'Informe', status: 'review' }, 'movió «Informe» a En revisión', 'moved “Informe” to In review'],
      [{ kind: 'blocked', title: 'Informe', text: 'sin acceso' }, 'se trabó en «Informe»: sin acceso', 'got stuck on “Informe”: sin acceso'],
      [{ kind: 'delivered', title: 'Informe' }, 'entregó «Informe»', 'delivered “Informe”'],
      [{ kind: 'approved', title: 'Informe' }, 'aprobó «Informe»', 'approved “Informe”'],
      [{ kind: 'returnedToBoard', title: 'Informe', revisions: 3 }, 'devolvió «Informe» por 3ª vez: pasa al Directorio', 'sent back “Informe” after 3 rounds of review: it goes to the Board'],
      [{ kind: 'changesRequested', title: 'Informe' }, 'pidió cambios en «Informe»', 'asked for changes on “Informe”'],
      [{ kind: 'escalated', message: 'ayuda' }, 'le escribió al Directorio: ayuda', 'wrote to the Board: ayuda'],
      [{ kind: 'started', title: 'Informe' }, 'empezó «Informe»', 'started “Informe”'],
      [{ kind: 'consulted', to: 'Beto' }, 'le consultó a Beto', 'consulted Beto'],
      [{ kind: 'meetingScheduled', topic: 'Plan', date: '12/10 10:00' }, 'convocó la reunión «Plan» para el 12/10 10:00', 'scheduled the meeting “Plan” for 12/10 10:00'],
      [{ kind: 'meetingCancelled', topic: 'Plan' }, 'canceló la reunión «Plan»', 'cancelled the meeting “Plan”'],
      [{ kind: 'meetingPreparing', topic: 'Plan' }, 'los participantes preparan «Plan»', 'the participants are preparing “Plan”'],
      [{ kind: 'meetingStarted', topic: 'Plan' }, 'empezó la reunión «Plan»', 'the meeting “Plan” started'],
      [{ kind: 'meetingClosed', topic: 'Plan', decisions: 2, actions: 1 }, 'cerró «Plan»: 2 decisiones, 1 tarea', 'closed “Plan”: 2 decisions, 1 task']
    ]
    for (const [entry, es, en] of logs) {
      expect(companyLog('es', entry), entry.kind).toBe(es)
      expect(companyLog('en', entry), entry.kind).toBe(en)
    }
  })

  it('AC-9.2 meeting minutes get their headings in the language in effect, and keep what was said as it was', () => {
    const minutes = {
      topic: 'Plan',
      date: 'lunes 12/10 10:00',
      chair: 'Ana',
      participants: [{ name: 'Ana', prep: 'Traigo cifras' }, { name: 'Beto' }],
      summary: 'Se acordó el plan.',
      decisions: ['Arrancar el lunes'],
      actions: [{ title: 'Enviar', owner: 'Beto', due: 'viernes' }, { title: 'Revisar', owner: 'Ana' }],
      transcript: [{ speaker: 'Ana', text: 'Hola' }]
    }
    const es = minutesNote('es', minutes)
    expect(es).toContain('# Plan\n\nlunes 12/10 10:00 · Modera: Ana\n\nParticipantes: Ana, Beto\n\n## Resumen\n\nSe acordó el plan.\n\n## Decisiones\n\n- Arrancar el lunes\n\n## Tareas\n\n- [ ] Enviar — Beto (para viernes)\n\n- [ ] Revisar — Ana')
    expect(es).toContain('## Preparación\n\n### Ana\nTraigo cifras\n\n### Beto\n(no preparó)\n\n## Transcripción\n\n**Ana:** Hola')
    const en = minutesNote('en', { ...minutes, decisions: [], actions: [] })
    expect(en).toContain('# Plan\n\nlunes 12/10 10:00 · Chair: Ana\n\nParticipants: Ana, Beto\n\n## Summary\n\nSe acordó el plan.\n\n## Decisions\n\n- (none)\n\n## Tasks\n\n- (none)')
    expect(en).toContain('## Preparation\n\n### Ana\nTraigo cifras\n\n### Beto\n(did not prepare)\n\n## Transcript\n\n**Ana:** Hola')
    expect(summaryFailed('es', 'sin red')).toBe('No se pudo resumir: sin red')
    expect(summaryFailed('en', 'no network')).toBe('Could not summarize: no network')
  })

  it('AC-9.2 the memory file starts with the header of the language in effect, and never rewrites one that exists', async () => {
    expect(memoryHeader('es')).toBe('# Recuerdos\n\nLo que Alma recuerda de vos. Se incluye en todas las conversaciones. Editá o borrá líneas cuando quieras.')
    expect(memoryHeader('en')).toBe('# Memories\n\nWhat Alma remembers about you. It goes into every conversation. Edit or delete lines whenever you want.')
    const open = async (language: Language) => {
      const root = mkdtempSync(join(tmpdir(), 'alma-vault-i18n-'))
      const data = mkdtempSync(join(tmpdir(), 'alma-vault-data-'))
      const embedder = { modelId: 'fake', state: () => ({ state: 'ready' as const }), embed: async (texts: string[]) => texts.map(() => new Float32Array(1024)) }
      const kb = new KnowledgeBase({ root, dataDir: data, embedder, trash: async () => {}, onStatus: () => {}, onChanged: () => {}, language: () => language })
      return { kb, root, data }
    }
    const english = await open('en')
    await english.kb.remember('likes tea')
    expect(readFileSync(join(english.root, 'Alma', 'Memories.md'), 'utf8').startsWith('# Memories\n')).toBe(true)
    // Switching language later keeps the header already written (nothing is rewritten, ADR 0019).
    const switched = await open('es')
    writeFileSync(join(switched.root, 'seed'), '')
    mkdirSync(join(switched.root, 'Alma'), { recursive: true })
    writeFileSync(join(switched.root, ...MEMORY_FILE.split('/')), '# Memories\n\n- likes tea\n')
    await switched.kb.remember('uses vim')
    expect(readFileSync(join(switched.root, ...MEMORY_FILE.split('/')), 'utf8').startsWith('# Memories\n')).toBe(true)
    await Promise.all([english.kb.close(), switched.kb.close()])
    for (const dir of [english.root, english.data, switched.root, switched.data]) rmSync(dir, { recursive: true, force: true })
  })
})

describe('what the code says on Telegram and WhatsApp', () => {
  const approval = (over: Record<string, unknown> = {}) =>
    ({ approvalId: 'a1', threadId: 't', toolUseId: 'u', toolName: 'write_file', input: { path: 'a.txt' }, flagged: false, allowAlways: true, ...over }) as never

  it('AC-3.9 the approval question names the tool and the input, and WhatsApp says how to answer', () => {
    expect(approvalPrompt('es', approval())).toBe('¿Permitir esta acción?\nHerramienta: write_file\n{\n "path": "a.txt"\n}')
    expect(approvalPrompt('en', approval())).toBe('Allow this action?\nTool: write_file\n{\n "path": "a.txt"\n}')
    expect(approvalPrompt('es', approval({ flagged: true, reason: 'borra todo' }), { askYesNo: true })).toBe(
      '⚠️ Auto-review marcó esta acción como riesgosa.\nborra todo\nHerramienta: write_file\n{\n "path": "a.txt"\n}\nRespondé *sí* o *no*.'
    )
    expect(approvalPrompt('en', approval({ flagged: true, reason: 'deletes everything' }), { askYesNo: true })).toBe(
      '⚠️ Auto-review flagged this action as risky.\ndeletes everything\nTool: write_file\n{\n "path": "a.txt"\n}\nReply *yes* or *no*.'
    )
  })

  it('AC-3.9 a long input is cut so the message still fits', () => {
    const long = approvalPrompt('en', approval({ input: { text: 'x'.repeat(3000) } }))
    expect(long.length).toBeLessThan(1700)
    expect(long).toContain('…')
  })

  it('AC-3.9 the approval buttons and the toast after a press follow the language', () => {
    expect(approvalButtons('es')).toEqual({ allow: 'Permitir', always: 'Siempre', deny: 'Rechazar' })
    expect(approvalButtons('en')).toEqual({ allow: 'Allow', always: 'Always', deny: 'Reject' })
    expect(approvalToast('es', 'deny')).toBe('Rechazado')
    expect(approvalToast('en', 'deny')).toBe('Rejected')
    expect(approvalToast('es', 'always')).toBe('Permitido')
    expect(approvalToast('en', 'allow')).toBe('Allowed')
  })

  it('AC-3.9 a Telegram failure is explained in the language, and an unknown one keeps its message', () => {
    expect(describeTelegramError('es', new Error('401 Unauthorized'))).toBe('el token no es válido (revisalo en @BotFather).')
    expect(describeTelegramError('en', new Error('401 Unauthorized'))).toBe('the token is not valid (check it in @BotFather).')
    expect(describeTelegramError('es', new Error('409: Conflict'))).toBe('otro programa está usando este bot (¿quedó ALMA corriendo?).')
    expect(describeTelegramError('en', new Error('409: Conflict'))).toBe('another program is using this bot (is ALMA still running?).')
    expect(describeTelegramError('en', 'boom')).toBe('boom')
  })

  it('AC-3.9 the fixed replies keep today\'s Spanish and have an English twin', () => {
    const replies: [Parameters<typeof translate>[1], string, string][] = [
      ['chan.done', 'Listo.', 'Done.'],
      ['chan.newDone', 'Listo, conversación nueva.', 'Done, new conversation.'],
      ['chan.noAudio', 'No entendí el audio.', 'I did not understand the audio.'],
      ['chan.thinking', 'Pensando…', 'Thinking…'],
      ['tg.noPhotos', 'Todavía no puedo mirar fotos.', 'I cannot look at photos yet.'],
      ['tg.answered', '(respondido)', '(answered)'],
      ['wa.unlinked', 'WhatsApp desvinculó a Alma. Volvé a escanear el QR.', 'WhatsApp unlinked Alma. Scan the QR again.']
    ]
    for (const [key, es, en] of replies) {
      expect(translate('es', key as never), key).toBe(es)
      expect(translate('en', key as never), key).toBe(en)
    }
    expect(translate('es', 'chan.failed', { error: 'x' })).toBe('No pude completar el pedido: x')
    expect(translate('en', 'chan.failed', { error: 'x' })).toBe('I could not complete the request: x')
    expect(translate('es', 'tg.denied', { who: '@ana' })).toBe('No estás autorizado para usar este bot. Para habilitarte, agregá @ana en Alma → Configuración → Telegram.')
    expect(translate('en', 'tg.denied', { who: '@ana' })).toBe('You are not authorized to use this bot. To enable yourself, add @ana in Alma → Settings → Telegram.')
  })
})

describe('what the coordinator tells the person', () => {
  it('AC-3.2 an approval notice names the post for Instagram and the thread for anything else', () => {
    expect(approvalNotice('es', { toolName: 'instagram_publish', caption: 'Hola mundo' }, 'Chat')).toEqual({ title: 'Post listo para Instagram', body: 'Hola mundo' })
    expect(approvalNotice('en', { toolName: 'instagram_publish', caption: 'Hello world' }, 'Chat')).toEqual({ title: 'Post ready for Instagram', body: 'Hello world' })
    expect(approvalNotice('en', { toolName: 'instagram_publish' }, 'Chat')).toEqual({ title: 'Post ready for Instagram', body: 'Chat' })
    expect(approvalNotice('es', { toolName: 'write_file' }, 'Chat')).toEqual({ title: 'Un agente necesita tu aprobación', body: 'Chat' })
    expect(approvalNotice('en', { toolName: 'write_file' }, 'Chat')).toEqual({ title: 'An agent needs your approval', body: 'Chat' })
  })

  it('AC-3.2 reminders and routines are announced in the language', () => {
    expect(reminderNotice('es', 'llamar al dentista')).toEqual({ title: 'Recordatorio', body: 'llamar al dentista' })
    expect(reminderNotice('en', 'call the dentist')).toEqual({ title: 'Reminder', body: 'call the dentist' })
    expect(routineNotice('es', 'Informe', { ok: true, threadTitle: 'Rutina · Informe' })).toEqual({ title: 'Rutina «Informe» terminada', body: 'Rutina · Informe' })
    expect(routineNotice('en', 'Report', { ok: true, threadTitle: 'Routine · Report' })).toEqual({ title: 'Routine “Report” finished', body: 'Routine · Report' })
    expect(routineNotice('es', 'Informe', { ok: false, message: 'sin red' })).toEqual({ title: 'La rutina «Informe» falló', body: 'sin red' })
    expect(routineNotice('en', 'Report', { ok: false, message: 'no network' })).toEqual({ title: 'The routine “Report” failed', body: 'no network' })
    expect(ruleFailedNotice('es', 'Noche', 'x')).toEqual({ title: 'La regla «Noche» falló', body: 'x' })
    expect(ruleFailedNotice('en', 'Night', 'x')).toEqual({ title: 'The rule “Night” failed', body: 'x' })
  })

  it('AC-3.2 house alerts speak the language and keep the cameras note when there is one', () => {
    expect(watchEndedNotice('es', 'Patio', 12, 'una persona')).toEqual({ title: 'Terminó la vigilancia de Patio', body: 'Miré 12 veces buscando: una persona. No pasó nada.' })
    expect(watchEndedNotice('en', 'Yard', 12, 'a person')).toEqual({ title: 'The watch on Yard is over', body: 'I looked 12 times for: a person. Nothing happened.' })
    expect(watchMatchNotice('es', 'Patio', 'una persona', 'hay alguien')).toEqual({ title: 'Patio: una persona', body: 'hay alguien' })
    expect(watchMatchNotice('es', 'Patio', 'una persona')).toEqual({ title: 'Patio: una persona', body: 'Se cumplió la condición.' })
    expect(watchMatchNotice('en', 'Yard', 'a person')).toEqual({ title: 'Yard: a person', body: 'The condition was met.' })
  })

  it('AC-3.2 company notices keep the amounts and say whether the work is paused', () => {
    const budget = { kind: 'budget', company: 'Acme', who: 'Ana', used: 20, cap: 20 } as const
    expect(companyNotice('es', { ...budget, level: '100' })).toEqual({ title: 'Acme: presupuesto agotado', body: 'Ana gastó USD 20.00 de 20 este mes. Se pausa hasta que lo amplíes en Configuración → Equipos.' })
    expect(companyNotice('es', { ...budget, level: '80', used: 16 })).toEqual({ title: 'Acme: 80 % del presupuesto', body: 'Ana gastó USD 16.00 de 20 este mes.' })
    expect(companyNotice('en', { ...budget, level: '100' }).title).toBe('Acme: budget used up')
    expect(companyNotice('en', { ...budget, level: '80', used: 16 })).toEqual({ title: 'Acme: 80% of the budget', body: 'Ana spent USD 16.00 of 20 this month.' })
    expect(companyNotice('es', { kind: 'stuck', company: 'Acme', title: 'Informe', revisions: 4 })).toEqual({ title: 'Acme: una tarea no sale', body: '«Informe» volvió 4 veces de revisión. Miralo en el tablero.' })
    expect(companyNotice('en', { kind: 'delivery', company: 'Acme', title: 'Report', who: 'Ana' })).toEqual({ title: 'Acme: delivery to review', body: '“Report” from Ana' })
    expect(companyNotice('es', { kind: 'meeting', company: 'Acme', topic: 'Planificación' })).toEqual({ title: 'Acme: empezó la reunión', body: '«Planificación». Podés entrar desde Empresas → Reuniones.' })
    expect(companyNotice('en', { kind: 'meeting', company: 'Acme', topic: 'Planning' })).toEqual({ title: 'Acme: the meeting started', body: '“Planning”. You can join from Companies → Meetings.' })
  })

  it('AC-3.2 a provider configuration error is worded in the language of the settings', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    expect(() => new XaiProvider('', 'https://x', DEEPSEEK, 'es')).toThrow('Falta la API key de DeepSeek. Cargala en Configuración → Proveedores o definí DEEPSEEK_API_KEY.')
    expect(() => new XaiProvider('', 'https://x', DEEPSEEK, 'en')).toThrow('The DeepSeek API key is missing. Add it in Settings → Providers or set DEEPSEEK_API_KEY.')
    // Without a language the provider keeps speaking Spanish, as before.
    expect(() => new XaiProvider('', 'https://x', DEEPSEEK)).toThrow('Falta la API key de DeepSeek')
    vi.unstubAllEnvs()
  })

  it('AC-3.2 the note on an approval card follows the language', async () => {
    const request = (language: Language, over: Record<string, unknown>) =>
      ({
        risk: 'write',
        toolName: 'write_file',
        autoApprove: [],
        signal: new AbortController().signal,
        setState: () => {},
        ...over,
        settings: { ...defaultSettings(), language, ...(over.settings as object) }
      }) as never
    expect((await authorize(request('es', { risk: 'read' })))?.note).toBe('Solo lectura')
    expect((await authorize(request('en', { risk: 'read' })))?.note).toBe('Read only')
    expect((await authorize(request('en', { settings: { approvalMode: 'blocked' } })))?.note).toBe('Blocked by the approval mode')
    expect((await authorize(request('es', { settings: { approvalMode: 'blocked' } })))?.note).toBe('Bloqueado por el modo de aprobación')
    expect((await authorize(request('en', { risk: 'memory' })))?.note).toBe("Alma's memory")
    expect((await authorize(request('en', { risk: 'home' })))?.note).toBe('House control')
    expect((await authorize(request('en', { autoApprove: ['write_file'] })))?.note).toBe('Allowed for this agent')
    expect((await authorize(request('en', { settings: { alwaysAllowTools: ['write_file'] } })))?.note).toBe('Allowed by your rule')
    expect((await authorize(request('en', { settings: { approvalMode: 'always-allow' } })))?.note).toBe('Mode “Always allow”')
    expect((await authorize(request('es', { settings: { approvalMode: 'always-allow' } })))?.note).toBe('Modo «siempre permitir»')
  })
})
