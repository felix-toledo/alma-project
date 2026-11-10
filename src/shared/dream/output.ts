// What the dream's model must answer (spec 033 BR-15, AC-4.4, AC-6.9). Anything else is invalid output: nothing is applied.
import * as z from 'zod/v4'

export const SourceSchema = z.strictObject({ thread: z.string().min(1), ts: z.number().int().min(0) })
export type Source = z.infer<typeof SourceSchema>

const sources = z.array(SourceSchema).min(1)
// The bounds remember enforces, then one line as remember writes it.
const memoryLine = z
  .string()
  .min(3)
  .max(300)
  .transform((text) => text.replace(/\s+/g, ' ').trim())
  .refine((text) => text.length > 0)
const why = z.string().min(1)

export const BatchOutputSchema = z.strictObject({
  add: z.array(z.strictObject({ text: memoryLine, why, sources })),
  replace: z.array(z.strictObject({ old: z.string().min(1), text: memoryLine, why, sources })),
  remove: z.array(z.strictObject({ old: z.string().min(1), why, sources })),
  speculative: z.array(z.strictObject({ text: z.string().min(1), sources }))
})
export type BatchOutput = z.infer<typeof BatchOutputSchema>

export const GreetingOutputSchema = z.strictObject({ greeting: z.string().min(1).max(1200) })

/** The JSON of an answer, bare or in one code fence; undefined when it is not JSON. */
function json(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /^```[a-z]*\r?\n([\s\S]*)\r?\n```$/i.exec(trimmed)
  try {
    return JSON.parse(fenced ? fenced[1] : trimmed)
  } catch {
    return undefined
  }
}

/** A batch answer, or null when it is invalid or cites a source it was not given (plan §10 G4). */
export function parseBatch(text: string, refs: ReadonlySet<string>): BatchOutput | null {
  const parsed = BatchOutputSchema.safeParse(json(text))
  if (!parsed.success) return null
  const { add, replace, remove, speculative } = parsed.data
  const cited = [...add, ...replace, ...remove, ...speculative].flatMap((item) => item.sources)
  return cited.every((s) => refs.has(`${s.thread}@${s.ts}`)) ? parsed.data : null
}

/** The greeting answer's text, or null when it is invalid. */
export function parseGreeting(text: string): string | null {
  const parsed = GreetingOutputSchema.safeParse(json(text))
  return parsed.success ? parsed.data.greeting : null
}
