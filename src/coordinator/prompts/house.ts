// What a house rule says to the agent it wakes, in English whatever the app language (spec 025 BR-17).

export interface HouseRuleRun {
  rule: string
  thing: string
  entityId: string
  from: string | null | undefined
  to: string | null | undefined
  /** When it fired, written for the model. */
  at: string
  /** The person's own instructions for the rule: they stay as they wrote them. */
  instructions: string
}

export const houseRulePrompt = (run: HouseRuleRun): string =>
  `Your house rule “${run.rule}” fired: “${run.thing}” (${run.entityId}) went from “${run.from ?? '—'}” to “${run.to ?? '—'}” at ${run.at}.
What you have to do: ${run.instructions}
Act now with the house tools (cameras with camera_look). If it is something the user should know, tell them with send_telegram; if nothing relevant is going on, do not bother them and finish with one line.`
