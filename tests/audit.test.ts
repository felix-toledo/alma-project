import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { audit, initAudit, redact, verifyAudit } from '../src/shared/audit'

const dirs: string[] = []
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'alma-audit-'))
  dirs.push(dir)
  return dir
}
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const trail = (dir: string): string => join(dir, 'audit', readdirSync(join(dir, 'audit')).find((n) => n.startsWith('coordinator-'))!)

describe('audit trail', () => {
  it('chains entries, survives a restart and detects tampering', () => {
    const dir = fresh()
    initAudit(dir, 'coordinator')
    for (const target of ['a', 'b', 'c']) audit({ action: 'tool.authorize', actor: 'agent', target, outcome: 'ok' })
    initAudit(dir, 'coordinator') // restart: the chain must continue, not restart
    audit({ action: 'tool.authorize', actor: 'agent', target: 'd', outcome: 'denied' })
    expect(verifyAudit(dir)).toEqual({ ok: true, entries: 4 })

    const file = trail(dir)
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
    writeFileSync(file, [lines[0], lines[1].replace('"b"', '"x"'), ...lines.slice(2)].join('\n') + '\n')
    expect(verifyAudit(dir).brokenAt?.line).toBe(3)

    writeFileSync(file, [lines[0], ...lines.slice(2)].join('\n') + '\n')
    expect(verifyAudit(dir).ok).toBe(false)
  })

  it('never writes secrets and can throttle spammable events', () => {
    const dir = fresh()
    initAudit(dir, 'coordinator')
    audit({ action: 'tool.authorize', actor: 'agent', outcome: 'ok', detail: { command: 'curl -H "Authorization: Bearer abcdef123456" x; export API_KEY=hunter2', key: 'sk-abcdefghijklmnopqrstuv' } })
    const text = readFileSync(trail(dir), 'utf8')
    expect(text).not.toMatch(/abcdef123456|hunter2|abcdefghijklmnopqrstuv/)

    const now = new Date()
    for (let i = 0; i < 5; i++) audit({ action: 'channel.denied', actor: 'remote', target: 'telegram', outcome: 'denied', throttle: true }, now)
    expect(readFileSync(trail(dir), 'utf8').split('\n').filter((l) => l.includes('channel.denied'))).toHaveLength(1)
    expect(redact('LLM|abcdefghijklmnop1234')).toBe('[clave]')
  })

  it('removes trails older than the retention window', () => {
    const dir = fresh()
    initAudit(dir, 'main', new Date('2024-01-15'))
    audit({ action: 'old', actor: 'system', outcome: 'ok' }, new Date('2024-01-15'))
    initAudit(dir, 'main', new Date('2026-03-15'))
    expect(readdirSync(join(dir, 'audit'))).toEqual([])
  })
})
