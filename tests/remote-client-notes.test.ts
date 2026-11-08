import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fetchImage, findNotes, listFolder, readNote } from '../src/remote-client/lib/notes'
import { outcomeKey } from '../src/remote-client/lib/outcome'
import type { FetchLike, FetchResponse } from '../src/remote-client/lib/session'

type Call = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }

function respond(status: number, body: unknown): FetchResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function fake(handler: (call: Call) => FetchResponse): FetchLike & { calls: Call[] } {
  const calls: Call[] = []
  const fetch = (async (url: string, init?: Call['init']) => {
    calls.push({ url, init })
    return handler({ url, init })
  }) as FetchLike & { calls: Call[] }
  fetch.calls = calls
  return fetch
}

const down: FetchLike = async () => {
  throw new TypeError('fetch failed')
}

describe('PWA notes client (028 AC-2.1, AC-2.6, AC-2.10, AC-2.11, AC-1.7)', () => {
  it('AC-2.1 (028) client posts the folder and parses entries', async () => {
    const entries = [
      { name: 'Ideas', kind: 'folder', size: 0, mtime: 5 },
      { name: 'hola.md', kind: 'file', size: 12, mtime: 9 }
    ]
    const fetch = fake(() => respond(200, { folder: 'Docs', entries: [...entries, { name: 3 }, 'x', null] }))
    const out = await listFolder({ fetch, token: 'tok', folder: 'Docs' })
    expect(out).toEqual({ ok: true, folder: 'Docs', entries })
    expect(fetch.calls).toHaveLength(1)
    expect(fetch.calls[0].url).toBe('/api/notes/list')
    expect(fetch.calls[0].init?.method).toBe('POST')
    expect(fetch.calls[0].init?.headers).toMatchObject({ authorization: 'Bearer tok', 'content-type': 'application/json' })
    expect(JSON.parse(fetch.calls[0].init?.body ?? '')).toEqual({ folder: 'Docs' })
  })

  it('AC-2.2 (028) no vault is a state of its own, not an error and not an empty folder', async () => {
    expect(await listFolder({ fetch: fake(() => respond(200, { vault: 'none' })), token: 't', folder: '' })).toEqual({ ok: true, vault: 'none' })
    expect(await listFolder({ fetch: fake(() => respond(200, { folder: '', entries: [] })), token: 't', folder: '' })).toEqual({ ok: true, folder: '', entries: [] })
    expect(await findNotes({ fetch: fake(() => respond(200, { vault: 'none' })), token: 't', query: 'a' })).toEqual({ ok: true, vault: 'none' })
  })

  it('AC-2.10 (028) client posts the query and parses the found list', async () => {
    const fetch = fake(() => respond(200, { found: [{ path: 'A/b.md', name: 'b.md' }, { path: 4 }] }))
    expect(await findNotes({ fetch, token: 'tok', query: 'b' })).toEqual({ ok: true, found: [{ path: 'A/b.md', name: 'b.md' }] })
    expect(fetch.calls[0].url).toBe('/api/notes/find')
    expect(JSON.parse(fetch.calls[0].init?.body ?? '')).toEqual({ query: 'b' })
  })

  it('AC-2.3 (028) the note text comes back verbatim, CRLF and all', async () => {
    const content = '---\r\ntitle: x\r\n---\r\n# Hola\r\n\u{1F600}'
    const fetch = fake(() => respond(200, { path: 'Docs/a.md', content, mtime: 7 }))
    expect(await readNote({ fetch, token: 'tok', path: 'Docs/a.md' })).toEqual({ ok: true, path: 'Docs/a.md', content, mtime: 7 })
    expect(fetch.calls[0].url).toBe('/api/notes/read')
    expect(JSON.parse(fetch.calls[0].init?.body ?? '')).toEqual({ path: 'Docs/a.md' })
  })

  it('AC-2.6 (028) the client never reads from storage or caches: every open asks the PC again', async () => {
    let text = 'v1'
    const fetch = fake(() => respond(200, { path: 'a.md', content: text, mtime: 1 }))
    expect(await readNote({ fetch, token: 't', path: 'a.md' })).toMatchObject({ content: 'v1' })
    text = 'v2'
    expect(await readNote({ fetch, token: 't', path: 'a.md' })).toMatchObject({ content: 'v2' })
    expect(fetch.calls).toHaveLength(2)
    // A note that vanished answers unavailable now; the earlier text is nowhere to fall back to.
    const gone = fake(() => respond(404, { error: 'unavailable' }))
    expect(await readNote({ fetch: gone, token: 't', path: 'a.md' })).toEqual({ ok: false, reason: 'unavailable' })
    for (const file of ['notes.ts', 'request.ts']) {
      const source = readFileSync(join(__dirname, '..', 'src', 'remote-client', 'lib', file), 'utf8')
      expect(source, file).not.toMatch(/indexedDB|localStorage|sessionStorage|\bcaches\b|idbStorage|Storage\b/)
    }
  })

  it('AC-2.11 (028) 413 maps to the photo reason, the image comes back as base64 and its type', async () => {
    const fetch = fake(() => respond(200, { photo: 'QUJD', mediaType: 'image/png' }))
    expect(await fetchImage({ fetch, token: 't', target: 'a.png', from: 'Docs/n.md' })).toEqual({ ok: true, photo: 'QUJD', mediaType: 'image/png' })
    expect(fetch.calls[0].url).toBe('/api/notes/image')
    expect(JSON.parse(fetch.calls[0].init?.body ?? '')).toEqual({ target: 'a.png', from: 'Docs/n.md' })
    const big = await fetchImage({ fetch: fake(() => respond(413, { error: 'too-large' })), token: 't', target: 'a.png', from: '' })
    expect(big).toEqual({ ok: false, reason: 'too-large' })
    if (!big.ok) expect(outcomeKey(big.reason, 'notes.image')).toBe('remote.pwa.photoTooBig')
  })

  it('AC-1.7 (028) 401 is refused as an unknown device, on every notes call', async () => {
    const refused = fake(() => respond(401, { error: 'unknown-device' }))
    const expected = { ok: false, reason: 'unknown-device' }
    expect(await listFolder({ fetch: refused, token: 't', folder: '' })).toEqual(expected)
    expect(await findNotes({ fetch: refused, token: 't', query: 'a' })).toEqual(expected)
    expect(await readNote({ fetch: refused, token: 't', path: 'a.md' })).toEqual(expected)
    expect(await fetchImage({ fetch: refused, token: 't', target: 'a.png', from: '' })).toEqual(expected)
  })

  it('AC-6.3 (028) each failure keeps its own cause: the body names it, the status is the fallback', async () => {
    const as = async (status: number, body: unknown) => readNote({ fetch: fake(() => respond(status, body)), token: 't', path: 'a.md' })
    expect(await as(403, { error: 'scope-off' })).toEqual({ ok: false, reason: 'scope-off' })
    expect(await as(415, { error: 'unsupported' })).toEqual({ ok: false, reason: 'unsupported' })
    expect(await as(413, { error: 'too-large' })).toEqual({ ok: false, reason: 'too-large' })
    expect(await as(429, { error: 'rate-limited' })).toEqual({ ok: false, reason: 'rate-limited' })
    expect(await as(429, undefined)).toEqual({ ok: false, reason: 'rate-limited' })
    expect(await as(400, { error: 'invalid' })).toEqual({ ok: false, reason: 'invalid' })
    // An unknown error text is not trusted as a reason; a server fault is the PC not answering.
    expect(await as(500, { error: 'boom' })).toEqual({ ok: false, reason: 'network' })
    expect(await as(200, { nope: true })).toEqual({ ok: false, reason: 'network' })
    expect(await readNote({ fetch: down, token: 't', path: 'a.md' })).toEqual({ ok: false, reason: 'network' })
  })
})
