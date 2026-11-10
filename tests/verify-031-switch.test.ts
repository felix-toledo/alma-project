import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acknowledgeNotice, threadReaders } from '../src/shared/attach/readers'
import { defaultSettings } from '../src/shared/defaults'
import { acknowledgedProviders, remoteDialog } from '../src/main/messages'
import { ROUTES } from '../src/shared/remote/api'
import { authorizeRemote } from '../src/shared/remote/authorize'
import { planRemoteChange, runConfirmations, stripRemotePatch, type RemoteConfirmation } from '../src/shared/remote/confirmations'
import { defaultRemote, sanitizeRemote } from '../src/shared/remote/settings'
import { statusView } from '../src/shared/remote/status'
import type { RemoteSettings } from '../src/shared/types'

const root = join(__dirname, '..')
const on = (patch: Partial<RemoteSettings> = {}): RemoteSettings => ({ ...defaultRemote(), enabled: true, scopes: { ...defaultRemote().scopes, chat: true }, ...patch })
const plan = (before: RemoteSettings, after: RemoteSettings, readers: ('meta' | 'anthropic')[] = ['meta']) =>
  planRemoteChange(before, after, [], { activeVault: 'C:/Notes', attachReaders: readers })
const kinds = (list: RemoteConfirmation[]): string[] => list.map((c) => c.kind)

describe('031 verify: the sub-switch (US-2)', () => {
  it('AC-1.1 (031 verify) a fresh install and an old settings document have Send files off', () => {
    expect(defaultRemote().sendFiles).toBe(false)
    expect(defaultSettings().remote.sendFiles).toBe(false)
    const { sendFiles: _omitted, ...old } = on()
    expect(sanitizeRemote(old).sendFiles).toBe(false)
    for (const junk of ['true', 1, 'yes', null, {}, []]) expect(sanitizeRemote({ ...on(), sendFiles: junk }).sendFiles).toBe(false)
  })

  it('AC-1.1 (031 verify) every turn-on forces it off, even when the same patch asks for it, and asks no files confirmation', () => {
    for (const transport of ['tailscale', 'relay'] as const) {
      const before = { ...defaultRemote(), transport }
      const after = on({ transport, sendFiles: true, continueHistory: true, sensitive: true })
      const planned = plan(before, after)
      expect(planned.next.sendFiles).toBe(false)
      expect(kinds(planned.confirmations)).not.toContain('attachments')
      expect(planned.next.scopes).toEqual(defaultRemote().scopes)
    }
  })

  it('AC-1.1 (031 verify) off, on, off, on: the second turn-on is off again whatever was saved in between', () => {
    const live = on({ sendFiles: true })
    const off = { ...live, enabled: false }
    const again = plan(off, { ...off, enabled: true, sendFiles: true })
    expect(again.next.sendFiles).toBe(false)
  })

  it('AC-1.2 (031 verify) turning it on asks exactly one files confirmation; turning it off, none', () => {
    const before = on()
    const turnedOn = plan(before, { ...before, sendFiles: true })
    expect(kinds(turnedOn.confirmations)).toEqual(['attachments'])
    expect(turnedOn.next.sendFiles).toBe(true)
    const turnedOff = plan({ ...before, sendFiles: true }, { ...before, sendFiles: false })
    expect(turnedOff.confirmations).toEqual([])
    expect(turnedOff.next.sendFiles).toBe(false)
  })

  it('AC-1.2 (031 verify) it is not asked again when it is already on, and it comes after "continue" and before cameras and exclusions', () => {
    const base = on({ cameras: ['camera.a'], vaultExcluded: ['Privado'], scopes: { ...on().scopes, history: true } })
    const stay = plan({ ...base, sendFiles: true }, { ...base, sendFiles: true })
    expect(stay.confirmations).toEqual([])
    const all = plan(
      base,
      {
        ...base,
        scopes: { ...base.scopes, approve: true, home: true },
        sensitive: true,
        continueHistory: true,
        sendFiles: true,
        cameras: ['camera.a', 'camera.b'],
        vaultExcluded: []
      }
    )
    expect(kinds(all.confirmations)).toEqual(['scope', 'scope', 'sensitive', 'continue', 'attachments', 'camera', 'unexclude'])
  })

  it('AC-1.2 (031 verify) a denial stops the chain: nothing after the denied step is asked', () => {
    const before = on()
    const planned = plan(before, { ...before, continueHistory: true, sendFiles: true, scopes: { ...before.scopes, history: true } })
    const asked: string[] = []
    const verdict = runConfirmations(planned.confirmations, (c) => {
      asked.push(c.kind)
      return c.kind !== 'continue'
    })
    expect(verdict).toBe('denied')
    expect(asked).toEqual(['scope', 'continue'])
  })

  it('AC-1.2 (031 verify) the dialog is the native Allow/Cancel one with Cancel as the default, in both languages', () => {
    const confirmation: RemoteConfirmation = { kind: 'attachments', providers: ['meta'] }
    for (const language of ['es', 'en'] as const) {
      const dialog = remoteDialog(language, confirmation)
      expect(dialog.buttons).toHaveLength(2)
      expect(dialog.defaultId).toBe(1)
    }
  })

  it('AC-1.3 (031 verify) a settings document with the sub-switch on and Chat off is read as off, and the sibling flags are kept', () => {
    const doc = { ...on({ sendFiles: true, scopes: { ...on().scopes, chat: false, history: true }, continueHistory: true }) }
    const read = sanitizeRemote(doc)
    expect(read.sendFiles).toBe(false)
    expect(read.continueHistory).toBe(true)
    expect(sanitizeRemote({ ...doc, scopes: { ...doc.scopes, chat: true } }).sendFiles).toBe(true)
  })

  it('AC-1.3 (031 verify) turning Chat off turns it off, and asking for both at once yields neither the switch nor its confirmation', () => {
    const live = on({ sendFiles: true })
    const chatOff = plan(live, { ...live, scopes: { ...live.scopes, chat: false } })
    expect(chatOff.next.sendFiles).toBe(false)
    expect(chatOff.confirmations).toEqual([])
    const bothAtOnce = plan(on(), { ...on(), scopes: { ...on().scopes, chat: false }, sendFiles: true })
    expect(bothAtOnce.next.sendFiles).toBe(false)
    expect(kinds(bothAtOnce.confirmations)).not.toContain('attachments')
  })

  it('AC-1.3 (031 verify) turning Chat on and Send files on in one patch asks both, scope first', () => {
    const before = { ...on(), scopes: { ...on().scopes, chat: false } }
    const planned = plan(before, { ...before, scopes: { ...before.scopes, chat: true }, sendFiles: true })
    expect(kinds(planned.confirmations)).toEqual(['scope', 'attachments'])
  })

  it('AC-1.4 (031 verify) the native text says 30 days and the provider names, in es and en, with nothing left unfilled', () => {
    const confirmation: RemoteConfirmation = { kind: 'attachments', providers: ['meta', 'anthropic'] }
    const es = remoteDialog('es', confirmation).message
    const en = remoteDialog('en', confirmation).message
    for (const text of [es, en]) {
      expect(text).toContain('30')
      expect(text).toContain('Meta (Muse)')
      expect(text).toContain('Claude')
      expect(text).not.toMatch(/\{\w+\}/)
    }
    expect(es).toMatch(/d[ií]as/)
    expect(en).toMatch(/days/)
  })

  it('AC-1.4 (031 verify) the providers named are the remote agent\'s and, for pictures, the vision one', () => {
    const settings = defaultSettings()
    const agent = settings.agents.find((a) => a.id === settings.remote.agentId) ?? settings.agents[0]
    const withVision = { ...settings, images: { ...settings.images, vision: { provider: 'anthropic' as const, model: 'claude-x' } } }
    const readers = threadReaders(withVision, { agentId: agent.id }, true, {})
    expect(readers).toContain(agent.provider)
    expect(readers).toContain('anthropic')
    expect(new Set(readers).size).toBe(readers.length)
    expect(threadReaders(withVision, { agentId: agent.id }, false, {})).toEqual([agent.provider])
  })

  it('AC-1.4 (031 verify) Allow records the providers once each in the desktop list; Cancel (no confirmation reached) records nothing', () => {
    const list: RemoteConfirmation[] = [{ kind: 'continue' }, { kind: 'attachments', providers: ['meta', 'anthropic'] }]
    const owed = acknowledgedProviders(list)
    expect(owed).toEqual(['meta', 'anthropic'])
    const merged = acknowledgeNotice({ noticeAcknowledged: ['meta'] }, owed)
    expect(merged.noticeAcknowledged.slice().sort()).toEqual(['anthropic', 'meta'])
    expect(acknowledgeNotice({ noticeAcknowledged: [] }, ['bogus' as never, 'meta']).noticeAcknowledged).toEqual(['meta'])
    expect(acknowledgedProviders([])).toEqual([])
    expect(acknowledgedProviders([{ kind: 'continue' }, { kind: 'sensitive' }])).toEqual([])
  })

  it('AC-1.4 (031 verify) [structural] main acknowledges only after every dialog was allowed (the loop throws on Cancel first)', () => {
    const source = readFileSync(join(root, 'src', 'main', 'index.ts'), 'utf8')
    const cancelled = source.indexOf("throw new Error(mainError(settings.get().language, 'cancelled'))", source.indexOf('planRemoteChange('))
    const acknowledge = source.indexOf('acknowledgedProviders(planned.confirmations)')
    expect(cancelled).toBeGreaterThan(0)
    expect(acknowledge).toBeGreaterThan(cancelled)
  })

  it('AC-1.5 (031 verify) the coordinator patch loses the whole remote section, the new key included', () => {
    const patch = { remote: { sendFiles: true, enabled: true }, language: 'en' as const }
    const stripped = stripRemotePatch(patch)
    expect(stripped).toEqual({ language: 'en' })
    expect('remote' in stripped).toBe(false)
    expect(patch.remote.sendFiles).toBe(true)
    expect(JSON.stringify(stripRemotePatch({ remote: { sendFiles: true } }))).not.toContain('sendFiles')
  })

  it('AC-1.5 (031 verify) [structural] main strips the coordinator\'s settings.patch before applying it', () => {
    const source = readFileSync(join(root, 'src', 'main', 'index.ts'), 'utf8')
    expect(source).toMatch(/settings\.update\(stripRemotePatch\(message\.patch\)\)/)
  })

  it('AC-1.5 (031 verify) no tool, agent or coordinator module outside the remote channel reads or writes the sub-switch', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.tsx?$/.test(name) && /sendFiles/.test(readFileSync(path, 'utf8'))) offenders.push(path.replace(root, '').replaceAll('\\', '/'))
      }
    }
    walk(join(root, 'src', 'coordinator'))
    expect(offenders.filter((file) => !file.startsWith('/src/coordinator/channels/remote/'))).toEqual([])
  })

  it('AC-1.9 (031 verify) the status view lists exactly the known keys, and counts the sub-switch only while Chat is on', () => {
    const live = on({ sendFiles: true })
    expect(Object.keys(statusView(live)).sort()).toEqual(['continue', 'scopes', 'sendFiles', 'sensitive'])
    expect(statusView(live).sendFiles).toBe(true)
    expect(statusView({ ...live, scopes: { ...live.scopes, chat: false } }).sendFiles).toBe(false)
    expect(statusView({ ...live, sendFiles: false }).sendFiles).toBe(false)
    expect(Object.keys(statusView(live).scopes).sort()).toEqual(['approve', 'cameras', 'chat', 'history', 'home', 'vault'])
  })
})

describe('031 verify: the pure authorization for the new routes (AC-1.6 to AC-1.8, AC-9.2)', () => {
  const route = (path: string) => {
    const found = ROUTES.find((r) => r.path === path)
    if (!found) throw new Error(`no route ${path}`)
    return found
  }
  const device = { deviceId: 'd1' }
  const all = (patch: Partial<RemoteSettings> = {}): RemoteSettings => ({
    ...defaultRemote(),
    enabled: true,
    scopes: { chat: true, approve: true, home: true, cameras: true, vault: true, history: true },
    continueHistory: true,
    sendFiles: true,
    ...patch
  })
  const verdict = (path: string, remote: RemoteSettings, extra: { device?: { deviceId: string } | null; carriesFiles?: boolean } = {}) =>
    authorizeRemote({ device: extra.device === undefined ? device : extra.device, remote, route: route(path), carriesFiles: extra.carriesFiles })

  it('AC-1.6 (031 verify) with the sub-switch off, a put on any of the three routes is attach-off', () => {
    for (const path of ['/api/chat/attach', '/api/threads/attach', '/api/attachments/remove']) {
      expect(verdict(path, all({ sendFiles: false }))).toEqual({ ok: false, reason: 'attach-off' })
    }
  })

  it('AC-1.6 (031 verify) a send is refused attach-off only when it carries ids; a text-only send is not affected', () => {
    for (const path of ['/api/chat/send', '/api/threads/send']) {
      const off = all({ sendFiles: false })
      expect(verdict(path, off, { carriesFiles: true })).toEqual({ ok: false, reason: 'attach-off' })
      expect(verdict(path, off, { carriesFiles: false })).toEqual({ ok: true })
      expect(verdict(path, off)).toEqual({ ok: true })
      expect(verdict(path, all(), { carriesFiles: true })).toEqual({ ok: true })
    }
  })

  it('AC-1.7 (031 verify) the shared-thread put needs Chat: scope-off when it is off, whatever the other switches say', () => {
    const noChat = all({ scopes: { ...all().scopes, chat: false }, sendFiles: true })
    expect(verdict('/api/chat/attach', noChat)).toEqual({ ok: false, reason: 'scope-off' })
    expect(verdict('/api/chat/attach', all())).toEqual({ ok: true })
  })

  it('AC-1.7 (031 verify) the by-id put needs History (scope-off), then continue (write-off), then Files (attach-off)', () => {
    expect(verdict('/api/threads/attach', all({ scopes: { ...all().scopes, history: false } }))).toEqual({ ok: false, reason: 'scope-off' })
    expect(verdict('/api/threads/attach', all({ continueHistory: false }))).toEqual({ ok: false, reason: 'write-off' })
    expect(verdict('/api/threads/attach', all({ sendFiles: false }))).toEqual({ ok: false, reason: 'attach-off' })
    expect(verdict('/api/threads/attach', all())).toEqual({ ok: true })
  })

  it('AC-1.7 (031 verify) the verdict takes no transport input: the same object for the same facts', () => {
    const a = authorizeRemote({ device, remote: all(), route: route('/api/threads/attach') })
    const b = authorizeRemote({ device, remote: all(), route: route('/api/threads/attach') })
    expect(a).toEqual(b)
    expect(authorizeRemote.length).toBe(1)
  })

  it('AC-1.8 (031 verify) no device gets the unknown-device refusal on every new route, before any scope is looked at', () => {
    for (const path of ['/api/chat/attach', '/api/threads/attach', '/api/attachments/remove', '/api/chat/send', '/api/threads/send']) {
      expect(verdict(path, all({ sendFiles: false, scopes: { ...all().scopes, chat: false, history: false } }), { device: null })).toEqual({ ok: false, reason: 'unknown-device' })
    }
  })

  it('AC-9.1 (031 verify) every new route declares its scope, audit class, files rule and a strict schema', () => {
    for (const path of ['/api/chat/attach', '/api/threads/attach', '/api/attachments/remove']) {
      const spec = route(path)
      expect(spec.auth).toBe('session')
      expect(spec.scope).toBeDefined()
      expect(spec.audit).not.toBe('none')
      expect(spec.files).toBe('always')
      expect(spec.body).toBeDefined()
      // strict: an extra key is refused
      const strict = spec.body?.safeParse({ id: 'x', name: 'a.txt', size: 0, base64: '', extra: 1 })
      expect(strict?.success).toBe(false)
    }
    for (const path of ['/api/chat/send', '/api/threads/send']) expect(route(path).files).toBe('with-ids')
  })
})
