import { describe, expect, it, vi } from 'vitest'
import { PhoneFiles } from '../src/coordinator/attachments/phone'
import { acknowledgeNotice, threadReaders } from '../src/shared/attach/readers'
import { defaultSettings } from '../src/shared/defaults'
import type { ProviderId, Settings, Thread, VisionChoice } from '../src/shared/types'
import { makePng } from './support/verify-030'

// Independent verification of spec 038 AC-4.3 (the phone puts a picture): notice-needed before anything is stored. Written from spec.md only.

const thread = { id: 't1', title: 't', agentId: 'general', workspace: '', createdAt: 1, updatedAt: 1 } as unknown as Thread
const png = Buffer.from(makePng()).toString('base64')

function rig(vision: VisionChoice, acked: ProviderId[], env: Record<string, string> = {}) {
  const store = vi.fn(() => ({ ok: true as const, attachment: { id: 'a', name: 'p.png', kind: 'image', size: 1 } }))
  let settings: Settings = defaultSettings('en')
  settings = { ...settings, images: { ...settings.images, vision }, attachments: { noticeAcknowledged: acked } }
  const files = new PhoneFiles({
    store: { store, remove: vi.fn(), lookup: vi.fn() } as never,
    threads: { get: () => thread },
    settings: () => settings,
    env: () => env
  })
  return { files, store, set: (next: Settings) => (settings = next), current: () => settings }
}
const put = (files: PhoneFiles) => files.put({ threadId: 't1', name: 'p.png', size: 1, base64: png })

describe('AC-4.3 (038 verify) a picture is refused with notice-needed before anything is stored, until the provider the looks would use is acknowledged', () => {
  it('AC-4.3 (038 verify) a typed see model on an unacknowledged provider: refused; acknowledged: stored', () => {
    const { files, store, set, current } = rig({ provider: 'xai', model: 'grok-4' }, ['meta'])
    expect(put(files)).toEqual({ ok: false, reason: 'notice-needed' })
    expect(store).not.toHaveBeenCalled()
    set({ ...current(), attachments: acknowledgeNotice(current().attachments, ['xai']) })
    expect(put(files).ok).toBe(true)
    expect(store).toHaveBeenCalledTimes(1)
  })

  it('AC-4.3 (038 verify) changing the see provider to a new one flips the very next put from stored to refused', () => {
    const { files, store, set, current } = rig({ provider: '', model: '' }, ['meta'])
    expect(put(files).ok).toBe(true)
    set({ ...current(), images: { ...current().images, vision: { provider: 'anthropic', model: 'claude-sonnet-4-5' } } })
    expect(put(files)).toEqual({ ok: false, reason: 'notice-needed' })
    expect(store).toHaveBeenCalledTimes(1)
  })

  it('AC-4.3 (038 verify) a held provider-only value names the fallback provider, not the held one: acknowledging the fallback is enough, and the held one stays unnamed', () => {
    const { files, current } = rig({ provider: 'deepseek', model: '' }, ['meta'], { META_API_KEY: 'k' })
    expect(threadReaders(current(), thread, true, { META_API_KEY: 'k' })).not.toContain('deepseek')
    expect(put(files).ok).toBe(true)
  })

  it('AC-4.3 (038 verify) text files never need the vision provider acknowledged', () => {
    const { files, store } = rig({ provider: 'anthropic', model: 'claude-x' }, ['meta'])
    const text = Buffer.from('hola').toString('base64')
    expect(files.put({ threadId: 't1', name: 'a.txt', size: 4, base64: text }).ok).toBe(true)
    expect(store).toHaveBeenCalledTimes(1)
  })
})
