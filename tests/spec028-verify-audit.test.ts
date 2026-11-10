import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultRemote } from '../src/shared/remote/settings'
import type { AuditEvent } from '../src/shared/audit'
import { HOST, makeThread, testChannel, type Harness } from './support/remote-harness'

// Adversarial verification of spec 028 §Audit and §What the phone and the PC keep.

async function served(record?: (entry: AuditEvent) => void): Promise<Harness> {
  const scopes = { ...defaultRemote().scopes, history: true, vault: true, chat: true, approve: true, cameras: true }
  const t = await testChannel({ remote: { ...defaultRemote(), enabled: true, scopes, continueHistory: true, vaultExcluded: ['CANARYEXCLUDED'], cameras: ['camera.patio'] }, record })
  await t.channel.sync()
  const talk = { ...makeThread('talk'), title: 'CANARYTITLE', workspace: 'C:\\CANARYWORKSPACE' }
  talk.messages.push({ role: 'user', content: [{ type: 'text', text: 'CANARYTEXT' }], ts: 1 })
  t.chat.threads.push(talk)
  t.vault.put('Notas/ok.md', 'CANARYNOTE')
  t.vault.put('Notas/p.png', new Uint8Array([1, 2]))
  return t
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

describe('AC-5.1 / AC-5.2 (028 verify) what the trail holds', () => {
  it('AC-5.1 (028 verify) every open, send and stop is one remote entry with the device and an id or path; listings and the filter write nothing', async () => {
    const t = await served()
    const { deviceId } = await t.phone()
    await t.call('/api/notes/list', { folder: '' })
    await t.call('/api/notes/find', { query: 'ok' })
    await t.call('/api/threads/list', { offset: 0 })
    expect(t.records).toEqual([])
    await t.call('/api/notes/read', { path: 'NOTAS/OK.MD' })
    await t.call('/api/notes/image', { target: 'p.png', from: 'Notas/ok.md' })
    await t.call('/api/threads/read', { id: 'talk' })
    await t.call('/api/threads/send', { id: 'talk', text: 'CANARYSEND' })
    await t.call('/api/threads/stop', { id: 'talk' })
    expect(t.records.map((entry) => [entry.action, entry.target, entry.outcome])).toEqual([
      ['remote.notes.read', 'Notas/ok.md', 'ok'],
      ['remote.notes.image', 'Notas/p.png', 'ok'],
      ['remote.threads.read', 'talk', 'ok'],
      ['remote.threads.send', 'talk', 'ok'],
      ['remote.threads.stop', 'talk', 'ok']
    ])
    for (const entry of t.records) {
      expect(entry.actor).toBe('remote')
      expect(entry.detail).toEqual({ deviceId })
    }
  })

  it('AC-5.2 (028 verify) known strings fed through every new operation never reach the trail, success or refusal', async () => {
    const t = await served()
    await t.call('/api/notes/find', { query: 'CANARYQUERY' })
    await t.call('/api/notes/read', { path: 'Notas/ok.md' })
    await t.call('/api/notes/image', { target: 'CANARYIMAGE.png', from: 'Notas/CANARYFROM.md' })
    await t.call('/api/threads/read', { id: 'talk' })
    await t.call('/api/threads/read', { id: 'CANARYMISSING' })
    await t.call('/api/threads/send', { id: 'talk', text: 'CANARYSEND' })
    await t.call('/api/threads/send', { id: 'talk', text: 'CANARYSECOND' })
    await t.call('/api/threads/stop', { id: 'talk' })
    t.setRemote({ scopes: { ...defaultRemote().scopes, history: false, vault: false } })
    await t.call('/api/notes/find', { query: 'CANARYQUERY2' })
    await t.call('/api/threads/send', { id: 'talk', text: 'CANARYREFUSED' })
    const trail = JSON.stringify(t.records)
    for (const canary of ['CANARYTITLE', 'CANARYTEXT', 'CANARYNOTE', 'CANARYSEND', 'CANARYSECOND', 'CANARYQUERY', 'CANARYIMAGE', 'CANARYFROM', 'CANARYREFUSED', 'CANARYWORKSPACE', 'CANARYEXCLUDED', 'camera.patio']) {
      expect(trail, canary).not.toContain(canary)
    }
    // The one content-derived field a note may leave is its vault path.
    expect(trail).toContain('Notas/ok.md')
  })

  it('AC-5.1 (028 verify) an image the note names but the vault does not have leaves an entry with no target (the typed string is not copied)', async () => {
    const t = await served()
    await t.call('/api/notes/image', { target: 'nada.png', from: 'Notas/ok.md' })
    expect(t.records).toHaveLength(1)
    expect(t.records[0]).toMatchObject({ action: 'remote.notes.image', outcome: 'error' })
    expect(t.records[0]).not.toHaveProperty('target')
  })

  // REAL BUG (028 verify): a read carrying `since` is treated as live-follow polling and skips the audit entry (channel.ts auditResponse),
  // but `since: 0` returns the whole conversation, so a client can read any non-company conversation with no audit entry (BR-30, AC-5.1).
  it('AC-5.1 (028 verify) reading a whole conversation with since:0 leaves the same audit entry as an open', async () => {
    const t = await served()
    const res = await t.call('/api/threads/read', { id: 'talk', since: 0 })
    expect((res.body as { messages: unknown[] }).messages).toHaveLength(1)
    expect(t.records.map((entry) => entry.action)).toContain('remote.threads.read')
  })

  it('AC-5.1 (028 verify) the plain follow poll (since = current rev) is not an open and writes nothing', async () => {
    const t = await served()
    const rev = ((await t.call('/api/threads/read', { id: 'talk' })).body as { rev: number }).rev
    t.records.length = 0
    await t.call('/api/threads/read', { id: 'talk', since: rev })
    expect(t.records).toEqual([])
  })
})

describe('AC-5.3 / AC-5.4 (028 verify) refusals and a broken trail', () => {
  it('AC-5.3 (028 verify) a scope refusal and an unknown device are denied entries: throttled, no names, no content, no target', async () => {
    const t = await served()
    t.setRemote({ scopes: { ...defaultRemote().scopes, vault: false, history: false } })
    const { deviceId } = await t.phone()
    await t.call('/api/notes/read', { path: 'Notas/ok.md' })
    await t.call('/api/threads/send', { id: 'talk', text: 'CANARYSEND' })
    await t.transport.request({ method: 'POST', path: '/api/notes/read', headers: { ...HOST, authorization: 'Bearer nope' }, body: { path: 'Notas/CANARYPATH.md' } })
    expect(t.records.map((entry) => [entry.action, entry.outcome, entry.throttle, entry.detail ?? null, entry.target ?? null])).toEqual([
      ['remote.notes.read', 'denied', true, { deviceId }, null],
      ['remote.threads.send', 'denied', true, { deviceId }, null],
      ['remote.notes.read', 'denied', true, null, null]
    ])
    expect(JSON.stringify(t.records)).not.toMatch(/CANARY/)
  })

  it('AC-5.3 (028 verify) a continue-off send is a denied entry too (write-off), without the text', async () => {
    const t = await served()
    t.setRemote({ continueHistory: false })
    await t.call('/api/threads/send', { id: 'talk', text: 'CANARYSEND' })
    expect(t.records).toHaveLength(1)
    expect(t.records[0]).toMatchObject({ action: 'remote.threads.send', outcome: 'denied', throttle: true })
    expect(JSON.stringify(t.records)).not.toContain('CANARY')
  })

  it('AC-5.4 (028 verify) a trail that throws on every write interrupts none of the new operations', async () => {
    const t = await served(() => {
      throw new Error('disk full')
    })
    expect((await t.call('/api/notes/read', { path: 'Notas/ok.md' })).body).toMatchObject({ content: 'CANARYNOTE' })
    expect((await t.call('/api/notes/image', { target: 'p.png', from: 'Notas/ok.md' })).status).toBe(200)
    expect((await t.call('/api/threads/read', { id: 'talk' })).status).toBe(200)
    expect((await t.call('/api/threads/send', { id: 'talk', text: 'hola' })).status).toBe(200)
    expect(t.chat.askCalls).toHaveLength(1)
    expect((await t.call('/api/threads/stop', { id: 'talk' })).status).toBe(200)
    expect(t.chat.cancelCalls).toEqual(['talk'])
    t.setRemote({ scopes: { ...defaultRemote().scopes, vault: false } })
    expect((await t.call('/api/notes/read', { path: 'Notas/ok.md' })).status).toBe(403)
    await settle()
  })
})

describe('AC-6.11 / AC-4.1 / AC-4.3 (028 verify) what the phone is told and keeps', () => {
  it('AC-6.11 (028 verify) status carries the switches and nothing about what they cover, even with cameras and exclusions configured', async () => {
    const t = await served()
    const res = await t.transport.request({ method: 'GET', path: '/api/status', headers: (await t.phone()).headers })
    expect(res.status).toBe(200)
    expect(Object.keys(res.body as object).sort()).toEqual(['continue', 'scopes', 'sendFiles', 'sensitive'])
    expect(Object.keys((res.body as { scopes: object }).scopes).sort()).toEqual(['approve', 'cameras', 'chat', 'history', 'home', 'vault'])
    expect(JSON.stringify(res.body)).not.toMatch(/CANARY|camera\.|patio/)
    // `continue` is only true while History is on.
    t.setRemote({ scopes: { ...defaultRemote().scopes, history: false } })
    expect(((await t.transport.request({ method: 'GET', path: '/api/status', headers: (await t.phone()).headers })).body as { continue: boolean }).continue).toBe(false)
  })

  it('AC-4.1 (028 verify) every response of every new route, served or refused, carries no-store', async () => {
    const t = await served()
    const calls: [string, unknown][] = [
      ['/api/notes/list', { folder: '' }],
      ['/api/notes/list', { folder: 5 }],
      ['/api/notes/find', { query: 'o' }],
      ['/api/notes/read', { path: 'Notas/ok.md' }],
      ['/api/notes/read', { path: 'falta.md' }],
      ['/api/notes/read', { path: '../x' }],
      ['/api/notes/image', { target: 'p.png', from: 'Notas/ok.md' }],
      ['/api/notes/image', { target: 'q.png', from: '' }],
      ['/api/threads/list', { offset: 0 }],
      ['/api/threads/list', { offset: -1 }],
      ['/api/threads/read', { id: 'talk' }],
      ['/api/threads/read', { id: 'nada' }],
      ['/api/threads/send', { id: 'nada', text: 'x' }],
      ['/api/threads/send', { id: 'talk', text: 'x' }],
      ['/api/threads/send', { id: 'talk', text: 'x' }],
      ['/api/threads/stop', { id: 'talk' }]
    ]
    for (const [path, body] of calls) expect((await t.call(path, body)).headers?.['cache-control'], `${path} ${JSON.stringify(body)}`).toBe('no-store')
    t.setRemote({ scopes: { ...defaultRemote().scopes } })
    for (const [path, body] of calls) expect((await t.call(path, body)).headers?.['cache-control'], `off ${path}`).toBe('no-store')
  })

  it('AC-4.1 (028 verify) the phone code reaches browser storage only through the two storage modules, and the worker never answers /api/ from a cache', () => {
    const root = join(__dirname, '..', 'src', 'remote-client')
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.(ts|tsx)$/.test(name)) files.push(full)
      }
    }
    walk(root)
    const users = files.filter((file) => /\b(localStorage|sessionStorage|indexedDB|caches\.|document\.cookie|openDatabase)\b/.test(readFileSync(file, 'utf8'))).map((file) => file.slice(root.length + 1).replace(/\\/g, '/'))
    expect(users.sort()).toEqual(['idb.ts', 'lib/storage.ts'])
    const worker = readFileSync(join(root, 'public', 'sw.js'), 'utf8')
    expect(worker).toMatch(/url\.pathname\.startsWith\('\/api\/'\)\) return/)
    // The only thing put in a cache is the response to a GET that is not /api/.
    expect(worker.match(/cache\.put\(/g)).toHaveLength(1)
  })

  it('AC-4.3 (028 verify) the push for a phone-started run is empty and no other thread, device or scope can trigger one', async () => {
    const t = await served()
    t.chat.threads.push(makeThread('pc'))
    await t.call('/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p', auth: 'a' } })
    await t.call('/api/threads/send', { id: 'talk', text: 'CANARYSEND' })
    t.approvals.askApproval({ threadId: 'talk', toolUseId: 't', toolName: 'CANARYTOOL', input: { x: 'CANARYINPUT' }, flagged: true, reason: 'CANARYREASON', allowAlways: true })
    t.approvals.askApproval({ threadId: 'pc', toolUseId: 't', toolName: 'CANARYTOOL', input: {}, flagged: false, allowAlways: true })
    for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(t.posts).toHaveLength(1)
    expect(t.posts[0]?.body.length).toBe(0)
    expect(JSON.stringify([t.posts[0]?.url, t.posts[0]?.headers])).not.toMatch(/CANARY|talk/)
  })
})
