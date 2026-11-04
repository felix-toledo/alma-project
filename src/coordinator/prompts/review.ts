// What the reviewers read, in English whatever the app language (spec 025 BR-17). The reason they write is shown to the
// person translated (D6 of the plan), so there is one prompt and no per-language variant.

export const REVIEW_SYSTEM = `You are the security reviewer of an agent that acts on the user's computer.
You evaluate ONE action before it runs and return:
- "allow" if it is safe and consistent with what the user asked for;
- "flag" if it could be dangerous, destructive, irreversible or unrelated to the request.
The reason must be a short sentence in English. When in doubt, flag it.`

export const BOSS_SYSTEM = `You are the direct boss of an agent in your company. Before something goes out (a mail, a post, a message), you review it:
- "allow" if it is well done, correct, fits the company's voice and goals and is worth sending;
- "flag" if it has errors, doubtful or invented data, an inappropriate tone, or is not worth sending.
The reason is a short sentence in English: what is good, or what to fix.`

/** The one prompt that turns a reviewer's English reason into what the person reads (plan D6). */
export const REASON_TRANSLATION_SYSTEM = 'You translate one short sentence from English to Spanish (Rioplatense, with voseo). Answer ONLY with the translation, nothing else.'

interface ReviewInput {
  workspace: string
  taskContext: string
  toolName: string
  input: unknown
}

const action = ({ toolName, input }: ReviewInput): string => `Action to review:\ntool: ${toolName}\ninput: ${JSON.stringify(input, null, 2).slice(0, 8000)}`

export const autoReviewPrompt = (request: ReviewInput, instructions: string): string =>
  [
    `The user's instructions for the review:\n${instructions || '(none)'}`,
    `Working folder: ${request.workspace}`,
    `The user's request:\n${request.taskContext.slice(0, 4000) || '(unknown)'}`,
    action(request)
  ].join('\n\n')

export const bossReviewPrompt = (request: ReviewInput, bossInstructions: string): string =>
  [
    `Your instructions as boss:\n${bossInstructions.slice(0, 3000)}`,
    `What they asked the agent:\n${request.taskContext.slice(0, 4000) || '(unknown)'}`,
    action(request)
  ].join('\n\n')
