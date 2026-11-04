// Small rules about what a tool card shows, kept pure so they are tested (spec 025 AC-4.4).

/** The workspace path a generate_image result points to, if it succeeded (results saved before spec 025 say it in Spanish). */
export function generatedImagePath(result: string | undefined): string | undefined {
  return result ? /^(?:Image saved|Imagen guardada): (.+)$/m.exec(result)?.[1]?.trim() : undefined
}

/** The reason on an approval card: the reviewer's English first, and its translation once it has arrived. */
export function reviewerReasonShown(approval: { reason?: string; reasonShown?: string }): string | undefined {
  return approval.reasonShown ?? approval.reason
}
