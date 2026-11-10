import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../src/shared/defaults'

const electron = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => electron.userData },
  safeStorage: { isEncryptionAvailable: () => false }
}))

import { SettingsStore } from '../src/main/settings'

const file = (): string => join(electron.userData, 'settings.json')

beforeEach(() => {
  electron.userData = mkdtempSync(join(tmpdir(), 'alma-dream-settings-'))
})
afterEach(() => rmSync(electron.userData, { recursive: true, force: true }))

describe('dream settings in main (spec 033 T13)', () => {
  it('AC-1.1 (033) old settings load with the dream off', () => {
    expect(defaultSettings().dream).toEqual({ enabled: false, capUsd: 0.25 })
    expect(new SettingsStore(['es']).get().dream).toEqual({ enabled: false, capUsd: 0.25 })
    // A save from before spec 033, then one with garbage in the section.
    writeFileSync(file(), JSON.stringify({ language: 'es', defaultAgentId: 'alma' }))
    expect(new SettingsStore(['es']).get().dream).toEqual({ enabled: false, capUsd: 0.25 })
    writeFileSync(file(), JSON.stringify({ dream: { enabled: 'yes', capUsd: 99 } }))
    expect(new SettingsStore(['es']).get().dream).toEqual({ enabled: false, capUsd: 0.25 })
    writeFileSync(file(), JSON.stringify({ dream: { enabled: true, capUsd: 1.5 } }))
    expect(new SettingsStore(['es']).get().dream).toEqual({ enabled: true, capUsd: 1.5 })
  })

  it('AC-1.3 (033) an invalid cap keeps the previous one', () => {
    const store = new SettingsStore(['es'])
    expect(store.update({ dream: { enabled: true, capUsd: 2 } }).dream).toEqual({ enabled: true, capUsd: 2 })
    for (const bad of [0, -1, 0.009, 5.01, Number.NaN, 'abc', '0.5', null]) {
      expect(store.update({ dream: { enabled: true, capUsd: bad as number } }).dream).toEqual({ enabled: true, capUsd: 2 })
    }
    // Only the dream section is checked; a bad switch value keeps the previous switch too.
    expect(store.update({ dream: { enabled: 'no' as unknown as boolean, capUsd: 0.01 } }).dream).toEqual({ enabled: true, capUsd: 0.01 })
    expect(JSON.parse(readFileSync(file(), 'utf8')).dream).toEqual({ enabled: true, capUsd: 0.01 })
  })
})
