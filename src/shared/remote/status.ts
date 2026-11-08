import type { RemoteSettings } from '../types'
import type { StatusView } from './wire'

/** What Settings on the phone may learn: which switches are on, nothing about what they cover (spec 028 AC-6.11). */
export function statusView(remote: RemoteSettings): StatusView {
  const { chat, approve, home, cameras, vault, history } = remote.scopes
  return { scopes: { chat, approve, home, cameras, vault, history }, sensitive: remote.sensitive, continue: remote.continueHistory && history }
}
