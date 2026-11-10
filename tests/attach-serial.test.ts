import { describe, expect, it } from 'vitest'
import { createSerial } from '../src/shared/attach/serial'

const gate = () => {
  let open!: () => void
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { promise, open }
}

describe('intake ordering (spec 030 AC-1.4)', () => {
  it('AC-1.4 (030) a second intake starts only when the first has finished, and sees what it left', async () => {
    const serial = createSerial()
    const chips: string[] = []
    const events: string[] = []
    const first = gate()
    const one = serial(async () => {
      events.push(`one starts with ${chips.length}`)
      await first.promise
      chips.push('a')
      events.push('one ends')
    })
    const two = serial(async () => {
      events.push(`two starts with ${chips.length}`)
      chips.push('b')
    })
    await Promise.resolve()
    expect(events).toEqual(['one starts with 0'])
    first.open()
    await Promise.all([one, two])
    expect(events).toEqual(['one starts with 0', 'one ends', 'two starts with 1'])
    expect(chips).toEqual(['a', 'b'])
  })

  it('AC-1.4 (030) a failing intake does not block the ones behind it, and still reports its own error', async () => {
    const serial = createSerial()
    const failed = serial(async () => {
      throw new Error('boom')
    })
    const after = serial(async () => 'ran')
    await expect(failed).rejects.toThrow('boom')
    expect(await after).toBe('ran')
  })

  it('AC-1.4 (030) the result of each task is its own', async () => {
    const serial = createSerial()
    expect(await Promise.all([serial(async () => 1), serial(async () => 2), serial(async () => 3)])).toEqual([1, 2, 3])
  })
})
