// Text main shows outside the window. Pure on purpose (no electron), so it is tested; the strings live in the dictionaries.
import { PROVIDER_NAMES } from '../shared/defaults'
import type { Language } from '../shared/i18n/language'
import { type MessageKey, translate } from '../shared/i18n/messages'
import type { RemoteConfirmation } from '../shared/remote/confirmations'
import type { ProviderId, Settings } from '../shared/types'

export function trayMenu(language: Language): { open: string; quit: string; tooltip: string; remoteOff: string } {
  return {
    open: translate(language, 'tray.open'),
    quit: translate(language, 'tray.quit'),
    tooltip: translate(language, 'tray.tooltip'),
    remoteOff: translate(language, 'tray.remote.off')
  }
}

/**
 * The tray rule (spec 026 T34, amends spec 023 in T48): the quick kill switch exists
 * while remote access is on, whatever "keep running in the tray" says.
 */
export function trayState(settings: Settings): { icon: boolean; remoteOff: boolean } {
  return { icon: settings.background.runInTray || settings.remote.enabled, remoteOff: settings.remote.enabled }
}

/** The native confirmation for the two changes that give an agent more power than the person gave it. */
export function securityDialog(
  language: Language,
  kind: 'mcp' | 'always-allow',
  programs: string[]
): { title: string; message: string; detail: string; allow: string; cancel: string } {
  return {
    title: translate(language, 'main.security.title'),
    message: translate(language, kind === 'mcp' ? 'main.security.mcp' : 'main.security.alwaysAllow'),
    detail: kind === 'mcp' ? programs.join('\n') : translate(language, 'main.security.alwaysAllowDetail'),
    allow: translate(language, 'main.security.allow'),
    cancel: translate(language, 'main.security.cancel')
  }
}

/** The native confirmation for each remote-access widening (spec 026 BR-29). Cancel is always the default. */
export function remoteDialog(
  language: Language,
  confirmation: RemoteConfirmation
): { title: string; message: string; detail: string; buttons: string[]; defaultId: number } {
  const base = {
    title: translate(language, 'main.security.title'),
    buttons: [translate(language, 'main.security.allow'), translate(language, 'main.security.cancel')],
    defaultId: 1
  }
  switch (confirmation.kind) {
    case 'enable': {
      const detail = translate(language, 'main.remote.enableDetail')
      const lines = [detail]
      if (confirmation.dormant.length) lines.push(translate(language, 'main.remote.dormant', { names: confirmation.dormant.join(', ') }))
      // The relay is named at every turn-on while it is the selected transport (spec 027 AC-1.13).
      if (confirmation.relay) lines.push(translate(language, 'main.remote.relayOn'))
      return { ...base, message: translate(language, 'main.remote.enable'), detail: lines.join('\n') }
    }
    case 'relay':
      return { ...base, message: translate(language, 'main.remote.relay'), detail: '' }
    case 'scope':
      return {
        ...base,
        message: translate(language, 'main.remote.scope', { scope: translate(language, `remote.scope.${confirmation.scope}`) }),
        detail: confirmation.vaultFolder ? translate(language, 'main.remote.scope.vaultDetail', { folder: confirmation.vaultFolder }) : ''
      }
    case 'sensitive':
      return { ...base, message: translate(language, 'main.remote.sensitive'), detail: '' }
    case 'continue':
      return { ...base, message: translate(language, 'main.remote.continue'), detail: '' }
    case 'attachments':
      return { ...base, message: translate(language, 'main.remote.attachments', { providers: confirmation.providers.map((p) => PROVIDER_NAMES[p]).join(', ') }), detail: '' }
    case 'unexclude':
      return { ...base, message: translate(language, 'main.remote.unexclude', { folder: confirmation.folder }), detail: '' }
    case 'camera':
      return { ...base, message: translate(language, 'main.remote.camera', { camera: confirmation.cameraId }), detail: '' }
    case 'pair':
      return {
        ...base,
        message: translate(language, 'main.remote.pair', { name: confirmation.name, code: confirmation.code }),
        detail: ''
      }
    case 'serve':
      return { ...base, message: translate(language, 'main.remote.serve'), detail: confirmation.command }
    case 'revokeAll':
      return { ...base, message: translate(language, 'main.remote.revokeAll'), detail: '' }
    case 'download':
      return { ...base, message: translate(language, 'main.remote.download'), detail: confirmation.url }
  }
}

/** The providers an allowed Send files dialog covers: they join the desktop notice list (spec 031 AC-1.4). */
export function acknowledgedProviders(confirmations: readonly RemoteConfirmation[]): ProviderId[] {
  return confirmations.flatMap((c) => (c.kind === 'attachments' ? c.providers : []))
}

/**
 * The coordinator's remote.confirm arrives as string params; missing pieces refuse without a
 * dialog, never approve blind. 'download' is not a confirm kind: remote.open shows it itself.
 */
export function hostConfirmation(kind: string, params: Record<string, string>): RemoteConfirmation | null {
  if (kind === 'revokeAll') return { kind: 'revokeAll' }
  if (kind === 'pair' && params.name !== undefined && params.code !== undefined) {
    return { kind: 'pair', name: params.name, code: params.code }
  }
  if (kind === 'serve' && params.command !== undefined) return { kind: 'serve', command: params.command }
  return null
}

/**
 * The only pages remote.open may open, chosen by main from a fixed id (PD-9). Both verified
 * against tailscale.com while writing (T16); the download page detects the OS itself.
 */
export const REMOTE_OPEN_URLS = {
  'tailscale-download': 'https://tailscale.com/download',
  'tailscale-terms': 'https://tailscale.com/terms'
} as const

/** Titles of the Instagram windows the person watches. */
export function instagramTitle(language: Language, kind: 'connect' | 'test' | 'publishing'): string {
  return translate(language, `main.instagram.${kind}`)
}

/** Title of the native "attach files" dialog (spec 030 AC-1.8). */
export function attachPickTitle(language: Language): string {
  return translate(language, 'main.attach.pickTitle')
}

export type MainError = 'rejected-origin' | 'cancelled' | 'unknown-provider' | 'unknown-company' | 'path-missing' | 'no-programs' | 'invalid-language' | 'unknown-target' | 'missing-data'

const ERROR_KEYS = {
  'rejected-origin': 'main.error.rejectedOrigin',
  cancelled: 'main.error.cancelled',
  'unknown-provider': 'main.error.unknownProvider',
  'unknown-company': 'main.error.unknownCompany',
  'path-missing': 'main.error.pathMissing',
  'no-programs': 'main.error.noPrograms',
  'invalid-language': 'main.error.invalidLanguage',
  'unknown-target': 'main.error.unknownTarget',
  'missing-data': 'main.error.missingData'
} as const satisfies Record<MainError, MessageKey>

/** Text of an error that main throws or returns to the window. */
export function mainError(language: Language, error: MainError): string {
  return translate(language, ERROR_KEYS[error])
}
