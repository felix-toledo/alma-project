// Test helper for the dictionaries (spec 025 AC-2.3).
import type { Message } from '../../src/shared/i18n/messages'

/** The keys that only one of two dictionaries defines. */
export function dictionaryDiff(a: Record<string, Message>, b: Record<string, Message>): { onlyInA: string[]; onlyInB: string[] } {
  return {
    onlyInA: Object.keys(a).filter((key) => !(key in b)),
    onlyInB: Object.keys(b).filter((key) => !(key in a))
  }
}
