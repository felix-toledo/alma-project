// Which model dreams and what a call costs (spec 033 BR-2, BR-9). Pure; the caller says which providers have a key.
import { costAt } from '../company'
import type { ProviderId } from '../types'

/** The gateway is left out while its price is a guess (BR-2). */
const GATEWAY = 'vercel' satisfies ProviderId
export type EconomyProvider = Exclude<ProviderId, typeof GATEWAY>

/** List prices in USD per million tokens; `checked` is the date they were copied from the provider's price page. */
export interface EconomyRow {
  provider: EconomyProvider
  model: string
  input: number
  output: number
  cacheRead: number
  checked: string
}

/** One economy model per provider, in the fixed tie-break order (BR-2). Empty until real list prices are confirmed (plan §9 B-1, T5). */
export const ECONOMY_MODELS: readonly EconomyRow[] = []

/** The keyed row with the lowest input price, ties to the table's order; null when no row has a key (AC-4.1, AC-4.2). */
export function pickDreamModel(hasKey: (provider: ProviderId) => boolean, table: readonly EconomyRow[] = ECONOMY_MODELS): EconomyRow | null {
  let best: EconomyRow | null = null
  // Checked here too: the type alone does not keep a gateway row out of a table built at run time.
  for (const row of table) if ((row.provider as ProviderId) !== GATEWAY && hasKey(row.provider) && (best === null || row.input < best.input)) best = row
  return best
}

/** Tokens estimated as characters / 4 (plan §9 D-3), the output at the limit the call is sent with. */
export function estimateCallUsd(row: EconomyRow, inputChars: number, maxOutputTokens: number): number {
  return costAt(row, { inputTokens: Math.ceil(inputChars / 4), outputTokens: maxOutputTokens })
}

// Compared in nano-dollars, so 0.1 + 0.1 + 0.05 lands exactly on a 0.25 cap instead of a float hair over it.
const nano = (usd: number): number => Math.round(usd * 1e9)

/** Whether the next call, plus what must stay reserved, would take the night past the cap (AC-4.3). */
export function wouldCross(spentUsd: number, nextUsd: number, reserveUsd: number, capUsd: number): boolean {
  return nano(spentUsd) + nano(nextUsd) + nano(reserveUsd) > nano(capUsd)
}
