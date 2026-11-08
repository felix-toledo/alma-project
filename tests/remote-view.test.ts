import { describe, expect, it } from 'vitest'
import { formatDateTime } from '../src/shared/i18n/format'
import type { RemoteFailure, RemoteStatus } from '../src/shared/types'
import { activityRowText, dormantMarking, failureKey, wizardStep, type WizardTailscale } from '../src/shared/remote/view'

describe('T36 PC view logic (AC-2.4, 2.7, 6.4, 7.6)', () => {
  const tailscale = (over: Partial<WizardTailscale> = {}): WizardTailscale => ({ state: 'connected', https: true, serving: true, ...over })
  const offline: RemoteStatus = { state: 'error', failure: 'tailscaleDown' }
  const online: RemoteStatus = { state: 'online', address: 'https://pc.tailnet.ts.net' }

  it('wizardStep: missing → download; disconnected → tailscale; no HTTPS → https; not published → serve', () => {
    expect(wizardStep({ tailscale: tailscale({ state: 'missing' }), status: offline, devices: 0 })).toBe('download')
    expect(wizardStep({ tailscale: tailscale({ state: 'disconnected' }), status: offline, devices: 0 })).toBe('tailscale')
    expect(wizardStep({ tailscale: tailscale({ https: false }), status: offline, devices: 0 })).toBe('https')
    expect(wizardStep({ tailscale: tailscale({ serving: false }), status: offline, devices: 0 })).toBe('serve')
  })

  it('wizardStep: published but not tested → test; tested with no device → pair; devices → ready', () => {
    expect(wizardStep({ tailscale: tailscale(), status: offline, devices: 0 })).toBe('test')
    expect(wizardStep({ tailscale: tailscale(), status: online, devices: 0 })).toBe('pair')
    expect(wizardStep({ tailscale: tailscale(), status: online, devices: 2 })).toBe('ready')
  })

  it('wizardStep: earlier problems win over later ones', () => {
    expect(wizardStep({ tailscale: tailscale({ state: 'missing', https: false, serving: false }), status: offline, devices: 3 })).toBe('download')
    expect(wizardStep({ tailscale: tailscale({ state: 'disconnected', https: false }), status: online, devices: 3 })).toBe('tailscale')
  })

  it('failureKey: every RemoteFailure maps to its wizard key', () => {
    const failures: RemoteFailure[] = ['noInternet', 'tailscaleDown', 'httpsOff', 'listener', 'phoneSilent', 'portTaken', 'serveBusy']
    for (const failure of failures) expect(failureKey(failure)).toBe(`remote.wizard.fail.${failure}`)
  })

  it('dormantMarking: remote off marks every device dormant; on leaves them alone', () => {
    const devices = [
      { id: 'a', name: 'phone-a', pairedAt: 1, lastSeen: 2, dormant: false },
      { id: 'b', name: 'phone-b', pairedAt: 1, lastSeen: null, dormant: false }
    ]
    expect(dormantMarking(devices, false)).toEqual([
      { id: 'a', name: 'phone-a', pairedAt: 1, lastSeen: 2, dormant: true },
      { id: 'b', name: 'phone-b', pairedAt: 1, lastSeen: null, dormant: true }
    ])
    expect(dormantMarking(devices, true)).toBe(devices)
  })

  it('activityRowText: the date goes through shared/i18n/format, in each language', () => {
    const ts = new Date(Date.UTC(2026, 4, 9, 15, 4, 0)).toISOString()
    const es = activityRowText({ ts, device: 'phone-a' }, 'es')
    const en = activityRowText({ ts, device: 'phone-a' }, 'en')
    expect(es.who).toBe('phone-a')
    expect(en.who).toBe('phone-a')
    expect(es.when).not.toBe(en.when)
    expect(es.when).toBe(formatDateTime('es', new Date(ts), 'short'))
    expect(en.when).toBe(formatDateTime('en', new Date(ts), 'short'))
    expect(activityRowText({ ts, device: '' }, 'es')).toEqual({ when: es.when, who: null })
  })
})
