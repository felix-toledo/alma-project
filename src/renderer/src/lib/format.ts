import type { AgentProfile, ApprovalMode } from '../../../shared/types'

export const APPROVAL_MODES: { value: ApprovalMode; label: string; hint: string }[] = [
  { value: 'needs-approval', label: 'Pedir aprobación', hint: 'Te pregunta antes de escribir archivos, ejecutar comandos o usar MCP.' },
  { value: 'auto-review', label: 'Auto-review', hint: 'Un modelo revisor evalúa cada acción; solo te pregunta si la marca como riesgosa.' },
  { value: 'always-allow', label: 'Permitir todo', hint: 'Ejecuta todo sin preguntar. Usalo solo en carpetas de prueba.' },
  { value: 'blocked', label: 'Solo lectura', hint: 'Bloquea escrituras, comandos y MCP; el agente solo puede leer.' }
]

export function relativeTime(ts: number): string {
  const seconds = Math.round((Date.now() - ts) / 1000)
  if (seconds < 60) return 'ahora'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `hace ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `hace ${hours} h`
  const days = Math.round(hours / 24)
  return days === 1 ? 'ayer' : `hace ${days} días`
}

export function agentName(agents: AgentProfile[], id: string): string {
  return agents.find((a) => a.id === id)?.name ?? id
}

export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

const TOOL_LABELS: Record<string, string> = {
  read_file: 'Leer archivo',
  list_dir: 'Listar carpeta',
  search_files: 'Buscar',
  write_file: 'Escribir archivo',
  edit_file: 'Editar archivo',
  run_command: 'Ejecutar comando',
  delegate_task: 'Delegar',
  generate_image: 'Generar imagen',
  compose_image: 'Componer imagen',
  instagram_publish: 'Publicar en Instagram',
  search_knowledge: 'Buscar en el vault',
  read_note: 'Leer nota',
  save_knowledge: 'Guardar conocimiento',
  remember: 'Recordar',
  forget: 'Olvidar',
  web_search: 'Buscar en internet',
  fetch_url: 'Abrir página',
  send_telegram: 'Mandar por Telegram',
  email_search: 'Buscar mails',
  email_read: 'Leer mail',
  email_send: 'Mandar mail',
  send_whatsapp: 'Mandar WhatsApp',
  whatsapp_recent: 'Ver WhatsApps',
  office_read: 'Leer documento',
  office_create: 'Crear documento',
  office_edit: 'Editar documento',
  excalidraw_read: 'Leer dibujo',
  excalidraw_draw: 'Dibujar',
  assign_task: 'Asignar tarea',
  update_task: 'Entregar tarea',
  review_task: 'Revisar tarea',
  list_tasks: 'Ver tareas',
  ask_colleague: 'Consultar a un colega',
  escalate: 'Escalar',
  schedule_meeting: 'Convocar reunión'
}

/** The vault note a knowledge tool call is about, so the chat can link to it. */
export function knowledgeNotePath(name: string, input: unknown, result: string | undefined): string | undefined {
  const data = (input ?? {}) as Record<string, unknown>
  if (name === 'read_note' && typeof data.path === 'string') return data.path
  if (name === 'remember' || name === 'forget') return result ? 'Alma/Recuerdos.md' : undefined
  if (name === 'save_knowledge') return result ? /(\S+\.md)\b/.exec(result)?.[1] : undefined
  return undefined
}

/** The workspace path a generate_image result points to, if it succeeded. */
export function generatedImagePath(result: string | undefined): string | undefined {
  return result ? /^Imagen guardada: (.+)$/m.exec(result)?.[1]?.trim() : undefined
}

export function toolLabel(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name]
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  return mcp ? `${mcp[1]} · ${mcp[2]}` : name
}

/** One-line summary of a tool call's input for the collapsed card. */
export function toolSummary(name: string, input: unknown): string {
  const data = (input ?? {}) as Record<string, unknown>
  const pick = (key: string): string => (typeof data[key] === 'string' ? (data[key] as string) : '')
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return pick('path')
    case 'list_dir':
      return pick('path') || '.'
    case 'search_files':
      return `${pick('pattern')}${pick('glob') ? `  (${pick('glob')})` : ''}`
    case 'run_command':
      return pick('command')
    case 'delegate_task':
      return pick('title')
    case 'generate_image':
      return pick('prompt').slice(0, 140)
    case 'compose_image':
      return [pick('template'), pick('title')].filter(Boolean).join(' · ').slice(0, 140)
    case 'instagram_publish':
      return pick('caption').split('\n')[0].slice(0, 140)
    case 'search_knowledge':
    case 'web_search':
      return pick('query')
    case 'fetch_url':
      return pick('url')
    case 'office_read':
    case 'office_create':
    case 'office_edit':
    case 'excalidraw_read':
    case 'excalidraw_draw':
      return pick('path')
    case 'assign_task':
    case 'schedule_meeting':
      return pick('title') || pick('topic')
    case 'ask_colleague':
      return pick('question').slice(0, 140)
    case 'escalate':
      return pick('message').slice(0, 140)
    case 'email_search':
      return pick('query') || 'últimos mails'
    case 'email_send':
      return `${pick('to')} · ${pick('subject')}`.slice(0, 140)
    case 'send_whatsapp':
      return `${pick('to')} · ${pick('text')}`.slice(0, 140)
    case 'send_telegram':
      return pick('text').slice(0, 140)
    case 'read_note':
      return pick('path')
    case 'save_knowledge':
      return pick('title')
    case 'remember':
    case 'forget':
      return pick('text')
    default: {
      const text = JSON.stringify(data)
      return text === '{}' ? '' : text.slice(0, 120)
    }
  }
}

/** Títulos viejos de rutinas empezaban con un emoji; se muestran sin él. */
export const threadTitle = (title: string): string => title.replace(/^\u{1F501}\s*/u, 'Rutina · ')
