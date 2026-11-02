import type { AgentProfile, LiveEvent, PendingApproval, Settings } from '../shared/types'
import { getProvider } from './providers'
import type { ToolRisk } from './tools/types'

export type Decision = 'allow' | 'deny' | 'always'

interface Waiter {
  approval: PendingApproval
  resolve(decision: Decision): void
}

/** Holds tool calls waiting for the user's answer in the UI. */
export class ApprovalBroker {
  private waiting = new Map<string, Waiter>()

  constructor(private emit: (event: LiveEvent) => void) {}

  ask(approval: Omit<PendingApproval, 'approvalId'>, signal: AbortSignal): Promise<Decision> {
    const approvalId = crypto.randomUUID()
    const full: PendingApproval = { ...approval, approvalId }
    return new Promise<Decision>((resolve) => {
      const settle = (decision: Decision): void => {
        if (!this.waiting.delete(approvalId)) return
        signal.removeEventListener('abort', onAbort)
        this.emit({ type: 'approval.resolved', approvalId })
        resolve(decision)
      }
      const onAbort = (): void => settle('deny')
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiting.set(approvalId, { approval: full, resolve: settle })
      this.emit({ type: 'approval.request', approval: full })
    })
  }

  respond(approvalId: string, decision: Decision): void {
    this.waiting.get(approvalId)?.resolve(decision)
  }

  pending(): PendingApproval[] {
    return [...this.waiting.values()].map((waiter) => waiter.approval)
  }
}

export interface AuthorizationRequest {
  settings: Settings
  threadId: string
  subagentId?: string
  toolUseId: string
  toolName: string
  risk: ToolRisk
  input: unknown
  workspace: string
  /** The user's latest request, so auto-review can judge whether the action fits the task. */
  taskContext: string
  /** Tools the running agent may use without asking (per-agent setting). */
  autoApprove: string[]
  preview?: PendingApproval['preview']
  signal: AbortSignal
  broker: ApprovalBroker
  setState(state: 'pending-approval' | 'reviewing', note?: string): void
  rememberAlwaysAllow(toolName: string): void
  /** In a company, the agent's boss sees what goes out first; only if they agree does it reach the user. */
  boss?: { name: string; profile: AgentProfile }
}

export interface Authorization {
  allowed: boolean
  note: string
}

const REVIEW_SYSTEM = `Sos el revisor de seguridad de un agente que actúa en la computadora del usuario.
Evaluás UNA acción antes de que se ejecute y devolvés:
- "allow" si es segura y coherente con lo que pidió el usuario;
- "flag" si podría ser peligrosa, destructiva, irreversible o no tiene relación con el pedido.
La razón debe ser una frase corta en español. Ante la duda, marcá "flag".`

async function autoReview(request: AuthorizationRequest): Promise<{ verdict: 'allow' | 'flag'; reason: string }> {
  const { autoReview: config } = request.settings
  const provider = getProvider(config.provider, request.settings)
  const prompt = [
    `Instrucciones del usuario para la revisión:\n${config.instructions || '(ninguna)'}`,
    `Carpeta de trabajo: ${request.workspace}`,
    `Pedido del usuario:\n${request.taskContext.slice(0, 4000) || '(desconocido)'}`,
    `Acción a revisar:\nherramienta: ${request.toolName}\nentrada: ${JSON.stringify(request.input, null, 2).slice(0, 8000)}`
  ].join('\n\n')
  return provider.review({ model: config.model, system: REVIEW_SYSTEM, prompt, signal: request.signal })
}

async function askUser(request: AuthorizationRequest, flagged: boolean, reason?: string, allowAlways = true): Promise<Authorization> {
  request.setState('pending-approval', reason)
  const decision = await request.broker.ask(
    {
      threadId: request.threadId,
      subagentId: request.subagentId,
      toolUseId: request.toolUseId,
      toolName: request.toolName,
      input: request.input,
      flagged,
      reason,
      allowAlways,
      ...(request.preview ? { preview: request.preview } : {})
    },
    request.signal
  )
  if (decision === 'always' && allowAlways) {
    request.rememberAlwaysAllow(request.toolName)
    return { allowed: true, note: 'Permitido siempre por vos' }
  }
  if (decision === 'always') return { allowed: true, note: 'Aprobado por vos' }
  if (decision === 'allow') return { allowed: true, note: 'Aprobado por vos' }
  return { allowed: false, note: request.signal.aborted ? 'Cancelado' : 'Rechazado por vos' }
}

const BOSS_SYSTEM = `Sos el jefe directo de un agente de tu empresa. Antes de que algo salga hacia afuera (un mail, un posteo, un mensaje), lo revisás:
- "allow" si está bien hecho, es correcto, va con la voz y los objetivos de la empresa y conviene mandarlo;
- "flag" si tiene errores, datos dudosos o inventados, un tono inadecuado, o no conviene.
La razón es una frase corta en español: qué está bien, o qué corregir.`

/** The boss's verdict on an outgoing action, in their own voice (their instructions shape the judgment). */
async function bossReview(request: AuthorizationRequest): Promise<{ verdict: 'allow' | 'flag'; reason: string }> {
  const { profile } = request.boss!
  const provider = getProvider(profile.provider, request.settings)
  const prompt = [
    `Tus instrucciones como jefe:\n${profile.systemPrompt.slice(0, 3000)}`,
    `Lo que le pidieron al agente:\n${request.taskContext.slice(0, 4000) || '(desconocido)'}`,
    `Acción a revisar:\nherramienta: ${request.toolName}\nentrada: ${JSON.stringify(request.input, null, 2).slice(0, 8000)}`
  ].join('\n\n')
  return provider.review({ model: profile.model, system: BOSS_SYSTEM, prompt, signal: request.signal })
}

/**
 * Applies the approval mode to one tool call. Read-only tools never need approval; publishing always does,
 * whatever the mode or rules, because it acts in the user's name outside this computer.
 */
export async function authorize(request: AuthorizationRequest): Promise<Authorization> {
  if (request.risk === 'read') return { allowed: true, note: 'Solo lectura' }
  const { settings } = request
  if (settings.approvalMode === 'blocked') return { allowed: false, note: 'Bloqueado por el modo de aprobación' }
  if (request.risk === 'memory') return { allowed: true, note: 'Memoria de Alma' }
  if (request.risk === 'home') return { allowed: true, note: 'Control de la casa' }
  if (request.risk === 'publish') {
    if (!request.boss) return askUser(request, false, undefined, false)
    request.setState('reviewing', `Lo revisa ${request.boss.name}`)
    try {
      const verdict = await bossReview(request)
      if (verdict.verdict === 'flag') return { allowed: false, note: `Rechazado por ${request.boss.name}: ${verdict.reason}` }
      return askUser(request, false, `Aprobado por ${request.boss.name}: ${verdict.reason}`, false)
    } catch (error) {
      if (request.signal.aborted) return { allowed: false, note: 'Cancelado' }
      return askUser(request, false, `${request.boss.name} no pudo revisarlo: ${(error as Error).message}`, false)
    }
  }
  if (request.autoApprove.includes(request.toolName)) return { allowed: true, note: 'Permitido para este agente' }
  if (settings.alwaysAllowTools.includes(request.toolName)) return { allowed: true, note: 'Permitido por tu regla' }

  switch (settings.approvalMode) {
    case 'always-allow':
      return { allowed: true, note: 'Modo «siempre permitir»' }
    case 'auto-review': {
      request.setState('reviewing')
      try {
        const verdict = await autoReview(request)
        if (verdict.verdict === 'allow') return { allowed: true, note: `Auto-review: ${verdict.reason}` }
        return askUser(request, true, verdict.reason)
      } catch (error) {
        if (request.signal.aborted) return { allowed: false, note: 'Cancelado' }
        return askUser(request, false, `Auto-review no disponible: ${(error as Error).message}`)
      }
    }
    case 'needs-approval':
    default:
      return askUser(request, false)
  }
}
