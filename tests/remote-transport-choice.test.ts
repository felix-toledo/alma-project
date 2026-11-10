import { describe, expect, it } from 'vitest'
import { chooseTransport, planTransportChange } from '../src/coordinator/channels/remote/transport-choice'

// Which transport runs, decided apart from the composition root (spec 027 AC-1.1, AC-1.8, AC-1.10).
const plan = (over: Partial<Parameters<typeof planTransportChange>[0]> = {}) =>
  planTransportChange({ transport: 'tailscale', available: true, enabled: true, active: 'tailscale', ...over })

describe('which transport runs (spec 027 T20 composition)', () => {
  it('AC-1.1 Tailscale is what runs unless the relay is both chosen and offered by this build', () => {
    expect(chooseTransport({ transport: 'tailscale', available: true })).toBe('tailscale')
    expect(chooseTransport({ transport: 'tailscale', available: false })).toBe('tailscale')
    expect(chooseTransport({ transport: 'relay', available: true })).toBe('relay')
    // A packaged build with no relay to offer keeps the person on Tailscale, whatever the saved setting says.
    expect(chooseTransport({ transport: 'relay', available: false })).toBe('tailscale')
  })

  it('AC-1.8 exactly one transport at a time: the answer is one of the two and the Tailscale monitor runs only for Tailscale', () => {
    for (const transport of ['tailscale', 'relay'] as const) {
      for (const available of [true, false]) {
        for (const enabled of [true, false]) {
          for (const active of ['tailscale', 'relay'] as const) {
            const result = plan({ transport, available, enabled, active })
            expect(['tailscale', 'relay']).toContain(result.use)
            expect(result.use).toBe(chooseTransport({ transport, available }))
            expect(result.monitor).toBe(enabled && result.use === 'tailscale')
            expect(result.touchesTailscale).toBe(result.use === 'tailscale')
          }
        }
      }
    }
  })

  it('AC-1.10 with the relay selected Tailscale is left alone: no monitor, no Serve, no setup calls; the one exception is taking down the Serve entry when the person switches away from Tailscale', () => {
    expect(plan({ transport: 'relay', active: 'relay' })).toMatchObject({ use: 'relay', monitor: false, unserve: false, touchesTailscale: false, restart: false })
    expect(plan({ transport: 'relay', active: 'tailscale' })).toMatchObject({ use: 'relay', monitor: false, unserve: true, touchesTailscale: false, restart: true })
    expect(plan({ transport: 'relay', enabled: false, active: 'relay' })).toMatchObject({ monitor: false, unserve: false })
  })

  it('AC-1.8 a change of the choice restarts the channel; no change does not; turning Tailscale off takes down its Serve entry', () => {
    expect(plan({ transport: 'tailscale', active: 'relay' })).toMatchObject({ use: 'tailscale', restart: true, monitor: true, unserve: false })
    expect(plan({ transport: 'tailscale', active: 'tailscale' })).toMatchObject({ restart: false, monitor: true })
    expect(plan({ transport: 'tailscale', enabled: false, active: 'tailscale' })).toMatchObject({ monitor: false, unserve: true })
  })

  it('AC-1.8 there is no fallback: the plan has no input about how a transport is doing, so a failure of one cannot choose the other', () => {
    // Same inputs, same answer, however many times and in whatever order.
    const first = plan({ transport: 'relay', active: 'relay' })
    plan({ transport: 'tailscale', active: 'tailscale' })
    expect(plan({ transport: 'relay', active: 'relay' })).toEqual(first)
    expect(Object.keys(first).sort()).toEqual(['monitor', 'restart', 'touchesTailscale', 'unserve', 'use'])
  })
})
