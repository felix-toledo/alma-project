import * as z from 'zod/v4'
import { END_VOICE_TOOL } from '../voice/speech'
import { defineTool, toolText } from './types'

/** Only offered in voice conversations. It changes nothing: the voice assistant reads the call from the thread. */
export const endVoiceConversationTool = defineTool({
  name: END_VOICE_TOOL,
  description:
    'End the voice conversation: the microphone closes and the user will have to call you again. Always call it when your answer does not need a reply from the user (you did what they asked, gave them the fact, they thanked you or said goodbye). Do not call it if you asked them a question or the topic is still open.',
  risk: 'read',
  standalone: true,
  schema: z.object({ reason: z.string().optional().describe('Why it ends (optional)') }),
  async run(_input, ctx) {
    return toolText(ctx, 'tool.voice.ended')
  }
})
