import { describe, expect, it } from 'vitest'
import { compactHistory } from '../src/coordinator/context'
import { truncateMiddle } from '../src/coordinator/tools/types'
import type { Block, ChatMessage } from '../src/shared/types'

const user = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }], ts: 0 })
const call = (id: string): ChatMessage => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'read_file', input: {} }], ts: 0 })
const result = (id: string, content: string): ChatMessage => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }], ts: 0 })
const picture = (): ChatMessage => ({ role: 'user', content: [{ type: 'text', text: 'mirá' }, { type: 'image', mediaType: 'image/png', data: 'A'.repeat(50_000) }], ts: 0 })
const results = (m: ChatMessage): Extract<Block, { type: 'tool_result' }>[] => m.content.filter((b) => b.type === 'tool_result') as never

describe('compactHistory (spec 024)', () => {
  const big = `${'a'.repeat(3000)}${'z'.repeat(3000)}`

  it('AC-7.1 shortens old results and pictures, keeps the current turn whole', () => {
    const messages = [user('uno'), call('1'), result('1', big), picture(), user('dos'), call('2'), result('2', big)]
    const out = compactHistory(messages)
    const old = results(out[2])[0].content
    expect(old.length).toBeLessThan(2000)
    expect(old.startsWith('aaa')).toBe(true)
    expect(old.endsWith('zzz')).toBe(true)
    expect(old).toContain('trimmed')
    expect(out[3].content.some((b) => b.type === 'image')).toBe(false)
    expect(out[3].content.find((b) => b.type === 'text')).toEqual({ type: 'text', text: 'mirá' })
    expect(results(out[6])[0].content).toBe(big)
  })

  it('AC-7.1 also keeps a picture sent in the current turn', () => {
    const out = compactHistory([user('uno'), picture()])
    expect(out[1].content.some((b) => b.type === 'image')).toBe(true)
  })

  it('AC-7.1 inside a long run, results far behind the latest messages are trimmed more gently', () => {
    const huge = 'q'.repeat(10_000)
    const run: ChatMessage[] = [user('hacé todo')]
    for (let i = 0; i < 8; i++) run.push(call(`c${i}`), result(`c${i}`, huge))
    const out = compactHistory(run)
    expect(results(out[2])[0].content.length).toBeLessThan(3500)
    expect(results(out[2])[0].content).toContain('trimmed')
    expect(results(out.at(-1)!)[0].content).toBe(huge)
  })

  it('AC-7.2 returns the same messages when nothing is long, and never edits the stored ones', () => {
    const small = [user('uno'), call('1'), result('1', 'corto'), user('dos')]
    expect(compactHistory(small)).toBe(small)
    const long = [user('uno'), call('1'), result('1', big), user('dos')]
    const before = JSON.stringify(long)
    expect(compactHistory(long)).not.toBe(long)
    expect(JSON.stringify(long)).toBe(before)
  })

  it('AC-7.3 caps a tool result at 24 000 characters', () => {
    const out = truncateMiddle('x'.repeat(100_000))
    expect(out.length).toBeLessThan(24_500)
  })
})
