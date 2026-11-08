import { describe, expect, it } from 'vitest'
import { hostConfirmation, REMOTE_OPEN_URLS, remoteDialog, trayMenu, trayState } from '../src/main/messages'
import { movedExclusions } from '../src/main/remote-exclusions'
import { defaultRemote } from '../src/shared/remote/settings'
import type { RemoteSettings, Settings } from '../src/shared/types'
import { translate } from '../src/shared/i18n/messages'

describe('remote main dialogs (spec 026 T5)', () => {
  it('AC-1.2 the dialog has the title, the text and Cancel as the default', () => {
    const text = remoteDialog('es', { kind: 'enable', dormant: [] })
    expect(text.title).toBe(translate('es', 'main.security.title'))
    expect(text.message).toBe(translate('es', 'main.remote.enable'))
    expect(text.detail).toBe(translate('es', 'main.remote.enableDetail'))
    expect(text.buttons).toEqual([translate('es', 'main.security.allow'), translate('es', 'main.security.cancel')])
    expect(text.defaultId).toBe(1)
    const english = remoteDialog('en', { kind: 'enable', dormant: [] })
    expect(english.title).toBe(translate('en', 'main.security.title'))
    expect(english.defaultId).toBe(1)
  })

  it('AC-1.11 the dialog lists the dormant names', () => {
    const text = remoteDialog('es', { kind: 'enable', dormant: ['Pixel de Ana', 'iPhone'] })
    expect(text.detail).toBe(`${translate('es', 'main.remote.enableDetail')}\n${translate('es', 'main.remote.dormant', { names: 'Pixel de Ana, iPhone' })}`)
  })

  it('AC-1.11 odd dormant names are joined verbatim: they are person-typed and trusted', () => {
    const text = remoteDialog('es', { kind: 'enable', dormant: ['a,b', 'c\nd'] })
    expect(text.detail).toBe(
      `${translate('es', 'main.remote.enableDetail')}\n${translate('es', 'main.remote.dormant', { names: 'a,b, c\nd' })}`
    )
  })

  it('AC-1.9 AC-1.10 AC-5.22 scope, locks and camera confirmations name what they widen', () => {
    expect(remoteDialog('es', { kind: 'scope', scope: 'chat' }).message).toBe(
      translate('es', 'main.remote.scope', { scope: translate('es', 'remote.scope.chat') })
    )
    expect(remoteDialog('es', { kind: 'sensitive' }).message).toBe(translate('es', 'main.remote.sensitive'))
    expect(remoteDialog('es', { kind: 'camera', cameraId: 'camera.kitchen' }).message).toBe(
      translate('es', 'main.remote.camera', { camera: 'camera.kitchen' })
    )
  })

  it('AC-1.2 (028) the Notes dialog names the vault folder, the continue dialog says the phone can make agents work', () => {
    const notes = remoteDialog('es', { kind: 'scope', scope: 'vault', vaultFolder: 'E:\\Notas' })
    expect(notes.message).toBe(translate('es', 'main.remote.scope', { scope: translate('es', 'remote.scope.vault') }))
    expect(notes.detail).toBe(translate('es', 'main.remote.scope.vaultDetail', { folder: 'E:\\Notas' }))
    expect(remoteDialog('en', { kind: 'scope', scope: 'vault', vaultFolder: 'E:\\Notes' }).detail).toBe(
      translate('en', 'main.remote.scope.vaultDetail', { folder: 'E:\\Notes' })
    )
    // Every other scope keeps an empty detail.
    expect(remoteDialog('es', { kind: 'scope', scope: 'history' }).detail).toBe('')
    expect(remoteDialog('es', { kind: 'scope', scope: 'vault' }).detail).toBe('')
    const resume = remoteDialog('es', { kind: 'continue' })
    expect(resume.message).toBe(translate('es', 'main.remote.continue'))
    expect(resume.message).toContain('agentes')
    expect(resume.defaultId).toBe(1)
  })

  it('AC-1.10 (028) the unexclude dialog names the folder and Cancel is the default', () => {
    const text = remoteDialog('en', { kind: 'unexclude', folder: 'Private/Taxes' })
    expect(text.message).toBe(translate('en', 'main.remote.unexclude', { folder: 'Private/Taxes' }))
    expect(text.message).toContain('Private/Taxes')
    expect(text.buttons).toEqual([translate('en', 'main.security.allow'), translate('en', 'main.security.cancel')])
    expect(text.defaultId).toBe(1)
  })

  it('AC-4.3 the pair dialog shows the name and the code', () => {
    const text = remoteDialog('es', { kind: 'pair', name: 'Pixel', code: '123456' })
    expect(text.message).toBe(translate('es', 'main.remote.pair', { name: 'Pixel', code: '123456' }))
    expect(text.title).toBe(translate('es', 'main.security.title'))
    expect(text.buttons).toEqual([translate('es', 'main.security.allow'), translate('es', 'main.security.cancel')])
    expect(text.defaultId).toBe(1)
  })

  it('AC-2.8 the serve dialog shows the exact command', () => {
    const command = 'tailscale serve --https=443 http://127.0.0.1:18789'
    const text = remoteDialog('es', { kind: 'serve', command })
    expect(text.message).toBe(translate('es', 'main.remote.serve'))
    expect(text.detail).toBe(command)
    expect(text.defaultId).toBe(1)
  })

  it('AC-6.5 the revoke-all dialog names the wipe', () => {
    const text = remoteDialog('es', { kind: 'revokeAll' })
    expect(text.message).toBe(translate('es', 'main.remote.revokeAll'))
    expect(text.defaultId).toBe(1)
  })

  it('AC-2.2 the download dialog shows the official URL', () => {
    const text = remoteDialog('es', { kind: 'download', url: 'https://tailscale.com/download' })
    expect(text.message).toBe(translate('es', 'main.remote.download'))
    expect(text.detail).toBe('https://tailscale.com/download')
    expect(text.defaultId).toBe(1)
  })

  it('AC-2.2 the open table maps the two fixed ids to the official pages, nothing else', () => {
    expect(REMOTE_OPEN_URLS).toEqual({
      'tailscale-download': 'https://tailscale.com/download',
      'tailscale-terms': 'https://tailscale.com/terms'
    })
  })

  it('AC-4.3 host confirmations build from string params and refuse incomplete ones', () => {
    expect(hostConfirmation('pair', { name: 'Pixel', code: '123456' })).toEqual({ kind: 'pair', name: 'Pixel', code: '123456' })
    expect(hostConfirmation('serve', { command: 'tailscale serve' })).toEqual({ kind: 'serve', command: 'tailscale serve' })
    expect(hostConfirmation('revokeAll', {})).toEqual({ kind: 'revokeAll' })
    expect(hostConfirmation('pair', { name: 'Pixel' })).toBeNull()
    expect(hostConfirmation('pair', { code: '123456' })).toBeNull()
    expect(hostConfirmation('serve', {})).toBeNull()
    expect(hostConfirmation('download', {})).toBeNull()
    expect(hostConfirmation('nope', {})).toBeNull()
  })

  it('AC-1.13 the tray menu carries the remote kill-switch text', () => {
    expect(trayMenu('es').remoteOff).toBe(translate('es', 'tray.remote.off'))
    expect(trayMenu('en').remoteOff).toBe(translate('en', 'tray.remote.off'))
  })
})

describe('remote exclusion move (spec 028 T42)', () => {
  const remote = (vaultExcluded: string[]): RemoteSettings => ({ ...defaultRemote(), vaultExcluded })
  // The disk after the rename: only the destinations exist, the origins are gone.
  const moved = (path: string): boolean => ['job', 'archive/private', 'x', 'diary'].includes(path.toLowerCase())

  it('AC-1.11 (028) a move rewrites the list without a dialog and never adds an unrelated path', () => {
    const before = remote(['Private', 'Work/Taxes', 'work/Taxes/2024', 'Journal'])
    const next = movedExclusions(before, { from: 'work', to: 'Job' }, moved)
    expect(next).toEqual(['Private', 'Job/Taxes', 'Job/Taxes/2024', 'Journal'])
    expect(next).toHaveLength(before.vaultExcluded.length)
    expect(movedExclusions(before, { from: 'Private', to: 'Archive/Private' }, moved)).toEqual(['Archive/Private', 'Work/Taxes', 'work/Taxes/2024', 'Journal'])
    // The inputs are not mutated and the rewrite is a plain list: nothing here can reach a dialog or a settings write.
    expect(before.vaultExcluded).toEqual(['Private', 'Work/Taxes', 'work/Taxes/2024', 'Journal'])
  })

  it('AC-1.11 (028) a move naming a path that is not in the list changes nothing', () => {
    const before = remote(['Private', 'Work/Taxes'])
    expect(movedExclusions(before, { from: 'Journal', to: 'Diary' }, moved)).toBeNull()
    expect(movedExclusions(before, { from: 'Priv', to: 'X' }, moved)).toBeNull()
    expect(movedExclusions(before, { from: 'Work', to: 'Work' }, () => true)).toBeNull()
    expect(movedExclusions(remote([]), { from: 'Private', to: 'X' }, moved)).toBeNull()
    expect(movedExclusions(before, { from: '', to: 'X' }, moved)).toBeNull()
  })

  it('AC-1.11 (028) malformed arguments change nothing', () => {
    const before = remote(['Private'])
    for (const args of [null, undefined, 'Private', { from: 'Private' }, { from: 1, to: 'X' }, { from: 'Private', to: 'X', extra: true }, { from: 'Private', to: 'x'.repeat(1025) }]) {
      expect(movedExclusions(before, args, moved)).toBeNull()
    }
  })

  it('AC-1.11 (028) a lying renderer cannot move an exclusion while the folder is still where it was', () => {
    const before = remote(['Private'])
    const stays = (path: string): boolean => ['private', 'archive/private'].includes(path.toLowerCase())
    expect(movedExclusions(before, { from: 'Private', to: 'Archive/Private' }, stays)).toBeNull()
    expect(movedExclusions(before, { from: 'Private', to: 'Archive/Private' }, (path) => path.toLowerCase() === 'private')).toBeNull()
    expect(movedExclusions(before, { from: 'Private', to: 'Archive/Private' }, (path) => path.toLowerCase() === 'archive/private')).toEqual(['Archive/Private'])
  })

  it('AC-1.11 (028) a case-only rename counts as moved although both spellings exist on a case-insensitive disk', () => {
    expect(movedExclusions(remote(['Private']), { from: 'Private', to: 'private' }, () => true)).toEqual(['private'])
  })
})

describe('remote tray rule (spec 026 T34)', () => {
  const settings = (runInTray: boolean, remoteEnabled: boolean): Settings =>
    ({ background: { runInTray }, remote: { enabled: remoteEnabled } }) as Settings

  it('AC-1.13 the tray offers turning remote off only while it is on', () => {
    expect(trayState(settings(false, false)).remoteOff).toBe(false)
    expect(trayState(settings(true, false)).remoteOff).toBe(false)
    expect(trayState(settings(false, true)).remoteOff).toBe(true)
    expect(trayState(settings(true, true)).remoteOff).toBe(true)
  })

  it('AC-1.13 the tray icon exists while remote is on even with tray mode off, and is gone when both are off', () => {
    expect(trayState(settings(false, false)).icon).toBe(false)
    expect(trayState(settings(true, false)).icon).toBe(true)
    expect(trayState(settings(false, true)).icon).toBe(true)
    expect(trayState(settings(true, true)).icon).toBe(true)
  })
})
