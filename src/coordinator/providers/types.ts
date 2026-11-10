import type { Block, ChatMessage, Effort, ProviderId, Usage } from '../../shared/types'

/** A tool as offered to the model: JSON Schema input, provider-neutral. */
export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface TurnRequest {
  model: string
  effort: Effort
  system: string
  tools: ToolSpec[]
  messages: ChatMessage[]
  /** A hard limit on the answer, thinking included; the provider's own default when absent. */
  maxOutputTokens?: number
  signal: AbortSignal
  onText(delta: string): void
  onThinking(delta: string): void
  onToolStart(id: string, name: string): void
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other'

export interface TurnResult {
  content: Block[]
  /** Provider-native content to replay on the next request to the same provider. */
  raw?: unknown
  stopReason: StopReason
  /** Human-readable detail for refusals and other unusual stops. */
  stopDetail?: string
  usage?: Usage
  model: string
}

/** Verdict from the auto-review model on one tool call. */
export interface ReviewVerdict {
  verdict: 'allow' | 'flag'
  reason: string
}

export interface Provider {
  id: ProviderId
  streamTurn(request: TurnRequest): Promise<TurnResult>
  review(request: { model: string; system: string; prompt: string; signal: AbortSignal }): Promise<ReviewVerdict>
  listModels(): Promise<string[]>
}

export class ProviderConfigError extends Error {}
