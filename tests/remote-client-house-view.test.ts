import { describe, expect, it } from 'vitest'
import { camerasEvent, homeEvent } from '../src/remote-client/lib/house-view'
import type { PwaCamera } from '../src/remote-client/lib/cameras'
import type { PwaThing } from '../src/remote-client/lib/home'
import { nextScreenState, startScreen } from '../src/remote-client/lib/screen-state'

const thing = (id: string, areaId: string | null = null): PwaThing => ({ id, entityId: `light.${id}`, name: id, kind: 'light', areaId, state: 'on', sensitive: false })
const camera = (id: string): PwaCamera => ({ id, entityId: `camera.${id}`, name: id, state: 'idle' })

describe('PWA Home and Cameras screen states (028 AC-6.3, AC-6.5, AC-6.6)', () => {
  it('AC-6.3 (028) a house with things is content grouped by room, and one with none is the empty state', () => {
    expect(homeEvent({ ok: true, things: [thing('a', 'r1')], areas: [{ id: 'r1', name: 'Sala' }] })).toEqual({
      type: 'content',
      data: { kind: 'ready', data: [{ area: 'Sala', things: [thing('a', 'r1')] }] }
    })
    expect(homeEvent({ ok: true, things: [], areas: [] })).toEqual({ type: 'empty' })
    expect(camerasEvent({ ok: true, cameras: [camera('c1')] })).toEqual({ type: 'content', data: { kind: 'ready', data: [camera('c1')] } })
    expect(camerasEvent({ ok: true, cameras: [] })).toEqual({ type: 'empty' })
  })

  it('AC-6.3 (028) every refusal reads through the shared outcomes: revoked, switch off, rate limited, PC unreachable', () => {
    for (const [name, event] of [['home', homeEvent], ['cameras', camerasEvent]] as const) {
      expect(event({ ok: false, reason: 'refused' }), name).toEqual({ type: 'failed', reason: 'unknown-device', operation: name })
      expect(event({ ok: false, reason: 'scope-off' }), name).toEqual({ type: 'failed', reason: 'scope-off', operation: name })
      expect(event({ ok: false, reason: 'rate-limited' }), name).toEqual({ type: 'failed', reason: 'rate-limited', operation: name })
      expect(event({ ok: false, reason: 'network' }), name).toEqual({ type: 'failed', reason: 'network', operation: name })
    }
    expect(nextScreenState(startScreen(0), homeEvent({ ok: false, reason: 'scope-off' }), 1)).toEqual({ kind: 'scopeOff', key: 'remote.pwa.scopeOff' })
    expect(nextScreenState(startScreen(0), camerasEvent({ ok: false, reason: 'network' }), 1)).toEqual({ kind: 'unreachable' })
  })

  it('AC-6.3 (028) a house that is off keeps the PC note, or says the feature is off when the PC gave none', () => {
    expect(homeEvent({ ok: false, reason: 'house-off', note: 'La casa está apagada' })).toEqual({ type: 'content', data: { kind: 'off', note: 'La casa está apagada' } })
    expect(camerasEvent({ ok: false, reason: 'house-off' })).toEqual({ type: 'content', data: { kind: 'off', note: undefined } })
  })

  it('AC-6.5 (028) a switch turned off and on again changes the screen without a reload', () => {
    let state = nextScreenState(startScreen(0), homeEvent({ ok: false, reason: 'scope-off' }), 1)
    expect(state.kind).toBe('scopeOff')
    state = nextScreenState(state, homeEvent({ ok: true, things: [thing('a')], areas: [] }), 2)
    expect(state.kind).toBe('content')
  })
})
