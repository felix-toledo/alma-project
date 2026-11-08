import type { StatusView } from '../../shared/remote/wire'
import type { PwaKey } from '../i18n/es'

/** The read-only list in Settings (AC-6.7): which switches are on, in the spec's order, and nothing about what they cover. */
export function canList(status: StatusView): { key: PwaKey; on: boolean }[] {
  const scopes: Partial<Record<string, unknown>> = status.scopes ?? {}
  const on = (value: unknown): boolean => value === true
  return [
    { key: 'remote.pwa.can.chat', on: on(scopes.chat) },
    { key: 'remote.pwa.can.approve', on: on(scopes.approve) },
    { key: 'remote.pwa.can.home', on: on(scopes.home) },
    { key: 'remote.pwa.can.cameras', on: on(scopes.cameras) },
    { key: 'remote.pwa.can.sensitive', on: on(status.sensitive) },
    { key: 'remote.pwa.can.notes', on: on(scopes.vault) },
    { key: 'remote.pwa.can.threads', on: on(scopes.history) },
    { key: 'remote.pwa.can.continue', on: on(status.continue) }
  ]
}
