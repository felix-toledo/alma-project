import { describe, expect, it } from 'vitest'
import { canHoldAnother, claimUploads, PHONE_ATTACH, type PendingUpload, pendingExpired, phoneAttachmentViews, planPhoneFile, reencodedPictureName, SHRINK_STEPS, shrinkToFit } from '../src/shared/attach/phone'
import { acknowledgeNotice, pickVisionModel, threadReaders } from '../src/shared/attach/readers'
import { ALLOWED_EXTENSIONS } from '../src/shared/attach/rules'
import { defaultSettings } from '../src/shared/defaults'
import type { AgentProfile, ProviderId, Settings } from '../src/shared/types'
import { REMOTE_LIMITS } from '../src/shared/remote/limits'

describe('phone limits', () => {
  it('AC-9.5 (031) REMOTE_LIMITS is unchanged and the phone limit is its own constant', () => {
    expect({ ...REMOTE_LIMITS }).toEqual({
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
      firstLoadMessages: 30,
    })
    expect({ ...PHONE_ATTACH }).toEqual({ maxFileBytes: 700_000, maxFiles: 5, maxPending: 5, pendingTtlMs: 900_000 })
  })

  it('AC-2.3 (031) a 700 000-byte file with the longest name fits the request cap with margin', () => {
    const base64Length = Math.ceil(PHONE_ATTACH.maxFileBytes / 3) * 4
    expect(base64Length).toBe(933_336)
    const body = JSON.stringify({ name: 'n'.repeat(512), size: PHONE_ATTACH.maxFileBytes, base64: 'A'.repeat(base64Length) })
    expect(REMOTE_LIMITS.requestBytes - body.length).toBeGreaterThanOrEqual(100_000)
  })
})

describe('the phone file plan', () => {
  const LIMIT = PHONE_ATTACH.maxFileBytes
  const refuse = (reason: 'too-big' | 'type' | 'too-many') => ({ action: 'refuse', reason })

  it('AC-8.1 (031) the phone file plan: pictures are sent or shrunk, everything else is sent or refused', () => {
    expect(planPhoneFile({ name: 'a.jpg', size: 1000 }, 0)).toEqual({ action: 'send' })
    expect(planPhoneFile({ name: 'a.jpg', size: LIMIT }, 0)).toEqual({ action: 'send' })
    expect(planPhoneFile({ name: 'a.jpg', size: LIMIT + 1 }, 0)).toEqual({ action: 'shrink' })
    expect(planPhoneFile({ name: 'a.PNG', size: LIMIT + 1 }, 0)).toEqual({ action: 'shrink' })
    expect(planPhoneFile({ name: 'a.webp', size: 5_000_000 }, 0)).toEqual({ action: 'shrink' })
    expect(planPhoneFile({ name: 'a.gif', size: LIMIT }, 0)).toEqual({ action: 'send' })
    expect(planPhoneFile({ name: 'a.gif', size: LIMIT + 1 }, 0)).toEqual(refuse('too-big'))
    expect(planPhoneFile({ name: 'a.pdf', size: LIMIT }, 0)).toEqual({ action: 'send' })
    expect(planPhoneFile({ name: 'a.pdf', size: LIMIT + 1 }, 0)).toEqual(refuse('too-big'))
    expect(planPhoneFile({ name: 'a.docx', size: LIMIT + 1 }, 0)).toEqual(refuse('too-big'))
    expect(planPhoneFile({ name: 'notes.txt', size: LIMIT + 1 }, 0)).toEqual(refuse('too-big'))
  })

  it('AC-8.1 (031) a type outside the 030 list is refused as type, whatever its size', () => {
    for (const name of ['a.svg', 'a.exe', 'README', 'report.pdf.exe', 'a.html', 'a.zip', '.env', 'a.pdf.']) {
      expect(planPhoneFile({ name, size: 10 }, 0), name).toEqual(refuse('type'))
    }
    expect(planPhoneFile({ name: 'a.svg', size: LIMIT + 1 }, 0)).toEqual(refuse('type'))
  })

  it('AC-8.1 (031) the type test is the 030 list and no other', () => {
    for (const ext of Object.keys(ALLOWED_EXTENSIONS)) {
      expect(planPhoneFile({ name: `file${ext}`, size: 10 }, 0), ext).not.toEqual(refuse('type'))
      expect(planPhoneFile({ name: `FILE${ext.toUpperCase()}`, size: 10 }, 0), ext).not.toEqual(refuse('type'))
    }
  })

  it('AC-8.1 (031) the sixth chip is refused as too-many', () => {
    expect(planPhoneFile({ name: 'a.pdf', size: 10 }, PHONE_ATTACH.maxFiles - 1)).toEqual({ action: 'send' })
    expect(planPhoneFile({ name: 'a.pdf', size: 10 }, PHONE_ATTACH.maxFiles)).toEqual(refuse('too-many'))
    expect(planPhoneFile({ name: 'a.jpg', size: LIMIT + 1 }, PHONE_ATTACH.maxFiles)).toEqual(refuse('too-many'))
  })
})

describe('the shrink loop', () => {
  type Step = { maxSide: number; quality: number }
  const LIMIT = PHONE_ATTACH.maxFileBytes
  // a fake encoder: the size it returns for the n-th step, and the steps it was asked for
  const encoder = (sizes: number[]) => {
    const asked: Step[] = []
    const encode = async (step: Step) => {
      asked.push(step)
      return { size: sizes[asked.length - 1] ?? Number.MAX_SAFE_INTEGER, step }
    }
    return { encode, asked }
  }

  it('AC-8.1 (031) the shrink steps go from the biggest picture to the smallest', () => {
    expect(SHRINK_STEPS.length).toBeGreaterThan(1)
    for (let i = 1; i < SHRINK_STEPS.length; i++) expect(SHRINK_STEPS[i].maxSide).toBeLessThan(SHRINK_STEPS[i - 1].maxSide)
    for (const step of SHRINK_STEPS) expect(step.quality).toBeGreaterThan(0)
    for (const step of SHRINK_STEPS) expect(step.quality).toBeLessThanOrEqual(1)
  })

  it('AC-8.1 (031) shrinkToFit returns the first encoding within the limit or null', async () => {
    const first = encoder([LIMIT + 1, LIMIT, 10])
    const result = await shrinkToFit(first.encode)
    expect(result?.size).toBe(LIMIT)
    expect(first.asked).toEqual(SHRINK_STEPS.slice(0, 2))

    const direct = encoder([1])
    expect((await shrinkToFit(direct.encode))?.size).toBe(1)
    expect(direct.asked).toEqual([SHRINK_STEPS[0]])

    const never = encoder([])
    expect(await shrinkToFit(never.encode)).toBeNull()
    expect(never.asked).toEqual([...SHRINK_STEPS])

    const barely = encoder(SHRINK_STEPS.map(() => LIMIT + 1))
    expect(await shrinkToFit(barely.encode)).toBeNull()
  })

  it('AC-8.1 (031) shrinkToFit honours another limit and never returns a result over it', async () => {
    const result = await shrinkToFit(encoder([500, 400, 300]).encode, 450)
    expect(result?.size).toBe(400)
  })

  it('AC-8.1 (031) an encoder that throws gives null, not an exception', async () => {
    const calls: Step[] = []
    const result = await shrinkToFit(async (step) => {
      calls.push(step)
      throw new Error('canvas failed')
    })
    expect(result).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('AC-8.1 (031) a re-encoded picture is named imagen-<timestamp>.jpg', () => {
    expect(reencodedPictureName(1_700_000_000_000)).toBe('imagen-1700000000000.jpg')
    expect(reencodedPictureName(1)).toBe('imagen-1.jpg')
  })
})

describe('pending uploads', () => {
  const T0 = 1_700_000_000_000
  const up = (id: string, over: Partial<PendingUpload> = {}): PendingUpload => ({ id, deviceId: 'd1', threadId: 't1', putAt: T0, ...over })
  const ask = (ids: readonly unknown[], over: Partial<{ deviceId: string; threadId: string }> = {}) => ({ deviceId: 'd1', threadId: 't1', ids, ...over })

  it('AC-2.9 (031) pending rules', () => {
    expect(canHoldAnother(0)).toBe(true)
    expect(canHoldAnother(4)).toBe(true)
    expect(canHoldAnother(5)).toBe(false)
    expect(canHoldAnother(6)).toBe(false)
    expect(pendingExpired(up('a'), T0 + 899_999)).toBe(false)
    expect(pendingExpired(up('a'), T0 + 900_000)).toBe(true)
    expect(pendingExpired(up('a'), T0 + 900_001)).toBe(true)
    expect(pendingExpired(up('a'), T0)).toBe(false)
  })

  it('AC-4.2 (031) claimUploads answers ok for this device, this conversation, unexpired, distinct ids, at most 5', () => {
    const held = ['a', 'b', 'c', 'd', 'e'].map((id) => up(id))
    expect(claimUploads(held, ask(['a']), T0 + 1000)).toEqual({ ok: true, ids: ['a'] })
    expect(claimUploads(held, ask(['e', 'a', 'c', 'b', 'd']), T0 + 1000)).toEqual({ ok: true, ids: ['e', 'a', 'c', 'b', 'd'] })
    expect(claimUploads(held, ask(['a']), T0 + 899_999)).toEqual({ ok: true, ids: ['a'] })
  })

  it('AC-4.2 (031) every other case is one identical refusal', () => {
    const held = [
      up('mine'),
      up('old', { putAt: T0 - 900_000 }),
      up('theirs', { deviceId: 'd2' }),
      up('elsewhere', { threadId: 't2' }),
      ...['x1', 'x2', 'x3', 'x4', 'x5', 'x6'].map((id) => up(id)),
    ]
    const refused = { ok: false }
    expect(claimUploads(held, ask(['unknown']), T0)).toEqual(refused)
    expect(claimUploads(held, ask(['old']), T0)).toEqual(refused)
    expect(claimUploads(held, ask(['theirs']), T0)).toEqual(refused)
    expect(claimUploads(held, ask(['elsewhere']), T0)).toEqual(refused)
    expect(claimUploads(held, ask(['mine'], { deviceId: 'd2' }), T0)).toEqual(refused)
    expect(claimUploads(held, ask(['mine'], { threadId: 't2' }), T0)).toEqual(refused)
    expect(claimUploads(held, ask(['mine', 'unknown']), T0)).toEqual(refused)
    expect(claimUploads(held, ask([1]), T0)).toEqual(refused)
    expect(claimUploads(held, ask([{ id: 'mine' }]), T0)).toEqual(refused)
    expect(claimUploads(held, ask(['']), T0)).toEqual(refused)
    expect(claimUploads(held, ask([null]), T0)).toEqual(refused)
    expect(claimUploads(held, ask(['mine', 'mine']), T0)).toEqual(refused)
    expect(claimUploads(held, ask([]), T0)).toEqual(refused)
    expect(claimUploads(held, ask(['x1', 'x2', 'x3', 'x4', 'x5', 'x6']), T0)).toEqual(refused)
    expect(claimUploads([up('a'.repeat(65))], ask(['a'.repeat(65)]), T0)).toEqual(refused)
    expect(claimUploads([], ask(['mine']), T0)).toEqual(refused)
  })

  it('AC-4.2 (031) claimUploads does not change what it was given', () => {
    const held = [up('a')]
    const snapshot = JSON.stringify(held)
    claimUploads(held, ask(['a']), T0)
    expect(JSON.stringify(held)).toBe(snapshot)
  })
})

describe('the phone projection', () => {
  const ID_MARKER = 'ID-MARKER-7f3a'
  const EXTRA_MARKER = 'EXTRA-MARKER-91bc'
  const attachment = (over: object = {}) => ({ id: ID_MARKER, name: 'receipt.pdf', kind: 'pdf' as const, size: 1234, ...over })

  it('AC-5.2 (031) the projection keeps name, kind and size and nothing else', () => {
    const input = [attachment({ removedAt: 5, path: EXTRA_MARKER }), attachment({ name: 'photo.jpg', kind: 'image', size: 99 })]
    const output = phoneAttachmentViews(input)
    expect(output).toEqual([
      { name: 'receipt.pdf', kind: 'pdf', size: 1234 },
      { name: 'photo.jpg', kind: 'image', size: 99 },
    ])
    for (const view of output) expect(Object.keys(view).sort()).toEqual(['kind', 'name', 'size'])
    expect(JSON.stringify(output)).not.toContain(ID_MARKER)
    expect(JSON.stringify(output)).not.toContain(EXTRA_MARKER)
  })

  it('AC-5.2 (031) nothing gives an empty list and the input is not mutated', () => {
    expect(phoneAttachmentViews(undefined)).toEqual([])
    expect(phoneAttachmentViews([])).toEqual([])
    const input = [attachment({ path: EXTRA_MARKER })]
    const snapshot = JSON.stringify(input)
    phoneAttachmentViews(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})

describe('who reads the attachments', () => {
  const profile = (id: string, provider: ProviderId, model: string): AgentProfile => ({ ...defaultSettings().agents[0], id, provider, model })
  // no key anywhere unless a test gives one
  const base = (): Settings => {
    const settings = defaultSettings()
    for (const id of ['anthropic', 'xai', 'deepseek', 'vercel', 'meta'] as const) settings.providers[id].apiKey = ''
    settings.agents = [profile('first', 'anthropic', 'a-model'), profile('house', 'xai', 'x-model'), profile('main', 'deepseek', 'd-model')]
    settings.defaultAgentId = 'main'
    settings.home = { ...settings.home, agentId: 'house' }
    return settings
  }
  const noEnv = {}

  it('AC-2.8 (031) pickVisionModel behaves as visionModel did: the chosen vision model wins', () => {
    const settings = base()
    settings.images.vision = { provider: 'vercel', model: 'v-model' }
    settings.providers.xai.apiKey = 'k'
    expect(pickVisionModel(settings, noEnv)).toEqual({ provider: 'vercel', model: 'v-model' })
  })

  it('AC-2.8 (031) pickVisionModel: else the house agent, the default agent, any agent with a key, in that order', () => {
    const settings = base()
    for (const id of ['xai', 'deepseek', 'anthropic'] as const) settings.providers[id].apiKey = 'k'
    expect(pickVisionModel(settings, noEnv)).toEqual({ provider: 'xai', model: 'x-model' })
    settings.providers.xai.apiKey = ''
    expect(pickVisionModel(settings, noEnv)).toEqual({ provider: 'deepseek', model: 'd-model' })
    settings.providers.deepseek.apiKey = ''
    expect(pickVisionModel(settings, noEnv)).toEqual({ provider: 'anthropic', model: 'a-model' })
    settings.providers.anthropic.apiKey = ''
    // nothing has a key: the first agent
    expect(pickVisionModel(settings, noEnv)).toEqual({ provider: 'anthropic', model: 'a-model' })
  })

  it('AC-2.8 (031) pickVisionModel reads a key from the environment passed in', () => {
    const settings = base()
    expect(pickVisionModel(settings, { DEEPSEEK_API_KEY: 'k' })).toEqual({ provider: 'deepseek', model: 'd-model' })
    expect(pickVisionModel(settings, { XAI_API_KEY: 'k', DEEPSEEK_API_KEY: 'k' })).toEqual({ provider: 'xai', model: 'x-model' })
    expect(pickVisionModel(settings, { XAI_API_KEY: '' })).toEqual({ provider: 'anthropic', model: 'a-model' })
  })

  it('AC-1.4 (031) threadReaders names the conversation provider and, for pictures, the vision provider', () => {
    const settings = base()
    settings.images.vision = { provider: 'vercel', model: 'v-model' }
    expect(threadReaders(settings, { agentId: 'house' }, false, noEnv)).toEqual(['xai'])
    expect(threadReaders(settings, { agentId: 'house' }, true, noEnv)).toEqual(['xai', 'vercel'])
  })

  it('AC-1.4 (031) threadReaders counts the same provider once', () => {
    const settings = base()
    settings.images.vision = { provider: 'xai', model: 'x-vision' }
    expect(threadReaders(settings, { agentId: 'house' }, true, noEnv)).toEqual(['xai'])
  })

  it('AC-1.4 (031) a thread model override wins over the agent, and the first agent answers for an unknown agent id', () => {
    const settings = base()
    settings.images.vision = { provider: 'vercel', model: 'v-model' }
    expect(threadReaders(settings, { agentId: 'house', model: { provider: 'meta', model: 'm' } }, false, noEnv)).toEqual(['meta'])
    expect(threadReaders(settings, { agentId: 'house', model: { provider: 'meta', model: 'm' } }, true, noEnv)).toEqual(['meta', 'vercel'])
    expect(threadReaders(settings, { agentId: 'gone' }, false, noEnv)).toEqual(['anthropic'])
  })

  it('AC-1.4 (031) threadReaders with no pictures never names the vision provider', () => {
    const settings = base()
    settings.images.vision = { provider: 'vercel', model: 'v-model' }
    expect(threadReaders(settings, { agentId: 'main' }, false, noEnv)).not.toContain('vercel')
  })
})

describe('acknowledging the notice', () => {
  it('AC-1.4 (031) acknowledgeNotice adds providers without duplicates and drops unknown ids', () => {
    expect(acknowledgeNotice({ noticeAcknowledged: [] }, ['xai', 'meta'])).toEqual({ noticeAcknowledged: ['xai', 'meta'] })
    expect(acknowledgeNotice({ noticeAcknowledged: ['xai'] }, ['meta', 'xai', 'meta'])).toEqual({ noticeAcknowledged: ['xai', 'meta'] })
    expect(acknowledgeNotice({ noticeAcknowledged: ['xai'] }, [])).toEqual({ noticeAcknowledged: ['xai'] })
    expect(acknowledgeNotice({ noticeAcknowledged: ['xai'] }, ['nope' as ProviderId])).toEqual({ noticeAcknowledged: ['xai'] })
    expect(acknowledgeNotice({ noticeAcknowledged: ['gone' as ProviderId, 'xai'] }, ['meta'])).toEqual({ noticeAcknowledged: ['xai', 'meta'] })
  })

  it('AC-1.4 (031) acknowledgeNotice does not change what it was given', () => {
    const current: Settings['attachments'] = { noticeAcknowledged: ['xai'] }
    acknowledgeNotice(current, ['meta'])
    expect(current).toEqual({ noticeAcknowledged: ['xai'] })
  })
})
