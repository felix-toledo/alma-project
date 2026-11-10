// The end-trimming of long tool results, shared by the coordinator's history compaction and the dream (spec 033 BR-21).

/** Kept from each end of a tool result from an earlier turn. */
export const KEEP_CHARS = 600

export function shorten(text: string, keep: number): string {
  if (text.length <= keep * 2 + 200) return text
  return `${text.slice(0, keep)}
[… trimmed: ${text.length - keep * 2} characters of an earlier answer …]
${text.slice(-keep)}`
}
