import type { AgentProfile, ProviderId, Settings } from './types'

/** Word, Excel, PowerPoint and PDF: read, create and edit (src/coordinator/tools/office). */
export const OFFICE_TOOLS = ['office_read', 'office_create', 'office_edit']
const FILE_TOOLS = ['read_file', 'list_dir', 'search_files', 'write_file', 'edit_file', 'run_command', ...OFFICE_TOOLS]
export const BUILTIN_TOOLS = [...FILE_TOOLS, 'generate_image', 'compose_image', 'instagram_publish'] as const
export const READ_ONLY_TOOLS: readonly string[] = ['read_file', 'list_dir', 'search_files', 'office_read']

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5'
export const CLAUDE_MODELS = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-fable-5-1',
  'claude-opus-5'
]
export const XAI_BASE_URL = 'https://api.x.ai/v1'
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
export const VERCEL_BASE_URL = 'https://ai-gateway.vercel.sh/v1'
export const META_BASE_URL = 'https://api.meta.ai/v1'

export const PROVIDER_NAMES: Record<ProviderId, string> = { anthropic: 'Claude', xai: 'Grok', deepseek: 'DeepSeek', vercel: 'Vercel AI Gateway', meta: 'Meta (Muse)' }

/** True for xAI/OpenAI/Anthropic-style API keys, which don't belong in model fields. */
export function looksLikeApiKey(value: string): boolean {
  return /^(?:xai|sk)-[\w-]{16,}$/.test(value.trim())
}

const WORKING_STYLE = `Trabajás dentro de la carpeta de trabajo del usuario usando tus herramientas.
Antes de cambiar archivos, leé lo necesario para entender el contexto. Hacé cambios mínimos y precisos.
Si una herramienta es rechazada, no la reintentes igual: explicá qué necesitabas y proponé alternativas.
Respondé en el idioma del usuario.`

export const DEFAULT_AGENTS: AgentProfile[] = [
  {
    id: 'general',
    name: 'General',
    description: 'Agente principal: resuelve tareas de punta a punta y delega en otros agentes cuando conviene.',
    systemPrompt: `Sos un agente de escritorio que ayuda al usuario con tareas en su computadora.
${WORKING_STYLE}
Cuando una tarea se divide en partes independientes (investigar varias áreas, revisar y programar en paralelo), delegá cada parte con delegate_task y después integrá los resultados.`,
    provider: 'anthropic',
    model: DEFAULT_CLAUDE_MODEL,
    effort: 'high',
    tools: [...FILE_TOOLS, 'generate_image', 'compose_image'],
    allowMcp: true,
    canDelegate: true
  },
  {
    id: 'investigador',
    name: 'Investigador',
    description: 'Explora la carpeta de trabajo y responde preguntas sobre el código o los documentos. Solo lectura.',
    systemPrompt: `Sos un investigador. Explorás archivos para responder una pregunta concreta y devolvés hallazgos verificables con rutas y números de línea.
No modificás nada. Terminá con un resumen claro de lo que encontraste y lo que no pudiste confirmar.`,
    provider: 'anthropic',
    model: DEFAULT_CLAUDE_MODEL,
    effort: 'medium',
    tools: ['read_file', 'list_dir', 'search_files', 'office_read'],
    allowMcp: false,
    canDelegate: false
  },
  {
    id: 'programador',
    name: 'Programador',
    description: 'Implementa cambios de código y corre comandos (tests, builds) para verificarlos.',
    systemPrompt: `Sos un programador cuidadoso. Implementás el cambio pedido, lo verificás corriendo los comandos adecuados y reportás qué cambiaste y cómo lo comprobaste.
${WORKING_STYLE}`,
    provider: 'anthropic',
    model: DEFAULT_CLAUDE_MODEL,
    effort: 'medium',
    tools: [...FILE_TOOLS, 'generate_image', 'compose_image'],
    allowMcp: true,
    canDelegate: false
  },
  {
    id: 'revisor',
    name: 'Revisor',
    description: 'Revisa código o cambios buscando errores concretos, con evidencia. Solo lectura.',
    systemPrompt: `Sos un revisor de código. Buscás errores reales (lógica, casos borde, seguridad) y los reportás con archivo, línea y por qué fallan.
No inventes problemas: si no encontrás nada importante, decilo.`,
    provider: 'anthropic',
    model: DEFAULT_CLAUDE_MODEL,
    effort: 'medium',
    tools: ['read_file', 'list_dir', 'search_files', 'office_read'],
    allowMcp: false,
    canDelegate: false
  },
  {
    id: 'grok',
    name: 'Grok',
    description: 'Agente principal que usa la API de xAI (Grok) en lugar de Claude.',
    systemPrompt: `Sos un agente de escritorio que ayuda al usuario con tareas en su computadora.
${WORKING_STYLE}
Cuando una tarea se divide en partes independientes, delegá cada parte con delegate_task.`,
    provider: 'xai',
    model: '',
    effort: 'high',
    tools: [...FILE_TOOLS, 'generate_image', 'compose_image'],
    allowMcp: true,
    canDelegate: true
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'Agente principal que usa la API de DeepSeek en lugar de Claude.',
    systemPrompt: `Sos un agente de escritorio que ayuda al usuario con tareas en su computadora.
${WORKING_STYLE}
Cuando una tarea se divide en partes independientes, delegá cada parte con delegate_task.`,
    provider: 'deepseek',
    model: '',
    effort: 'high',
    tools: [...FILE_TOOLS, 'generate_image', 'compose_image'],
    allowMcp: true,
    canDelegate: true
  },
  {
    id: 'vercel',
    name: 'Vercel AI Gateway',
    description: 'Agente principal que usa el AI Gateway de Vercel: una sola key para modelos de Anthropic, OpenAI, Google y más.',
    systemPrompt: `Sos un agente de escritorio que ayuda al usuario con tareas en su computadora.
${WORKING_STYLE}
Cuando una tarea se divide en partes independientes, delegá cada parte con delegate_task.`,
    provider: 'vercel',
    model: '',
    effort: 'high',
    tools: [...FILE_TOOLS, 'generate_image', 'compose_image'],
    allowMcp: true,
    canDelegate: true
  },
  {
    id: 'multimedia',
    name: 'Multimedia',
    description: 'Crea videos con Remotion (React → MP4), imágenes y animaciones, y los renderiza en tu computadora.',
    systemPrompt: `Sos un productor multimedia. Hacés videos programáticos con Remotion (React → MP4), más imágenes y piezas gráficas.
${WORKING_STYLE}
Cómo trabajás con Remotion:
1. Entorno: comprobá con run_command que hay Node (node -v). Si no hay proyecto Remotion en la carpeta, creá uno mínimo: package.json + npm i remotion @remotion/cli react react-dom (y typescript, @types/react) con src/index.ts (registerRoot), src/Root.tsx (<Composition id, component, durationInFrames, fps, width, height>) y la composición en su propio archivo. No uses plantillas interactivas: create-video pregunta cosas y se cuelga.
2. Todo movimiento sale de useCurrentFrame() y useVideoConfig(): interpolate() para valores, spring() para rebotes, <Sequence from durationInFrames> para ordenar escenas, <Series> para encadenarlas, <AbsoluteFill> para capas. Prohibido: transiciones o animaciones CSS, setTimeout, requestAnimationFrame, Math.random() sin semilla (usá random('semilla') de remotion): el render va cuadro por cuadro y se rompería.
3. Medios: staticFile('x') para lo que está en public/, <Img>, <OffthreadVideo> y <Audio> de remotion (no las etiquetas HTML). Tipografías con @remotion/google-fonts. Subtítulos con @remotion/captions. Transiciones entre escenas con @remotion/transitions. Las imágenes que necesites generalas con generate_image/compose_image y guardalas en public/.
4. Verificá antes de renderizar todo: npx remotion compositions (que exista y tenga bien duración y tamaño) y npx remotion still <id> --frame=<n> out/frame-<n>.png en 2 o 3 cuadros clave. Si algo falla, leé el error completo y corregí la causa.
5. Renderizá con npx remotion render <id> out/<nombre>.mp4 (--codec=h264 por defecto; --scale=0.5 para una prueba rápida; --props='{"titulo":"..."}' para variar el contenido). run_command corta a los 120 s: para npm install y renders pasá timeout_seconds: 600, y si un render es más largo dividilo en tramos (--frames=0-299) o bajá la escala. Reportá la ruta, la duración, la resolución y el tamaño.
6. Nunca dejes un proceso largo corriendo: npx remotion studio es interactivo, no lo lances salvo que el usuario lo pida y avisale cómo abrirlo él.
Formatos habituales: 1920x1080 a 30 fps para YouTube, 1080x1920 para Reels/TikTok/Shorts, 1080x1080 o 1080x1350 para feed. Si faltan datos (duración, textos, marca, formato), proponé valores razonables y avanzá en lugar de preguntar todo.`,
    provider: 'anthropic',
    model: DEFAULT_CLAUDE_MODEL,
    effort: 'medium',
    tools: [...FILE_TOOLS, 'generate_image', 'compose_image'],
    allowMcp: false,
    canDelegate: false,
    autoApproveTools: ['generate_image', 'compose_image', 'write_file', 'edit_file']
  },
  {
    id: 'community-manager',
    name: 'Community Manager',
    description: 'Crea posts para Instagram (imagen + texto) y los publica después de que el usuario los aprueba.',
    systemPrompt: `Sos el community manager del usuario. Creás publicaciones para su Instagram.
Cómo trabajás:
1. Si existe marca.md en la carpeta de trabajo, leelo primero: tiene el tono, el público, los temas y lo que hay que evitar. Si existe publicaciones.md, leelo para no repetir temas ni imágenes.
2. Elegí un tema concreto y generá UNA imagen con generate_image (formato 4:5 o 1:1, sin texto incrustado salvo que te lo pidan). Describí la imagen con detalle: sujeto, estilo, luz, encuadre. Si no hay modelo de imágenes o falla, armala con compose_image usando los colores y la fuente de marca.md (si están) y las piezas de biblioteca/.
3. Escribí el texto del post en la voz de la marca: un gancho en la primera línea, cuerpo breve, una llamada a la acción y entre 3 y 8 hashtags relevantes. Máximo 2200 caracteres.
4. Publicá con instagram_publish. El usuario ve la imagen y el texto y decide; si lo rechaza, preguntá qué cambiar en lugar de reintentar lo mismo.
5. Si se publicó, agregá una entrada a publicaciones.md con la fecha, el tema, la ruta de la imagen y el texto.
Respondé en el idioma del usuario.`,
    provider: 'anthropic',
    model: DEFAULT_CLAUDE_MODEL,
    effort: 'medium',
    tools: ['read_file', 'list_dir', 'search_files', 'write_file', 'edit_file', ...OFFICE_TOOLS, 'generate_image', 'compose_image', 'instagram_publish'],
    allowMcp: false,
    canDelegate: false,
    // Only publishing waits for the user; preparing the post doesn't.
    autoApproveTools: ['generate_image', 'compose_image', 'write_file', 'edit_file']
  }
]

export const OPENAI_BASE_URL = 'https://api.openai.com/v1'

export const DEFAULT_REVIEW_INSTRUCTIONS = `Marcá como peligrosa cualquier acción que:
- borre o sobrescriba archivos fuera de lo que el usuario pidió, o en masa;
- instale software, cambie configuración del sistema o use privilegios de administrador;
- envíe datos a internet, publique, haga push o pague algo;
- lea o exponga credenciales, claves o datos personales.
Permití lecturas, builds, tests y ediciones acotadas a la tarea.`

export function defaultSettings(): Settings {
  return {
    providers: {
      anthropic: { apiKey: '' },
      xai: { apiKey: '', baseUrl: XAI_BASE_URL },
      deepseek: { apiKey: '' },
      vercel: { apiKey: '' },
      meta: { apiKey: '' },
      openai: { apiKey: '' },
      telegram: { apiKey: '' },
      elevenlabs: { apiKey: '' },
      email: { apiKey: '' }
    },
    defaultAgentId: 'general',
    agents: structuredClone(DEFAULT_AGENTS),
    approvalMode: 'needs-approval',
    autoReview: { provider: 'anthropic', model: DEFAULT_CLAUDE_MODEL, instructions: DEFAULT_REVIEW_INSTRUCTIONS },
    alwaysAllowTools: [],
    mcpServers: {},
    defaultWorkspace: '',
    images: { provider: 'xai', model: '' },
    instagram: { testMode: true },
    routines: [],
    background: { runInTray: true, launchAtLogin: false },
    privacy: { threadRetentionDays: 0 },
    vaults: [],
    activeVault: '',
    telegram: { enabled: true, allowedUsers: [], agentId: 'general', chatId: null, threadId: null },
    voice: {
      enabled: false,
      wakeWord: 'hola_alma',
      wakeThreshold: 0.5,
      hotkey: 'Control+Alt+Space',
      micDeviceId: '',
      verifySpeaker: true,
      speakerThreshold: 0.86,
      stt: 'local',
      sttModel: 'whisper-base',
      tts: 'kokoro',
      kokoroVoice: 'ef_dora',
      windowsVoice: '',
      elevenVoiceId: '',
      elevenModel: 'eleven_multilingual_v2',
      agentId: 'general',
      threadId: null
    },
    email: { address: '', imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465 },
    whatsapp: { enabled: false, agentId: 'general', threadId: null },
    companies: [],
    companySecrets: {},
    home: { enabled: false, mode: 'managed', externalUrl: '', mirrored: false, agentId: '', visionProvider: '', visionModel: '' }
  }
}

/** IMAP/SMTP servers for the usual providers, guessed from the address (the user can still edit them). */
export function emailServersFor(address: string): Partial<Settings['email']> {
  const domain = address.split('@')[1]?.toLowerCase() ?? ''
  if (/^(gmail|googlemail)\.com$/.test(domain)) return { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 }
  if (/^(outlook|hotmail|live|msn)\.[a-z.]+$/.test(domain)) return { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp-mail.outlook.com', smtpPort: 587 }
  if (/^yahoo\.[a-z.]+$/.test(domain)) return { imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465 }
  if (/^(icloud|me|mac)\.com$/.test(domain)) return { imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587 }
  return domain ? { imapHost: `imap.${domain}`, imapPort: 993, smtpHost: `smtp.${domain}`, smtpPort: 465 } : {}
}
