import { audit } from '../shared/audit'
import type { AuditDetail, ToolRisk } from './tools/types'

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
 * A tool with its own audit action (spec 029) replaces the generic action and detail with a closed set of ids and counts.
 */
export function toolTrail(call: ToolTrailCall, outcome: 'ok' | 'denied' | 'error', action: string, override?: { action: string; detail: AuditDetail }): void {
  if (call.risk === 'read') return
  if (override) {
    audit({ action: override.action, actor: 'agent', target: call.name, outcome, detail: override.detail })
    return
  }
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
