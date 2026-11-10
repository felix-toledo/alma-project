import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveVision } from '../src/shared/images/vision'
import type { Settings } from '../src/shared/types'

const electron = vi.hoisted(() => ({ userData: '', keychain: true }))
// The keychain is available unless a test turns it off: resealing without one would blank the keys, a wiped key is the one reason to rewrite anyway.
vi.mock('electron', () => ({
  app: { getPath: () => electron.userData },
  safeStorage: {
    isEncryptionAvailable: () => electron.keychain,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (bytes: Buffer) => bytes.toString()
  }
}))

import { SettingsStore } from '../src/main/settings'

const file = (): string => join(electron.userData, 'settings.json')
const onDisk = (): Record<string, any> => JSON.parse(readFileSync(file(), 'utf8'))
const write = (stored: unknown): void => writeFileSync(file(), JSON.stringify(stored))
const open = (): SettingsStore => new SettingsStore(['en'])
const KEY_SHAPED = `xai-${'x'.repeat(20)}`
const legacy = (visionProvider: string, visionModel: string, extra: object = {}) => ({ images: { provider: 'meta', model: '' }, home: { enabled: true, visionProvider, visionModel }, ...extra })

beforeEach(() => {
  electron.userData = mkdtempSync(join(tmpdir(), 'alma-vision-store-'))
  electron.keychain = true
})
afterEach(() => rmSync(electron.userData, { recursive: true, force: true }))

describe('038 the see setting on disk', () => {
  it('AC-3.1 (038) load shows the pair in images.vision, home emptied, file rewritten', () => {
    write(legacy('anthropic', 'claude-x'))
    const settings = open().get()
    expect(settings.images.vision).toEqual({ provider: 'anthropic', model: 'claude-x' })
    expect(settings.visionMigrated).toBe(true)
    expect(settings.home).not.toHaveProperty('visionProvider')
    expect(settings.home).not.toHaveProperty('visionModel')
    expect(settings.home.enabled).toBe(true)
    // the same pair is what the looks resolve to, as before
    expect(resolveVision(settings, () => true)).toEqual({ provider: 'anthropic', model: 'claude-x', via: 'chosen' })
    const saved = onDisk()
    expect(saved.images.vision).toEqual({ provider: 'anthropic', model: 'claude-x' })
    expect(saved.visionMigrated).toBe(true)
    expect(saved.home).not.toHaveProperty('visionProvider')
    expect(saved.home).not.toHaveProperty('visionModel')
  })

  it('AC-3.3 (038) store variant: a legacy provider alone loads with an empty model and is held', () => {
    write(legacy('xai', ''))
    const settings = open().get()
    expect(settings.images.vision).toEqual({ provider: 'xai', model: '' })
    expect(resolveVision(settings, () => true)).toMatchObject({ via: 'fallback', held: 'xai' })
    settings.attachments.noticeAcknowledged.push('xai')
    expect(resolveVision(settings, () => true)).toEqual({ provider: 'xai', model: '', via: 'chosen' })
  })

  it('AC-3.2 (038) nothing set stays unset, and a fresh install writes nothing', () => {
    expect(open().get().images.vision).toEqual({ provider: '', model: '' })
    expect(existsSync(file())).toBe(false)
    write(legacy('', ''))
    expect(open().get().images.vision).toEqual({ provider: '', model: '' })
    write({ language: 'es', defaultAgentId: 'alma' })
    const settings = open().get()
    expect(settings.images.vision).toEqual({ provider: '', model: '' })
    expect(resolveVision(settings, () => false).via).toBe('fallback')
  })

  it('AC-1.8 (038) a stored images without or with a malformed vision loads with it empty', () => {
    for (const vision of [undefined, 'xai', [], null, 7, { provider: 'nope', model: 'm' }, { provider: 'xai', model: 5 }, { provider: '', model: 'm' }]) {
      write({ images: { provider: 'xai', model: 'grok-imagine-image', vision } })
      expect(open().get().images, JSON.stringify(vision)).toEqual({ provider: 'xai', model: 'grok-imagine-image', vision: { provider: '', model: '' } })
    }
    write({})
    expect(open().get().images).toEqual({ provider: 'meta', model: '', vision: { provider: '', model: '' } })
  })

  it('AC-1.8 (038) applyMetaDefault keeps a chosen vision', () => {
    write({ images: { provider: 'xai', model: '', vision: { provider: 'anthropic', model: 'claude-x' } }, providers: { meta: { apiKey: 'meta-key' } } })
    expect(open().get().images).toEqual({ provider: 'meta', model: '', vision: { provider: 'anthropic', model: 'claude-x' } })
  })

  it('AC-1.4 (038) a key-looking vision model is blanked and the file rewritten', () => {
    write({ images: { provider: 'xai', model: 'grok-imagine-image', vision: { provider: 'anthropic', model: KEY_SHAPED } } })
    expect(open().get().images).toEqual({ provider: 'xai', model: 'grok-imagine-image', vision: { provider: 'anthropic', model: '' } })
    expect(onDisk().images.vision).toEqual({ provider: 'anthropic', model: '' })
    expect(readFileSync(file(), 'utf8')).not.toContain(KEY_SHAPED)
    // the create field keeps working through the same path
    write({ images: { provider: 'xai', model: KEY_SHAPED, vision: { provider: '', model: '' } } })
    expect(open().get().images.model).toBe('')
    expect(readFileSync(file(), 'utf8')).not.toContain(KEY_SHAPED)
  })

  it('AC-1.4 (038) a key in the see model never stays on disk: empty or unknown provider, or the legacy Casa field, with or without a keychain', () => {
    for (const keychain of [true, false]) {
      electron.keychain = keychain
      for (const stored of [
        { images: { provider: 'xai', model: '', vision: { provider: '', model: KEY_SHAPED } } },
        { images: { provider: 'xai', model: '', vision: { provider: 'nope', model: KEY_SHAPED } } },
        legacy('xai', KEY_SHAPED),
        legacy('', KEY_SHAPED),
        legacy('xai', KEY_SHAPED, { visionMigrated: true })
      ]) {
        write(stored)
        open()
        expect(readFileSync(file(), 'utf8'), `${keychain} ${JSON.stringify(stored)}`).not.toContain(KEY_SHAPED)
      }
    }
  })
})

describe('038 changing the see setting', () => {
  it('AC-1.8 (038) update() with an images patch that omits vision keeps it', () => {
    write({ images: { provider: 'meta', model: '', vision: { provider: 'anthropic', model: 'claude-x' } } })
    const store = open()
    const chosen = { provider: 'anthropic', model: 'claude-x' }
    expect(store.update({ images: { provider: 'xai', model: 'grok-imagine-image' } } as never).images).toEqual({ provider: 'xai', model: 'grok-imagine-image', vision: chosen })
    for (const bad of ['x', null, [], { provider: 'nope', model: '' }, { provider: 'xai', model: 3 }]) {
      expect(store.update({ images: { provider: 'xai', model: '', vision: bad } } as never).images.vision, JSON.stringify(bad)).toEqual(chosen)
    }
    expect(onDisk().images.vision).toEqual(chosen)
    // a whole, valid object replaces it; "Automatic" (empty) is a valid choice
    expect(store.update({ images: { provider: 'xai', model: '', vision: { provider: 'xai', model: 'grok-4' } } }).images.vision).toEqual({ provider: 'xai', model: 'grok-4' })
    expect(store.update({ images: { provider: 'xai', model: '', vision: { provider: '', model: '' } } }).images.vision).toEqual({ provider: '', model: '' })
    expect(onDisk().images.vision).toEqual({ provider: '', model: '' })
  })

  it('AC-3.4 (038) editing the old Casa keys through update() does not overwrite Imágenes and does not store them', () => {
    write(legacy('anthropic', 'claude-x'))
    const store = open()
    const home = { ...store.get().home, visionProvider: 'xai', visionModel: 'grok-4' } as Settings['home']
    const after = store.update({ home })
    expect(after.images.vision).toEqual({ provider: 'anthropic', model: 'claude-x' })
    expect(after.home).not.toHaveProperty('visionProvider')
    expect(after.home).not.toHaveProperty('visionModel')
    expect(after.home.enabled).toBe(true)
    expect(onDisk().home).not.toHaveProperty('visionProvider')
    expect(onDisk().home).not.toHaveProperty('visionModel')
  })

  it('AC-3.4 (038) the marker stops a second run: what the person chose stays across restarts', () => {
    write(legacy('anthropic', 'claude-x'))
    const store = open()
    store.update({ images: { ...store.get().images, vision: { provider: '', model: '' } } })
    // a stale file (an older version wrote the legacy keys back) must neither re-copy nor keep them
    const saved = onDisk()
    write({ ...saved, home: { ...saved.home, visionProvider: 'xai', visionModel: 'grok-4' } })
    const again = open().get()
    expect(again.images.vision).toEqual({ provider: '', model: '' })
    expect(again.home).not.toHaveProperty('visionProvider')
    expect(onDisk().home).not.toHaveProperty('visionProvider')
    // and with the marker unset but the Images tab already holding a choice, the old House value does not win
    write({ ...legacy('xai', 'grok-4'), images: { provider: 'meta', model: '', vision: { provider: 'anthropic', model: 'claude-y' } } })
    expect(open().get().images.vision).toEqual({ provider: 'anthropic', model: 'claude-y' })
  })
})
