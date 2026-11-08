import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en } from '../src/remote-client/i18n/en'
import { es } from '../src/remote-client/i18n/es'
import { canList } from '../src/remote-client/lib/can'
import { fetchStatus, statusEvent } from '../src/remote-client/lib/status'
import type { FetchLike, FetchResponse } from '../src/remote-client/lib/session'
import type { StatusView } from '../src/shared/remote/wire'

const answer = (status: number, body: unknown): FetchResponse => ({ ok: status < 300, status, json: async () => body })

const status = (over: Partial<StatusView['scopes']> = {}, rest: Partial<Omit<StatusView, 'scopes'>> = {}): StatusView => ({
  scopes: { chat: false, approve: false, home: false, cameras: false, vault: false, history: false, ...over },
  sensitive: false,
  continue: false,
  ...rest
})

describe('what this phone can do (028 AC-6.7)', () => {
  it('AC-6.7 (028) can-list reflects status and has no entry for exclusions or cameras', () => {
    expect(canList(status())).toEqual([
      { key: 'remote.pwa.can.chat', on: false },
      { key: 'remote.pwa.can.approve', on: false },
      { key: 'remote.pwa.can.home', on: false },
      { key: 'remote.pwa.can.cameras', on: false },
      { key: 'remote.pwa.can.sensitive', on: false },
      { key: 'remote.pwa.can.notes', on: false },
      { key: 'remote.pwa.can.threads', on: false },
      { key: 'remote.pwa.can.continue', on: false }
    ])
    const all = canList(status({ chat: true, approve: true, home: true, cameras: true, vault: true, history: true }, { sensitive: true, continue: true }))
    expect(all.every((row) => row.on)).toBe(true)
    // Each switch drives its own row and no other.
    const onKeys = (view: StatusView) => canList(view).filter((row) => row.on).map((row) => row.key)
    expect(onKeys(status({ vault: true }))).toEqual(['remote.pwa.can.notes'])
    expect(onKeys(status({ history: true }))).toEqual(['remote.pwa.can.threads'])
    expect(onKeys(status({}, { sensitive: true }))).toEqual(['remote.pwa.can.sensitive'])
    expect(onKeys(status({ history: true }, { continue: true }))).toEqual(['remote.pwa.can.threads', 'remote.pwa.can.continue'])
    // Only a name and a state per row: nothing about which cameras, which folders are excluded or which devices.
    for (const row of all) expect(Object.keys(row).sort()).toEqual(['key', 'on'])
    // Every row has its text in both languages.
    for (const row of all) {
      expect(es[row.key], row.key).toBeTruthy()
      expect(en[row.key], row.key).toBeTruthy()
    }
  })

  it('AC-6.7 (028) the status is read with a GET and keeps only the known switches', async () => {
    const calls: { url: string; init?: { method?: string; headers?: Record<string, string> } }[] = []
    const good = status({ vault: true, history: true }, { continue: true })
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, init })
      return answer(200, { ...good, deviceId: 'd1', excluded: ['Privado'] })
    }
    expect(await fetchStatus({ fetch, token: 'tok' })).toEqual({ ok: true, status: good })
    expect(calls[0].url).toBe('/api/status')
    expect(calls[0].init?.method).toBeUndefined()
    expect(calls[0].init?.headers).toEqual({ authorization: 'Bearer tok' })
    const reply = (code: number, body: unknown): FetchLike => async () => answer(code, body)
    expect(await fetchStatus({ fetch: reply(401, { error: 'unknown-device' }), token: 't' })).toEqual({ ok: false, reason: 'unknown-device' })
    expect(await fetchStatus({ fetch: reply(200, { scopes: { chat: 'yes' } }), token: 't' })).toEqual({ ok: false, reason: 'network' })
    const down: FetchLike = async () => {
      throw new TypeError('fetch failed')
    }
    expect(await fetchStatus({ fetch: down, token: 't' })).toEqual({ ok: false, reason: 'network' })
  })

  it('AC-6.7 (028) a hostile or old status reads as off: a missing or non-boolean value is never on', () => {
    const odd = { scopes: { chat: 'yes', vault: 1 }, continue: undefined } as unknown as StatusView
    expect(canList(odd).every((row) => !row.on)).toBe(true)
    expect(canList({} as StatusView).every((row) => !row.on)).toBe(true)
  })

  it('AC-6.7 (028) the status becomes a screen state: the switches as content, a refusal by its reason', () => {
    expect(statusEvent({ ok: true, status: status({ vault: true }) })).toEqual({ type: 'content', data: status({ vault: true }) })
    expect(statusEvent({ ok: false, reason: 'unknown-device' })).toEqual({ type: 'failed', reason: 'unknown-device', operation: 'status' })
    expect(statusEvent({ ok: false, reason: 'network' })).toEqual({ type: 'failed', reason: 'network', operation: 'status' })
  })

  it('AC-6.7 (028) Settings has no scope toggle and no language switch, and shows the version and Forget this PC', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'remote-client', 'screens', 'Settings.tsx'), 'utf8')
    expect(source).not.toMatch(/type=['"]checkbox['"]|role=['"]switch['"]|<select|aria-checked/)
    expect(source).not.toMatch(/navigator\.language|phoneLanguage|setLanguage|localStorage/)
    expect(source).not.toMatch(/\.(?:scopes|continue|sensitive)\s*=[^=]/)
    expect(source).toContain('remote.pwa.version')
    expect(source).toContain('remote.pwa.forget')
    expect(source).toContain('canList(')
  })
})
