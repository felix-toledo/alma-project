import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PHONE_ATTACH } from '../src/shared/attach/phone'
import { REMOTE_LIMITS, ROUTES, chatSendBody, putBody, removeBody, threadsSendBody } from '../src/shared/remote/api'
import { en as pcEn } from '../src/shared/i18n/en'
import { es as pcEs } from '../src/shared/i18n/es'
import { en as pwaEn } from '../src/remote-client/i18n/en'
import { es as pwaEs } from '../src/remote-client/i18n/es'
import { importsOf, resolveSpecifier } from './support/arch'
import { bytesOf, errorOf, putBody as body, rig } from './support/verify-031'

const root = join(__dirname, '..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
// the files an upload, a send or a thread view passes through (device storage and the relay have their own reasons to touch the disk)
const remoteModule = (): string[] =>
  ['uploads', 'channel', 'chat', 'threads', 'thread-view', 'audit', 'transport', 'runs', 'devices-admin'].map((name) => `src/coordinator/channels/remote/${name}.ts`)

describe('031 verify: the closed route table (AC-9.1)', () => {
  const keys = ROUTES.map((r) => `${r.method} ${r.path}`)

  it('AC-9.1 (031 verify) exactly three routes name attachments, and only one of them names an attachment to delete', () => {
    const attachRoutes = keys.filter((k) => /attach/.test(k)).sort()
    expect(attachRoutes).toEqual(['POST /api/attachments/remove', 'POST /api/chat/attach', 'POST /api/threads/attach'])
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('AC-9.1 (031 verify) the phone has no route to read, list, fetch, preview or download a stored attachment', () => {
    for (const k of keys) expect(k).not.toMatch(/attachments\/(list|get|read|download|preview|open|thumb|content)/)
    expect(keys.filter((k) => k.includes('/api/attachments'))).toEqual(['POST /api/attachments/remove'])
  })

  it('AC-9.1 (031 verify) every route that takes a body has a strict schema: an extra key is refused', () => {
    const forbidden = { id: 'x', name: 'a.txt', size: 0, base64: '', text: 'x', __extra: 1 }
    for (const spec of ROUTES.filter((r) => r.body && /attach|send/.test(r.path))) expect({ path: spec.path, ok: spec.body?.safeParse(forbidden).success }).toEqual({ path: spec.path, ok: false })
  })

  it('AC-9.1 (031 verify) the two sends gain an optional strict id list, bounded at 64 characters per id and not by its length', () => {
    for (const schema of [chatSendBody, threadsSendBody]) {
      const base = schema === chatSendBody ? { text: 'hola' } : { id: 't', text: 'hola' }
      expect(schema.safeParse(base).success).toBe(true)
      expect(schema.safeParse({ ...base, attachments: ['a'] }).success).toBe(true)
      expect(schema.safeParse({ ...base, attachments: Array(64).fill('a') }).success).toBe(true)
      // owner decision F2: a list longer than 64 is the claim's to refuse as unavailable, not the schema's as invalid
      expect(schema.safeParse({ ...base, attachments: Array(65).fill('a') }).success).toBe(true)
      expect(schema.safeParse({ ...base, attachments: ['a'.repeat(64)] }).success).toBe(true)
      expect(schema.safeParse({ ...base, attachments: ['a'.repeat(65)] }).success).toBe(false)
      expect(schema.safeParse({ ...base, attachments: [1] }).success).toBe(false)
      expect(schema.safeParse({ ...base, attachments: null }).success).toBe(false)
      expect(schema.safeParse({ ...base, files: ['a'] }).success).toBe(false)
      expect(schema.safeParse({ ...base, text: '', attachments: ['a'] }).success).toBe(true)
      expect(schema.safeParse({ ...base, text: '', attachments: [] }).success).toBe(false)
      expect(schema.safeParse({ ...base, text: '  ' }).success).toBe(false)
    }
  })

  it('AC-9.1 (031 verify) the put and remove schemas are strict at the boundary values', () => {
    expect(putBody.safeParse({ name: 'a', size: 0, base64: '' }).success).toBe(true)
    expect(putBody.safeParse({ name: 'a'.repeat(512), size: 3, base64: 'AAAA' }).success).toBe(true)
    expect(putBody.safeParse({ name: 'a'.repeat(513), size: 0, base64: '' }).success).toBe(false)
    const max = 'A'.repeat(933_336)
    expect(putBody.safeParse({ name: 'a', size: 700_002, base64: max }).success).toBe(true)
    expect(putBody.safeParse({ name: 'a', size: 700_003, base64: `${max}AAAA` }).success).toBe(false)
    expect(removeBody.safeParse({ id: 'a'.repeat(64) }).success).toBe(true)
    expect(removeBody.safeParse({ id: 'a'.repeat(65) }).success).toBe(false)
  })

  it('AC-9.1 (031 verify) the table is closed at the channel: near misses of the new paths are unknown routes', async () => {
    const t = await rig()
    const { headers } = await t.h.phone()
    const near: [string, string][] = [
      ['GET', '/api/chat/attach'],
      ['PUT', '/api/chat/attach'],
      ['POST', '/api/chat/attach/'],
      ['POST', '/api/Chat/attach'],
      ['POST', '/api/chat/attach/../send'],
      ['POST', '/api/attachments'],
      ['POST', '/api/attachments/'],
      ['POST', '/api/attachments/list'],
      ['GET', '/api/attachments/remove'],
      ['DELETE', '/api/attachments/remove'],
      ['POST', '/api/attachments/get'],
      ['POST', '/api/threads/attach/remove'],
      ['POST', '/api/attach'],
      ['POST', '//api/chat/attach']
    ]
    for (const [method, path] of near) {
      const answer = await t.h.transport.request({ method, path, headers, body: body('a.txt', bytesOf('x')) })
      expect({ method, path, error: errorOf(answer), status: answer.status }).toEqual({ method, path, error: 'unknown-route', status: 404 })
    }
    expect(t.h.files.puts).toEqual([])
  })

  it('AC-9.1 (031 verify) a wrong host or origin gets nothing from the new routes, even with a valid session', async () => {
    const t = await rig()
    const { headers } = await t.h.phone()
    for (const forged of [{ host: 'evil.test' }, { origin: 'https://evil.test' }] as Record<string, string>[]) {
      const answer = await t.h.transport.request({ method: 'POST', path: '/api/chat/attach', headers: { ...headers, ...forged }, body: body('a.txt', bytesOf('x')) })
      expect(errorOf(answer)).toBe('invalid')
    }
    expect(t.h.files.puts).toEqual([])
  })

  it('AC-1.8 (031 verify) an unknown, malformed, revoked or idle-expired token gets the same refusal on every new route, and touches nothing', async () => {
    const t = await rig()
    const { headers, deviceId } = await t.h.phone()
    const good = body('a.txt', bytesOf('x'))
    const routes: [string, unknown][] = [
      ['/api/chat/attach', good],
      ['/api/threads/attach', { id: 'remote', ...good }],
      ['/api/attachments/remove', { id: 'x' }],
      ['/api/chat/send', { text: 'hola', attachments: ['x'] }],
      ['/api/threads/send', { id: 'remote', text: 'hola', attachments: ['x'] }]
    ]
    const send = (authorization: string | undefined, path: string, payload: unknown) =>
      t.h.transport.request({ method: 'POST', path, headers: authorization === undefined ? { host: headers.host } : { host: headers.host, authorization }, body: payload })
    const refusals = []
    for (const token of [undefined, '', 'Bearer', 'Bearer ', 'Bearer nope', 'Bearer a b', `Bearer ${'a'.repeat(129)}`, 'bearer sometoken', 'Basic abc', "Bearer ' OR 1=1", 'Bearer ../../x']) {
      for (const [path, payload] of routes) refusals.push(await send(token, path, payload))
    }
    // a valid token of a revoked device
    await t.h.channel.revokeDevice(deviceId)
    for (const [path, payload] of routes) refusals.push(await t.h.transport.request({ method: 'POST', path, headers, body: payload }))
    for (const answer of refusals) {
      expect(answer.status).toBe(401)
      expect(answer.body).toEqual({ error: 'unknown-device' })
      expect(answer.headers?.['cache-control']).toBe('no-store')
    }
    expect(t.h.files.puts).toEqual([])
    expect(t.h.chat.askCalls).toEqual([])
    expect(t.onDisk().folders).toEqual([])
  })

  it('AC-1.8 (031 verify) an idle-expired device (past 15 days) gets the usual refusal on the new routes', async () => {
    const t = await rig()
    t.h.setNow(1_000)
    const { headers } = await t.h.phone()
    await t.h.store.touch((await t.h.phone()).deviceId)
    t.h.setNow(1_000 + 15 * 86_400_000 + 1)
    const answer = await t.h.transport.request({ method: 'POST', path: '/api/chat/attach', headers, body: body('a.txt', bytesOf('x')) })
    expect(answer.body).toEqual({ error: 'unknown-device' })
    expect(answer.status).toBe(401)
  })

  it('AC-1.6 (031 verify) with the sub-switch off nothing is read from disk, stored or run: put, remove and a send with ids are attach-off', async () => {
    const t = await rig({ remote: { sendFiles: false } })
    const answers = [
      await t.h.call('/api/chat/attach', body('a.txt', bytesOf('x'))),
      await t.h.call('/api/threads/attach', { id: 'remote', ...body('a.txt', bytesOf('x')) }),
      await t.h.call('/api/attachments/remove', { id: 'x' }),
      await t.h.call('/api/chat/send', { text: 'hola', attachments: ['x'] }),
      await t.h.call('/api/threads/send', { id: 'remote', text: 'hola', attachments: ['x'] })
    ]
    for (const answer of answers) expect({ status: answer.status, error: errorOf(answer) }).toEqual({ status: 403, error: 'attach-off' })
    expect(t.h.files.puts).toEqual([])
    expect(t.h.files.removes).toEqual([])
    expect(t.h.chat.askCalls).toEqual([])
    // text-only sends are not affected
    expect((await t.h.call('/api/chat/send', { text: 'hola' })).status).toBe(200)
  })

  it('AC-1.7 (031 verify) through the channel: scope-off, write-off and attach-off as the authorization function says, in order', async () => {
    const t = await rig({ remote: { scopes: { ...rigScopes(), chat: false } } })
    t.addThread('t1')
    const good = body('a.txt', bytesOf('x'))
    expect(errorOf(await t.h.call('/api/chat/attach', good))).toBe('scope-off')
    t.h.setRemote({ scopes: { ...rigScopes(), history: false } })
    expect(errorOf(await t.h.call('/api/threads/attach', { id: 't1', ...good }))).toBe('scope-off')
    t.h.setRemote({ scopes: rigScopes(), continueHistory: false })
    expect(errorOf(await t.h.call('/api/threads/attach', { id: 't1', ...good }))).toBe('write-off')
    expect((await t.h.call('/api/chat/attach', good)).status).toBe(200)
    t.h.setRemote({ continueHistory: true, sendFiles: false })
    expect(errorOf(await t.h.call('/api/threads/attach', { id: 't1', ...good }))).toBe('attach-off')
  })

  it('AC-1.9 (031 verify) the status route returns the sub-switch and the usual keys only, and follows a change on the PC without a restart', async () => {
    const t = await rig()
    const { headers } = await t.h.phone()
    const status = () => t.h.transport.request({ method: 'GET', path: '/api/status', headers })
    const first = await status()
    expect(Object.keys(first.body as object).sort()).toEqual(['continue', 'scopes', 'sendFiles', 'sensitive'])
    expect((first.body as { sendFiles: boolean }).sendFiles).toBe(true)
    t.h.setRemote({ sendFiles: false })
    expect(((await status()).body as { sendFiles: boolean }).sendFiles).toBe(false)
    t.h.setRemote({ sendFiles: true, scopes: { ...rigScopes(), chat: false } })
    expect(((await status()).body as { sendFiles: boolean }).sendFiles).toBe(false)
  })
})

const rigScopes = () => ({ chat: true, approve: false, home: false, cameras: false, vault: false, history: true })

describe('031 verify: the limits, the layers and the manifest (AC-9.3 to AC-9.6)', () => {
  it('AC-9.5 (031 verify) REMOTE_LIMITS is exactly the 026 table, and the phone limit lives in its own constant', () => {
    expect(JSON.stringify(REMOTE_LIMITS)).toBe(
      JSON.stringify({
        requestBytes: 1_048_576,
        photoBytes: 2_097_152,
        chatChars: 8000,
        requestsPerMinute: 60,
        connectionsPerDevice: 2,
        timeoutMs: 30_000,
        testWaitMs: 10_000,
        pairingPerMinute: 5,
        approvalInputChars: 1500,
        longPollMs: 25_000,
        firstLoadMessages: 30
      })
    )
    expect(Object.keys(REMOTE_LIMITS)).not.toContain('maxFileBytes')
    expect(PHONE_ATTACH).toEqual({ maxFileBytes: 700_000, maxFiles: 5, maxPending: 5, pendingTtlMs: 900_000 })
    expect(read('src/shared/remote/limits.ts')).not.toMatch(/700[_ ]?000|maxFile|attach/i)
  })

  it('AC-9.5 (031 verify) the biggest allowed file as base64 plus a 512-character name fits the request cap with margin', () => {
    const base64 = Buffer.alloc(PHONE_ATTACH.maxFileBytes, 7).toString('base64')
    expect(base64.length).toBe(933_336)
    const request = JSON.stringify({ id: 'x'.repeat(64), name: 'n'.repeat(512), size: PHONE_ATTACH.maxFileBytes, base64 })
    expect(Buffer.byteLength(request)).toBeLessThan(REMOTE_LIMITS.requestBytes - 100_000)
  })

  it('AC-9.3 (031 verify) the remote module imports no file-system API and keeps no copy of the type list, size rule, name sanitiser or store layout', () => {
    const fs = /^(node:)?(fs|fs\/promises|path|os)$/
    for (const file of [...remoteModule(), 'src/shared/remote/api.ts', 'src/shared/remote/authorize.ts', 'src/shared/remote/wire.ts', 'src/shared/remote/status.ts']) {
      const source = read(file)
      const bad = importsOf(source).map((s) => resolveSpecifier(file, s)).filter((s) => fs.test(s) || /attach\/(store|names|exif|classify)$/.test(s) || /attachments\/store$/.test(s))
      expect({ file, bad }).toEqual({ file, bad: [] })
      expect({ file, copy: /ALLOWED_EXTENSIONS|classifyFile|storedFileName|sanitizeFileName|ATTACH_LIMITS|isSecretLikeName|stripMetadata|'\.(png|jpe?g|webp|gif|pdf|docx)'/.test(source) }).toEqual({ file, copy: false })
      expect({ file, literal: /\b700[_]?000\b|2_097_152/.test(source) }).toEqual({ file, literal: false })
    }
  })

  it('AC-9.3 (031 verify) the upload flow reaches the store only through its port (an interface it declares), never by import', () => {
    const uploads = importsOf(read('src/coordinator/channels/remote/uploads.ts')).map((s) => resolveSpecifier('src/coordinator/channels/remote/uploads.ts', s))
    expect(uploads.some((s) => /coordinator\/attachments|attach\/(store|service)/.test(s))).toBe(false)
    expect(read('src/coordinator/index.ts')).toMatch(/files: new PhoneFiles\(/)
    expect(read('src/coordinator/attachments/phone.ts')).toMatch(/classifyFile\(/)
    expect(read('src/coordinator/attachments/phone.ts')).toMatch(/isSecretLikeName\(/)
  })

  it('AC-9.4 (031 verify) the manifest lists the new uploads module and every listed file matches its recorded hash', () => {
    const manifest = JSON.parse(read('tests/support/remote-protected.json')) as Record<string, string>
    expect(Object.keys(manifest)).toContain('src/coordinator/channels/remote/uploads.ts')
    const stale = Object.entries(manifest)
      .filter(([file, hash]) => createHash('sha256').update(read(file).replaceAll('\r\n', '\n')).digest('hex') !== hash)
      .map(([file]) => file)
    expect(stale).toEqual([])
    for (const file of ['channel', 'chat', 'threads', 'thread-view', 'audit', 'transport', 'devices-admin']) expect(Object.keys(manifest)).toContain(`src/coordinator/channels/remote/${file}.ts`)
    for (const file of ['api', 'authorize', 'wire', 'status']) expect(Object.keys(manifest)).toContain(`src/shared/remote/${file}.ts`)
  })

  it('AC-9.6 (031 verify) the other channels do not import the phone\'s attachment rules or flows', () => {
    for (const file of ['telegram', 'whatsapp', 'voice']) {
      let source = ''
      try {
        source = read(`src/coordinator/channels/${file}.ts`)
      } catch {
        continue
      }
      expect({ file, imports: importsOf(source).filter((s) => /attach\/phone|remote\/uploads|attachments\/phone/.test(s)) }).toEqual({ file, imports: [] })
    }
  })

  it('AC-4.6 (031 verify) read_attachment is risk read and never asks, in the mode a phone-started run uses; this spec adds no tool', async () => {
    const { readAttachmentTool } = await import('../src/coordinator/attachments/read-tool')
    const { ApprovalBroker, authorize } = await import('../src/coordinator/approval')
    const { defaultSettings } = await import('../src/shared/defaults')
    expect(readAttachmentTool.risk).toBe('read')
    const broker = new ApprovalBroker(() => undefined)
    const settings = { ...defaultSettings(), approvalMode: 'needs-approval' as const }
    const verdict = await authorize({
      settings,
      threadId: 't',
      toolUseId: 'u',
      toolName: readAttachmentTool.name,
      risk: readAttachmentTool.risk,
      input: { id: 'x' },
      workspace: '',
      taskContext: '',
      autoApprove: [],
      signal: new AbortController().signal,
      broker,
      setState: () => undefined,
      rememberAlwaysAllow: () => undefined
    })
    expect(verdict.allowed).toBe(true)
    expect(broker.pending()).toEqual([])
    const { readdirSync, readFileSync } = await import('node:fs')
    const names = readdirSync(join(root, 'src/coordinator/tools')).flatMap((f) => (f.endsWith('.ts') ? [readFileSync(join(root, 'src/coordinator/tools', f), 'utf8')] : []))
    expect(names.filter((source) => /name: '(put_|send_file|attach_from_phone|phone_)/.test(source))).toEqual([])
  })

  it('AC-8.9 (031 verify) every key of §6.1 exists in both phone dictionaries and in the PC ones, with the same placeholders', () => {
    const pwaKeys = [
      'remote.pwa.can.attach', 'remote.pwa.attach.button', 'remote.pwa.attach.remove', 'remote.pwa.attach.preparing', 'remote.pwa.attach.uploading', 'remote.pwa.attach.failed',
      'remote.pwa.attach.off', 'remote.pwa.attach.noticeNeeded', 'remote.pwa.attach.tooBig', 'remote.pwa.attach.type', 'remote.pwa.attach.content', 'remote.pwa.attach.empty',
      'remote.pwa.attach.malformed', 'remote.pwa.attach.secret', 'remote.pwa.attach.tooMany', 'remote.pwa.attach.busy', 'remote.pwa.attach.expired', 'remote.pwa.attach.storage',
      'remote.pwa.attach.kind.image', 'remote.pwa.attach.kind.text', 'remote.pwa.attach.kind.pdf', 'remote.pwa.attach.kind.office',
      'remote.pwa.retry', 'remote.pwa.scopeOff', 'remote.pwa.writeOff', 'remote.pwa.pcUnreachable', 'remote.pwa.rateLimited', 'remote.pwa.thread.gone', 'remote.pwa.run.active', 'remote.pwa.tooLong'
    ]
    const holes = (a: Record<string, string>, b: Record<string, string>) => (key: string) => !(key in a) || !(key in b) || !a[key].trim() || !b[key].trim()
    expect(pwaKeys.filter(holes(pwaEs, pwaEn))).toEqual([])
    const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    for (const key of Object.keys(pwaEs)) expect({ key, same: placeholders(pwaEs[key as keyof typeof pwaEs]).join() === placeholders((pwaEn as unknown as Record<string, string>)[key] ?? '').join() }).toEqual({ key, same: true })
    expect(Object.keys(pwaEs).sort()).toEqual(Object.keys(pwaEn).sort())
    const pcKeys = ['remote.scope.attachments', 'remote.scope.attachments.hint', 'main.remote.attachments']
    const es = pcEs as unknown as Record<string, string>
    const en = pcEn as unknown as Record<string, string>
    expect(pcKeys.filter((k) => !(k in es) || !(k in en) || !es[k].trim() || !en[k].trim())).toEqual([])
    expect(placeholders(es['main.remote.attachments'])).toEqual(['providers'])
    expect(placeholders(en['main.remote.attachments'])).toEqual(['providers'])
  })

  it('AC-8.9 (031 verify) the new phone screens have no hard-coded user-visible text: no JSX text and no literal aria-label or title', () => {
    for (const file of ['AttachBar', 'FileLines']) {
      const source = read(`src/remote-client/screens/${file}.tsx`)
      const jsxText = [...source.matchAll(/>([^<>{}\n]*[A-Za-zÁÉÍÓÚáéíóúñ]{3,}[^<>{}\n]*)</g)].map((m) => m[1].trim())
      expect({ file, jsxText }).toEqual({ file, jsxText: [] })
      expect({ file, literal: /(aria-label|title|alt|placeholder)="[^"]+"/.test(source) }).toEqual({ file, literal: false })
    }
  })

  it('AC-8.10 (031 verify) the new screens play no sound and the stylesheet honors reduced motion for the chip', () => {
    for (const file of ['AttachBar', 'FileLines']) expect(read(`src/remote-client/screens/${file}.tsx`)).not.toMatch(/Audio|\.play\(|<audio|vibrate/)
    const css = read('src/remote-client/pwa.css')
    expect(css).toMatch(/\.pwa-chip/)
    expect(css).toMatch(/prefers-reduced-motion/)
  })
})
