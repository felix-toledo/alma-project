import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appTools, type RunContext } from '../src/coordinator/agent'
import { builtinTools } from '../src/coordinator/tools'
import { jsonSchemaOf, type ToolDefinition } from '../src/coordinator/tools/types'
import { acknowledgedProviders, remoteDialog } from '../src/main/messages'
import { defaultSettings, PROVIDER_NAMES } from '../src/shared/defaults'
import { translate } from '../src/shared/i18n/messages'
import { acknowledgeNotice, threadReaders } from '../src/shared/attach/readers'
import { planRemoteChange, runConfirmations, stripRemotePatch } from '../src/shared/remote/confirmations'
import { defaultRemote, sanitizeRemote } from '../src/shared/remote/settings'
import type { ProviderId, RemoteSettings } from '../src/shared/types'
import { readSources } from './support/arch'

const chatOn = { chat: true, approve: false, home: false, cameras: false, vault: false, history: false }

describe('the Send files sub-switch setting (spec 031)', () => {
  it('AC-1.1 (031) sendFiles is off by default', () => {
    expect(defaultRemote().sendFiles).toBe(false)
    expect(defaultSettings().remote.sendFiles).toBe(false)
  })

  it('AC-1.1 (031) a document without the field, or with a non-boolean, reads off', () => {
    expect(sanitizeRemote({ enabled: true, scopes: chatOn }).sendFiles).toBe(false)
    for (const value of ['true', 'yes', 1, null, [], {}]) {
      expect(sanitizeRemote({ enabled: true, scopes: chatOn, sendFiles: value }).sendFiles, String(value)).toBe(false)
    }
    for (const value of [null, undefined, [], 'remote', 42, true]) expect(sanitizeRemote(value).sendFiles).toBe(false)
  })

  it('AC-1.1 (031) a stored true with Chat on is kept', () => {
    expect(sanitizeRemote({ enabled: true, scopes: chatOn, sendFiles: true }).sendFiles).toBe(true)
  })

  it('AC-1.3 (031) a document with sendFiles on and Chat off reads off', () => {
    const chatOff = { ...chatOn, chat: false, history: true }
    expect(sanitizeRemote({ enabled: true, scopes: chatOff, sendFiles: true }).sendFiles).toBe(false)
    // an unreadable scopes section is the default scopes: Chat off
    expect(sanitizeRemote({ enabled: true, scopes: 'x', sendFiles: true }).sendFiles).toBe(false)
    expect(sanitizeRemote({ enabled: true, sendFiles: true }).sendFiles).toBe(false)
    expect(sanitizeRemote({ enabled: true, scopes: { ...chatOn, chat: 'yes' }, sendFiles: true }).sendFiles).toBe(false)
  })

  it('AC-1.3 (031) the rest of the document is read as before', () => {
    const read = sanitizeRemote({ enabled: true, scopes: { ...chatOn, chat: false }, sendFiles: true, agentId: 'revisor', continueHistory: true })
    expect(read).toEqual({ ...defaultRemote(), enabled: true, agentId: 'revisor', continueHistory: true })
  })
})

describe('planRemoteChange and the Send files sub-switch (spec 031)', () => {
  const plan = (before: RemoteSettings, after: RemoteSettings, attachReaders: ProviderId[] = ['meta']) =>
    planRemoteChange(before, after, ['Pixel'], { activeVault: 'C:/Notes', attachReaders })
  const scopes = (over: Partial<RemoteSettings['scopes']> = {}) => ({ ...chatOn, history: true, ...over })
  const on = (over: Partial<RemoteSettings> = {}): RemoteSettings => ({ ...defaultRemote(), enabled: true, scopes: scopes(), ...over })
  const kinds = (list: { kind: string }[]) => list.map((c) => c.kind)

  it('AC-1.2 (031) turning sendFiles on asks once, after continue, in the fixed order', () => {
    const before = on()
    const after = on({
      scopes: scopes({ home: true }),
      sensitive: true,
      continueHistory: true,
      sendFiles: true,
      cameras: ['camera.door'],
      vaultExcluded: [],
    })
    const { confirmations, next } = plan(before, after)
    expect(kinds(confirmations)).toEqual(['scope', 'sensitive', 'continue', 'attachments', 'camera'])
    expect(confirmations.filter((c) => c.kind === 'attachments')).toHaveLength(1)
    expect(next.sendFiles).toBe(true)
  })

  it('AC-1.2 (031) turning sendFiles on alone asks for it alone', () => {
    const { confirmations, next } = plan(on(), on({ sendFiles: true }), ['xai', 'meta'])
    expect(confirmations).toEqual([{ kind: 'attachments', providers: ['xai', 'meta'] }])
    expect(next).toEqual(on({ sendFiles: true }))
  })

  it('AC-1.2 (031) turning sendFiles off, or leaving it as it is, asks nothing', () => {
    const before = on({ sendFiles: true })
    expect(plan(before, on({ sendFiles: false }))).toEqual({ confirmations: [], next: on({ sendFiles: false }) })
    expect(plan(before, { ...before })).toEqual({ confirmations: [], next: before })
    expect(plan(on(), on()).confirmations).toEqual([])
  })

  it('AC-1.1 (031) every turn-on resets sendFiles', () => {
    const off = defaultRemote()
    const { confirmations, next } = plan(off, on({ sendFiles: true, sensitive: true, continueHistory: true }))
    expect(kinds(confirmations)).toEqual(['enable'])
    expect(next.sendFiles).toBe(false)
    // off, then on again: still off
    const again = plan(on({ enabled: false, sendFiles: true }), on({ sendFiles: true }))
    expect(kinds(again.confirmations)).toEqual(['enable'])
    expect(again.next.sendFiles).toBe(false)
  })

  it('AC-1.3 (031) turning Chat off turns sendFiles off with no dialog', () => {
    const before = on({ sendFiles: true })
    const { confirmations, next } = plan(before, on({ sendFiles: true, scopes: scopes({ chat: false }) }))
    expect(confirmations).toEqual([])
    expect(next.sendFiles).toBe(false)
    expect(next.scopes.chat).toBe(false)
  })

  it('AC-1.3 (031) sendFiles asked together with Chat off asks nothing and stays off', () => {
    const before = on({ scopes: scopes({ chat: false }) })
    const { confirmations, next } = plan(before, on({ sendFiles: true, scopes: scopes({ chat: false }) }))
    expect(confirmations).toEqual([])
    expect(next.sendFiles).toBe(false)
  })

  it('AC-1.4 (031) the confirmation carries a copy of the providers', () => {
    const readers: ProviderId[] = ['xai']
    const { confirmations } = plan(on(), on({ sendFiles: true }), readers)
    readers.push('meta')
    expect(confirmations).toEqual([{ kind: 'attachments', providers: ['xai'] }])
  })

  it('AC-1.4 (031) a caller that names no providers never gets file sending switched on (consent must name them)', () => {
    const { confirmations, next } = planRemoteChange(on(), on({ sendFiles: true }), [], { activeVault: 'C:/Notes' })
    expect(confirmations).toEqual([])
    expect(next.sendFiles).toBe(false)
  })

  it('AC-1.2 (031) Cancel in runConfirmations saves nothing and asks nothing after it', () => {
    const { confirmations } = plan(on(), on({ sendFiles: true, cameras: ['camera.door'] }))
    const asked: string[] = []
    const result = runConfirmations(confirmations, (c) => {
      asked.push(c.kind)
      return c.kind !== 'attachments'
    })
    expect(result).toBe('denied')
    expect(asked).toEqual(['attachments'])
    const allowed: string[] = []
    expect(runConfirmations(confirmations, (c) => (allowed.push(c.kind), true))).toBe('ok')
    expect(allowed).toEqual(['attachments', 'camera'])
  })
})

describe('the coordinator cannot change the Send files sub-switch (spec 031 AC-1.5)', () => {
  it('AC-1.5 (031) the coordinator patch cannot carry sendFiles', () => {
    const patches = [
      { remote: { sendFiles: true } },
      { remote: { ...defaultRemote(), enabled: true, sendFiles: true }, language: 'es' },
      { attachments: { noticeAcknowledged: ['xai'] }, remote: null },
    ]
    for (const patch of patches) {
      const before = JSON.stringify(patch)
      const stripped = stripRemotePatch(patch) as Record<string, unknown>
      expect(Object.hasOwn(stripped, 'remote')).toBe(false)
      expect(JSON.stringify(patch)).toBe(before)
      expect({ remote: 'UNCHANGED', ...stripped }.remote).toBe('UNCHANGED')
    }
    expect(stripRemotePatch({ remote: { sendFiles: true } })).toEqual({})
  })

  // the sub-switch, the remote section and the acknowledged-providers list, as setting names
  const SETTING_NAMES = /sendFiles|noticeAcknowledged|settings\.remote|\bremote\.(sendFiles|scopes|enabled)|settings\.attachments/

  it('AC-1.5 (031) no tool reads or changes the remote settings', () => {
    const base = defaultSettings()
    const ctx = (channel: string, depth: number, extra: object) =>
      ({ getSettings: () => ({ ...base, home: { ...base.home, enabled: true } }), thread: { channel }, depth, knowledge: {}, whatsapp: {}, home: {}, ...extra }) as unknown as RunContext
    const tools: ToolDefinition[] = [...builtinTools, ...appTools(ctx('voice', 0, {})), ...appTools(ctx('company', 1, { company: {}, knowledge: null, whatsapp: null }))]
    expect(tools.length).toBeGreaterThan(30)
    expect(tools.map((tool) => tool.name)).toContain('read_attachment')
    for (const tool of tools) {
      expect(`${tool.name} ${tool.description} ${JSON.stringify(jsonSchemaOf(tool.schema))}`, tool.name).not.toMatch(SETTING_NAMES)
    }
    const root = join(__dirname, '..')
    const sources = { ...readSources(root, 'src/coordinator/tools'), ...readSources(root, 'src/coordinator/knowledge'), ...readSources(root, 'src/coordinator/attachments') }
    expect(Object.keys(sources).length).toBeGreaterThan(10)
    // the attachment service reads the acknowledged list to check the notice; only the tool modules are about tools
    const toolSources = Object.entries(sources).filter(([file]) => !file.includes('/attachments/') || file.endsWith('read-tool.ts'))
    expect(toolSources.filter(([, text]) => SETTING_NAMES.test(text)).map(([file]) => file)).toEqual([])
    // the scan can fail
    expect(SETTING_NAMES.test('settings.remote.sendFiles = true')).toBe(true)
    expect(SETTING_NAMES.test('settings.attachments.noticeAcknowledged.push(p)')).toBe(true)
    expect(SETTING_NAMES.test('Read an attached document by its id.')).toBe(false)
  })
})

describe('the Send files native dialog and PC labels (spec 031 T40)', () => {
  it('AC-1.2 (031) remoteDialog for attachments has Allow and Cancel with Cancel as default', () => {
    for (const language of ['es', 'en'] as const) {
      const text = remoteDialog(language, { kind: 'attachments', providers: ['xai'] })
      expect(text.title).toBe(translate(language, 'main.security.title'))
      expect(text.buttons).toEqual([translate(language, 'main.security.allow'), translate(language, 'main.security.cancel')])
      expect(text.defaultId).toBe(1)
      expect(text.buttons[text.defaultId]).toBe(translate(language, 'main.security.cancel'))
    }
  })

  it('AC-1.4 (031) the text names the 30 days, the model provider and the provider names, in es and en', () => {
    const providers: ProviderId[] = ['xai', 'meta']
    const names = `${PROVIDER_NAMES.xai}, ${PROVIDER_NAMES.meta}`
    const es = remoteDialog('es', { kind: 'attachments', providers })
    expect(es.message).toBe(translate('es', 'main.remote.attachments', { providers: names }))
    expect(es.message).toContain('30 días')
    expect(es.message).toContain('proveedor del modelo')
    expect(es.message).toContain(names)
    const en = remoteDialog('en', { kind: 'attachments', providers })
    expect(en.message).toBe(translate('en', 'main.remote.attachments', { providers: names }))
    expect(en.message).toContain('30 days')
    expect(en.message).toContain('model provider')
    expect(en.message).toContain(names)
    // one provider: just its name
    expect(remoteDialog('en', { kind: 'attachments', providers: ['anthropic'] }).message).toContain(`agent that answers: ${PROVIDER_NAMES.anthropic}.`)
  })

  it('AC-1.2 (031) the PC tab row has its label and hint in es and en', () => {
    expect(translate('es', 'remote.scope.attachments')).toBe('Enviar archivos desde el celular')
    expect(translate('es', 'remote.scope.attachments.hint')).toBe('El celular puede dejar fotos y archivos en esta PC, y tus agentes pueden leerlos.')
    expect(translate('en', 'remote.scope.attachments')).toBe('Send files from the phone')
    expect(translate('en', 'remote.scope.attachments.hint')).toBe('The phone can leave photos and files on this PC, and your agents can read them.')
  })
})

describe('the acknowledgment recorded when the Send files dialog is allowed (spec 031 T41)', () => {
  it('AC-1.4 (031) only an attachments confirmation names providers to acknowledge', () => {
    expect(acknowledgedProviders([])).toEqual([])
    expect(acknowledgedProviders([{ kind: 'scope', scope: 'chat' }, { kind: 'continue' }, { kind: 'sensitive' }])).toEqual([])
    expect(acknowledgedProviders([{ kind: 'continue' }, { kind: 'attachments', providers: ['xai', 'meta'] }, { kind: 'sensitive' }])).toEqual(['xai', 'meta'])
  })

  it('AC-1.4 (031) Allow merges the providers into the same list as the desktop notice, once each', () => {
    const current = { noticeAcknowledged: ['xai' as ProviderId] }
    expect(acknowledgeNotice(current, acknowledgedProviders([{ kind: 'attachments', providers: ['xai', 'meta'] }]))).toEqual({ noticeAcknowledged: ['xai', 'meta'] })
    expect(acknowledgeNotice(current, acknowledgedProviders([]))).toEqual(current)
  })

  it('AC-1.4 (031) the providers main names are the conversation reader and the vision provider, once each', () => {
    const settings = defaultSettings()
    const readers = threadReaders(settings, { agentId: settings.remote.agentId }, true, {})
    expect(readers.length).toBeGreaterThan(0)
    expect(new Set(readers).size).toBe(readers.length)
    const { confirmations } = planRemoteChange(on0(), { ...on0(), sendFiles: true }, [], { activeVault: '', attachReaders: readers })
    expect(acknowledgedProviders(confirmations)).toEqual(readers)
  })
})

function on0(): RemoteSettings {
  return { ...defaultRemote(), enabled: true, scopes: { ...chatOn } }
}
