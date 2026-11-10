import { describe, expect, it } from 'vitest'
import { type Chip, type ChipEvent, canSendNow, chipsReduce } from '../src/shared/attach/phone-chips'

const run = (events: ChipEvent[], start: Chip[] = []) => {
  let chips = start
  const effects: unknown[] = []
  for (const event of events) {
    const step = chipsReduce(chips, event)
    chips = step.chips
    effects.push(...step.effects)
  }
  return { chips, effects }
}
const chip = (key: string, state: Chip['state'], over: Partial<Chip> = {}): Chip => ({ key, name: `${key}.pdf`, state, ...over })

describe('chip transitions', () => {
  it('AC-8.3 (031) chip transitions and effects: added, preparing, uploading, ready with the id', () => {
    const added = run([{ type: 'added', key: 'k1', name: 'a.pdf' }])
    expect(added.chips).toEqual([{ key: 'k1', name: 'a.pdf', state: 'preparing' }])
    const prepared = run([{ type: 'prepared', key: 'k1' }], added.chips)
    expect(prepared.chips).toEqual([{ key: 'k1', name: 'a.pdf', state: 'uploading' }])
    const done = run([{ type: 'uploaded', key: 'k1', id: 'att-1' }], prepared.chips)
    expect(done.chips).toEqual([{ key: 'k1', name: 'a.pdf', state: 'ready', id: 'att-1' }])
    expect([...added.effects, ...prepared.effects, ...done.effects]).toEqual([])
  })

  it('AC-8.3 (031) failed keeps the chip with its reason, and the order of chips is kept', () => {
    const start = [chip('a', 'ready', { id: 'x' }), chip('b', 'uploading'), chip('c', 'preparing')]
    const { chips, effects } = run([{ type: 'failed', key: 'b', reason: 'too-large' }], start)
    expect(chips.map((c) => [c.key, c.state, c.reason])).toEqual([
      ['a', 'ready', undefined],
      ['b', 'failed', 'too-large'],
      ['c', 'preparing', undefined],
    ])
    expect(effects).toEqual([])
  })

  it('AC-8.3 (031) a failure before upload (preparing) is kept too, with the phone-side reason', () => {
    const { chips } = run([{ type: 'failed', key: 'c', reason: 'too-large' }], [chip('c', 'preparing')])
    expect(chips).toEqual([{ key: 'c', name: 'c.pdf', state: 'failed', reason: 'too-large' }])
  })

  it('AC-8.3 (031) removing a ready chip asks the PC to remove the pending upload', () => {
    const { chips, effects } = run([{ type: 'remove', key: 'a' }], [chip('a', 'ready', { id: 'att-9' }), chip('b', 'ready', { id: 'att-8' })])
    expect(chips.map((c) => c.key)).toEqual(['b'])
    expect(effects).toEqual([{ type: 'remove-remote', id: 'att-9' }])
  })

  it('AC-8.3 (031) removing an uploading chip aborts the request', () => {
    const { chips, effects } = run([{ type: 'remove', key: 'a' }], [chip('a', 'uploading')])
    expect(chips).toEqual([])
    expect(effects).toEqual([{ type: 'abort', key: 'a' }])
  })

  it('AC-8.3 (031) removing a preparing or failed chip, or an unknown one, emits nothing', () => {
    expect(run([{ type: 'remove', key: 'a' }], [chip('a', 'preparing')])).toEqual({ chips: [], effects: [] })
    expect(run([{ type: 'remove', key: 'a' }], [chip('a', 'failed', { reason: 'network' })])).toEqual({ chips: [], effects: [] })
    const start = [chip('a', 'ready', { id: 'x' })]
    expect(run([{ type: 'remove', key: 'zzz' }], start)).toEqual({ chips: start, effects: [] })
  })

  it('AC-8.3 (031) an event for a chip that is gone or in another state changes nothing', () => {
    const start = [chip('a', 'ready', { id: 'x' }), chip('b', 'failed', { reason: 'file-type' })]
    const events: ChipEvent[] = [
      { type: 'prepared', key: 'a' },
      { type: 'prepared', key: 'zzz' },
      { type: 'uploaded', key: 'a', id: 'y' },
      { type: 'uploaded', key: 'zzz', id: 'y' },
      { type: 'failed', key: 'a', reason: 'network' },
      { type: 'failed', key: 'b', reason: 'network' },
    ]
    for (const event of events) expect(run([event], start)).toEqual({ chips: start, effects: [] })
  })

  it('AC-8.3 (031) the same key is not added twice and the input is not mutated', () => {
    const start = [chip('a', 'preparing')]
    const snapshot = JSON.stringify(start)
    expect(run([{ type: 'added', key: 'a', name: 'other.pdf' }], start).chips).toEqual(start)
    run([{ type: 'prepared', key: 'a' }], start)
    expect(JSON.stringify(start)).toBe(snapshot)
  })

  it('AC-8.6 (031) a dropped connection arrives as a failed event with the reason network: only that chip fails and the rest are kept', () => {
    const start = [chip('a', 'ready', { id: 'x' }), chip('b', 'uploading'), chip('c', 'preparing'), chip('d', 'failed', { reason: 'file-type' })]
    const { chips, effects } = run([{ type: 'failed', key: 'b', reason: 'network' }], start)
    expect(chips).toEqual([
      chip('a', 'ready', { id: 'x' }),
      chip('b', 'failed', { reason: 'network' }),
      chip('c', 'preparing'),
      chip('d', 'failed', { reason: 'file-type' }),
    ])
    expect(effects).toEqual([])
  })

  it('AC-8.7 (031) an expired id marks the chip expired and it can be attached again', () => {
    const start = [chip('a', 'ready', { id: 'x' }), chip('b', 'ready', { id: 'y' })]
    const { chips, effects } = run([{ type: 'expired', id: 'x' }], start)
    expect(chips).toEqual([chip('a', 'failed', { reason: 'unavailable' }), chip('b', 'ready', { id: 'y' })])
    expect(chips[0].id).toBeUndefined()
    expect(effects).toEqual([])
    // the PC already forgot it: removing the chip asks nothing, and the same file can be attached again
    const again = run(
      [
        { type: 'remove', key: 'a' },
        { type: 'added', key: 'a2', name: 'a.pdf' },
      ],
      chips,
    )
    expect(again.effects).toEqual([])
    expect(again.chips.map((c) => [c.key, c.state])).toEqual([
      ['b', 'ready'],
      ['a2', 'preparing'],
    ])
  })

  it('AC-8.7 (031) an expired id nobody holds changes nothing', () => {
    const start = [chip('a', 'ready', { id: 'x' })]
    expect(run([{ type: 'expired', id: 'nope' }], start)).toEqual({ chips: start, effects: [] })
  })
})

describe('canSendNow', () => {
  it('AC-8.3 (031) canSendNow is false while any chip is preparing or uploading', () => {
    expect(canSendNow([chip('a', 'preparing')], 'hola', false)).toBe(false)
    expect(canSendNow([chip('a', 'uploading')], 'hola', false)).toBe(false)
    expect(canSendNow([chip('a', 'ready', { id: 'x' }), chip('b', 'uploading')], 'hola', false)).toBe(false)
  })

  it('AC-8.3 (031) canSendNow needs text or a ready chip, and no run', () => {
    expect(canSendNow([], '', false)).toBe(false)
    expect(canSendNow([], '   ', false)).toBe(false)
    expect(canSendNow([], 'hola', false)).toBe(true)
    expect(canSendNow([chip('a', 'ready', { id: 'x' })], '', false)).toBe(true)
    expect(canSendNow([chip('a', 'failed', { reason: 'network' })], '', false)).toBe(false)
    expect(canSendNow([chip('a', 'failed', { reason: 'network' })], 'hola', false)).toBe(true)
    expect(canSendNow([chip('a', 'ready', { id: 'x' })], 'hola', true)).toBe(false)
    expect(canSendNow([], 'hola', true)).toBe(false)
  })
})
