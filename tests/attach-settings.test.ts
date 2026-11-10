import { describe, expect, it } from 'vitest'
import { sanitizeAttachmentSettings } from '../src/shared/attach/settings'
import { defaultSettings } from '../src/shared/defaults'

describe('attachment settings (spec 030 T18)', () => {
  it('AC-3.1 (030) old settings load with no acknowledged providers', () => {
    expect(defaultSettings().attachments).toEqual({ noticeAcknowledged: [] })
    expect(sanitizeAttachmentSettings(undefined)).toEqual({ noticeAcknowledged: [] })
    expect(sanitizeAttachmentSettings(null)).toEqual({ noticeAcknowledged: [] })
    expect(sanitizeAttachmentSettings({})).toEqual({ noticeAcknowledged: [] })
  })

  it('AC-3.1 (030) unknown provider ids in the acknowledged list are dropped', () => {
    expect(sanitizeAttachmentSettings({ noticeAcknowledged: ['xai', 'nope', 7, 'meta', 'xai'] })).toEqual({ noticeAcknowledged: ['xai', 'meta'] })
    expect(sanitizeAttachmentSettings({ noticeAcknowledged: ['anthropic', 'deepseek', 'vercel'] }).noticeAcknowledged).toEqual(['anthropic', 'deepseek', 'vercel'])
  })

  it('AC-3.1 (030) a non-array resets to empty', () => {
    for (const bad of ['xai', 42, { 0: 'xai' }, null, true]) {
      expect(sanitizeAttachmentSettings({ noticeAcknowledged: bad })).toEqual({ noticeAcknowledged: [] })
    }
    for (const bad of [[], 'attachments', 5, true]) expect(sanitizeAttachmentSettings(bad)).toEqual({ noticeAcknowledged: [] })
  })
})
