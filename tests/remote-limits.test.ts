import { describe, expect, it } from 'vitest'
import { RateLimiter, exceedsRequestBytes } from '../src/coordinator/channels/remote/limits'
import { REMOTE_LIMITS } from '../src/shared/remote/api'

describe('remote limits (spec 026 T9)', () => {
  it('AC-10.1 AC-10.4 the specified limits are the specified values', () => {
    expect(REMOTE_LIMITS).toEqual({
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
      firstLoadMessages: 30
    })
  })

  it('AC-10.2 the 60th request in a minute passes and the 61st is refused', () => {
    let now = 1_000_000
    const limits = new RateLimiter(() => now)
    for (let i = 0; i < 60; i++) expect(limits.takeRequest('d1')).toBe(true)
    expect(limits.takeRequest('d1')).toBe(false)
    now += 60_000
    expect(limits.takeRequest('d1')).toBe(true)
  })

  it('AC-10.2 two devices do not share counters', () => {
    const limits = new RateLimiter(() => 0)
    for (let i = 0; i < 60; i++) limits.takeRequest('d1')
    expect(limits.takeRequest('d1')).toBe(false)
    expect(limits.takeRequest('d2')).toBe(true)
  })

  it('AC-4.9 more than 5 pairing requests a minute are refused', () => {
    let now = 0
    const limits = new RateLimiter(() => now)
    for (let i = 0; i < 5; i++) expect(limits.takePairing()).toBe(true)
    expect(limits.takePairing()).toBe(false)
    now += 60_000
    expect(limits.takePairing()).toBe(true)
  })

  it('AC-10.3 a device with 2 connections open cannot open a third', () => {
    const limits = new RateLimiter(() => 0)
    expect(limits.open('d1')).toBe(true)
    expect(limits.open('d1')).toBe(true)
    expect(limits.open('d1')).toBe(false)
    expect(limits.open('d2')).toBe(true)
  })

  it('AC-10.3 a released connection frees its slot; releasing twice is harmless', () => {
    const limits = new RateLimiter(() => 0)
    limits.open('d1')
    limits.open('d1')
    limits.close('d1')
    expect(limits.open('d1')).toBe(true)
    limits.close('d1')
    limits.close('d1')
    limits.close('d1')
    expect(limits.open('d1')).toBe(true)
    expect(limits.open('d1')).toBe(true)
    expect(limits.open('d1')).toBe(false)
  })

  it('AC-10.1 a request body over 1 MB is too large', () => {
    expect(exceedsRequestBytes(1_048_576)).toBe(false)
    expect(exceedsRequestBytes(1_048_577)).toBe(true)
  })
})
