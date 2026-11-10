import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../src/shared/defaults'
import { resolveVision } from '../src/shared/images/vision'
import type { PublicSettings, Settings } from '../src/shared/types'

// Independent verification of spec 038 at the settings store (main). Written from spec.md only.

const electron = vi.hoisted(() => ({ userData: '', sealed: true }))
vi.mock('electron', () => ({
  app: { getPath: () => electron.userData },
  safeStorage: {
    isEncryptionAvailable: () => electron.sealed,
    encryptString: (text: string) => Buffer.from(`E${text}`),
    decryptString: (bytes: Buffer) => bytes.toString().slice(1)
  }
}))
import { SettingsStore } from '../src/main/settings'

const KEY = 'xai-abcdefghijklmnopqrstuvwxyz0123'
let envBefore: Record<string, string | undefined>
const ENV = ['META_API_KEY', 'XAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'AI_GATEWAY_API_KEY', 'ALMA_ALLOW_PLAINTEXT_SECRETS']

beforeEach(() => {
  electron.userData = mkdtempSync(join(tmpdir(), 'alma-verify-038-'))
  electron.sealed = true
  envBefore = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))
  for (const k of ENV) delete process.env[k]
})
afterEach(() => {
  for (const k of ENV) {
    if (envBefore[k] === undefined) delete process.env[k]
    else process.env[k] = envBefore[k]
  }
  rmSync(electron.userData, { recursive: true, force: true })
})

const file = (): string => join(electron.userData, 'settings.json')
const write = (data: unknown): void => writeFileSync(file(), typeof data === 'string' ? data : JSON.stringify(data))
const disk = (): Record<string, unknown> & { home: Record<string, unknown>; images: Record<string, unknown> } => JSON.parse(readFileSync(file(), 'utf8'))
const open = (): SettingsStore => new SettingsStore(['en'])

/** A settings file as an older version wrote it: no `images.vision`, the pair under `home`. */
function legacyFile(home: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const s = defaultSettings('en')
  const { vision: _v, ...images } = s.images
  return { ...s, images, home: { ...s.home, ...home }, ...extra }
}

describe('AC-3.1 / AC-3.2 / AC-3.3 (038 verify) migration through the store', () => {
  it('AC-3.1 (038 verify) a legacy pair is shown in Images, Casa is emptied, the file is rewritten and looks behave as before', () => {
    write(legacyFile({ visionProvider: 'xai', visionModel: 'grok-4' }))
    const store = open()
    expect(store.get().images.vision).toEqual({ provider: 'xai', model: 'grok-4' })
    expect(store.get().home).not.toHaveProperty('visionProvider')
    expect(store.get().home).not.toHaveProperty('visionModel')
    expect(store.getPublic().home).not.toHaveProperty('visionProvider')
    const onDisk = disk()
    expect(onDisk.images.vision).toEqual({ provider: 'xai', model: 'grok-4' })
    expect(onDisk.home).not.toHaveProperty('visionProvider')
    expect(onDisk.home).not.toHaveProperty('visionModel')
    expect(onDisk.visionMigrated).toBe(true)
    const s = store.get()
    expect(resolveVision(s, () => true)).toEqual({ provider: 'xai', model: 'grok-4', via: 'chosen' })
  })

  it('AC-3.2 (038 verify) no vision values: Automatic', () => {
    write(legacyFile({}))
    const store = open()
    expect(store.get().images.vision).toEqual({ provider: '', model: '' })
    expect(store.get().attachments.noticeAcknowledged).toEqual([])
  })

  it('AC-3.3 (038 verify) a legacy provider with no model keeps the provider, empty model, and stays held (not acknowledged by migration)', () => {
    write(legacyFile({ visionProvider: 'anthropic' }))
    const store = open()
    expect(store.get().images.vision).toEqual({ provider: 'anthropic', model: '' })
    expect(store.get().attachments.noticeAcknowledged).toEqual([])
    expect(resolveVision(store.get(), () => true).held).toBe('anthropic')
    expect(disk().attachments).toEqual({ noticeAcknowledged: [] })
  })

  it('AC-3.1 (038 verify) unknown provider, openai, non-string model and key-shaped model', () => {
    const cases: [Record<string, unknown>, { provider: string; model: string }][] = [
      [{ visionProvider: 'ghost', visionModel: 'm' }, { provider: '', model: '' }],
      [{ visionProvider: 'openai', visionModel: 'gpt-4o' }, { provider: '', model: '' }],
      [{ visionProvider: 'xai', visionModel: 9 }, { provider: 'xai', model: '' }],
      [{ visionProvider: 'xai', visionModel: KEY }, { provider: 'xai', model: '' }],
      [{ visionProvider: 12, visionModel: 'm' }, { provider: '', model: '' }]
    ]
    for (const [home, expected] of cases) {
      write(legacyFile(home))
      const store = open()
      expect(store.get().images.vision, JSON.stringify(home)).toEqual(expected)
      expect(JSON.stringify(disk())).not.toContain(KEY)
    }
  })

  it('AC-3.4 (038 verify) Images already holds a choice: the stale Casa pair does not overwrite it', () => {
    const s = defaultSettings('en')
    write(legacyFile({ visionProvider: 'xai', visionModel: 'grok-4' }, { images: { ...s.images, vision: { provider: 'meta', model: 'muse-spark' } } }))
    expect(open().get().images.vision).toEqual({ provider: 'meta', model: 'muse-spark' })
  })

  it('AC-3.4 (038 verify) loading again (a new store on the rewritten file) changes nothing and rewrites nothing', () => {
    write(legacyFile({ visionProvider: 'xai', visionModel: 'grok-4' }))
    open()
    const first = readFileSync(file(), 'utf8')
    const again = open()
    expect(readFileSync(file(), 'utf8')).toBe(first)
    expect(again.get().images.vision).toEqual({ provider: 'xai', model: 'grok-4' })
  })

  it('AC-3.4 (038 verify) without a secure store the file is not rewritten (keys would be blanked) but the result is identical on every load', () => {
    electron.sealed = false
    write(legacyFile({ visionProvider: 'xai', visionModel: 'grok-4' }))
    const raw = readFileSync(file(), 'utf8')
    const a = open().get()
    expect(readFileSync(file(), 'utf8')).toBe(raw)
    const b = open().get()
    expect(a.images.vision).toEqual({ provider: 'xai', model: 'grok-4' })
    expect(b.images).toEqual(a.images)
    expect(b.home).toEqual(a.home)
  })

  it('AC-3.4 (038 verify) the person cleared Images to Automatic: a later load (stale pair gone from disk by the update) never resurrects it', () => {
    write(legacyFile({ visionProvider: 'xai', visionModel: 'grok-4' }))
    const store = open()
    const images = store.get().images
    store.update({ images: { ...images, vision: { provider: '', model: '' } } })
    expect(open().get().images.vision).toEqual({ provider: '', model: '' })
  })

  it('AC-3.4 (038 verify) a stale file with the marker set AND legacy keys (older build wrote them back): stripped on load, Images untouched, file rewritten', () => {
    const s = defaultSettings('en')
    write(legacyFile({ visionProvider: 'xai', visionModel: 'grok-4' }, { visionMigrated: true, images: { ...s.images, vision: { provider: '', model: '' } } }))
    const store = open()
    expect(store.get().images.vision).toEqual({ provider: '', model: '' })
    expect(store.get().home).not.toHaveProperty('visionProvider')
    expect(disk().home).not.toHaveProperty('visionProvider')
    expect(disk().home).not.toHaveProperty('visionModel')
  })

  it('AC-3.2 (038 verify) fresh install: nothing is written by the migration', () => {
    const store = open()
    expect(existsSync(file())).toBe(false)
    expect(store.get().images.vision).toEqual({ provider: '', model: '' })
  })

  it('AC-3.2 (038 verify) a corrupt or non-object file falls back to defaults and does not throw', () => {
    for (const raw of ['', '{', 'null', '[]', '"x"', '{"images":', '{"home":null}', '{"images":null,"home":5}']) {
      write(raw)
      expect(() => open(), raw).not.toThrow()
      expect(open().get().images.vision, raw).toEqual({ provider: '', model: '' })
    }
  })
})

describe('AC-1.8 / AC-1.4 (038 verify) the shallow-merge trap', () => {
  it('AC-1.8 (038 verify) a stored images without or with a malformed see part loads with the see part empty and the create part kept', () => {
    for (const vision of [undefined, null, 'x', 5, [], {}, { provider: 'xai' }, { provider: 'xai', model: 3 }, { provider: 'openai', model: 'm' }, { provider: 'zzz', model: 'm' }]) {
      const s = defaultSettings('en')
      write({ ...s, images: { provider: 'xai', model: 'grok-2-image', ...(vision === undefined ? {} : { vision }) }, visionMigrated: true })
      const store = open()
      expect(store.get().images, JSON.stringify(vision)).toEqual({ provider: 'xai', model: 'grok-2-image', vision: { provider: '', model: '' } })
    }
    write({ ...defaultSettings('en'), images: undefined, visionMigrated: true })
    expect(open().get().images).toEqual(defaultSettings('en').images)
    write({ ...defaultSettings('en'), images: 'weird' })
    expect(open().get().images).toEqual(defaultSettings('en').images)
  })

  it('AC-1.8 (038 verify) update() with an images patch that omits vision keeps vision; with malformed vision keeps vision', () => {
    const store = open()
    store.update({ images: { provider: 'meta', model: '', vision: { provider: 'xai', model: 'grok-4' } } })
    store.update({ images: { provider: 'openai', model: 'gpt-image-1' } as unknown as PublicSettings['images'] })
    expect(store.get().images).toEqual({ provider: 'openai', model: 'gpt-image-1', vision: { provider: 'xai', model: 'grok-4' } })
    for (const vision of [null, 'x', [], {}, { provider: 'ghost', model: 'm' }, { provider: 'xai', model: 1 }, { provider: 'openai', model: 'm' }]) {
      store.update({ images: { provider: 'openai', model: 'gpt-image-1', vision } as unknown as PublicSettings['images'] })
      expect(store.get().images.vision, JSON.stringify(vision)).toEqual({ provider: 'xai', model: 'grok-4' })
    }
    expect(disk().images).toEqual({ provider: 'openai', model: 'gpt-image-1', vision: { provider: 'xai', model: 'grok-4' } })
  })

  it('AC-1.8 (038 verify) every ordering of create and see edits leaves the other group exactly as it was', () => {
    type Images = PublicSettings['images']
    const createEdits: ((i: Images) => Images)[] = [
      (i) => ({ ...i, provider: 'xai', model: '' }),
      (i) => ({ ...i, model: 'grok-imagine-image' }),
      (i) => ({ ...i, provider: 'openai', model: '' }),
      (i) => ({ ...i, model: '' })
    ]
    const seeEdits: ((i: Images) => Images)[] = [
      (i) => ({ ...i, vision: { provider: 'anthropic', model: '' } }),
      (i) => ({ ...i, vision: { provider: 'anthropic', model: 'claude-sonnet-4-5' } }),
      (i) => ({ ...i, vision: { provider: '', model: '' } }),
      (i) => ({ ...i, vision: { provider: 'deepseek', model: 'dsv' } })
    ]
    const orders: ('c' | 's')[][] = []
    const walk = (acc: ('c' | 's')[]): void => {
      if (acc.length === 6) return void orders.push(acc)
      walk([...acc, 'c'])
      walk([...acc, 's'])
    }
    walk([])
    for (const order of orders) {
      rmSync(file(), { force: true })
      const store = open()
      let c = 0
      let s = 0
      for (const group of order) {
        const before = store.get().images
        // the renderer always sends the whole object
        const edit = group === 'c' ? createEdits[c++ % createEdits.length] : seeEdits[s++ % seeEdits.length]
        const next = edit(before as Images)
        store.update({ images: next })
        const after = store.get().images
        if (group === 'c') expect(after.vision, order.join('')).toEqual(before.vision)
        else {
          expect(after.provider, order.join('')).toBe(before.provider)
          expect(after.model, order.join('')).toBe(before.model)
        }
        expect(after).toEqual(next)
      }
      expect(open().get().images).toEqual(store.get().images)
    }
  })

  it('AC-1.8 (038 verify) a patch carrying ONLY the see part keeps the create part', () => {
    const store = open()
    store.update({ images: { provider: 'xai', model: 'grok-2-image', vision: { provider: '', model: '' } } })
    store.update({ images: { vision: { provider: 'meta', model: 'muse-spark' } } as unknown as PublicSettings['images'] })
    expect(store.get().images).toEqual({ provider: 'xai', model: 'grok-2-image', vision: { provider: 'meta', model: 'muse-spark' } })
  })

  it('AC-1.8 (038 verify) other top-level patches do not touch images', () => {
    const store = open()
    store.update({ images: { provider: 'xai', model: '', vision: { provider: 'xai', model: 'grok-4' } } })
    store.update({ privacy: { threadRetentionDays: 3 } })
    store.update({ attachments: { noticeAcknowledged: ['xai'] } })
    expect(store.get().images.vision).toEqual({ provider: 'xai', model: 'grok-4' })
    expect(store.get().images.provider).toBe('xai')
  })

  it('AC-3.4 (038 verify) a home patch from a stale window carrying the old keys never stores them', () => {
    const store = open()
    const home = { ...store.get().home, visionProvider: 'xai', visionModel: 'grok-4' } as unknown as PublicSettings['home']
    store.update({ home })
    expect(store.get().home).not.toHaveProperty('visionProvider')
    expect(store.get().home).not.toHaveProperty('visionModel')
    expect(disk().home).not.toHaveProperty('visionProvider')
    expect(disk().home).not.toHaveProperty('visionModel')
    // and the next load does not migrate them into Images either
    expect(open().get().images.vision).toEqual({ provider: '', model: '' })
  })

  it('AC-3.4 (038 verify) every home patch strips them, whatever else the home patch changes', () => {
    const store = open()
    for (const extra of [{ enabled: true }, { agentId: 'general' }, { mirrored: true }]) {
      store.update({ home: { ...store.get().home, ...extra, visionProvider: 'anthropic', visionModel: 'claude-x' } as unknown as PublicSettings['home'] })
      expect(Object.keys(store.get().home)).not.toContain('visionProvider')
      expect(Object.keys(store.get().home)).not.toContain('visionModel')
      expect(store.get().images.vision).toEqual({ provider: '', model: '' })
    }
  })

  it('AC-1.4 (038 verify) a key pasted into either model field on disk is wiped on load, the file is rewritten without it, even with no secure store', () => {
    for (const sealed of [true, false]) {
      electron.sealed = sealed
      const s = defaultSettings('en')
      write({ ...s, visionMigrated: true, images: { provider: 'openai', model: KEY, vision: { provider: 'anthropic', model: 'sk-ant-abcdefghijklmnopqrstuvwxyz' } } })
      const store = open()
      expect(store.get().images, String(sealed)).toEqual({ provider: 'openai', model: '', vision: { provider: 'anthropic', model: '' } })
      const raw = readFileSync(file(), 'utf8')
      expect(raw).not.toContain(KEY)
      expect(raw).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz')
    }
  })

  it('AC-1.4 (038 verify) a key only in the see field wipes only the see model; only in the create field wipes only the create model', () => {
    const s = defaultSettings('en')
    write({ ...s, visionMigrated: true, images: { provider: 'openai', model: 'gpt-image-1', vision: { provider: 'xai', model: KEY } } })
    expect(open().get().images).toEqual({ provider: 'openai', model: 'gpt-image-1', vision: { provider: 'xai', model: '' } })
    write({ ...s, visionMigrated: true, images: { provider: 'openai', model: KEY, vision: { provider: 'xai', model: 'grok-4' } } })
    expect(open().get().images).toEqual({ provider: 'openai', model: '', vision: { provider: 'xai', model: 'grok-4' } })
  })

  it('AC-1.4 (038 verify) a key that reaches update() in either model field is removed on the next load and never survives in a reloaded store', () => {
    const store = open()
    store.update({ images: { provider: 'xai', model: KEY, vision: { provider: 'xai', model: KEY } } })
    const reloaded = open()
    expect(reloaded.get().images.model).toBe('')
    expect(reloaded.get().images.vision.model).toBe('')
    expect(readFileSync(file(), 'utf8')).not.toContain(KEY)
  })

  it('AC-1.4 (038 verify) migrating a legacy key-shaped model does not leave it on disk', () => {
    write(legacyFile({ visionProvider: 'xai', visionModel: KEY }))
    open()
    expect(readFileSync(file(), 'utf8')).not.toContain(KEY)
  })

  it('AC-1.8 (038 verify) applyMetaDefault keeps vision (and the acknowledged list) when it moves the create service', () => {
    process.env.META_API_KEY = 'meta-key-for-test-purposes'
    const s = defaultSettings('en')
    write({
      ...s,
      images: { provider: 'xai', model: '', vision: { provider: 'anthropic', model: 'claude-x' } },
      attachments: { noticeAcknowledged: ['anthropic'] },
      visionMigrated: true
    })
    const store = open()
    expect(store.get().images).toEqual({ provider: 'meta', model: '', vision: { provider: 'anthropic', model: 'claude-x' } })
    expect(store.get().attachments.noticeAcknowledged).toEqual(['anthropic'])
    expect(open().get().images.vision).toEqual({ provider: 'anthropic', model: 'claude-x' })
  })

  it('AC-1.8 (038 verify) getPublic carries images.vision and never an API key', () => {
    const store = open()
    store.setApiKey('xai', KEY)
    store.update({ images: { provider: 'meta', model: '', vision: { provider: 'xai', model: 'grok-4' } } })
    const pub = store.getPublic()
    expect(pub.images.vision).toEqual({ provider: 'xai', model: 'grok-4' })
    expect(JSON.stringify(pub)).not.toContain(KEY)
  })

  it('AC-4.8 (038 verify) provider, empty model and acknowledgement saved together survive one update and a reload', () => {
    const store = open()
    const s: Settings = store.get()
    store.update({
      images: { ...s.images, vision: { provider: 'xai', model: '' } },
      attachments: { noticeAcknowledged: [...s.attachments.noticeAcknowledged, 'xai'] }
    })
    const again = open().get()
    expect(again.images.vision).toEqual({ provider: 'xai', model: '' })
    expect(again.attachments.noticeAcknowledged).toEqual(['xai'])
    expect(resolveVision(again, () => true)).toMatchObject({ provider: 'xai', via: 'chosen' })
  })

  it('AC-4.7 (038 verify) acknowledging later (a separate attachments update) flips the gate with no restart', () => {
    const store = open()
    store.update({ images: { ...store.get().images, vision: { provider: 'xai', model: '' } } })
    expect(resolveVision(store.get(), () => true).via).toBe('fallback')
    store.update({ attachments: { noticeAcknowledged: ['xai'] } })
    expect(resolveVision(store.get(), () => true).via).toBe('chosen')
  })
})
