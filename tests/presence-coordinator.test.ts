import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuditEvent } from '../src/shared/audit'

const audits: AuditEvent[] = []
vi.mock('../src/shared/audit', async (original) => ({ ...(await original<typeof import('../src/shared/audit')>()), audit: (event: AuditEvent) => void audits.push(event) }))

import { type PresenceConsumer, type PresenceDeps, PresenceService } from '../src/coordinator/presence'
import { exportPersonalData } from '../src/coordinator/privacy'

const HOUR = 3_600_000

interface FakeConsumer extends PresenceConsumer {
  on: boolean
  usable: boolean
  calls: unknown[][]
}

const consumer = (on = true, usable = true): FakeConsumer => {
  const fake: FakeConsumer = {
    on,
    usable,
    calls: [],
    enabled: () => fake.on,
    canUse: () => fake.usable,
    wake: (...args: unknown[]) => void fake.calls.push(args)
  }
  return fake
}

let dir: string
let clock: Date
let logs: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alma-presence-'))
  clock = new Date(2026, 5, 10, 7, 30)
  logs = []
  audits.length = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const service = (consumers: PresenceConsumer[], patch: Partial<PresenceDeps> = {}): PresenceService =>
  new PresenceService({
    file: join(dir, 'presence.json'),
    now: () => clock,
    thresholdMs: 4 * HOUR,
    consumers: () => consumers,
    log: (line) => void logs.push(line),
    ...patch
  })

describe('presence: the coordinator service (spec 034)', () => {
  it('AC-1.3 (034) a malformed presence message is ignored and logged without its payload', () => {
    const fake = consumer()
    const presence = service([fake])
    const MARKER = 'secret-marker-7731'
    const malformed: unknown[] = [
      { kind: MARKER, absenceMs: 5 * HOUR },
      { kind: 'unlock', absenceMs: -1 },
      { kind: 'unlock', absenceMs: Number.NaN },
      { kind: 'unlock', absenceMs: Number.POSITIVE_INFINITY },
      { kind: 'unlock', absenceMs: MARKER },
      { kind: 'unlock', absenceMs: 5 * HOUR, note: MARKER },
      { absenceMs: 5 * HOUR },
      null,
      MARKER
    ]
    for (const raw of malformed) expect(() => presence.receive(raw)).not.toThrow()
    expect(fake.calls).toEqual([])
    expect(logs).toHaveLength(malformed.length)
    expect(logs.join('\n')).not.toContain(MARKER)
    expect(logs.join('\n')).not.toContain('18000000')
  })

  it('AC-2.1 (034) the signal is offered once to the consumers that are on', () => {
    const first = consumer()
    const second = consumer()
    const off = consumer(false)
    const presence = service([first, off, second])
    presence.receive({ kind: 'resume', absenceMs: 8 * HOUR })
    presence.receive({ kind: 'unlock', absenceMs: 8 * HOUR })
    presence.receive({ kind: 'idle-return', absenceMs: 5 * HOUR })
    expect(first.calls).toHaveLength(1)
    expect(second.calls).toHaveLength(1)
    expect(off.calls).toEqual([])
  })

  it('AC-3.2 (034) a consumer gets no detail and nothing reaches the audit trail', () => {
    const fake = consumer()
    const presence = service([fake])
    presence.receive({ kind: 'active' })
    presence.receive({ kind: 'unlock', absenceMs: 9 * HOUR })
    presence.receive({ kind: 'unlock', absenceMs: 'bad' })
    expect(fake.calls).toEqual([[]])
    expect(audits).toEqual([])
  })
})

describe('presence: the state file (spec 034)', () => {
  const file = (): string => join(dir, 'presence.json')

  it('AC-2.5 (034) the last signal date survives a restart', () => {
    const fake = consumer()
    service([fake]).receive({ kind: 'unlock', absenceMs: 6 * HOUR })
    expect(fake.calls).toHaveLength(1)
    clock = new Date(2026, 5, 10, 18, 0)
    const again = consumer()
    service([again]).receive({ kind: 'resume', absenceMs: 6 * HOUR })
    expect(again.calls).toEqual([])
  })

  it('AC-2.7 (034) a start uses the persisted last activity', () => {
    const fake = consumer()
    const before = service([fake])
    before.receive({ kind: 'active' })
    clock = new Date(clock.getTime() + 4 * HOUR)
    service([fake]).receive({ kind: 'start' })
    expect(fake.calls).toHaveLength(1)

    // A quick reboot: the start itself was the last activity.
    clock = new Date(2026, 5, 11, 9, 0)
    const reboot = consumer()
    service([reboot]).receive({ kind: 'active' })
    clock = new Date(clock.getTime() + 10 * 60_000)
    service([reboot]).receive({ kind: 'start' })
    expect(reboot.calls).toEqual([])
  })

  it('AC-2.7 (034) a start with nothing persisted is not a signal', () => {
    const fake = consumer()
    service([fake]).receive({ kind: 'start' })
    expect(fake.calls).toEqual([])
  })

  it('AC-3.1 (034) only the two fields are written', () => {
    const presence = service([consumer()])
    presence.receive({ kind: 'active' })
    presence.receive({ kind: 'resume', absenceMs: 7 * HOUR })
    presence.receive({ kind: 'unlock', absenceMs: 7 * HOUR })
    presence.receive({ kind: 'idle-return', absenceMs: 2 * 60_000 })
    presence.receive({ kind: 'active' })
    const saved = JSON.parse(readFileSync(file(), 'utf8'))
    expect(Object.keys(saved).sort()).toEqual(['lastActivityAt', 'lastWakeDay'])
    expect(saved).toEqual({ lastWakeDay: '2026-06-10', lastActivityAt: clock.getTime() })
  })

  it('AC-3.1 (034) a corrupt file reads as empty and is logged without its content', () => {
    for (const content of ['{not json', JSON.stringify({ lastWakeDay: '2026-06-10', history: ['secret-marker-7731'] }), 'null']) {
      writeFileSync(file(), content)
      logs = []
      const fake = consumer()
      service([fake]).receive({ kind: 'unlock', absenceMs: 6 * HOUR })
      expect(fake.calls, content).toHaveLength(1)
      expect(logs.join('\n')).not.toContain('secret-marker-7731')
    }
  })

  it('AC-2.13 (034) the service asks canUse before using up the day', () => {
    const fake = consumer(true, false)
    clock = new Date(2026, 5, 10, 2, 10)
    service([fake]).receive({ kind: 'resume', absenceMs: 5 * HOUR })
    expect(fake.calls).toEqual([])
    fake.usable = true
    clock = new Date(2026, 5, 10, 7, 0)
    service([fake]).receive({ kind: 'idle-return', absenceMs: 4 * HOUR })
    expect(fake.calls).toEqual([[]])
  })
})

describe('presence: no consumer on (spec 034)', () => {
  const file = (): string => join(dir, 'presence.json')

  it('AC-2.11 (034) with no consumer on nothing is persisted or offered', () => {
    const off = consumer(false)
    for (const presence of [service([]), service([off])]) {
      presence.receive({ kind: 'active' })
      presence.receive({ kind: 'unlock', absenceMs: 9 * HOUR })
      presence.receive({ kind: 'start' })
    }
    expect(off.calls).toEqual([])
    expect(existsSync(file())).toBe(false)
  })

  it('AC-2.11 (034) the state is deleted when the last consumer turns off', () => {
    const fake = consumer()
    const presence = service([fake])
    presence.receive({ kind: 'active' })
    presence.consumersChanged()
    expect(existsSync(file())).toBe(true)
    fake.on = false
    presence.consumersChanged()
    expect(existsSync(file())).toBe(false)
    // Turned on again later: nothing is known about the last activity, so a start is no signal (BR-11).
    fake.on = true
    clock = new Date(clock.getTime() + 6 * HOUR)
    presence.receive({ kind: 'start' })
    expect(fake.calls).toEqual([])
  })
})

describe('presence: export and erase (spec 034)', () => {
  it('AC-3.3 (034) export leaves the presence state out and erase clears it', () => {
    const fake = consumer()
    const presence = service([fake])
    presence.receive({ kind: 'active' })
    expect(existsSync(join(dir, 'presence.json'))).toBe(true)

    const target = mkdtempSync(join(tmpdir(), 'alma-presence-export-'))
    try {
      const folder = exportPersonalData(dir, target)
      expect(existsSync(join(folder, 'presence.json'))).toBe(false)
    } finally {
      rmSync(target, { recursive: true, force: true })
    }

    presence.clear()
    expect(existsSync(join(dir, 'presence.json'))).toBe(false)
    // The next start has no last activity, in this service and in a new one.
    clock = new Date(clock.getTime() + 6 * HOUR)
    presence.receive({ kind: 'start' })
    expect(fake.calls).toEqual([])
    presence.clear()
    service([fake]).receive({ kind: 'start' })
    expect(fake.calls).toEqual([])
  })
})

describe('presence: robustness (spec 034)', () => {
  it('AC-1.3 (034) a consumer that throws does not stop the others, and the state is still saved', () => {
    const broken: PresenceConsumer = { enabled: () => true, canUse: () => true, wake: () => { throw new Error('boom') } }
    const fake = consumer()
    const presence = service([broken, fake])
    presence.receive({ kind: 'unlock', absenceMs: 5 * HOUR })
    expect(fake.calls).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(dir, 'presence.json'), 'utf8')).lastWakeDay).toBe('2026-06-10')
    expect(logs.some((line) => line.startsWith('[presence] a consumer failed'))).toBe(true)
    // One that throws when asked whether it is on or can use the signal counts as no.
    const asking: PresenceConsumer = { enabled: () => { throw new Error('boom') }, canUse: () => true, wake: () => {} }
    expect(() => service([asking, fake]).receive({ kind: 'active' })).not.toThrow()
  })

  it('AC-1.3 (034) receive answers the kind it accepted, null for a malformed message', () => {
    const presence = service([consumer()])
    expect(presence.receive({ kind: 'resume', absenceMs: 10 })).toBe('resume')
    expect(service([]).receive({ kind: 'resume', absenceMs: 10 })).toBe('resume')
    expect(presence.receive({ kind: 'nope' })).toBeNull()
  })

  it('AC-3.3 (034) erasing removes a leftover temp file and completes even when a removal fails', () => {
    const file = join(dir, 'presence.json')
    mkdirSync(file)
    writeFileSync(`${file}.tmp`, '{}')
    expect(() => service([consumer()]).clear()).not.toThrow()
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(logs.some((line) => line.startsWith('[presence] could not erase'))).toBe(true)
  })
})
