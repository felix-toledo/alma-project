import * as z from 'zod/v4'
import type { RemoteSettings } from '../types'

/** Remote access is opt-in and off by default; every scope starts off (spec 026 BR-5, BR-10). */
export function defaultRemote(): RemoteSettings {
  return {
    enabled: false,
    transport: 'tailscale',
    scopes: { chat: false, approve: false, home: false, cameras: false, vault: false, history: false },
    sensitive: false,
    continueHistory: false,
    cameras: [],
    vaultExcluded: [],
    agentId: 'general'
  }
}

const scopesSchema = z.object({
  chat: z.boolean().catch(false),
  approve: z.boolean().catch(false),
  home: z.boolean().catch(false),
  cameras: z.boolean().catch(false),
  vault: z.boolean().catch(false),
  history: z.boolean().catch(false)
})

const remoteSettingsSchema = z.object({
  enabled: z.boolean().catch(false),
  transport: z.literal('tailscale').catch('tailscale'),
  scopes: scopesSchema.catch(defaultRemote().scopes),
  sensitive: z.boolean().catch(false),
  continueHistory: z.boolean().catch(false),
  // An allow-list fails closed: one bad id drops the whole list.
  cameras: z.array(z.string()).catch([]),
  // Read as unknown: items are dropped one by one, and a non-array is told apart in sanitizeRemote.
  vaultExcluded: z.unknown().optional(),
  agentId: z.string().min(1).catch('general')
})

/** Settings from disk or older versions: unknown shapes become the default, field by field. */
export function sanitizeRemote(value: unknown): RemoteSettings {
  const parsed = remoteSettingsSchema.safeParse(value)
  if (!parsed.success) return defaultRemote()
  const { vaultExcluded, ...rest } = parsed.data
  // A lost exclusion list must not widen access: Notes goes off with it (spec 028 AC-1.3).
  if (!Array.isArray(vaultExcluded)) {
    const raw = (value as Record<string, unknown>).vaultExcluded
    return { ...rest, vaultExcluded: [], scopes: { ...rest.scopes, vault: raw === undefined ? rest.scopes.vault : false } }
  }
  return { ...rest, vaultExcluded: vaultExcluded.filter((item): item is string => typeof item === 'string' && item.trim() !== '') }
}
