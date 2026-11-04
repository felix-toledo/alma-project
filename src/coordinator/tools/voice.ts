import * as z from 'zod/v4'
import { END_VOICE_TOOL } from '../voice/speech'
import { defineTool } from './types'

/** Only offered in voice conversations. It changes nothing: the voice assistant reads the call from the thread. */
export const endVoiceConversationTool = defineTool({
  name: END_VOICE_TOOL,
  description:
    'Terminá la conversación por voz: el micrófono se cierra y el usuario tendrá que volver a llamarte. Llamala siempre que tu respuesta no necesite una respuesta del usuario (hiciste lo que pidió, le diste el dato, te agradeció o se despidió). No la llames si le hiciste una pregunta o el tema sigue abierto.',
  risk: 'read',
  standalone: true,
  schema: z.object({ reason: z.string().optional().describe('Por qué termina (opcional)') }),
  async run() {
    return 'Conversación terminada. Si hace falta, despedite con una frase corta; si ya cerraste, no digas nada más.'
  }
})
