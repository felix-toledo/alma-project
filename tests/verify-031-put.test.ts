import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { UploadsFlow } from '../src/coordinator/channels/remote/uploads'
import { PHONE_ATTACH } from '../src/shared/attach/phone'
import { MARKERS, GIF, has, makeJpeg, makePng, makeWebp, textWithNul } from './support/verify-030'
import { SHARED, attachmentOf, bytesOf, errorOf, idOf, putBody, rig, storedBytes, textFile } from './support/verify-031'

const CHAT = '/api/chat/attach'
const BY_ID = '/api/threads/attach'
const T1 = 't1'

async function ready() {
  const t = await rig()
  t.addThread(T1)
  return t
}

describe('031 verify: putting a file (US-1, US-3)', () => {
  it('AC-2.1 (031 verify) a valid file is stored through the 030 store, bound to the shared thread, and answers id, name, kind, size only', async () => {
    const t = await ready()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const data = bytesOf('hola desde el celular')
    const response = await t.h.call(CHAT, putBody('nota.txt', data))
    expect(response.status).toBe(200)
    expect(Object.keys((response.body as { attachment: object }).attachment).sort()).toEqual(['id', 'kind', 'name', 'size'])
    expect(attachmentOf(response)).toMatchObject({ name: 'nota.txt', kind: 'text', size: data.length })
    const found = t.store.lookup(idOf(response))
    expect(found.state).toBe('present')
    if (found.state === 'present') {
      expect(found.record.threadId).toBe(SHARED)
      expect(readFileSync(found.path).equals(Buffer.from(data))).toBe(true)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(t.h.posts).toEqual([])
    fetchSpy.mockRestore()
  })

  it('AC-2.1 (031 verify) a by-id put is bound to that conversation, not to the shared thread', async () => {
    const t = await ready()
    const response = await t.h.call(BY_ID, { id: T1, ...putBody('a.txt', bytesOf('x')) })
    expect(response.status).toBe(200)
    const found = t.store.lookup(idOf(response))
    expect(found.state === 'present' && found.record.threadId).toBe(T1)
  })

  it('AC-2.2 (031 verify) the bytes decide: every disguise is refused with a named reason and nothing reaches the disk', async () => {
    const t = await ready()
    const exe = Uint8Array.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0])
    const cases: [string, string, Uint8Array, string, number][] = [
      ['a .png that is an executable', 'foto.png', exe, 'file-content', 422],
      ['an SVG', 'logo.svg', bytesOf('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'file-type', 415],
      ['HTML', 'page.html', bytesOf('<html></html>'), 'file-type', 415],
      ['an archive', 'x.zip', Uint8Array.from([0x50, 0x4b, 3, 4]), 'file-type', 415],
      ['no extension', 'README', bytesOf('hello'), 'file-type', 415],
      ['a trailing dot', 'a.txt.', bytesOf('hello'), 'file-type', 415],
      ['a double extension', 'a.txt.exe', bytesOf('hello'), 'file-type', 415],
      ['text with a NUL in the first 8000 bytes', 'log.txt', textWithNul(100, 50), 'file-content', 422],
      ['text with a NUL at byte 7999', 'log.txt', textWithNul(9000, 7999), 'file-content', 422],
      ['a PDF that is not', 'doc.pdf', bytesOf('not a pdf'), 'file-content', 422],
      ['a .docx that is not a zip', 'doc.docx', bytesOf('PK-not'), 'file-content', 422],
      ['an image extension over text', 'a.jpg', bytesOf('plain text'), 'file-content', 422],
      ['an empty file', 'empty.txt', new Uint8Array(0), 'file-empty', 422]
    ]
    for (const [label, name, data, reason, status] of cases) {
      const response = await t.h.call(CHAT, putBody(name, data))
      expect({ label, error: errorOf(response), status: response.status }).toEqual({ label, error: reason, status })
    }
    expect(t.onDisk()).toEqual({ folders: [], records: [] })
  })

  it('AC-2.2 (031 verify) a NUL just after the first 8000 bytes is outside the sniff window and the file is accepted', async () => {
    const t = await ready()
    const response = await t.h.call(CHAT, putBody('log.txt', textWithNul(9000, 8000)))
    expect(response.status).toBe(200)
  })

  it('AC-2.2 (031 verify) the extension check is case-insensitive and a refused type never consumes a pending slot', async () => {
    const t = await ready()
    for (let i = 0; i < 12; i++) await t.h.call(CHAT, putBody('x.exe', bytesOf('x')))
    for (let i = 0; i < 5; i++) expect((await t.h.call(CHAT, putBody(`n${i}.TXT`, bytesOf('hi')))).status).toBe(200)
  })

  it('AC-2.3 (031 verify) 700 000 bytes pass; 700 001 are refused as too-large and nothing is stored', async () => {
    const t = await ready()
    const ok = await t.h.call(CHAT, putBody('big.txt', textFile(PHONE_ATTACH.maxFileBytes)))
    expect(ok.status).toBe(200)
    expect(attachmentOf(ok).size).toBe(700_000)
    const before = t.onDisk().folders.length
    const over = await t.h.call(CHAT, putBody('big.txt', textFile(PHONE_ATTACH.maxFileBytes + 1)))
    expect(errorOf(over)).toBe('too-large')
    expect(over.status).toBe(413)
    expect(t.onDisk().folders.length).toBe(before)
  })

  it('AC-2.3 (031 verify) the size rule is the real decoded count: a few bytes over (700 002) are too-large as well', async () => {
    const t = await ready()
    expect(errorOf(await t.h.call(CHAT, putBody('big.txt', textFile(700_002))))).toBe('too-large')
  })

  it('AC-2.3 (031 verify) a file clearly over the limit but under the request cap is refused as too-large, whatever the exact size', async () => {
    const t = await ready()
    // 750 000 bytes is 1 000 000 base64 characters: under the 1 MB request cap, over the 700 000 bytes limit
    const response = await t.h.call(CHAT, putBody('big.txt', textFile(750_000)))
    expect(errorOf(response)).toBe('too-large')
    expect(t.onDisk().folders).toEqual([])
  })

  it('AC-2.3 (031 verify) a request over 1 MB never reaches a handler', async () => {
    const t = await ready()
    const response = await t.h.call(CHAT, { name: 'a.txt', size: 1, base64: 'A'.repeat(1_100_000) })
    expect(response.status).toBe(413)
    expect(errorOf(response)).toBe('too-large')
    expect(t.h.files.puts).toEqual([])
  })

  it('AC-2.3 (031 verify) hostile bodies are rejected at the boundary: the store is never asked', async () => {
    const t = await ready()
    const good = putBody('a.txt', bytesOf('hello'))
    const bad: [string, unknown][] = [
      ['claimed size too small', { ...good, size: 1 }],
      ['claimed size too big', { ...good, size: 700_000 }],
      ['negative size', { ...good, size: -5 }],
      ['fractional size', { ...good, size: 5.5 }],
      ['string size', { ...good, size: '5' }],
      ['bad base64 characters', { ...good, base64: 'not base64!!' }],
      ['base64 with a newline', { ...good, base64: 'aGVs\nbG8=' }],
      ['url-safe base64', { name: 'a.txt', size: 2, base64: '-_8=' }],
      ['unpadded base64', { ...good, base64: 'aGVsbG8' }],
      ['padding in the middle', { ...good, base64: 'aGVs=bG8' }],
      ['an extra key', { ...good, thread: 'other' }],
      ['an override flag', { name: '.env', size: 5, base64: good.base64, confirm: true }],
      ['no name', { size: 5, base64: good.base64 }],
      ['empty name', { ...good, name: '' }],
      ['name over 512', { ...good, name: `${'a'.repeat(510)}.txt` }],
      ['no base64', { name: 'a.txt', size: 0 }],
      ['null body', null],
      ['array body', []],
      ['string body', 'hola'],
      ['number body', 5]
    ]
    for (const [label, body] of bad) {
      const response = await t.h.call(CHAT, body)
      expect({ label, error: errorOf(response) }).toEqual({ label, error: 'invalid' })
    }
    // the 512-character name itself is the boundary and is fine
    expect((await t.h.call(CHAT, putBody(`${'a'.repeat(508)}.txt`, bytesOf('hello')))).status).toBe(200)
    expect(t.h.files.puts).toHaveLength(1)
  })

  it('AC-2.3 (031 verify) the by-id put checks the same shapes and a bad id is invalid, never a lookup', async () => {
    const t = await ready()
    const good = putBody('a.txt', bytesOf('hello'))
    for (const id of ['', 'x'.repeat(65), 5, null, undefined]) {
      const response = await t.h.call(BY_ID, { id, ...good })
      expect(errorOf(response)).toBe('invalid')
    }
    expect(errorOf(await t.h.call(BY_ID, good))).toBe('invalid')
    expect(t.h.files.puts).toEqual([])
  })

  it('AC-2.3 (031 verify) the empty file answers with a named reason in both AC-2.2 and AC-2.3 wording: refused, nothing stored', async () => {
    const t = await ready()
    const response = await t.h.call(CHAT, { name: 'empty.txt', size: 0, base64: '' })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(errorOf(response)).toBeDefined()
    expect(t.onDisk().folders).toEqual([])
  })

  it('AC-2.4 (031 verify) a secret-looking name is refused as secret-name for every pattern, case and path form, with no override', async () => {
    const t = await ready()
    const names = [
      '.env', '.env.local', '.ENV', '.env.production', 'server.pem', 'KEY.PEM', 'id_rsa', 'id_rsa.pub', 'ID_RSA', 'id_ed25519', 'passwords.txt', 'Passwords.CSV',
      'credentials.json', '.npmrc', '.netrc', 'cert.pfx', 'putty.ppk', 'vault.kdbx', 'my.key', 'cookies', 'Login Data',
      'docs/.env', 'C:\\Users\\yo\\.env', '..\\..\\id_rsa', '.env/readme.txt', '\\\\server\\share\\id_rsa.txt', '.env.'
    ]
    for (const name of names) {
      const response = await t.h.call(CHAT, putBody(name, bytesOf('TOKEN=1')))
      expect({ name, error: errorOf(response), status: response.status }).toEqual({ name, error: 'secret-name', status: 422 })
    }
    expect(t.onDisk()).toEqual({ folders: [], records: [] })
    expect(errorOf(await t.h.call(CHAT, { ...putBody('.env', bytesOf('A=1')), confirm: true }))).toBe('invalid')
    expect(errorOf(await t.h.call(CHAT, { ...putBody('.env', bytesOf('A=1')), force: true }))).toBe('invalid')
  })

  it('AC-2.4 (031 verify) names that only look similar are not over-blocked', async () => {
    const t = await ready()
    for (const name of ['environment.txt', 'keys.txt', 'pemex.txt', 'notes.md']) {
      expect({ name, status: (await t.h.call(CHAT, putBody(name, bytesOf('hola')))).status }).toEqual({ name, status: 200 })
    }
  })

  it('AC-2.4 (031 verify) the secret-name check runs before the file is classified: a .pem with PDF bytes is secret-name, not file-type', async () => {
    const t = await ready()
    expect(errorOf(await t.h.call(CHAT, putBody('x.pem', bytesOf('%PDF-1.4'))))).toBe('secret-name')
  })

  it('AC-2.5 (031 verify) location and camera metadata is gone from the stored copy of a JPEG, a PNG and a WebP', async () => {
    const t = await ready()
    const pictures: [string, Uint8Array][] = [
      ['photo.jpg', makeJpeg()],
      ['photo.png', makePng()],
      ['photo.webp', makeWebp()]
    ]
    for (const [name, data] of pictures) {
      for (const marker of MARKERS.slice(0, 3)) expect(has(data, marker)).toBe(true)
      const response = await t.h.call(CHAT, putBody(name, data))
      expect({ name, status: response.status }).toEqual({ name, status: 200 })
      expect(attachmentOf(response).kind).toBe('image')
    }
    const kept = storedBytes(t.inbox)
    expect(kept).toHaveLength(3)
    for (const stored of kept) for (const marker of MARKERS) expect(has(stored, marker)).toBe(false)
  })

  it('AC-2.5 (031 verify) the reported size is the stripped copy\'s, which may be smaller than what the phone sent', async () => {
    const t = await ready()
    const data = makeJpeg()
    const response = await t.h.call(CHAT, putBody('photo.jpg', data))
    expect(attachmentOf(response).size).toBeLessThan(data.length)
    const found = t.store.lookup(idOf(response))
    expect(found.state === 'present' && readFileSync(found.path).length).toBe(attachmentOf(response).size)
  })

  it('AC-2.5 (031 verify) a malformed picture is refused and never stored, even when it starts with the right magic', async () => {
    const t = await ready()
    const cases: [string, Uint8Array][] = [
      ['truncated jpeg segment', Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1, 2, 3])],
      ['jpeg magic only', Uint8Array.from([0xff, 0xd8, 0xff])],
      ['png signature only', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      ['riff header only', Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])]
    ]
    for (const [label, data] of cases) {
      const name = label.startsWith('png') ? 'p.png' : label.startsWith('riff') ? 'p.webp' : 'p.jpg'
      const response = await t.h.call(CHAT, putBody(name, data))
      expect({ label, error: errorOf(response) }).toEqual({ label, error: 'file-malformed' })
    }
    expect(t.onDisk()).toEqual({ folders: [], records: [] })
  })

  it('AC-2.5 (031 verify) a GIF is accepted as a picture', async () => {
    const t = await ready()
    expect(attachmentOf(await t.h.call(CHAT, putBody('anim.gif', GIF))).kind).toBe('image')
  })

  it('AC-2.6 (031 verify) a company conversation, an unknown id and a deleted one answer the same gone, and store nothing', async () => {
    const t = await ready()
    t.addThread('company-thread', 'ceo')
    t.addThread('doomed')
    t.h.chat.threads.splice(t.h.chat.threads.findIndex((x) => x.id === 'doomed'), 1)
    const body = putBody('a.txt', bytesOf('hola'))
    const answers = await Promise.all(['company-thread', 'no-such-id', 'doomed', '../../x', 'remote/../x'].map((id) => t.h.call(BY_ID, { id, ...body })))
    for (const answer of answers) {
      expect(errorOf(answer)).toBe('gone')
      expect(answer).toEqual(answers[0])
    }
    expect(t.onDisk()).toEqual({ folders: [], records: [] })
  })

  it('AC-2.7 (031 verify) a run in progress (PC, another surface or this phone) refuses the put as busy and stores nothing', async () => {
    const t = await ready()
    t.h.threads.running.add(T1)
    const body = putBody('a.txt', bytesOf('hola'))
    const byId = await t.h.call(BY_ID, { id: T1, ...body })
    expect(errorOf(byId)).toBe('busy')
    expect(byId.status).toBe(409)
    // a run the phone itself started in the shared thread
    await t.h.call('/api/chat/send', { text: 'hola' })
    expect(errorOf(await t.h.call(CHAT, body))).toBe('busy')
    expect(t.onDisk().folders).toEqual([])
    // and attaching works again once the run ends
    t.h.threads.running.delete(T1)
    expect((await t.h.call(BY_ID, { id: T1, ...body })).status).toBe(200)
  })

  it('AC-2.7 (031 verify) another device\'s run in the same conversation also makes the put busy', async () => {
    const t = await ready()
    const other = await t.device('other')
    await other.call('/api/threads/send', { id: T1, text: 'sigamos' })
    expect(errorOf(await t.h.call(BY_ID, { id: T1, ...putBody('a.txt', bytesOf('x')) }))).toBe('busy')
  })

  it('AC-2.8 (031 verify) a provider that was never shown the notice makes the put notice-needed and nothing is stored', async () => {
    const t = await ready()
    t.acknowledge([])
    const response = await t.h.call(CHAT, putBody('a.txt', bytesOf('hola')))
    expect(errorOf(response)).toBe('notice-needed')
    expect(response.status).toBe(403)
    expect(t.onDisk().folders).toEqual([])
  })

  it('AC-2.8 (031 verify) a picture also needs the vision provider acknowledged; a text file does not', async () => {
    const t = await ready()
    const agent = t.settings().agents[0].provider
    const vision = agent === 'anthropic' ? 'xai' : 'anthropic'
    t.setSettings({ images: { ...t.settings().images, vision: { provider: vision, model: 'vision-x' } } })
    t.acknowledge([agent])
    expect(errorOf(await t.h.call(CHAT, putBody('p.png', makePng())))).toBe('notice-needed')
    expect((await t.h.call(CHAT, putBody('a.txt', bytesOf('hola')))).status).toBe(200)
    t.acknowledge([agent, vision])
    expect((await t.h.call(CHAT, putBody('p.png', makePng()))).status).toBe(200)
  })

  it('AC-2.8 (031 verify) a model chosen for the conversation changes the provider that must be acknowledged', async () => {
    const t = await ready()
    const agent = t.settings().agents[0].provider
    const other = agent === 'anthropic' ? 'xai' : 'anthropic'
    t.acknowledge([agent])
    t.addThread('switched', 'general', { model: { provider: other, model: 'm' } })
    expect(errorOf(await t.h.call(BY_ID, { id: 'switched', ...putBody('a.txt', bytesOf('x')) }))).toBe('notice-needed')
    expect((await t.h.call(BY_ID, { id: T1, ...putBody('a.txt', bytesOf('x')) })).status).toBe(200)
  })

  it('AC-2.9 (031 verify) the sixth pending upload of a device is too-many; a removal frees a slot; other devices have their own', async () => {
    const t = await ready()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(idOf(await t.h.call(CHAT, putBody(`n${i}.txt`, bytesOf(`x${i}`)))))
    const sixth = await t.h.call(CHAT, putBody('n5.txt', bytesOf('x')))
    expect(errorOf(sixth)).toBe('too-many')
    expect(sixth.status).toBe(409)
    expect(t.onDisk().folders).toHaveLength(5)
    const other = await t.device('other')
    expect((await other.call(CHAT, putBody('o.txt', bytesOf('o')))).status).toBe(200)
    expect(t.onDisk().folders).toHaveLength(6)
    await t.h.call('/api/attachments/remove', { id: ids[0] })
    expect(t.onDisk().folders).toHaveLength(5)
    expect((await t.h.call(CHAT, putBody('again.txt', bytesOf('y')))).status).toBe(200)
  })

  it('AC-2.9 (031 verify) the cap counts a device\'s uploads across conversations together', async () => {
    const t = await ready()
    for (let i = 0; i < 3; i++) expect((await t.h.call(CHAT, putBody(`s${i}.txt`, bytesOf('x')))).status).toBe(200)
    for (let i = 0; i < 2; i++) expect((await t.h.call(BY_ID, { id: T1, ...putBody(`c${i}.txt`, bytesOf('x')) })).status).toBe(200)
    expect(errorOf(await t.h.call(BY_ID, { id: T1, ...putBody('c9.txt', bytesOf('x')) }))).toBe('too-many')
    expect(errorOf(await t.h.call(CHAT, putBody('s9.txt', bytesOf('x'))))).toBe('too-many')
  })

  it('AC-2.9 (031 verify) a sent or expired upload frees its slot', async () => {
    const t = await ready()
    t.h.setNow(1_000)
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(idOf(await t.h.call(CHAT, putBody(`n${i}.txt`, bytesOf('x')))))
    expect(errorOf(await t.h.call(CHAT, putBody('x.txt', bytesOf('x'))))).toBe('too-many')
    expect((await t.h.call('/api/chat/send', { text: '', attachments: [ids[0]] })).status).toBe(200)
    t.h.chat.resolveAsk(0, 'listo')
    await Promise.resolve()
    expect((await t.h.call(CHAT, putBody('x.txt', bytesOf('x')))).status).toBe(200)
    expect(errorOf(await t.h.call(CHAT, putBody('y.txt', bytesOf('x'))))).toBe('too-many')
    t.h.setNow(1_000 + PHONE_ATTACH.pendingTtlMs)
    expect((await t.h.call(CHAT, putBody('y.txt', bytesOf('x')))).status).toBe(200)
  })

  it('AC-2.10 (031 verify) 61 uploads in a minute: the 61st is rate-limited, refused ones count, and the limits did not change', async () => {
    const t = await ready()
    t.h.setNow(10_000)
    for (let i = 0; i < 60; i++) expect(errorOf(await t.h.call(CHAT, putBody('x.exe', bytesOf('x'))))).toBe('file-type')
    const sixtyFirst = await t.h.call(CHAT, putBody('x.exe', bytesOf('x')))
    expect(errorOf(sixtyFirst)).toBe('rate-limited')
    expect(sixtyFirst.status).toBe(429)
    t.h.setNow(10_000 + 60_001)
    expect(errorOf(await t.h.call(CHAT, putBody('x.exe', bytesOf('x'))))).toBe('file-type')
  })

  it('AC-2.11 (031 verify) the file cannot be written: the answer names storage and no folder or record is left', async () => {
    let writes = 0
    const failing = await rig({
      io: {
        writeFileSync: (() => {
          writes += 1
          throw new Error('ENOSPC: no space left on device')
        }) as never
      }
    })
    const response = await failing.h.call(CHAT, putBody('a.txt', bytesOf('hola')))
    expect(errorOf(response)).toBe('storage')
    expect(response.status).toBe(500)
    expect(writes).toBeGreaterThan(0)
    expect(failing.onDisk()).toEqual({ folders: [], records: [] })
    // a failed put holds no slot
    for (let i = 0; i < 6; i++) expect(errorOf(await failing.h.call(CHAT, putBody('a.txt', bytesOf('hola'))))).toBe('storage')
  })

  it('AC-2.11 (031 verify) the file was written but the record could not be: nothing is left behind', async () => {
    const failing = await rig({
      io: {
        renameSync: (() => {
          throw new Error('EPERM: locked')
        }) as never
      }
    })
    const response = await failing.h.call(CHAT, putBody('a.txt', bytesOf('hola')))
    expect(errorOf(response)).toBe('storage')
    expect(failing.onDisk()).toEqual({ folders: [], records: [] })
    const left = existsLeftovers(failing.inbox)
    expect(left).toEqual([])
  })

  it('AC-9.5 (031 verify) a hostile name never decides where the file lands: every entry sits in a one-segment folder of the store', async () => {
    const t = await ready()
    const names = ['../../escape.txt', '..\\..\\escape.txt', '\\\\server\\share\\x.txt', 'C:\\Windows\\win.txt', 'a\r\nb.txt', 'CON.txt', 'nul', 'a\u0000b.txt', '....txt', ' .txt']
    for (const name of names) await t.h.call(CHAT, putBody(name, bytesOf('hola')))
    const root = join(t.inbox, 'attachments')
    for (const folder of t.onDisk().folders) {
      expect(folder).toMatch(/^[0-9a-f-]{36}$/)
      for (const file of readdirSync(join(root, folder))) expect(file).toMatch(/^\w[\w.-]{0,59}$/)
    }
    expect(readdirSync(t.inbox)).toEqual(['attachments'])
  })

  it('AC-2.3 (031 verify) concurrent puts never exceed the cap of five', async () => {
    const t = await ready()
    const answers = await Promise.all(Array.from({ length: 9 }, (_, i) => t.h.call(CHAT, putBody(`n${i}.txt`, bytesOf(`${i}`)))))
    expect(answers.filter((a) => a.status === 200)).toHaveLength(5)
    expect(t.onDisk().folders).toHaveLength(5)
  })

  it('AC-3.3 (031 verify) after a restart nothing is pending: the files stay on disk and a send naming them is refused', async () => {
    const t = await ready()
    const id = idOf(await t.h.call(CHAT, putBody('a.txt', bytesOf('hola'))))
    // a restarted process: a new flow over the same store, with nothing in memory
    const restarted = new UploadsFlow({
      now: () => 0,
      sharedId: () => SHARED,
      reachable: () => undefined,
      isRunning: () => false,
      files: t.h.files,
      timers: t.h.timers
    })
    const device = (await t.h.phone()).deviceId
    expect(restarted.claim(device, SHARED, [id])).toEqual({ ok: false })
    expect(t.store.lookup(id).state).toBe('present')
    expect(t.onDisk().folders).toContain(id)
  })
})

function existsLeftovers(inbox: string): string[] {
  const root = join(inbox, 'attachments')
  try {
    return readdirSync(root)
  } catch {
    return []
  }
}

