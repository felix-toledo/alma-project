import { audit } from '../shared/audit'
import type { ToolRisk } from './tools/types'

export interface ToolTrailCall {
  risk: ToolRisk
  name: string
  input: unknown
  threadId: string
  agentId: string
  note: string
}

/**
 * The tool audit trail (spec 026 T22, extracted from executeTool unchanged):
 * reads aren't trailed; anything that changes, runs or sends is, with who allowed
 * it and what it was about. `run_command` also keeps its command text.
 */
export function toolTrail(call: ToolTrailCall, outcome: 'ok' | 'denied' | 'error', action: string): void {
  if (call.risk === 'read') return
  const args = call.input && typeof call.input === 'object' ? (call.input as Record<string, unknown>) : {}
  audit({
    action,
    actor: 'agent',
    target: call.name,
    outcome,
    detail: {
      risk: call.risk,
      thread: call.threadId,
      agent: call.agentId,
      decision: call.note,
      args: Object.keys(args).join(','),
      ...(call.name === 'run_command' && typeof args.command === 'string' ? { command: args.command } : {})
    }
  })
}
