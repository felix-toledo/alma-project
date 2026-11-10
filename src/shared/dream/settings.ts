// The dream's settings (spec 033): off by default (BR-1), a nightly cost cap in USD (BR-9), and the status line under them.
import * as z from 'zod/v4'
import type { EconomyProvider } from './model'
import { DreamFailureSchema } from './schedule'

export const DREAM_CAP = { min: 0.01, max: 5, default: 0.25 } as const

export interface DreamSettings {
  enabled: boolean
  capUsd: number
}

const validCap = (value: unknown): value is number => typeof value === 'number' && value >= DREAM_CAP.min && value <= DREAM_CAP.max

const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined)

/** Settings from disk or an older version: each invalid field falls back to its default (AC-1.1). */
export function sanitizeDreamSettings(stored: unknown): DreamSettings {
  const enabled = field(stored, 'enabled')
  const capUsd = field(stored, 'capUsd')
  return { enabled: typeof enabled === 'boolean' ? enabled : false, capUsd: validCap(capUsd) ? capUsd : DREAM_CAP.default }
}

/** A change from the settings screen: an invalid field keeps its previous value (AC-1.3). */
export function acceptDreamPatch(previous: DreamSettings, patch: unknown): DreamSettings {
  const enabled = field(patch, 'enabled')
  const capUsd = field(patch, 'capUsd')
  return { enabled: typeof enabled === 'boolean' ? enabled : previous.enabled, capUsd: validCap(capUsd) ? capUsd : previous.capUsd }
}

export const DreamLastSchema = z.object({ at: z.number(), costUsd: z.number(), outcome: z.enum(['ok', 'capped', 'skipped']) })
export const DreamFailureRecordSchema = z.object({ at: z.number(), reason: DreamFailureSchema })

/** What the status line under the switch shows (AC-1.2, AC-1.5, BR-34): ids, dates, amounts, no text. */
export interface DreamStatusView {
  enabled: boolean
  /** The provider and model the dream would use now; null without a key (AC-1.2). */
  choice: { provider: EconomyProvider; model: string } | null
  last?: z.infer<typeof DreamLastSchema>
  /** The last failure, kept after a later dream: the line shows both (BR-34). */
  failure?: z.infer<typeof DreamFailureRecordSchema>
  running: boolean
}
