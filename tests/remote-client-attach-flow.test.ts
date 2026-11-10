import { describe, expect, it } from 'vitest'
import type { PutOutcome } from '../src/remote-client/lib/attach'
import { createAttachFlow } from '../src/remote-client/lib/attach-flow'

// The composer behind the chips (031 T52): the order and overlap of requests, what the X does in each state, what a send does to the chips.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const file = (name: string, bytes = [1, 2, 3]): File => new File([new Uint8Array(bytes)], name)
const stored = (id: string, name: string): PutOutcome => ({ ok: true, attachment: { id, name, kind: 'pdf', size: 3 } })

/** Every put waits until the test answers it, so the order and the overlap of requests can be seen. */
function rig(options: { shrink?: (f: File) => Promise<File | null> } = {}) {
  const puts: { payload: { name: string; size: number; base64: string }; signal: AbortSignal; answer(outcome: PutOutcome): void }[] = []
  const removed: string[] = []
  const flow = createAttachFlow({
    put: (payload, signal) => new Promise<PutOutcome>((answer) => puts.push({ payload, signal, answer })),
    remove: async (id) => {
      removed.push(id)
    },
    shrink: options.shrink ?? (async () => null)
  })
  return { flow, puts, removed }
}
const states = (flow: ReturnType<typeof rig>['flow']): string[] => flow.get().map((chip) => `${chip.name}:${chip.state}${chip.reason ? `:${chip.reason}` : ''}`)

describe('the composer flow behind the chips (AC-8.1, AC-8.3, AC-8.6, AC-8.7, AC-4.3, 031)', () => {
  it('AC-8.3 (031) files upload one at a time, in order, and each chip ends ready with the PC id', async () => {
    const { flow, puts } = rig()
    flow.add([file('a.pdf'), file('b.txt')])
    expect(states(flow)).toEqual(['a.pdf:preparing', 'b.txt:preparing'])
    await settle()
    expect(puts).toHaveLength(1)
    expect(puts[0].payload).toEqual({ name: 'a.pdf', size: 3, base64: 'AQID' })
    expect(states(flow)).toEqual(['a.pdf:uploading', 'b.txt:preparing'])
    puts[0].answer(stored('id-a', 'a.pdf'))
    await settle()
    expect(puts).toHaveLength(2)
    expect(puts[1].payload.name).toBe('b.txt')
    puts[1].answer(stored('id-b', 'b.txt'))
    await settle()
    expect(states(flow)).toEqual(['a.pdf:ready', 'b.txt:ready'])
    expect(flow.readyIds()).toEqual(['id-a', 'id-b'])
  })

  it('AC-8.1 (031) the phone refuses a type and a sixth chip without asking the PC', async () => {
    const { flow, puts } = rig()
    flow.add([file('virus.exe'), file('1.pdf'), file('2.pdf'), file('3.pdf'), file('4.pdf'), file('5.pdf'), file('6.pdf')])
    await settle()
    expect(states(flow)).toEqual([
      'virus.exe:failed:file-type',
      '1.pdf:uploading',
      '2.pdf:preparing',
      '3.pdf:preparing',
      '4.pdf:preparing',
      '5.pdf:preparing',
      '6.pdf:failed:too-many'
    ])
    expect(puts.map((p) => p.payload.name)).toEqual(['1.pdf'])
  })

  it('AC-8.1 (031) a picture the phone cannot decode is unreadable and can be tried again, not too-large', async () => {
    const broken = rig({ shrink: async () => Promise.reject(new Error('InvalidStateError')) })
    broken.flow.add([new File([new Uint8Array(700_001)], 'IMG_3.jpg')])
    await settle()
    expect(states(broken.flow)).toEqual(['IMG_3.jpg:failed:unreadable'])
    expect(broken.puts).toHaveLength(0)
  })

  it('AC-8.1 (031) a picture over the limit is shrunk and the shrunk bytes are what is sent; one that cannot fit is too-large', async () => {
    const shrunk = new File([new Uint8Array([9, 9])], 'imagen-5.jpg')
    const fits = rig({ shrink: async () => shrunk })
    fits.flow.add([new File([new Uint8Array(700_001)], 'IMG_1.jpg')])
    await settle()
    expect(fits.puts[0].payload).toEqual({ name: 'imagen-5.jpg', size: 2, base64: 'CQk=' })
    const never = rig({ shrink: async () => null })
    never.flow.add([new File([new Uint8Array(700_001)], 'IMG_2.jpg')])
    await settle()
    expect(states(never.flow)).toEqual(['IMG_2.jpg:failed:too-large'])
    expect(never.puts).toHaveLength(0)
  })

  it('AC-8.5 (031) a refusal of the PC marks the chip failed with its reason and the next file still goes', async () => {
    const { flow, puts } = rig()
    flow.add([file('.env.txt'), file('b.txt')])
    await settle()
    puts[0].answer({ ok: false, reason: 'secret-name' })
    await settle()
    puts[1].answer(stored('id-b', 'b.txt'))
    await settle()
    expect(states(flow)).toEqual(['.env.txt:failed:secret-name', 'b.txt:ready'])
  })

  it('AC-8.6 (031) a dropped connection marks the chip failed network, nothing is retried by itself, and retry sends the same file again', async () => {
    const { flow, puts } = rig()
    flow.add([file('a.pdf')])
    await settle()
    puts[0].answer({ ok: false, reason: 'network' })
    await settle()
    expect(states(flow)).toEqual(['a.pdf:failed:network'])
    expect(puts).toHaveLength(1)
    flow.retry(flow.get()[0].key)
    await settle()
    expect(states(flow)).toEqual(['a.pdf:uploading'])
    expect(puts).toHaveLength(2)
    expect(puts[1].payload.name).toBe('a.pdf')
  })

  it('AC-8.3 (031) the X on a ready chip asks the PC to delete it; on an uploading one it aborts and deletes what the PC stored anyway', async () => {
    const { flow, puts, removed } = rig()
    flow.add([file('a.pdf'), file('b.pdf')])
    await settle()
    puts[0].answer(stored('id-a', 'a.pdf'))
    await settle()
    flow.remove(flow.get()[0].key)
    expect(removed).toEqual(['id-a'])
    expect(states(flow)).toEqual(['b.pdf:uploading'])
    flow.remove(flow.get()[0].key)
    expect(puts[1].signal.aborted).toBe(true)
    expect(states(flow)).toEqual([])
    puts[1].answer(stored('id-b', 'b.pdf'))
    await settle()
    expect(removed).toEqual(['id-a', 'id-b'])
    expect(flow.readyIds()).toEqual([])
  })

  it('AC-4.3, AC-8.7 (031) an accepted send clears the chips, an unavailable one expires them, any other failure keeps them', async () => {
    const { flow, puts } = rig()
    flow.add([file('a.pdf')])
    await settle()
    puts[0].answer(stored('id-a', 'a.pdf'))
    await settle()
    flow.sent({ ok: false, reason: 'busy' })
    expect(states(flow)).toEqual(['a.pdf:ready'])
    flow.sent({ ok: false, reason: 'unavailable' })
    expect(states(flow)).toEqual(['a.pdf:failed:unavailable'])
    expect(flow.readyIds()).toEqual([])
    flow.add([file('b.pdf')])
    await settle()
    puts[1].answer(stored('id-b', 'b.pdf'))
    await settle()
    flow.sent({ ok: true })
    expect(states(flow)).toEqual([])
  })

  it('AC-7.4 (031) leaving the screen drops the chips, aborts the upload and deletes what is ready', async () => {
    const { flow, puts, removed } = rig()
    flow.add([file('a.pdf'), file('b.pdf')])
    await settle()
    puts[0].answer(stored('id-a', 'a.pdf'))
    await settle()
    flow.dispose()
    expect(removed).toEqual(['id-a'])
    expect(puts[1].signal.aborted).toBe(true)
    expect(states(flow)).toEqual([])
  })

  it('AC-8.3 (031) subscribers hear every change and get the same snapshot until the next one', () => {
    const { flow } = rig()
    let heard = 0
    const stop = flow.subscribe(() => heard++)
    const before = flow.get()
    expect(flow.get()).toBe(before)
    flow.add([file('a.pdf')])
    expect(heard).toBeGreaterThan(0)
    expect(flow.get()).not.toBe(before)
    stop()
    const after = heard
    flow.dispose()
    expect(heard).toBe(after)
  })
})
